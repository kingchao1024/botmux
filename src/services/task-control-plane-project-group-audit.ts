import type { ProjectGroupState } from './project-group-store.js';
import type { DeliveryOutboxRow, TaskControlEvent, TaskProjection, TrustedTaskControlMappingRecord } from './task-control-plane-store.js';

export type ProjectGroupAuditDiffCode =
  | 'legacy_only'
  | 'task_control_only'
  | 'state_mismatch'
  | 'missing_mapping'
  | 'unresolved_unknown'
  | 'terminal_without_receipt'
  | 'stale_execution_without_terminal';

export interface ProjectGroupAuditDiff {
  code: ProjectGroupAuditDiffCode;
  dispatchRoot: string;
  taskGuid?: string;
}

export interface ProjectGroupTaskControlAuditReader {
  listTrustedMappings(): TrustedTaskControlMappingRecord[];
  getTaskProjection(taskGuid: string): TaskProjection;
  listEvents(filter?: { taskGuid?: string }): TaskControlEvent[];
  listOutbox(filter?: { eventId?: string }): DeliveryOutboxRow[];
}

export type ProjectGroupTaskControlReconcileAction =
  | {
      kind: 'recover_dispatch';
      reservationId: string;
      dispatchRoot: string;
      bindRoot: boolean;
      registryMissing: boolean;
      discoverRoot: boolean;
      targetAppIds: string[];
      title: string;
      purpose: string;
      owners: string[];
      botOpenIds: string[];
      acceptanceRequested: boolean;
      seedText: string;
      workerAppIds: string[];
      reviewerAppIds: string[];
    }
  | {
      kind: 'mark_mapping_registered';
      dispatchRoot: string;
      taskGuid: string;
      mappingRef: string;
    }
  | {
      kind: 'recover_mapping';
      dispatchRoot: string;
      taskGuid: string;
    }
  | {
      kind: 'dispatch_requested';
      dispatchRoot: string;
      taskGuid: string;
      sourceSessionId: string;
      occurredAt: string;
    }
  | {
      kind: 'acceptance_timed_out';
      dispatchRoot: string;
      taskGuid: string;
      sourceEventId: string;
      sourceRef: string;
      occurredAt: string;
    }
  | {
      kind: 'execution_timeout_unknown';
      dispatchRoot: string;
      taskGuid: string;
      sourceEventId: string;
      sourceRef: string;
      unknownKey: string;
      occurredAt: string;
    };

function exactProjectMapping(
  project: ProjectGroupState,
  workstream: ProjectGroupState['workstreams'][number],
  mapping: TrustedTaskControlMappingRecord | undefined,
): mapping is TrustedTaskControlMappingRecord {
  const binding = workstream.taskControl;
  const authority = mapping?.mappingAuthority;
  return !!binding && !!mapping
    && mapping.dispatchRoot === workstream.dispatchRoot
    && mapping.projectId === `project-group:${project.chatId}`
    && mapping.phaseId === binding.phaseId
    && mapping.phaseTaskGuids.length === 1
    && mapping.phaseTaskGuids[0] === binding.taskGuid
    && mapping.taskGuid === binding.taskGuid
    && mapping.topicRootId === workstream.dispatchRoot
    && mapping.ownerId === binding.workerAppId
    && mapping.reviewerId === binding.reviewerAppId
    && mapping.acceptorId === binding.acceptorAppId
    && mapping.controllerId === binding.controllerAppId
    && mapping.registrationRef === binding.mappingRef
    && authority?.kind === 'project_group'
    && authority.chatId === project.chatId
    && authority.reservationId === binding.reservationId
    && authority.projectRevision === binding.projectRevision
    && authority.acceptorAppId === binding.acceptorAppId
    && authority.mode === 'audit_only';
}

function latestEvent(
  events: TaskControlEvent[],
  eventType: TaskControlEvent['eventType'],
): TaskControlEvent | undefined {
  return events
    .filter(event => event.eventType === eventType && Number.isFinite(Date.parse(event.occurredAt)))
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))[0];
}

function projectMappings(
  project: ProjectGroupState,
  mappings: TrustedTaskControlMappingRecord[],
): TrustedTaskControlMappingRecord[] {
  return mappings.filter(mapping => mapping.projectId === `project-group:${project.chatId}`
    && mapping.mappingAuthority.kind === 'project_group'
    && mapping.mappingAuthority.chatId === project.chatId
    && mapping.mappingAuthority.mode === 'audit_only');
}

