import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';
import { normalizeDispatchWriteScopes, type ProjectDispatchAccess } from '../core/dispatch-write-scope.js';
import type {
  ProjectDispatchReservationFactsV1,
  ProjectDispatchReservationProofV1,
} from './task-control-plane-project-group-mapping-source.js';
import type { RepositoryLeaseRef } from './repository-control-store.js';
import {
  normalizeProjectStageAdvanceEvents,
  type ProjectStageAdvanceEvent,
} from './project-stage-auto-advance.js';

export const PROJECT_GROUP_STORE_FILE = 'project-groups.json';
export const PROJECT_COMPLETION_GATE_VALIDITY_MS = 5 * 60_000;
export const PROJECT_COMPLETION_GATE_REFRESH_WINDOW_MS = 60_000;

export type ProjectGroupStatus = 'active' | 'paused' | 'completed';
export type ProjectWorkstreamStatus = 'pending' | 'in_progress' | 'in_review' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type ProjectBlockerSource = 'manual' | 'task_control' | 'human_action';
export type ProjectCompletionGateStatus = 'pending' | 'blocked' | 'satisfied';

export interface ProjectCompletionGateEvidence {
  sourceProjectRevision: number;
  reviewerVerdictId: string;
  terminalEventId: string;
  deliveryReceiptId: string;
}

export interface ProjectCompletionGateRetirement {
  retiredAt: string;
  retiredBySessionId: string;
  authorizationRef: string;
  authorizedByOpenId: string;
  reason: string;
  replacementGateId?: string;
}

