/**
 * Integration tests for schedule terminal state: the path from turn_terminal
 * through parseScheduledTurnId → dispatchedTurnRunIds lookup → settleTerminalRun.
 *
 * These tests exercise the PRODUCTION thin-adapter functions directly.  No
 * test-local copies of bindDispatchedTurn / settleScheduledTurn; no sibling
 * scanning; no direct runId injection.
 *
 * Run:  bun run test -- test/schedule-terminal-integration.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attachOrdinaryTurnRecovery,
  beginOrdinaryTurnRecovery,
  handleOrdinaryTurnRecoveryTerminal,
  disposeOrdinaryTurnRecovery,
} from '../src/services/ordinary-turn-recovery.js';
import { executeScheduledTaskForTargets, ScheduleTargetExecutionError } from '../src/services/schedule-target-executor.js';

// ─── Shared state ────────────────────────────────────────────────────────────

let tempDir: string;

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() {
        return join(tempDir, 'data');
      },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Production imports ──────────────────────────────────────────────────────
//
// Fresh-imported per-test to reset module-level state.  The production
// adapter (schedule-turn-binding.ts) imports settleTerminalRun / getTask
// from schedule-store.js, which shares the mock context.

import {
  bindDispatchedTurn,
  settleScheduledTurn,
  cleanupTaskBindings,
  recordTaskRunId,
  lookupTaskRunId,
} from '../src/services/schedule-turn-binding.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_APP = 'cli_testapp0000000001';

interface FreshEnv {
  owner: {
    beginRun: (taskId: string, runId: string) => void;
    bindDispatch: (turnId: string, runId: string) => boolean;
    bindRecovery: (turnId: string, sourceTurnId: string) => boolean;
    releaseRecovery: (turnId: string) => void;
    settle: (turnId: string, status: 'completed' | 'failed' | 'cancelled' | 'ambiguous', errorCode?: string) => boolean;
    restore: () => void;
    deleteTask: (taskId: string) => void;
    hasTransient: (turnId: string) => boolean;
    hasDurable: (turnId: string) => boolean;
  };
  createTask: (params: Record<string, unknown>) => any;
  claimRun: (id: string, claim: Record<string, unknown>) => any;
  markRun: (id: string, success: boolean, error?: string, deliveryError?: string, runId?: string) => void;
  settleTerminalRun: (id: string, runId: string, success: boolean, error?: string, turnId?: string, sourceTurnId?: string) => boolean;
  setRunTargetCount: (id: string, count: number, runId: string) => void;
  bindRunTurnId: (id: string, turnId: string, runId: string) => void;
  getTask: (id: string) => any;
  bindDispatchedTurn: (bindings: Map<string, string>, turnId: string, runId: string) => void;
  settleScheduledTurn: (bindings: Map<string, string>, turnId: string, status: 'completed' | 'failed' | 'cancelled' | 'ambiguous', errorCode?: string) => boolean;
  cleanupTaskBindings: (bindings: Map<string, string>, taskId: string) => void;
  recordTaskRunId: (taskRunIds: Map<string, string>, taskId: string, runId: string) => void;
  lookupTaskRunId: (taskRunIds: Map<string, string>, taskId: string) => string | undefined;
  recordRecoverySource: (recoveryTurnId: string, sourceTurnId: string) => void;
  setRecoveryBindFn: (cb: (turnId: string, logicalTurnId: string) => string | undefined, release?: (turnId: string) => void) => void;
  bindRecoveryTurn: (turnId: string, logicalTurnId: string) => boolean;
  releaseRecoveryTurn: (turnId: string) => void;
    abandonRecoveryTurn: (turnId: string) => void;
}

/**
 * Fresh environment: reset modules, import store + adapter from a shared
 * module cache so that both read/write to the same in-memory task map.
 */
async function freshEnv(): Promise<FreshEnv> {
  vi.resetModules();
  const storeMod = await import('../src/services/schedule-store.js');
  storeMod.setScheduleScope(TEST_APP);
  // The adapter imports from schedule-store.js — since it's after
  // setScheduleScope in the same module cache, settleTerminalRun will
  // find the scope already bound.
  await import('../src/core/scheduled-turn-provenance.js');
  const adapterMod = await import('../src/services/schedule-turn-binding.js');
  const owner = new adapterMod.ScheduleTurnBindingOwner();
  adapterMod.setScheduleTurnBindingOwner(owner);
  return {
    owner,
    createTask: storeMod.createTask,
    claimRun: storeMod.claimRun,
    markRun: storeMod.markRun,
    settleTerminalRun: storeMod.settleTerminalRun,
    setRunTargetCount: storeMod.setRunTargetCount,
    bindRunTurnId: storeMod.bindRunTurnId,
    getTask: storeMod.getTask,
    bindDispatchedTurn: adapterMod.bindDispatchedTurn,
    settleScheduledTurn: adapterMod.settleScheduledTurn,
    cleanupTaskBindings: adapterMod.cleanupTaskBindings,
    recordTaskRunId: adapterMod.recordTaskRunId,
    lookupTaskRunId: adapterMod.lookupTaskRunId,
    recordRecoverySource: adapterMod.recordRecoverySource,
    setRecoveryBindFn: adapterMod.setRecoveryBindFn,
    bindRecoveryTurn: adapterMod.bindRecoveryTurn,
    releaseRecoveryTurn: adapterMod.releaseRecoveryTurn,
    abandonRecoveryTurn: adapterMod.abandonRecoveryTurn,
  };
}

