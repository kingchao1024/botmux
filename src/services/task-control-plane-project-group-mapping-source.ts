import { createHash } from 'node:crypto';
import type { ProjectDispatchAccess } from '../core/dispatch-write-scope.js';

export interface ProjectDispatchReservationFactsV1 {
  schemaVersion: 'ProjectDispatchReservation.v1';
  larkAppId: string;
  chatId: string;
  coordinatorSessionId: string;
  originTurnId: string;
  reservationId: string;
  taskGuid: string;
  phaseId: string;
  workerAppId: string;
  reviewerAppId: string;
  acceptorAppId: string;
  access: ProjectDispatchAccess;
  createdAt: string;
  expiresAt: string;
  dispatch: {
    seedText: string;
    title: string;
    purpose: string;
    owners: string[];
    botOpenIds: string[];
    acceptanceRequested: boolean;
  };
}

export interface ProjectDispatchReservationProofV1 {
  schemaVersion: 'ProjectDispatchReservationProof.v1';
  larkAppId: string;
  issuedAt: string;
  keyId: string;
  signature: string;
}

export interface ProjectGroupMappingFactsV1 {
  schemaVersion: 'ProjectGroupMappingRegistration.v1';
  sourceKind: 'project_group';
  larkAppId: string;
  chatId: string;
  coordinatorSessionId: string;
  projectRevision: number;
  reservationId: string;
  reservationProofKeyId: string;
  dispatchRoot: string;
  taskGuid: string;
  projectId: string;
  phaseId: string;
  controllerAppId: string;
  workerAppId: string;
  reviewerAppId: string;
  acceptorAppId: string;
  access: ProjectDispatchAccess;
  rootCreateTime: string;
}

export interface ProjectGroupMappingSourceInput {
  selfLarkAppId: string;
  controllerBotOpenId: string;
  now: string;
  liveSession: {
    larkAppId: string;
    chatId: string;
    sessionId: string;
    workerGeneration: number;
    turnCapability: string;
  };
  project: {
    chatId: string;
    larkAppId: string;
    coordinatorSessionId: string;
    revision: number;
  };
  reservation: ProjectDispatchReservationFactsV1 & {
    taskControlMode: 'audit_only' | 'legacy';
    stage: 'reserved' | 'root_created';
    targetAppIds: string[];
    dispatchRoot?: string;
    rootCreateTime?: string;
    proof: ProjectDispatchReservationProofV1;
  };
  root: {
    messageId: string;
    rootId?: string;
    chatId: string;
    senderId: string;
    createTime: string;
  };
  allowedWorkerAppIds: readonly string[];
  verifyReservationProof(
    facts: ProjectDispatchReservationFactsV1,
    proof: ProjectDispatchReservationProofV1,
  ): boolean;
  recovery?: boolean;
}

export function projectGroupRootSnapshotFromLarkDetail(detail: unknown): ProjectGroupMappingSourceInput['root'] | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const items = (detail as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length !== 1 || !items[0] || typeof items[0] !== 'object' || Array.isArray(items[0])) {
    return undefined;
  }
  const item = items[0] as Record<string, unknown>;
  const sender = item.sender && typeof item.sender === 'object' && !Array.isArray(item.sender)
    ? item.sender as Record<string, unknown>
    : undefined;
  const messageId = typeof item.message_id === 'string' ? item.message_id.trim() : '';
  const chatId = typeof item.chat_id === 'string' ? item.chat_id.trim() : '';
  const senderId = typeof sender?.open_bot_id === 'string'
    ? sender.open_bot_id.trim()
    : typeof sender?.id === 'string' ? sender.id.trim() : '';
  const rawCreateTime = typeof item.create_time === 'string' || typeof item.create_time === 'number'
    ? String(item.create_time)
    : '';
  const createTimeMs = /^\d{10,16}$/.test(rawCreateTime)
    ? Number(rawCreateTime) * (rawCreateTime.length <= 10 ? 1_000 : 1)
    : Date.parse(rawCreateTime);
  if (!MESSAGE_ID.test(messageId) || !CHAT_ID.test(chatId) || !senderId || !Number.isFinite(createTimeMs)) return undefined;
  const rootId = typeof item.root_id === 'string' && item.root_id.trim() ? item.root_id.trim() : undefined;
  return {
    messageId,
    ...(rootId ? { rootId } : {}),
    chatId,
    senderId,
    createTime: new Date(createTimeMs).toISOString(),
  };
}

export type ProjectGroupMappingSourceResult =
  | { ok: true; facts: ProjectGroupMappingFactsV1 }
  | { ok: false; error: string };