export interface ProjectCompletionGate {
  gateId: string;
  sourceChatId: string;
  dispatchRoot: string;
  taskGuid: string;
  label: string;
  definitionFingerprint: string;
  status: ProjectCompletionGateStatus;
  reason: string;
  checkedAt?: string;
  validUntil?: string;
  evidence?: ProjectCompletionGateEvidence;
  retirement?: ProjectCompletionGateRetirement;
  replacesGateId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBlockerRecord {
  blockerId: string;
  source: ProjectBlockerSource;
  summary: string;
  openedAt: string;
  taskGuid?: string;
  eventId?: string;
  code?: string;
}

export interface ProjectBlockerRetirement {
  schemaVersion: 'ProjectBlockerRetirement.v1';
  record: ProjectBlockerRecord;
  recordFingerprint: string;
  authorizationRef: string;
  authorizedByOpenId: string;
  reason: string;
  retiredAt: string;
  retiredBySessionId: string;
}

export const TASK_CONTROL_CANARY_QUARANTINE_CODE = 'task_control_canary_quarantine';
export const TASK_CONTROL_CANARY_ABANDONED_CODE = 'task_control_canary_abandoned';

export interface ProjectTaskControlCanaryPhaseABinding {
  historicalDispatchRoot: string;
  historicalTaskGuid: string;
  mappedWorkerAppId: string;
  failedReportContent: string;
  failedReportSha256: string;
  instructionTemplateVersion: 'TaskControlPhaseAInstruction.v1';
  instructionTemplate: string;
  instructionTemplateSha256: string;
}

export interface ProjectTaskControlCanaryKickoffBinding {
  templateVersion: 'TaskControlKickoff.v1';
  rootPlaceholder: '{{dispatchRoot}}';
  brief: string;
  briefSha256: string;
  bots: Array<{
    appId: string;
    openId: string;
    displayName: string;
    role: 'worker' | 'reviewer';
  }>;
}

export interface ProjectTaskControlCanaryFenceInput {
  dispatchOperationId: string;
  taskGuid: string;
  coordinatorSessionId: string;
  originTurnId: string;
  authorizationRef: string;
  authorizedByOpenId: string;
  planSha256: string;
  controllerAppId: string;
  workerAppId: string;
  reviewerAppId: string;
  acceptorAppId: string;
  targetChatId: string;
  targetAppIds: string[];
  writeScopes: string[];
  title: string;
  purpose: string;
  owners: string[];
  botOpenIds: string[];
  acceptanceRequested: boolean;
  seedText: string;
  taskControlMode: 'audit_only';
  kickoff?: ProjectTaskControlCanaryKickoffBinding;
  phaseA: ProjectTaskControlCanaryPhaseABinding;
}

export interface ProjectTaskControlCanaryFence extends ProjectTaskControlCanaryFenceInput {
  schemaVersion: 'TaskControlCanaryFence.v1';
}

export interface ProjectTaskControlCanaryAbandonmentV1 {
  schemaVersion: 'TaskControlCanaryAbandoned.v1';
  fence: ProjectTaskControlCanaryFence;
  fenceFingerprint: string;
  authorizationRef: string;
  authorizedByOpenId: string;
  abandonedAt: string;
}

export interface ProjectTaskControlCanaryAbandonmentV2 {
  schemaVersion: 'TaskControlCanaryAbandoned.v2';
  fence: ProjectTaskControlCanaryFence;
  fenceFingerprint: string;
  phaseBDispatchRoot: string | null;
  authorizationRef: string;
  authorizedByOpenId: string;
  abandonedAt: string;
  fingerprint: string;
}

export type ProjectTaskControlCanaryAbandonment =
  | ProjectTaskControlCanaryAbandonmentV1
  | ProjectTaskControlCanaryAbandonmentV2;

export interface ProjectTaskControlBinding {
  taskGuid: string;
  phaseId: string;
  mappingRef: string;
  mappingStatus: 'pending' | 'registered' | 'rejected' | 'retired';
  sourceKind: 'project_group';
  controllerAppId: string;
  workerAppId: string;
  reviewerAppId: string;
  acceptorAppId: string;
  projectRevision: number;
  reservationId: string;
  coordinatorSessionId: string;
  originTurnId: string;
  reservationCreatedAt: string;
  reservationExpiresAt: string;
  rootCreateTime: string;
  reservationProof: ProjectDispatchReservationProofV1;
  recovery?: ProjectDispatchReservationFactsV1['dispatch'];
  registeredAt?: string;
  failureCode?: string;
}

export interface ProjectWorkstreamDelivery {
  reportedByAppId: string;
  content: string;
  reportedAt: string;
  round: number;
}

export interface ProjectWorkstreamReview {
  reviewerAppId: string;
  verdict: 'pass' | 'fail';
  content: string;
  reviewedAt: string;
  round: number;
}

export interface ProjectReviewerReplacement {
  oldReviewerAppId: string;
  newReviewerAppId: string;
  authorizationRef: string;
  authorizedByOpenId: string;
  reason: string;
  coordinatorSessionId: string;
  replacedAt: string;
  fromRevision: number;
  toRevision: number;
}

export interface ProjectReviewerReplacementReceipt {
  operationFingerprint: string;
  fromRevision: number;
  toRevision: number;
}

export interface ProjectWorkstreamArchive {
  archivedFromStatus: 'failed';
  archivedAt: string;
  archiveReason: string;
  archiveAuthorizationRef: string;
  archivedByOpenId: string;
}

export interface ProjectWorkstream extends Partial<ProjectWorkstreamArchive> {
  dispatchRoot: string;
  threadId?: string;
  title: string;
  purpose: string;
  owners: string[];
  targetAppIds?: string[];
  workerAppIds?: string[];
  reviewerAppIds?: string[];
  reviewerReplacements?: ProjectReviewerReplacement[];
  reviewerReplacementReceipts?: ProjectReviewerReplacementReceipt[];
  access?: ProjectDispatchAccess;
  repositoryLeaseRef?: RepositoryLeaseRef;
  delivery?: ProjectWorkstreamDelivery;
  review?: ProjectWorkstreamReview;
  status: ProjectWorkstreamStatus;
  progress: number;
  remaining?: string;
  lastReport?: string;
  blocker?: string;
  taskControl?: ProjectTaskControlBinding;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDispatchReservation {
  reservationId: string;
  targetAppIds: string[];
  access: ProjectDispatchAccess;
  repositoryLeaseRef?: RepositoryLeaseRef;
  createdAt: string;
  expiresAt: string;
  stage?: 'reserved' | 'root_created';
  dispatchRoot?: string;
  rootCreateTime?: string;
  taskControl?: {
    mode: 'audit_only';
    taskGuid: string;
    phaseId: string;
    workerAppId: string;
    reviewerAppId: string;
    acceptorAppId: string;
    originTurnId: string;
    coordinatorSessionId?: string;
    proof: ProjectDispatchReservationProofV1;
    recovery?: ProjectDispatchReservationFactsV1['dispatch'];
  };
}

export interface ProjectMilestone {
  content: string;
  createdAt: string;
}

export interface ProjectGroupState {
  schemaVersion: 3;
  revision: number;
  chatId: string;
  larkAppId: string;
  coordinatorSessionId: string;
  title: string;
  goal: string;
  phase: string;
  focus: string;
  status: ProjectGroupStatus;
  manualProgress?: number;
  remaining?: string;
  blockers: string[];
  blockerRecords: ProjectBlockerRecord[];
  blockerRetirements?: ProjectBlockerRetirement[];
  workstreams: ProjectWorkstream[];
  /** Bounded durable outbox for trusted coordinator wake-ups. */
  stageAdvanceEvents?: ProjectStageAdvanceEvent[];
  /** Durable cross-chat dependencies that must pass before the parent may complete. */
  completionGates?: ProjectCompletionGate[];
  /** Optional for backwards-compatible reads of project state written before reservations. */
  dispatchReservations?: ProjectDispatchReservation[];
  milestones: ProjectMilestone[];
  nextMilestone?: string;
  card?: {
    messageId: string;
    pinned: boolean;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface ProjectGroupRegistry {
  schemaVersion: 3;
  projects: Record<string, ProjectGroupState>;
}

export interface ProjectGroupRegistryReader {
  readProject(chatId: string): ProjectGroupState | undefined;
}

function storePath(dataDir: string): string {
  return join(dataDir, PROJECT_GROUP_STORE_FILE);
}

function taskControlChatLockTarget(dataDir: string, chatId: string): string {
  const identity = createHash('sha256').update(chatId).digest('hex').slice(0, 24);
  return join(dataDir, `.task-control-chat-${identity}`);
}

export function withProjectTaskControlChatLockSync<T>(
  dataDir: string,
  chatId: string,
  action: () => T,
): T {
  return withFileLockSync(taskControlChatLockTarget(dataDir, chatId), action);
}

export function withProjectTaskControlChatLock<T>(
  dataDir: string,
  chatId: string,
  action: () => Promise<T>,
): Promise<T> {
  return withFileLock(taskControlChatLockTarget(dataDir, chatId), action);
}

function emptyRegistry(): ProjectGroupRegistry {
  return { schemaVersion: 3, projects: {} };
}

export function projectBlockerId(source: ProjectBlockerSource, key: string): string {
  return `${source}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function canonicalStringSet(values: readonly string[], field: string): string[] {
  const normalized = [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
  if (normalized.length === 0) throw new Error(`project_task_control_canary_fence_${field}_required`);
  return normalized;
}

export function canonicalProjectTaskControlCanaryFence(
  input: ProjectTaskControlCanaryFenceInput,
): ProjectTaskControlCanaryFence {
  const dispatchOperationId = input.dispatchOperationId.trim();
  const taskGuid = input.taskGuid.trim().toLowerCase();
  const coordinatorSessionId = input.coordinatorSessionId.trim();
  const originTurnId = input.originTurnId.trim();
  const authorizationRef = input.authorizationRef.trim();
  const authorizedByOpenId = input.authorizedByOpenId.trim();
  const planSha256 = input.planSha256.trim().toLowerCase();
  const controllerAppId = input.controllerAppId.trim();
  const workerAppId = input.workerAppId.trim();
  const reviewerAppId = input.reviewerAppId.trim();
  const acceptorAppId = input.acceptorAppId.trim();
  const targetChatId = input.targetChatId.trim();
  const targetAppIds = canonicalStringSet(input.targetAppIds, 'target_apps');
  const writeScopes = normalizeDispatchWriteScopes(input.writeScopes);
  const title = input.title.trim();
  const purpose = input.purpose.trim();
  const owners = canonicalStringSet(input.owners, 'owners');
  const botOpenIds = canonicalStringSet(input.botOpenIds, 'bot_open_ids');
  const seedText = input.seedText.trim();
  const kickoff = input.kickoff;
  const phaseA = input.phaseA;
  if (!/^[a-f0-9]{50}$/.test(dispatchOperationId)) {
    throw new Error('project_task_control_canary_fence_operation_invalid');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(taskGuid)) {
    throw new Error('project_task_control_canary_fence_task_guid_invalid');
  }
  if (!coordinatorSessionId || !originTurnId) {
    throw new Error('project_task_control_canary_fence_origin_invalid');
  }
  if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(authorizationRef)
    || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(authorizedByOpenId)) {
    throw new Error('project_task_control_canary_fence_authorization_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(planSha256)) {
    throw new Error('project_task_control_canary_fence_plan_invalid');
  }
  if (![controllerAppId, workerAppId, reviewerAppId, acceptorAppId]
    .every(appId => /^cli_[A-Za-z0-9_-]{1,128}$/.test(appId))) {
    throw new Error('project_task_control_canary_fence_roles_invalid');
  }
  if (new Set([controllerAppId, workerAppId, reviewerAppId, acceptorAppId]).size !== 4
    || targetAppIds.length !== 2 || !targetAppIds.includes(workerAppId) || !targetAppIds.includes(reviewerAppId)) {
    throw new Error('project_task_control_canary_fence_roles_invalid');
  }
  if (!/^oc_[A-Za-z0-9_-]{1,128}$/.test(targetChatId) || writeScopes.length === 0
    || !title || !purpose || !seedText || input.taskControlMode !== 'audit_only') {
    throw new Error('project_task_control_canary_fence_dispatch_invalid');
  }
  let canonicalKickoff: ProjectTaskControlCanaryKickoffBinding | undefined;
  if (kickoff !== undefined) {
    const bots = Array.isArray(kickoff.bots)
      ? kickoff.bots.map(bot => ({
          appId: bot.appId?.trim(), openId: bot.openId?.trim(),
          displayName: bot.displayName?.trim(), role: bot.role,
        })).sort((left, right) => left.role.localeCompare(right.role))
      : [];
    if (kickoff.templateVersion !== 'TaskControlKickoff.v1'
      || kickoff.rootPlaceholder !== '{{dispatchRoot}}'
      || typeof kickoff.brief !== 'string' || kickoff.brief.trim() !== kickoff.brief
      || kickoff.brief !== purpose
      || !/^[a-f0-9]{64}$/i.test(kickoff.briefSha256?.trim())
      || createHash('sha256').update(kickoff.brief).digest('hex') !== kickoff.briefSha256.trim().toLowerCase()
      || bots.length !== 2
      || bots.some(bot => !/^cli_[A-Za-z0-9_-]{1,128}$/.test(bot.appId)
        || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(bot.openId)
        || !bot.displayName || (bot.role !== 'worker' && bot.role !== 'reviewer'))
      || new Set(bots.map(bot => bot.appId)).size !== 2
      || new Set(bots.map(bot => bot.openId)).size !== 2
      || bots.filter(bot => bot.role === 'worker').length !== 1
      || bots.filter(bot => bot.role === 'reviewer').length !== 1
      || bots.find(bot => bot.role === 'worker')?.appId !== workerAppId
      || bots.find(bot => bot.role === 'reviewer')?.appId !== reviewerAppId
      || JSON.stringify(bots.map(bot => bot.appId).sort()) !== JSON.stringify(targetAppIds)
      || JSON.stringify(bots.map(bot => bot.openId).sort()) !== JSON.stringify(botOpenIds)
      || JSON.stringify(bots.map(bot => bot.displayName).sort()) !== JSON.stringify(owners)) {
      throw new Error('project_task_control_canary_fence_kickoff_invalid');
    }
    canonicalKickoff = {
      templateVersion: 'TaskControlKickoff.v1', rootPlaceholder: '{{dispatchRoot}}',
      brief: kickoff.brief, briefSha256: kickoff.briefSha256.trim().toLowerCase(), bots,
    };
  }
  if (!phaseA || typeof phaseA !== 'object'
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(phaseA.historicalDispatchRoot?.trim())
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(phaseA.historicalTaskGuid?.trim())
    || !/^cli_[A-Za-z0-9_-]{1,128}$/.test(phaseA.mappedWorkerAppId?.trim())
    || typeof phaseA.failedReportContent !== 'string'
    || !phaseA.failedReportContent
    || phaseA.failedReportContent.trim() !== phaseA.failedReportContent
    || Array.from(phaseA.failedReportContent).length > 1_000
    || !/^[a-f0-9]{64}$/i.test(phaseA.failedReportSha256?.trim())
    || createHash('sha256').update(phaseA.failedReportContent).digest('hex')
      !== phaseA.failedReportSha256.trim().toLowerCase()
    || phaseA.instructionTemplateVersion !== 'TaskControlPhaseAInstruction.v1'
    || typeof phaseA.instructionTemplate !== 'string'
    || !phaseA.instructionTemplate
    || phaseA.instructionTemplate.trim() !== phaseA.instructionTemplate
    || !/^[a-f0-9]{64}$/i.test(phaseA.instructionTemplateSha256?.trim())
    || createHash('sha256').update(phaseA.instructionTemplate).digest('hex')
      !== phaseA.instructionTemplateSha256.trim().toLowerCase()) {
    throw new Error('project_task_control_canary_fence_phase_a_invalid');
  }
  return {
    schemaVersion: 'TaskControlCanaryFence.v1', dispatchOperationId, taskGuid,
    coordinatorSessionId, originTurnId, authorizationRef, authorizedByOpenId,
    planSha256, controllerAppId, workerAppId, reviewerAppId, acceptorAppId,
    targetChatId, targetAppIds, writeScopes, title, purpose, owners, botOpenIds,
    acceptanceRequested: input.acceptanceRequested === true, seedText, taskControlMode: 'audit_only',
    ...(canonicalKickoff ? { kickoff: canonicalKickoff } : {}),
    phaseA: {
      historicalDispatchRoot: phaseA.historicalDispatchRoot.trim(),
      historicalTaskGuid: phaseA.historicalTaskGuid.trim().toLowerCase(),
      mappedWorkerAppId: phaseA.mappedWorkerAppId.trim(),
      failedReportContent: phaseA.failedReportContent,
      failedReportSha256: phaseA.failedReportSha256.trim().toLowerCase(),
      instructionTemplateVersion: 'TaskControlPhaseAInstruction.v1',
      instructionTemplate: phaseA.instructionTemplate,
      instructionTemplateSha256: phaseA.instructionTemplateSha256.trim().toLowerCase(),
    },
  };
}

export function projectTaskControlCanaryFenceFingerprint(
  input: ProjectTaskControlCanaryFenceInput,
): string {
  const canonical = canonicalProjectTaskControlCanaryFence(input);
  return `tccq1:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

export function projectTaskControlCanaryFenceRecord(
  input: ProjectTaskControlCanaryFenceInput,
  openedAt: string,
): ProjectBlockerRecord {
  const canonical = canonicalProjectTaskControlCanaryFence(input);
  const fingerprint = projectTaskControlCanaryFenceFingerprint(canonical);
  return {
    blockerId: projectBlockerId('task_control', TASK_CONTROL_CANARY_QUARANTINE_CODE),
    source: 'task_control', code: TASK_CONTROL_CANARY_QUARANTINE_CODE,
    summary: JSON.stringify({ ...canonical, fingerprint }), openedAt,
    taskGuid: canonical.taskGuid, eventId: canonical.dispatchOperationId,
  };
}

export function projectTaskControlCanaryAbandonedRecord(
  input: ProjectTaskControlCanaryFenceInput,
  abandonment: {
    authorizationRef: string;
    authorizedByOpenId: string;
    abandonedAt: string;
    phaseBDispatchRoot?: string | null;
  },
  openedAt: string,
): ProjectBlockerRecord {
  const fence = canonicalProjectTaskControlCanaryFence(input);
  const authorizationRef = abandonment.authorizationRef.trim();
  const authorizedByOpenId = abandonment.authorizedByOpenId.trim();
  const abandonedAt = new Date(abandonment.abandonedAt).toISOString();
  if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(authorizationRef)
    || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(authorizedByOpenId)) {
    throw new Error('project_task_control_canary_abandonment_authorization_invalid');
  }
  const fenceFingerprint = projectTaskControlCanaryFenceFingerprint(fence);
  const hasPhaseBDispatchRoot = Object.hasOwn(abandonment, 'phaseBDispatchRoot');
  const phaseBDispatchRoot = abandonment.phaseBDispatchRoot === null
    ? null
    : abandonment.phaseBDispatchRoot?.trim();
  if (hasPhaseBDispatchRoot && phaseBDispatchRoot !== null
    && !/^om_[A-Za-z0-9_-]{1,128}$/.test(phaseBDispatchRoot ?? '')) {
    throw new Error('project_task_control_canary_abandonment_phase_b_root_invalid');
  }
  let summary: ProjectTaskControlCanaryAbandonment;
  if (hasPhaseBDispatchRoot) {
    const canonical = {
      schemaVersion: 'TaskControlCanaryAbandoned.v2' as const,
      fence,
      fenceFingerprint,
      phaseBDispatchRoot: phaseBDispatchRoot ?? null,
      authorizationRef,
      authorizedByOpenId,
      abandonedAt,
    };
    summary = {
      ...canonical,
      fingerprint: `tcca2:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`,
    };
  } else {
    summary = {
      schemaVersion: 'TaskControlCanaryAbandoned.v1',
      fence,
      fenceFingerprint,
      authorizationRef,
      authorizedByOpenId,
      abandonedAt,
    };
  }
  return {
    blockerId: projectBlockerId('task_control', TASK_CONTROL_CANARY_QUARANTINE_CODE),
    source: 'task_control', code: TASK_CONTROL_CANARY_ABANDONED_CODE,
    summary: JSON.stringify(summary), openedAt,
    taskGuid: fence.taskGuid, eventId: fence.dispatchOperationId,
  };
}

export function projectTaskControlCanaryAbandonmentFromRecord(
  record: ProjectBlockerRecord,
): ProjectTaskControlCanaryAbandonment {
  try {
    const parsed = JSON.parse(record.summary) as ProjectTaskControlCanaryAbandonment;
    const expected = projectTaskControlCanaryAbandonedRecord(parsed.fence, {
      authorizationRef: parsed.authorizationRef,
      authorizedByOpenId: parsed.authorizedByOpenId,
      abandonedAt: parsed.abandonedAt,
      ...(parsed.schemaVersion === 'TaskControlCanaryAbandoned.v2'
        ? { phaseBDispatchRoot: parsed.phaseBDispatchRoot }
        : {}),
    }, record.openedAt);
    if ((parsed.schemaVersion !== 'TaskControlCanaryAbandoned.v1'
      && parsed.schemaVersion !== 'TaskControlCanaryAbandoned.v2')
      || record.source !== expected.source
      || record.code !== TASK_CONTROL_CANARY_ABANDONED_CODE
      || record.blockerId !== expected.blockerId || record.eventId !== expected.eventId
      || record.taskGuid !== expected.taskGuid || record.summary !== expected.summary) {
      throw new Error('project_task_control_canary_abandonment_conflict');
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'project_task_control_canary_abandonment_conflict') {
      throw error;
    }
    throw new Error('project_task_control_canary_abandonment_conflict');
  }
}

export function projectTaskControlCanaryAbandonmentRejectsRoot(
  abandonment: ProjectTaskControlCanaryAbandonment,
  dispatchRoot: string,
  recoverablePhaseBRoots: readonly string[],
): boolean {
  if (dispatchRoot === abandonment.fence.phaseA.historicalDispatchRoot) return true;
  const recoveredRoots = [...new Set(recoverablePhaseBRoots.map(root => root.trim()).filter(Boolean))];
  if (abandonment.schemaVersion === 'TaskControlCanaryAbandoned.v2') {
    return dispatchRoot === abandonment.phaseBDispatchRoot || recoveredRoots.includes(dispatchRoot);
  }
  if (recoveredRoots.length !== 1) return true;
  return dispatchRoot === recoveredRoots[0];
}

function blockerOrder(left: ProjectBlockerRecord, right: ProjectBlockerRecord): number {
  return left.source.localeCompare(right.source)
    || left.openedAt.localeCompare(right.openedAt)
    || left.blockerId.localeCompare(right.blockerId);
}

function normalizedBlockerRecords(records: readonly ProjectBlockerRecord[]): ProjectBlockerRecord[] {
  return records.map(record => {
    if (!record || typeof record !== 'object' || !record.blockerId?.trim() || !record.summary?.trim()
      || !['manual', 'task_control', 'human_action'].includes(record.source)
      || !Number.isFinite(Date.parse(record.openedAt))) {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has an invalid blocker record`);
    }
    return { ...record, blockerId: record.blockerId.trim(), summary: record.summary.trim() };
  }).sort(blockerOrder);
}

export function projectBlockerRecordFingerprint(record: ProjectBlockerRecord): string {
  const normalized = normalizedBlockerRecords([record])[0]!;
  if (normalized.code === TASK_CONTROL_CANARY_ABANDONED_CODE) {
    projectTaskControlCanaryAbandonmentFromRecord(normalized);
  }
  const canonical = {
    blockerId: normalized.blockerId,
    source: normalized.source,
    summary: normalized.summary,
    openedAt: normalized.openedAt,
    ...(normalized.taskGuid ? { taskGuid: normalized.taskGuid } : {}),
    ...(normalized.eventId ? { eventId: normalized.eventId } : {}),
    ...(normalized.code ? { code: normalized.code } : {}),
  };
  return `pcbr1:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function normalizedProjectBlockerRetirements(value: unknown): ProjectBlockerRetirement[] {
  const invalid = 'project_task_control_canary_abandoned_retirement_history_invalid';
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(invalid);
  const seen = new Set<string>();
  return value.map(raw => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(invalid);
      const retirement = raw as ProjectBlockerRetirement;
      const reason = typeof retirement.reason === 'string'
        ? Array.from(retirement.reason.trim()).slice(0, 160).join('')
        : '';
      projectTaskControlCanaryAbandonmentFromRecord(retirement.record);
      const recordFingerprint = projectBlockerRecordFingerprint(retirement.record);
      const valid = retirement.schemaVersion === 'ProjectBlockerRetirement.v1'
        && /^pcbr1:[a-f0-9]{64}$/.test(retirement.recordFingerprint)
        && retirement.recordFingerprint === recordFingerprint
        && typeof retirement.authorizationRef === 'string'
        && /^om_[A-Za-z0-9_-]{1,128}$/.test(retirement.authorizationRef)
        && typeof retirement.authorizedByOpenId === 'string'
        && /^ou_[A-Za-z0-9_-]{1,128}$/.test(retirement.authorizedByOpenId)
        && typeof retirement.retiredBySessionId === 'string'
        && /^[A-Za-z0-9_-]{1,160}$/.test(retirement.retiredBySessionId)
        && Number.isFinite(Date.parse(retirement.retiredAt))
        && new Date(retirement.retiredAt).toISOString() === retirement.retiredAt
        && reason.length > 0
        && reason === retirement.reason;
      if (!valid || seen.has(retirement.recordFingerprint)) throw new Error(invalid);
      seen.add(retirement.recordFingerprint);
      return {
        schemaVersion: 'ProjectBlockerRetirement.v1',
        record: structuredClone(retirement.record),
        recordFingerprint,
        authorizationRef: retirement.authorizationRef,
        authorizedByOpenId: retirement.authorizedByOpenId,
        reason,
        retiredAt: retirement.retiredAt,
        retiredBySessionId: retirement.retiredBySessionId,
      };
    } catch {
      throw new Error(invalid);
    }
  });
}

function blockerSummaries(records: readonly ProjectBlockerRecord[]): string[] {
  return records.map(record => record.summary);
}

function normalizedCompletionGates(value: unknown): ProjectCompletionGate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid completion gates`);
  const seen = new Set<string>();
  const gates = value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid completion gate`);
    }
    const gate = raw as ProjectCompletionGate;
    const definition = {
      gateId: typeof gate.gateId === 'string' ? gate.gateId.trim() : '',
      sourceChatId: typeof gate.sourceChatId === 'string' ? gate.sourceChatId.trim() : '',
      dispatchRoot: typeof gate.dispatchRoot === 'string' ? gate.dispatchRoot.trim() : '',
      taskGuid: typeof gate.taskGuid === 'string' ? gate.taskGuid.trim() : '',
    };
    const evidence = gate.evidence;
    const retirement = gate.retirement;
    const evidenceValid = evidence !== undefined
      && Number.isSafeInteger(evidence.sourceProjectRevision) && evidence.sourceProjectRevision > 0
      && !!evidence.reviewerVerdictId?.trim()
      && !!evidence.terminalEventId?.trim()
      && !!evidence.deliveryReceiptId?.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(definition.gateId)
      || seen.has(definition.gateId)
      || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(definition.sourceChatId)
      || !/^om_[A-Za-z0-9_-]{1,128}$/.test(definition.dispatchRoot)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(definition.taskGuid)
      || !gate.label?.trim()
      || gate.definitionFingerprint !== projectCompletionGateFingerprint(definition)
      || !['pending', 'blocked', 'satisfied'].includes(gate.status)
      || !gate.reason?.trim()
      || !Number.isFinite(Date.parse(gate.createdAt))
      || !Number.isFinite(Date.parse(gate.updatedAt))
      || (gate.checkedAt !== undefined && !Number.isFinite(Date.parse(gate.checkedAt)))
      || (gate.validUntil !== undefined && !Number.isFinite(Date.parse(gate.validUntil)))
      || (gate.status === 'satisfied' && (!gate.checkedAt || !gate.validUntil || !evidenceValid
        || Date.parse(gate.validUntil) <= Date.parse(gate.checkedAt)))
      || (gate.status !== 'satisfied' && (evidence !== undefined || gate.validUntil !== undefined))) {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid completion gate`);
    }
    if (retirement !== undefined && (
      !retirement || typeof retirement !== 'object' || Array.isArray(retirement)
      || !Number.isFinite(Date.parse(retirement.retiredAt))
      || !retirement.retiredBySessionId?.trim()
      || !/^om_[A-Za-z0-9_-]{1,128}$/.test(retirement.authorizationRef?.trim())
      || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(retirement.authorizedByOpenId?.trim())
      || !retirement.reason?.trim()
      || (retirement.replacementGateId !== undefined
        && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(retirement.replacementGateId.trim()))
    )) {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid completion gate retirement`);
    }
    if (gate.replacesGateId !== undefined
      && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(gate.replacesGateId.trim())) {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid completion gate replacement`);
    }
    seen.add(definition.gateId);
    return {
      ...gate,
      gateId: definition.gateId,
      sourceChatId: definition.sourceChatId,
      dispatchRoot: definition.dispatchRoot,
      taskGuid: definition.taskGuid,
      label: gate.label.trim(),
      reason: gate.reason.trim(),
      ...(retirement ? { retirement: {
        ...retirement,
        retiredAt: new Date(retirement.retiredAt).toISOString(),
        retiredBySessionId: retirement.retiredBySessionId.trim(),
        authorizationRef: retirement.authorizationRef.trim(),
        authorizedByOpenId: retirement.authorizedByOpenId.trim(),
        reason: retirement.reason.trim(),
        ...(retirement.replacementGateId
          ? { replacementGateId: retirement.replacementGateId.trim() }
          : {}),
      } } : {}),
      ...(gate.replacesGateId ? { replacesGateId: gate.replacesGateId.trim() } : {}),
    };
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.gateId.localeCompare(right.gateId));
  const byId = new Map(gates.map(gate => [gate.gateId, gate]));
  for (const gate of gates) {
    const replacementGateId = gate.retirement?.replacementGateId;
    if (replacementGateId) {
      const replacement = byId.get(replacementGateId);
      if (!replacement || replacement.replacesGateId !== gate.gateId) {
        throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid completion gate replacement chain`);
      }
    }
    if (gate.replacesGateId) {
      const replaced = byId.get(gate.replacesGateId);
      if (!replaced?.retirement || replaced.retirement.replacementGateId !== gate.gateId) {
        throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid completion gate replacement chain`);
      }
    }
  }
  for (const gate of gates) {
    const chain = new Set<string>();
    let cursor: ProjectCompletionGate | undefined = gate;
    while (cursor) {
      if (chain.has(cursor.gateId)) {
        throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid completion gate replacement chain`);
      }
      chain.add(cursor.gateId);
      cursor = cursor.replacesGateId ? byId.get(cursor.replacesGateId) : undefined;
    }
  }
  return gates;
}