const TASK_PARAMS = {
  name: 'Integration task',
  schedule: '0 9 * * *',
  parsed: { kind: 'cron' as const, expr: '0 9 * * *', display: '0 9 * * *' },
  prompt: 'Run integration test',
  workingDir: '/workspace/project',
  chatId: 'oc_test_chat',
};

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schedule-term-integration-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('schedule turn_terminal integration', () => {
  // ── Basic lifecycle ─────────────────────────────────────────────────────

  it('model_dispatched (markRun) does NOT write terminal state', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_running' });
    const runId = 'run-integration-1';

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T01:00:00.000Z',
      nextRunAt: '2026-09-27T01:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const reloaded = env.getTask(task.id);
    expect(reloaded.lastStatus).toBe('ok');            // dispatch settled
    expect(reloaded.lastTerminalStatus).toBeUndefined(); // terminal NOT set
  });

  it('turn_terminal completed writes lastTerminalStatus=ok', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_completed' });
    const runId = 'run-int-completed';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T02:00:00.000Z',
      nextRunAt: '2026-09-27T02:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_completed:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    const settled = env.settleScheduledTurn(bindings, turnId, 'completed');
    expect(settled).toBe(true);

    const reloaded = env.getTask(task.id);
    expect(reloaded.lastTerminalStatus).toBe('ok');
  });

  it('turn_terminal failed writes lastTerminalStatus=error with errorCode', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_failed' });
    const runId = 'run-int-failed';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T03:00:00.000Z',
      nextRunAt: '2026-09-27T03:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_failed:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    const settled = env.settleScheduledTurn(bindings, turnId, 'failed', 'ECONNREFUSED');
    expect(settled).toBe(true);

    const reloaded = env.getTask(task.id);
    expect(reloaded.lastTerminalStatus).toBe('error');
    expect(reloaded.lastTerminalError).toBe('ECONNREFUSED');
  });

  it('turn_terminal cancelled writes lastTerminalStatus=error', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_cancelled' });
    const runId = 'run-int-cancelled';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T04:00:00.000Z',
      nextRunAt: '2026-09-27T04:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_cancelled:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    const settled = env.settleScheduledTurn(bindings, turnId, 'cancelled', 'CANCELLED');
    expect(settled).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');
  });

  // ── Routing / validation ────────────────────────────────────────────────

  it('non-schedule turnId is ignored (no terminal write)', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_nonschedule' });
    const runId = 'run-int-nonschedule';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T05:00:00.000Z',
      nextRunAt: '2026-09-27T05:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const ordinaryTurnId = 'some-ordinary-turn-id';
    const settled = env.settleScheduledTurn(bindings, ordinaryTurnId, 'completed');
    expect(settled).toBe(false);

    const reloaded = env.getTask(task.id);
    expect(reloaded.lastTerminalStatus).toBeUndefined();
  });

  it('malformed turnId (not schedule: pattern) is ignored', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_malformed' });
    const bindings = new Map<string, string>();

    const badTurnIds = [
      'schedule:not-a-uuid',
      'schedule:too:many:colons',
      'schedule:taskId:',
      'plain-string',
      '',
    ];

    for (const turnId of badTurnIds) {
      const settled = env.settleScheduledTurn(bindings, turnId, 'completed');
      expect(settled).toBe(false);
    }

    expect(env.getTask(task.id)!.lastTerminalStatus).toBeUndefined();
  });

  it('terminal from unbound turnId is rejected (fail-closed)', async () => {
    // Production settleScheduledTurn does NOT scan sibling bindings.
    // If the turnId has no exact binding in the map, it is rejected.
    // Recovery continuations must be explicitly bound via bindDispatchedTurn
    // (called by bindRecoveryTurn from the daemon's setRecoveryBindFn callback)
    // BEFORE the turn becomes visible to the worker.
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_unbound' });
    const runId = 'run-unbound';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T15:00:00.000Z',
      nextRunAt: '2026-09-27T15:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    // TurnId is NOT in bindings map — no sibling scan, fail-closed.
    const turnId = `schedule:int_unbound:${crypto.randomUUID()}`;
    const settled = env.settleScheduledTurn(bindings, turnId, 'completed');
    expect(settled).toBe(false);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBeUndefined();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────

  it('double-settle of the same run is rejected (idempotent)', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_double' });
    const runId = 'run-int-double';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T06:00:00.000Z',
      nextRunAt: '2026-09-27T06:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_double:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    // First settle succeeds
    const first = env.settleScheduledTurn(bindings, turnId, 'completed');
    expect(first).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('ok');
    const terminalAt = env.getTask(task.id)!.lastTerminalAt;

    // Re-bind same turnId then settle again — must be rejected.
    env.bindDispatchedTurn(bindings, turnId, runId);
    const second = env.settleScheduledTurn(bindings, turnId, 'failed', 'LATE_ERROR');
    expect(second).toBe(false);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('ok');
    expect(env.getTask(task.id)!.lastTerminalAt).toBe(terminalAt);
  });

  // ── Run progression ─────────────────────────────────────────────────────

  it('new run terminal overwrites previous run terminal', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_overwrite' });
    const bindings = new Map<string, string>();

    // Run 1
    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T07:00:00.000Z',
      nextRunAt: '2026-09-27T07:00:00.000Z',
      lastRunId: 'run-int-1',
    });
    env.markRun(task.id, true, undefined, undefined, 'run-int-1');
    const turn1 = `schedule:int_overwrite:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turn1, 'run-int-1');
    env.settleScheduledTurn(bindings, turn1, 'completed');
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('ok');

    // Run 2
    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T08:00:00.000Z',
      nextRunAt: '2026-09-27T08:00:00.000Z',
      lastRunId: 'run-int-2',
    });
    env.markRun(task.id, true, undefined, undefined, 'run-int-2');
    const turn2 = `schedule:int_overwrite:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turn2, 'run-int-2');
    env.settleScheduledTurn(bindings, turn2, 'failed', 'ECONNRESET');
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');
    expect(env.getTask(task.id)!.lastTerminalError).toBe('ECONNRESET');
  });

  it('stale terminal from old dispatch crossing new claim is rejected', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_stale_xclaim' });

    // Run A
    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T10:00:00.000Z',
      nextRunAt: '2026-09-27T10:00:00.000Z',
      lastRunId: 'run-int-a',
    });
    const turnIdA = 'schedule:int_stale_xclaim:aaaaaaa1-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const bindings = new Map<string, string>();
    env.bindDispatchedTurn(bindings, turnIdA, 'run-int-a');
    const settledA = env.settleScheduledTurn(bindings, turnIdA, 'completed');
    expect(settledA).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('ok');
    env.markRun(task.id, true, undefined, undefined, 'run-int-a');

    // Run B
    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T11:00:00.000Z',
      nextRunAt: '2026-09-27T11:00:00.000Z',
      lastRunId: 'run-int-b',
    });
    env.markRun(task.id, true, undefined, undefined, 'run-int-b');

    // Stale Run A terminal → rejected
    env.bindDispatchedTurn(bindings, turnIdA, 'run-int-a');
    const staleSettle = env.settleScheduledTurn(bindings, turnIdA, 'failed', 'STALE_ERROR');
    expect(staleSettle).toBe(false);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('ok');

    // Run B terminal → accepted
    const turnIdB = 'schedule:int_stale_xclaim:bbbbbbb2-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    env.bindDispatchedTurn(bindings, turnIdB, 'run-int-b');
    const settledB = env.settleScheduledTurn(bindings, turnIdB, 'failed', 'ECONNRESET');
    expect(settledB).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');
  });

  // ── Recovery continuation ───────────────────────────────────────────────

  it('recovery continuation uses task→runId map for precise binding', async () => {
    // In production, the daemon's setRecoveryBindFn callback calls
    // bindRecoveryTurn(turnId, logicalTurnId), which:
    //   1. parseScheduledTurnId(logicalTurnId) → taskId
    //   2. lookupTaskRunId(taskRunIds, taskId) → runId
    //   3. bindDispatchedTurn(turnBindings, turnId, runId)
    // This test replicates that exact flow with the production env.
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_recovery' });
    const runId = 'run-recovery';
    const bindings = new Map<string, string>();
    const taskRunIds = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T12:00:00.000Z',
      nextRunAt: '2026-09-27T12:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    // Bind original turnId (explicit dispatch binding)
    const origTurnId = `schedule:int_recovery:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, origTurnId, runId);

    // Record task→runId (same as daemon's recordTaskRunId in scheduler callback)
    env.recordTaskRunId(taskRunIds, task.id, runId);

    // Recovery continuation: simulate bindRecoveryTurn(turnId, logicalTurnId)
    const recoveryTurnId = `schedule:int_recovery:${crypto.randomUUID()}`;
    const recoveredRunId = env.lookupTaskRunId(taskRunIds, task.id);
    expect(recoveredRunId).toBe(runId);
    env.bindDispatchedTurn(bindings, recoveryTurnId, recoveredRunId!);

    const settled = env.settleScheduledTurn(bindings, recoveryTurnId, 'completed');
    expect(settled).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('ok');
  });

  // ── Multi-target deferred-ok ────────────────────────────────────────────

  it('multi-target: defers ok until all targets settle', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_multi_ok' });
    const runId = 'run-multi-ok';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T13:00:00.000Z',
      nextRunAt: '2026-09-27T13:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    // Dispatch 3 targets
    env.setRunTargetCount(task.id, 3, runId);

    const t1 = `schedule:int_multi_ok:${crypto.randomUUID()}`;
    const t2 = `schedule:int_multi_ok:${crypto.randomUUID()}`;
    const t3 = `schedule:int_multi_ok:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, t1, runId);
    env.bindDispatchedTurn(bindings, t2, runId);
    env.bindDispatchedTurn(bindings, t3, runId);

    // Target 1 succeeds — deferred
    const s1 = env.settleScheduledTurn(bindings, t1, 'completed');
    expect(s1).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBeUndefined();

    // Target 2 succeeds — still deferred
    const s2 = env.settleScheduledTurn(bindings, t2, 'completed');
    expect(s2).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBeUndefined();

    // Target 3 succeeds — ALL settled, now write ok
    const s3 = env.settleScheduledTurn(bindings, t3, 'completed');
    expect(s3).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('ok');
  });

  it('multi-target: error writes immediately, blocks subsequent ok', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_multi_err' });
    const runId = 'run-multi-err';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T14:00:00.000Z',
      nextRunAt: '2026-09-27T14:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    env.setRunTargetCount(task.id, 2, runId);

    const t1 = `schedule:int_multi_err:${crypto.randomUUID()}`;
    const t2 = `schedule:int_multi_err:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, t1, runId);
    env.bindDispatchedTurn(bindings, t2, runId);

    // Target 1 fails — error written (settled count increments)
    const s1 = env.settleScheduledTurn(bindings, t1, 'failed', 'T1_ERR');
    expect(s1).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');
    expect(env.getTask(task.id)!.lastTerminalError).toBe('T1_ERR');

    // Target 2 succeeds — settlement accepted (source counted), but error projection
    // is sticky (per-run perTargetErrors still has t1, so hasErrors=true).
    const s2 = env.settleScheduledTurn(bindings, t2, 'completed');
    expect(s2).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');
    // settledTurnIds should be 2 (both targets' sources counted)
    expect(env.getTask(task.id)!.runRecords?.[runId]?.settledTurnIds.length).toBe(2);
  });

  // ── Partial dispatch failure ────────────────────────────────────────────

  it('partial dispatch failure: setRunTargetCount + failed-settle blocks success terminal', async () => {
    // Production daemon error path: setRunTargetCount is called BEFORE
    // dispatch, and each failed target is settled via settleTerminalRun.
    // A subsequently-arriving success terminal from a dispatched target
    // must be rejected by the error-sticky guard.
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_partial_fix' });
    const runId = 'run-partial-fix';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T17:00:00.000Z',
      nextRunAt: '2026-09-27T17:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    // Daemon error path: total 3 targets, 1 failed at dispatch
    env.setRunTargetCount(task.id, 3, runId);

    // Settle the failed target (no turnId — daemon calls directly with sourceTurnId)
    env.bindRunTurnId(task.id, 'dispatch-failed:src', runId);
    const failedSettled = env.settleTerminalRun(
      task.id, runId, false, 'DISPATCH_FAILED', undefined, 'dispatch-failed:src',
    );
    expect(failedSettled).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');

    // Bind and settle a dispatched target — settlement accepted (source counted)
    // but error projection is sticky (error already set by failed target).
    const turnId = `schedule:int_partial_fix:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);
    const settled = env.settleScheduledTurn(bindings, turnId, 'completed');
    expect(settled).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');
  });

  // ── P1-1: Recovery success corrects same-target error ────────────────────

  it('P1-1 RED: recovery success corrects same-target error (multi-target)', async () => {
    // Multi-target run: 2 targets.  Target 1 fails → error written.
    // Recovery retries target 1 successfully → should clear error and
    // write ok (all targets settled, no errors remain).
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_1' });
    const runId = 'run-p1-1';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T19:00:00.000Z',
      nextRunAt: '2026-09-27T19:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);
    env.setRunTargetCount(task.id, 2, runId);

    // Dispatch 2 targets
    const t1 = `schedule:int_p1_1:${crypto.randomUUID()}`;
    const t2 = `schedule:int_p1_1:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, t1, runId);
    env.bindDispatchedTurn(bindings, t2, runId);

    // Target 1 fails → error written, settledCount=1
    const s1 = env.settleScheduledTurn(bindings, t1, 'failed', 'T1_ERR');
    expect(s1).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');
    expect(env.getTask(task.id)!.lastTerminalError).toBe('T1_ERR');

    // Target 2 succeeds — settlement accepted (source counted), but error persists.
    // Error is now projected (hasErrors=true from t1), so lastTerminalStatus stays 'error'.
    const s2 = env.settleScheduledTurn(bindings, t2, 'completed');
    expect(s2).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');
    expect(env.getTask(task.id)!.runRecords?.[runId]?.settledTurnIds.length).toBe(2);

    // Recovery of target 1: without source mapping, treated as new target.
    // Settlement is accepted but error persists (no source mapping to clear t1's error).
    const recoveryTurnId = `schedule:int_p1_1:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, recoveryTurnId, runId);
    const s3 = env.settleScheduledTurn(
      bindings, recoveryTurnId, 'completed', undefined,
    );
    // RED: without source mapping, recovery can't clear per-target error.
    expect(s3).toBe(true);  // settlement accepted (counted as new source)
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error'); // RED — still error (not corrected)
    // settledTurnIds now has 3: t1, t2, recoveryTurnId (recovery counted as separate source)
    expect(env.getTask(task.id)!.runRecords?.[runId]?.settledTurnIds.length).toBe(3);
  });

  it('P1-1 GREEN: recovery source tracking enables per-target error correction', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_1_green' });
    const runId = 'run-p1-1-green';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T20:00:00.000Z',
      nextRunAt: '2026-09-27T20:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);
    env.setRunTargetCount(task.id, 2, runId);

    const t1 = `schedule:int_p1_1_green:${crypto.randomUUID()}`;
    const t2 = `schedule:int_p1_1_green:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, t1, runId);
    env.bindDispatchedTurn(bindings, t2, runId);

    // Target 1 fails
    env.settleScheduledTurn(bindings, t1, 'failed', 'T1_ERR');
    // Target 2 succeeds (rejected by sticky)
    env.settleScheduledTurn(bindings, t2, 'completed');
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');

    // Simulate recovery with source mapping (like the daemon's
    // setRecoveryBindFn callback which calls recordRecoverySource).
    const recoveryTurnId = `schedule:int_p1_1_green:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, recoveryTurnId, runId);
    // Set up recovery source mapping (this is what recordRecoverySource does)
    env.recordRecoverySource?.(recoveryTurnId, t1);
    // Need to call settleScheduledTurn with the source mapping in place

    const s3 = env.settleScheduledTurn(bindings, recoveryTurnId, 'completed');
    // GREEN: recovery success should clear t1's error, all targets settled → ok
    expect(s3).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('ok');
  });

  // ── P1-2: Recovery uses exact turnId→runId binding from durable map ────

  it('P1-2 RED: recovery continuation uses durable map keyed by exact turnId (cross-claim)', async () => {
    // Run A: dispatch turnA → durable map has turnA→runA.
    // Run B claims → durable map still has turnA→runA.
    // Recovery for turnA fires → setRecoveryBindFn callback resolves runA.
    // bindRecoveryTurn binds recoveryTurnId → runA via the callback.
    // settleScheduledTurn accepts the recovery terminal because runId matches.
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_2' });
    const runA = 'run-p1-2-a';
    const bindings = new Map<string, string>();

    // ── Run A dispatch ──────────────────────────────────────────────────
    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T10:00:00.000Z',
      nextRunAt: '2026-09-27T10:00:00.000Z',
      lastRunId: runA,
    });
    env.markRun(task.id, true, undefined, undefined, runA);

    const turnA = `schedule:int_p1_2:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnA, runA);

    // Simulate the daemon's dispatch-side durable map population.
    // The durable map is keyed by exact turnId and NEVER consumed.
    const durableMap = new Map<string, string>();
    durableMap.set(turnA, runA);

    // Run A terminal arrives → consumed from bindings
    const settledA = env.settleScheduledTurn(bindings, turnA, 'failed', 'A_FAILED');
    expect(settledA).toBe(true);
    expect(env.getTask(task.id)!.lastTerminalStatus).toBe('error');

    // ── Run B claims ───────────────────────────────────────────────────
    const runB = 'run-p1-2-b';
    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T11:00:00.000Z',
      nextRunAt: '2026-09-27T11:00:00.000Z',
      lastRunId: runB,
    });
    env.markRun(task.id, true, undefined, undefined, runB);

    // ── Recovery for Run A's logicalTurnId=turnA ────────────────────────
    // The daemon's setRecoveryBindFn callback uses the durable map to
    // look up runId by exact logicalTurnId (=turnA).  It then binds the
    // recovery turnId and records the recovery source.
    // We wire the production adapter so the test exercises the real path.
    env.setRecoveryBindFn((recoveryTurnId: string, logicalTurnId: string): string | undefined => {
      const resolvedRunId = durableMap.get(logicalTurnId);
      if (!resolvedRunId) return undefined;
      // Production callback does bindDispatchedTurn + recordRecoverySource
      env.bindDispatchedTurn(bindings, recoveryTurnId, resolvedRunId);
      env.recordRecoverySource(recoveryTurnId, logicalTurnId);
      return resolvedRunId;
    });

    const recoveryTurnId = `schedule:int_p1_2:${crypto.randomUUID()}`;
    // Production: ensureOrdinaryTurnRecoveryAttached calls
    // bindRecoveryTurn(recoveryTurnId, logicalTurnId=turnA)
    env.bindRecoveryTurn(recoveryTurnId, turnA);
    // Now bindings should have recoveryTurnId → runA (from the callback)

    // Settle the recovery terminal
    const settledRecovery = env.settleScheduledTurn(bindings, recoveryTurnId, 'completed');
    // GREEN: recovery should be accepted with runA, not rejected by runB mismatch
    expect(settledRecovery).toBe(true);   // RED if cross-claim binding fails
    expect(env.getTask(task.id)!.lastTerminalRunId).toBe(runA);
  });

  // ── P1-3: Daemon restart — fallback to persisted per-run turnBindings ──

  it('P1-3 RED: daemon restart restores runId binding from persisted per-run turnBindings', async () => {
    // Run A: dispatch turnA → persist turnA→runA via bindRunTurnId.
    // Simulate restart: clear in-memory maps.
    // Recovery fires → setRecoveryBindFn falls back to runRecords[rid].turnBindings.
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_3' });
    const runA = 'run-p1-3-a';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T12:00:00.000Z',
      nextRunAt: '2026-09-27T12:00:00.000Z',
      lastRunId: runA,
    });
    env.markRun(task.id, true, undefined, undefined, runA);

    const turnA = `schedule:int_p1_3:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnA, runA);

    // Persist the turnId→runId binding (daemon calls bindRunTurnId at dispatch)
    const storeMod = await import('../src/services/schedule-store.js');
    storeMod.bindRunTurnId(task.id, turnA, runA);

    // Run A terminal arrives
    const settledA = env.settleScheduledTurn(bindings, turnA, 'failed', 'A_FAILED');
    expect(settledA).toBe(true);

    // Simulate daemon restart: in-memory maps are empty.
    // The recovery binding callback must fall back to persisted bindings.
    const emptyDurableMap = new Map<string, string>();
    env.setRecoveryBindFn((recoveryTurnId: string, logicalTurnId: string): string | undefined => {
      // Try durable map (empty after restart)
      let resolvedRunId = emptyDurableMap.get(logicalTurnId);
      if (!resolvedRunId) {
        // P1-3 FALLBACK: consult persisted turnBindings in per-run records
        const t = env.getTask(task.id);
        if (t?.runRecords) {
          for (const [, rec] of Object.entries(t.runRecords)) {
            const bound = rec.turnBindings?.[logicalTurnId];
            if (bound) { resolvedRunId = bound; break; }
          }
        }
      }
      if (!resolvedRunId) return undefined;
      env.bindDispatchedTurn(bindings, recoveryTurnId, resolvedRunId);
      env.recordRecoverySource(recoveryTurnId, logicalTurnId);
      return resolvedRunId;
    });

    const recoveryTurnId = `schedule:int_p1_3:${crypto.randomUUID()}`;
    env.bindRecoveryTurn(recoveryTurnId, turnA);

    const settledRecovery = env.settleScheduledTurn(bindings, recoveryTurnId, 'completed');
    // GREEN: recovery should be accepted using the persisted binding
    expect(settledRecovery).toBe(true);   // RED if fallback to persisted bindings fails
  });

  it('cleanupTaskBindings removes all bindings for a task', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_cleanup' });
    const runId = 'run-cleanup';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T18:00:00.000Z',
      nextRunAt: '2026-09-27T18:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    // Bind 3 turnIds for this task
    const t1 = `schedule:int_cleanup:${crypto.randomUUID()}`;
    const t2 = `schedule:int_cleanup:${crypto.randomUUID()}`;
    const t3 = `schedule:int_cleanup:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, t1, runId);
    env.bindDispatchedTurn(bindings, t2, runId);
    env.bindDispatchedTurn(bindings, t3, runId);
    expect(bindings.size).toBe(3);

    // Cleanup
    env.cleanupTaskBindings(bindings, task.id);
    expect(bindings.size).toBe(0);
  });

  it('cleanupTaskBindings does not affect other task bindings', async () => {
    const env = await freshEnv();
    const taskA = env.createTask({ ...TASK_PARAMS, id: 'int_cleanup_a' });
    const taskB = env.createTask({ ...TASK_PARAMS, id: 'int_cleanup_b' });
    const runId = 'run-cleanup-isolate';
    const bindings = new Map<string, string>();

    const tA = `schedule:int_cleanup_a:${crypto.randomUUID()}`;
    const tB = `schedule:int_cleanup_b:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, tA, runId);
    env.bindDispatchedTurn(bindings, tB, runId);
    expect(bindings.size).toBe(2);

    env.cleanupTaskBindings(bindings, taskA.id);
    expect(bindings.size).toBe(1);
    expect(bindings.has(tA)).toBe(false);
    expect(bindings.has(tB)).toBe(true);
  });

  // ── P1-4: Credential sanitizer ─────────────────────────────────────────

  it('P1-4 RED: credential sanitizer handles escaped quotes, spaces, backslashes', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_4' });
    const runId = 'run-p1-4';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T21:00:00.000Z',
      nextRunAt: '2026-09-27T21:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_p1_4:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    // Test: password with quoted value containing spaces and escaped backslash
    // Expected: entire quoted value redacted, no residue
    env.settleScheduledTurn(bindings, turnId, 'failed',
      'Error: password="alpha beta\\\\gamma" in config');
    const t1 = env.getTask(task.id);
    expect(t1.lastTerminalError).toBeDefined();
    expect(t1.lastTerminalError!).not.toMatch(/alpha/);
    expect(t1.lastTerminalError!).not.toMatch(/beta/);
    expect(t1.lastTerminalError!).not.toMatch(/gamma/);
  });

  it('P1-4: credential sanitizer handles quoted token with spaces', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_4b' });
    const runId = 'run-p1-4b';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T22:00:00.000Z',
      nextRunAt: '2026-09-27T22:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_p1_4b:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    // Test: token with quoted value containing escaped quotes
    env.settleScheduledTurn(bindings, turnId, 'failed',
      'Auth token="my\\"secret token" failed');
    const t1 = env.getTask(task.id);
    expect(t1.lastTerminalError!).not.toMatch(/my\\"secret/);
  });

  it('P1-4: credential sanitizer handles Bearer token with spaces', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_4c' });
    const runId = 'run-p1-4c';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-26T23:00:00.000Z',
      nextRunAt: '2026-09-27T23:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_p1_4c:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    // Test: Bearer token with key=value
    env.settleScheduledTurn(bindings, turnId, 'failed',
      'Bearer sk-mysecretkey123');
    const t1 = env.getTask(task.id);
    expect(t1.lastTerminalError!).not.toMatch(/sk-mysecret/);
    expect(t1.lastTerminalError!).toMatch(/redacted/);
  });

  it('P1-4: credential sanitizer handles URL credentials', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_4d' });
    const runId = 'run-p1-4d';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-27T00:00:00.000Z',
      nextRunAt: '2026-09-28T00:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_p1_4d:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    // Test: URL with credentials
    env.settleScheduledTurn(bindings, turnId, 'failed',
      'Fetch https://user:hunter2@example.com/api failed');
    const t1 = env.getTask(task.id);
    expect(t1.lastTerminalError!).not.toMatch(/hunter2/);
    expect(t1.lastTerminalError!).toMatch(/redacted/);
  });

  it('P1-4: credential sanitizer caps at 500 chars', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_4e' });
    const runId = 'run-p1-4e';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-27T01:00:00.000Z',
      nextRunAt: '2026-09-28T01:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_p1_4e:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    // 499 chars should pass through uncapped, 501 gets truncated
    const msg499 = 'X'.repeat(499);
    env.settleScheduledTurn(bindings, turnId, 'failed', msg499);
    expect(env.getTask(task.id)!.lastTerminalError!.length).toBe(499);

    // 501 chars gets "..." suffix — check perTargetErrors directly since
    // lastTerminalError may pick a different source's error (first entry).
    const turnId2 = `schedule:int_p1_4e:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId2, runId);
    env.settleScheduledTurn(bindings, turnId2, 'failed', 'X'.repeat(501));
    const t2 = env.getTask(task.id);
    const err501 = t2!.runRecords?.[runId]?.perTargetErrors?.[turnId2];
    expect(err501).toBeDefined();
    // Truncation: input 501 chars → slice(0, 497) + '...' → 500 chars
    expect(err501!.length).toBeGreaterThanOrEqual(497);
    expect(err501!.length).toBeLessThanOrEqual(500);
    expect(err501!.endsWith('...')).toBe(true);
  });

  it('P1-4: credential sanitizer handles empty and whitespace-only errors', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'int_p1_4f' });
    const runId = 'run-p1-4f';
    const bindings = new Map<string, string>();

    env.claimRun(task.id, {
      lastRunAt: '2026-09-27T02:00:00.000Z',
      nextRunAt: '2026-09-28T02:00:00.000Z',
      lastRunId: runId,
    });
    env.markRun(task.id, true, undefined, undefined, runId);

    const turnId = `schedule:int_p1_4f:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId, runId);

    // Empty/whitespace error string → sanitiseTerminalError returns undefined,
    // which fallback becomes 'unknown error' (per-target error never empty).
    env.settleScheduledTurn(bindings, turnId, 'failed', '');
    const t1 = env.getTask(task.id);
    expect(t1.lastTerminalError).toBe('unknown error');

    const turnId2 = `schedule:int_p1_4f:${crypto.randomUUID()}`;
    env.bindDispatchedTurn(bindings, turnId2, runId);
    env.settleScheduledTurn(bindings, turnId2, 'failed', '   ');
    const t2 = env.getTask(task.id);
    expect(t2.lastTerminalError).toBe('unknown error');
  });

  // These are the reviewer reproducers.  They intentionally exercise the
  // shipped recovery adapter rather than reimplementing terminal settlement
  // in the test.
  it('review RED: an early recovery terminal never creates a settled source', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_early_recovery' });
    const runId = 'run-review-early';
    const bindings = new Map<string, string>();
    const sourceTurnId = `schedule:review_early_recovery:${crypto.randomUUID()}`;
    const recoveryTurnId = `schedule:review_early_recovery:${crypto.randomUUID()}`;

    env.claimRun(task.id, { lastRunAt: '2026-09-27T03:00:00.000Z', nextRunAt: '2026-09-28T03:00:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    env.bindDispatchedTurn(bindings, sourceTurnId, runId);
    env.setRecoveryBindFn((turnId, logicalTurnId) => {
      env.bindDispatchedTurn(bindings, turnId, runId);
      env.recordRecoverySource(turnId, logicalTurnId);
      return runId;
    });

    env.bindRecoveryTurn(recoveryTurnId, sourceTurnId);
    expect(env.settleScheduledTurn(bindings, recoveryTurnId, 'completed')).toBe(false);
    expect(env.getTask(task.id)!.runRecords?.[runId]?.settledTurnIds).toEqual([]);
  });

  it('review RED: recovery for Run A mutates Run A only after Run B is claimed', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_cross_run' });
    const bindings = new Map<string, string>();
    const runA = 'run-review-a';
    const runB = 'run-review-b';
    const sourceTurnId = `schedule:review_cross_run:${crypto.randomUUID()}`;
    const recoveryTurnId = `schedule:review_cross_run:${crypto.randomUUID()}`;

    env.claimRun(task.id, { lastRunAt: '2026-09-27T04:00:00.000Z', nextRunAt: '2026-09-28T04:00:00.000Z', lastRunId: runA });
    env.setRunTargetCount(task.id, 1, runA);
    env.bindDispatchedTurn(bindings, sourceTurnId, runA);
    expect(env.settleScheduledTurn(bindings, sourceTurnId, 'failed', 'A_FAILED')).toBe(true);
    env.markRun(task.id, true, undefined, undefined, runA);
    env.claimRun(task.id, { lastRunAt: '2026-09-27T05:00:00.000Z', nextRunAt: '2026-09-28T05:00:00.000Z', lastRunId: runB });
    env.setRunTargetCount(task.id, 1, runB);
    env.setRecoveryBindFn((turnId, logicalTurnId) => {
      env.bindDispatchedTurn(bindings, turnId, runA);
      env.recordRecoverySource(turnId, logicalTurnId);
      return runA;
    });

    env.bindRecoveryTurn(recoveryTurnId, sourceTurnId);
    expect(env.settleScheduledTurn(bindings, recoveryTurnId, 'completed')).toBe(true);
    const reloaded = env.getTask(task.id)!;
    expect(reloaded.runRecords?.[runA]?.perTargetErrors?.[sourceTurnId]).toBeUndefined();
    expect(reloaded.runRecords?.[runB]?.settledTurnIds).toEqual([]);
    expect(reloaded.lastRunId).toBe(runB);
  });

  it('review RED: persisted Run A source remains recoverable after claim B and module restore', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_restart' });
    const runA = 'run-review-restart-a';
    const sourceTurnId = `schedule:review_restart:${crypto.randomUUID()}`;

    env.claimRun(task.id, { lastRunAt: '2026-09-27T06:00:00.000Z', nextRunAt: '2026-09-28T06:00:00.000Z', lastRunId: runA });
    env.setRunTargetCount(task.id, 1, runA);
    env.bindDispatchedTurn(new Map<string, string>(), sourceTurnId, runA);
    env.claimRun(task.id, { lastRunAt: '2026-09-27T07:00:00.000Z', nextRunAt: '2026-09-28T07:00:00.000Z', lastRunId: 'run-review-restart-b' });

    const restored = await freshEnv();
    const persisted = restored.getTask(task.id)!;
    expect(persisted.runRecords?.[runA]?.turnBindings?.[sourceTurnId]).toBe(runA);
  });

  it('review RED: escaped opening and closing quotes consume the entire credential', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_escaped_quote' });
    const runId = 'run-review-escaped';
    const bindings = new Map<string, string>();
    const turnId = `schedule:review_escaped_quote:${crypto.randomUUID()}`;

    env.claimRun(task.id, { lastRunAt: '2026-09-27T08:00:00.000Z', nextRunAt: '2026-09-28T08:00:00.000Z', lastRunId: runId });
    env.bindDispatchedTurn(bindings, turnId, runId);
    env.settleScheduledTurn(bindings, turnId, 'failed', 'token=\\"leaked value\\" rejected');
    const error = env.getTask(task.id)!.lastTerminalError!;
    expect(error).not.toContain('leaked');
    expect(error).not.toContain('value');
  });

  it('releases a recovery binding when the real recovery lifecycle gets enqueue=false', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_enqueue_false' });
    const runId = 'run-enqueue-false';
    const sourceTurnId = `schedule:review_enqueue_false:${crypto.randomUUID()}`;
    const recoveryTurnId = `schedule:review_enqueue_false:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T08:30:00.000Z', nextRunAt: '2026-09-28T08:30:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    env.owner.bindDispatch(sourceTurnId, runId);
    expect(env.owner.settle(sourceTurnId, 'failed', 'retry')).toBe(true);
    const timers: Array<() => void> = [];
    const session = { sessionId: `recovery-${crypto.randomUUID()}` };
    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => false),
      warn: vi.fn(),
      mintContinuationTurnId: () => recoveryTurnId,
      bindRecoveryTurn: env.bindRecoveryTurn,
      releaseRecoveryTurn: env.releaseRecoveryTurn,
    });
    beginOrdinaryTurnRecovery(session, sourceTurnId);
    handleOrdinaryTurnRecoveryTerminal(session, {
      turnId: sourceTurnId,
      status: 'failed', retryable: true,
    });
    timers.shift()!();
    expect(env.owner.hasTransient(recoveryTurnId)).toBe(false);
    expect(env.owner.hasDurable(recoveryTurnId)).toBe(false);
    expect(env.getTask(task.id)!.runRecords?.[runId]?.turnBindings?.[sourceTurnId]).toBe(runId);
    disposeOrdinaryTurnRecovery(session);
  });

  it('terminal success releases the durable source while a failed source remains recoverable', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_terminal_cleanup' });
    const bindings = new Map<string, string>();
    const runId = 'run-review-cleanup';
    const completed = `schedule:review_terminal_cleanup:${crypto.randomUUID()}`;
    const failed = `schedule:review_terminal_cleanup:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T09:00:00.000Z', nextRunAt: '2026-09-28T09:00:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 2, runId);
    env.bindDispatchedTurn(bindings, completed, runId);
    env.bindDispatchedTurn(bindings, failed, runId);
    expect(env.settleScheduledTurn(bindings, completed, 'completed')).toBe(true);
    expect(env.getTask(task.id)!.runRecords?.[runId]?.turnBindings?.[completed]).toBeUndefined();
    expect(env.settleScheduledTurn(bindings, failed, 'failed', 'retry me')).toBe(true);
    expect(env.getTask(task.id)!.runRecords?.[runId]?.turnBindings?.[failed]).toBe(runId);
  });

  it('attack round 1: a recovered source cannot be rebound for a second terminal', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'attack_recovery_once' });
    const runId = 'run-attack-once';
    const bindings = new Map<string, string>();
    const source = `schedule:attack_recovery_once:${crypto.randomUUID()}`;
    const recovery = `schedule:attack_recovery_once:${crypto.randomUUID()}`;
    const replay = `schedule:attack_recovery_once:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T10:00:00.000Z', nextRunAt: '2026-09-28T10:00:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    env.bindDispatchedTurn(bindings, source, runId);
    expect(env.settleScheduledTurn(bindings, source, 'failed', 'retry')).toBe(true);
    env.setRecoveryBindFn((turnId, logicalTurnId) => {
      if (env.getTask(task.id)!.runRecords?.[runId]?.turnBindings?.[logicalTurnId] !== runId) return undefined;
      env.bindDispatchedTurn(bindings, turnId, runId);
      env.recordRecoverySource(turnId, logicalTurnId);
      return runId;
    });
    env.bindRecoveryTurn(recovery, source);
    expect(env.settleScheduledTurn(bindings, recovery, 'completed')).toBe(true);
    env.bindRecoveryTurn(replay, source);
    expect(env.settleScheduledTurn(bindings, replay, 'completed')).toBe(false);
  });

  it('attack round 2: restored old-run recovery stays isolated and redacts escaped single quotes', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'attack_restore_isolation' });
    const runA = 'run-attack-a';
    const source = `schedule:attack_restore_isolation:${crypto.randomUUID()}`;
    const bindings = new Map<string, string>();
    env.claimRun(task.id, { lastRunAt: '2026-09-27T11:00:00.000Z', nextRunAt: '2026-09-28T11:00:00.000Z', lastRunId: runA });
    env.setRunTargetCount(task.id, 1, runA);
    env.bindDispatchedTurn(bindings, source, runA);
    expect(env.settleScheduledTurn(bindings, source, 'failed', "secret=\\'hidden value\\'" )).toBe(true);
    env.markRun(task.id, true, undefined, undefined, runA);
    env.claimRun(task.id, { lastRunAt: '2026-09-27T12:00:00.000Z', nextRunAt: '2026-09-28T12:00:00.000Z', lastRunId: 'run-attack-b' });
    const restored = await freshEnv();
    const recovery = `schedule:attack_restore_isolation:${crypto.randomUUID()}`;
    restored.setRecoveryBindFn((turnId, logicalTurnId) => {
      if (restored.getTask(task.id)!.runRecords?.[runA]?.turnBindings?.[logicalTurnId] !== runA) return undefined;
      restored.bindDispatchedTurn(bindings, turnId, runA);
      restored.recordRecoverySource(turnId, logicalTurnId);
      return runA;
    });
    restored.bindRecoveryTurn(recovery, source);
    expect(restored.settleScheduledTurn(bindings, recovery, 'completed')).toBe(true);
    const reloaded = restored.getTask(task.id)!;
    expect(reloaded.lastRunId).toBe('run-attack-b');
    expect(reloaded.runRecords?.[runA]?.perTargetErrors?.[source]).toBeUndefined();
    expect(reloaded.lastTerminalError ?? '').not.toContain('hidden');
    expect(reloaded.lastTerminalError ?? '').not.toContain('value');
  });

  it('review RED P1: Run B cleanup cannot consume Run A active recovery binding', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_keep_a_recovery' });
    const runA = 'run-review-keep-a';
    const runB = 'run-review-keep-b';
    const source = `schedule:review_keep_a_recovery:${crypto.randomUUID()}`;
    const recovery = `schedule:review_keep_a_recovery:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T13:00:00.000Z', nextRunAt: '2026-09-28T13:00:00.000Z', lastRunId: runA });
    env.setRunTargetCount(task.id, 1, runA);
    expect(env.owner.bindDispatch(source, runA)).toBe(true);
    expect(env.owner.settle(source, 'failed', 'A failed')).toBe(true);
    env.markRun(task.id, false, 'A failed', undefined, runA);
    expect(env.owner.bindRecovery(recovery, source)).toBe(true);
    env.claimRun(task.id, { lastRunAt: '2026-09-27T14:00:00.000Z', nextRunAt: '2026-09-28T14:00:00.000Z', lastRunId: runB });
    env.owner.beginRun(task.id, runB);
    expect(env.owner.hasTransient(recovery)).toBe(true);
    expect(env.owner.hasDurable(recovery)).toBe(true);
  });

  it('review RED P1: a successful recovery source cannot be bound and replayed again', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_replay_closed' });
    const runId = 'run-review-replay';
    const source = `schedule:review_replay_closed:${crypto.randomUUID()}`;
    const recovery = `schedule:review_replay_closed:${crypto.randomUUID()}`;
    const replay = `schedule:review_replay_closed:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T15:00:00.000Z', nextRunAt: '2026-09-28T15:00:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    expect(env.owner.bindDispatch(source, runId)).toBe(true);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    expect(env.owner.bindRecovery(recovery, source)).toBe(true);
    expect(env.owner.settle(recovery, 'completed')).toBe(true);
    expect(env.owner.bindRecovery(replay, source)).toBe(false);
    expect(env.owner.settle(replay, 'completed')).toBe(false);
  });

  it('review RED P1: JSON-escaped quote parity never persists credential fragments', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_quote_parity' });
    const bindings = new Map<string, string>();
    const runId = 'run-review-quote-parity';
    const turnId = `schedule:review_quote_parity:${crypto.randomUUID()}`;
    const secret = 'part-one part-two\\\\part-three';
    env.claimRun(task.id, { lastRunAt: '2026-09-27T16:00:00.000Z', nextRunAt: '2026-09-28T16:00:00.000Z', lastRunId: runId });
    env.bindDispatchedTurn(bindings, turnId, runId);
    env.settleScheduledTurn(bindings, turnId, 'failed', `{"error":"Bearer \\\"${secret}\\\\\\\" tail"}`);
    const persisted = env.getTask(task.id)!.lastTerminalError!;
    for (const fragment of ['part-one', 'part-two', 'part-three']) expect(persisted).not.toContain(fragment);
  });

  it('review P2: enqueue=false rolls back only the recovery attempt and rejects its fake terminal', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_enqueue_owner' });
    const runId = 'run-review-enqueue-owner';
    const source = `schedule:review_enqueue_owner:${crypto.randomUUID()}`;
    const attempt = `schedule:review_enqueue_owner:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T17:00:00.000Z', nextRunAt: '2026-09-28T17:00:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    expect(env.owner.bindDispatch(source, runId)).toBe(true);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    expect(env.owner.bindRecovery(attempt, source)).toBe(true);
    env.owner.releaseRecovery(attempt);
    expect(env.owner.hasTransient(attempt)).toBe(false);
    expect(env.owner.hasDurable(attempt)).toBe(false);
    expect(env.getTask(task.id)!.runRecords?.[runId]?.turnBindings?.[source]).toBe(runId);
    expect(env.owner.settle(attempt, 'completed')).toBe(false);
    const retry = `schedule:review_enqueue_owner:${crypto.randomUUID()}`;
    expect(env.owner.bindRecovery(retry, source)).toBe(true);
  });

  it('owner restore and delete use persisted source identity and release every runtime class', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_owner_restore_delete' });
    const runId = 'run-review-owner-restore';
    const source = `schedule:review_owner_restore_delete:${crypto.randomUUID()}`;
    const recovery = `schedule:review_owner_restore_delete:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T17:30:00.000Z', nextRunAt: '2026-09-28T17:30:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    expect(env.owner.bindDispatch(source, runId)).toBe(true);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    env.owner.restore();
    expect(env.owner.bindRecovery(recovery, source)).toBe(true);
    expect(env.owner.hasTransient(recovery)).toBe(true);
    expect(env.owner.hasDurable(recovery)).toBe(true);
    env.owner.deleteTask(task.id);
    expect(env.owner.hasTransient(recovery)).toBe(false);
    expect(env.owner.hasDurable(recovery)).toBe(false);
  });

  it('review RED P1: escaped quote parity redacts past an even-slash non-closure', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_quote_even_parity' });
    const runId = 'run-review-quote-even';
    const turnId = `schedule:review_quote_even_parity:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T19:00:00.000Z', nextRunAt: '2026-09-28T19:00:00.000Z', lastRunId: runId });
    expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
    // The double slash before the first quote means it is data, while the
    // later odd slash quote closes the escaped wrapper.
    expect(env.owner.settle(turnId, 'failed', 'api_key=\\"alpha\\\\" beta gamma\\" end')).toBe(true);
    const persisted = env.getTask(task.id)!.lastTerminalError!;
    for (const fragment of ['alpha', 'beta', 'gamma']) expect(persisted).not.toContain(fragment);
  });

  it('attack: JSON-wrapped credential families never persist value fragments', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'attack_all_credential_families' });
    const values = [
      ['token', 'violet apple one'],
      ['Bearer', 'orange comet two'],
      ['api_key', 'indigo river three'],
      ['secret', 'yellow meadow four'],
      ['url', 'purple canyon five'],
    ] as const;
    for (let index = 0; index < values.length; index++) {
      const [kind, value] = values[index];
      const runId = `run-attack-creds-${index}`;
      const turnId = `schedule:attack_all_credential_families:${crypto.randomUUID()}`;
      env.claimRun(task.id, { lastRunAt: `2026-09-27T20:0${index}:00.000Z`, nextRunAt: '2026-09-28T20:00:00.000Z', lastRunId: runId });
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      const payload = kind === 'url'
        ? `{"error":"Fetch https://user:${value.replaceAll(' ', '-') }@example.test/x"}`
        : `{"error":"${kind}=\\"${value}\\""}`;
      expect(env.owner.settle(turnId, 'failed', payload)).toBe(true);
      const persisted = env.getTask(task.id)!.lastTerminalError!;
      for (const fragment of value.split(/[ -]/).filter(part => part.length > 2)) expect(persisted).not.toContain(fragment);
      env.markRun(task.id, false, 'terminal failed', undefined, runId);
    }
  });

  it('fresh attack round 1: failed Run A source survives B and supports exactly one retry', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'attack_a_retry_under_b' });
    const source = `schedule:attack_a_retry_under_b:${crypto.randomUUID()}`;
    const recovery = `schedule:attack_a_retry_under_b:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T21:00:00.000Z', nextRunAt: '2026-09-28T21:00:00.000Z', lastRunId: 'run-a' });
    env.setRunTargetCount(task.id, 1, 'run-a');
    env.owner.bindDispatch(source, 'run-a');
    expect(env.owner.settle(source, 'failed', 'A failed')).toBe(true);
    env.markRun(task.id, false, 'A failed', undefined, 'run-a');
    env.claimRun(task.id, { lastRunAt: '2026-09-27T21:01:00.000Z', nextRunAt: '2026-09-28T21:01:00.000Z', lastRunId: 'run-b' });
    env.owner.beginRun(task.id, 'run-b');
    expect(env.owner.bindRecovery(recovery, source)).toBe(true);
    expect(env.owner.settle(recovery, 'completed')).toBe(true);
    expect(env.getTask(task.id)!.lastRunId).toBe('run-b');
    expect(env.owner.bindRecovery(`schedule:attack_a_retry_under_b:${crypto.randomUUID()}`, source)).toBe(false);
  });

  it('fresh attack round 2: pruning retains only old runs with live recovery authority', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'attack_prune_live_authority' });
    const source = `schedule:attack_prune_live_authority:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-27T22:00:00.000Z', nextRunAt: '2026-09-28T22:00:00.000Z', lastRunId: 'run-a' });
    env.setRunTargetCount(task.id, 1, 'run-a');
    env.owner.bindDispatch(source, 'run-a');
    expect(env.owner.settle(source, 'failed', 'recoverable')).toBe(true);
    env.markRun(task.id, false, 'recoverable', undefined, 'run-a');
    for (let index = 0; index < 4; index++) {
      const runId = `run-b${index}`;
      env.claimRun(task.id, { lastRunAt: `2026-09-27T22:0${index + 1}:00.000Z`, nextRunAt: '2026-09-28T22:00:00.000Z', lastRunId: runId });
      env.setRunTargetCount(task.id, 1, runId);
      const turnId = `schedule:attack_prune_live_authority:${crypto.randomUUID()}`;
      env.owner.bindDispatch(turnId, runId);
      expect(env.owner.settle(turnId, 'completed')).toBe(true);
      env.markRun(task.id, true, undefined, undefined, runId);
    }
    expect(env.getTask(task.id)!.runRecords?.['run-a']?.turnBindings?.[source]).toBe('run-a');
    expect(Object.keys(env.getTask(task.id)!.runRecords ?? {})).toEqual(['run-a', 'run-b3']);
  });

  it('review RED P2: recurring successful runs retain a bounded runRecords set', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_prune_records' });
    for (let index = 0; index < 12; index++) {
      const runId = `run-review-prune-${index}`;
      env.claimRun(task.id, { lastRunAt: `2026-09-27T18:${String(index).padStart(2, '0')}:00.000Z`, nextRunAt: '2026-09-28T18:00:00.000Z', lastRunId: runId });
      env.setRunTargetCount(task.id, 1, runId);
      const turnId = `schedule:review_prune_records:${crypto.randomUUID()}`;
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'completed')).toBe(true);
      env.markRun(task.id, true, undefined, undefined, runId);
    }
    const records = env.getTask(task.id)!.runRecords ?? {};
    expect(Object.keys(records)).toEqual(['run-review-prune-11']);
  });

  it('review RED P1: persistent source ownership allows only one active recovery attempt', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_recovery_cas' });
    const runId = 'run-review-cas';
    const source = `schedule:review_recovery_cas:${crypto.randomUUID()}`;
    const attemptA = `schedule:review_recovery_cas:${crypto.randomUUID()}`;
    const attemptB = `schedule:review_recovery_cas:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-28T01:00:00.000Z', nextRunAt: '2026-09-29T01:00:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    expect(env.owner.bindDispatch(source, runId)).toBe(true);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    expect(env.owner.bindRecovery(attemptA, source)).toBe(true);
    expect(env.owner.bindRecovery(attemptB, source)).toBe(false);
  });

  it('review RED P1: bind=false blocks ordinary recovery before enqueue and running', () => {
    const timers: Array<() => void> = [];
    const enqueue = vi.fn(() => true);
    const session = { sessionId: `bind-false-${crypto.randomUUID()}` };
    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => { timers.push(run); return run; },
      cancel: vi.fn(), persist: vi.fn(), enqueue, warn: vi.fn(),
      mintContinuationTurnId: logicalTurnId => `${logicalTurnId}:recovery`,
      bindRecoveryTurn: () => false,
    });
    beginOrdinaryTurnRecovery(session, 'schedule:review_bind_false:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    handleOrdinaryTurnRecoveryTerminal(session, {
      turnId: 'schedule:review_bind_false:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      status: 'failed', retryable: true,
    });
    timers.shift()!();
    expect(enqueue).not.toHaveBeenCalled();
    expect(session.ordinaryTurnRecovery?.status).not.toBe('running');
    disposeOrdinaryTurnRecovery(session);
  });

  it('review RED P1: finite repeat removal invokes binding cleanup and rejects late terminal', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_repeat_cleanup', repeat: { times: 1, completed: 0 } });
    const runId = 'run-review-repeat';
    const turnId = `schedule:review_repeat_cleanup:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-28T02:00:00.000Z', nextRunAt: '2026-09-29T02:00:00.000Z', lastRunId: runId });
    expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
    env.markRun(task.id, true, undefined, undefined, runId);
    expect(env.getTask(task.id)).toBeUndefined();
    expect(env.owner.hasTransient(turnId)).toBe(false);
    expect(env.owner.hasDurable(turnId)).toBe(false);
    expect(env.owner.settle(turnId, 'completed')).toBe(false);
  });

  it('review RED P1: a failed atomic recovery commit preserves both error and source authority', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_atomic_failure' });
    const runId = 'run-review-atomic';
    const source = `schedule:review_atomic_failure:${crypto.randomUUID()}`;
    const attempt = `schedule:review_atomic_failure:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-28T03:00:00.000Z', nextRunAt: '2026-09-29T03:00:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    env.owner.bindDispatch(source, runId);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    expect(env.owner.bindRecovery(attempt, source)).toBe(true);
    const store = await import('../src/services/schedule-store.js');
    store.__setScheduleStoreBeforeRenameTestHook(() => { throw new Error('inject persistence failure'); });
    expect(() => env.owner.settle(attempt, 'completed')).toThrow('inject persistence failure');
    store.__setScheduleStoreBeforeRenameTestHook();
    const restored = await freshEnv();
    expect(restored.getTask(task.id)!.runRecords?.[runId]?.perTargetErrors?.[source]).toBe('retry');
    expect(restored.owner.bindRecovery(`schedule:review_atomic_failure:${crypto.randomUUID()}`, source)).toBe(false);
  });

  it('review RED P1: escaped JSON key/value boundaries redact every credential fragment', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_structured_credentials' });
    const cases = [
      ['token', '{\\"token\\":\\"violet one\\\\\\" azure two\\"}'],
      ['Bearer', '{\\"error\\":\\"Bearer \\"orange three\\\\\\" comet four\\"}'],
      ['api_key', '{\\"api_key\\":\\"indigo five\\\\\\" river six\\"}'],
      ['secret', '{\\"secret\\":\\"yellow seven\\\\\\" meadow eight\\"}'],
      ['url', '{\\"url\\":\\"https://user:purple-nine-canyon@example.test/x\\"}'],
    ] as const;
    for (let index = 0; index < cases.length; index++) {
      const [, raw] = cases[index];
      const runId = `run-structured-${index}`;
      const turnId = `schedule:review_structured_credentials:${crypto.randomUUID()}`;
      env.claimRun(task.id, { lastRunAt: `2026-09-28T04:0${index}:00.000Z`, nextRunAt: '2026-09-29T04:00:00.000Z', lastRunId: runId });
      env.owner.bindDispatch(turnId, runId);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const persisted = env.getTask(task.id)!.lastTerminalError!;
      for (const fragment of ['violet', 'azure', 'orange', 'comet', 'indigo', 'river', 'yellow', 'meadow', 'purple', 'canyon']) {
        expect(persisted).not.toContain(fragment);
      }
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('review RED P2: repeated dispatch-failed records are not recovery owners and stay bounded', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_dispatch_failure_prune' });
    for (let index = 0; index < 12; index++) {
      const runId = `run-dispatch-failed-${index}`;
      const source = 'dispatch-failed:oc_target';
      env.claimRun(task.id, { lastRunAt: `2026-09-28T05:${String(index).padStart(2, '0')}:00.000Z`, nextRunAt: '2026-09-29T05:00:00.000Z', lastRunId: runId });
      env.setRunTargetCount(task.id, 1, runId);
      env.bindRunTurnId(task.id, source, runId);
      expect(env.settleTerminalRun(task.id, runId, false, 'dispatch failed', undefined, source)).toBe(true);
      expect(env.owner.bindRecovery(`schedule:review_dispatch_failure_prune:${crypto.randomUUID()}`, source)).toBe(false);
      env.markRun(task.id, false, 'dispatch failed', undefined, runId);
    }
    expect(Object.keys(env.getTask(task.id)!.runRecords ?? {})).toEqual(['run-dispatch-failed-11']);
  });

  it('fresh attack round 1: failed recovery commit survives restart without a stale-terminal replay', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'attack_atomic_restart' });
    const runId = 'run-attack-atomic-restart';
    const source = `schedule:attack_atomic_restart:${crypto.randomUUID()}`;
    const attempt = `schedule:attack_atomic_restart:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-28T06:00:00.000Z', nextRunAt: '2026-09-29T06:00:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    env.owner.bindDispatch(source, runId);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    expect(env.owner.bindRecovery(attempt, source)).toBe(true);
    const store = await import('../src/services/schedule-store.js');
    store.__setScheduleStoreBeforeRenameTestHook(() => { throw new Error('simulated write fault'); });
    expect(() => env.owner.settle(attempt, 'completed')).toThrow('simulated write fault');
    store.__setScheduleStoreBeforeRenameTestHook();
    const restored = await freshEnv();
    expect(restored.owner.settle(attempt, 'completed')).toBe(true);
    expect(restored.owner.settle(attempt, 'completed')).toBe(false);
    expect(restored.getTask(task.id)!.runRecords?.[runId]?.perTargetErrors?.[source]).toBeUndefined();
  });

  it('fresh attack round 2: nested escaped password and URL userinfo keep no credential fragments', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'attack_nested_credentials' });
    const runId = 'run-attack-nested-credentials';
    const turnId = `schedule:attack_nested_credentials:${crypto.randomUUID()}`;
    const raw = '{\\"outer\\":{\\"password\\":\\"scarlet one\\\\\\" orchid two\\"},\\"url\\":\\"https://name:teal-three-forest@example.test/x\\"}';
    env.claimRun(task.id, { lastRunAt: '2026-09-28T07:00:00.000Z', nextRunAt: '2026-09-29T07:00:00.000Z', lastRunId: runId });
    env.owner.bindDispatch(turnId, runId);
    expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
    const persisted = env.getTask(task.id)!.lastTerminalError!;
    for (const fragment of ['scarlet', 'orchid', 'teal', 'forest']) expect(persisted).not.toContain(fragment);
  });

  it('review RED P1: old-run recovery consumes its attempt before skipping current projection', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_old_run_consume' });
    const source = `schedule:review_old_run_consume:${crypto.randomUUID()}`;
    const attempt = `schedule:review_old_run_consume:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-28T08:00:00.000Z', nextRunAt: '2026-09-29T08:00:00.000Z', lastRunId: 'run-a' });
    env.setRunTargetCount(task.id, 1, 'run-a');
    env.owner.bindDispatch(source, 'run-a');
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    expect(env.owner.bindRecovery(attempt, source)).toBe(true);
    env.claimRun(task.id, { lastRunAt: '2026-09-28T08:01:00.000Z', nextRunAt: '2026-09-29T08:01:00.000Z', lastRunId: 'run-b' });
    expect(env.owner.settle(attempt, 'completed')).toBe(true);
    const record = env.getTask(task.id)!.runRecords?.['run-a'];
    expect(record?.turnBindings?.[attempt]).toBeUndefined();
    expect(record?.turnBindings?.[source]).toBeUndefined();
    expect(record?.recoveryAttempts?.[source]).toBeUndefined();
    expect(env.owner.bindRecovery(`schedule:review_old_run_consume:${crypto.randomUUID()}`, source)).toBe(false);
  });

  it('review RED P1: restart settles the exact persisted in-flight attempt once', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_restart_attempt' });
    const runId = 'run-restart-attempt';
    const source = `schedule:review_restart_attempt:${crypto.randomUUID()}`;
    const attempt = `schedule:review_restart_attempt:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-28T09:00:00.000Z', nextRunAt: '2026-09-29T09:00:00.000Z', lastRunId: runId });
    env.setRunTargetCount(task.id, 1, runId);
    env.owner.bindDispatch(source, runId);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    expect(env.owner.bindRecovery(attempt, source)).toBe(true);
    const restored = await freshEnv();
    expect(restored.owner.settle(attempt, 'completed')).toBe(true);
    expect(restored.owner.settle(attempt, 'completed')).toBe(false);
  });

  it('review RED P1: context persist and enqueue throws release attempt and preserve source', () => {
    for (const phase of ['persist', 'enqueue'] as const) {
      const release = vi.fn();
      const timers: Array<() => void> = [];
      const session: any = { sessionId: `throw-${phase}-${crypto.randomUUID()}`, turnReplyContexts: { 'schedule:throw:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa': { target: 'x' } } };
      let persists = 0;
      attachOrdinaryTurnRecovery(session, {
        schedule: (_delay, run) => { timers.push(run); return run; },
        cancel: vi.fn(),
        persist: () => { persists++; if (phase === 'persist' && persists === 4) throw new Error('persist failure'); },
        enqueue: () => { if (phase === 'enqueue') throw new Error('enqueue failure'); return true; },
        warn: vi.fn(), mintContinuationTurnId: logical => `${logical}:recovery`,
        bindRecoveryTurn: () => true, releaseRecoveryTurn: release,
      });
      beginOrdinaryTurnRecovery(session, 'schedule:throw:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
      handleOrdinaryTurnRecoveryTerminal(session, { turnId: 'schedule:throw:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', status: 'failed', retryable: true });
      timers.shift()!();
      expect(release).toHaveBeenCalled();
      expect(session.ordinaryTurnRecovery?.status).toBe('attention_required');
      expect(session.turnReplyContexts?.['schedule:throw:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa:recovery']).toBeUndefined();
      expect(session.replyTargets?.['schedule:throw:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa:recovery']).toBeUndefined();
      disposeOrdinaryTurnRecovery(session);
    }
  });

  it('review RED P1: access refresh and client secret JSON values leave no fragments', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_oauth_credential_families' });
    const cases = [
      '{\\"access_token\\":\\"magenta one\\\\\\" willow two\\"}',
      '{\\"refresh_token\\":\\"cyan three\\\\\\" harbor four\\"}',
      '{\\"client_secret\\":\\"amber five\\\\\\" valley six\\"}',
    ];
    for (let index = 0; index < cases.length; index++) {
      const runId = `run-oauth-family-${index}`;
      const turnId = `schedule:review_oauth_credential_families:${crypto.randomUUID()}`;
      env.claimRun(task.id, { lastRunAt: `2026-09-28T10:0${index}:00.000Z`, nextRunAt: '2026-09-29T10:00:00.000Z', lastRunId: runId });
      env.owner.bindDispatch(turnId, runId);
      expect(env.owner.settle(turnId, 'failed', cases[index])).toBe(true);
      const persisted = env.getTask(task.id)!.lastTerminalError!;
      for (const fragment of ['magenta', 'willow', 'cyan', 'harbor', 'amber', 'valley']) expect(persisted).not.toContain(fragment);
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('fresh attack round 1: restart-recovered old-run attempt cannot alter current Run B projection', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'attack_restart_old_run' });
    const source = `schedule:attack_restart_old_run:${crypto.randomUUID()}`;
    const attempt = `schedule:attack_restart_old_run:${crypto.randomUUID()}`;
    env.claimRun(task.id, { lastRunAt: '2026-09-28T11:00:00.000Z', nextRunAt: '2026-09-29T11:00:00.000Z', lastRunId: 'run-a' });
    env.setRunTargetCount(task.id, 1, 'run-a');
    env.owner.bindDispatch(source, 'run-a');
    expect(env.owner.settle(source, 'failed', 'A retry')).toBe(true);
    env.markRun(task.id, false, 'A retry', undefined, 'run-a');
    expect(env.owner.bindRecovery(attempt, source)).toBe(true);
    env.claimRun(task.id, { lastRunAt: '2026-09-28T11:01:00.000Z', nextRunAt: '2026-09-29T11:01:00.000Z', lastRunId: 'run-b' });
    env.setRunTargetCount(task.id, 1, 'run-b');
    const currentBefore = env.getTask(task.id)!.lastTerminalRunId;
    const restored = await freshEnv();
    expect(restored.owner.settle(attempt, 'completed')).toBe(true);
    expect(restored.getTask(task.id)!.lastRunId).toBe('run-b');
    expect(restored.getTask(task.id)!.lastTerminalRunId).toBe(currentBefore);
  });

  it('fresh attack round 2: nested OAuth, Bearer and URL values leak no fragments', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'attack_oauth_nested' });
    const runId = 'run-attack-oauth-nested';
    const turnId = `schedule:attack_oauth_nested:${crypto.randomUUID()}`;
    const raw = '{\\"tokens\\":{\\"access_token\\":\\"rose one\\\\\\" pine two\\",\\"refresh_token\\":\\"blue three\\\\\\" lake four\\",\\"client_secret\\":\\"gold five\\\\\\" ridge six\\"},\\"error\\":\\"Bearer \\"silver seven\\\\\\" cloud eight\\" https://u:violet-nine-field@example.test/x\\"}';
    env.claimRun(task.id, { lastRunAt: '2026-09-28T12:00:00.000Z', nextRunAt: '2026-09-29T12:00:00.000Z', lastRunId: runId });
    env.owner.bindDispatch(turnId, runId);
    expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
    const persisted = env.getTask(task.id)!.lastTerminalError!;
    for (const fragment of ['rose', 'pine', 'blue', 'lake', 'gold', 'ridge', 'silver', 'cloud', 'violet', 'field']) expect(persisted).not.toContain(fragment);
  });

  it('review P1: real old-run success and failure consume authority after an asserted B claim', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_strict_old_run' });
    for (const terminal of ['completed', 'failed'] as const) {
      const source = `schedule:review_strict_old_run:${crypto.randomUUID()}`;
      const attempt = `schedule:review_strict_old_run:${crypto.randomUUID()}`;
      const runA = `run-a-${terminal}`;
      const runB = `run-b-${terminal}`;
      expect(env.claimRun(task.id, { lastRunAt: '2026-09-28T13:00:00.000Z', nextRunAt: '2026-09-29T13:00:00.000Z', lastRunId: runA }).ok).toBe(true);
      env.setRunTargetCount(task.id, 1, runA);
      env.owner.bindDispatch(source, runA);
      expect(env.owner.settle(source, 'failed', 'A retry')).toBe(true);
      env.markRun(task.id, false, 'A retry', undefined, runA);
      expect(env.owner.bindRecovery(attempt, source)).toBe(true);
      expect(env.claimRun(task.id, { lastRunAt: '2026-09-28T13:01:00.000Z', nextRunAt: '2026-09-29T13:01:00.000Z', lastRunId: runB }).ok).toBe(true);
      expect(env.owner.settle(attempt, terminal, 'terminal')).toBe(true);
      const rec = env.getTask(task.id)!.runRecords?.[runA];
      expect(rec?.turnBindings?.[attempt]).toBeUndefined();
      expect(rec?.recoveryAttempts?.[source]).toBeUndefined();
      env.markRun(task.id, true, undefined, undefined, runB);
    }
  });

  it('review P1: non-retryable attached recovery abandons exact source authority', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_abandon_terminal' });
    const runId = 'run-abandon';
    const source = `schedule:review_abandon_terminal:${crypto.randomUUID()}`;
    const attempt = `schedule:review_abandon_terminal:${crypto.randomUUID()}`;
    expect(env.claimRun(task.id, { lastRunAt: '2026-09-28T14:00:00.000Z', nextRunAt: '2026-09-29T14:00:00.000Z', lastRunId: runId }).ok).toBe(true);
    env.setRunTargetCount(task.id, 1, runId);
    env.owner.bindDispatch(source, runId);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    expect(env.owner.bindRecovery(attempt, source)).toBe(true);
    const session: any = { sessionId: `abandon-${crypto.randomUUID()}`, ordinaryTurnRecovery: { logicalTurnId: source, currentTurnId: attempt, continuationsStarted: 1, status: 'running' } };
    attachOrdinaryTurnRecovery(session, {
      schedule: vi.fn(), cancel: vi.fn(), persist: vi.fn(), enqueue: vi.fn(), warn: vi.fn(),
      abandonRecoveryTurn: env.abandonRecoveryTurn,
    });
    handleOrdinaryTurnRecoveryTerminal(session, { turnId: attempt, status: 'failed', retryable: false });
    expect(env.getTask(task.id)!.runRecords?.[runId]?.turnBindings?.[attempt]).toBeUndefined();
    expect(env.getTask(task.id)!.runRecords?.[runId]?.turnBindings?.[source]).toBeUndefined();
    expect(env.owner.bindRecovery(`schedule:review_abandon_terminal:${crypto.randomUUID()}`, source)).toBe(false);
    disposeOrdinaryTurnRecovery(session);
  });

  it('review P1: production settle-before-abandon still releases the exact logical source', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_settle_then_abandon' });
    const runId = 'run-settle-then-abandon';
    const source = `schedule:review_settle_then_abandon:${crypto.randomUUID()}`;
    const attempt = `schedule:review_settle_then_abandon:${crypto.randomUUID()}`;
    expect(env.claimRun(task.id, { lastRunAt: '2026-09-28T15:00:00.000Z', nextRunAt: '2026-09-29T15:00:00.000Z', lastRunId: runId }).ok).toBe(true);
    env.setRunTargetCount(task.id, 1, runId);
    expect(env.owner.bindDispatch(source, runId)).toBe(true);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    expect(env.owner.bindRecovery(attempt, source)).toBe(true);
    // Daemon's schedule terminal path runs before ordinary recovery terminal ownership.
    expect(env.owner.settle(attempt, 'failed', 'non-retryable')).toBe(true);
    const session: any = { sessionId: `settle-first-${crypto.randomUUID()}`, ordinaryTurnRecovery: { logicalTurnId: source, currentTurnId: attempt, continuationsStarted: 1, status: 'running' } };
    attachOrdinaryTurnRecovery(session, { schedule: vi.fn(), cancel: vi.fn(), persist: vi.fn(), enqueue: vi.fn(), warn: vi.fn(), abandonRecoveryTurn: env.abandonRecoveryTurn });
    handleOrdinaryTurnRecoveryTerminal(session, { turnId: attempt, status: 'failed', retryable: false });
    const rec = env.getTask(task.id)!.runRecords?.[runId];
    expect(rec?.turnBindings?.[attempt]).toBeUndefined();
    expect(rec?.turnBindings?.[source]).toBeUndefined();
    expect(rec?.perTargetErrors?.[source]).toBeUndefined();
    expect(env.owner.bindRecovery(`schedule:review_settle_then_abandon:${crypto.randomUUID()}`, source)).toBe(false);
    disposeOrdinaryTurnRecovery(session);
  });

  it('review P1: deleted task rejects a late dispatch bind without transient authority', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_late_bind_delete' });
    const runId = 'run-late-bind-delete';
    const late = `schedule:review_late_bind_delete:${crypto.randomUUID()}`;
    expect(env.claimRun(task.id, { lastRunAt: '2026-09-28T16:00:00.000Z', nextRunAt: '2026-09-29T16:00:00.000Z', lastRunId: runId }).ok).toBe(true);
    env.markRun(task.id, true, undefined, undefined, runId);
    expect(env.getTask(task.id)).toBeDefined();
    // Direct durable deletion races the late worker callback.
    const store = await import('../src/services/schedule-store.js');
    expect(store.removeTask(task.id)).toBe(true);
    expect(env.owner.bindDispatch(late, runId)).toBe(false);
    expect(env.owner.hasTransient(late)).toBe(false);
    expect(env.owner.hasDurable(late)).toBe(false);
    expect(env.owner.settle(late, 'completed')).toBe(false);
  });

  it('review RED P1: original non-retryable source is restart-safely abandoned after schedule settle', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_original_abandon' });
    const runId = 'run-original-abandon';
    const source = `schedule:review_original_abandon:${crypto.randomUUID()}`;
    expect(env.claimRun(task.id, { lastRunAt: '2026-09-28T17:00:00.000Z', nextRunAt: '2026-09-29T17:00:00.000Z', lastRunId: runId }).ok).toBe(true);
    env.setRunTargetCount(task.id, 1, runId);
    expect(env.owner.bindDispatch(source, runId)).toBe(true);
    // Production schedule terminal settles first, then ordinary recovery
    // decides this source cannot be retried.
    expect(env.owner.settle(source, 'failed', 'non-retryable')).toBe(true);
    const restored = await freshEnv();
    const session: any = { sessionId: `original-abandon-${crypto.randomUUID()}`, ordinaryTurnRecovery: { logicalTurnId: source, currentTurnId: source, continuationsStarted: 0, status: 'running' } };
    attachOrdinaryTurnRecovery(session, { schedule: vi.fn(), cancel: vi.fn(), persist: vi.fn(), enqueue: vi.fn(), warn: vi.fn(), abandonRecoveryTurn: restored.abandonRecoveryTurn });
    handleOrdinaryTurnRecoveryTerminal(session, { turnId: source, status: 'failed', retryable: false });
    const rec = restored.getTask(task.id)!.runRecords?.[runId];
    expect(rec?.turnBindings?.[source]).toBeUndefined();
    expect(rec?.perTargetErrors?.[source]).toBeUndefined();
    expect(restored.owner.bindRecovery(`schedule:review_original_abandon:${crypto.randomUUID()}`, source)).toBe(false);
    disposeOrdinaryTurnRecovery(session);
  });

  it('review RED P1: Basic and AWS secrets leave neither full value nor fragments', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_basic_aws_credentials' });
    const cases = [
      'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      'AWS_SECRET_ACCESS_KEY=AKIA_super_secret_key_fragment',
    ];
    for (let index = 0; index < cases.length; index++) {
      const runId = `run-basic-aws-${index}`;
      const turnId = `schedule:review_basic_aws_credentials:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-28T18:0${index}:00.000Z`, nextRunAt: '2026-09-29T18:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', cases[index])).toBe(true);
      const error = env.getTask(task.id)!.lastTerminalError!;
      for (const fragment of ['QWxhZGRpbj', 'c2FtZQ', 'AKIA', 'super', 'secret', 'fragment']) expect(error).not.toContain(fragment);
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('review RED P1: Authorization Basic redacts text, JSON and escaped JSON values', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_authorization_json_basic' });
    const cases = [
      'Authorization: Basic TEXT_BASIC_SECRET_AlphaBeta',
      '{"Authorization":"Basic JSON_BASIC_SECRET_AlphaBeta"}',
      '{\\"Authorization\\":\\"Basic ESCAPED_JSON_BASIC_SECRET_AlphaBeta\\"}',
    ];
    for (let index = 0; index < cases.length; index++) {
      const runId = `run-authorization-basic-${index}`;
      const turnId = `schedule:review_authorization_json_basic:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-28T19:0${index}:00.000Z`, nextRunAt: '2026-09-29T19:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', cases[index])).toBe(true);
      const error = env.getTask(task.id)!.lastTerminalError!;
      for (const fragment of ['TEXT_BASIC', 'JSON_BASIC', 'ESCAPED_JSON', 'SECRET', 'AlphaBeta']) expect(error).not.toContain(fragment);
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('review RED P1: Basic Authorization handles arbitrary escape runs and composite Bearer', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_authorization_escape_runs' });
    const raws = [0, 1, 2, 4].map(level => {
      const quote = '\\'.repeat(level) + '"';
      return `{${quote}Authorization${quote}:${quote}Basic L${level}_BASIC_SECRET_AlphaBeta${quote}}`;
    });
    const composite = '{\\\\"Authorization\\\\":\\\\"Basic COMPOSITE_BASIC_SECRET_AlphaBeta\\\\" Bearer COMPOSITE_BEARER_SECRET_GammaDelta}';
    for (const [index, raw] of [...raws, composite].entries()) {
      const runId = `run-authorization-escape-${index}`;
      const turnId = `schedule:review_authorization_escape_runs:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-28T20:0${index}:00.000Z`, nextRunAt: '2026-09-29T20:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const error = env.getTask(task.id)!.lastTerminalError!;
      for (const fragment of ['L2_BASIC', 'L4_BASIC', 'AlphaBeta', 'COMPOSITE_BASIC', 'COMPOSITE_BEARER', 'GammaDelta']) expect(error).not.toContain(fragment);
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('review RED P1: Basic redaction preserves adjacent compact JSON fields at every escape depth', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_basic_compact_json_boundary' });
    for (let depth = 0; depth <= 9; depth++) {
      const quote = '\\'.repeat(depth) + '"';
      const raw = `{${quote}Authorization${quote}:${quote}Basic DEPTH_${depth}_BASIC_SECRET_AlphaBeta${quote},${quote}access_token${quote}:${quote}KEEP_ACCESS_${depth}${quote},${quote}message${quote}:${quote}KEEP_ADJACENT_CONTEXT_42${quote}}`;
      const runId = `run-basic-compact-${depth}`;
      const turnId = `schedule:review_basic_compact_json_boundary:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-28T21:${String(depth).padStart(2, '0')}:00.000Z`, nextRunAt: '2026-09-29T21:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const error = env.getTask(task.id)!.lastTerminalError!;
      expect(error).not.toContain(`DEPTH_${depth}_BASIC`);
      expect(error).not.toContain('SECRET_AlphaBeta');
      // access_token retains its field boundary but remains protected by the
      // existing OAuth rule; Basic must not consume the adjacent field.
      expect(error).toContain('access_token=[redacted]');
      expect(error).toContain('KEEP_ADJACENT_CONTEXT_42');
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('review RED P1: owner restore settles the persisted original turn exactly once', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_restore_original_terminal' });
    const runId = 'run-restore-original';
    const turnId = `schedule:review_restore_original_terminal:${crypto.randomUUID()}`;
    expect(env.claimRun(task.id, { lastRunAt: '2026-09-28T01:00:00.000Z', nextRunAt: '2026-09-29T01:00:00.000Z', lastRunId: runId }).ok).toBe(true);
    expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
    const restored = await freshEnv();
    expect(restored.owner.settle(turnId, 'failed', 'original terminal')).toBe(true);
    expect(restored.owner.settle(turnId, 'failed', 'late duplicate')).toBe(false);
  });

  it('review RED P1: prefixed credential keys redact only the sensitive value', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_prefixed_keys' });
    const cases = [
      'OPENAI_API_KEY=OPENAI_PREFIX_SECRET,message=KEEP_OPENAI',
      'GITHUB_TOKEN=GITHUB_PREFIX_SECRET,message=KEEP_GITHUB',
      'DB_PASSWORD=DB_PREFIX_SECRET,message=KEEP_DB',
    ];
    for (let index = 0; index < cases.length; index++) {
      const runId = `run-prefixed-${index}`;
      const turnId = `schedule:review_prefixed_keys:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-28T02:0${index}:00.000Z`, nextRunAt: '2026-09-29T02:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', cases[index])).toBe(true);
      const error = env.getTask(task.id)!.lastTerminalError!;
      for (const secret of ['OPENAI_PREFIX_SECRET', 'GITHUB_PREFIX_SECRET', 'DB_PREFIX_SECRET']) expect(error).not.toContain(secret);
      for (const context of ['KEEP_OPENAI', 'KEEP_GITHUB', 'KEEP_DB']) if (cases[index].includes(context)) expect(error).toContain(context);
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('review RED P1: one raw target failure exposes an explicit failed target result', async () => {
    const task = {
      ...TASK_PARAMS,
      id: 'review_raw_single_target',
      enabled: true,
      createdAt: new Date().toISOString(),
    } as any;
    await expect(executeScheduledTaskForTargets(task, [task.chatId], async () => {
      throw new Error('raw single target failure');
    }, true)).rejects.toMatchObject({
      name: 'ScheduleTargetExecutionError',
      targetResults: [{ chatId: task.chatId, outcome: 'error', error: 'raw single target failure' }],
    });
  });

  it('review RED P1: JSON Authorization Basic and Bearer consume every value word but preserve next field', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_authorization_value_tail' });
    const cases = [
      '{"Authorization":"Basic BASIC_FULL_SECRET AUTH_TAIL","message":"KEEP_BASIC_FIELD"}',
      '{\\"Authorization\\":\\"Bearer BEARER_FULL_SECRET AUTH_TAIL\\",\\"message\\":\\"KEEP_BEARER_FIELD\\"}',
    ];
    for (let index = 0; index < cases.length; index++) {
      const runId = `run-auth-tail-${index}`;
      const turnId = `schedule:review_authorization_value_tail:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-28T03:0${index}:00.000Z`, nextRunAt: '2026-09-29T03:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', cases[index])).toBe(true);
      const error = env.getTask(task.id)!.lastTerminalError!;
      for (const fragment of ['BASIC_FULL', 'BEARER_FULL', 'AUTH_TAIL']) expect(error).not.toContain(fragment);
      expect(error).toContain(index === 0 ? 'KEEP_BASIC_FIELD' : 'KEEP_BEARER_FIELD');
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('review P1: unquoted delimiter values and quoted Basic/Bearer preserve adjacent context', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_compact_delimiter_context' });
    const cases = [
      'password=PW_SECRET,token=TOK_SECRET,message=KEEP_COMPACT;api_key=API_SECRET status=KEEP_SPACE',
      'Authorization: Basic "BASIC_SECRET" status=KEEP_BASIC Bearer "BEARER_SECRET";message=KEEP_BEARER',
    ];
    for (let index = 0; index < cases.length; index++) {
      const runId = `run-compact-context-${index}`;
      const turnId = `schedule:review_compact_delimiter_context:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-28T22:0${index}:00.000Z`, nextRunAt: '2026-09-29T22:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', cases[index])).toBe(true);
      const error = env.getTask(task.id)!.lastTerminalError!;
      for (const fragment of ['PW_SECRET', 'TOK_SECRET', 'API_SECRET', 'BASIC_SECRET', 'BEARER_SECRET']) expect(error).not.toContain(fragment);
      for (const context of ['KEEP_COMPACT', 'KEEP_SPACE', 'KEEP_BASIC', 'KEEP_BEARER']) {
        if (cases[index].includes(context)) expect(error).toContain(context);
      }
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('review RED P1: only an exact same-layer quote closes Basic and Bearer values', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_exact_slash_layer' });
    for (let depth = 1; depth <= 9; depth++) {
      const open = '\\'.repeat(depth) + '"';
      const inner = '\\'.repeat(depth + 2) + '"';
      const raw = `{${open}Authorization${open}:${open}Basic BASIC_HEAD_${depth} BASIC_TAIL_${depth}${inner},Bearer BEAR_HEAD_${depth} BEAR_TAIL_${depth}${open},${open}message${open}:${open}KEEP_LAYER_${depth}${open}}`;
      const runId = `run-exact-layer-${depth}`;
      const turnId = `schedule:review_exact_slash_layer:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-28T23:${String(depth).padStart(2, '0')}:00.000Z`, nextRunAt: '2026-09-29T23:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const error = env.getTask(task.id)!.lastTerminalError!;
      for (const fragment of [`BASIC_HEAD_${depth}`, `BASIC_TAIL_${depth}`, `BEAR_HEAD_${depth}`, `BEAR_TAIL_${depth}`]) expect(error).not.toContain(fragment);
      expect(error).toContain(`KEEP_LAYER_${depth}`);
      env.markRun(task.id, false, 'error', undefined, runId);
    }
  });

  it('review RED P1: sensitive words in ordinary context values are not treated as keys', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_key_position_boundary' });
    const raw = 'message=GITHUB_TOKEN,status=DB_PASSWORD,detail=OPENAI_API_KEY,OPENAI_API_KEY=REAL_KEY_SECRET';
    const runId = 'run-key-position';
    const turnId = `schedule:review_key_position_boundary:${crypto.randomUUID()}`;
    expect(env.claimRun(task.id, { lastRunAt: '2026-09-28T23:30:00.000Z', nextRunAt: '2026-09-29T23:30:00.000Z', lastRunId: runId }).ok).toBe(true);
    expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
    expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
    const error = env.getTask(task.id)!.lastTerminalError!;
    expect(error).not.toContain('REAL_KEY_SECRET');
    expect(error).toContain('message=GITHUB_TOKEN');
    expect(error).toContain('status=DB_PASSWORD');
    expect(error).toContain('detail=OPENAI_API_KEY');
  });

  it('review RED P1: same-layer Basic and Bearer values close before punctuation-delimited status', async () => {
    const env = await freshEnv();
    const delimiters = [';', '|', '&', ')'];
    const schemes = ['Basic', 'Bearer'];
    let index = 0;
    for (let depth = 0; depth <= 5; depth++) {
      const quote = '\\'.repeat(depth) + '"';
      for (const delimiter of delimiters) {
        for (const scheme of schemes) {
          const runId = `run-auth-punctuation-${depth}-${index}`;
          const head = `${scheme}_HEAD_${depth}_${index}`;
          const tail = `${scheme}_TAIL_${depth}_${index}`;
          const status = `KEEP_STATUS_${depth}_${index}`;
          const raw = `{${quote}Authorization${quote}:${quote}${scheme} ${head} ${tail}${quote}${delimiter}status=${status}`;
          const task = env.createTask({ ...TASK_PARAMS, id: `review_auth_punctuation_boundary_${index}` });
          const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
          expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T00:${String(index).padStart(2, '0')}:00.000Z`, nextRunAt: '2026-09-30T00:00:00.000Z', lastRunId: runId }).ok).toBe(true);
          expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
          expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
          const persisted = env.getTask(task.id)!;
          const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
          for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
            expect(error).not.toContain(head);
            expect(error).not.toContain(tail);
            expect(error).toContain(status);
          }
          index++;
        }
      }
    }
  });

  it('review RED P1: sensitive-name text inside message, status and detail values remains literal', async () => {
    const env = await freshEnv();
    const formats = [
      (field: string, literal: string, actual: string) => `${field}=${literal},OPENAI_API_KEY=${actual}`,
      (field: string, literal: string, actual: string) => `{"${field}":"${literal}","OPENAI_API_KEY":"${actual}"}`,
      (field: string, literal: string, actual: string) => `{\\"${field}\\":\\"${literal}\\",\\"OPENAI_API_KEY\\":\\"${actual}\\"}`,
    ];
    const cases = [
      ['message', 'GITHUB_TOKEN=KEEP_MESSAGE_LITERAL'],
      ['status', 'DB_PASSWORD:KEEP_STATUS_LITERAL'],
      ['detail', 'OPENAI_API_KEY=KEEP_DETAIL_LITERAL'],
    ] as const;
    let index = 0;
    for (const format of formats) {
      for (const [field, literal] of cases) {
        const runId = `run-sensitive-value-${index}`;
        const actual = `REAL_SECRET_${index}`;
        const task = env.createTask({ ...TASK_PARAMS, id: `review_sensitive_value_text_${index}` });
        const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
        expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T01:${String(index).padStart(2, '0')}:00.000Z`, nextRunAt: '2026-09-30T01:00:00.000Z', lastRunId: runId }).ok).toBe(true);
        expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
        expect(env.owner.settle(turnId, 'failed', format(field, literal, actual))).toBe(true);
        const persisted = env.getTask(task.id)!;
        const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
        for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
          expect(error).not.toContain(actual);
          expect(error).toContain(literal);
        }
        index++;
      }
    }
  });

  it('review RED P1: quoted message, status and detail values ignore internal field delimiters', async () => {
    const env = await freshEnv();
    const cases = [
      ['message', 'GITHUB_TOKEN=KEEP_PLAIN_COMMA', 'before,GITHUB_TOKEN=KEEP_PLAIN_COMMA', 'OPENAI_API_KEY=REAL_PLAIN_SECRET'],
      ['status', 'DB_PASSWORD:KEEP_PLAIN_SEMICOLON', 'before;DB_PASSWORD:KEEP_PLAIN_SEMICOLON', 'OPENAI_API_KEY=REAL_STATUS_SECRET'],
      ['detail', 'OPENAI_API_KEY=KEEP_PLAIN_PIPE', 'before|OPENAI_API_KEY=KEEP_PLAIN_PIPE', 'OPENAI_API_KEY=REAL_DETAIL_SECRET'],
      ['message', 'GITHUB_TOKEN=KEEP_JSON_AMPERSAND', 'before&GITHUB_TOKEN=KEEP_JSON_AMPERSAND', '{"message":"before&GITHUB_TOKEN=KEEP_JSON_AMPERSAND","OPENAI_API_KEY":"REAL_JSON_SECRET"}'],
      ['detail', 'OPENAI_API_KEY=KEEP_ESCAPED_PAREN', 'before)OPENAI_API_KEY=KEEP_ESCAPED_PAREN', '{\\"detail\\":\\"before)OPENAI_API_KEY=KEEP_ESCAPED_PAREN\\",\\"OPENAI_API_KEY\\":\\"REAL_ESCAPED_SECRET\\"}'],
    ] as const;
    for (const [index, [field, literal, value, structured]] of cases.entries()) {
      const runId = `run-quoted-value-delimiter-${index}`;
      const task = env.createTask({ ...TASK_PARAMS, id: `review_quoted_value_delimiter_${index}` });
      const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
      const raw = structured.startsWith('{') ? structured : `${field}="${value}";${structured}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T02:0${index}:00.000Z`, nextRunAt: '2026-09-30T02:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const persisted = env.getTask(task.id)!;
      const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
      for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
        expect(error).toContain(literal);
        expect(error).not.toContain('REAL_PLAIN_SECRET');
        expect(error).not.toContain('REAL_STATUS_SECRET');
        expect(error).not.toContain('REAL_DETAIL_SECRET');
        expect(error).not.toContain('REAL_JSON_SECRET');
        expect(error).not.toContain('REAL_ESCAPED_SECRET');
      }
    }
  });

  it('review RED P1: multiple JSON credential families are redacted from one immutable source', async () => {
    const env = await freshEnv();
    const cases = [
      ['oauth-json', '{"access_token":"ACCESS_ALPHA","refresh_token":"REFRESH_BRAVO","client_secret":"CLIENT_CHARLIE","message":"KEEP_JSON"}'],
      ['oauth-escaped', '{\\"access_token\\":\\"ACCESS_DELTA\\",\\"refresh_token\\":\\"REFRESH_ECHO\\",\\"client_secret\\":\\"CLIENT_FOXTROT\\",\\"message\\":\\"KEEP_ESCAPED\\"}'],
      ['prefixed-json', '{"GITHUB_TOKEN":"GITHUB_GOLF","DB_PASSWORD":"PASSWORD_HOTEL","OPENAI_API_KEY":"OPENAI_INDIA","message":"KEEP_PREFIXED"}'],
      ['prefixed-escaped', '{\\"GITHUB_TOKEN\\":\\"GITHUB_JULIET\\",\\"DB_PASSWORD\\":\\"PASSWORD_KILO\\",\\"OPENAI_API_KEY\\":\\"OPENAI_LIMA\\",\\"message\\":\\"KEEP_PREFIXED_ESCAPED\\"}'],
      ['mixed-json', '{"accessToken":"ACCESS_MIKE","refresh_token":"REFRESH_NOVEMBER","AWS_SECRET_ACCESS_KEY":"AWS_OSCAR","message":"KEEP_MIXED"}'],
    ] as const;
    const fragments = [
      'ACCESS_ALPHA', 'REFRESH_BRAVO', 'CLIENT_CHARLIE', 'ACCESS_DELTA', 'REFRESH_ECHO', 'CLIENT_FOXTROT',
      'GITHUB_GOLF', 'PASSWORD_HOTEL', 'OPENAI_INDIA', 'GITHUB_JULIET', 'PASSWORD_KILO', 'OPENAI_LIMA',
      'ACCESS_MIKE', 'REFRESH_NOVEMBER', 'AWS_OSCAR',
    ];
    for (const [index, [name, raw]] of cases.entries()) {
      const task = env.createTask({ ...TASK_PARAMS, id: `review_multi_credential_${name.replace('-', '_')}` });
      const runId = `run-multi-credential-${index}`;
      const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T03:0${index}:00.000Z`, nextRunAt: '2026-09-30T03:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const persisted = env.getTask(task.id)!;
      const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
      for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
        for (const fragment of fragments) expect(error).not.toContain(fragment);
        expect(error).toContain(index === 1 ? 'KEEP_ESCAPED' : index === 3 ? 'KEEP_PREFIXED_ESCAPED' : index === 4 ? 'KEEP_MIXED' : index === 2 ? 'KEEP_PREFIXED' : 'KEEP_JSON');
      }
    }
  });

  it('review RED P1: scheduled ordinary recovery bypasses only deleted or archived binding metadata', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_recovery_missing_metadata', repeat: { times: 1, completed: 0 } });
    const runId = 'run-recovery-missing-metadata';
    const source = `schedule:${task.id}:${crypto.randomUUID()}`;
    const rejectedAttempt = `schedule:${task.id}:${crypto.randomUUID()}`;
    expect(env.claimRun(task.id, { lastRunAt: '2026-09-29T04:00:00.000Z', nextRunAt: '2026-09-30T04:00:00.000Z', lastRunId: runId }).ok).toBe(true);
    expect(env.owner.bindDispatch(source, runId)).toBe(true);
    // A still-persisted but non-failed source is an authority mismatch and must
    // remain fail-closed.
    expect(env.bindRecoveryTurn(rejectedAttempt, source)).toBe(false);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    env.markRun(task.id, true, undefined, undefined, runId);
    expect(env.getTask(task.id)).toBeUndefined();

    const timers: Array<() => void> = [];
    const enqueued: string[] = [];
    const session: any = { sessionId: `recovery-missing-metadata-${crypto.randomUUID()}` };
    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: dispatch => { enqueued.push(dispatch.turnId); return true; },
      warn: vi.fn(),
      mintContinuationTurnId: logical => `schedule:${task.id}:${crypto.randomUUID()}`,
      bindRecoveryTurn: env.bindRecoveryTurn,
      backoffMs: [0, 0],
    });
    beginOrdinaryTurnRecovery(session, source);
    handleOrdinaryTurnRecoveryTerminal(session, { turnId: source, status: 'failed', retryable: true });
    timers.shift()!();
    expect(enqueued).toHaveLength(1);
    disposeOrdinaryTurnRecovery(session);

    const retryTask = env.createTask({ ...TASK_PARAMS, id: 'review_recovery_retry_binding' });
    const retryRunId = 'run-recovery-retry-binding';
    const retrySource = `schedule:${retryTask.id}:${crypto.randomUUID()}`;
    expect(env.claimRun(retryTask.id, { lastRunAt: '2026-09-29T04:10:00.000Z', nextRunAt: '2026-09-30T04:10:00.000Z', lastRunId: retryRunId }).ok).toBe(true);
    expect(env.owner.bindDispatch(retrySource, retryRunId)).toBe(true);
    expect(env.owner.settle(retrySource, 'failed', 'retry')).toBe(true);

    const retryTimers: Array<() => void> = [];
    const retryEnqueued: string[] = [];
    const retrySession: any = { sessionId: `recovery-retry-binding-${crypto.randomUUID()}` };
    attachOrdinaryTurnRecovery(retrySession, {
      schedule: (_delay, run) => { retryTimers.push(run); return run; },
      cancel: vi.fn(), persist: vi.fn(),
      enqueue: dispatch => { retryEnqueued.push(dispatch.turnId); return true; },
      warn: vi.fn(),
      mintContinuationTurnId: logical => `schedule:${retryTask.id}:${crypto.randomUUID()}`,
      bindRecoveryTurn: env.bindRecoveryTurn,
      releaseRecoveryTurn: env.releaseRecoveryTurn,
      backoffMs: [0, 0],
    });
    beginOrdinaryTurnRecovery(retrySession, retrySource);
    handleOrdinaryTurnRecoveryTerminal(retrySession, { turnId: retrySource, status: 'failed', retryable: true });
    retryTimers.shift()!();
    expect(retryEnqueued).toHaveLength(1);
    expect(env.owner.settle(retryEnqueued[0], 'failed', 'retry')).toBe(true);
    handleOrdinaryTurnRecoveryTerminal(retrySession, { turnId: retryEnqueued[0], status: 'failed', retryable: true });
    retryTimers.shift()!();
    expect(retryEnqueued).toHaveLength(2);
    disposeOrdinaryTurnRecovery(retrySession);

    const restored = await freshEnv();
    const restoreTimers: Array<() => void> = [];
    const restoredDispatches: Array<{ turnId: string; silent: boolean }> = [];
    const restoredSession: any = {
      sessionId: `recovery-archive-restore-${crypto.randomUUID()}`,
      ordinaryTurnRecovery: {
        logicalTurnId: source,
        currentTurnId: source,
        continuationsStarted: 0,
        status: 'backoff',
        nextAttemptAt: 0,
        silentLogicalTurnIds: [source],
      },
    };
    attachOrdinaryTurnRecovery(restoredSession, {
      schedule: (_delay, run) => { restoreTimers.push(run); return run; },
      cancel: vi.fn(), persist: vi.fn(),
      enqueue: dispatch => { restoredDispatches.push({ turnId: dispatch.turnId, silent: dispatch.silent }); return true; },
      warn: vi.fn(),
      mintContinuationTurnId: logical => `schedule:${task.id}:${crypto.randomUUID()}`,
      bindRecoveryTurn: restored.bindRecoveryTurn,
      backoffMs: [0, 0],
    });
    restoreTimers.shift()!();
    expect(restoredDispatches).toHaveLength(1);
    expect(restoredDispatches[0].silent).toBe(true);
    disposeOrdinaryTurnRecovery(restoredSession);
  });

  it('review RED P1: active owner rejects a cross-task recovery continuation', async () => {
    const env = await freshEnv();
    const sourceTask = env.createTask({ ...TASK_PARAMS, id: 'review_active_source' });
    const otherTask = env.createTask({ ...TASK_PARAMS, id: 'review_active_other' });
    const source = `schedule:${sourceTask.id}:${crypto.randomUUID()}`;
    const crossTaskAttempt = `schedule:${otherTask.id}:${crypto.randomUUID()}`;

    expect(env.bindRecoveryTurn(crossTaskAttempt, source)).toBe(false);
  });

  it('review RED P1: active owner rejects a live task without its source binding', async () => {
    const env = await freshEnv();
    const sourceTask = env.createTask({ ...TASK_PARAMS, id: 'review_active_unbound' });
    const unboundSource = `schedule:${sourceTask.id}:${crypto.randomUUID()}`;
    const sameTaskAttempt = `schedule:${sourceTask.id}:${crypto.randomUUID()}`;

    expect(env.bindRecoveryTurn(sameTaskAttempt, unboundSource)).toBe(false);
  });

  it('review RED P1: active owner lets a rejecting legacy binder veto recovery', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_active_legacy_veto' });
    const runId = 'run-active-legacy-veto';
    const source = `schedule:${task.id}:${crypto.randomUUID()}`;
    const attempt = `schedule:${task.id}:${crypto.randomUUID()}`;
    expect(env.claimRun(task.id, { lastRunAt: '2026-09-29T06:00:00.000Z', nextRunAt: '2026-09-30T06:00:00.000Z', lastRunId: runId }).ok).toBe(true);
    expect(env.owner.bindDispatch(source, runId)).toBe(true);
    expect(env.owner.settle(source, 'failed', 'retry')).toBe(true);
    const reject = vi.fn(() => undefined);
    env.setRecoveryBindFn(reject);

    expect(env.bindRecoveryTurn(attempt, source)).toBe(false);
    expect(reject).toHaveBeenCalledWith(attempt, source);
    expect(env.owner.hasTransient(attempt)).toBe(false);
  });

  it('review RED P1: single-quoted Authorization and direct message fields keep no secret tails', async () => {
    const env = await freshEnv();
    const cases = [
      ["{'Authorization':'Basic SINGLE_BASIC_HEAD SINGLE_BASIC_TAIL','message':'KEEP_SINGLE'}", ['SINGLE_BASIC_HEAD', 'SINGLE_BASIC_TAIL']],
      ["{\\'Authorization\\':\\'Bearer ESCAPED_BEAR_HEAD ESCAPED_BEAR_TAIL\\',\\'message\\':\\'KEEP_ESCAPED_SINGLE\\'}", ['ESCAPED_BEAR_HEAD', 'ESCAPED_BEAR_TAIL']],
      ['message=access_token=KEEP_DIRECT_TOKEN,status=client_secret:KEEP_DIRECT_SECRET,detail=GITHUB_TOKEN=KEEP_DIRECT_GITHUB', []],
    ] as const;
    for (const [index, [raw, fragments]] of cases.entries()) {
      const task = env.createTask({ ...TASK_PARAMS, id: `review_single_quote_direct_${index}` });
      const runId = `run-single-quote-direct-${index}`;
      const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T05:0${index}:00.000Z`, nextRunAt: '2026-09-30T05:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const persisted = env.getTask(task.id)!;
      const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
      for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
        for (const fragment of fragments) expect(error).not.toContain(fragment);
        if (index === 2) {
          expect(error).toContain('message=access_token=KEEP_DIRECT_TOKEN');
          expect(error).toContain('status=client_secret:KEEP_DIRECT_SECRET');
          expect(error).toContain('detail=GITHUB_TOKEN=KEEP_DIRECT_GITHUB');
        }
      }
    }
  });

  it('review RED P1: multi-target success followed by failure retains a writable error record', async () => {
    const env = await freshEnv();
    const task = env.createTask({ ...TASK_PARAMS, id: 'review_success_then_failure' });
    const runId = 'run-success-then-failure';
    const first = `schedule:${task.id}:${crypto.randomUUID()}`;
    const second = `schedule:${task.id}:${crypto.randomUUID()}`;
    expect(env.claimRun(task.id, { lastRunAt: '2026-09-29T05:30:00.000Z', nextRunAt: '2026-09-30T05:30:00.000Z', lastRunId: runId }).ok).toBe(true);
    env.setRunTargetCount(task.id, 2, runId);
    expect(env.owner.bindDispatch(first, runId)).toBe(true);
    expect(env.owner.bindDispatch(second, runId)).toBe(true);
    expect(env.owner.settle(first, 'completed')).toBe(true);
    let accepted = false;
    expect(() => { accepted = env.owner.settle(second, 'failed', 'SECOND_TARGET_FAILURE'); }).not.toThrow();
    expect(accepted).toBe(true);
    const persisted = env.getTask(task.id)!;
    expect(persisted.lastTerminalStatus).toBe('error');
    expect(persisted.lastTerminalError).toBe('SECOND_TARGET_FAILURE');
    expect(persisted.runRecords?.[runId]?.perTargetErrors?.[second]).toBe('SECOND_TARGET_FAILURE');
  });

  it('review RED P1: plain quoted Authorization and protected direct fields preserve exact boundaries', async () => {
    const env = await freshEnv();
    const cases = [
      ["Authorization='Basic SYNTH_BASIC_VALUE SYNTH_BASIC_TAIL';status=KEEP_STATUS", ['SYNTH_BASIC_VALUE', 'SYNTH_BASIC_TAIL'], 'KEEP_STATUS'],
      ['Authorization="Bearer SYNTH_BEAR_VALUE SYNTH_BEAR_TAIL"&detail=KEEP_DETAIL', ['SYNTH_BEAR_VALUE', 'SYNTH_BEAR_TAIL'], 'KEEP_DETAIL'],
      ["Authorization=\\'Basic SYNTH_ESCAPED_VALUE SYNTH_ESCAPED_TAIL\\'|message=KEEP_MESSAGE", ['SYNTH_ESCAPED_VALUE', 'SYNTH_ESCAPED_TAIL'], 'KEEP_MESSAGE'],
      ['message: access_token=KEEP_LITERAL_TOKEN,OPENAI_API_KEY=SYNTH_REAL_KEY', ['SYNTH_REAL_KEY'], 'access_token=KEEP_LITERAL_TOKEN'],
      ['status: client_secret=KEEP_LITERAL_SECRET;DB_PASSWORD=SYNTH_REAL_PASSWORD', ['SYNTH_REAL_PASSWORD'], 'client_secret=KEEP_LITERAL_SECRET'],
      ['detail: GITHUB_TOKEN=KEEP_LITERAL_GITHUB|access_token=SYNTH_REAL_ACCESS', ['SYNTH_REAL_ACCESS'], 'GITHUB_TOKEN=KEEP_LITERAL_GITHUB'],
    ] as const;
    for (const [index, [raw, hidden, kept]] of cases.entries()) {
      const task = env.createTask({ ...TASK_PARAMS, id: `review_plain_boundary_${index}` });
      const runId = `run-plain-boundary-${index}`;
      const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T06:0${index}:00.000Z`, nextRunAt: '2026-09-30T06:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const persisted = env.getTask(task.id)!;
      const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
      for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
        for (const fragment of hidden) expect(error).not.toContain(fragment);
        expect(error).toContain(kept);
      }
    }
  });

  it('review P1: a closing quote followed by a spaced field releases both wrapper and protected-value state', async () => {
    const env = await freshEnv();
    const cases = [
      ["Authorization='Basic SYNTH_SPACE_AUTH' status=KEEP_AUTH_STATUS", ['SYNTH_SPACE_AUTH'], 'KEEP_AUTH_STATUS'],
      ['message="token=KEEP_QUOTED_LITERAL,still-text" OPENAI_API_KEY=SYNTH_AFTER_MESSAGE', ['SYNTH_AFTER_MESSAGE'], 'token=KEEP_QUOTED_LITERAL,still-text'],
      ["detail='client_secret=KEEP_SINGLE_LITERAL;still-text' DB_PASSWORD=SYNTH_AFTER_DETAIL", ['SYNTH_AFTER_DETAIL'], 'client_secret=KEEP_SINGLE_LITERAL;still-text'],
    ] as const;
    for (const [index, [raw, hidden, kept]] of cases.entries()) {
      const task = env.createTask({ ...TASK_PARAMS, id: `review_space_field_handoff_${index}` });
      const runId = `run-space-field-handoff-${index}`;
      const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T07:0${index}:00.000Z`, nextRunAt: '2026-09-30T07:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const persisted = env.getTask(task.id)!;
      const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
      for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
        for (const fragment of hidden) expect(error).not.toContain(fragment);
        expect(error).toContain(kept);
      }
    }
  });

  it('review RED P1: unquoted protected values release at a whitespace-delimited real field', async () => {
    const env = await freshEnv();
    const cases = [
      ['message=KEEP_MESSAGE_LITERAL OPENAI_API_KEY=SYNTH_AFTER_MESSAGE', ['SYNTH_AFTER_MESSAGE'], 'KEEP_MESSAGE_LITERAL'],
      ['status=KEEP_STATUS_LITERAL\tDB_PASSWORD=SYNTH_AFTER_STATUS', ['SYNTH_AFTER_STATUS'], 'KEEP_STATUS_LITERAL'],
      ['detail=KEEP_DETAIL_LITERAL access_token=SYNTH_AFTER_DETAIL', ['SYNTH_AFTER_DETAIL'], 'KEEP_DETAIL_LITERAL'],
      ['message=KEEP TWO WORDS refresh_token=SYNTH_AFTER_SPACES', ['SYNTH_AFTER_SPACES'], 'KEEP TWO WORDS'],
      ['status=KEEP\tTABBED client_secret=SYNTH_AFTER_TABS', ['SYNTH_AFTER_TABS'], 'KEEP\tTABBED'],
      ['detail=KEEP_LITERAL GITHUB_TOKEN=SYNTH_AFTER_GITHUB', ['SYNTH_AFTER_GITHUB'], 'KEEP_LITERAL'],
    ] as const;
    for (const [index, [raw, hidden, kept]] of cases.entries()) {
      const task = env.createTask({ ...TASK_PARAMS, id: `review_unquoted_handoff_${index}` });
      const runId = `run-unquoted-handoff-${index}`;
      const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T08:0${index}:00.000Z`, nextRunAt: '2026-09-30T08:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const persisted = env.getTask(task.id)!;
      const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
      for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
        for (const fragment of hidden) expect(error).not.toContain(fragment);
        expect(error).toContain(kept);
      }
    }
  });

  it('review RED P1: shared field tokens accept whitespace before separators for credentials and Authorization', async () => {
    const env = await freshEnv();
    const cases = [
      ['OPENAI_API_KEY \t= SYNTH_SPACED_KEY message=KEEP_KEY_CONTEXT', ['SYNTH_SPACED_KEY'], 'KEEP_KEY_CONTEXT'],
      ['access_token  : SYNTH_SPACED_TOKEN status=KEEP_TOKEN_CONTEXT', ['SYNTH_SPACED_TOKEN'], 'KEEP_TOKEN_CONTEXT'],
      ['Authorization \t= Basic SYNTH_UNQUOTED_BASIC message=KEEP_BASIC_CONTEXT', ['SYNTH_UNQUOTED_BASIC'], 'KEEP_BASIC_CONTEXT'],
      ['Authorization  : Bearer SYNTH_UNQUOTED_BEAR detail=KEEP_BEAR_CONTEXT', ['SYNTH_UNQUOTED_BEAR'], 'KEEP_BEAR_CONTEXT'],
      ['message=KEEP_LITERAL OPENAI_API_KEY \t= SYNTH_AFTER_LITERAL', ['SYNTH_AFTER_LITERAL'], 'KEEP_LITERAL'],
      ['status=KEEP_LITERAL Authorization = Basic SYNTH_AFTER_STATUS', ['SYNTH_AFTER_STATUS'], 'KEEP_LITERAL'],
    ] as const;
    for (const [index, [raw, hidden, kept]] of cases.entries()) {
      const task = env.createTask({ ...TASK_PARAMS, id: `review_shared_field_token_${index}` });
      const runId = `run-shared-field-token-${index}`;
      const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T09:0${index}:00.000Z`, nextRunAt: '2026-09-30T09:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const persisted = env.getTask(task.id)!;
      const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
      for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
        for (const fragment of hidden) expect(error).not.toContain(fragment);
        expect(error).toContain(kept);
      }
    }
  });

  it('review RED P1: unquoted Authorization padding and every credential family consume one field-token boundary', async () => {
    const env = await freshEnv();
    const cases = [
      ['Authorization=Basic SYNTH_PAD_BASIC= OPENAI_API_KEY=SYNTH_AFTER_BASIC message=KEEP_BASIC_CONTEXT', ['SYNTH_PAD_BASIC=', 'SYNTH_AFTER_BASIC'], 'KEEP_BASIC_CONTEXT'],
      ['Authorization=Bearer SYNTH_PAD_BEAR= DB_PASSWORD=SYNTH_AFTER_BEAR status=KEEP_BEAR_CONTEXT', ['SYNTH_PAD_BEAR=', 'SYNTH_AFTER_BEAR'], 'KEEP_BEAR_CONTEXT'],
      ['message=KEEP_LITERAL access_token \t= SYNTH_AFTER_ACCESS client_secret = SYNTH_AFTER_CLIENT', ['SYNTH_AFTER_ACCESS', 'SYNTH_AFTER_CLIENT'], 'KEEP_LITERAL'],
      ['detail=KEEP_LITERAL GITHUB_TOKEN = SYNTH_AFTER_GITHUB AWS_SECRET_ACCESS_KEY\t=SYNTH_AFTER_AWS', ['SYNTH_AFTER_GITHUB', 'SYNTH_AFTER_AWS'], 'KEEP_LITERAL'],
    ] as const;
    for (const [index, [raw, hidden, kept]] of cases.entries()) {
      const task = env.createTask({ ...TASK_PARAMS, id: `review_padding_shared_token_${index}` });
      const runId = `run-padding-shared-token-${index}`;
      const turnId = `schedule:${task.id}:${crypto.randomUUID()}`;
      expect(env.claimRun(task.id, { lastRunAt: `2026-09-29T10:0${index}:00.000Z`, nextRunAt: '2026-09-30T10:00:00.000Z', lastRunId: runId }).ok).toBe(true);
      expect(env.owner.bindDispatch(turnId, runId)).toBe(true);
      expect(env.owner.settle(turnId, 'failed', raw)).toBe(true);
      const persisted = env.getTask(task.id)!;
      const perTarget = persisted.runRecords?.[runId]?.perTargetErrors?.[turnId] ?? '';
      for (const error of [persisted.lastTerminalError ?? '', perTarget]) {
        for (const fragment of hidden) expect(error).not.toContain(fragment);
        expect(error).toContain(kept);
      }
    }
  });
});
