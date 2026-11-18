/**
 * native_input_consumed covers shared group background, so it may only be sent
 * where the CLI itself evidenced this exact input. Executes the worker's real
 * Claude transcript boundary (helpers/worker-function-harness.ts). Ordinary IM
 * receipt / queue-head ordering during init is executed against a real worker
 * in worker-ordinary-im-init-concurrency.integration.test.ts.
 */
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import {
  prepareTraexNativeContext,
  settleTraexNativeContextReceipt,
} from '../src/core/traex-native-context.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function caseRegion(type: string, nextType: string): string {
  const start = workerSource.indexOf(`case '${type}':`);
  const end = workerSource.indexOf(`case '${nextType}':`, start);
  if (start < 0 || end < 0) throw new Error(`Missing worker cases: ${type}, ${nextType}`);
  return workerSource.slice(start, end);
}

type Notify = (
  turn: { turnId: string; isLocal?: boolean; isScheduled?: boolean },
  evidence: { fullContentMatch: boolean; sourceJsonlPath?: string },
) => void;

function claudeTranscriptHarness(overrides: Record<string, unknown> = {}) {
  const acknowledgeNativeInputConsumed = vi.fn();
  const scope: Record<string, unknown> = {
    cliAdapter: { claudeDataDir: '/home/u/.claude' },
    lastInitConfig: { cliSessionId: 'configured-session', adoptMode: false },
    basename,
    acknowledgeNativeInputConsumed,
    ...overrides,
  };
  const notify = loadWorkerFunction<Notify>('notifyNativeTranscriptConsumedLarkTurn', scope);
  return { notify, acknowledgeNativeInputConsumed };
}

const transcript = '/home/u/.claude/projects/p/0f3c1d2e-aaaa-bbbb-cccc-1234567890ab.jsonl';

describe('Claude transcript native input consumption receipt', () => {
  it('acknowledges a full transcript match with the transcript-derived native session id', () => {
    const h = claudeTranscriptHarness();
    h.notify({ turnId: 'om_turn' }, { fullContentMatch: true, sourceJsonlPath: transcript });
    expect(h.acknowledgeNativeInputConsumed).toHaveBeenCalledExactlyOnceWith(
      'om_turn', 'claude_transcript_user_record', '0f3c1d2e-aaaa-bbbb-cccc-1234567890ab',
    );
  });

  it('claims and ACKs a steady-state turn before crash recovery awaits', () => {
    const message = caseRegion('message', 'raw_input');
    const receipt = message.indexOf('receiveOrdinaryImTurn(ordinaryImTurnId)');
    const crashRestart = message.indexOf('await spawnCli(restartCfg)');

    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(crashRestart).toBeGreaterThan(receipt);
  });

  it('queues pre-adapter follow-ups and preserves the init prompt at the head', () => {
    const pendingMessages = [{ content: 'initial prompt', turnId: 'om_initial' }];
    const sendToPty = loadWorkerFunction<(content: string, turnId: string) => boolean>('sendToPty', {
      pendingMessages,
      rememberTurnLinkRefMode: vi.fn(),
      traexAutoModelRuntimeEligible: () => false,
      cliRestartInProgress: false, backend: null, cliAdapter: null,
      freshnessInputQueue: { enqueueNormal: (item: typeof pendingMessages[number]) => pendingMessages.push(item) },
      log: vi.fn(),
    });
    expect(sendToPty('follow-up B', 'om_b')).toBe(true);
    expect(sendToPty('follow-up C', 'om_c')).toBe(true);
    expect(pendingMessages).toEqual([
      { content: 'initial prompt', turnId: 'om_initial' },
      { content: 'follow-up B', turnId: 'om_b' },
      { content: 'follow-up C', turnId: 'om_c' },
    ]);
  });
});