function normalizedReviewerReplacements(value: unknown): ProjectReviewerReplacement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid reviewer replacements`);
  }
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid reviewer replacement`);
    }
    const record = raw as ProjectReviewerReplacement;
    if (!/^cli_[A-Za-z0-9_-]{1,128}$/.test(record.oldReviewerAppId?.trim())
      || !/^cli_[A-Za-z0-9_-]{1,128}$/.test(record.newReviewerAppId?.trim())
      || record.oldReviewerAppId.trim() === record.newReviewerAppId.trim()
      || !/^om_[A-Za-z0-9_-]{1,128}$/.test(record.authorizationRef?.trim())
      || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(record.authorizedByOpenId?.trim())
      || !record.reason?.trim() || !record.coordinatorSessionId?.trim()
      || !Number.isFinite(Date.parse(record.replacedAt))
      || !Number.isSafeInteger(record.fromRevision) || record.fromRevision < 1
      || !Number.isSafeInteger(record.toRevision) || record.toRevision !== record.fromRevision + 1) {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid reviewer replacement`);
    }
    return {
      ...record,
      oldReviewerAppId: record.oldReviewerAppId.trim(),
      newReviewerAppId: record.newReviewerAppId.trim(),
      authorizationRef: record.authorizationRef.trim(),
      authorizedByOpenId: record.authorizedByOpenId.trim(),
      reason: record.reason.trim(),
      coordinatorSessionId: record.coordinatorSessionId.trim(),
      replacedAt: new Date(record.replacedAt).toISOString(),
    };
  });
}

function normalizedReviewerReplacementReceipts(
  value: unknown,
): ProjectReviewerReplacementReceipt[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid reviewer replacement receipts`);
  }
  const seen = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid reviewer replacement receipt`);
    }
    const receipt = raw as ProjectReviewerReplacementReceipt;
    if (!/^prr1:[a-f0-9]{64}$/.test(receipt.operationFingerprint)
      || seen.has(receipt.operationFingerprint)
      || !Number.isSafeInteger(receipt.fromRevision) || receipt.fromRevision < 1
      || !Number.isSafeInteger(receipt.toRevision) || receipt.toRevision !== receipt.fromRevision + 1) {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid reviewer replacement receipt`);
    }
    seen.add(receipt.operationFingerprint);
    return { ...receipt };
  });
}