export function auditProjectGroupTaskControl(_input: {
  project: ProjectGroupState;
  reader: ProjectGroupTaskControlAuditReader;
  now: number;
  staleExecutionMs: number;
}): { diffs: ProjectGroupAuditDiff[] } {
  const input = _input;
  const diffs: ProjectGroupAuditDiff[] = [];
  const mappings = projectMappings(input.project, input.reader.listTrustedMappings());
  const mappingsByRoot = new Map(mappings.map(mapping => [mapping.dispatchRoot, mapping]));
  const projectRoots = new Set(input.project.workstreams.map(workstream => workstream.dispatchRoot));
  const expectedStatus = (state: TaskProjection['state']): string => {
    if (state === 'planned') return 'pending';
    if (state === 'accepted' || state === 'executing' || state === 'rework') return 'in_progress';
    if (state === 'submitted' || state === 'reviewing') return 'in_review';
    if (state === 'delivered' || state === 'task_done_pending_freeze') return 'completed';
    if (state === 'blocked') return 'blocked';
    return 'failed';
  };

  for (const workstream of input.project.workstreams) {
    const taskControl = workstream.taskControl;
    if (!taskControl) {
      diffs.push({ code: 'legacy_only', dispatchRoot: workstream.dispatchRoot });
      continue;
    }
    const mapping = mappingsByRoot.get(workstream.dispatchRoot);
    if (!exactProjectMapping(input.project, workstream, mapping)) {
      diffs.push({ code: 'missing_mapping', dispatchRoot: workstream.dispatchRoot, taskGuid: taskControl.taskGuid });
      continue;
    }
    const projection = input.reader.getTaskProjection(taskControl.taskGuid);
    if (workstream.status !== expectedStatus(projection.state)) {
      diffs.push({ code: 'state_mismatch', dispatchRoot: workstream.dispatchRoot, taskGuid: taskControl.taskGuid });
    }
    if (projection.unknowns.some(item => item.required && !item.resolved)
      || projection.unresolvedConflictEventIds.length > 0
      || projection.transitionViolations.length > 0) {
      diffs.push({ code: 'unresolved_unknown', dispatchRoot: workstream.dispatchRoot, taskGuid: taskControl.taskGuid });
    }
    if (projection.terminalBody
      && !input.reader.listOutbox({ eventId: projection.terminalBody.eventId }).some(row => row.status === 'delivered')) {
      diffs.push({ code: 'terminal_without_receipt', dispatchRoot: workstream.dispatchRoot, taskGuid: taskControl.taskGuid });
    }
    if (projection.state === 'executing') {
      const execution = latestEvent(
        input.reader.listEvents({ taskGuid: taskControl.taskGuid }),
        'task.execution_started',
      );
      if (execution && input.now - Date.parse(execution.occurredAt) >= input.staleExecutionMs) {
        diffs.push({ code: 'stale_execution_without_terminal', dispatchRoot: workstream.dispatchRoot, taskGuid: taskControl.taskGuid });
      }
    }
  }

  for (const mapping of mappings) {
    if (!projectRoots.has(mapping.dispatchRoot)) {
      diffs.push({ code: 'task_control_only', dispatchRoot: mapping.dispatchRoot, taskGuid: mapping.taskGuid });
    }
  }
  return { diffs };
}

/**
 * Compute the narrow, deterministic repairs allowed during Phase 1. This
 * function is read-only: the daemon applies returned actions through the
 * existing project CAS and authenticated TaskControl integration.
 */
