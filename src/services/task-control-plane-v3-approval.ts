import { join } from 'node:path';
import { readV3RunChatBinding, safeRunDir } from '../workflows/v3/daemon-run.js';
import { readWait } from '../workflows/v3/gate-wait-store.js';
import { canResolveGateWait, selectedResolution } from '../workflows/v3/gate-policy.js';
import { readJournal } from '../workflows/v3/journal.js';
import type { VerifiedTaskControlGateResolution } from './task-control-plane-authority.js';
import type {
  DaemonTaskControlApprovalSource,
  TaskControlApprovalGateBinding,
  TaskControlApprovalGateRegistration,
} from './task-control-plane-daemon-bridge.js';

/** Short-lived proof derived only from an already durable v3 humanGate. */
export const TASK_CONTROL_GATE_TTL_MS = 15 * 60 * 1_000;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

/**
 * Converts v3's daemon-owned wait+journal truth into control-plane source
 * material. It deliberately reads every source fresh: mutable wait files are
 * only valid when their corresponding journal evidence, immutable run binding,
 * exact node instance, resolver and authored approver policy agree.
 */
export function createV3TaskControlApprovalSource(input: {
  baseDir: string;
  now?: () => number;
}): DaemonTaskControlApprovalSource {
  return {
    validateBinding(request: { larkAppId: string; gate: TaskControlApprovalGateRegistration }): boolean {
      const { larkAppId, gate } = request;
      try {
        const runDir = safeRunDir(input.baseDir, gate.runId);
        const binding = readV3RunChatBinding(runDir);
        if (!binding || binding.larkAppId !== larkAppId || binding.ownerOpenId !== gate.operatorId) return false;
        const wait = readWait(runDir, gate.waitId);
        if (!wait
          || wait.nodeId !== gate.nodeId
          || wait.instanceId !== gate.instanceId
          || !sameStrings(wait.approvers, gate.approverPolicy)
          || !canResolveGateWait(wait, gate.operatorId)) return false;
        const journal = readJournal(join(runDir, 'journal.ndjson'));
        return journal.some(event => event.type === 'gateDispatched'
          && event.nodeId === gate.nodeId
          && event.instanceId === gate.instanceId
          && event.waitId === gate.waitId);
      } catch {
        return false;
      }
    },
    get(request) {
      const { approvalRef, larkAppId, gate } = request;
      try {
        const runDir = safeRunDir(input.baseDir, gate.runId);
        const binding = readV3RunChatBinding(runDir);
        if (!binding || binding.larkAppId !== larkAppId || binding.ownerOpenId !== gate.operatorId) return undefined;
        const wait = readWait(runDir, gate.waitId);
        if (!wait
          || wait.status !== 'approved'
          || wait.nodeId !== gate.nodeId
          || wait.instanceId !== gate.instanceId
          || wait.by !== gate.operatorId
          || !Number.isFinite(wait.resolvedAt)
          || !sameStrings(wait.approvers, gate.approverPolicy)
          || !canResolveGateWait(wait, gate.operatorId)
          || selectedResolution(wait, wait.selected ?? '') !== 'approved') return undefined;

        const journal = readJournal(join(runDir, 'journal.ndjson'));
        const dispatched = journal.some(event => event.type === 'gateDispatched'
          && event.nodeId === gate.nodeId
          && event.instanceId === gate.instanceId
          && event.waitId === gate.waitId);
        const resolved = journal.some(event => event.type === 'gateResolved'
          && event.nodeId === gate.nodeId
          && event.instanceId === gate.instanceId
          && event.waitId === gate.waitId
          && event.resolution === 'approved'
          && event.by === gate.operatorId
          && event.selected === wait.selected);
        if (!dispatched || !resolved) return undefined;

        const approvedAtMs = wait.resolvedAt!;
        const expiresAtMs = approvedAtMs + TASK_CONTROL_GATE_TTL_MS;
        const now = input.now?.() ?? Date.now();
        if (!Number.isFinite(now) || now >= expiresAtMs) return undefined;
        return {
          runId: gate.runId, nodeId: gate.nodeId, instanceId: gate.instanceId, waitId: gate.waitId,
          operatorId: gate.operatorId,
          approvedAt: new Date(approvedAtMs).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        };
      } catch {
        return undefined;
      }
    },
  };
}