const PROJECT_WORKSTREAM_ARCHIVE_KEYS = new Set([
  'archivedFromStatus', 'archivedAt', 'archiveReason',
  'archiveAuthorizationRef', 'archivedByOpenId',
]);

function normalizedProjectWorkstreamArchive(
  workstream: ProjectWorkstream,
): ProjectWorkstreamArchive | undefined {
  const keys = Object.keys(workstream);
  if (keys.some(key => (key.startsWith('archive') || key.startsWith('archived'))
    && !PROJECT_WORKSTREAM_ARCHIVE_KEYS.has(key))) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid workstream archive metadata`);
  }
  const present = [...PROJECT_WORKSTREAM_ARCHIVE_KEYS].filter(key => Object.hasOwn(workstream, key));
  if (present.length === 0) {
    if (workstream.status === 'cancelled') {
      throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid workstream archive metadata`);
    }
    return undefined;
  }
  const archive = workstream as ProjectWorkstream & ProjectWorkstreamArchive;
  if (present.length !== PROJECT_WORKSTREAM_ARCHIVE_KEYS.size
    || workstream.status !== 'cancelled'
    || archive.archivedFromStatus !== 'failed'
    || !Number.isFinite(Date.parse(archive.archivedAt))
    || typeof archive.archiveReason !== 'string' || !archive.archiveReason.trim()
    || Array.from(archive.archiveReason.trim()).length > 160
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(archive.archiveAuthorizationRef?.trim())
    || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(archive.archivedByOpenId?.trim())) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid workstream archive metadata`);
  }
  return {
    archivedFromStatus: 'failed',
    archivedAt: new Date(archive.archivedAt).toISOString(),
    archiveReason: archive.archiveReason.trim(),
    archiveAuthorizationRef: archive.archiveAuthorizationRef.trim(),
    archivedByOpenId: archive.archivedByOpenId.trim(),
  };
}

export function projectCompletionGateFingerprint(input: Pick<
  ProjectCompletionGate,
  'gateId' | 'sourceChatId' | 'dispatchRoot' | 'taskGuid'
>): string {
  return `pcg1:${createHash('sha256').update(JSON.stringify({
    gateId: input.gateId,
    sourceChatId: input.sourceChatId,
    dispatchRoot: input.dispatchRoot,
    taskGuid: input.taskGuid,
  })).digest('hex')}`;
}

export function refreshProjectBlockerProjection(project: ProjectGroupState): void {
  project.blockerRecords = normalizedBlockerRecords(project.blockerRecords);
  project.blockers = blockerSummaries(project.blockerRecords);
}

export function projectCompletionGateOpen(gate: ProjectCompletionGate, nowMs = Date.now()): boolean {
  if (gate.retirement) return false;
  const validUntil = gate.validUntil ? Date.parse(gate.validUntil) : Number.NaN;
  return gate.status !== 'satisfied' || !Number.isFinite(validUntil) || validUntil <= nowMs;
}

export function activeProjectCompletionGates(project: ProjectGroupState): ProjectCompletionGate[] {
  return (project.completionGates ?? []).filter(gate => !gate.retirement);
}

export function projectCompletionGatesOpen(project: ProjectGroupState, nowMs = Date.now()): boolean {
  return activeProjectCompletionGates(project).some(gate => projectCompletionGateOpen(gate, nowMs));
}

function migrateProject(project: unknown): ProjectGroupState {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} has an invalid project`);
  }
  const raw = project as Record<string, unknown>;
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} has an unsupported project schema`);
  }
  const legacyBlockers = Array.isArray(raw.blockers) && raw.blockers.every(item => typeof item === 'string')
    ? raw.blockers as string[]
    : undefined;
  if (!legacyBlockers) throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid blockers`);
  const updatedAt = typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt))
    ? raw.updatedAt
    : new Date(0).toISOString();
  const records = raw.schemaVersion === 3
    ? normalizedBlockerRecords(Array.isArray(raw.blockerRecords) ? raw.blockerRecords as ProjectBlockerRecord[] : [])
    : normalizedBlockerRecords(legacyBlockers.map((summary, index) => ({
        blockerId: `manual:legacy:${String(index).padStart(4, '0')}:${createHash('sha256').update(summary).digest('hex').slice(0, 16)}`,
        source: 'manual' as const,
        summary,
        openedAt: updatedAt,
      })));
  const projected = blockerSummaries(records);
  if (raw.schemaVersion === 3 && JSON.stringify(legacyBlockers) !== JSON.stringify(projected)) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} blocker projection mismatch`);
  }
  const stageAdvanceEvents = normalizeProjectStageAdvanceEvents(raw.stageAdvanceEvents);
  if (stageAdvanceEvents.some(event => event.chatId !== raw.chatId)) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} has a stage advance chat mismatch`);
  }
  const workstreams = Array.isArray(raw.workstreams)
    ? (raw.workstreams as ProjectWorkstream[]).map(workstream => {
        if (!['pending', 'in_progress', 'in_review', 'blocked', 'completed', 'failed', 'cancelled']
          .includes(workstream.status)) {
          throw new Error(`${PROJECT_GROUP_STORE_FILE} has invalid workstream status`);
        }
        const reviewerReplacements = normalizedReviewerReplacements(workstream.reviewerReplacements);
        const reviewerReplacementReceipts = normalizedReviewerReplacementReceipts(
          workstream.reviewerReplacementReceipts,
        );
        const archive = normalizedProjectWorkstreamArchive(workstream);
        return {
          ...workstream,
          ...(reviewerReplacements ? { reviewerReplacements } : {}),
          ...(reviewerReplacementReceipts ? { reviewerReplacementReceipts } : {}),
          ...(archive ?? {}),
        };
      })
    : raw.workstreams;
  const blockerRetirements = normalizedProjectBlockerRetirements(raw.blockerRetirements);
  const projectFields = { ...raw };
  delete projectFields.blockerRetirements;
  return {
    ...(projectFields as unknown as ProjectGroupState),
    schemaVersion: 3,
    blockers: projected,
    blockerRecords: records,
    ...(blockerRetirements.length > 0 ? { blockerRetirements } : {}),
    completionGates: normalizedCompletionGates(raw.completionGates),
    stageAdvanceEvents,
    workstreams: workstreams as ProjectWorkstream[],
  };
}