// ── native_input_consumed emission boundaries ────────────────────────────────
// The receipt covers shared group background, so it may only be sent from
// boundaries where the CLI itself evidenced this exact input. Pin the gates.
describe('native input consumption receipt wiring', () => {
  it('accepts history proof only for non-adopted Codex paste sessions', () => {
    const cases: Array<[string, boolean, object | undefined, boolean]> = [
      ['codex', false, undefined, true],
      ['codex', true, undefined, false],
      ['codex', false, {}, false],
      ['traex', false, undefined, false],
    ];
    for (const [cliId, adoptMode, codexRpcEngine, expected] of cases) {
      const provesConsumption = loadWorkerFunction<() => boolean>('codexHistoryMatchProvesConsumption', {
        lastInitConfig: { cliId, adoptMode }, codexRpcEngine,
      });
      expect(provesConsumption()).toBe(expected);
    }
  });

  it('Codex paste: only an exact owned history match, after session id persistence', () => {
    const region = workerSource.slice(workerSource.indexOf('if (result?.cliSessionId) {\n        persistCliSessionId(result.cliSessionId);'));
    const receipt = region.indexOf("acknowledgeNativeInputConsumed(item.turnId, 'codex_history_match'");
    expect(receipt).toBeGreaterThan(region.indexOf('persistCliSessionId(result.cliSessionId);'));
    expect(region.slice(0, receipt)).toContain('result?.submitted === true && result.ownershipProven === true && codexHistoryMatchProvesConsumption()');
    expect(workerSource).toContain("return lastInitConfig?.cliId === 'codex' && !lastInitConfig.adoptMode && !codexRpcEngine;");
    const deferred = workerSource.slice(workerSource.indexOf("case 'suppress-confirmed':"), workerSource.indexOf("case 'suppress-usage-limit':"));
    expect(deferred).toContain('if (settlement.ownershipProven === true && codexHistoryMatchProvesConsumption()) {');
    expect(deferred.indexOf('acknowledgeNativeInputConsumed(')).toBeGreaterThan(deferred.indexOf('persistCliSessionId(cliSessionId);'));
    // The ZMX late recheck settles into the same result object the gate reads:
    // a positive ownership proof must survive it, or the gate never fires.
    // Both managed-pid wiring sites (synchronous at spawn, delayed for late-child
    // backends) hand the pid to the adapter through one predicate that names codex.
    expect(workerSource).toContain("if (cliPid && cliAdapterBindsOwnershipPid(cfg.cliId, claudeDataDir)) {");
    expect(workerSource).toContain("if (cliAdapterBindsOwnershipPid(cfg.cliId, claudeDataDir)) {");
    expect(workerSource).not.toMatch(/claudeDataDir \|\| cfg\.cliId === 'grok'/);
    const settle = workerSource.slice(workerSource.indexOf('async function settleVerifiableSubmissionForJournal('), workerSource.indexOf('function captureAmbiguousSubmissionFence('));
    expect(settle).toContain('if (typeof recheck === \'object\' && recheck && recheck.ownershipProven === true) {\n      result.ownershipProven = true;');
  });

  it('Codex RPC: only after the acknowledged turn/start passed the generation fence', () => {
    const start = workerSource.indexOf('rpcNativeTurnId = (await writeRpcEngine.sendTurn(');
    const fence = workerSource.indexOf('if (!writeContinuationIsCurrent()) {', start);
    const receipt = workerSource.indexOf("acknowledgeNativeInputConsumed(item.turnId, 'codex_rpc_turn_start'", start);
    const bridgeMark = workerSource.indexOf('bridgeTurnId = rpcTurnIdentity.turnId;', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(start);
    expect(receipt).toBeGreaterThan(fence);
    expect(receipt).toBeLessThan(bridgeMark);
    const fresh = workerSource.slice(workerSource.indexOf('const first = await engine.sendFirstTurn('), workerSource.indexOf('if (shouldPreMarkFirstTurn(first.outcome)) {'));
    expect(fresh).toContain("if (first.outcome === 'accepted') {");
    expect(fresh.indexOf("acknowledgeNativeInputConsumed(cfg.turnId, 'codex_rpc_turn_start'")).toBeGreaterThan(fresh.indexOf("if (first.outcome === 'not-sent') {"));
  });

  it('Claude: only a full normalised transcript match in a non-adopted Claude-family session', () => {
    const start = workerSource.indexOf('function notifyNativeTranscriptConsumedLarkTurn(');
    const end = workerSource.indexOf('function notifyTerminalTurnStarted(', start);
    const body = workerSource.slice(start, end);
    expect(body).toContain('if (!evidence.fullContentMatch || turn.isLocal || turn.isScheduled) return;');
    expect(body).toContain('if (!cliAdapter?.claudeDataDir || lastInitConfig?.adoptMode) return;');
    expect(body).toContain("acknowledgeNativeInputConsumed(turn.turnId, 'claude_transcript_user_record'");
    expect(workerSource).toMatch(/,\s*notifyNativeTranscriptConsumedLarkTurn\s*,/);
  });

  it('never treats IPC receipt, queue commit or a generic submitted flag as consumption', () => {
    const receiveStart = workerSource.indexOf('function receiveOrdinaryImTurn(');
    const receiveEnd = workerSource.indexOf('function rejectOrdinaryImTurn(', receiveStart);
    expect(workerSource.slice(receiveStart, receiveEnd)).not.toContain('acknowledgeNativeInputConsumed');
    const commitStart = workerSource.indexOf('function acknowledgeTurnInputCommitted(');
    const commitEnd = workerSource.indexOf('function acknowledgeTurnInputReceived(', commitStart);
    expect(workerSource.slice(commitStart, commitEnd)).not.toContain('acknowledgeNativeInputConsumed');
  });

  it('never acknowledges partial matches, local or scheduled turns, adopted or non-Claude sessions', () => {
    const cases: Array<[Parameters<Notify>, Record<string, unknown>]> = [
      [[{ turnId: 'om_partial' }, { fullContentMatch: false, sourceJsonlPath: transcript }], {}],
      [[{ turnId: 'om_local', isLocal: true }, { fullContentMatch: true, sourceJsonlPath: transcript }], {}],
      [[{ turnId: 'om_scheduled', isScheduled: true }, { fullContentMatch: true, sourceJsonlPath: transcript }], {}],
      [[{ turnId: 'om_adopted' }, { fullContentMatch: true, sourceJsonlPath: transcript }],
        { lastInitConfig: { cliSessionId: 'adopted', adoptMode: true } }],
      [[{ turnId: 'om_codex' }, { fullContentMatch: true, sourceJsonlPath: transcript }], { cliAdapter: {} }],
    ];
    for (const [args, overrides] of cases) {
      const h = claudeTranscriptHarness(overrides);
      h.notify(...args);
      expect(h.acknowledgeNativeInputConsumed, args[0].turnId).not.toHaveBeenCalled();
    }
  });

  it('settles TraeX context only from RPC accepted or ambiguous outcomes', () => {
    const rpcSend = workerSource.indexOf('writeRpcEngine.sendTurn(');
    const catchStart = workerSource.indexOf('} catch (err: any) {', rpcSend);
    const accepted = workerSource.slice(rpcSend, catchStart);
    const ambiguousEnd = workerSource.indexOf('codexAppPromptReplay.cancelSubmission(', catchStart);
    const failed = workerSource.slice(catchStart, ambiguousEnd);

    expect(rpcSend).toBeGreaterThanOrEqual(0);
    expect(accepted).toMatch(/publishTraexNativeContextReceipt\([\s\S]*?rpcContext,[\s\S]*?rpcTurnIdentity\.turnId,[\s\S]*?'accepted'/);
    expect(failed).toContain("deliveryError?.deliveryDisposition === 'ambiguous'");
    expect(failed).toMatch(/publishTraexNativeContextReceipt\([\s\S]*?rpcContext,[\s\S]*?rpcTurnIdentity\.turnId,[\s\S]*?'unknown'/);
    expect(failed.indexOf("'unknown'")).toBeLessThan(failed.indexOf('installRpcLifecycleFailClosedOwner'));
  });

  it('resends the full context when a same-thread receipt is unknown', () => {
    const user = '<user_message>next turn</user_message>';
    const content = [
      '<role>authorization boundary</role>',
      '<botmux_skills><skill name="review" /></botmux_skills>',
      user,
    ].join('\n\n');
    const prepared = prepareTraexNativeContext(content, 'thread');
    const accepted = settleTraexNativeContextReceipt(prepared, 'om_previous', 'accepted')!;
    const unknown = settleTraexNativeContextReceipt(prepared, 'om_previous', 'unknown')!;

    expect(prepareTraexNativeContext(content, 'thread', accepted).content).toBe(user);
    expect(prepareTraexNativeContext(content, 'thread', unknown).content).toBe(content);
  });

  it('prepares queued context against the latest receipt inside the RPC write lock', () => {
    const flush = workerSource.indexOf('async function flushPending(');
    const writeLock = workerSource.indexOf('await runAfterAmbiguousSubmissionWrites(writeBackend, async () => {', flush);
    const fence = workerSource.indexOf('if (!writeContinuationIsCurrent()) {', writeLock);
    const prepare = workerSource.indexOf('rpcContext = prepareTraexNativeContext(', writeLock);
    const sendTurn = workerSource.indexOf('writeRpcEngine.sendTurn(', prepare);

    expect(flush).toBeGreaterThanOrEqual(0);
    expect(writeLock).toBeGreaterThan(flush);
    expect(fence).toBeGreaterThan(writeLock);
    expect(prepare).toBeGreaterThan(fence);
    expect(sendTurn).toBeGreaterThan(prepare);
    expect(workerSource.slice(prepare, sendTurn)).toMatch(
      /prepareTraexNativeContext\(\s*msg,\s*nativeThreadId,\s*lastInitConfig\.traexNativeContextReceipt\s*\)/,
    );
    expect(workerSource.slice(sendTurn)).toMatch(
      /^writeRpcEngine\.sendTurn\(\s*rpcContext\?\.content \?\? msg,/,
    );
  });
});

describe('consumed input updates addressing without advancing execution', () => {
  it('publishes only a consumed queued input and preserves every final obligation', () => {
    const queue = [{ turnId: 'om_b' }, { turnId: 'om_c' }];
    const snapshots: unknown[] = [];
    const scope: Record<string, unknown> = {
      queuedTypeAheadTurns: queue,
      writeCliPidMarker: () => snapshots.push(structuredClone(queue)),
      inflightInputs: { onTurnStarted: vi.fn() },
      lastWrittenCliInput: undefined,
      send: vi.fn(),
    };
    scope.markReplyInputConsumed = loadWorkerFunction('markReplyInputConsumed', scope);
    const acknowledge = loadWorkerFunction<(id: string, proof: string) => void>('acknowledgeNativeInputConsumed', scope);
    acknowledge('om_b', 'claude_transcript_user_record');
    expect(snapshots).toEqual([[{ turnId: 'om_b', inputConsumed: true }, { turnId: 'om_c' }]]);
    acknowledge('om_b', 'claude_transcript_user_record');
    acknowledge('om_missing', 'codex_history_match');
    expect(snapshots).toHaveLength(1);
    acknowledge('om_c', 'codex_history_match');
    expect(snapshots).toHaveLength(2);
    expect(queue.map(t => t.turnId)).toEqual(['om_b', 'om_c']);
  });
});