export function planProjectGroupTaskControlReconciliation(input: {
  project: ProjectGroupState;
  reader: ProjectGroupTaskControlAuditReader;
  now: number;
  acceptanceTimeoutMs: number;
  staleExecutionMs: number;
  findDispatchOperation?(operationId: string): { dispatchRoot: string; entry: Record<string, unknown> } | undefined;
}): { actions: ProjectGroupTaskControlReconcileAction[] } {
  const actions: ProjectGroupTaskControlReconcileAction[] = [];
  const mappingsByRoot = new Map(projectMappings(input.project, input.reader.listTrustedMappings())
    .map(mapping => [mapping.dispatchRoot, mapping]));

  for (const reservation of input.project.dispatchReservations ?? []) {
    if (!reservation.taskControl?.recovery) continue;
    const recovery = reservation.taskControl.recovery;
    let operation = input.findDispatchOperation?.(reservation.reservationId);
    const registryMissing = !operation;
    if (!operation && reservation.taskControl.recovery
      && ((reservation.stage === 'root_created' && reservation.dispatchRoot) || reservation.stage === 'reserved')) {
      operation = {
        dispatchRoot: reservation.stage === 'root_created' ? reservation.dispatchRoot! : '',
        entry: {
          dispatchOperationId: reservation.reservationId,
          orchAppId: input.project.larkAppId, orchChatId: input.project.chatId,
          orchSessionId: reservation.taskControl.coordinatorSessionId,
          targetChatId: input.project.chatId, targetAppIds: reservation.targetAppIds,
          access: reservation.access,
          workerAppIds: [reservation.taskControl.workerAppId],
          reviewerAppIds: [reservation.taskControl.reviewerAppId],
          taskControl: {
            mode: 'audit_only', taskGuid: reservation.taskControl.taskGuid,
            phaseId: reservation.taskControl.phaseId, controllerAppId: input.project.larkAppId,
            workerAppId: reservation.taskControl.workerAppId,
            reviewerAppId: reservation.taskControl.reviewerAppId,
            acceptorAppId: reservation.taskControl.acceptorAppId,
          },
          title: reservation.taskControl.recovery.title,
          purpose: reservation.taskControl.recovery.purpose,
          owners: reservation.taskControl.recovery.owners,
          bots: reservation.taskControl.recovery.botOpenIds,
          acceptanceState: reservation.taskControl.recovery.acceptanceRequested ? 'requested' : 'not_requested',
        },
      };
    }
    if (!operation || (operation.dispatchRoot !== '' && !/^om_[A-Za-z0-9_-]{1,128}$/.test(operation.dispatchRoot))) continue;
    const entry = operation.entry;
    const taskControl = entry.taskControl && typeof entry.taskControl === 'object' && !Array.isArray(entry.taskControl)
      ? entry.taskControl as Record<string, unknown>
      : undefined;
    const targetAppIds = Array.isArray(entry.targetAppIds)
      ? entry.targetAppIds.filter((value): value is string => typeof value === 'string').sort()
      : [];
    const workerAppIds = Array.isArray(entry.workerAppIds)
      ? entry.workerAppIds.filter((value): value is string => typeof value === 'string').sort()
      : [];
    const reviewerAppIds = Array.isArray(entry.reviewerAppIds)
      ? entry.reviewerAppIds.filter((value): value is string => typeof value === 'string').sort()
      : [];
    const access = entry.access && typeof entry.access === 'object' && !Array.isArray(entry.access)
      ? entry.access as Record<string, unknown>
      : undefined;
    const accessMatches = reservation.access.mode === 'read_only'
      ? access?.mode === 'read_only'
      : access?.mode === 'write' && Array.isArray(access.scopes)
        && JSON.stringify([...access.scopes].sort()) === JSON.stringify([...reservation.access.scopes].sort());
    if (entry.dispatchOperationId !== reservation.reservationId
      || (reservation.stage !== 'reserved' && reservation.stage !== 'root_created')
      || (reservation.stage === 'root_created' && reservation.dispatchRoot !== operation.dispatchRoot)
      || entry.orchAppId !== input.project.larkAppId || entry.orchChatId !== input.project.chatId
      || entry.orchSessionId !== reservation.taskControl.coordinatorSessionId
      || entry.targetChatId !== input.project.chatId
      || JSON.stringify(targetAppIds) !== JSON.stringify([...reservation.targetAppIds].sort())
      || !accessMatches
      || workerAppIds.length !== 1 || workerAppIds[0] !== reservation.taskControl.workerAppId
      || reviewerAppIds.length !== 1 || reviewerAppIds[0] !== reservation.taskControl.reviewerAppId
      || taskControl?.mode !== 'audit_only' || taskControl.taskGuid !== reservation.taskControl.taskGuid
      || taskControl.phaseId !== reservation.taskControl.phaseId
      || taskControl.controllerAppId !== input.project.larkAppId
      || taskControl.workerAppId !== reservation.taskControl.workerAppId
      || taskControl.reviewerAppId !== reservation.taskControl.reviewerAppId
      || taskControl.acceptorAppId !== reservation.taskControl.acceptorAppId) continue;
    const entryTitle = typeof entry.title === 'string' ? entry.title.trim() : '';
    const entryPurpose = typeof entry.purpose === 'string' ? entry.purpose : '';
    const entryOwners = Array.isArray(entry.owners)
      ? entry.owners.filter((value): value is string => typeof value === 'string' && !!value.trim())
      : [];
    const entryBotOpenIds = Array.isArray(entry.bots)
      ? entry.bots.filter((value): value is string => typeof value === 'string')
      : [];
    const entryAcceptanceRequested = entry.acceptanceState === 'requested';
    if (!entryTitle || entryTitle === '子任务' || entryTitle === '子项目' || Array.from(entryTitle).length > 24
      || entryTitle !== recovery.title || entryPurpose !== recovery.purpose
      || JSON.stringify(entryOwners) !== JSON.stringify(recovery.owners)
      || JSON.stringify(entryBotOpenIds) !== JSON.stringify(recovery.botOpenIds)
      || entryAcceptanceRequested !== recovery.acceptanceRequested) continue;
    actions.push({
      kind: 'recover_dispatch', reservationId: reservation.reservationId,
      dispatchRoot: operation.dispatchRoot, bindRoot: reservation.stage !== 'root_created', registryMissing,
      discoverRoot: operation.dispatchRoot === '',
      targetAppIds: [...reservation.targetAppIds], title: recovery.title,
      purpose: recovery.purpose, owners: [...recovery.owners],
      botOpenIds: [...recovery.botOpenIds],
      acceptanceRequested: recovery.acceptanceRequested,
      seedText: recovery.seedText,
      workerAppIds, reviewerAppIds,
    });
  }

  for (const workstream of input.project.workstreams) {
    const binding = workstream.taskControl;
    if (!binding || binding.mappingStatus === 'rejected' || binding.mappingStatus === 'retired') continue;
    const mapping = mappingsByRoot.get(workstream.dispatchRoot);
    if (!exactProjectMapping(input.project, workstream, mapping)) {
      if (binding.mappingStatus === 'pending' && mapping === undefined) {
        actions.push({ kind: 'recover_mapping', dispatchRoot: workstream.dispatchRoot, taskGuid: binding.taskGuid });
      }
      continue;
    }
    if (binding.mappingStatus === 'pending') {
      actions.push({
        kind: 'mark_mapping_registered', dispatchRoot: workstream.dispatchRoot,
        taskGuid: binding.taskGuid, mappingRef: binding.mappingRef,
      });
      continue;
    }

    const projection = input.reader.getTaskProjection(binding.taskGuid);
    const events = input.reader.listEvents({ taskGuid: binding.taskGuid });
    if (projection.state === 'planned') {
      const requested = latestEvent(events, 'task.dispatch_requested');
      if (!requested) {
        actions.push({
          kind: 'dispatch_requested', dispatchRoot: workstream.dispatchRoot, taskGuid: binding.taskGuid,
          sourceSessionId: binding.coordinatorSessionId, occurredAt: new Date(input.now).toISOString(),
        });
        continue;
      }
      if (requested && input.now - Date.parse(requested.occurredAt) >= input.acceptanceTimeoutMs) {
        actions.push({
          kind: 'acceptance_timed_out', dispatchRoot: workstream.dispatchRoot, taskGuid: binding.taskGuid,
          sourceEventId: requested.eventId, sourceRef: `reconcile:acceptance-timeout:${requested.eventId}`,
          occurredAt: new Date(input.now).toISOString(),
        });
      }
      continue;
    }
    if (projection.state === 'executing') {
      const execution = latestEvent(events, 'task.execution_started');
      if (execution && input.now - Date.parse(execution.occurredAt) >= input.staleExecutionMs) {
        actions.push({
          kind: 'execution_timeout_unknown', dispatchRoot: workstream.dispatchRoot, taskGuid: binding.taskGuid,
          sourceEventId: execution.eventId, sourceRef: `reconcile:execution-timeout:${execution.eventId}`,
          unknownKey: `execution-timeout:${execution.eventId}`, occurredAt: new Date(input.now).toISOString(),
        });
      }
    }
  }
  return { actions };
}
