import { join } from 'node:path';
import type { V3WriteExecutionBinding } from '../workflows/v3/dag.js';
import { readV3RunChatBinding, safeRunDir } from '../workflows/v3/daemon-run.js';
import { readWait } from '../workflows/v3/gate-wait-store.js';
import { canResolveGateWait, normalizeGateWaitInput, selectedResolution } from '../workflows/v3/gate-policy.js';
import { readJournal } from '../workflows/v3/journal.js';
import { loadAuthorizedV3Run } from '../workflows/v3/run-envelope.js';
import { materialize } from '../workflows/v3/state.js';
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

function sameWriteExecution(
  left: V3WriteExecutionBinding | undefined,
  right: V3WriteExecutionBinding,
): boolean {
  return !!left
    && left.grantRef === right.grantRef
    && left.projectId === right.projectId
    && left.phaseId === right.phaseId
    && left.taskGuid === right.taskGuid
    && left.candidate === right.candidate
    && left.action === right.action
    && left.attempt === right.attempt
    && left.operatorId === right.operatorId;
}

function sameGateEvent(
  event: { nodeId: string; instanceId?: string; waitId: string },
  gate: TaskControlApprovalGateBinding,
): boolean {
  return event.nodeId === gate.nodeId
    && event.instanceId === gate.instanceId
    && event.waitId === gate.waitId;
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
          || wait.writeExecution
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
        if (!Number.isFinite(now) || now < approvedAtMs || now >= expiresAtMs) return undefined;
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
    getWriteExecution(request) {
      const { larkAppId, gate } = request;
      const expected: V3WriteExecutionBinding = {
        grantRef: request.grantRef,
        projectId: request.projectId,
        phaseId: request.phaseId,
        taskGuid: request.taskGuid,
        candidate: request.candidate,
        action: request.action,
        attempt: request.attempt,
        operatorId: request.operatorId,
      };
      try {
        const runDir = safeRunDir(input.baseDir, gate.runId);
        const binding = readV3RunChatBinding(runDir);
        if (!binding || binding.larkAppId !== larkAppId || binding.ownerOpenId !== request.operatorId
          || gate.operatorId !== request.operatorId) return undefined;

        const dag = loadAuthorizedV3Run(runDir, { expectedRunId: gate.runId }).dag;
        const node = dag.nodes.find(candidate => candidate.id === gate.nodeId);
        if (!node?.humanGate || !sameWriteExecution(node.humanGate.writeExecution, expected)) return undefined;
        const authored = normalizeGateWaitInput(node.humanGate);

        const wait = readWait(runDir, gate.waitId);
        if (!wait
          || wait.status !== 'approved'
          || wait.nodeId !== gate.nodeId
          || wait.instanceId !== gate.instanceId
          || wait.by !== request.operatorId
          || !Number.isFinite(wait.resolvedAt)
          || wait.prompt !== authored.prompt
          || JSON.stringify(wait.options) !== JSON.stringify(authored.options)
          || JSON.stringify(wait.approveOptions) !== JSON.stringify(authored.approveOptions)
          || !sameStrings(wait.approvers, authored.approvers)
          || !sameStrings(wait.approvers, gate.approverPolicy)
          || !canResolveGateWait(wait, request.operatorId)
          || selectedResolution(wait, wait.selected ?? '') !== 'approved'
          || !sameWriteExecution(wait.writeExecution, expected)) return undefined;

        const journal = readJournal(join(runDir, 'journal.ndjson'));
        const dispatches = journal
          .map((event, index) => ({ event, index }))
          .filter(({ event }) => event.type === 'gateDispatched' && event.waitId === gate.waitId);
        const dispatched = dispatches[0];
        const resolutions = !dispatched ? [] : journal.slice(dispatched.index + 1)
          .filter(event => event.type === 'gateResolved' && event.waitId === gate.waitId);
        const resolution = resolutions[0];
        const snapshot = materialize(journal);
        const nodeState = snapshot.nodes.get(gate.nodeId);
        const instanceState = snapshot.instances.get(gate.instanceId);
        if (!resolution
          || resolution.type !== 'gateResolved'
          || dispatches.length !== 1
          || dispatched!.event.type !== 'gateDispatched'
          || !sameGateEvent(dispatched!.event, gate)
          || !sameWriteExecution(dispatched!.event.writeExecution, expected)
          || resolutions.length !== 1
          || !sameGateEvent(resolution, gate)
          || resolution.resolution !== 'approved'
          || resolution.by !== request.operatorId
          || resolution.selected !== wait.selected
          || !sameWriteExecution(resolution.writeExecution, expected)
          || (snapshot.runStatus !== 'running' && snapshot.runStatus !== 'succeeded')
          || nodeState?.effectiveInstanceId !== gate.instanceId
          || !nodeState.gateCleared
          || !instanceState?.gateCleared
          || !['pending', 'running', 'done'].includes(nodeState.status)
          || !['pending', 'running', 'done'].includes(instanceState.status)) return undefined;

        const issuedAtMs = wait.resolvedAt!;
        const expiresAtMs = issuedAtMs + TASK_CONTROL_GATE_TTL_MS;
        const now = input.now?.() ?? Date.now();
        if (!Number.isFinite(now) || now < issuedAtMs || now >= expiresAtMs) return undefined;
        return {
          issuedAt: new Date(issuedAtMs).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        };
      } catch {
        return undefined;
      }
    },
  };
}
