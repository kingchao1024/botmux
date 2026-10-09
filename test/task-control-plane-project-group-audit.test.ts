import { describe, expect, it } from 'vitest';
import {
  auditProjectGroupTaskControl,
  planProjectGroupTaskControlReconciliation,
} from '../src/services/task-control-plane-project-group-audit.js';

const now = Date.parse('2026-09-29T02:00:00.000Z');

function project() {
  return {
    schemaVersion: 3 as const,
    revision: 1,
    chatId: 'oc_project',
    larkAppId: 'cli_controller',
    coordinatorSessionId: 'session-controller',
    title: '项目', goal: '闭环', phase: '执行', focus: '验证', status: 'active' as const,
    blockers: [], blockerRecords: [], milestones: [], createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
    workstreams: [
      {
        dispatchRoot: 'om_legacy', title: '旧任务', purpose: '旧任务', owners: [], status: 'in_progress' as const,
        progress: 20, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
      },
      {
        dispatchRoot: 'om_mapped', title: '新任务', purpose: '新任务', owners: [], status: 'completed' as const,
        progress: 100, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
        taskControl: {
          taskGuid: 'task-1', phaseId: 'workstream:task-1', mappingRef: 'topic-message:om_mapped', mappingStatus: 'registered' as const,
          sourceKind: 'project_group' as const, controllerAppId: 'cli_controller', workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer',
          acceptorAppId: 'cli_acceptor', projectRevision: 1, reservationId: 'reservation-1',
          coordinatorSessionId: 'session-controller', originTurnId: 'turn-1',
          reservationCreatedAt: '2026-09-29T00:00:00.000Z', reservationExpiresAt: '2026-09-29T01:00:00.000Z',
          rootCreateTime: '2026-09-29T00:00:01.000Z',
          reservationProof: { schemaVersion: 'ProjectDispatchReservationProof.v1' as const, larkAppId: 'cli_controller', issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64) },
        },
      },
    ],
  };
}