export function projectGroupTaskGuid(input: {
  larkAppId: string;
  chatId: string;
  reservationId: string;
}): string {
  if (!input.larkAppId.trim() || !input.chatId.trim() || !input.reservationId.trim()) {
    throw new Error('project_group_task_guid_input_invalid');
  }
  const hex = createHash('sha256')
    .update(`botmux.project-group.task-guid.v1\0${input.larkAppId}\0${input.chatId}\0${input.reservationId}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

const APP_ID = /^cli_[A-Za-z0-9_-]{16,128}$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]{16,128}$/;
const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,128}$/;
const TASK_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(error: string): ProjectGroupMappingSourceResult {
  return { ok: false, error };
}

function reservationFacts(input: ProjectGroupMappingSourceInput['reservation']): ProjectDispatchReservationFactsV1 {
  return {
    schemaVersion: input.schemaVersion,
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    coordinatorSessionId: input.coordinatorSessionId,
    originTurnId: input.originTurnId,
    reservationId: input.reservationId,
    taskGuid: input.taskGuid,
    phaseId: input.phaseId,
    workerAppId: input.workerAppId,
    reviewerAppId: input.reviewerAppId,
    acceptorAppId: input.acceptorAppId,
    access: input.access,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    dispatch: input.dispatch,
  };
}

export function resolveProjectGroupMappingFacts(
  input: ProjectGroupMappingSourceInput,
): ProjectGroupMappingSourceResult {
  const { liveSession, project, reservation, root } = input;
  if (!APP_ID.test(input.selfLarkAppId)
    || (!input.recovery && liveSession.larkAppId !== input.selfLarkAppId)
    || project.larkAppId !== input.selfLarkAppId) return fail('controller_app_mismatch');
  if (!input.recovery && (liveSession.sessionId !== project.coordinatorSessionId
    || reservation.coordinatorSessionId !== project.coordinatorSessionId)) return fail('coordinator_session_mismatch');
  if ((!input.recovery && liveSession.chatId !== project.chatId) || reservation.chatId !== project.chatId) return fail('project_chat_mismatch');
  if ((!input.recovery && (!Number.isSafeInteger(liveSession.workerGeneration) || liveSession.workerGeneration < 1
    || !liveSession.turnCapability.trim())) || !reservation.originTurnId.trim()) return fail('controller_turn_unproven');
  if (root.chatId !== project.chatId) return fail('root_chat_mismatch');
  if (reservation.taskControlMode !== 'audit_only') return fail('audit_only_required');
  if (reservation.stage !== 'root_created' || !reservation.dispatchRoot || !reservation.rootCreateTime) {
    return fail('root_not_persisted');
  }
  const roles = [input.selfLarkAppId, reservation.workerAppId, reservation.reviewerAppId, reservation.acceptorAppId];
  if (roles.some(role => !APP_ID.test(role)) || new Set(roles).size !== roles.length) return fail('role_overlap');
  if (reservation.access.mode !== 'write' || reservation.access.scopes.length === 0) return fail('write_scope_required');
  const allowed = new Set(input.allowedWorkerAppIds);
  if ([reservation.workerAppId, reservation.reviewerAppId, reservation.acceptorAppId].some(role => !allowed.has(role))) {
    return fail('role_not_allowlisted');
  }
  const targets = [...new Set(reservation.targetAppIds)].sort();
  const expectedTargets = [reservation.workerAppId, reservation.reviewerAppId].sort();
  if (JSON.stringify(targets) !== JSON.stringify(expectedTargets)) return fail('dispatch_targets_mismatch');
  if (!MESSAGE_ID.test(reservation.dispatchRoot) || root.messageId !== reservation.dispatchRoot) return fail('root_message_mismatch');
  if (root.rootId && root.rootId !== root.messageId) return fail('root_shape_mismatch');
  if (!input.controllerBotOpenId.trim() || root.senderId !== input.controllerBotOpenId) return fail('root_sender_mismatch');
  if (root.createTime !== reservation.rootCreateTime || !Number.isFinite(Date.parse(root.createTime))) return fail('root_time_mismatch');
  if (!TASK_GUID.test(reservation.taskGuid) || reservation.phaseId !== `workstream:${reservation.taskGuid}`) {
    return fail('task_identity_invalid');
  }
  if (!Number.isSafeInteger(project.revision) || project.revision < 1) return fail('project_revision_invalid');
  const now = Date.parse(input.now);
  const createdAt = Date.parse(reservation.createdAt);
  const expiresAt = Date.parse(reservation.expiresAt);
  if (![now, createdAt, expiresAt].every(Number.isFinite) || expiresAt <= createdAt) return fail('reservation_time_invalid');
  if (now >= expiresAt && !input.recovery) return fail('reservation_expired');
  if (reservation.proof.schemaVersion !== 'ProjectDispatchReservationProof.v1'
    || reservation.proof.larkAppId !== input.selfLarkAppId
    || !input.verifyReservationProof(reservationFacts(reservation), reservation.proof)) {
    return fail('reservation_proof_invalid');
  }
  return {
    ok: true,
    facts: {
      schemaVersion: 'ProjectGroupMappingRegistration.v1',
      sourceKind: 'project_group',
      larkAppId: input.selfLarkAppId,
      chatId: project.chatId,
      coordinatorSessionId: reservation.coordinatorSessionId,
      projectRevision: project.revision,
      reservationId: reservation.reservationId,
      reservationProofKeyId: reservation.proof.keyId,
      dispatchRoot: reservation.dispatchRoot,
      taskGuid: reservation.taskGuid,
      projectId: `project-group:${project.chatId}`,
      phaseId: reservation.phaseId,
      controllerAppId: input.selfLarkAppId,
      workerAppId: reservation.workerAppId,
      reviewerAppId: reservation.reviewerAppId,
      acceptorAppId: reservation.acceptorAppId,
      access: reservation.access,
      rootCreateTime: reservation.rootCreateTime,
    },
  };
}
