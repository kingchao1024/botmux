import { parseScheduledTurnId } from '../core/scheduled-turn-provenance.js';
import {
  bindRunTurnId,
  abandonRecoveryAttempt,
  claimRecoveryAttempt,
  getTask,
  releaseRecoveryAttempt,
  setScheduleStoreTaskRemovedHook,
  settleTerminalRun,
} from './schedule-store.js';

export type ScheduleTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'ambiguous';

/** One daemon's complete schedule binding lifecycle. */
export class ScheduleTurnBindingOwner {
  private readonly transient = new Map<string, string>();
  private readonly durable = new Map<string, string>();
  private readonly taskRuns = new Map<string, string>();
  private readonly recoverySources = new Map<string, string>();
  private readonly settledRecoverySources = new Map<string, { runId: string; sourceTurnId: string }>();

  beginRun(taskId: string, runId: string): void {
    this.taskRuns.set(taskId, runId);
  }

  bindDispatch(turnId: string, runId: string): boolean {
    const taskId = parseScheduledTurnId(turnId);
    if (!taskId) return false;
    if (!bindRunTurnId(taskId, turnId, runId)) return false;
    this.transient.set(turnId, runId);
    this.durable.set(turnId, runId);
    return true;
  }

  /** Process restart drops only in-memory state; bindings restore on demand. */
  restore(): void {
    this.transient.clear();
    this.durable.clear();
    this.taskRuns.clear();
    this.recoverySources.clear();
  }

  /** Start exactly one recovery continuation for an active failed source. */
  bindRecovery(turnId: string, sourceTurnId: string): boolean {
    const taskId = parseScheduledTurnId(sourceTurnId);
    if (!taskId || parseScheduledTurnId(turnId) !== taskId) return false;
    const task = getTask(taskId);
    const runId = this.durable.get(sourceTurnId) ?? this.persistedRunId(task, sourceTurnId);
    if (!runId || task?.runRecords?.[runId]?.turnBindings?.[sourceTurnId] !== runId) return false;
    if (!claimRecoveryAttempt(taskId, runId, sourceTurnId, turnId)) return false;
    this.transient.set(turnId, runId);
    this.durable.set(turnId, runId);
    this.recoverySources.set(turnId, sourceTurnId);
    return true;
  }

  /** Compatibility seam while callers migrate to bindRecovery(). */
  recordRecoverySource(turnId: string, sourceTurnId: string): void {
    const taskId = parseScheduledTurnId(sourceTurnId);
    const runId = this.transient.get(turnId);
    if (taskId && runId && claimRecoveryAttempt(taskId, runId, sourceTurnId, turnId)) {
      this.recoverySources.set(turnId, sourceTurnId);
    }
  }

  /** Roll back only a recovery attempt that never reached the worker. */
  releaseRecovery(turnId: string): void {
    const settled = this.settledRecoverySources.get(turnId);
    const runId = this.transient.get(turnId) ?? settled?.runId;
    const sourceTurnId = this.recoverySources.get(turnId) ?? settled?.sourceTurnId;
    if (!runId || !sourceTurnId) return;
    const taskId = parseScheduledTurnId(turnId);
    if (taskId) releaseRecoveryAttempt(taskId, runId, sourceTurnId, turnId);
    this.transient.delete(turnId);
    this.durable.delete(turnId);
    this.recoverySources.delete(turnId);
    this.settledRecoverySources.delete(turnId);
  }

  abandonRecovery(turnId: string, logicalSourceTurnId?: string): void {
    const settled = this.settledRecoverySources.get(turnId);
    let runId = this.transient.get(turnId) ?? settled?.runId;
    const sourceTurnId = logicalSourceTurnId ?? this.recoverySources.get(turnId) ?? settled?.sourceTurnId;
    const taskId = parseScheduledTurnId(turnId);
    if (!sourceTurnId || !taskId) return;
    if (!runId) runId = this.persistedRunId(getTask(taskId), sourceTurnId);
    if (!runId) return;
    if (abandonRecoveryAttempt(taskId, runId, sourceTurnId, turnId)) {
      this.transient.delete(turnId); this.durable.delete(turnId);
      this.durable.delete(sourceTurnId); this.recoverySources.delete(turnId); this.settledRecoverySources.delete(turnId);
    }
  }

  settle(turnId: string, status: ScheduleTerminalStatus, errorCode?: string): boolean {
    const taskId = parseScheduledTurnId(turnId);
    if (!taskId) return false;
    let runId = this.transient.get(turnId);
    let sourceTurnId = this.recoverySources.get(turnId);
    if (!runId) {
      const task = getTask(taskId);
      for (const [candidateRunId, record] of Object.entries(task?.runRecords ?? {})) {
        const source = Object.entries(record.recoveryAttempts ?? {})
          .find(([, attempt]) => attempt === turnId)?.[0];
        if (record.turnBindings?.[turnId] !== candidateRunId) continue;
        runId = candidateRunId;
        sourceTurnId = source;
        this.transient.set(turnId, candidateRunId);
        this.durable.set(turnId, candidateRunId);
        if (source) this.recoverySources.set(turnId, source);
        break;
      }
    }
    if (!runId) return false;
    const success = status === 'completed';
    const accepted = settleTerminalRun(
      taskId, runId, success, success ? undefined : errorCode, turnId, sourceTurnId,
      sourceTurnId ? turnId : undefined, success && !sourceTurnId,
    );
    if (!accepted) return false;

    if (sourceTurnId && !success) this.settledRecoverySources.set(turnId, { runId, sourceTurnId });

    // Consume the exact terminal attempt. A failed original remains the sole
    // recovery source; a successful recovery consumes source + continuation.
    this.transient.delete(turnId);
    if (sourceTurnId || success) this.durable.delete(turnId);
    this.recoverySources.delete(turnId);
    if (sourceTurnId && success) {
      this.durable.delete(sourceTurnId);
    }
    return true;
  }