describe('project-group TaskControl audit projector', () => {
  it('reports legacy, mismatched, unknown, missing receipt, stale and control-only facts without mutating project state', () => {
    const input = project();
    const before = structuredClone(input);
    const result = auditProjectGroupTaskControl({
      project: input,
      now,
      staleExecutionMs: 30 * 60_000,
      reader: {
        listTrustedMappings: () => [
          {
            larkAppId: 'cli_controller', dispatchRoot: 'om_mapped', projectId: 'project-group:oc_project',
            phaseId: 'workstream:task-1', phaseTaskGuids: ['task-1'], taskGuid: 'task-1', topicRootId: 'om_mapped',
            ownerId: 'cli_worker', reviewerId: 'cli_reviewer', acceptorId: 'cli_acceptor', controllerId: 'cli_controller',
            registrationRef: 'topic-message:om_mapped', createdAt: '2026-09-29T00:00:01.000Z',
            mappingAuthority: {
              kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 1,
              acceptorAppId: 'cli_acceptor', mode: 'audit_only',
            },
          },
          {
            larkAppId: 'cli_controller', dispatchRoot: 'om_controlonly', projectId: 'project-group:oc_project',
            phaseId: 'workstream:task-2', phaseTaskGuids: ['task-2'], taskGuid: 'task-2', topicRootId: 'om_controlonly',
            ownerId: 'cli_worker', reviewerId: 'cli_reviewer', acceptorId: 'cli_acceptor', controllerId: 'cli_controller',
            registrationRef: 'topic-message:om_controlonly', createdAt: '2026-09-29T00:00:01.000Z',
            mappingAuthority: {
              kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-2', projectRevision: 1,
              acceptorAppId: 'cli_acceptor', mode: 'audit_only',
            },
          },
          {
            larkAppId: 'cli_controller', dispatchRoot: 'om_other_chat', projectId: 'project-group:oc_other',
            phaseId: 'workstream:task-3', phaseTaskGuids: ['task-3'], taskGuid: 'task-3', topicRootId: 'om_other_chat',
            ownerId: 'cli_worker', reviewerId: 'cli_reviewer', acceptorId: 'cli_acceptor', controllerId: 'cli_controller',
            registrationRef: 'topic-message:om_other_chat', createdAt: '2026-09-29T00:00:01.000Z',
            mappingAuthority: {
              kind: 'project_group', chatId: 'oc_other', reservationId: 'reservation-3', projectRevision: 1,
              acceptorAppId: 'cli_acceptor', mode: 'audit_only',
            },
          },
        ] as any,
        getTaskProjection: () => ({
          taskGuid: 'task-1', state: 'executing', explicitlyAccepted: true,
          unknowns: [{ key: 'terminal', required: true, declared: false, resolved: false }],
          unresolvedConflictEventIds: [], transitionViolations: [],
          terminalBody: { eventId: 'evt-terminal', seq: 4, docToken: 'doc', docRevision: 1 },
        } as any),
        listEvents: () => [{ eventId: 'evt-exec', eventType: 'task.execution_started', occurredAt: '2026-09-29T00:00:00.000Z' }] as any,
        listOutbox: () => [],
      },
    });

    expect(result.diffs.map(item => item.code)).toEqual([
      'legacy_only', 'state_mismatch', 'unresolved_unknown', 'terminal_without_receipt',
      'stale_execution_without_terminal', 'task_control_only',
    ]);
    expect(input).toEqual(before);
  });

  it('reports a pending project binding whose trusted mapping is absent', () => {
    const input = project();
    input.workstreams[1]!.taskControl!.mappingStatus = 'pending';
    expect(auditProjectGroupTaskControl({
      project: input, now, staleExecutionMs: 30 * 60_000,
      reader: {
        listTrustedMappings: () => [],
        getTaskProjection: () => ({ taskGuid: 'task-1', state: 'planned', explicitlyAccepted: false, unknowns: [], unresolvedConflictEventIds: [], transitionViolations: [] } as any),
        listEvents: () => [],
        listOutbox: () => [],
      },
    }).diffs).toEqual([
      expect.objectContaining({ code: 'legacy_only', dispatchRoot: 'om_legacy' }),
      expect.objectContaining({ code: 'missing_mapping', dispatchRoot: 'om_mapped', taskGuid: 'task-1' }),
    ]);
    expect(planProjectGroupTaskControlReconciliation({
      project: input, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
      reader: {
        listTrustedMappings: () => [],
        getTaskProjection: () => ({ taskGuid: 'task-1', state: 'planned', explicitlyAccepted: false, unknowns: [], unresolvedConflictEventIds: [], transitionViolations: [] } as any),
        listEvents: () => [], listOutbox: () => [],
      },
    }).actions).toEqual([{
      kind: 'recover_mapping', dispatchRoot: 'om_mapped', taskGuid: 'task-1',
    }]);
  });

  it('repairs only a pending binding backed by the exact trusted mapping', () => {
    const input = project();
    const binding = input.workstreams[1]!.taskControl!;
    binding.mappingStatus = 'pending';
    Object.assign(binding, {
      reservationId: 'reservation-1', coordinatorSessionId: 'session-controller', originTurnId: 'turn-1',
      reservationCreatedAt: '2026-09-29T00:00:00.000Z', reservationExpiresAt: '2026-09-29T01:00:00.000Z',
      rootCreateTime: '2026-09-29T00:00:01.000Z',
    });
    const exactMapping = {
      larkAppId: 'cli_controller', dispatchRoot: 'om_mapped', projectId: 'project-group:oc_project',
      phaseId: 'workstream:task-1', phaseTaskGuids: ['task-1'], taskGuid: 'task-1', topicRootId: 'om_mapped',
      ownerId: 'cli_worker', reviewerId: 'cli_reviewer', acceptorId: 'cli_acceptor', controllerId: 'cli_controller',
      registrationRef: 'topic-message:om_mapped', createdAt: '2026-09-29T00:00:01.000Z',
      mappingAuthority: {
        kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 1,
        acceptorAppId: 'cli_acceptor', mode: 'audit_only',
      },
    } as any;
    const reader = {
      listTrustedMappings: () => [exactMapping],
      getTaskProjection: () => ({ taskGuid: 'task-1', state: 'planned', explicitlyAccepted: false, unknowns: [], unresolvedConflictEventIds: [], transitionViolations: [] } as any),
      listEvents: () => [], listOutbox: () => [],
    };

    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
    }).actions).toEqual([{
      kind: 'mark_mapping_registered', dispatchRoot: 'om_mapped', taskGuid: 'task-1',
      mappingRef: 'topic-message:om_mapped',
    }]);

    binding.mappingStatus = 'registered';
    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
    }).actions).toEqual([{
      kind: 'dispatch_requested', dispatchRoot: 'om_mapped', taskGuid: 'task-1',
      sourceSessionId: 'session-controller', occurredAt: new Date(now).toISOString(),
    }]);

    exactMapping.mappingAuthority.projectRevision = 2;
    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
    }).actions).toEqual([]);
  });

  it('plans idempotent acceptance and execution timeout evidence from exact lifecycle events', () => {
    const input = project();
    const binding = input.workstreams[1]!.taskControl!;
    Object.assign(binding, {
      reservationId: 'reservation-1', coordinatorSessionId: 'session-controller', originTurnId: 'turn-1',
      reservationCreatedAt: '2026-09-29T00:00:00.000Z', reservationExpiresAt: '2026-09-29T01:00:00.000Z',
      rootCreateTime: '2026-09-29T00:00:01.000Z',
    });
    const mapping = {
      larkAppId: 'cli_controller', dispatchRoot: 'om_mapped', projectId: 'project-group:oc_project',
      phaseId: 'workstream:task-1', phaseTaskGuids: ['task-1'], taskGuid: 'task-1', topicRootId: 'om_mapped',
      ownerId: 'cli_worker', reviewerId: 'cli_reviewer', acceptorId: 'cli_acceptor', controllerId: 'cli_controller',
      registrationRef: 'topic-message:om_mapped', createdAt: '2026-09-29T00:00:01.000Z',
      mappingAuthority: {
        kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 1,
        acceptorAppId: 'cli_acceptor', mode: 'audit_only',
      },
    } as any;
    const reader = {
      listTrustedMappings: () => [mapping],
      getTaskProjection: () => ({ taskGuid: 'task-1', state: 'planned', explicitlyAccepted: false, unknowns: [], unresolvedConflictEventIds: [], transitionViolations: [] } as any),
      listEvents: () => [{ eventId: 'evt-dispatch', eventType: 'task.dispatch_requested', occurredAt: '2026-09-29T00:00:00.000Z' }] as any,
      listOutbox: () => [],
    };
    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
    }).actions).toEqual([expect.objectContaining({
      kind: 'acceptance_timed_out', dispatchRoot: 'om_mapped', sourceEventId: 'evt-dispatch',
    })]);

    reader.getTaskProjection = () => ({ taskGuid: 'task-1', state: 'executing', explicitlyAccepted: true, unknowns: [], unresolvedConflictEventIds: [], transitionViolations: [] } as any);
    reader.listEvents = () => [
      { eventId: 'evt-execution', eventType: 'task.execution_started', occurredAt: '2026-09-29T00:00:00.000Z' },
      { eventId: 'evt-later-observation', eventType: 'unknown.declared', occurredAt: '2026-09-29T01:59:59.000Z' },
    ] as any;
    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
    }).actions).toEqual([expect.objectContaining({
      kind: 'execution_timeout_unknown', dispatchRoot: 'om_mapped', sourceEventId: 'evt-execution',
      unknownKey: 'execution-timeout:evt-execution',
    })]);
  });

  it('recovers a rooted reservation only from its exact durable dispatch registry entry', () => {
    const input = project();
    input.workstreams = [];
    input.dispatchReservations = [{
      reservationId: 'operation-1', targetAppIds: ['cli_reviewer', 'cli_worker'],
      access: { mode: 'write', scopes: ['/repo/src'] }, createdAt: '2026-09-29T00:00:00.000Z',
      expiresAt: '2026-09-29T01:00:00.000Z', stage: 'root_created', dispatchRoot: 'om_recover',
      rootCreateTime: '2026-09-29T00:00:01.000Z',
      taskControl: {
        mode: 'audit_only', taskGuid: '11111111-1111-4111-8111-111111111111',
        phaseId: 'workstream:11111111-1111-4111-8111-111111111111', workerAppId: 'cli_worker',
        reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor', originTurnId: 'turn-1',
        coordinatorSessionId: 'session-controller',
        recovery: {
          title: '恢复任务', purpose: '完成恢复', owners: ['开发一号'], botOpenIds: ['ou_worker'],
          acceptanceRequested: true, seedText: '恢复任务 seed',
        },
        proof: { schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_controller', issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64) },
      },
    }];
    const entry = {
      dispatchOperationId: 'operation-1', orchAppId: 'cli_controller', orchChatId: 'oc_project',
      orchSessionId: 'session-controller', targetChatId: 'oc_project', targetAppIds: ['cli_worker', 'cli_reviewer'],
      access: { mode: 'write', scopes: ['/repo/src'] }, workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'],
      taskControl: {
        mode: 'audit_only', taskGuid: '11111111-1111-4111-8111-111111111111',
        phaseId: 'workstream:11111111-1111-4111-8111-111111111111', controllerAppId: 'cli_controller',
        workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor',
      },
      title: '恢复任务', purpose: '完成恢复', owners: ['开发一号'], bots: ['ou_worker'], acceptanceState: 'requested',
    };
    const reader = {
      listTrustedMappings: () => [], getTaskProjection: () => ({} as any), listEvents: () => [], listOutbox: () => [],
    };
    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
      findDispatchOperation: operationId => operationId === 'operation-1'
        ? { dispatchRoot: 'om_recover', entry }
        : undefined,
    }).actions).toEqual([expect.objectContaining({
      kind: 'recover_dispatch', reservationId: 'operation-1', dispatchRoot: 'om_recover',
      workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'],
    })]);

    input.dispatchReservations[0]!.taskControl!.recovery = {
      title: '恢复任务', purpose: '完成恢复', owners: ['开发一号'], botOpenIds: ['ou_worker'],
      acceptanceRequested: true, seedText: '恢复任务 seed',
    };
    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
      findDispatchOperation: () => undefined,
    }).actions).toEqual([expect.objectContaining({
      kind: 'recover_dispatch', dispatchRoot: 'om_recover', registryMissing: true,
      title: '恢复任务', purpose: '完成恢复', acceptanceRequested: true,
    })]);

    input.dispatchReservations[0]!.stage = 'reserved';
    delete input.dispatchReservations[0]!.dispatchRoot;
    delete input.dispatchReservations[0]!.rootCreateTime;
    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
      findDispatchOperation: () => undefined,
    }).actions).toEqual([expect.objectContaining({
      kind: 'recover_dispatch', dispatchRoot: '', discoverRoot: true,
      registryMissing: true, seedText: '恢复任务 seed',
    })]);
    input.dispatchReservations[0]!.stage = 'root_created';
    input.dispatchReservations[0]!.dispatchRoot = 'om_recover';
    input.dispatchReservations[0]!.rootCreateTime = '2026-09-29T00:00:01.000Z';

    entry.title = '篡改标题';
    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
      findDispatchOperation: () => ({ dispatchRoot: 'om_recover', entry }),
    }).actions).toEqual([]);
    entry.title = '恢复任务';
    entry.taskControl.taskGuid = '22222222-2222-4222-8222-222222222222';
    expect(planProjectGroupTaskControlReconciliation({
      project: input as any, reader, now, acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
      findDispatchOperation: () => ({ dispatchRoot: 'om_recover', entry }),
    }).actions).toEqual([]);
  });
});
