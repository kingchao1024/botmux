import {
  PROJECT_COMPLETION_GATE_REFRESH_WINDOW_MS,
  PROJECT_COMPLETION_GATE_VALIDITY_MS,
  type ProjectCompletionGate,
  type ProjectGroupState,
} from './project-group-store.js';
import type {
  DeliveryReceipt,
  TaskProjection,
} from './task-control-plane-store.js';
import {
  auditProjectGroupTaskControl,
  type ProjectGroupTaskControlAuditReader,
} from './task-control-plane-project-group-audit.js';

export interface ProjectCompletionGateReader extends ProjectGroupTaskControlAuditReader {
  getTaskProjection(taskGuid: string, checkedAt?: string): TaskProjection;
  listReceipts(eventId?: string): DeliveryReceipt[];
}

export interface ProjectCompletionGateEvaluation {
  gateId: string;
  definitionFingerprint: string;
  status: ProjectCompletionGate['status'];
  reason: string;
  checkedAt: string;
  validUntil?: string;
  evidence?: ProjectCompletionGate['evidence'];
}

export function evaluateProjectCompletionGate(input: {
  parentLarkAppId: string;
  gate: ProjectCompletionGate;
  sourceProject: ProjectGroupState | undefined;
  reader: ProjectCompletionGateReader;
  checkedAt: string;
  staleExecutionMs: number;
}): ProjectCompletionGateEvaluation {
  const result = (
    status: ProjectCompletionGate['status'],
    reason: string,
    evidence?: ProjectCompletionGate['evidence'],
  ): ProjectCompletionGateEvaluation => ({
    gateId: input.gate.gateId,
    definitionFingerprint: input.gate.definitionFingerprint,
    status,
    reason,
    checkedAt: input.checkedAt,
    ...(status === 'satisfied'
      ? { validUntil: new Date(Date.parse(input.checkedAt) + PROJECT_COMPLETION_GATE_VALIDITY_MS).toISOString() }
      : {}),
    ...(evidence ? { evidence } : {}),
  });
  const project = input.sourceProject;
  const checkedAtMs = Date.parse(input.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return result('pending', 'checked_at_invalid');
  if (!project) return result('pending', 'source_project_missing');
  if (project.chatId !== input.gate.sourceChatId || project.larkAppId !== input.parentLarkAppId) {
    return result('pending', 'source_project_identity_mismatch');
  }
  const workstream = project.workstreams.find(item => item.dispatchRoot === input.gate.dispatchRoot);
  if (!workstream) return result('pending', 'source_workstream_missing');
  if (workstream.taskControl?.taskGuid !== input.gate.taskGuid) {
    return result('pending', 'source_task_guid_mismatch');
  }
  if (workstream.status === 'failed' || workstream.status === 'blocked') {
    return result('blocked', `source_workstream_${workstream.status}`);
  }
  if (workstream.status !== 'completed' || workstream.progress !== 100) {
    return result('pending', 'source_workstream_incomplete');
  }
  if (!workstream.delivery || !workstream.review || workstream.review.verdict !== 'pass'
    || workstream.delivery.round !== workstream.review.round) {
    return result('pending', 'source_review_incomplete');
  }

  try {
    const audit = auditProjectGroupTaskControl({
      project, reader: input.reader, now: checkedAtMs, staleExecutionMs: input.staleExecutionMs,
    });
    const diff = audit.diffs.find(item => item.dispatchRoot === input.gate.dispatchRoot);
    if (diff) return result('pending', `audit_${diff.code}`);

    const task = input.reader.getTaskProjection(input.gate.taskGuid, input.checkedAt);
    if (task.state !== 'task_done_pending_freeze' || !task.explicitlyAccepted) {
      return result('pending', 'task_not_ready');
    }
    const review = task.independentReview;
    if (!review || !review.independent || review.verdict !== 'pass' || !review.reviewerVerdictId
      || review.reviewRound !== workstream.review.round
      || review.reviewerId !== workstream.review.reviewerAppId
      || task.reviewerVerdictIssue || task.unresolvedReviewConditionIds.length > 0) {
      return result('pending', 'reviewer_verdict_unverified');
    }
    const terminal = task.terminalBody;
    if (!terminal || !task.doneEvent) return result('pending', 'terminal_missing');
    const artifact = terminal.artifactEvidence;
    if (artifact?.kind !== 'project_report' || artifact.dispatchRoot !== input.gate.dispatchRoot
      || !artifact.targetSessionId
      || JSON.stringify(review.artifactEvidence ?? null) !== JSON.stringify(artifact)) {
      return result('pending', 'terminal_artifact_unverified');
    }
    const eventTypes = new Set(input.reader.listEvents({ taskGuid: input.gate.taskGuid }).map(event => event.eventType));
    for (const required of [
      'task.accepted', 'task.execution_started', 'task.first_submitted',
      'task.reviewed', 'task.delivered', 'task.done_marked',
    ] as const) {
      if (!eventTypes.has(required)) return result('pending', `event_missing:${required}`);
    }
    const expectedDestination = `project-session:${artifact.targetSessionId}`;
    const deliveredOutbox = input.reader.listOutbox({ eventId: terminal.eventId })
      .find(row => row.status === 'delivered' && row.destinationId === expectedDestination);
    if (!deliveredOutbox) return result('pending', 'terminal_outbox_not_delivered');
    const receipt = input.reader.listReceipts(terminal.eventId)
      .find(item => item.outboxId === deliveredOutbox.outboxId
        && item.destinationId === deliveredOutbox.destinationId
        && item.state === 'delivered');
    if (!receipt) return result('pending', 'delivery_receipt_missing');
    return result('satisfied', 'verified', {
      sourceProjectRevision: project.revision,
      reviewerVerdictId: review.reviewerVerdictId,
      terminalEventId: terminal.eventId,
      deliveryReceiptId: receipt.receiptId,
    });
  } catch {
    return result('pending', 'verification_unavailable');
  }
}

export async function syncProjectCompletionGates(input: {
  projects: readonly ProjectGroupState[];
  larkAppId: string;
  reader: ProjectCompletionGateReader;
  checkedAt: string;
  staleExecutionMs: number;
  apply(parent: ProjectGroupState, evaluation: ProjectCompletionGateEvaluation): Promise<void>;
}): Promise<number> {
  const projectsByChat = new Map(input.projects.map(project => [project.chatId, project]));
  let synced = 0;
  for (const parent of input.projects) {
    if (parent.larkAppId !== input.larkAppId || parent.status !== 'active') continue;
    for (const gate of parent.completionGates ?? []) {
      if (gate.retirement) continue;
      const evaluation = evaluateProjectCompletionGate({
        parentLarkAppId: input.larkAppId,
        gate,
        sourceProject: projectsByChat.get(gate.sourceChatId),
        reader: input.reader,
        checkedAt: input.checkedAt,
        staleExecutionMs: input.staleExecutionMs,
      });
      const unchanged = gate.status === evaluation.status
        && gate.reason === evaluation.reason
        && JSON.stringify(gate.evidence ?? null) === JSON.stringify(evaluation.evidence ?? null);
      const validUntil = gate.validUntil ? Date.parse(gate.validUntil) : Number.NaN;
      const checkedAt = Date.parse(input.checkedAt);
      const needsValidityRefresh = gate.status === 'satisfied'
        && (!Number.isFinite(validUntil)
          || validUntil - checkedAt <= PROJECT_COMPLETION_GATE_REFRESH_WINDOW_MS);
      if (unchanged && !needsValidityRefresh) continue;
      await input.apply(parent, evaluation);
      synced += 1;
    }
  }
  return synced;
}