  /** Explicit deletion, not a new run, is the only task-wide release. */
  deleteTask(taskId: string): void {
    const prefix = `schedule:${taskId}:`;
    for (const map of [this.transient, this.durable, this.recoverySources]) {
      for (const turnId of map.keys()) if (turnId.startsWith(prefix)) map.delete(turnId);
    }
    for (const turnId of this.settledRecoverySources.keys()) if (turnId.startsWith(prefix)) this.settledRecoverySources.delete(turnId);
    this.taskRuns.delete(taskId);
  }

  hasTransient(turnId: string): boolean { return this.transient.has(turnId); }
  hasDurable(turnId: string): boolean { return this.durable.has(turnId); }
  runForTask(taskId: string): string | undefined { return this.taskRuns.get(taskId); }

  hasPersistedSourceBinding(turnId: string): boolean {
    const taskId = parseScheduledTurnId(turnId);
    const task = taskId ? getTask(taskId) : undefined;
    return Object.entries(task?.runRecords ?? {}).some(([runId, record]) =>
      record.turnBindings?.[turnId] === runId,
    );
  }

  private persistedRunId(task: ReturnType<typeof getTask>, turnId: string): string | undefined {
    for (const [runId, record] of Object.entries(task?.runRecords ?? {})) {
      if (record.turnBindings?.[turnId] === runId) return runId;
    }
    return undefined;
  }
}

let activeOwner: ScheduleTurnBindingOwner | undefined;
let legacyRecoveryBind: ((turnId: string, sourceTurnId: string) => string | undefined) | undefined;
let legacyRecoveryRelease: ((turnId: string) => void) | undefined;

export function setScheduleTurnBindingOwner(owner: ScheduleTurnBindingOwner | undefined): void {
  activeOwner = owner;
  setScheduleStoreTaskRemovedHook(owner ? taskId => owner.deleteTask(taskId) : undefined);
}

/** Worker-pool integration reaches the daemon-owned lifecycle, not callbacks. */
export function bindRecoveryTurn(turnId: string, sourceTurnId: string): boolean {
  const taskId = parseScheduledTurnId(sourceTurnId);
  if (!taskId) return true;
  if (parseScheduledTurnId(turnId) !== taskId) return false;
  if (activeOwner) {
    // A live task is scheduler-authoritative, including a missing source
    // binding. A deleted task or pruned archive has no terminal left to settle.
    if (!getTask(taskId)) return true;
    if (!activeOwner.bindRecovery(turnId, sourceTurnId)) return false;
    if (legacyRecoveryBind && legacyRecoveryBind(turnId, sourceTurnId) === undefined) {
      activeOwner.releaseRecovery(turnId);
      return false;
    }
    return true;
  }
  return legacyRecoveryBind?.(turnId, sourceTurnId) !== undefined || !legacyRecoveryBind;
}

export function releaseRecoveryTurn(turnId: string): void {
  legacyRecoveryRelease?.(turnId);
  activeOwner?.releaseRecovery(turnId);
}

export function abandonRecoveryTurn(turnId: string, logicalSourceTurnId?: string): void {
  activeOwner?.abandonRecovery(turnId, logicalSourceTurnId);
}

/** Transitional call shape retained while older schedule tests migrate. */
export function bindDispatchedTurn(bindings: Map<string, string>, turnId: string, runId: string): void {
  bindings.set(turnId, runId);
  activeOwner?.bindDispatch(turnId, runId);
}

export function settleScheduledTurn(
  _bindings: Map<string, string>,
  turnId: string,
  status: ScheduleTerminalStatus,
  errorCode?: string,
): boolean {
  return activeOwner?.settle(turnId, status, errorCode) ?? false;
}

export function cleanupTaskBindings(bindings: Map<string, string>, taskId: string): void {
  const prefix = `schedule:${taskId}:`;
  for (const turnId of bindings.keys()) if (turnId.startsWith(prefix)) bindings.delete(turnId);
  activeOwner?.deleteTask(taskId);
}

export function recordTaskRunId(_taskRuns: Map<string, string>, taskId: string, runId: string): void {
  activeOwner?.beginRun(taskId, runId);
}

export function lookupTaskRunId(_taskRuns: Map<string, string>, taskId: string): string | undefined {
  return activeOwner?.runForTask(taskId);
}

export function recordRecoverySource(_turnId: string, _sourceTurnId: string): void {
  activeOwner?.recordRecoverySource(_turnId, _sourceTurnId);
}

export function setRecoveryBindFn(
  bind: (turnId: string, sourceTurnId: string) => string | undefined,
  release?: (turnId: string) => void,
): void {
  legacyRecoveryBind = bind;
  legacyRecoveryRelease = release;
}