function readRegistry(path: string): ProjectGroupRegistry {
  if (!existsSync(path)) return emptyRegistry();
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} must contain an object`);
  }
  const raw = parsed as { schemaVersion?: number; projects?: unknown };
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3)
    || !raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} has an unsupported schema`);
  }
  const projects = Object.fromEntries(Object.entries(raw.projects as Record<string, unknown>).map(([chatId, project]) => [
    chatId, migrateProject(project),
  ]));
  return { schemaVersion: 3, projects };
}

function writeRegistry(path: string, registry: ProjectGroupRegistry): void {
  atomicWriteFileSync(path, JSON.stringify(registry, null, 2), {
    mode: 0o600,
    followTargetSymlink: false,
  });
}

export function readProjectGroup(dataDir: string, chatId: string): ProjectGroupState | undefined {
  return readRegistry(storePath(dataDir)).projects[chatId];
}

export function listProjectGroups(dataDir: string): ProjectGroupState[] {
  return Object.values(readRegistry(storePath(dataDir)).projects).map(project => structuredClone(project));
}

export async function mutateProjectGroup(
  dataDir: string,
  chatId: string,
  mutate: (
    current: ProjectGroupState | undefined,
    registry: ProjectGroupRegistryReader,
  ) => ProjectGroupState | undefined | Promise<ProjectGroupState | undefined>,
): Promise<ProjectGroupState | undefined> {
  const path = storePath(dataDir);
  let result: ProjectGroupState | undefined;
  await withFileLock(path, async () => {
    const registry = readRegistry(path);
    const stored = registry.projects[chatId];
    const next = await mutate(stored ? structuredClone(stored) : undefined, {
      readProject: sourceChatId => {
        const source = registry.projects[sourceChatId];
        return source ? structuredClone(source) : undefined;
      },
    });
    if (next === undefined) {
      if (!stored) {
        result = undefined;
        return;
      }
      delete registry.projects[chatId];
      result = undefined;
    } else {
      refreshProjectBlockerProjection(next);
      if (stored && JSON.stringify(next) === JSON.stringify(stored)) {
        result = structuredClone(stored);
        return;
      }
      registry.projects[chatId] = next;
      result = structuredClone(next);
    }
    writeRegistry(path, registry);
  });
  return result;
}

