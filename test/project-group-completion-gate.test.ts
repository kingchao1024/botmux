import { describe, expect, it } from 'vitest';
import {
  evaluateProjectCompletionGate,
  syncProjectCompletionGates,
} from '../src/services/project-group-completion-gate.js';
import {
  projectCompletionGateFingerprint,
  type ProjectCompletionGate,
  type ProjectGroupState,
} from '../src/services/project-group-store.js';

const now = '2026-09-29T12:00:00.000Z';
const taskGuid = '11111111-1111-4111-8111-111111111111';
const dispatchRoot = 'om_child';

function gate(): ProjectCompletionGate {
  const definition = {
    gateId: 'child-clean-canary', sourceChatId: 'oc_child', dispatchRoot, taskGuid,
  };
  return {
    ...definition,
    label: '子群 clean canary',
    definitionFingerprint: projectCompletionGateFingerprint(definition),
    status: 'pending', reason: 'not_evaluated', createdAt: now, updatedAt: now,
  };
}

function project(status: 'completed' | 'failed' = 'completed'): ProjectGroupState {
  return {
    schemaVersion: 3, revision: 7, chatId: 'oc_child', larkAppId: 'cli_controller', coordinatorSessionId: 'session-child',
    title: '子项目', goal: '完成 clean canary', phase: '验收', focus: '核验', status: 'active',
    blockers: [], blockerRecords: [], completionGates: [], dispatchReservations: [], milestones: [],
    workstreams: [{
      dispatchRoot, title: 'clean canary', purpose: '验证', owners: [], status,
      progress: status === 'completed' ? 100 : 0,
      workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'],
      access: { mode: 'write', scopes: ['/repo/canary'] },
      delivery: { reportedByAppId: 'cli_worker', content: '完成', reportedAt: now, round: 1 },
      review: { reviewerAppId: 'cli_reviewer', verdict: 'pass', content: 'PASS', reviewedAt: now, round: 1 },
      taskControl: {
        taskGuid, phaseId: `workstream:${taskGuid}`, mappingRef: `topic-message:${dispatchRoot}`,
        mappingStatus: 'registered', sourceKind: 'project_group', controllerAppId: 'cli_controller',
        workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor',
        projectRevision: 3, reservationId: 'reservation-1', coordinatorSessionId: 'session-child', originTurnId: 'turn-1',
        reservationCreatedAt: now, reservationExpiresAt: '2026-09-29T13:00:00.000Z', rootCreateTime: now,
        reservationProof: {
          schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_controller', issuedAt: now,
          keyId: 'tcpr1:key', signature: 'a'.repeat(64),
        },
      },
      createdAt: now, updatedAt: now,
    }],
    createdAt: now, updatedAt: now,
  };
}

