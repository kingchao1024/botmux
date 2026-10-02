import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tsRunnerPrefix, tsEvalArgs } from './helpers/ts-runner.js';
import {
  activateTaskControlTurnAdmissionSync,
  beginTaskControlKickoffOperationSync,
  beginTaskControlSeedOperationSync,
  claimTaskControlTurnAdmissionPendingSync,
  completeTaskControlKickoffOperationSync,
  createDispatchOperationId,
  findDispatchOperation,
  readTaskControlKickoffOperation,
  readTaskControlSeedOperation,
  readTaskControlTurnAdmission,
  recordDispatchRegistryEntry,
  terminalizeTaskControlTurnAdmissionSync,
} from '../src/core/dispatch-registry.js';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';

const registryModuleUrl = pathToFileURL(fileURLToPath(new URL('../src/core/dispatch-registry.ts', import.meta.url))).href;

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`registry writer exited code=${code} signal=${signal}: ${stderr}`));
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for registry writer');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function spawnWriter(registryPath: string, seed: string, holdMs: number): ChildProcess {
  const script = `
    import { updateDispatchRegistry } from ${JSON.stringify(registryModuleUrl)};
    await updateDispatchRegistry(${JSON.stringify(registryPath)}, async registry => {
      registry[${JSON.stringify(seed)}] = { orchSessionId: ${JSON.stringify(`session-${seed}`)} };
      await new Promise(resolve => setTimeout(resolve, ${holdMs}));
    });
  `;
  // Node still needs `--import tsx` on top of the eval args because the snippet
  // imports a repo .ts module; Bun runs TypeScript natively.
  const { command, prefixArgs } = tsRunnerPrefix();
  return spawn(command, [...prefixArgs, ...tsEvalArgs(script).args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function spawnAdmissionClaim(
  registryPath: string,
  messageId: string,
  dispatchRoot = 'om_task_root',
): ChildProcess {
  const script = `
    import { claimTaskControlTurnAdmissionPendingSync } from ${JSON.stringify(registryModuleUrl)};
    try {
      claimTaskControlTurnAdmissionPendingSync(${JSON.stringify(registryPath)}, {
        messageId: ${JSON.stringify(messageId)}, chatId: 'oc_project',
        dispatchRoot: ${JSON.stringify(dispatchRoot)}, targetAppId: 'cli_worker',
        sessionId: ${JSON.stringify(`session_${messageId}`)},
      }, '2026-09-30T00:00:00.000Z');
      process.stdout.write('claimed');
    } catch (error) {
      process.stdout.write(error instanceof Error ? error.message : String(error));
    }
  `;
  const { command, prefixArgs } = tsRunnerPrefix();
  return spawn(command, [...prefixArgs, ...tsEvalArgs(script).args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collectResult(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

describe('dispatch registry persistence', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('derives a stable provider-safe operation id from the exact dispatch request', () => {
    const input = { sessionId: 'session-1', turnId: 'turn-1', targetAppIds: ['cli_worker'] };
    const operationId = createDispatchOperationId(input);
    expect(operationId).toMatch(/^[a-f0-9]{50}$/);
    expect(createDispatchOperationId(structuredClone(input))).toBe(operationId);
    expect(createDispatchOperationId({ ...input, turnId: 'turn-2' })).not.toBe(operationId);
  });

  it('persists a domain-separated seed operation before its provider effect', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const operationId = 'a'.repeat(50);
    const payloadHash = 'b'.repeat(64);
    const operation = beginTaskControlSeedOperationSync(registryPath, {
      operationId,
      sourceAppId: 'cli_coordinator',
      targetChatId: 'oc_project',
      messageType: 'text',
      payloadHash,
      attempt: {
        wallTime: '2026-09-30T00:00:00.000Z',
        bootId: 'boot-1',
        processStartIdentity: 'process-start-1',
        monotonicMs: 1_000,
      },
    });

    expect(operation).toMatchObject({
      schemaVersion: 'TaskControlSeedOperation.v1', operationId,
      sourceAppId: 'cli_coordinator', targetChatId: 'oc_project',
      messageType: 'text', payloadHash, state: 'pending',
    });
    expect(operation.providerUuid).toBe(createDispatchOperationId({
      schemaVersion: 'TaskControlProviderUuid.v1', effect: 'seed_root', operationId,
      targetChatId: 'oc_project', targetRoot: null, messageType: 'text', payloadHash,
    }));
    expect(operation.providerUuid).not.toBe(createDispatchOperationId({
      schemaVersion: 'TaskControlProviderUuid.v1', effect: 'phase_a_instruction', operationId,
      targetChatId: 'oc_project', targetRoot: null, messageType: 'text', payloadHash,
    }));
    expect(readTaskControlSeedOperation(registryPath, operationId)).toEqual(operation);
  });

  it('replays a pending seed only in the same-process monotonic window and quarantines unprovable retries', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const base = {
      operationId: 'c'.repeat(50), sourceAppId: 'cli_coordinator',
      targetChatId: 'oc_project', messageType: 'text' as const, payloadHash: 'd'.repeat(64),
    };
    const initial = beginTaskControlSeedOperationSync(registryPath, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:00:00.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 10_000,
      },
    });
    const safeReplay = beginTaskControlSeedOperationSync(registryPath, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:53:59.999Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 3_249_999,
      },
    });
    expect(safeReplay).toEqual(initial);

    const restarted = beginTaskControlSeedOperationSync(registryPath, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:54:00.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-2', monotonicMs: 1,
      },
    });
    expect(restarted).toMatchObject({ state: 'ambiguous', attempt: initial.attempt });
    expect(readTaskControlSeedOperation(registryPath, base.operationId)).toEqual(restarted);

    const invalidClockId = 'e'.repeat(50);
    beginTaskControlSeedOperationSync(registryPath, {
      ...base, operationId: invalidClockId,
      attempt: {
        wallTime: '2026-09-30T01:00:00.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 10_000,
      },
    });
    expect(beginTaskControlSeedOperationSync(registryPath, {
      ...base, operationId: invalidClockId,
      attempt: {
        wallTime: '2026-09-30T01:00:01.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 9_999,
      },
    })).toMatchObject({ state: 'ambiguous' });
  });

  it('durably absorbs invalid persisted seed coordinates as ambiguous', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const attacks = [
      { operationId: '7'.repeat(50), payloadHash: '8'.repeat(64), damage: (row: any) => { row.attempt.monotonicMs = -1; } },
      { operationId: '6'.repeat(50), payloadHash: '9'.repeat(64), damage: (row: any) => { delete row.attempt.monotonicMs; } },
      { operationId: '5'.repeat(50), payloadHash: 'a'.repeat(64), damage: (row: any) => { delete row.attempt; } },
    ];
    for (const attack of attacks) {
      const base = {
        operationId: attack.operationId, sourceAppId: 'cli_coordinator',
        targetChatId: 'oc_project', messageType: 'text' as const, payloadHash: attack.payloadHash,
      };
      const pending = beginTaskControlSeedOperationSync(registryPath, {
        ...base,
        attempt: {
          wallTime: '2026-09-30T00:00:00.000Z', bootId: 'boot-1',
          processStartIdentity: 'process-start-1', monotonicMs: 10_000,
        },
      });
      const damaged = JSON.parse(readFileSync(registryPath, 'utf-8'));
      attack.damage(damaged.__taskControlSeedOperationsV1.operations[base.operationId]);
      writeFileSync(registryPath, JSON.stringify(damaged));

      const firstRecovery = beginTaskControlSeedOperationSync(registryPath, {
        ...base,
        attempt: {
          wallTime: '2026-09-30T00:00:01.000Z', bootId: 'boot-1',
          processStartIdentity: 'process-start-1', monotonicMs: 10_001,
        },
      });
      expect(firstRecovery).toMatchObject({
        state: 'ambiguous', providerUuid: pending.providerUuid,
      });
      expect(JSON.parse(readFileSync(registryPath, 'utf-8'))
        .__taskControlSeedOperationsV1.operations[base.operationId]).toEqual(firstRecovery);

      const laterRecovery = beginTaskControlSeedOperationSync(registryPath, {
        ...base,
        attempt: {
          wallTime: '2026-09-30T00:00:02.000Z', bootId: 'boot-1',
          processStartIdentity: 'process-start-1', monotonicMs: 10_002,
        },
      });
      expect(laterRecovery).toEqual(firstRecovery);
      expect(readTaskControlSeedOperation(registryPath, base.operationId)).toEqual(firstRecovery);
    }
  });

  it('replays an exact kickoff only inside the provider window and preserves its delivered receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const base = {
      operationId: 'f'.repeat(50), sourceAppId: 'cli_coordinator', chatId: 'oc_project',
      dispatchRoot: 'om_kickoff_root', fenceFingerprint: `tccq1:${'1'.repeat(64)}`,
      targetAppIds: ['cli_worker', 'cli_reviewer'], messageType: 'post' as const,
      payloadHash: '2'.repeat(64),
    };
    const initial = beginTaskControlKickoffOperationSync(registryPath, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:00:00.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 10_000,
      },
    });
    const safeReplay = beginTaskControlKickoffOperationSync(registryPath, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:53:59.999Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 3_249_999,
      },
    });
    expect(safeReplay).toEqual(initial);
    expect(initial.providerUuid).toBe(createDispatchOperationId({
      schemaVersion: 'TaskControlProviderUuid.v1', effect: 'kickoff_thread',
      operationId: base.operationId, targetChatId: base.chatId,
      targetRoot: base.dispatchRoot, messageType: 'post', payloadHash: base.payloadHash,
    }));

    const delivered = completeTaskControlKickoffOperationSync(registryPath, {
      operationId: base.operationId, messageId: 'om_kickoff_message',
    });
    expect(beginTaskControlKickoffOperationSync(registryPath, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T01:00:00.000Z', bootId: 'boot-2',
        processStartIdentity: 'process-start-2', monotonicMs: 1,
      },
    })).toEqual(delivered);
    expect(readTaskControlKickoffOperation(registryPath, base.operationId)).toEqual(delivered);
    expect(() => completeTaskControlKickoffOperationSync(registryPath, {
      operationId: base.operationId, messageId: 'om_different_message',
    })).toThrow('project_task_control_kickoff_operation_conflict');
  });

  it('quarantines a kickoff retry when producer continuity is not provable', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const base = {
      operationId: '9'.repeat(50), sourceAppId: 'cli_coordinator', chatId: 'oc_project',
      dispatchRoot: 'om_kickoff_root', fenceFingerprint: `tccq1:${'3'.repeat(64)}`,
      targetAppIds: ['cli_worker', 'cli_reviewer'], messageType: 'post' as const,
      payloadHash: '4'.repeat(64),
    };
    const initial = beginTaskControlKickoffOperationSync(registryPath, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:00:00.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 10_000,
      },
    });
    const ambiguous = beginTaskControlKickoffOperationSync(registryPath, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:54:00.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-2', monotonicMs: 1,
      },
    });
    expect(ambiguous).toMatchObject({ state: 'ambiguous', attempt: initial.attempt });
    expect(readTaskControlKickoffOperation(registryPath, base.operationId)).toEqual(ambiguous);
    expect(() => beginTaskControlKickoffOperationSync(registryPath, {
      ...base, payloadHash: '5'.repeat(64),
      attempt: {
        wallTime: '2026-09-30T00:54:01.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 10_001,
      },
    })).toThrow('project_task_control_kickoff_operation_conflict');
  });

  it('preserves existing report routing entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    writeFileSync(registryPath, JSON.stringify({ seed_old: { orchSessionId: 'session-old' } }));

    await recordDispatchRegistryEntry(registryPath, 'seed_new', { orchSessionId: 'session-new' });

    expect(JSON.parse(readFileSync(registryPath, 'utf-8'))).toEqual({
      seed_old: { orchSessionId: 'session-old' },
      seed_new: { orchSessionId: 'session-new' },
    });
  });

  it('finds the latest entry for a stable dispatch operation even after transport failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    writeFileSync(registryPath, JSON.stringify({
      om_live: { dispatchOperationId: 'same', status: 'dispatched' },
      om_latest: { dispatchOperationId: 'same', status: 'failed' },
    }));
    expect(findDispatchOperation(registryPath, 'same')).toMatchObject({ dispatchRoot: 'om_latest' });
    expect(findDispatchOperation(registryPath, 'missing')).toBeUndefined();
  });

  it('rejects replacing an existing dispatch report binding with another target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const existing = {
      orchSessionId: 'session-owner',
      reportBinding: createDispatchReportBinding('secret', {
        dispatchRoot: 'om_seed',
        targetLarkAppId: 'cli_owner',
        targetSessionId: 'session-owner',
        sourceName: 'owner task',
        issuedAt: '2026-08-10T00:00:00.000Z',
      }),
    };
    writeFileSync(registryPath, JSON.stringify({ om_seed: existing }));

    await expect(recordDispatchRegistryEntry(registryPath, 'om_seed', {
      orchSessionId: 'session-attacker',
      reportBinding: createDispatchReportBinding('secret', {
        dispatchRoot: 'om_seed',
        targetLarkAppId: 'cli_owner',
        targetSessionId: 'session-attacker',
        sourceName: 'attacker task',
        issuedAt: '2026-08-10T00:00:01.000Z',
      }),
    })).rejects.toThrow('dispatch registry entry already exists');

    expect(JSON.parse(readFileSync(registryPath, 'utf-8'))).toEqual({ om_seed: existing });
  });

  it('allows an exact idempotent rewrite for the same dispatch report binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const entry = {
      orchSessionId: 'session-owner',
      reportBinding: createDispatchReportBinding('secret', {
        dispatchRoot: 'om_seed',
        targetLarkAppId: 'cli_owner',
        targetSessionId: 'session-owner',
        sourceName: 'owner task',
        issuedAt: '2026-08-10T00:00:00.000Z',
      }),
    };
    writeFileSync(registryPath, JSON.stringify({ om_seed: entry }));

    await recordDispatchRegistryEntry(registryPath, 'om_seed', entry);

    expect(JSON.parse(readFileSync(registryPath, 'utf-8'))).toEqual({ om_seed: entry });
  });

  it('keeps both seeds when two CLI processes overlap their writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');

    // Writer A holds the critical section after reading. Writer B starts while
    // A owns the lock, so an unlocked read-modify-write would deterministically
    // lose one seed when A eventually renames its stale snapshot over B's file.
    const writerA = spawnWriter(registryPath, 'seed_a', 250);
    await waitUntil(() => existsSync(`${registryPath}.lock`));
    const writerB = spawnWriter(registryPath, 'seed_b', 0);

    await Promise.all([waitForExit(writerA), waitForExit(writerB)]);

    expect(JSON.parse(readFileSync(registryPath, 'utf-8'))).toEqual({
      seed_a: { orchSessionId: 'session-seed_a' },
      seed_b: { orchSessionId: 'session-seed_b' },
    });
    expect(existsSync(`${registryPath}.lock`)).toBe(false);
  }, 10_000);

  it('fails closed instead of replacing a malformed registry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    writeFileSync(registryPath, '[]');

    await expect(recordDispatchRegistryEntry(registryPath, 'seed_new', {}))
      .rejects.toThrow('orchestrate-dispatch.json must contain an object');
    expect(readFileSync(registryPath, 'utf-8')).toBe('[]');
    expect(existsSync(`${registryPath}.lock`)).toBe(false);
  });

  it('reuses one exact pending and active TaskControl turn claim by message id', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const claim = {
      messageId: 'om_exact_turn', chatId: 'oc_project', dispatchRoot: 'om_task_root',
      targetAppId: 'cli_worker', sessionId: 'session_worker',
    };

    const pending = claimTaskControlTurnAdmissionPendingSync(
      registryPath, claim, '2026-09-30T00:00:00.000Z',
    );
    const pendingRetry = claimTaskControlTurnAdmissionPendingSync(
      registryPath, claim, '2026-09-30T00:10:00.000Z',
    );
    expect(pendingRetry).toEqual(pending);

    const active = activateTaskControlTurnAdmissionSync(
      registryPath, { ...claim, workerGeneration: 7 }, '2026-09-30T00:11:00.000Z',
    );
    const activeRetry = activateTaskControlTurnAdmissionSync(
      registryPath, { ...claim, workerGeneration: 7 }, '2026-09-30T00:12:00.000Z',
    );
    expect(activeRetry).toEqual(active);
    expect(active).toMatchObject({ ...claim, workerGeneration: 7, state: 'active' });
    expect(() => activateTaskControlTurnAdmissionSync(
      registryPath, { ...claim, workerGeneration: 8 }, '2026-09-30T00:13:00.000Z',
    )).toThrow('project_task_control_turn_claim_conflict');
    expect(Object.keys(JSON.parse(readFileSync(registryPath, 'utf-8'))
      .__taskControlTurnAdmissionsV1.claims)).toEqual([claim.messageId]);
  });

  it('tracks worker and reviewer claims independently for the same kickoff message', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const base = {
      messageId: 'om_shared_kickoff', chatId: 'oc_project', dispatchRoot: 'om_task_root',
    };
    const worker = { ...base, targetAppId: 'cli_worker', sessionId: 'session_worker', workerGeneration: 7 };
    const reviewer = { ...base, targetAppId: 'cli_reviewer', sessionId: 'session_reviewer', workerGeneration: 8 };

    claimTaskControlTurnAdmissionPendingSync(registryPath, worker, '2026-09-30T00:00:00.000Z');
    claimTaskControlTurnAdmissionPendingSync(registryPath, reviewer, '2026-09-30T00:00:01.000Z');
    activateTaskControlTurnAdmissionSync(registryPath, worker, '2026-09-30T00:01:00.000Z');
    activateTaskControlTurnAdmissionSync(registryPath, reviewer, '2026-09-30T00:01:01.000Z');
    terminalizeTaskControlTurnAdmissionSync(registryPath, worker, '2026-09-30T00:02:00.000Z');
    terminalizeTaskControlTurnAdmissionSync(registryPath, reviewer, '2026-09-30T00:02:01.000Z');

    expect(readTaskControlTurnAdmission(registryPath, base.messageId, worker.targetAppId))
      .toMatchObject({ ...worker, state: 'terminal' });
    expect(readTaskControlTurnAdmission(registryPath, base.messageId, reviewer.targetAppId))
      .toMatchObject({ ...reviewer, state: 'terminal' });
    claimTaskControlTurnAdmissionPendingSync(registryPath, {
      messageId: 'om_after_compaction', chatId: 'oc_project', dispatchRoot: 'om_other_root',
      targetAppId: 'cli_worker', sessionId: 'session_after_compaction',
    }, '2026-09-30T01:02:02.000Z');
    const admissions = JSON.parse(readFileSync(registryPath, 'utf8')).__taskControlTurnAdmissionsV1;
    expect(Object.values(admissions.claims)).not.toContainEqual(
      expect.objectContaining({ messageId: base.messageId }),
    );
    expect(admissions.terminalSummaries[base.dispatchRoot]).toMatchObject({ count: 2 });
  });

  it('terminalizes only the exact active TaskControl turn claim and keeps exact retry idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const claim = {
      messageId: 'om_terminal_turn', chatId: 'oc_project', dispatchRoot: 'om_task_root',
      targetAppId: 'cli_worker', sessionId: 'session_worker', workerGeneration: 7,
    };
    claimTaskControlTurnAdmissionPendingSync(registryPath, claim, '2026-09-30T00:00:00.000Z');
    activateTaskControlTurnAdmissionSync(registryPath, claim, '2026-09-30T00:01:00.000Z');

    const terminal = terminalizeTaskControlTurnAdmissionSync(
      registryPath, claim, '2026-09-30T00:02:00.000Z',
    );
    const retry = terminalizeTaskControlTurnAdmissionSync(
      registryPath, claim, '2026-09-30T00:03:00.000Z',
    );
    expect(terminal).toMatchObject({ ...claim, state: 'terminal', terminalAt: '2026-09-30T00:02:00.000Z' });
    expect(retry).toEqual(terminal);
    expect(() => terminalizeTaskControlTurnAdmissionSync(
      registryPath, { ...claim, workerGeneration: 8 }, '2026-09-30T00:04:00.000Z',
    )).toThrow('project_task_control_turn_claim_conflict');
    expect(JSON.parse(readFileSync(registryPath, 'utf-8'))
      .__taskControlTurnAdmissionsV1.claims[claim.messageId]).toEqual(terminal);
  });

  it('atomically caps open TaskControl turn claims at 32 per root with one bounded overflow marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    for (let index = 0; index < 32; index += 1) {
      claimTaskControlTurnAdmissionPendingSync(registryPath, {
        messageId: `om_turn_${index}`, chatId: 'oc_project', dispatchRoot: 'om_task_root',
        targetAppId: 'cli_worker', sessionId: `session_${index}`,
      }, '2026-09-30T00:00:00.000Z');
    }

    const overflow = {
      messageId: 'om_turn_overflow', chatId: 'oc_project', dispatchRoot: 'om_task_root',
      targetAppId: 'cli_worker', sessionId: 'session_overflow',
    };
    expect(() => claimTaskControlTurnAdmissionPendingSync(
      registryPath, overflow, '2026-09-30T00:01:00.000Z',
    )).toThrow('project_task_control_turn_claim_per_root_capacity');
    expect(() => claimTaskControlTurnAdmissionPendingSync(
      registryPath, overflow, '2026-09-30T00:02:00.000Z',
    )).toThrow('project_task_control_turn_claim_per_root_capacity');

    const admissions = JSON.parse(readFileSync(registryPath, 'utf-8')).__taskControlTurnAdmissionsV1;
    expect(Object.keys(admissions.claims)).toHaveLength(32);
    expect(admissions.claims).not.toHaveProperty(overflow.messageId);
    expect(admissions.overflowMarkers).toEqual({
      perRoot: {
        reason: 'per_root', chatId: overflow.chatId, dispatchRoot: overflow.dispatchRoot,
        messageId: overflow.messageId, observedAt: '2026-09-30T00:01:00.000Z',
      },
    });
  });

  it('arbitrates the per-root admission boundary across independent processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    for (let index = 0; index < 31; index += 1) {
      claimTaskControlTurnAdmissionPendingSync(registryPath, {
        messageId: `om_existing_${index}`, chatId: 'oc_project', dispatchRoot: 'om_task_root',
        targetAppId: 'cli_worker', sessionId: `session_existing_${index}`,
      }, '2026-09-30T00:00:00.000Z');
    }

    const results = await Promise.all([
      collectResult(spawnAdmissionClaim(registryPath, 'om_racer_a')),
      collectResult(spawnAdmissionClaim(registryPath, 'om_racer_b')),
    ]);
    expect(results.map(result => result.code)).toEqual([0, 0]);
    expect(results.map(result => result.stdout).sort()).toEqual([
      'claimed', 'project_task_control_turn_claim_per_root_capacity',
    ]);
    const admissions = JSON.parse(readFileSync(registryPath, 'utf-8')).__taskControlTurnAdmissionsV1;
    expect(Object.keys(admissions.claims)).toHaveLength(32);
    expect(Object.keys(admissions.overflowMarkers)).toEqual(['perRoot']);
  }, 10_000);

  it('recovers a crash-left pending claim after process restart without minting another claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const created = await collectResult(spawnAdmissionClaim(registryPath, 'om_restart_turn'));
    expect(created).toMatchObject({ code: 0, stdout: 'claimed' });

    const active = activateTaskControlTurnAdmissionSync(registryPath, {
      messageId: 'om_restart_turn', chatId: 'oc_project', dispatchRoot: 'om_task_root',
      targetAppId: 'cli_worker', sessionId: 'session_om_restart_turn', workerGeneration: 11,
    }, '2026-09-30T00:10:00.000Z');
    expect(active).toMatchObject({ state: 'active', workerGeneration: 11 });
    expect(Object.keys(JSON.parse(readFileSync(registryPath, 'utf-8'))
      .__taskControlTurnAdmissionsV1.claims)).toEqual(['om_restart_turn']);
  });

  it('atomically caps open TaskControl turn claims at 256 globally', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    for (let index = 0; index < 256; index += 1) {
      claimTaskControlTurnAdmissionPendingSync(registryPath, {
        messageId: `om_global_${index}`, chatId: 'oc_project',
        dispatchRoot: `om_task_${Math.floor(index / 32)}`,
        targetAppId: 'cli_worker', sessionId: `session_${index}`,
      }, '2026-09-30T00:00:00.000Z');
    }
    expect(() => claimTaskControlTurnAdmissionPendingSync(registryPath, {
      messageId: 'om_global_overflow', chatId: 'oc_project', dispatchRoot: 'om_task_8',
      targetAppId: 'cli_worker', sessionId: 'session_overflow',
    }, '2026-09-30T00:01:00.000Z')).toThrow('project_task_control_turn_claim_global_capacity');

    const admissions = JSON.parse(readFileSync(registryPath, 'utf-8')).__taskControlTurnAdmissionsV1;
    expect(Object.keys(admissions.claims)).toHaveLength(256);
    expect(admissions.overflowMarkers.global).toEqual({
      reason: 'global', chatId: 'oc_project', dispatchRoot: 'om_task_8',
      messageId: 'om_global_overflow', observedAt: '2026-09-30T00:01:00.000Z',
    });
  });

  it('compacts terminal claims older than one hour into a deterministic per-root chain only', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    const terminalClaims = [
      {
        messageId: 'om_terminal_b', chatId: 'oc_project', dispatchRoot: 'om_task_root',
        targetAppId: 'cli_worker', sessionId: 'session_b', workerGeneration: 8,
        state: 'terminal', createdAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:30:00.000Z', terminalAt: '2026-09-30T00:30:00.000Z',
      },
      {
        messageId: 'om_terminal_a', chatId: 'oc_project', dispatchRoot: 'om_task_root',
        targetAppId: 'cli_worker', sessionId: 'session_a', workerGeneration: 7,
        state: 'terminal', createdAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:20:00.000Z', terminalAt: '2026-09-30T00:20:00.000Z',
      },
    ];
    const active = {
      messageId: 'om_active', chatId: 'oc_project', dispatchRoot: 'om_task_root',
      targetAppId: 'cli_worker', sessionId: 'session_active', workerGeneration: 9,
      state: 'active', createdAt: '2026-09-30T00:40:00.000Z', updatedAt: '2026-09-30T00:40:00.000Z',
    };
    writeFileSync(registryPath, JSON.stringify({
      __taskControlTurnAdmissionsV1: {
        claims: Object.fromEntries([...terminalClaims, active].map(claim => [claim.messageId, claim])),
      },
    }));

    claimTaskControlTurnAdmissionPendingSync(registryPath, {
      messageId: 'om_new', chatId: 'oc_project', dispatchRoot: 'om_other_root',
      targetAppId: 'cli_worker', sessionId: 'session_new',
    }, '2026-09-30T01:31:00.000Z');

    let chainedHash = `tcta1:${'0'.repeat(64)}`;
    for (const claim of [...terminalClaims].sort((left, right) =>
      left.terminalAt.localeCompare(right.terminalAt) || left.messageId.localeCompare(right.messageId))) {
      chainedHash = `tcta1:${createHash('sha256').update(JSON.stringify({
        previousHash: chainedHash,
        messageId: claim.messageId, chatId: claim.chatId, dispatchRoot: claim.dispatchRoot,
        targetAppId: claim.targetAppId, sessionId: claim.sessionId,
        workerGeneration: claim.workerGeneration, terminalAt: claim.terminalAt,
      })).digest('hex')}`;
    }
    const admissions = JSON.parse(readFileSync(registryPath, 'utf-8')).__taskControlTurnAdmissionsV1;
    expect(admissions.claims).not.toHaveProperty('om_terminal_a');
    expect(admissions.claims).not.toHaveProperty('om_terminal_b');
    expect(admissions.claims.om_active).toEqual(active);
    expect(admissions.terminalSummaries.om_task_root).toEqual({
      count: 2, lastTerminalAt: '2026-09-30T00:30:00.000Z', chainedHash,
    });
  });
});
