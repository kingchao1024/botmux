/**
 * native_input_consumed covers shared group background, so it may only be sent
 * where the CLI itself evidenced this exact input. Executes the worker's real
 * Claude transcript boundary (helpers/worker-function-harness.ts). Ordinary IM
 * receipt / queue-head ordering during init is executed against a real worker
 * in worker-ordinary-im-init-concurrency.integration.test.ts.
 */
import { basename } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

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
    const sendToPtyStart = workerSource.indexOf('function sendToPty(');
    const sendToPtyEnd = workerSource.indexOf('// ─── Screen Update Timer', sendToPtyStart);
    const sendToPty = workerSource.slice(sendToPtyStart, sendToPtyEnd);
    const backendQueue = sendToPty.indexOf('if (cliRestartInProgress || !backend)');
    const adapterReject = sendToPty.indexOf('if (!cliAdapter) return false;');
    const init = caseRegion('init', 'message');
    const initialPromptQueue = init.indexOf('pendingMessages.unshift(...recoveredAcceptedInputs, {');
    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flush = workerSource.slice(flushStart, flushEnd);

    expect(backendQueue).toBeGreaterThanOrEqual(0);
    expect(adapterReject).toBeGreaterThan(backendQueue);
    expect(initialPromptQueue).toBeGreaterThanOrEqual(0);
    expect(flush).toContain('if (initialInputOwnershipPending) return;');
    expect(init.indexOf('initialInputOwnershipPending = !!msg.prompt;'))
      .toBeLessThan(init.indexOf('await startWebServer('));
    expect(init.indexOf('initialInputOwnershipPending = false;'))
      .toBeGreaterThan(initialPromptQueue);
  });
});

// ── native_input_consumed emission boundaries ────────────────────────────────
// The receipt covers shared group background, so it may only be sent from
// boundaries where the CLI itself evidenced this exact input. Pin the gates.
describe('native input consumption receipt wiring', () => {
  const emissions = [...workerSource.matchAll(/acknowledgeNativeInputConsumed\(/g)].map(m => m.index!)
    .filter(index => !workerSource.slice(index - 20, index).includes('function '));

  it('emits from exactly the five evidenced boundaries', () => {
    // Codex paste (immediate + deferred history match), Codex RPC (steady
    // turn/start + fresh first turn), Claude transcript full match.
    expect(emissions).toHaveLength(5);
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
    expect(workerSource).toContain('notifyNativeTranscriptConsumedLarkTurn,\n);');
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

  it('blocks an unknown same-thread context receipt before calling turn/start again', () => {
    const prepare = workerSource.indexOf('rpcContext = item.traexNativeContext');
    const sendTurn = workerSource.indexOf('writeRpcEngine.sendTurn(', prepare);
    const guarded = workerSource.slice(prepare, sendTurn);

    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(sendTurn).toBeGreaterThan(prepare);
    expect(guarded).toContain("rpcContext.blockedReason === 'context_receipt_unknown'");
    expect(guarded).toContain('pendingMessages.unshift(item);');
    expect(guarded).toContain('break;');
  });

  it('revalidates the prepared context metadata against the latest receipt', () => {
    const prepare = workerSource.indexOf('rpcContext = item.traexNativeContext');
    const sendTurn = workerSource.indexOf('writeRpcEngine.sendTurn(', prepare);
    const guarded = workerSource.slice(prepare, sendTurn);

    expect(guarded).toMatch(
      /restorePreparedTraexNativeContext\(\s*msg,\s*item\.traexNativeContext,\s*nativeThreadId,\s*lastInitConfig\.traexNativeContextReceipt,\s*\)/,
    );
    expect(guarded.indexOf('restorePreparedTraexNativeContext'))
      .toBeLessThan(guarded.indexOf(': prepareTraexNativeContext'));
  });
});