function reader(options: { receipt?: boolean; destinationId?: string; artifact?: boolean } = {}) {
  const terminalEventId = 'evt-delivered';
  const destinationId = options.destinationId ?? 'project-session:session-child';
  const artifactEvidence = {
    kind: 'project_report' as const, reportRequestId: 'report:1', triggerId: 'trg-1', dispatchRoot,
    sourceSessionId: 'session-worker', sourceTurnId: 'turn-worker', reporterAppId: 'cli_reviewer',
    targetSessionId: 'session-child', projectRevision: 7, contentHash: `sha256:${'a'.repeat(64)}`,
  };
  const eventTypes = [
    'mapping.registered', 'task.dispatch_requested', 'task.accepted', 'task.execution_started',
    'task.first_submitted', 'task.reviewed', 'task.delivered', 'task.done_marked',
  ] as const;
  const events = eventTypes.map((eventType, index) => ({
    eventId: eventType === 'task.delivered' ? terminalEventId : `evt-${index}`,
    seq: index + 1, projectId: 'project-group:oc_child', phaseId: `workstream:${taskGuid}`,
    taskGuid, topicRootId: dispatchRoot, actorId: eventType === 'task.reviewed' ? 'cli_reviewer' : 'cli_controller',
    actorRole: eventType === 'task.reviewed' ? 'reviewer' : 'controller', eventType,
    payload: eventType === 'task.reviewed'
      ? { independent: true, verdict: 'pass', reviewRound: 1, reviewCommentId: 'om_review', reviewerVerdictId: 'rv_1' }
      : {},
    evidenceRef: eventType === 'task.reviewed' ? 'reviewer-verdict:rv_1' : undefined,
    idempotencyKey: `key-${index}`, terminal: eventType === 'task.delivered', occurredAt: now,
  }));
  return {
    listTrustedMappings: () => [{
      larkAppId: 'cli_controller', dispatchRoot, projectId: 'project-group:oc_child',
      phaseId: `workstream:${taskGuid}`, phaseTaskGuids: [taskGuid], taskGuid, topicRootId: dispatchRoot,
      ownerId: 'cli_worker', reviewerId: 'cli_reviewer', acceptorId: 'cli_acceptor', controllerId: 'cli_controller',
      registrationRef: `topic-message:${dispatchRoot}`, createdAt: now,
      mappingAuthority: {
        kind: 'project_group', chatId: 'oc_child', reservationId: 'reservation-1', projectRevision: 3,
        acceptorAppId: 'cli_acceptor', mode: 'audit_only',
      },
    }],
    getTaskProjection: () => ({
      taskGuid,
      mapping: { projectId: 'project-group:oc_child', phaseId: `workstream:${taskGuid}`, taskGuid, topicRootId: dispatchRoot, ownerId: 'cli_worker', eventId: 'evt-0', seq: 1 },
      state: 'task_done_pending_freeze', explicitlyAccepted: true, acceptedEventId: 'evt-2', acceptedActorId: 'cli_worker',
      terminalBody: {
        eventId: terminalEventId, seq: 7,
        ...(options.artifact === false ? {} : { artifactEvidence }),
      },
      independentReview: {
        eventId: 'evt-5', seq: 6, reviewRound: 1, reviewCommentId: 'om_review', reviewerId: 'cli_reviewer',
        independent: true, verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, reviewerVerdictId: 'rv_1',
        ...(options.artifact === false ? {} : { artifactEvidence }),
      },
      unresolvedReviewConditionIds: [], doneEvent: { eventId: 'evt-7', seq: 8 },
      unknowns: [], unresolvedConflictEventIds: [], transitionViolations: [],
    }),
    listEvents: ({ taskGuid: filterTaskGuid }: { taskGuid?: string } = {}) => filterTaskGuid ? events.filter(event => event.taskGuid === filterTaskGuid) : events,
    listOutbox: ({ eventId }: { eventId?: string } = {}) => eventId === terminalEventId ? [{
      outboxId: 'out-1', eventId: terminalEventId, destinationId, status: 'delivered', attempts: 1,
      nextAttemptAt: 0, createdAt: now, updatedAt: now,
    }] : [],
    listReceipts: (eventId?: string) => options.receipt === false || eventId !== terminalEventId ? [] : [{
      receiptId: 'rcpt-1', outboxId: 'out-1', eventId: terminalEventId,
      destinationId, attempt: 1, state: 'delivered', createdAt: now,
    }],
  } as any;
}