export function mutateProjectGroupSync(
  dataDir: string,
  chatId: string,
  mutate: (
    current: ProjectGroupState | undefined,
    registry: ProjectGroupRegistryReader,
  ) => ProjectGroupState | undefined,
): ProjectGroupState | undefined {
  const path = storePath(dataDir);
  return withFileLockSync(path, () => {
    const registry = readRegistry(path);
    const stored = registry.projects[chatId];
    const next = mutate(stored ? structuredClone(stored) : undefined, {
      readProject: sourceChatId => {
        const source = registry.projects[sourceChatId];
        return source ? structuredClone(source) : undefined;
      },
    });
    if (next === undefined) {
      if (stored) {
        delete registry.projects[chatId];
        writeRegistry(path, registry);
      }
      return undefined;
    }
    refreshProjectBlockerProjection(next);
    if (stored && JSON.stringify(next) === JSON.stringify(stored)) return structuredClone(stored);
    registry.projects[chatId] = next;
    writeRegistry(path, registry);
    return structuredClone(next);
  });
}

export function projectOverallProgress(project: ProjectGroupState): number {
  if (project.status === 'completed') return 100;
  const gated = projectCompletionGatesOpen(project);
  if (project.manualProgress !== undefined) return gated ? Math.min(project.manualProgress, 99) : project.manualProgress;
  if (project.workstreams.length === 0) return 0;
  const total = project.workstreams.reduce((sum, item) => sum + item.progress, 0);
  const progress = Math.round(total / project.workstreams.length);
  return gated ? Math.min(progress, 99) : progress;
}

export function projectRemainingSummary(project: ProjectGroupState): string {
  if (project.remaining?.trim()) return project.remaining.trim();
  const openGates = activeProjectCompletionGates(project).filter(gate => projectCompletionGateOpen(gate)).length;
  if (openGates > 0) return `${openGates} 个父级完成门`;
  if (project.workstreams.length === 0) return project.status === 'completed' ? '无' : '待拆解';
  const pending = project.workstreams.filter(
    item => item.status !== 'completed' && item.status !== 'cancelled',
  ).length;
  return pending === 0 ? '无' : `${pending} 个子任务`;
}