describe('project group parent completion gate', () => {
  it('fails closed when the source project is unavailable', () => {
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject: undefined,
      reader: reader(), checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toMatchObject({ status: 'pending', reason: 'source_project_missing' });
  });

  it('keeps a failed source workstream blocked', () => {
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject: project('failed'),
      reader: reader(), checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toMatchObject({ status: 'blocked', reason: 'source_workstream_failed' });
  });

  it('requires the terminal delivered receipt', () => {
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject: project(),
      reader: reader({ receipt: false }), checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toMatchObject({ status: 'pending', reason: 'delivery_receipt_missing' });
  });

  it('rejects a terminal delivered to a different project session', () => {
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject: project(),
      reader: reader({ destinationId: 'project-session:other' }), checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toMatchObject({ status: 'pending', reason: 'terminal_outbox_not_delivered' });
  });

  it('keeps the immutable workstream coordinator destination after the chat session is recreated', () => {
    const sourceProject = project();
    sourceProject.coordinatorSessionId = 'session-recreated';
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject,
      reader: reader(), checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toMatchObject({ status: 'satisfied', reason: 'verified' });
  });

  it('requires the terminal to carry exact project-report evidence', () => {
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject: project(),
      reader: reader({ artifact: false }), checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toMatchObject({ status: 'pending', reason: 'terminal_artifact_unverified' });
  });

  it('rejects identity, task and reviewer drift before satisfying a gate', () => {
    const wrongController = project();
    wrongController.larkAppId = 'cli_other';
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject: wrongController,
      reader: reader(), checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toMatchObject({ status: 'pending', reason: 'source_project_identity_mismatch' });

    const wrongTask = project();
    wrongTask.workstreams[0]!.taskControl!.taskGuid = '22222222-2222-4222-8222-222222222222';
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject: wrongTask,
      reader: reader(), checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toMatchObject({ status: 'pending', reason: 'source_task_guid_mismatch' });

    const baseReader = reader();
    const projected = baseReader.getTaskProjection(taskGuid);
    const reviewerDrift = {
      ...baseReader,
      getTaskProjection: () => ({
        ...projected,
        independentReview: { ...projected.independentReview!, reviewRound: 2 },
      }),
    };
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject: project(),
      reader: reviewerDrift, checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toMatchObject({ status: 'pending', reason: 'reviewer_verdict_unverified' });
  });

  it('satisfies only the exact clean TaskControl workstream', () => {
    expect(evaluateProjectCompletionGate({
      parentLarkAppId: 'cli_controller', gate: gate(), sourceProject: project(),
      reader: reader(), checkedAt: now, staleExecutionMs: 30 * 60_000,
    })).toEqual(expect.objectContaining({
      gateId: 'child-clean-canary', definitionFingerprint: gate().definitionFingerprint,
      status: 'satisfied', reason: 'verified', checkedAt: now,
      evidence: {
        sourceProjectRevision: 7,
        reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered',
        deliveryReceiptId: 'rcpt-1',
      },
    }));
  });

  it('syncs every declared gate for the owning controller across project chats', async () => {
    const parent = project();
    parent.chatId = 'oc_parent';
    parent.completionGates = [gate()];
    const unrelated = project();
    unrelated.chatId = 'oc_unrelated';
    unrelated.larkAppId = 'cli_other';
    unrelated.completionGates = [{ ...gate(), gateId: 'foreign-gate' }];
    const applied: Array<{ chatId: string; status: string; reason: string }> = [];

    await expect(syncProjectCompletionGates({
      projects: [parent, project(), unrelated], larkAppId: 'cli_controller', reader: reader(),
      checkedAt: now, staleExecutionMs: 30 * 60_000,
      apply: async (target, evaluation) => {
        applied.push({ chatId: target.chatId, status: evaluation.status, reason: evaluation.reason });
      },
    })).resolves.toBe(1);
    expect(applied).toEqual([{ chatId: 'oc_parent', status: 'satisfied', reason: 'verified' }]);
  });

  it('does not rewrite an unchanged gate only to refresh checkedAt', async () => {
    const parent = project();
    parent.chatId = 'oc_parent';
    parent.completionGates = [{
      ...gate(), status: 'satisfied', reason: 'verified', checkedAt: '2026-09-29T11:59:50.000Z',
      validUntil: '2026-09-29T12:04:50.000Z',
      evidence: {
        sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    }];
    const applied: unknown[] = [];
    await expect(syncProjectCompletionGates({
      projects: [parent, project()], larkAppId: 'cli_controller', reader: reader(),
      checkedAt: now, staleExecutionMs: 30 * 60_000,
      apply: async (_target, evaluation) => { applied.push(evaluation); },
    })).resolves.toBe(0);
    expect(applied).toEqual([]);
  });

  it('does not evaluate or sync retired gates', async () => {
    const parent = project();
    parent.chatId = 'oc_parent';
    parent.completionGates = [{
      ...gate(),
      retirement: {
        retiredAt: '2026-09-29T11:59:00.000Z',
        retiredBySessionId: 'session-parent',
        authorizationRef: 'om_authorization',
        authorizedByOpenId: 'ou_authorizer',
        reason: '由新一轮验收替代',
      },
    }];
    const applied: unknown[] = [];
    await expect(syncProjectCompletionGates({
      projects: [parent, project()], larkAppId: 'cli_controller', reader: reader(),
      checkedAt: now, staleExecutionMs: 30 * 60_000,
      apply: async (_target, evaluation) => { applied.push(evaluation); },
    })).resolves.toBe(0);
    expect(applied).toEqual([]);
  });
});
