import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { loadDashboardSecret } from '../dashboard/auth.js';
import {
  dispatchReportBindingSecretPath,
  verifyDispatchReportBinding,
} from '../core/dispatch-report-binding.js';
import { localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';
import {
  buildProjectGroupCard,
  buildProjectGroupOnboardingCard,
  buildProjectGroupStartedNoticeCard,
  type ProjectGroupOnboardingCardInput,
} from '../im/lark/project-group-card.js';
import type { Brand } from '../im/lark/lark-hosts.js';
import {
  normalizeDispatchWriteScopes,
  projectDispatchAccessConflicts,
  type ProjectDispatchAccess,
} from '../core/dispatch-write-scope.js';
import {
  buildTaskControlKickoffContent,
} from '../core/dispatch.js';
import { loadDaemonIpcSecret } from '../core/daemon-ipc-auth.js';
import {
  activateTaskControlTurnAdmissionSync,
  beginTaskControlPhaseAInstructionSync,
  claimTaskControlPhaseAFailedReportSync,
  claimTaskControlTurnAdmissionPendingSync,
  completeTaskControlPhaseAInstructionSync,
  createDispatchOperationId,
  findDispatchOperation,
  listDispatchOperations,
  openTaskControlTurnAdmissions,
  readTaskControlPhaseAFailedReport,
  readTaskControlPhaseAOperation,
  readTaskControlKickoffOperation,
  readTaskControlSeedOperation,
  readTaskControlSuccessCertificate,
  readTaskControlTurnAdmission,
  persistTaskControlSuccessCertificateSync,
  type TaskControlPhaseAAttemptCoordinates,
} from '../core/dispatch-registry.js';
import {
  canonicalProjectTaskControlCanaryFence,
  mutateProjectGroup,
  mutateProjectGroupSync,
  projectBlockerRecordFingerprint,
  projectBlockerId,
  projectCompletionGatesOpen,
  readProjectGroup,
  refreshProjectBlockerProjection,
  projectTaskControlCanaryFenceRecord,
  projectTaskControlCanaryAbandonedRecord,
  projectTaskControlCanaryAbandonmentFromRecord,
  projectTaskControlCanaryAbandonmentRejectsRoot,
  projectTaskControlCanaryFenceFingerprint,
  type ProjectBlockerRecord,
  projectCompletionGateFingerprint,
  type ProjectCompletionGate,
  type ProjectCompletionGateEvidence,
  type ProjectCompletionGateStatus,
  type ProjectDispatchReservation,
  type ProjectGroupState,
  type ProjectGroupStatus,
  type ProjectGroupRegistryReader,
  type ProjectWorkstreamStatus,
  type ProjectTaskControlCanaryFence,
  type ProjectTaskControlCanaryFenceInput,
  TASK_CONTROL_CANARY_ABANDONED_CODE,
  TASK_CONTROL_CANARY_QUARANTINE_CODE,
  withProjectTaskControlChatLock,
  withProjectTaskControlChatLockSync,
} from './project-group-store.js';
import {
  disableTaskControlPlaneForAbandonmentSync,
  readGroupCollaborationMode,
  withGroupCollaborationModeLockSync,
  writeProjectOnboardingCard,
  type ProjectOnboardingCardState,
} from './group-collaboration-mode-store.js';
import type { ProjectCompletionGateEvaluation } from './project-group-completion-gate.js';
import {
  hasExactTaskControlSuccessEvidenceSync,
  hasSettledTaskControlPhaseAEvidenceSync,
  TaskControlPlaneStore,
  type TaskControlSuccessEvidenceInput,
  type TaskControlSuccessEvidenceSnapshot,
} from './task-control-plane-store.js';
import { TaskControlMappingTrust } from './task-control-plane-mapping-trust.js';
import type { ProjectDispatchReservationFactsV1 } from './task-control-plane-project-group-mapping-source.js';
import {
  appendProjectStageAdvanceEvent,
  type ClaimedProjectStageAdvance,
} from './project-stage-auto-advance.js';

export type ProjectCompletionGateEvaluator = (input: {
  parentProject: ProjectGroupState;
  gate: ProjectCompletionGate;
  sourceProject: ProjectGroupState | undefined;
  checkedAt: string;
}) => ProjectCompletionGateEvaluation;

export interface ProjectCoordinatorTransport {
  sendCard(larkAppId: string, chatId: string, cardJson: string): Promise<string>;
  updateCard(larkAppId: string, messageId: string, cardJson: string): Promise<void>;
  pinMessage(larkAppId: string, messageId: string): Promise<boolean>;
  unpinMessage(larkAppId: string, messageId: string): Promise<boolean>;
  resolveThreadId(larkAppId: string, dispatchRoot: string): Promise<string | null>;
  isMessageWithdrawn(error: unknown): boolean;
  isMessageUpdateExpired(error: unknown): boolean;
  brand(larkAppId: string): Brand;
}

export type ProjectCoordinatorAction =
  | { action: 'init'; title: string; goal: string; phase?: string; focus?: string; remaining?: string }
  | { action: 'status' }
  | { action: 'refresh' }
  | {
      action: 'update'; goal?: string; phase?: string; focus?: string; progress?: number;
      remaining?: string; blocker?: string; clearBlockers?: boolean; milestone?: string; nextMilestone?: string;
    }
  | { action: 'close'; milestone?: string; now?: string }
  | { action: 'resume'; phase?: string; focus?: string }
  | {
      action: 'add_completion_gate'; gateId: string; sourceChatId: string; dispatchRoot: string;
      taskGuid: string; label: string; now?: string;
    }
  | {
      action: 'retire_completion_gate'; gateId: string; expectedDefinitionFingerprint: string;
      authorizationRef: string; authorizedByOpenId?: string; reason: string; now?: string;
    }
  | {
      action: 'replace_completion_gate'; gateId: string; expectedDefinitionFingerprint: string;
      newGateId: string; sourceChatId: string; dispatchRoot: string; taskGuid: string;
      label: string; authorizationRef: string; authorizedByOpenId?: string; reason: string; now?: string;
    }
  | {
      action: 'replace_workstream_reviewer'; dispatchRoot: string;
      oldReviewerAppId: string; newReviewerAppId: string; expectedRevision: number;
      authorizationRef: string; authorizedByOpenId?: string; reason: string;
      allowedReviewerAppIds?: string[]; now?: string;
    }
  | {
      action: 'archive_workstream'; dispatchRoot: string; expectedRevision: number;
      authorizationRef: string; archivedByOpenId?: string; reason: string; now?: string;
    }
  | {
      action: 'retire_task_control_canary_abandoned';
      expectedRecordFingerprint: string;
      authorizationRef: string;
      authorizedByOpenId?: string;
      reason: string;
      now?: string;
    }
  | {
      action: 'sync_completion_gate'; gateId: string; definitionFingerprint: string;
      status: ProjectCompletionGateStatus; reason: string; checkedAt: string;
      validUntil?: string;
      evidence?: ProjectCompletionGateEvidence;
    }
  | {
      action: 'reserve_dispatch'; reservationId: string; targetAppIds: string[];
      access: ProjectDispatchAccess; now?: string; ttlMs?: number;
      repositoryLeaseRef?: ProjectDispatchReservation['repositoryLeaseRef'];
      taskControl?: NonNullable<ProjectDispatchReservation['taskControl']>;
      maxActiveTaskControlMappings?: number;
      getTaskControlMappingDecision?: (input: { dispatchRoot: string; taskGuid: string }) => {
        capacityReleased: boolean;
        admissionSafe: boolean;
      };
    }
  | { action: 'install_task_control_canary_fence'; fence: ProjectTaskControlCanaryFenceInput; now?: string }
  | { action: 'persist_task_control_success_certificate'; fence: ProjectTaskControlCanaryFenceInput; now?: string }
  | {
      action: 'abandon_task_control_canary'; fence: ProjectTaskControlCanaryFenceInput;
      expectedConfigHash: string; authorizationRef: string; authorizedByOpenId: string; now?: string;
    }
  | {
      action: 'clear_task_control_canary_fence'; fence: ProjectTaskControlCanaryFenceInput;
      auditOnlyConfirmedAbsent: boolean;
      cleanupState: 'pre_dispatch_abort' | 'phase_a_terminal_no_canary' | 'delivered_terminal';
      successCertificateHash?: string;
      now?: string;
    }
  | {
      action: 'claim_task_control_turn_admission';
      claim: { messageId: string; dispatchRoot: string; targetAppId: string; sessionId: string; workerGeneration: number };
      now?: string;
    }
  | {
      action: 'begin_task_control_phase_a_instruction';
      fenceFingerprint: string;
      instructionTemplateSha256: string;
      attempt: TaskControlPhaseAAttemptCoordinates;
    }
  | {
      action: 'complete_task_control_phase_a_instruction';
      fenceFingerprint: string;
      messageId: string;
    }
  | {
      action: 'commit_dispatch'; reservationId: string; targetAppIds: string[]; dispatchRoot: string;
      title: string; purpose?: string; owners?: string[]; workerAppIds?: string[]; reviewerAppIds?: string[];
      repositoryLeaseRef?: ProjectDispatchReservation['repositoryLeaseRef'];
    }
  | {
      action: 'bind_dispatch_root'; reservationId: string; targetAppIds: string[];
      dispatchRoot: string; rootCreateTime: string;
    }
  | {
      action: 'mark_task_control_mapping'; dispatchRoot: string; taskGuid: string; mappingRef: string;
      status: 'registered' | 'rejected'; registeredAt?: string; failureCode?: string;
    }
  | { action: 'abort_dispatch'; reservationId: string; targetAppIds: string[] }
  | { action: 'fail_dispatch'; dispatchRoot: string; reason: string }
  | {
      action: 'dispatch'; dispatchRoot: string; title: string; purpose?: string; owners?: string[];
      status?: ProjectWorkstreamStatus; progress?: number;
    }
  | {
      action: 'report'; dispatchRoot: string; content: string; status?: ProjectWorkstreamStatus;
      progress?: number; remaining?: string; milestone?: string; reporterAppId?: string;
      reviewVerdict?: 'pass' | 'fail'; reviewRound?: number;
      repositoryLeaseRef?: ProjectDispatchReservation['repositoryLeaseRef'];
      phaseAReport?: {
        operationId: string; fenceFingerprint: string; sourceSessionId: string;
        sourceTurnId: string; workerGeneration: number; reportRequestId: string;
      };
    };

export interface ProjectCoordinatorContext {
  dataDir: string;
  chatId: string;
  larkAppId: string;
  coordinatorSessionId: string;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] as string : undefined;
}

function workstreamStatus(value: unknown): ProjectWorkstreamStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'in_review' || value === 'blocked'
    || value === 'completed' || value === 'failed'
    ? value
    : undefined;
}

function phaseAReportProof(value: unknown): NonNullable<Extract<
  ProjectCoordinatorAction,
  { action: 'report' }
>['phaseAReport']> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proof = value as Record<string, unknown>;
  const operationId = stringField(proof, 'operationId');
  const fenceFingerprint = stringField(proof, 'fenceFingerprint');
  const sourceSessionId = stringField(proof, 'sourceSessionId');
  const sourceTurnId = stringField(proof, 'sourceTurnId');
  const reportRequestId = stringField(proof, 'reportRequestId');
  const workerGeneration = proof.workerGeneration;
  if (JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify([
    'fenceFingerprint', 'operationId', 'reportRequestId', 'sourceSessionId',
    'sourceTurnId', 'workerGeneration',
  ])
    || !operationId || !fenceFingerprint || !sourceSessionId || !sourceTurnId || !reportRequestId
    || !Number.isSafeInteger(workerGeneration) || (workerGeneration as number) < 1) {
    return undefined;
  }
  return {
    operationId, fenceFingerprint, sourceSessionId, sourceTurnId,
    workerGeneration: workerGeneration as number, reportRequestId,
  };
}

function parsedRepositoryLeaseRef(
  value: unknown,
): ProjectDispatchReservation['repositoryLeaseRef'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(ref).sort()) !== JSON.stringify([
    'fencingToken', 'leaseId', 'repoKey', 'workingDir',
  ])
    || typeof ref.repoKey !== 'string' || !/^[a-f0-9]{64}$/.test(ref.repoKey)
    || typeof ref.leaseId !== 'string' || ref.leaseId.length < 1 || ref.leaseId.length > 128
    || !Number.isSafeInteger(ref.fencingToken) || (ref.fencingToken as number) < 1
    || typeof ref.workingDir !== 'string' || !isAbsolute(ref.workingDir)) return undefined;
  return {
    repoKey: ref.repoKey,
    leaseId: ref.leaseId,
    fencingToken: ref.fencingToken as number,
    workingDir: ref.workingDir,
  };
}

export function parseProjectCoordinatorAction(raw: unknown): ProjectCoordinatorAction | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const action = body.action;
  if (action === 'init') {
    const title = stringField(body, 'title');
    const goal = stringField(body, 'goal');
    if (!title || !goal) return undefined;
    return {
      action, title, goal, phase: stringField(body, 'phase'), focus: stringField(body, 'focus'),
      remaining: stringField(body, 'remaining'),
    };
  }
  if (action === 'status') return { action };
  if (action === 'update') {
    const progress = body.progress === undefined || typeof body.progress === 'number' ? body.progress as number | undefined : undefined;
    if (body.progress !== undefined && progress === undefined) return undefined;
    return {
      action, goal: stringField(body, 'goal'), phase: stringField(body, 'phase'), focus: stringField(body, 'focus'),
      progress, remaining: stringField(body, 'remaining'), blocker: stringField(body, 'blocker'),
      clearBlockers: body.clearBlockers === true, milestone: stringField(body, 'milestone'),
      nextMilestone: stringField(body, 'nextMilestone'),
    };
  }
  if (action === 'close') return { action, milestone: stringField(body, 'milestone') };
  if (action === 'resume') return { action, phase: stringField(body, 'phase'), focus: stringField(body, 'focus') };
  if (action === 'add_completion_gate') {
    const gateId = stringField(body, 'gateId');
    const sourceChatId = stringField(body, 'sourceChatId');
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const taskGuid = stringField(body, 'taskGuid');
    const label = stringField(body, 'label');
    if (!gateId || !sourceChatId || !dispatchRoot || !taskGuid || !label) return undefined;
    return { action, gateId, sourceChatId, dispatchRoot, taskGuid, label };
  }
  if (action === 'retire_completion_gate') {
    const gateId = stringField(body, 'gateId');
    const expectedDefinitionFingerprint = stringField(body, 'expectedDefinitionFingerprint');
    const authorizationRef = stringField(body, 'authorizationRef');
    const reason = stringField(body, 'reason');
    if (!gateId || !expectedDefinitionFingerprint || !authorizationRef || !reason) return undefined;
    return { action, gateId, expectedDefinitionFingerprint, authorizationRef, reason };
  }
  if (action === 'replace_completion_gate') {
    const gateId = stringField(body, 'gateId');
    const expectedDefinitionFingerprint = stringField(body, 'expectedDefinitionFingerprint');
    const newGateId = stringField(body, 'newGateId');
    const sourceChatId = stringField(body, 'sourceChatId');
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const taskGuid = stringField(body, 'taskGuid');
    const label = stringField(body, 'label');
    const authorizationRef = stringField(body, 'authorizationRef');
    const reason = stringField(body, 'reason');
    if (!gateId || !expectedDefinitionFingerprint || !newGateId || !sourceChatId
      || !dispatchRoot || !taskGuid || !label || !authorizationRef || !reason) return undefined;
    return {
      action, gateId, expectedDefinitionFingerprint, newGateId,
      sourceChatId, dispatchRoot, taskGuid, label, authorizationRef, reason,
    };
  }
  if (action === 'replace_workstream_reviewer') {
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const oldReviewerAppId = stringField(body, 'oldReviewerAppId');
    const newReviewerAppId = stringField(body, 'newReviewerAppId');
    const expectedRevision = body.expectedRevision;
    const authorizationRef = stringField(body, 'authorizationRef');
    const reason = stringField(body, 'reason');
    if (!dispatchRoot || !oldReviewerAppId || !newReviewerAppId
      || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1
      || !authorizationRef || !reason) return undefined;
    return {
      action, dispatchRoot, oldReviewerAppId, newReviewerAppId,
      expectedRevision: expectedRevision as number, authorizationRef, reason,
    };
  }
  if (action === 'archive_workstream') {
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const expectedRevision = body.expectedRevision;
    const authorizationRef = stringField(body, 'authorizationRef');
    const reason = stringField(body, 'reason');
    if (!dispatchRoot
      || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1
      || !authorizationRef || !reason) return undefined;
    return {
      action, dispatchRoot, expectedRevision: expectedRevision as number,
      authorizationRef, reason,
    };
  }
  if (action === 'retire_task_control_canary_abandoned') {
    const expectedRecordFingerprint = stringField(body, 'expectedRecordFingerprint');
    const authorizationRef = stringField(body, 'authorizationRef');
    const reason = stringField(body, 'reason');
    if (!expectedRecordFingerprint || !authorizationRef || !reason) return undefined;
    return { action, expectedRecordFingerprint, authorizationRef, reason };
  }
  if (action === 'dispatch') {
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const title = stringField(body, 'title');
    const status = workstreamStatus(body.status);
    if (!dispatchRoot || (body.status !== undefined && !status)) return undefined;
    const owners = Array.isArray(body.owners)
      ? body.owners.filter((owner): owner is string => typeof owner === 'string')
      : undefined;
    const progress = body.progress === undefined || typeof body.progress === 'number' ? body.progress as number | undefined : undefined;
    if (body.progress !== undefined && progress === undefined) return undefined;
    return { action, dispatchRoot, title: title ?? '', purpose: stringField(body, 'purpose'), owners, status, progress };
  }
  if (action === 'report') {
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const content = stringField(body, 'content');
    const status = workstreamStatus(body.status);
    if (!dispatchRoot || !content || (body.status !== undefined && !status)) return undefined;
    const progress = body.progress === undefined || typeof body.progress === 'number' ? body.progress as number | undefined : undefined;
    if (body.progress !== undefined && progress === undefined) return undefined;
    const hasReviewVerdict = Object.hasOwn(body, 'reviewVerdict');
    const hasReviewRound = Object.hasOwn(body, 'reviewRound');
    if (hasReviewVerdict !== hasReviewRound
      || (hasReviewVerdict && body.reviewVerdict !== 'pass' && body.reviewVerdict !== 'fail')
      || (hasReviewRound && (!Number.isSafeInteger(body.reviewRound) || (body.reviewRound as number) <= 0))) {
      return undefined;
    }
    const hasPhaseAReport = Object.hasOwn(body, 'phaseAReport');
    const phaseAReport = hasPhaseAReport ? phaseAReportProof(body.phaseAReport) : undefined;
    if (hasPhaseAReport && !phaseAReport) return undefined;
    const hasRepositoryLeaseRef = Object.hasOwn(body, 'repositoryLeaseRef');
    const repositoryLeaseRef = hasRepositoryLeaseRef
      ? parsedRepositoryLeaseRef(body.repositoryLeaseRef)
      : undefined;
    if (hasRepositoryLeaseRef && !repositoryLeaseRef) return undefined;
    return {
      action, dispatchRoot, content, status, progress,
      remaining: stringField(body, 'remaining'), milestone: stringField(body, 'milestone'),
      reporterAppId: stringField(body, 'reporterAppId'),
      reviewVerdict: body.reviewVerdict === 'pass' || body.reviewVerdict === 'fail' ? body.reviewVerdict : undefined,
      reviewRound: Number.isSafeInteger(body.reviewRound) && (body.reviewRound as number) > 0
        ? body.reviewRound as number : undefined,
      ...(phaseAReport ? { phaseAReport } : {}),
      ...(repositoryLeaseRef ? { repositoryLeaseRef } : {}),
    };
  }
  if (action === 'fail_dispatch') {
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const reason = stringField(body, 'reason');
    return dispatchRoot && reason ? { action, dispatchRoot, reason } : undefined;
  }
  return undefined;
}

const projectQueues = new Map<string, Promise<unknown>>();

function queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  projectQueues.set(key, next);
  const cleanup = () => {
    if (projectQueues.get(key) === next) projectQueues.delete(key);
  };
  void next.then(cleanup, cleanup);
  return next;
}

function nowIso(): string {
  return new Date().toISOString();
}

function taskControlScopeIsEmpty(paths: readonly string[]): boolean {
  const empty = (path: string): boolean => {
    if (!existsSync(path) || !lstatSync(path).isDirectory()) return false;
    return readdirSync(path, { withFileTypes: true }).every(entry => (
      entry.isDirectory() && !entry.isSymbolicLink() && empty(join(path, entry.name))
    ));
  };
  return paths.every(empty);
}

export const PROJECT_DISPATCH_RESERVATION_TTL_MS = 2 * 60_000;

function targetIdentity(targetAppIds: readonly string[]): string[] {
  const normalized = [...new Set(targetAppIds.map(id => id.trim()).filter(Boolean))].sort();
  if (normalized.length === 0) throw new Error('project_dispatch_targets_required');
  return normalized;
}

function sameTargets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRepositoryLeaseRef(
  left: ProjectDispatchReservation['repositoryLeaseRef'],
  right: ProjectDispatchReservation['repositoryLeaseRef'],
): boolean {
  if (!left || !right) return left === right;
  return left.repoKey === right.repoKey
    && left.leaseId === right.leaseId
    && left.fencingToken === right.fencingToken
    && left.workingDir === right.workingDir;
}

function sameAccess(left: ProjectDispatchAccess, right: ProjectDispatchAccess): boolean {
  if (left.mode !== right.mode) return false;
  return left.mode === 'read_only'
    || (right.mode === 'write'
      && left.scopes.length === right.scopes.length
      && left.scopes.every((scope, index) => scope === right.scopes[index]));
}

function sameTaskControlReservation(
  left: ProjectDispatchReservation['taskControl'],
  right: ProjectDispatchReservation['taskControl'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function upsertProjectBlocker(project: ProjectGroupState, record: ProjectBlockerRecord): void {
  const index = project.blockerRecords.findIndex(item => item.blockerId === record.blockerId);
  if (index >= 0) project.blockerRecords[index] = record;
  else project.blockerRecords.push(record);
  refreshProjectBlockerProjection(project);
}

function removeProjectBlocker(project: ProjectGroupState, blockerId: string): void {
  project.blockerRecords = project.blockerRecords.filter(item => item.blockerId !== blockerId);
  refreshProjectBlockerProjection(project);
}

function validatedProjectTaskControlCanaryFence(
  record: ProjectBlockerRecord,
): ProjectTaskControlCanaryFence {
  try {
    const { fingerprint, ...input } = JSON.parse(record.summary);
    const canonical = canonicalProjectTaskControlCanaryFence(input);
    const expectedFingerprint = projectTaskControlCanaryFenceFingerprint(canonical);
    const expected = projectTaskControlCanaryFenceRecord(canonical, record.openedAt);
    if (fingerprint !== expectedFingerprint
      || record.blockerId !== expected.blockerId
      || record.source !== expected.source
      || record.code !== expected.code
      || record.eventId !== expected.eventId
      || record.taskGuid !== expected.taskGuid
      || record.summary !== expected.summary) {
      throw new Error('project_task_control_canary_fence_conflict');
    }
    return canonical;
  } catch {
    throw new Error('project_task_control_canary_fence_conflict');
  }
}

function projectTaskControlCanaryFenceForReservation(
  project: ProjectGroupState,
  reservationId: string,
  taskControlRequested = false,
): ProjectTaskControlCanaryFence | undefined {
  const abandonedRecord = project.blockerRecords.find(
    item => item.code === TASK_CONTROL_CANARY_ABANDONED_CODE,
  );
  if (abandonedRecord) {
    const abandoned = projectTaskControlCanaryAbandonmentFromRecord(abandonedRecord);
    if (taskControlRequested || abandoned.fence.dispatchOperationId === reservationId) {
      throw new Error('project_task_control_canary_abandoned');
    }
  }
  const record = project.blockerRecords.find(
    item => item.code === TASK_CONTROL_CANARY_QUARANTINE_CODE,
  );
  if (!record) return undefined;
  const fence = validatedProjectTaskControlCanaryFence(record);
  if (fence.dispatchOperationId !== reservationId) {
    throw new Error('project_task_control_canary_fence_rejects_reservation');
  }
  return fence;
}

function abandonedTaskControlCanaryRejectsRoot(
  project: ProjectGroupState,
  registryPath: string,
  dispatchRoot: string,
): boolean {
  const record = project.blockerRecords.find(
    item => item.code === TASK_CONTROL_CANARY_ABANDONED_CODE,
  );
  if (!record) return false;
  const abandoned = projectTaskControlCanaryAbandonmentFromRecord(record);
  return projectTaskControlCanaryAbandonmentRejectsRoot(
    abandoned,
    dispatchRoot,
    taskControlCanaryPhaseBRoots(
      project,
      registryPath,
      abandoned.fence,
      record.openedAt,
      abandoned.abandonedAt,
    ),
  );
}

function taskControlCanaryPhaseBRoots(
  project: ProjectGroupState,
  registryPath: string,
  fence: ProjectTaskControlCanaryFenceInput,
  fenceOpenedAt: string,
  observedAt: string,
): string[] {
  const canonicalFence = canonicalProjectTaskControlCanaryFence(fence);
  const fenceFingerprint = projectTaskControlCanaryFenceFingerprint(canonicalFence);
  if (!canonicalIsoTimestamp(fenceOpenedAt) || !canonicalIsoTimestamp(observedAt)
    || Date.parse(fenceOpenedAt) > Date.parse(observedAt)) {
    throw new Error('project_task_control_canary_fence_conflict');
  }
  const seed = readTaskControlSeedOperation(registryPath, canonicalFence.dispatchOperationId);
  if (seed) {
    const expectedPayloadHash = createHash('sha256').update(canonicalFence.seedText).digest('hex');
    const expectedProviderUuid = createDispatchOperationId({
      schemaVersion: 'TaskControlProviderUuid.v1',
      effect: 'seed_root',
      operationId: canonicalFence.dispatchOperationId,
      targetChatId: canonicalFence.targetChatId,
      targetRoot: null,
      messageType: 'text',
      payloadHash: expectedPayloadHash,
    });
    if (seed.operationId !== canonicalFence.dispatchOperationId
      || seed.sourceAppId !== canonicalFence.controllerAppId
      || seed.targetChatId !== canonicalFence.targetChatId
      || seed.messageType !== 'text'
      || seed.payloadHash !== expectedPayloadHash
      || seed.providerUuid !== expectedProviderUuid
      || !taskControlCanaryTimeWithin(seed.attempt.wallTime, fenceOpenedAt, observedAt)
      || seed.state !== 'delivered'
      || !seed.dispatchRoot) {
      throw new Error('project_task_control_canary_fence_conflict');
    }
  }
  const seedRoots = seed ? [seed.dispatchRoot!] : [];
  const kickoff = readTaskControlKickoffOperation(registryPath, canonicalFence.dispatchOperationId);
  if (kickoff) {
    if (!canonicalFence.kickoff) {
      throw new Error('project_task_control_canary_fence_conflict');
    }
    const built = buildTaskControlKickoffContent({
      title: canonicalFence.title,
      brief: canonicalFence.kickoff.brief,
      dispatchRoot: kickoff.dispatchRoot,
      bots: canonicalFence.kickoff.bots,
    });
    const expectedPayloadHash = createHash('sha256').update(built.content).digest('hex');
    const expectedProviderUuid = createDispatchOperationId({
      schemaVersion: 'TaskControlProviderUuid.v1',
      effect: 'kickoff_thread',
      operationId: canonicalFence.dispatchOperationId,
      targetChatId: canonicalFence.targetChatId,
      targetRoot: kickoff.dispatchRoot,
      messageType: 'post',
      payloadHash: expectedPayloadHash,
    });
    if (kickoff.operationId !== canonicalFence.dispatchOperationId
      || kickoff.sourceAppId !== canonicalFence.controllerAppId
      || kickoff.chatId !== canonicalFence.targetChatId
      || kickoff.fenceFingerprint !== fenceFingerprint
      || !sameTargets(kickoff.targetAppIds, canonicalFence.targetAppIds)
      || !sameTargets(built.targetAppIds, canonicalFence.targetAppIds)
      || kickoff.messageType !== 'post'
      || kickoff.payloadHash !== expectedPayloadHash
      || kickoff.providerUuid !== expectedProviderUuid
      || !taskControlCanaryTimeWithin(kickoff.attempt.wallTime, fenceOpenedAt, observedAt)
      || kickoff.state !== 'delivered'
      || !kickoff.messageId) {
      throw new Error('project_task_control_canary_fence_conflict');
    }
  }
  if (seed && kickoff
    && Date.parse(seed.attempt.wallTime) > Date.parse(kickoff.attempt.wallTime)) {
    throw new Error('project_task_control_canary_fence_conflict');
  }
  const certificate = readTaskControlSuccessCertificate(
    registryPath,
    canonicalFence.dispatchOperationId,
  );
  if (certificate && (certificate.operationId !== canonicalFence.dispatchOperationId
    || certificate.chatId !== canonicalFence.targetChatId
    || certificate.fenceFingerprint !== fenceFingerprint
    || certificate.taskGuid !== canonicalFence.taskGuid
    || !assertProjectTaskControlCanarySuccessCertificate(
      canonicalFence,
      project,
      certificate,
      fenceOpenedAt,
      observedAt,
    )
    || (seed && Date.parse(seed.attempt.wallTime) > Date.parse(certificate.createdAt))
    || (kickoff && Date.parse(kickoff.attempt.wallTime) > Date.parse(certificate.createdAt)))) {
    throw new Error('project_task_control_canary_fence_conflict');
  }
  const canaryReservations = (project.dispatchReservations ?? []).filter(reservation => (
    reservation.reservationId === canonicalFence.dispatchOperationId
      || reservation.taskControl?.taskGuid === canonicalFence.taskGuid
  ));
  const canaryWorkstreams = project.workstreams.filter(item => (
    item.taskControl?.reservationId === canonicalFence.dispatchOperationId
      || item.taskControl?.taskGuid === canonicalFence.taskGuid
  ));
  const registryOperations = listDispatchOperations(
    registryPath,
    canonicalFence.dispatchOperationId,
  );
  const reservationAuthoritySecret = canaryReservations.length > 0
    || canaryWorkstreams.length > 0
    ? readTaskControlCanaryDaemonIpcSecret(registryPath)
    : undefined;
  const reportBindingSecret = registryOperations.length > 0
    ? readTaskControlCanaryReportBindingSecret(registryPath)
    : undefined;
  const reservationRoots = canaryReservations.flatMap(reservation => {
    if (reservation.reservationId !== canonicalFence.dispatchOperationId
      && reservation.taskControl?.taskGuid !== canonicalFence.taskGuid) {
      return [];
    }
    assertProjectTaskControlCanaryFenceReservation(canonicalFence, project, reservation);
    if (reservation.stage !== 'root_created'
      || !reservation.dispatchRoot
      || !/^om_[A-Za-z0-9_-]{1,128}$/.test(reservation.dispatchRoot)
      || !reservation.rootCreateTime
      || !Number.isFinite(Date.parse(reservation.rootCreateTime))
      || new Date(reservation.rootCreateTime).toISOString() !== reservation.rootCreateTime
      || !assertProjectTaskControlCanaryReservationAuthority(
        canonicalFence,
        project,
        reservation,
        reservationAuthoritySecret!,
        fenceOpenedAt,
        observedAt,
      )) {
      throw new Error('project_task_control_canary_fence_conflict');
    }
    return [reservation.dispatchRoot];
  });
  const workstreamRoots = canaryWorkstreams.flatMap(item => {
    assertProjectTaskControlCanaryFenceWorkstream(canonicalFence, project, item);
    if (!assertProjectTaskControlCanaryWorkstreamAuthority(
      canonicalFence,
      project,
      item,
      reservationAuthoritySecret!,
      fenceOpenedAt,
      observedAt,
    )) {
      throw new Error('project_task_control_canary_fence_conflict');
    }
    return [item.dispatchRoot];
  });
  const canaryAuthoritativeRoots = new Set([
    ...seedRoots,
    ...(kickoff ? [kickoff.dispatchRoot] : []),
    ...(certificate ? [certificate.dispatchRoot] : []),
    ...reservationRoots,
    ...workstreamRoots,
  ]);
  const registryRoots = registryOperations
    .map(operation => {
      assertProjectTaskControlCanaryFenceRegistryEntry(
        canonicalFence,
        project,
        operation.dispatchRoot,
        operation.entry,
        reportBindingSecret!,
      );
      if (!canaryAuthoritativeRoots.has(operation.dispatchRoot)) {
        throw new Error('project_task_control_canary_fence_conflict');
      }
      return operation.dispatchRoot;
    });
  return [...new Set([
    ...canaryAuthoritativeRoots,
    ...registryRoots,
  ])];
}

function taskControlCanaryTimeWithin(value: unknown, openedAt: string, observedAt: string): value is string {
  return canonicalIsoTimestamp(value)
    && Date.parse(value) >= Date.parse(openedAt)
    && Date.parse(value) <= Date.parse(observedAt);
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function exactNonBlankStrings(value: unknown, count: number): value is string[] {
  return Array.isArray(value)
    && value.length === count
    && value.every(item => typeof item === 'string' && item.trim() === item && item.length > 0)
    && new Set(value).size === count;
}

function assertProjectTaskControlCanarySuccessCertificate(
  fence: ReturnType<typeof validatedProjectTaskControlCanaryFence>,
  project: ProjectGroupState,
  certificate: NonNullable<ReturnType<typeof readTaskControlSuccessCertificate>>,
  fenceOpenedAt: string,
  observedAt: string,
): boolean {
  const evidence = certificate.evidence;
  if (!exactObjectKeys(evidence, ['phaseA', 'phaseB', 'scope'])
    || !evidence.phaseA || typeof evidence.phaseA !== 'object' || Array.isArray(evidence.phaseA)
    || !evidence.phaseB || typeof evidence.phaseB !== 'object' || Array.isArray(evidence.phaseB)
    || !evidence.scope || typeof evidence.scope !== 'object' || Array.isArray(evidence.scope)) {
    return false;
  }
  const phaseA = evidence.phaseA as Record<string, unknown>;
  const phaseB = evidence.phaseB as Record<string, unknown>;
  const scope = evidence.scope as Record<string, unknown>;
  const expectedSeedPayloadHash = createHash('sha256').update(fence.seedText).digest('hex');
  const expectedSeedProviderUuid = createDispatchOperationId({
    schemaVersion: 'TaskControlProviderUuid.v1',
    effect: 'seed_root',
    operationId: fence.dispatchOperationId,
    targetChatId: fence.targetChatId,
    targetRoot: null,
    messageType: 'text',
    payloadHash: expectedSeedPayloadHash,
  });
  if (!fence.kickoff) return false;
  const kickoff = buildTaskControlKickoffContent({
    title: fence.title,
    brief: fence.kickoff.brief,
    dispatchRoot: certificate.dispatchRoot,
    bots: fence.kickoff.bots,
  });
  const expectedKickoffPayloadHash = createHash('sha256').update(kickoff.content).digest('hex');
  const expectedKickoffProviderUuid = createDispatchOperationId({
    schemaVersion: 'TaskControlProviderUuid.v1',
    effect: 'kickoff_thread',
    operationId: fence.dispatchOperationId,
    targetChatId: fence.targetChatId,
    targetRoot: certificate.dispatchRoot,
    messageType: 'post',
    payloadHash: expectedKickoffPayloadHash,
  });
  if (!exactObjectKeys(phaseA, [
    'instructionMessageId', 'historicalDispatchRoot', 'historicalTaskGuid',
    'reportRequestId', 'reportContent', 'reportContentHash', 'evidenceIds',
    'controllerEventIds', 'taskFailedEventId',
  ])
    || !exactObjectKeys(phaseB, [
      'seedProviderUuid', 'kickoffProviderUuid', 'kickoffMessageId', 'projectRevision',
      'deliveryRound', 'deliveryContentHash', 'reviewRound', 'reviewVerdict',
      'reviewContentHash', 'workerTurnTerminalAt', 'reviewerTurnTerminalAt',
      'workerEvidenceIds', 'reviewerEvidenceIds', 'controllerEventIds',
      'workerSourceSessionId', 'workerGeneration', 'reviewerSourceSessionId',
      'reviewerGeneration', 'acceptedEventId', 'executionEventId', 'submittedEventId',
      'reviewedEventId', 'deliveredEventId', 'deliveryOutboxId', 'deliveryReceiptId',
      'doneEventId',
    ])
    || !exactObjectKeys(scope, ['paths', 'empty'])
    || typeof phaseA.instructionMessageId !== 'string'
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(phaseA.instructionMessageId)
    || phaseA.historicalDispatchRoot !== fence.phaseA.historicalDispatchRoot
    || phaseA.historicalTaskGuid !== fence.phaseA.historicalTaskGuid
    || typeof phaseA.reportRequestId !== 'string'
    || !/^report:[a-f0-9]{64}$/.test(phaseA.reportRequestId)
    || phaseA.reportContent !== fence.phaseA.failedReportContent
    || phaseA.reportContentHash !== fence.phaseA.failedReportSha256
    || !exactNonBlankStrings(phaseA.evidenceIds, 2)
    || !exactNonBlankStrings(phaseA.controllerEventIds, 1)
    || typeof phaseA.taskFailedEventId !== 'string'
    || phaseA.controllerEventIds[0] !== phaseA.taskFailedEventId
    || phaseB.seedProviderUuid !== expectedSeedProviderUuid
    || phaseB.kickoffProviderUuid !== expectedKickoffProviderUuid
    || typeof phaseB.kickoffMessageId !== 'string'
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(phaseB.kickoffMessageId)
    || phaseB.projectRevision !== project.revision
    || phaseB.deliveryRound !== 1
    || typeof phaseB.deliveryContentHash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(phaseB.deliveryContentHash)
    || phaseB.reviewRound !== 1
    || phaseB.reviewVerdict !== 'pass'
    || typeof phaseB.reviewContentHash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(phaseB.reviewContentHash)
    || !taskControlCanaryTimeWithin(phaseB.workerTurnTerminalAt, fenceOpenedAt, observedAt)
    || !taskControlCanaryTimeWithin(phaseB.reviewerTurnTerminalAt, fenceOpenedAt, observedAt)
    || Date.parse(phaseB.workerTurnTerminalAt) > Date.parse(phaseB.reviewerTurnTerminalAt)
    || !exactNonBlankStrings(phaseB.workerEvidenceIds, 4)
    || !exactNonBlankStrings(phaseB.reviewerEvidenceIds, 2)
    || !exactNonBlankStrings(phaseB.controllerEventIds, 6)
    || typeof phaseB.workerSourceSessionId !== 'string' || !phaseB.workerSourceSessionId.trim()
    || !Number.isSafeInteger(phaseB.workerGeneration) || (phaseB.workerGeneration as number) < 1
    || typeof phaseB.reviewerSourceSessionId !== 'string' || !phaseB.reviewerSourceSessionId.trim()
    || !Number.isSafeInteger(phaseB.reviewerGeneration) || (phaseB.reviewerGeneration as number) < 1
    || typeof phaseB.acceptedEventId !== 'string'
    || typeof phaseB.executionEventId !== 'string'
    || typeof phaseB.submittedEventId !== 'string'
    || typeof phaseB.reviewedEventId !== 'string'
    || typeof phaseB.deliveredEventId !== 'string'
    || typeof phaseB.deliveryOutboxId !== 'string' || !phaseB.deliveryOutboxId.trim()
    || typeof phaseB.deliveryReceiptId !== 'string' || !phaseB.deliveryReceiptId.trim()
    || typeof phaseB.doneEventId !== 'string'
    || JSON.stringify(phaseB.controllerEventIds) !== JSON.stringify([
      phaseB.acceptedEventId, phaseB.executionEventId, phaseB.submittedEventId,
      phaseB.reviewedEventId, phaseB.deliveredEventId, phaseB.doneEventId,
    ])
    || scope.empty !== true
    || !sameCanonicalStrings(fence.writeScopes, scope.paths)
    || !taskControlCanaryTimeWithin(certificate.createdAt, fenceOpenedAt, observedAt)
    || Date.parse(certificate.createdAt) < Date.parse(phaseB.workerTurnTerminalAt)
    || Date.parse(certificate.createdAt) < Date.parse(phaseB.reviewerTurnTerminalAt)) {
    return false;
  }
  return true;
}

function canaryReservationFacts(
  project: ProjectGroupState,
  input: {
    reservationId: string;
    access: ProjectDispatchAccess;
    createdAt: string;
    expiresAt: string;
    taskControl: NonNullable<ProjectDispatchReservation['taskControl']>;
  },
): ProjectDispatchReservationFactsV1 {
  return {
    schemaVersion: 'ProjectDispatchReservation.v1',
    larkAppId: project.larkAppId,
    chatId: project.chatId,
    coordinatorSessionId: input.taskControl.coordinatorSessionId!,
    originTurnId: input.taskControl.originTurnId,
    reservationId: input.reservationId,
    taskGuid: input.taskControl.taskGuid,
    phaseId: input.taskControl.phaseId,
    workerAppId: input.taskControl.workerAppId,
    reviewerAppId: input.taskControl.reviewerAppId,
    acceptorAppId: input.taskControl.acceptorAppId,
    access: input.access,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    dispatch: input.taskControl.recovery!,
  };
}

function taskControlCanaryReservationTrust(
  fence: ReturnType<typeof validatedProjectTaskControlCanaryFence>,
  secret: string,
): TaskControlMappingTrust {
  return new TaskControlMappingTrust({
    hostSecret: secret,
    previousHostSecret: process.env.TASK_CONTROL_PLANE_PREVIOUS_HOST_SECRET,
    larkAppId: fence.controllerAppId,
  });
}

function assertProjectTaskControlCanaryReservationAuthority(
  fence: ReturnType<typeof validatedProjectTaskControlCanaryFence>,
  project: ProjectGroupState,
  reservation: ProjectDispatchReservation,
  secret: string,
  fenceOpenedAt: string,
  observedAt: string,
): boolean {
  const taskControl = reservation.taskControl;
  if (!taskControl || !taskControl.recovery
    || !canonicalIsoTimestamp(reservation.createdAt)
    || !canonicalIsoTimestamp(reservation.expiresAt)
    || !taskControlCanaryTimeWithin(reservation.createdAt, fenceOpenedAt, observedAt)
    || !taskControlCanaryTimeWithin(reservation.rootCreateTime, fenceOpenedAt, observedAt)
    || Date.parse(reservation.createdAt) > Date.parse(reservation.rootCreateTime!)
    || Date.parse(reservation.rootCreateTime!) >= Date.parse(reservation.expiresAt)
    || taskControl.proof.issuedAt !== reservation.createdAt) {
    return false;
  }
  return taskControlCanaryReservationTrust(fence, secret).verifyProjectDispatchReservation(
    taskControl.proof,
    canaryReservationFacts(project, {
      reservationId: reservation.reservationId,
      access: reservation.access,
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
      taskControl,
    }),
  );
}

function assertProjectTaskControlCanaryWorkstreamAuthority(
  fence: ReturnType<typeof validatedProjectTaskControlCanaryFence>,
  project: ProjectGroupState,
  workstream: ProjectGroupState['workstreams'][number],
  secret: string,
  fenceOpenedAt: string,
  observedAt: string,
): boolean {
  const taskControl = workstream.taskControl;
  if (!taskControl || !taskControl.recovery || !workstream.access
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(workstream.dispatchRoot)
    || !Number.isSafeInteger(taskControl.projectRevision)
    || taskControl.projectRevision < 0 || taskControl.projectRevision > project.revision
    || !taskControlCanaryTimeWithin(taskControl.reservationCreatedAt, fenceOpenedAt, observedAt)
    || !canonicalIsoTimestamp(taskControl.reservationExpiresAt)
    || !taskControlCanaryTimeWithin(taskControl.rootCreateTime, fenceOpenedAt, observedAt)
    || !taskControlCanaryTimeWithin(workstream.createdAt, fenceOpenedAt, observedAt)
    || !taskControlCanaryTimeWithin(workstream.updatedAt, fenceOpenedAt, observedAt)
    || Date.parse(taskControl.reservationCreatedAt) > Date.parse(taskControl.rootCreateTime)
    || Date.parse(taskControl.rootCreateTime) >= Date.parse(taskControl.reservationExpiresAt)
    || Date.parse(taskControl.rootCreateTime) > Date.parse(workstream.createdAt)
    || Date.parse(workstream.createdAt) > Date.parse(workstream.updatedAt)
    || taskControl.reservationProof.issuedAt !== taskControl.reservationCreatedAt
    || (taskControl.mappingStatus === 'pending'
      ? taskControl.registeredAt !== undefined || taskControl.failureCode !== undefined
      : !taskControlCanaryTimeWithin(taskControl.registeredAt, taskControl.rootCreateTime, observedAt)
        || Date.parse(taskControl.registeredAt!) > Date.parse(workstream.updatedAt))) {
    return false;
  }
  const taskControlForFacts: NonNullable<ProjectDispatchReservation['taskControl']> = {
    mode: fence.taskControlMode,
    taskGuid: taskControl.taskGuid,
    phaseId: taskControl.phaseId,
    workerAppId: taskControl.workerAppId,
    reviewerAppId: taskControl.reviewerAppId,
    acceptorAppId: taskControl.acceptorAppId,
    originTurnId: taskControl.originTurnId,
    coordinatorSessionId: taskControl.coordinatorSessionId,
    proof: taskControl.reservationProof,
    recovery: taskControl.recovery,
  };
  return taskControlCanaryReservationTrust(fence, secret).verifyProjectDispatchReservation(
    taskControl.reservationProof,
    canaryReservationFacts(project, {
      reservationId: taskControl.reservationId,
      access: workstream.access,
      createdAt: taskControl.reservationCreatedAt,
      expiresAt: taskControl.reservationExpiresAt,
      taskControl: taskControlForFacts,
    }),
  );
}

function sameCanonicalStrings(expected: readonly string[], value: unknown): boolean {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return false;
  const normalized = [...new Set(value.map(item => item.trim()).filter(Boolean))].sort();
  return sameTargets(expected, normalized);
}

function matchesCanaryWriteAccess(
  fence: ReturnType<typeof validatedProjectTaskControlCanaryFence>,
  value: unknown,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const access = value as Record<string, unknown>;
  if (access.mode !== 'write' || !Array.isArray(access.scopes)
    || access.scopes.some(scope => typeof scope !== 'string')) return false;
  try {
    return sameTargets(fence.writeScopes, normalizeDispatchWriteScopes(access.scopes as string[]));
  } catch {
    return false;
  }
}

function canonicalIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function readTaskControlCanaryDaemonIpcSecret(registryPath: string): string {
  try {
    return loadDaemonIpcSecret(join(dirname(dirname(registryPath)), '.dashboard-secret'));
  } catch {
    throw new Error('project_task_control_canary_fence_conflict');
  }
}

function readTaskControlCanaryReportBindingSecret(registryPath: string): string {
  try {
    const secret = loadDashboardSecret(
      dispatchReportBindingSecretPath(dirname(registryPath)),
    );
    if (secret) return secret;
  } catch {
    // Missing, unreadable, or unsafe authority material all fail closed below.
  }
  throw new Error('project_task_control_canary_fence_conflict');
}

function assertProjectTaskControlCanaryFenceRegistryEntry(
  fence: ReturnType<typeof validatedProjectTaskControlCanaryFence>,
  project: ProjectGroupState,
  dispatchRoot: string,
  entry: Record<string, unknown>,
  reportBindingSecret: string,
): void {
  const taskControl = entry.taskControl;
  if (!taskControl || typeof taskControl !== 'object' || Array.isArray(taskControl)) {
    throw new Error('project_task_control_canary_fence_conflict');
  }
  const payload = verifyDispatchReportBinding(
    reportBindingSecret,
    dispatchRoot,
    entry.reportBinding,
  );
  if (!payload) {
    throw new Error('project_task_control_canary_fence_conflict');
  }
  const binding = taskControl as Record<string, unknown>;
  if (entry.dispatchOperationId !== fence.dispatchOperationId
    || entry.orchChatId !== project.chatId
    || entry.targetChatId !== fence.targetChatId
    || entry.orchAppId !== fence.controllerAppId
    || entry.orchSessionId !== fence.coordinatorSessionId
    || (entry.orchScope !== 'chat' && entry.orchScope !== 'thread')
    || !sameCanonicalStrings(fence.targetAppIds, entry.targetAppIds)
    || !sameCanonicalStrings([fence.workerAppId], entry.workerAppIds)
    || !sameCanonicalStrings([fence.reviewerAppId], entry.reviewerAppIds)
    || !matchesCanaryWriteAccess(fence, entry.access)
    || typeof entry.title !== 'string' || entry.title.trim() !== fence.title
    || typeof entry.purpose !== 'string' || entry.purpose.trim() !== fence.purpose
    || !sameCanonicalStrings(fence.owners, entry.owners)
    || !sameCanonicalStrings(fence.botOpenIds, entry.bots)
    || binding.mode !== fence.taskControlMode
    || binding.taskGuid !== fence.taskGuid
    || binding.phaseId !== `workstream:${fence.taskGuid}`
    || binding.controllerAppId !== fence.controllerAppId
    || binding.workerAppId !== fence.workerAppId
    || binding.reviewerAppId !== fence.reviewerAppId
    || binding.acceptorAppId !== fence.acceptorAppId
    || payload.targetLarkAppId !== fence.controllerAppId
    || payload.targetSessionId !== fence.coordinatorSessionId
    || payload.targetChatId !== fence.targetChatId
    || payload.targetScope !== entry.orchScope
    || payload.sourceName !== fence.title
    || !canonicalIsoTimestamp(payload.issuedAt)
    || payload.issuedAt !== entry.createdAt) {
    throw new Error('project_task_control_canary_fence_conflict');
  }
}

function assertProjectTaskControlCanaryFenceWorkstream(
  fence: ReturnType<typeof validatedProjectTaskControlCanaryFence>,
  project: ProjectGroupState,
  workstream: ProjectGroupState['workstreams'][number],
): void {
  const binding = workstream.taskControl;
  const recovery = binding?.recovery;
  const createdAt = binding?.reservationCreatedAt;
  const expiresAt = binding?.reservationExpiresAt;
  const rootCreateTime = binding?.rootCreateTime;
  if (!binding
    || binding.sourceKind !== 'project_group'
    || binding.reservationId !== fence.dispatchOperationId
    || binding.taskGuid !== fence.taskGuid
    || binding.phaseId !== `workstream:${fence.taskGuid}`
    || binding.mappingRef !== `topic-message:${workstream.dispatchRoot}`
    || (binding.mappingStatus !== 'pending' && binding.mappingStatus !== 'registered')
    || binding.controllerAppId !== fence.controllerAppId
    || binding.workerAppId !== fence.workerAppId
    || binding.reviewerAppId !== fence.reviewerAppId
    || binding.acceptorAppId !== fence.acceptorAppId
    || binding.coordinatorSessionId !== fence.coordinatorSessionId
    || binding.originTurnId !== fence.originTurnId
    || binding.reservationProof.schemaVersion !== 'ProjectDispatchReservationProof.v1'
    || binding.reservationProof.larkAppId !== fence.controllerAppId
    || !canonicalIsoTimestamp(binding.reservationProof.issuedAt)
    || project.chatId !== fence.targetChatId
    || project.larkAppId !== fence.controllerAppId
    || !sameCanonicalStrings(fence.targetAppIds, workstream.targetAppIds)
    || !sameCanonicalStrings([fence.workerAppId], workstream.workerAppIds)
    || !sameCanonicalStrings([fence.reviewerAppId], workstream.reviewerAppIds)
    || !matchesCanaryWriteAccess(fence, workstream.access)
    || workstream.title.trim() !== fence.title
    || workstream.purpose.trim() !== fence.purpose
    || !sameCanonicalStrings(fence.owners, workstream.owners)
    || !recovery
    || recovery.title.trim() !== fence.title
    || recovery.purpose.trim() !== fence.purpose
    || !sameCanonicalStrings(fence.owners, recovery.owners)
    || !sameCanonicalStrings(fence.botOpenIds, recovery.botOpenIds)
    || recovery.acceptanceRequested !== fence.acceptanceRequested
    || recovery.seedText.trim() !== fence.seedText
    || !canonicalIsoTimestamp(createdAt)
    || !canonicalIsoTimestamp(expiresAt)
    || !canonicalIsoTimestamp(rootCreateTime)
    || binding.reservationProof.issuedAt !== createdAt
    || Date.parse(createdAt) > Date.parse(rootCreateTime)
    || Date.parse(rootCreateTime) >= Date.parse(expiresAt)) {
    throw new Error('project_task_control_canary_fence_conflict');
  }
}

function assertProjectTaskControlCanaryFenceReservation(
  fence: ReturnType<typeof validatedProjectTaskControlCanaryFence>,
  project: ProjectGroupState,
  reservation: Pick<ProjectDispatchReservation, 'reservationId' | 'targetAppIds' | 'access' | 'taskControl'>,
): void {
  const taskControl = reservation.taskControl;
  const recovery = taskControl?.recovery;
  const normalizedOwners = [...new Set((recovery?.owners ?? []).map(value => value.trim()).filter(Boolean))].sort();
  const normalizedBotOpenIds = [...new Set((recovery?.botOpenIds ?? []).map(value => value.trim()).filter(Boolean))].sort();
  if (fence.dispatchOperationId !== reservation.reservationId
    || fence.targetChatId !== project.chatId
    || fence.controllerAppId !== project.larkAppId
    || !sameTargets(fence.targetAppIds, reservation.targetAppIds)
    || reservation.access.mode !== 'write'
    || !sameTargets(fence.writeScopes, reservation.access.scopes)
    || !taskControl
    || taskControl.mode !== fence.taskControlMode
    || taskControl.taskGuid !== fence.taskGuid
    || taskControl.phaseId !== `workstream:${fence.taskGuid}`
    || taskControl.coordinatorSessionId !== fence.coordinatorSessionId
    || taskControl.originTurnId !== fence.originTurnId
    || taskControl.workerAppId !== fence.workerAppId
    || taskControl.reviewerAppId !== fence.reviewerAppId
    || taskControl.acceptorAppId !== fence.acceptorAppId
    || taskControl.proof.larkAppId !== fence.controllerAppId
    || !recovery
    || recovery.title.trim() !== fence.title
    || recovery.purpose.trim() !== fence.purpose
    || !sameTargets(fence.owners, normalizedOwners)
    || !sameTargets(fence.botOpenIds, normalizedBotOpenIds)
    || recovery.acceptanceRequested !== fence.acceptanceRequested
    || recovery.seedText.trim() !== fence.seedText) {
    throw new Error('project_task_control_canary_fence_conflict');
  }
}

function assertProjectTaskControlCanaryFenceCommit(
  fence: ReturnType<typeof validatedProjectTaskControlCanaryFence>,
  action: Extract<ProjectCoordinatorAction, { action: 'commit_dispatch' }>,
): void {
  const owners = [...new Set((action.owners ?? []).map(value => value.trim()).filter(Boolean))].sort();
  if (action.title.trim() !== fence.title
    || (action.purpose ?? '').trim() !== fence.purpose
    || !sameTargets(fence.owners, owners)) {
    throw new Error('project_task_control_canary_fence_conflict');
  }
}

function holdsWriteClaim(status: ProjectWorkstreamStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

function boundedText(value: string | undefined, max: number, fallback = ''): string {
  const text = value?.trim() ?? '';
  return (text || fallback).slice(0, max);
}

function boundedArchiveReason(value: string | undefined): string {
  return Array.from(value?.trim() ?? '').slice(0, 160).join('');
}

function reviewerReplacementFingerprint(
  context: ProjectCoordinatorContext,
  action: ProjectWorkstreamReviewerReplacementAction,
  reason: string,
): string {
  const canonical = JSON.stringify({
    chatId: context.chatId,
    dispatchRoot: action.dispatchRoot.trim(),
    oldReviewerAppId: action.oldReviewerAppId.trim(),
    newReviewerAppId: action.newReviewerAppId.trim(),
    authorizationRef: action.authorizationRef.trim(),
    authorizedByOpenId: action.authorizedByOpenId?.trim() ?? '',
    reason,
    coordinatorSessionId: context.coordinatorSessionId,
    expectedRevision: action.expectedRevision,
  });
  return `prr1:${createHash('sha256').update(canonical).digest('hex')}`;
}

const COMPLETION_GATE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMPLETION_GATE_SOURCE_CHAT_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
const COMPLETION_GATE_ROOT_RE = /^om_[A-Za-z0-9_-]{1,128}$/;
const COMPLETION_GATE_TASK_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPLETION_GATE_AUTHORIZATION_RE = /^om_[A-Za-z0-9_-]{1,128}$/;
const COMPLETION_GATE_AUTHORIZED_ACTOR_RE = /^ou_[A-Za-z0-9_-]{1,128}$/;
const PROJECT_REVIEWER_APP_ID_RE = /^cli_[A-Za-z0-9_-]{1,128}$/;

export type ProjectCompletionGateLifecycleAction = Extract<
  ProjectCoordinatorAction,
  { action: 'retire_completion_gate' | 'replace_completion_gate' }
>;

/** Exact sentence the human must send in the active Lark turn. The daemon
 * matches it before adding the verified actor to the coordinator action. */
export function projectCompletionGateAuthorizationPrompt(
  action: ProjectCompletionGateLifecycleAction,
): string {
  const common = {
    action: action.action,
    gateId: action.gateId.trim(),
    expectedDefinitionFingerprint: action.expectedDefinitionFingerprint.trim(),
  };
  const payload = action.action === 'retire_completion_gate'
    ? { ...common, reason: boundedText(action.reason, 160) }
    : {
        ...common,
        newGateId: action.newGateId.trim(),
        sourceChatId: action.sourceChatId.trim(),
        dispatchRoot: action.dispatchRoot.trim(),
        taskGuid: action.taskGuid.trim(),
        label: boundedText(action.label, 80),
        reason: boundedText(action.reason, 160),
      };
  return `授权执行 BotMux completion gate 变更：${JSON.stringify(payload)}`;
}

export type ProjectWorkstreamReviewerReplacementAction = Extract<
  ProjectCoordinatorAction,
  { action: 'replace_workstream_reviewer' }
>;

/** Exact sentence the current authorized human must send before the daemon
 * adds the actor and current project worker allowlist to this action. */
export function projectWorkstreamReviewerAuthorizationPrompt(
  action: ProjectWorkstreamReviewerReplacementAction,
): string {
  const payload = {
    action: action.action,
    dispatchRoot: action.dispatchRoot.trim(),
    oldReviewerAppId: action.oldReviewerAppId.trim(),
    newReviewerAppId: action.newReviewerAppId.trim(),
    expectedRevision: action.expectedRevision,
    reason: boundedText(action.reason, 160),
  };
  return `授权执行 BotMux reviewer 变更：${JSON.stringify(payload)}`;
}

export type ProjectWorkstreamArchiveAction = Extract<
  ProjectCoordinatorAction,
  { action: 'archive_workstream' }
>;

export function projectWorkstreamArchiveAuthorizationPrompt(
  action: ProjectWorkstreamArchiveAction,
): string {
  const dispatchRoot = action.dispatchRoot.trim();
  const reason = boundedArchiveReason(action.reason);
  return '授权归档 BotMux 历史 failed workstream：' + JSON.stringify({
    dispatchRoot,
    expectedRevision: action.expectedRevision,
    reason,
  });
}

export type ProjectTaskControlCanaryAbandonedRetirementAction = Extract<
  ProjectCoordinatorAction,
  { action: 'retire_task_control_canary_abandoned' }
>;

export function projectTaskControlCanaryAbandonedRetirementAuthorizationPrompt(
  action: ProjectTaskControlCanaryAbandonedRetirementAction,
): string {
  return '授权退休 BotMux abandoned blocker：' + JSON.stringify({
    action: action.action,
    expectedRecordFingerprint: action.expectedRecordFingerprint.trim(),
    reason: boundedArchiveReason(action.reason),
  });
}

function projectStatusView(project: ProjectGroupState): ProjectGroupState {
  const view = structuredClone(project);
  view.blockerRecords = view.blockerRecords.map(record => ({
    ...record,
    recordFingerprint: projectBlockerRecordFingerprint(record),
  })) as ProjectGroupState['blockerRecords'];
  return view;
}

function newCompletionGate(input: {
  gateId: string;
  sourceChatId: string;
  dispatchRoot: string;
  taskGuid: string;
  label: string;
  parentChatId: string;
  now: string;
  replacesGateId?: string;
}): ProjectCompletionGate {
  const gateId = input.gateId.trim();
  const sourceChatId = input.sourceChatId.trim();
  const dispatchRoot = input.dispatchRoot.trim();
  const taskGuid = input.taskGuid.trim();
  const label = boundedText(input.label, 80);
  if (!COMPLETION_GATE_ID_RE.test(gateId)) throw new Error('project_completion_gate_id_invalid');
  if (!COMPLETION_GATE_SOURCE_CHAT_RE.test(sourceChatId) || sourceChatId === input.parentChatId) {
    throw new Error('project_completion_gate_source_chat_invalid');
  }
  if (!COMPLETION_GATE_ROOT_RE.test(dispatchRoot)) throw new Error('project_completion_gate_dispatch_root_invalid');
  if (!COMPLETION_GATE_TASK_GUID_RE.test(taskGuid)) throw new Error('project_completion_gate_task_guid_invalid');
  if (!label) throw new Error('project_completion_gate_label_required');
  const definitionFingerprint = projectCompletionGateFingerprint({ gateId, sourceChatId, dispatchRoot, taskGuid });
  return {
    gateId, sourceChatId, dispatchRoot, taskGuid, label, definitionFingerprint,
    status: 'pending', reason: 'not_evaluated', createdAt: input.now, updatedAt: input.now,
    ...(input.replacesGateId ? { replacesGateId: input.replacesGateId } : {}),
  };
}

function validProgress(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : undefined;
}

function statusProgress(status: ProjectWorkstreamStatus, explicit?: number, current?: number): number {
  const valid = validProgress(explicit);
  if (valid !== undefined) return valid;
  if (status === 'completed') return 100;
  if (status === 'in_progress') return current ?? 20;
  return current ?? 0;
}

export class ProjectCoordinator {
  private completionGateEvaluator: ProjectCompletionGateEvaluator | undefined;
  private taskControlSuccessEvidenceReader:
    | ((input: TaskControlSuccessEvidenceInput) => TaskControlSuccessEvidenceSnapshot)
    | undefined;

  constructor(private readonly transport: ProjectCoordinatorTransport) {}

  setCompletionGateEvaluator(evaluator: ProjectCompletionGateEvaluator | undefined): void {
    this.completionGateEvaluator = evaluator;
  }

  setTaskControlSuccessEvidenceReader(
    reader: ((input: TaskControlSuccessEvidenceInput) => TaskControlSuccessEvidenceSnapshot) | undefined,
  ): void {
    this.taskControlSuccessEvidenceReader = reader;
  }

  private applyCompletionGateEvaluation(
    gate: ProjectCompletionGate,
    evaluation: ProjectCompletionGateEvaluation,
  ): boolean {
    if (gate.gateId !== evaluation.gateId || gate.definitionFingerprint !== evaluation.definitionFingerprint) {
      throw new Error('project_completion_gate_definition_changed');
    }
    const checkedAt = new Date(evaluation.checkedAt).toISOString();
    const previousCheckedAt = gate.checkedAt ? Date.parse(gate.checkedAt) : Number.NaN;
    const incomingCheckedAt = Date.parse(checkedAt);
    if (Number.isFinite(previousCheckedAt) && incomingCheckedAt < previousCheckedAt) {
      throw new Error('project_completion_gate_evaluation_stale');
    }
    const reason = boundedText(evaluation.reason, 160);
    if (!reason) throw new Error('project_completion_gate_reason_required');
    let nextEvidence: ProjectCompletionGateEvidence | undefined;
    let validUntil: string | undefined;
    if (evaluation.status === 'satisfied') {
      const evidence = evaluation.evidence;
      if (!evidence || !Number.isSafeInteger(evidence.sourceProjectRevision) || evidence.sourceProjectRevision < 1
        || !evidence.reviewerVerdictId?.trim() || !evidence.terminalEventId?.trim()
        || !evidence.deliveryReceiptId?.trim()) {
        throw new Error('project_completion_gate_evidence_required');
      }
      nextEvidence = {
        sourceProjectRevision: evidence.sourceProjectRevision,
        reviewerVerdictId: evidence.reviewerVerdictId.trim(),
        terminalEventId: evidence.terminalEventId.trim(),
        deliveryReceiptId: evidence.deliveryReceiptId.trim(),
      };
      if (!evaluation.validUntil || !Number.isFinite(Date.parse(evaluation.validUntil))
        || Date.parse(evaluation.validUntil) <= incomingCheckedAt) {
        throw new Error('project_completion_gate_validity_required');
      }
      validUntil = new Date(evaluation.validUntil).toISOString();
    } else if (evaluation.validUntil !== undefined) {
      throw new Error('project_completion_gate_validity_unexpected');
    }
    const exactDuplicate = gate.checkedAt === checkedAt && gate.status === evaluation.status
      && gate.reason === reason
      && gate.validUntil === validUntil
      && JSON.stringify(gate.evidence ?? null) === JSON.stringify(nextEvidence ?? null);
    if (gate.checkedAt === checkedAt && !exactDuplicate) {
      throw new Error('project_completion_gate_evaluation_conflict');
    }
    if (exactDuplicate) return false;
    if (nextEvidence) gate.evidence = nextEvidence;
    else delete gate.evidence;
    if (validUntil) gate.validUntil = validUntil;
    else delete gate.validUntil;
    gate.status = evaluation.status;
    gate.reason = reason;
    gate.checkedAt = checkedAt;
    gate.updatedAt = checkedAt;
    return true;
  }

  private refreshCompletionGatesForTerminal(
    project: ProjectGroupState,
    registry: ProjectGroupRegistryReader,
    checkedAt: string,
  ): void {
    const gates = (project.completionGates ?? []).filter(gate => !gate.retirement);
    if (gates.length === 0) return;
    if (!this.completionGateEvaluator) throw new Error('project_completion_gates_open');
    for (const gate of gates) {
      let evaluation: ProjectCompletionGateEvaluation;
      try {
        evaluation = this.completionGateEvaluator({
          parentProject: structuredClone(project), gate: structuredClone(gate),
          sourceProject: registry.readProject(gate.sourceChatId), checkedAt,
        });
        this.applyCompletionGateEvaluation(gate, evaluation);
      } catch {
        throw new Error('project_completion_gates_open');
      }
      if (evaluation.status !== 'satisfied') throw new Error('project_completion_gates_open');
    }
  }

  private async retireOnboardingCard(
    context: Pick<ProjectCoordinatorContext, 'dataDir' | 'chatId' | 'larkAppId'>,
  ): Promise<void> {
    const current = readGroupCollaborationMode(context.dataDir, context.chatId)?.onboardingCard;
    if (!current) return;
    if (current.larkAppId !== context.larkAppId) throw new Error('project_onboarding_coordinator_mismatch');
    try {
      await this.transport.updateCard(context.larkAppId, current.messageId,
        JSON.stringify(buildProjectGroupStartedNoticeCard(localeForBot(context.larkAppId))));
    } catch (error) {
      if (!this.transport.isMessageWithdrawn(error) && !this.transport.isMessageUpdateExpired(error)) {
        logger.warn(`[project] Could not retire onboarding card ${current.messageId}; will retry on refresh: ${error}`);
        return;
      }
    }
    if (current.pinned) {
      try {
        const unpinned = await this.transport.unpinMessage(context.larkAppId, current.messageId);
        if (!unpinned) return;
      } catch (error) {
        if (!this.transport.isMessageWithdrawn(error)) {
          logger.warn(`[project] Could not retire onboarding card ${current.messageId}; will retry on refresh: ${error}`);
          return;
        }
      }
    }
    await writeProjectOnboardingCard(context.dataDir, context.chatId, undefined);
  }

  ensureOnboardingCard(
    context: Pick<ProjectCoordinatorContext, 'dataDir' | 'chatId' | 'larkAppId'>,
    input: Omit<ProjectGroupOnboardingCardInput, 'updatedAt'>,
  ): Promise<ProjectOnboardingCardState | null> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      if (readProjectGroup(context.dataDir, context.chatId)) return null;
      const mode = readGroupCollaborationMode(context.dataDir, context.chatId);
      if (mode?.mode !== 'project' || mode.coordinatorAppId !== context.larkAppId) {
        throw new Error('project_coordinator_mismatch');
      }
      const now = nowIso();
      const cardJson = JSON.stringify(buildProjectGroupOnboardingCard({ ...input, updatedAt: now }));
      const current = mode.onboardingCard;
      if (current) {
        if (current.larkAppId !== context.larkAppId) throw new Error('project_onboarding_coordinator_mismatch');
        try {
          await this.transport.updateCard(context.larkAppId, current.messageId, cardJson);
          const next = { ...current, updatedAt: now };
          await writeProjectOnboardingCard(context.dataDir, context.chatId, next);
          return next;
        } catch (error) {
          if (!this.transport.isMessageWithdrawn(error)) throw error;
          await writeProjectOnboardingCard(context.dataDir, context.chatId, undefined);
        }
      }
      const messageId = await this.transport.sendCard(context.larkAppId, context.chatId, cardJson);
      const pinned = await this.transport.pinMessage(context.larkAppId, messageId);
      const created: ProjectOnboardingCardState = {
        messageId, larkAppId: context.larkAppId, pinned, createdAt: now, updatedAt: now,
      };
      await writeProjectOnboardingCard(context.dataDir, context.chatId, created);
      return created;
    });
  }

  clearOnboardingCard(
    context: Pick<ProjectCoordinatorContext, 'dataDir' | 'chatId' | 'larkAppId'>,
  ): Promise<boolean> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      const current = readGroupCollaborationMode(context.dataDir, context.chatId)?.onboardingCard;
      if (!current) return false;
      if (current.larkAppId !== context.larkAppId) throw new Error('project_onboarding_coordinator_mismatch');
      if (current.pinned) {
        try {
          await this.transport.unpinMessage(context.larkAppId, current.messageId);
        } catch (error) {
          if (!this.transport.isMessageWithdrawn(error)) throw error;
        }
      }
      await writeProjectOnboardingCard(context.dataDir, context.chatId, undefined);
      return true;
    });
  }

  private installTaskControlCanaryFence(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'install_task_control_canary_fence' }>,
  ): ProjectGroupState {
    return withProjectTaskControlChatLockSync(context.dataDir, context.chatId, () => {
      const registryPath = join(context.dataDir, 'orchestrate-dispatch.json');
      if (openTaskControlTurnAdmissions(registryPath, context.chatId).length > 0) {
        throw new Error('project_task_control_canary_fence_turn_claim_open');
      }
      return withGroupCollaborationModeLockSync(context.dataDir, context.chatId, (_registry, config) => {
        if (config?.taskControlPlane !== undefined) {
          throw new Error('project_task_control_canary_fence_requires_config_absent');
        }
        const next = mutateProjectGroupSync(context.dataDir, context.chatId, current => {
          if (!current) throw new Error('project_not_found');
          if (current.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
          if (current.status !== 'active') throw new Error('project_not_active');
          if ((current.dispatchReservations ?? []).length !== 0) {
            throw new Error('project_task_control_canary_fence_requires_zero_reservations');
          }
          if (action.fence.targetChatId.trim() !== current.chatId
            || action.fence.controllerAppId.trim() !== current.larkAppId
            || action.fence.coordinatorSessionId.trim() !== context.coordinatorSessionId) {
            throw new Error('project_task_control_canary_fence_project_mismatch');
          }
          const now = action.now === undefined ? nowIso() : new Date(action.now).toISOString();
          const fence = projectTaskControlCanaryFenceRecord(action.fence, now);
          const abandoned = current.blockerRecords.find(
            item => item.code === TASK_CONTROL_CANARY_ABANDONED_CODE,
          );
          if (abandoned) projectTaskControlCanaryAbandonmentFromRecord(abandoned);
          const existing = current.blockerRecords.find(item => item.code === fence.code);
          if (existing) {
            if (existing.blockerId !== fence.blockerId || existing.eventId !== fence.eventId
              || existing.taskGuid !== fence.taskGuid || existing.summary !== fence.summary) {
              throw new Error('project_task_control_canary_fence_conflict');
            }
            return current;
          }
          current.coordinatorSessionId = context.coordinatorSessionId;
          current.revision += 1;
          current.updatedAt = now;
          current.dispatchReservations ??= [];
          upsertProjectBlocker(current, fence);
          return current;
        });
        if (!next) throw new Error('project_not_found');
        return next;
      });
    });
  }

  private claimTaskControlTurnAdmission(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'claim_task_control_turn_admission' }>,
  ): ProjectGroupState {
    return withProjectTaskControlChatLockSync(context.dataDir, context.chatId, () => {
      const project = readProjectGroup(context.dataDir, context.chatId);
      if (!project) throw new Error('project_not_found');
      if (project.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
      if (project.blockerRecords.some(record => record.code === TASK_CONTROL_CANARY_QUARANTINE_CODE)) {
        throw new Error('project_task_control_canary_fence_rejects_turn');
      }
      const registryPath = join(context.dataDir, 'orchestrate-dispatch.json');
      if (abandonedTaskControlCanaryRejectsRoot(project, registryPath, action.claim.dispatchRoot)) {
        throw new Error('project_task_control_canary_abandoned');
      }
      const workstream = project.workstreams.find(item => item.dispatchRoot === action.claim.dispatchRoot);
      const binding = workstream?.taskControl;
      if (!binding || binding.sourceKind !== 'project_group' || binding.mappingStatus !== 'registered'
        || (action.claim.targetAppId !== binding.workerAppId && action.claim.targetAppId !== binding.reviewerAppId)) {
        throw new Error('project_task_control_turn_mapping_not_found');
      }
      const base = { ...action.claim, chatId: context.chatId };
      const now = action.now === undefined ? new Date().toISOString() : new Date(action.now).toISOString();
      claimTaskControlTurnAdmissionPendingSync(registryPath, base, now);
      activateTaskControlTurnAdmissionSync(registryPath, base, now);
      return project;
    });
  }

  private clearTaskControlCanaryFence(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'clear_task_control_canary_fence' }>,
  ): ProjectGroupState {
    return withProjectTaskControlChatLockSync(context.dataDir, context.chatId, () => {
      if (openTaskControlTurnAdmissions(
        join(context.dataDir, 'orchestrate-dispatch.json'), context.chatId,
      ).length > 0) {
        throw new Error('project_task_control_canary_fence_turn_claim_open');
      }
      const registryPath = join(context.dataDir, 'orchestrate-dispatch.json');
      const operation = readTaskControlPhaseAOperation(registryPath, action.fence.dispatchOperationId);
      const report = readTaskControlPhaseAFailedReport(registryPath, action.fence.dispatchOperationId);
      const phaseBRegistryOperation = findDispatchOperation(
        registryPath, action.fence.dispatchOperationId,
      ) !== undefined;
      const phaseAEvidenceSettled = !!report && hasSettledTaskControlPhaseAEvidenceSync(
        context.dataDir,
        {
          sourceAppId: report.reporterAppId, controllerAppId: action.fence.controllerAppId,
          dispatchRoot: report.dispatchRoot, sourceSessionId: report.sourceSessionId,
          sourceTurnId: report.sourceTurnId, workerGeneration: report.workerGeneration,
          reportRequestId: report.reportRequestId,
          contentHash: `sha256:${report.contentHash}`,
        },
      );
      const successCertificate = action.cleanupState === 'delivered_terminal'
        ? readTaskControlSuccessCertificate(registryPath, action.fence.dispatchOperationId)
        : undefined;
      const certificateEvidence = successCertificate?.evidence as {
        phaseA?: { evidenceIds?: unknown; controllerEventIds?: unknown };
        phaseB?: {
          workerEvidenceIds?: unknown; reviewerEvidenceIds?: unknown; controllerEventIds?: unknown;
          projectRevision?: unknown; deliveryRound?: unknown; deliveryContentHash?: unknown;
          reviewRound?: unknown; reviewVerdict?: unknown; reviewContentHash?: unknown;
        };
      } | undefined;
      const successEvidenceCurrent = !!successCertificate
        && !!certificateEvidence?.phaseA && !!certificateEvidence.phaseB
        && hasExactTaskControlSuccessEvidenceSync(context.dataDir, {
          controllerAppId: action.fence.controllerAppId,
          phaseA: {
            dispatchRoot: action.fence.phaseA.historicalDispatchRoot,
            taskGuid: action.fence.phaseA.historicalTaskGuid,
            evidenceIds: certificateEvidence.phaseA.evidenceIds,
            controllerEventIds: certificateEvidence.phaseA.controllerEventIds,
          },
          phaseB: {
            dispatchRoot: successCertificate.dispatchRoot,
            taskGuid: action.fence.taskGuid,
            workerEvidenceIds: certificateEvidence.phaseB.workerEvidenceIds,
            reviewerEvidenceIds: certificateEvidence.phaseB.reviewerEvidenceIds,
            controllerEventIds: certificateEvidence.phaseB.controllerEventIds,
          },
        });
      return withGroupCollaborationModeLockSync(context.dataDir, context.chatId, (_registry, config) => {
        if (action.auditOnlyConfirmedAbsent !== true || config?.taskControlPlane !== undefined) {
          throw new Error('project_task_control_canary_fence_cleanup_requires_absence');
        }
        const next = mutateProjectGroupSync(context.dataDir, context.chatId, current => {
          if (!current) throw new Error('project_not_found');
          if (current.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
          const expected = projectTaskControlCanaryFenceRecord(
            action.fence,
            action.now === undefined ? nowIso() : new Date(action.now).toISOString(),
          );
          const index = current.blockerRecords.findIndex(
            record => record.code === TASK_CONTROL_CANARY_QUARANTINE_CODE,
          );
          if (index < 0) return current;
          const existing = current.blockerRecords[index]!;
          if (existing.blockerId !== expected.blockerId || existing.eventId !== expected.eventId
            || existing.taskGuid !== expected.taskGuid || existing.summary !== expected.summary) {
            throw new Error('project_task_control_canary_fence_conflict');
          }
          const phaseBStarted = (current.dispatchReservations ?? []).length > 0
            || current.workstreams.some(item => item.taskControl?.taskGuid === action.fence.taskGuid)
            || phaseBRegistryOperation;
          let cleanupSafe = action.cleanupState === 'pre_dispatch_abort'
            && operation === undefined && report === undefined && !phaseBStarted;
          if (action.cleanupState === 'phase_a_terminal_no_canary' && operation?.state === 'delivered'
            && operation.messageId && !phaseBStarted && report
            && report.operationId === operation.operationId
            && report.fenceFingerprint === operation.fenceFingerprint
            && report.chatId === context.chatId
            && report.dispatchRoot === action.fence.phaseA.historicalDispatchRoot
            && report.taskGuid === action.fence.phaseA.historicalTaskGuid
            && report.reporterAppId === action.fence.phaseA.mappedWorkerAppId
            && report.sourceTurnId === operation.messageId
            && report.contentHash === action.fence.phaseA.failedReportSha256
            && current.workstreams.some(item => item.dispatchRoot === report.dispatchRoot
              && item.taskControl?.taskGuid === report.taskGuid
              && item.status === 'failed' && item.lastReport === action.fence.phaseA.failedReportContent)
            && phaseAEvidenceSettled) {
            cleanupSafe = true;
          }
          const successWorkstreams = successCertificate ? current.workstreams.filter(item => (
            item.dispatchRoot === successCertificate.dispatchRoot
            || item.taskControl?.taskGuid === successCertificate.taskGuid
          )) : [];
          const successWorkstream = successWorkstreams[0];
          const successProjectCurrent = !!certificateEvidence?.phaseB
            && successWorkstreams.length === 1 && !!successWorkstream
            && certificateEvidence.phaseB.projectRevision === current.revision
            && successWorkstream.status === 'completed'
            && successWorkstream.taskControl?.taskGuid === action.fence.taskGuid
            && successWorkstream.taskControl.controllerAppId === action.fence.controllerAppId
            && successWorkstream.taskControl.workerAppId === action.fence.workerAppId
            && successWorkstream.taskControl.reviewerAppId === action.fence.reviewerAppId
            && successWorkstream.taskControl.acceptorAppId === action.fence.acceptorAppId
            && successWorkstream.delivery?.reportedByAppId === action.fence.workerAppId
            && successWorkstream.delivery.round === certificateEvidence.phaseB.deliveryRound
            && `sha256:${createHash('sha256').update(successWorkstream.delivery.content).digest('hex')}`
              === certificateEvidence.phaseB.deliveryContentHash
            && successWorkstream.review?.reviewerAppId === action.fence.reviewerAppId
            && successWorkstream.review.round === certificateEvidence.phaseB.reviewRound
            && successWorkstream.review.verdict === certificateEvidence.phaseB.reviewVerdict
            && `sha256:${createHash('sha256').update(successWorkstream.review.content).digest('hex')}`
              === certificateEvidence.phaseB.reviewContentHash;
          if (action.cleanupState === 'delivered_terminal' && successCertificate
            && action.successCertificateHash === successCertificate.certificateHash
            && successCertificate.operationId === action.fence.dispatchOperationId
            && successCertificate.chatId === context.chatId
            && successCertificate.fenceFingerprint === projectTaskControlCanaryFenceFingerprint(action.fence)
            && successCertificate.taskGuid === action.fence.taskGuid
            && findDispatchOperation(registryPath, action.fence.dispatchOperationId)?.dispatchRoot
              === successCertificate.dispatchRoot
            && successEvidenceCurrent
            && successProjectCurrent
            && taskControlScopeIsEmpty(action.fence.writeScopes)) {
            cleanupSafe = true;
          }
          if (!cleanupSafe) {
            throw new Error('project_task_control_canary_fence_cleanup_not_safe');
          }
          const now = action.now === undefined ? nowIso() : new Date(action.now).toISOString();
          current.blockerRecords.splice(index, 1);
          current.coordinatorSessionId = context.coordinatorSessionId;
          current.revision += 1;
          current.updatedAt = now;
          return current;
        });
        if (!next) throw new Error('project_not_found');
        return next;
      });
    });
  }

  private abandonTaskControlCanary(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'abandon_task_control_canary' }>,
  ): ProjectGroupState {
    return withProjectTaskControlChatLockSync(context.dataDir, context.chatId, () => {
      const before = readProjectGroup(context.dataDir, context.chatId);
      if (!before) throw new Error('project_not_found');
      if (before.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
      const quarantine = before.blockerRecords.find(record => record.code === TASK_CONTROL_CANARY_QUARANTINE_CODE);
      const abandonedRecord = before.blockerRecords.find(record => record.code === TASK_CONTROL_CANARY_ABANDONED_CODE);
      const existing = quarantine ?? abandonedRecord;
      if (!existing) throw new Error('project_task_control_canary_fence_missing');
      if (abandonedRecord) {
        const abandoned = projectTaskControlCanaryAbandonmentFromRecord(existing);
        if (abandoned.fenceFingerprint !== projectTaskControlCanaryFenceFingerprint(action.fence)
          || abandoned.authorizationRef !== action.authorizationRef.trim()
          || abandoned.authorizedByOpenId !== action.authorizedByOpenId.trim()) {
          throw new Error('project_task_control_canary_abandonment_conflict');
        }
      } else {
        const fence = validatedProjectTaskControlCanaryFence(existing);
        if (projectTaskControlCanaryFenceFingerprint(fence)
          !== projectTaskControlCanaryFenceFingerprint(action.fence)) {
          throw new Error('project_task_control_canary_fence_conflict');
        }
      }
      disableTaskControlPlaneForAbandonmentSync(context.dataDir, {
        chatId: context.chatId,
        controllerAppId: context.larkAppId,
        acceptorAppId: action.fence.acceptorAppId,
        expectedConfigHash: action.expectedConfigHash,
      });
      if (readGroupCollaborationMode(context.dataDir, context.chatId)?.taskControlPlane !== undefined) {
        throw new Error('project_task_control_canary_abandonment_requires_absence');
      }
      const next = mutateProjectGroupSync(context.dataDir, context.chatId, current => {
          if (!current) throw new Error('project_not_found');
          if (current.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
          const quarantineIndex = current.blockerRecords.findIndex(
            record => record.code === TASK_CONTROL_CANARY_QUARANTINE_CODE,
          );
          const abandonedIndex = current.blockerRecords.findIndex(
            record => record.code === TASK_CONTROL_CANARY_ABANDONED_CODE,
          );
          const existingIndex = quarantineIndex >= 0 ? quarantineIndex : abandonedIndex;
          if (existingIndex < 0) throw new Error('project_task_control_canary_fence_missing');
          const existing = current.blockerRecords[existingIndex]!;
          const openedAt = existing.openedAt;
          if (abandonedIndex >= 0) {
            const abandoned = projectTaskControlCanaryAbandonmentFromRecord(existing);
            if (abandoned.fenceFingerprint !== projectTaskControlCanaryFenceFingerprint(action.fence)
              || abandoned.authorizationRef !== action.authorizationRef.trim()
              || abandoned.authorizedByOpenId !== action.authorizedByOpenId.trim()) {
              throw new Error('project_task_control_canary_abandonment_conflict');
            }
            return current;
          }
          const abandonedAt = action.now === undefined ? nowIso() : new Date(action.now).toISOString();
          const phaseBRoots = taskControlCanaryPhaseBRoots(
            current,
            join(context.dataDir, 'orchestrate-dispatch.json'),
            action.fence,
            openedAt,
            abandonedAt,
          );
          if (phaseBRoots.length > 1) {
            throw new Error('project_task_control_canary_abandonment_phase_b_root_conflict');
          }
          const expected = projectTaskControlCanaryAbandonedRecord(action.fence, {
            authorizationRef: action.authorizationRef,
            authorizedByOpenId: action.authorizedByOpenId,
            abandonedAt,
            phaseBDispatchRoot: phaseBRoots[0] ?? null,
          }, openedAt);
          const fence = validatedProjectTaskControlCanaryFence(existing);
          if (projectTaskControlCanaryFenceFingerprint(fence)
            !== projectTaskControlCanaryFenceFingerprint(action.fence)) {
            throw new Error('project_task_control_canary_fence_conflict');
          }
          current.blockerRecords[existingIndex] = expected;
          current.coordinatorSessionId = context.coordinatorSessionId;
          current.revision += 1;
          current.updatedAt = expected.summary
            ? JSON.parse(expected.summary).abandonedAt as string
            : nowIso();
          refreshProjectBlockerProjection(current);
          return current;
      });
      if (!next) throw new Error('project_not_found');
      return next;
    });
  }

  private async persistTaskControlSuccessCertificate(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'persist_task_control_success_certificate' }>,
  ): Promise<ProjectGroupState> {
    const ownedTaskStore = this.taskControlSuccessEvidenceReader
      ? undefined
      : await TaskControlPlaneStore.openReadOnly(context.dataDir, context.larkAppId);
    const readSuccessEvidence = this.taskControlSuccessEvidenceReader
      ?? (input => ownedTaskStore!.readTaskControlSuccessEvidence(input));
    try {
      return withProjectTaskControlChatLockSync(context.dataDir, context.chatId, () => {
        const project = readProjectGroup(context.dataDir, context.chatId);
        if (!project) throw new Error('project_not_found');
        if (project.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
        const now = action.now === undefined ? nowIso() : new Date(action.now).toISOString();
        const expectedFence = projectTaskControlCanaryFenceRecord(action.fence, now);
        const existingFence = project.blockerRecords.find(
          record => record.code === TASK_CONTROL_CANARY_QUARANTINE_CODE,
        );
        if (!existingFence || existingFence.blockerId !== expectedFence.blockerId
          || existingFence.eventId !== expectedFence.eventId
          || existingFence.taskGuid !== expectedFence.taskGuid
          || existingFence.summary !== expectedFence.summary) {
          throw new Error('project_task_control_canary_fence_conflict');
        }
        const fence = validatedProjectTaskControlCanaryFence(existingFence);
        if (!fence.kickoff) throw new Error('project_task_control_success_certificate_kickoff_missing');
        const registryPath = join(context.dataDir, 'orchestrate-dispatch.json');
        if (openTaskControlTurnAdmissions(registryPath, context.chatId).length > 0) {
          throw new Error('project_task_control_success_certificate_turn_claim_open');
        }
        const phaseAOperation = readTaskControlPhaseAOperation(registryPath, fence.dispatchOperationId);
        const phaseAReport = readTaskControlPhaseAFailedReport(registryPath, fence.dispatchOperationId);
        const phaseATurn = phaseAOperation?.messageId
          ? readTaskControlTurnAdmission(registryPath, phaseAOperation.messageId)
          : undefined;
        if (!phaseAOperation || phaseAOperation.state !== 'delivered' || !phaseAOperation.messageId
          || phaseAOperation.chatId !== context.chatId
          || phaseAOperation.fenceFingerprint !== projectTaskControlCanaryFenceFingerprint(fence)
          || phaseAOperation.historicalDispatchRoot !== fence.phaseA.historicalDispatchRoot
          || phaseAOperation.historicalTaskGuid !== fence.phaseA.historicalTaskGuid
          || phaseAOperation.targetAppId !== fence.phaseA.mappedWorkerAppId
          || phaseAOperation.payloadHash !== fence.phaseA.instructionTemplateSha256
          || !phaseAReport
          || phaseAReport.fenceFingerprint !== phaseAOperation.fenceFingerprint
          || phaseAReport.dispatchRoot !== fence.phaseA.historicalDispatchRoot
          || phaseAReport.taskGuid !== fence.phaseA.historicalTaskGuid
          || phaseAReport.reporterAppId !== fence.phaseA.mappedWorkerAppId
          || phaseAReport.sourceTurnId !== phaseAOperation.messageId
          || phaseAReport.contentHash !== fence.phaseA.failedReportSha256
          || !phaseATurn || phaseATurn.state !== 'terminal'
          || phaseATurn.chatId !== context.chatId
          || phaseATurn.dispatchRoot !== fence.phaseA.historicalDispatchRoot
          || phaseATurn.targetAppId !== fence.phaseA.mappedWorkerAppId
          || phaseATurn.sessionId !== phaseAReport.sourceSessionId
          || phaseATurn.workerGeneration !== phaseAReport.workerGeneration) {
          throw new Error('project_task_control_success_certificate_phase_a_invalid');
        }
        const historical = project.workstreams.filter(item => (
          item.dispatchRoot === fence.phaseA.historicalDispatchRoot
          && item.taskControl?.taskGuid === fence.phaseA.historicalTaskGuid
        ));
        if (historical.length !== 1 || historical[0]!.status !== 'failed'
          || historical[0]!.lastReport !== fence.phaseA.failedReportContent) {
          throw new Error('project_task_control_success_certificate_phase_a_project_invalid');
        }

        const seed = readTaskControlSeedOperation(registryPath, fence.dispatchOperationId);
        const kickoff = readTaskControlKickoffOperation(registryPath, fence.dispatchOperationId);
        const dispatches = listDispatchOperations(registryPath, fence.dispatchOperationId);
        const dispatch = dispatches[0];
        const dispatchTaskControl = dispatch?.entry.taskControl as Record<string, unknown> | undefined;
        if (!seed || seed.state !== 'delivered' || seed.sourceAppId !== fence.controllerAppId
          || seed.targetChatId !== context.chatId || !seed.dispatchRoot
          || !kickoff || kickoff.state !== 'delivered' || !kickoff.messageId
          || kickoff.sourceAppId !== fence.controllerAppId || kickoff.chatId !== context.chatId
          || kickoff.dispatchRoot !== seed.dispatchRoot
          || kickoff.fenceFingerprint !== projectTaskControlCanaryFenceFingerprint(fence)
          || JSON.stringify(kickoff.targetAppIds) !== JSON.stringify(fence.targetAppIds)
          || dispatches.length !== 1 || dispatch?.dispatchRoot !== seed.dispatchRoot
          || dispatchTaskControl?.taskGuid !== fence.taskGuid
          || dispatchTaskControl?.controllerAppId !== fence.controllerAppId
          || dispatchTaskControl?.workerAppId !== fence.workerAppId
          || dispatchTaskControl?.reviewerAppId !== fence.reviewerAppId
          || dispatchTaskControl?.acceptorAppId !== fence.acceptorAppId) {
          throw new Error('project_task_control_success_certificate_phase_b_registry_invalid');
        }
        const currentWorkstreams = project.workstreams.filter(item => (
          item.taskControl?.taskGuid === fence.taskGuid || item.dispatchRoot === seed.dispatchRoot
        ));
        const current = currentWorkstreams[0];
        if (currentWorkstreams.length !== 1 || !current
          || current.dispatchRoot !== seed.dispatchRoot
          || current.taskControl?.controllerAppId !== fence.controllerAppId
          || current.taskControl.workerAppId !== fence.workerAppId
          || current.taskControl.reviewerAppId !== fence.reviewerAppId
          || current.taskControl.acceptorAppId !== fence.acceptorAppId
          || current.status !== 'completed'
          || current.delivery?.reportedByAppId !== fence.workerAppId
          || current.delivery.round !== 1
          || current.review?.reviewerAppId !== fence.reviewerAppId
          || current.review.verdict !== 'pass' || current.review.round !== 1) {
          throw new Error('project_task_control_success_certificate_phase_b_project_invalid');
        }
        if ((project.dispatchReservations ?? []).some(item => (
          item.reservationId === fence.dispatchOperationId || item.taskControl?.taskGuid === fence.taskGuid
        ))) {
          throw new Error('project_task_control_success_certificate_reservation_open');
        }
        if (!taskControlScopeIsEmpty(fence.writeScopes)) {
          throw new Error('project_task_control_success_certificate_scope_not_empty');
        }
        const ledger = readSuccessEvidence({
          controllerAppId: fence.controllerAppId,
          phaseA: {
            sourceAppId: phaseAReport.reporterAppId,
            controllerAppId: fence.controllerAppId,
            dispatchRoot: phaseAReport.dispatchRoot,
            sourceSessionId: phaseAReport.sourceSessionId,
            sourceTurnId: phaseAReport.sourceTurnId,
            workerGeneration: phaseAReport.workerGeneration,
            reportRequestId: phaseAReport.reportRequestId,
            contentHash: `sha256:${phaseAReport.contentHash}`,
            taskGuid: phaseAReport.taskGuid,
          },
          phaseB: {
            dispatchRoot: seed.dispatchRoot,
            taskGuid: fence.taskGuid,
            workerAppId: fence.workerAppId,
            reviewerAppId: fence.reviewerAppId,
            sourceTurnId: kickoff.messageId,
            deliveryContentHash: `sha256:${createHash('sha256').update(current.delivery.content).digest('hex')}`,
            reviewContentHash: `sha256:${createHash('sha256').update(current.review.content).digest('hex')}`,
            projectRevision: project.revision,
          },
        });
        const workerTurn = readTaskControlTurnAdmission(
          registryPath, kickoff.messageId, fence.workerAppId,
        );
        const reviewerTurn = readTaskControlTurnAdmission(
          registryPath, kickoff.messageId, fence.reviewerAppId,
        );
        if (!workerTurn || workerTurn.state !== 'terminal'
          || workerTurn.chatId !== context.chatId || workerTurn.dispatchRoot !== seed.dispatchRoot
          || workerTurn.sessionId !== ledger.phaseB.workerSourceSessionId
          || workerTurn.workerGeneration !== ledger.phaseB.workerGeneration
          || !reviewerTurn || reviewerTurn.state !== 'terminal'
          || reviewerTurn.chatId !== context.chatId || reviewerTurn.dispatchRoot !== seed.dispatchRoot
          || reviewerTurn.sessionId !== ledger.phaseB.reviewerSourceSessionId
          || reviewerTurn.workerGeneration !== ledger.phaseB.reviewerGeneration) {
          throw new Error('project_task_control_success_certificate_phase_b_turn_invalid');
        }
        persistTaskControlSuccessCertificateSync(registryPath, {
          operationId: fence.dispatchOperationId,
          chatId: context.chatId,
          fenceFingerprint: projectTaskControlCanaryFenceFingerprint(fence),
          dispatchRoot: seed.dispatchRoot,
          taskGuid: fence.taskGuid,
          evidence: {
            phaseA: {
              instructionMessageId: phaseAOperation.messageId,
              historicalDispatchRoot: fence.phaseA.historicalDispatchRoot,
              historicalTaskGuid: fence.phaseA.historicalTaskGuid,
              reportRequestId: phaseAReport.reportRequestId,
              reportContent: fence.phaseA.failedReportContent,
              reportContentHash: phaseAReport.contentHash,
              ...ledger.phaseA,
            },
            phaseB: {
              seedProviderUuid: seed.providerUuid,
              kickoffProviderUuid: kickoff.providerUuid,
              kickoffMessageId: kickoff.messageId,
              projectRevision: project.revision,
              deliveryRound: current.delivery.round,
              deliveryContentHash: `sha256:${createHash('sha256').update(current.delivery.content).digest('hex')}`,
              reviewRound: current.review.round,
              reviewVerdict: current.review.verdict,
              reviewContentHash: `sha256:${createHash('sha256').update(current.review.content).digest('hex')}`,
              workerTurnTerminalAt: workerTurn.terminalAt,
              reviewerTurnTerminalAt: reviewerTurn.terminalAt,
              ...ledger.phaseB,
            },
            scope: { paths: fence.writeScopes, empty: true },
          },
          createdAt: now,
        });
        return project;
      });
    } finally {
      ownedTaskStore?.close();
    }
  }

  private beginTaskControlPhaseAInstruction(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'begin_task_control_phase_a_instruction' }>,
  ): ProjectGroupState {
    return withProjectTaskControlChatLockSync(context.dataDir, context.chatId, () => {
      const project = readProjectGroup(context.dataDir, context.chatId);
      if (!project) throw new Error('project_not_found');
      if (project.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
      const record = project.blockerRecords.find(
        item => item.code === TASK_CONTROL_CANARY_QUARANTINE_CODE,
      );
      if (!record) throw new Error('project_task_control_canary_fence_missing');
      const fence = validatedProjectTaskControlCanaryFence(record);
      if (action.fenceFingerprint.trim().toLowerCase() !== projectTaskControlCanaryFenceFingerprint(fence)
        || action.instructionTemplateSha256.trim().toLowerCase() !== fence.phaseA.instructionTemplateSha256) {
        throw new Error('project_task_control_phase_a_operation_conflict');
      }
      beginTaskControlPhaseAInstructionSync(
        join(context.dataDir, 'orchestrate-dispatch.json'),
        {
          operationId: fence.dispatchOperationId,
          chatId: context.chatId,
          fenceFingerprint: action.fenceFingerprint,
          historicalDispatchRoot: fence.phaseA.historicalDispatchRoot,
          historicalTaskGuid: fence.phaseA.historicalTaskGuid,
          targetAppId: fence.phaseA.mappedWorkerAppId,
          payloadHash: fence.phaseA.instructionTemplateSha256,
          attempt: action.attempt,
        },
      );
      return project;
    });
  }

  private completeTaskControlPhaseAInstruction(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'complete_task_control_phase_a_instruction' }>,
  ): ProjectGroupState {
    return withProjectTaskControlChatLockSync(context.dataDir, context.chatId, () => {
      const project = readProjectGroup(context.dataDir, context.chatId);
      if (!project) throw new Error('project_not_found');
      if (project.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
      const record = project.blockerRecords.find(
        item => item.code === TASK_CONTROL_CANARY_QUARANTINE_CODE,
      );
      if (!record) throw new Error('project_task_control_canary_fence_missing');
      const fence = validatedProjectTaskControlCanaryFence(record);
      const fenceFingerprint = projectTaskControlCanaryFenceFingerprint(fence);
      if (action.fenceFingerprint.trim().toLowerCase() !== fenceFingerprint) {
        throw new Error('project_task_control_phase_a_operation_conflict');
      }
      completeTaskControlPhaseAInstructionSync(
        join(context.dataDir, 'orchestrate-dispatch.json'),
        { operationId: fence.dispatchOperationId, fenceFingerprint, messageId: action.messageId },
      );
      return project;
    });
  }

  private applyTaskControlPhaseAFailedReport(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'report' }>,
  ): ProjectGroupState {
    return withProjectTaskControlChatLockSync(context.dataDir, context.chatId, () => {
      const project = readProjectGroup(context.dataDir, context.chatId);
      if (!project) throw new Error('project_not_found');
      if (project.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
      const fenceRecord = project.blockerRecords.find(
        item => item.code === TASK_CONTROL_CANARY_QUARANTINE_CODE,
      );
      if (!fenceRecord) throw new Error('project_task_control_phase_a_report_rejected');
      const fence = validatedProjectTaskControlCanaryFence(fenceRecord);
      const phaseAReport = action.phaseAReport;
      const fenceFingerprint = projectTaskControlCanaryFenceFingerprint(fence);
      if (!phaseAReport
        || action.dispatchRoot !== fence.phaseA.historicalDispatchRoot
        || action.reporterAppId?.trim() !== fence.phaseA.mappedWorkerAppId
        || action.status !== 'failed'
        || action.content !== fence.phaseA.failedReportContent
        || action.progress !== undefined
        || action.remaining !== undefined
        || action.milestone !== undefined
        || action.reviewVerdict !== undefined
        || action.reviewRound !== undefined
        || phaseAReport.operationId.trim() !== fence.dispatchOperationId
        || phaseAReport.fenceFingerprint.trim().toLowerCase() !== fenceFingerprint) {
        throw new Error('project_task_control_phase_a_report_rejected');
      }
      claimTaskControlPhaseAFailedReportSync(
        join(context.dataDir, 'orchestrate-dispatch.json'),
        {
          operationId: phaseAReport.operationId,
          fenceFingerprint: phaseAReport.fenceFingerprint,
          chatId: context.chatId,
          dispatchRoot: action.dispatchRoot,
          taskGuid: fence.phaseA.historicalTaskGuid,
          reporterAppId: action.reporterAppId,
          sourceSessionId: phaseAReport.sourceSessionId,
          sourceTurnId: phaseAReport.sourceTurnId,
          workerGeneration: phaseAReport.workerGeneration,
          reportRequestId: phaseAReport.reportRequestId,
          contentHash: fence.phaseA.failedReportSha256,
        },
      );
      const next = mutateProjectGroupSync(context.dataDir, context.chatId, current => {
        if (!current) throw new Error('project_not_found');
        if (current.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
        const currentFenceRecord = current.blockerRecords.find(
          item => item.code === TASK_CONTROL_CANARY_QUARANTINE_CODE,
        );
        if (!currentFenceRecord
          || projectTaskControlCanaryFenceFingerprint(
            validatedProjectTaskControlCanaryFence(currentFenceRecord),
          ) !== fenceFingerprint) {
          throw new Error('project_task_control_phase_a_report_rejected');
        }
        const item = current.workstreams.find(
          candidate => candidate.dispatchRoot === fence.phaseA.historicalDispatchRoot,
        );
        if (!item || item.access?.mode !== 'write'
          || item.taskControl?.sourceKind !== 'project_group'
          || item.taskControl.taskGuid !== fence.phaseA.historicalTaskGuid
          || !item.workerAppIds?.includes(fence.phaseA.mappedWorkerAppId)) {
          throw new Error('project_task_control_phase_a_report_rejected');
        }
        if (item.status === 'failed'
          && item.lastReport === fence.phaseA.failedReportContent
          && item.blocker === fence.phaseA.failedReportContent) {
          return current;
        }
        if (item.status === 'completed' || item.status === 'failed') {
          throw new Error('project_task_control_phase_a_report_rejected');
        }
        const now = nowIso();
        current.coordinatorSessionId = context.coordinatorSessionId;
        current.revision += 1;
        current.updatedAt = now;
        item.status = 'failed';
        item.progress = statusProgress('failed', undefined, item.progress);
        item.lastReport = fence.phaseA.failedReportContent;
        delete item.remaining;
        item.blocker = fence.phaseA.failedReportContent;
        item.updatedAt = now;
        current.milestones = current.milestones.slice(-50);
        return current;
      });
      if (!next) throw new Error('project_not_found');
      return next;
    });
  }

  run(context: ProjectCoordinatorContext, action: ProjectCoordinatorAction): Promise<ProjectGroupState> {
    if (action.action === 'install_task_control_canary_fence') {
      return Promise.resolve().then(() => this.installTaskControlCanaryFence(context, action));
    }
    if (action.action === 'claim_task_control_turn_admission') {
      return Promise.resolve().then(() => this.claimTaskControlTurnAdmission(context, action));
    }
    if (action.action === 'clear_task_control_canary_fence') {
      return Promise.resolve().then(() => this.clearTaskControlCanaryFence(context, action));
    }
    if (action.action === 'abandon_task_control_canary') {
      return Promise.resolve().then(() => this.abandonTaskControlCanary(context, action));
    }
    if (action.action === 'persist_task_control_success_certificate') {
      return this.persistTaskControlSuccessCertificate(context, action);
    }
    if (action.action === 'begin_task_control_phase_a_instruction') {
      return Promise.resolve().then(() => this.beginTaskControlPhaseAInstruction(context, action));
    }
    if (action.action === 'complete_task_control_phase_a_instruction') {
      return Promise.resolve().then(() => this.completeTaskControlPhaseAInstruction(context, action));
    }
    if (action.action === 'report' && action.phaseAReport) {
      return Promise.resolve().then(() => this.applyTaskControlPhaseAFailedReport(context, action));
    }
    if (action.action === 'replace_workstream_reviewer') {
      return this.runReviewerReplacement(context, action).then(result => result.project);
    }
    if (action.action === 'archive_workstream') {
      return this.runWorkstreamArchive(context, action).then(result => result.project);
    }
    if (action.action === 'retire_task_control_canary_abandoned') {
      return this.runTaskControlCanaryAbandonedRetirement(context, action)
        .then(result => result.project);
    }
    if (action.action === 'reserve_dispatch'
      || action.action === 'commit_dispatch'
      || action.action === 'abort_dispatch'
      || action.action === 'bind_dispatch_root'
      || action.action === 'mark_task_control_mapping'
      || action.action === 'sync_completion_gate') {
      return this.apply(context, action);
    }
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      if (action.action === 'status') {
        const current = readProjectGroup(context.dataDir, context.chatId);
        if (!current) throw new Error('project_not_found');
        return projectStatusView(current);
      }
      if (action.action === 'refresh') {
        const current = readProjectGroup(context.dataDir, context.chatId);
        if (!current) throw new Error('project_not_found');
        if (current.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
        return this.publish(context, current);
      }
      const changed = await this.apply(context, action);
      if (action.action === 'report' && changed.workstreams
        .some(item => item.dispatchRoot === action.dispatchRoot && item.access?.mode === 'write')) {
        return changed;
      }
      return this.publish(context, changed);
    });
  }

  runWorkstreamArchive(
    context: ProjectCoordinatorContext,
    action: ProjectWorkstreamArchiveAction,
  ): Promise<{ project: ProjectGroupState; projectionWarning?: string }> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      const applied = await this.apply(context, action);
      try {
        // Archive's business mutation already advanced the revision; the card
        // projection is always a refresh and must never additionally bump it.
        return { project: await this.publish(context, applied, false, false) };
      } catch (error) {
        return {
          project: readProjectGroup(context.dataDir, context.chatId) ?? applied,
          projectionWarning: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  runTaskControlCanaryAbandonedRetirement(
    context: ProjectCoordinatorContext,
    action: ProjectTaskControlCanaryAbandonedRetirementAction,
  ): Promise<{ project: ProjectGroupState; projectionWarning?: string }> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      // Detect exact replay inside the store lock so that a concurrent
      // writer cannot race a stale outer revision read before apply
      // acquires the lock.  The replay flag controls whether publish
      // persists card metadata (first submit) or only re-projects the
      // card without changing store bytes (replay).
      const replayFlag = { wasReplay: false };
      const applied = await this.apply(context, action, replayFlag);
      try {
        return { project: await this.publish(context, applied, false, false, !replayFlag.wasReplay) };
      } catch (error) {
        return {
          project: readProjectGroup(context.dataDir, context.chatId) ?? applied,
          projectionWarning: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  runReport(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'report' }>,
  ): Promise<{ project: ProjectGroupState; write: boolean; projectionWarning?: string }> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      const execute = async () => {
        const applied = action.phaseAReport
          ? this.applyTaskControlPhaseAFailedReport(context, action)
          : await this.apply(context, action);
        const write = applied.workstreams
          .some(item => item.dispatchRoot === action.dispatchRoot && item.access?.mode === 'write');
        try {
          return { project: await this.publish(context, applied), write };
        } catch (error) {
          return {
            project: readProjectGroup(context.dataDir, context.chatId) ?? applied,
            write,
            projectionWarning: error instanceof Error ? error.message : String(error),
          };
        }
      };
      if (action.phaseAReport) return execute();
      const current = readProjectGroup(context.dataDir, context.chatId);
      const mapped = current?.workstreams.find(item => item.dispatchRoot === action.dispatchRoot)?.taskControl;
      return mapped?.sourceKind === 'project_group'
        ? withProjectTaskControlChatLock(context.dataDir, context.chatId, execute)
        : execute();
    });
  }

  runReviewerReplacement(
    context: ProjectCoordinatorContext,
    action: ProjectWorkstreamReviewerReplacementAction,
  ): Promise<{ project: ProjectGroupState; projectionWarning?: string }> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      const { applied, beforeRevision } = await withProjectTaskControlChatLock(context.dataDir, context.chatId, async () => {
        const groupMode = readGroupCollaborationMode(context.dataDir, context.chatId);
        if (groupMode?.mode !== 'project') {
          throw new Error('project_mode_required');
        }
        // Validate the reviewer app-id format before any store reads,
        // keeping the existing validation order from apply().
        if (!PROJECT_REVIEWER_APP_ID_RE.test(action.newReviewerAppId.trim())) {
          throw new Error('project_reviewer_app_id_invalid');
        }
        // Read the project to check for an exact durable receipt replay before
        // enforcing the allowlist.  Exact replays must remain idempotent even
        // after the collaboration-mode policy is updated to exclude the reviewer.
        const project = readProjectGroup(context.dataDir, context.chatId);
        const reason = boundedText(action.reason, 160);
        const operationFingerprint = reviewerReplacementFingerprint(context, action, reason);
        const hasExactReceipt = project?.workstreams.some(item =>
          item.dispatchRoot === action.dispatchRoot.trim()
          && (item.reviewerReplacementReceipts ?? []).some(
            receipt => receipt.operationFingerprint === operationFingerprint,
          ),
        );
        if (!hasExactReceipt) {
          const workerAppIds = new Set(
            (groupMode.workerAppIds ?? []).map(id => id.trim()).filter(Boolean),
          );
          if (!workerAppIds.has(action.newReviewerAppId.trim())) {
            throw new Error('project_reviewer_not_allowed');
          }
        }
        const beforeRevision = project?.revision;
        const applied = await this.apply(context, action);
        return { applied, beforeRevision };
      });
      try {
        // publish must run outside the chat lock: it calls
        // retireOnboardingCard → writeProjectOnboardingCard →
        // withLockedGroupConfig → withProjectTaskControlChatLockSync,
        // which would re-enter the same non-reentrant lock.
        // An exact replay (revision unchanged) re-projects only the card without
        // resolving threadIds or recording a projection revision; a new mutation
        // keeps full publish behavior (resolve + record projection revision).
        const replay = applied.revision === beforeRevision;
        return { project: await this.publish(context, applied, !replay, !replay) };
      } catch (error) {
        return {
          project: readProjectGroup(context.dataDir, context.chatId) ?? applied,
          projectionWarning: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  async claimStageAdvance(
    context: ProjectCoordinatorContext,
    options: {
      now?: string;
      leaseMs?: number;
      excludeFingerprints?: readonly string[] | ReadonlySet<string>;
    } = {},
  ): Promise<ClaimedProjectStageAdvance | undefined> {
    const now = new Date(options.now ?? nowIso()).toISOString();
    const leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('project_stage_advance_lease_invalid');
    let claimed: ClaimedProjectStageAdvance | undefined;
    await mutateProjectGroup(context.dataDir, context.chatId, current => {
      if (!current) throw new Error('project_not_found');
      if (current.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
      current.stageAdvanceEvents ??= [];
      const excluded = options.excludeFingerprints instanceof Set
        ? options.excludeFingerprints
        : new Set(options.excludeFingerprints ?? []);
      const nowMs = Date.parse(now);
      const event = current.stageAdvanceEvents.find(candidate => (
        !excluded.has(candidate.fingerprint)
        && (candidate.status === 'pending'
          || (candidate.status === 'dispatching' && !!candidate.claimExpiresAt && Date.parse(candidate.claimExpiresAt) <= nowMs))
      ));
      if (!event) return current;
      if (event.status === 'pending' && event.attemptCount >= 3) {
        const blockerId = projectBlockerId('task_control', `stage-auto-advance:${event.fingerprint}`);
        delete event.claimId;
        delete event.claimExpiresAt;
        event.status = 'blocked';
        event.lastErrorCode = 'stage_auto_advance_attempt_limit';
        event.updatedAt = now;
        upsertProjectBlocker(current, {
          blockerId,
          source: 'task_control',
          code: event.lastErrorCode,
          summary: '阶段自动推进重试次数已达上限',
          openedAt: now,
          eventId: event.fingerprint,
        });
        current.revision += 1;
        current.updatedAt = now;
        return current;
      }
      const targetSessionId = (event.status === 'pending'
        ? current.coordinatorSessionId
        : event.targetSessionId ?? current.coordinatorSessionId).trim();
      if (!targetSessionId) throw new Error('project_stage_advance_target_invalid');
      const claimId = `psac:${randomUUID()}`;
      event.status = 'dispatching';
      event.claimId = claimId;
      event.claimExpiresAt = new Date(nowMs + leaseMs).toISOString();
      event.targetSessionId = targetSessionId;
      if (event.attemptCount < 3) event.attemptCount += 1;
      event.updatedAt = now;
      current.revision += 1;
      current.updatedAt = now;
      claimed = { event: structuredClone(event), claimId };
      return current;
    });
    return claimed;
  }

  async settleStageAdvance(
    context: ProjectCoordinatorContext,
    input: {
      fingerprint: string;
      claimId: string;
      outcome: 'dispatched' | 'retryable_failure' | 'blocked';
      targetSessionId: string;
      triggerId?: string;
      errorCode?: string;
      now?: string;
    },
  ): Promise<ProjectGroupState> {
    const now = new Date(input.now ?? nowIso()).toISOString();
    const next = await mutateProjectGroup(context.dataDir, context.chatId, current => {
      if (!current) throw new Error('project_not_found');
      if (current.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
      const event = (current.stageAdvanceEvents ?? []).find(item => item.fingerprint === input.fingerprint);
      if (!event || event.status !== 'dispatching' || event.claimId !== input.claimId
        || !input.targetSessionId.trim() || event.targetSessionId !== input.targetSessionId.trim()) {
        throw new Error('project_stage_advance_claim_conflict');
      }
      const blockerId = projectBlockerId('task_control', `stage-auto-advance:${event.fingerprint}`);
      delete event.claimId;
      delete event.claimExpiresAt;
      event.updatedAt = now;
      if (input.outcome === 'dispatched') {
        if (!input.targetSessionId?.trim() || !input.triggerId?.trim()) throw new Error('project_stage_advance_dispatch_identity_required');
        event.status = 'dispatched';
        event.targetSessionId = input.targetSessionId.trim();
        event.triggerId = input.triggerId.trim();
        delete event.lastErrorCode;
        removeProjectBlocker(current, blockerId);
      } else if (input.outcome === 'retryable_failure' && event.attemptCount < 3) {
        event.status = 'pending';
        event.lastErrorCode = (input.errorCode ?? 'pre_dispatch_failed').trim();
      } else {
        event.status = 'blocked';
        event.lastErrorCode = (input.errorCode ?? 'stage_auto_advance_blocked').trim();
        upsertProjectBlocker(current, {
          blockerId, source: 'task_control', code: event.lastErrorCode,
          summary: `阶段自动推进受阻：${event.lastErrorCode}`, openedAt: now, eventId: event.fingerprint,
        });
      }
      current.revision += 1;
      current.updatedAt = now;
      return current;
    });
    if (!next) throw new Error('project_not_found');
    return next;
  }

  private async apply(
    context: ProjectCoordinatorContext,
    action: Exclude<ProjectCoordinatorAction, {
      action: 'status' | 'refresh' | 'install_task_control_canary_fence'
        | 'clear_task_control_canary_fence' | 'abandon_task_control_canary'
        | 'persist_task_control_success_certificate'
        | 'claim_task_control_turn_admission'
        | 'begin_task_control_phase_a_instruction' | 'complete_task_control_phase_a_instruction';
    }>,
    replayDetection?: { wasReplay: boolean },
  ): Promise<ProjectGroupState> {
    const reservedAccess = action.action === 'reserve_dispatch' && action.access.mode === 'write'
      ? { mode: 'write' as const, scopes: normalizeDispatchWriteScopes(action.access.scopes) }
      : action.action === 'reserve_dispatch' ? action.access : undefined;
    const next = await mutateProjectGroup(context.dataDir, context.chatId, (current, registry) => {
      const now = action.action === 'sync_completion_gate'
        ? new Date(action.checkedAt).toISOString()
        : (action.action === 'reserve_dispatch' || action.action === 'close'
        || action.action === 'add_completion_gate' || action.action === 'retire_completion_gate'
        || action.action === 'replace_completion_gate'
        || action.action === 'replace_workstream_reviewer'
        || action.action === 'archive_workstream'
        || action.action === 'retire_task_control_canary_abandoned') && action.now !== undefined
        ? new Date(action.now).toISOString()
        : nowIso();
      if (action.action === 'init') {
        if (current) throw new Error('project_already_exists');
        const title = boundedText(action.title, 80);
        const goal = boundedText(action.goal, 500);
        if (!title || !goal) throw new Error('title_and_goal_required');
        return {
          schemaVersion: 3, revision: 1,
          chatId: context.chatId, larkAppId: context.larkAppId,
          coordinatorSessionId: context.coordinatorSessionId,
          title, goal,
          phase: boundedText(action.phase, 80, '规划'),
          focus: boundedText(action.focus, 300, '拆解并派发首批子任务'),
          status: 'active' as ProjectGroupStatus,
          ...(boundedText(action.remaining, 160) ? { remaining: boundedText(action.remaining, 160) } : {}),
          blockers: [], blockerRecords: [], workstreams: [], stageAdvanceEvents: [], completionGates: [], dispatchReservations: [], milestones: [], createdAt: now, updatedAt: now,
        };
      }
      if (!current) throw new Error('project_not_found');
      if (current.larkAppId !== context.larkAppId) {
        throw new Error('project_coordinator_mismatch');
      }
      const previousCoordinatorSessionId = current.coordinatorSessionId;
      const previousRevision = current.revision;
      const previousUpdatedAt = current.updatedAt;
      // A chat-scope session may be recreated after an explicit close or daemon
      // migration. The authenticated live session for the same bot+chat becomes
      // the new report target; topic-scoped sessions are rejected by the route.
      if (action.action !== 'sync_completion_gate') {
        current.coordinatorSessionId = context.coordinatorSessionId;
      }
      current.revision += 1;
      current.updatedAt = now;
      const hadReservations = current.dispatchReservations !== undefined;
      current.dispatchReservations ??= [];
      const nowMs = Date.parse(now);
      const actionDispatchRoot = 'dispatchRoot' in action && typeof action.dispatchRoot === 'string'
        ? action.dispatchRoot.trim()
        : undefined;
      if (actionDispatchRoot && abandonedTaskControlCanaryRejectsRoot(
        current,
        join(context.dataDir, 'orchestrate-dispatch.json'),
        actionDispatchRoot,
      )
        && (action.action === 'dispatch' || action.action === 'report'
          || action.action === 'mark_task_control_mapping' || action.action === 'fail_dispatch')) {
        throw new Error('project_task_control_canary_abandoned');
      }
      if (action.action === 'reserve_dispatch') {
        if (current.status !== 'active') throw new Error('project_not_active');
        const reservationId = action.reservationId.trim();
        if (!reservationId) throw new Error('project_dispatch_reservation_id_required');
        const canaryFence = projectTaskControlCanaryFenceForReservation(
          current, reservationId, action.taskControl !== undefined,
        );
        const targetAppIds = targetIdentity(action.targetAppIds);
        if (canaryFence) {
          assertProjectTaskControlCanaryFenceReservation(canaryFence, current, {
            reservationId, targetAppIds, access: reservedAccess!,
            taskControl: action.taskControl ? {
              ...action.taskControl,
              coordinatorSessionId: context.coordinatorSessionId,
            } : undefined,
          });
        }
        if (!canaryFence) {
          current.dispatchReservations = current.dispatchReservations.filter(item => Date.parse(item.expiresAt) > nowMs);
        }
        const existing = current.dispatchReservations.find(item => item.reservationId === reservationId);
        if (existing) {
          if (!sameTargets(existing.targetAppIds, targetAppIds) || !sameAccess(existing.access, reservedAccess!)
            || !sameTaskControlReservation(existing.taskControl, action.taskControl ? {
              ...action.taskControl,
              coordinatorSessionId: context.coordinatorSessionId,
            } : undefined)) {
            throw new Error('project_dispatch_reservation_conflict');
          }
          if (!sameRepositoryLeaseRef(existing.repositoryLeaseRef, action.repositoryLeaseRef)) {
            throw new Error('project_repository_lease_ref_conflict');
          }
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (action.taskControl) {
          const maxActiveMappings = action.maxActiveTaskControlMappings;
          if (!Number.isSafeInteger(maxActiveMappings) || maxActiveMappings! < 1) {
            throw new Error('project_task_control_capacity_required');
          }
          let activeMappings = 0;
          for (const item of current.workstreams) {
            if (item.taskControl?.sourceKind !== 'project_group') continue;
            const decision = action.getTaskControlMappingDecision?.({
              dispatchRoot: item.dispatchRoot,
              taskGuid: item.taskControl.taskGuid,
            });
            if (!decision?.capacityReleased) {
              activeMappings += 1;
              continue;
            }
            if (!decision.admissionSafe) throw new Error('project_task_control_admission_unsafe');
          }
          const activeReservations = current.dispatchReservations.filter(item => item.taskControl?.mode === 'audit_only').length;
          if (activeMappings + activeReservations >= maxActiveMappings!) {
            throw new Error('project_task_control_canary_capacity_reached');
          }
        }
        const conflicts = current.workstreams.some(item => (
          item.access && holdsWriteClaim(item.status) && projectDispatchAccessConflicts(item.access, reservedAccess!)
        )) || current.dispatchReservations.some(item => projectDispatchAccessConflicts(item.access, reservedAccess!));
        if (conflicts) throw new Error('project_write_scope_conflict');
        const ttlMs = action.ttlMs ?? PROJECT_DISPATCH_RESERVATION_TTL_MS;
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
          throw new Error('project_dispatch_reservation_ttl_invalid');
        }
        if (action.taskControl && reservedAccess!.mode !== 'write') {
          throw new Error('project_task_control_write_scope_required');
        }
        current.dispatchReservations.push({
          reservationId, targetAppIds, access: structuredClone(reservedAccess!), createdAt: now,
          expiresAt: new Date(nowMs + ttlMs).toISOString(),
          ...(action.repositoryLeaseRef
            ? { repositoryLeaseRef: structuredClone(action.repositoryLeaseRef) }
            : {}),
          ...(action.taskControl ? {
            stage: 'reserved' as const,
            taskControl: { ...structuredClone(action.taskControl), coordinatorSessionId: context.coordinatorSessionId },
          } : {}),
        });
      } else if (action.action === 'bind_dispatch_root') {
        const reservationId = action.reservationId.trim();
        if (!reservationId) throw new Error('project_dispatch_reservation_id_required');
        const canaryFence = projectTaskControlCanaryFenceForReservation(current, reservationId);
        const targetAppIds = targetIdentity(action.targetAppIds);
        const reservation = current.dispatchReservations.find(item => item.reservationId === reservationId);
        if (!reservation) throw new Error('project_dispatch_reservation_not_found');
        if (canaryFence) assertProjectTaskControlCanaryFenceReservation(canaryFence, current, reservation);
        if (!sameTargets(reservation.targetAppIds, targetAppIds)) {
          throw new Error('project_dispatch_reservation_identity_mismatch');
        }
        if (!reservation.taskControl) throw new Error('project_task_control_reservation_required');
        const dispatchRoot = action.dispatchRoot.trim();
        if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(dispatchRoot)) throw new Error('invalid_dispatch_root');
        const rootCreateTime = new Date(action.rootCreateTime).toISOString();
        if (reservation.stage === 'root_created') {
          if (reservation.dispatchRoot !== dispatchRoot || reservation.rootCreateTime !== rootCreateTime) {
            throw new Error('project_dispatch_root_conflict');
          }
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        reservation.stage = 'root_created';
        reservation.dispatchRoot = dispatchRoot;
        reservation.rootCreateTime = rootCreateTime;
      } else if (action.action === 'abort_dispatch') {
        const reservationId = action.reservationId.trim();
        if (!reservationId) throw new Error('project_dispatch_reservation_id_required');
        projectTaskControlCanaryFenceForReservation(current, reservationId);
        const targetAppIds = targetIdentity(action.targetAppIds);
        const index = current.dispatchReservations.findIndex(item => item.reservationId === reservationId);
        if (index < 0) {
          if (!hadReservations) delete current.dispatchReservations;
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (!sameTargets(current.dispatchReservations[index]!.targetAppIds, targetAppIds)) {
          throw new Error('project_dispatch_reservation_identity_mismatch');
        }
        current.dispatchReservations.splice(index, 1);
      } else if (action.action === 'commit_dispatch') {
        if (current.status !== 'active') throw new Error('project_not_active');
        const reservationId = action.reservationId.trim();
        if (!reservationId) throw new Error('project_dispatch_reservation_id_required');
        const canaryFence = projectTaskControlCanaryFenceForReservation(current, reservationId);
        const targetAppIds = targetIdentity(action.targetAppIds);
        const reservationIndex = current.dispatchReservations.findIndex(item => item.reservationId === reservationId);
        if (reservationIndex < 0) throw new Error('project_dispatch_reservation_not_found');
        const reservation = current.dispatchReservations[reservationIndex]!;
        if (canaryFence) {
          assertProjectTaskControlCanaryFenceReservation(canaryFence, current, reservation);
          assertProjectTaskControlCanaryFenceCommit(canaryFence, action);
        }
        if (!sameTargets(reservation.targetAppIds, targetAppIds)) {
          throw new Error('project_dispatch_reservation_identity_mismatch');
        }
        if (!sameRepositoryLeaseRef(reservation.repositoryLeaseRef, action.repositoryLeaseRef)) {
          throw new Error('project_repository_lease_ref_conflict');
        }
        current.dispatchReservations.splice(reservationIndex, 1);
        const root = action.dispatchRoot.trim();
        if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(root)) throw new Error('invalid_dispatch_root');
        if (reservation.taskControl
          && (reservation.stage !== 'root_created' || reservation.dispatchRoot !== root || !reservation.rootCreateTime)) {
          throw new Error('project_dispatch_root_not_bound');
        }
        if (current.workstreams.some(item => item.dispatchRoot === root)) throw new Error('project_workstream_exists');
        const workerAppIds = [...new Set((action.workerAppIds ?? []).map(id => id.trim()).filter(Boolean))].sort();
        const reviewerAppIds = [...new Set((action.reviewerAppIds ?? []).map(id => id.trim()).filter(Boolean))].sort();
        if (reservation.access.mode === 'write') {
          if (workerAppIds.length === 0) throw new Error('project_worker_required');
          if (reviewerAppIds.length === 0) throw new Error('project_reviewer_required');
          if (workerAppIds.some(id => reviewerAppIds.includes(id))) throw new Error('project_review_roles_overlap');
          const assigned = [...new Set([...workerAppIds, ...reviewerAppIds])].sort();
          if (!sameTargets(assigned, targetAppIds)) throw new Error('project_dispatch_role_targets_mismatch');
        }
        if (reservation.taskControl
          && (workerAppIds.length !== 1 || reviewerAppIds.length !== 1
            || workerAppIds[0] !== reservation.taskControl.workerAppId
            || reviewerAppIds[0] !== reservation.taskControl.reviewerAppId)) {
          throw new Error('project_task_control_roles_mismatch');
        }
        const title = boundedText(action.title, 80);
        if (!title || title === '子任务' || title === '子项目') throw new Error('project_workstream_title_required');
        if (Array.from(title).length > 24) throw new Error('project_workstream_title_too_long');
        current.workstreams.push({
          dispatchRoot: root, title, purpose: boundedText(action.purpose, 300, '等待补充任务说明'),
          owners: (action.owners ?? []).map(owner => boundedText(owner, 80)).filter(Boolean).slice(0, 16),
          targetAppIds, access: reservation.access, status: 'pending', progress: 0,
          ...(reservation.repositoryLeaseRef
            ? { repositoryLeaseRef: structuredClone(reservation.repositoryLeaseRef) }
            : {}),
          ...(workerAppIds.length > 0 ? { workerAppIds } : {}),
          ...(reviewerAppIds.length > 0 ? { reviewerAppIds } : {}),
          ...(reservation.taskControl ? {
            taskControl: {
              taskGuid: reservation.taskControl.taskGuid,
              phaseId: reservation.taskControl.phaseId,
              mappingRef: `topic-message:${root}`,
              mappingStatus: 'pending' as const,
              sourceKind: 'project_group' as const,
              controllerAppId: context.larkAppId,
              workerAppId: reservation.taskControl.workerAppId,
              reviewerAppId: reservation.taskControl.reviewerAppId,
              acceptorAppId: reservation.taskControl.acceptorAppId,
              projectRevision: current.revision,
              reservationId: reservation.reservationId,
              coordinatorSessionId: reservation.taskControl.coordinatorSessionId ?? context.coordinatorSessionId,
              originTurnId: reservation.taskControl.originTurnId,
              reservationCreatedAt: reservation.createdAt,
              reservationExpiresAt: reservation.expiresAt,
              rootCreateTime: reservation.rootCreateTime!,
              reservationProof: structuredClone(reservation.taskControl.proof),
              ...(reservation.taskControl.recovery
                ? { recovery: structuredClone(reservation.taskControl.recovery) }
                : {}),
            },
          } : {}),
          createdAt: now, updatedAt: now,
        });
      } else if (action.action === 'replace_workstream_reviewer') {
        const dispatchRoot = action.dispatchRoot.trim();
        const oldReviewerAppId = action.oldReviewerAppId.trim();
        const newReviewerAppId = action.newReviewerAppId.trim();
        const authorizationRef = action.authorizationRef.trim();
        const authorizedByOpenId = action.authorizedByOpenId?.trim() ?? '';
        const reason = boundedText(action.reason, 160);
        if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(dispatchRoot)) throw new Error('invalid_dispatch_root');
        if (!PROJECT_REVIEWER_APP_ID_RE.test(oldReviewerAppId)
          || !PROJECT_REVIEWER_APP_ID_RE.test(newReviewerAppId)) {
          throw new Error('project_reviewer_app_id_invalid');
        }
        if (!Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 1) {
          throw new Error('project_revision_invalid');
        }
        if (!COMPLETION_GATE_AUTHORIZATION_RE.test(authorizationRef)
          || !COMPLETION_GATE_AUTHORIZED_ACTOR_RE.test(authorizedByOpenId)) {
          throw new Error('project_workstream_reviewer_authorization_required');
        }
        if (!reason) throw new Error('project_reviewer_replace_reason_required');
        const operationFingerprint = reviewerReplacementFingerprint(context, action, reason);
        const item = current.workstreams.find(candidate => candidate.dispatchRoot === dispatchRoot);
        if (!item) throw new Error('workstream_not_found');
        const hasExactReceipt = item.reviewerReplacementReceipts?.some(
          receipt => receipt.operationFingerprint === operationFingerprint,
        );
        if (hasExactReceipt) {
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        const exactRetry = item.reviewerReplacements?.find(record => (
          record.oldReviewerAppId === oldReviewerAppId
          && record.newReviewerAppId === newReviewerAppId
          && record.authorizationRef === authorizationRef
          && record.authorizedByOpenId === authorizedByOpenId
          && record.reason === reason
          && record.coordinatorSessionId === context.coordinatorSessionId
          && record.fromRevision === action.expectedRevision
          && item.reviewerAppIds?.includes(newReviewerAppId)
          && !item.reviewerAppIds?.includes(oldReviewerAppId)
          && item.targetAppIds?.includes(newReviewerAppId)
          && !item.targetAppIds?.includes(oldReviewerAppId)
        ));
        if (exactRetry) {
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (action.expectedRevision !== previousRevision) throw new Error('project_revision_conflict');
        if (item.taskControl) throw new Error('project_reviewer_replace_task_control_unsupported');
        if (item.access?.mode !== 'write' || item.status !== 'in_review' || item.review || !item.delivery) {
          throw new Error('project_reviewer_replace_state_invalid');
        }
        const reviewerAppIds = item.reviewerAppIds ?? [];
        const targetAppIds = item.targetAppIds ?? [];
        if (reviewerAppIds.filter(appId => appId === oldReviewerAppId).length !== 1
          || targetAppIds.filter(appId => appId === oldReviewerAppId).length !== 1) {
          throw new Error('project_old_reviewer_mismatch');
        }
        if (item.workerAppIds?.includes(newReviewerAppId)) throw new Error('project_review_roles_overlap');
        if (oldReviewerAppId === newReviewerAppId || reviewerAppIds.includes(newReviewerAppId)
          || targetAppIds.includes(newReviewerAppId)) {
          throw new Error('project_reviewer_already_assigned');
        }
        item.reviewerAppIds = reviewerAppIds.map(
          appId => appId === oldReviewerAppId ? newReviewerAppId : appId,
        );
        item.targetAppIds = targetAppIds.map(
          appId => appId === oldReviewerAppId ? newReviewerAppId : appId,
        );
        item.reviewerReplacements = [
          ...(item.reviewerReplacements ?? []).slice(-31),
          {
            oldReviewerAppId,
            newReviewerAppId,
            authorizationRef,
            authorizedByOpenId,
            reason,
            coordinatorSessionId: context.coordinatorSessionId,
            replacedAt: now,
            fromRevision: previousRevision,
            toRevision: current.revision,
          },
        ];
        item.reviewerReplacementReceipts = [
          ...(item.reviewerReplacementReceipts ?? []),
          {
            operationFingerprint,
            fromRevision: previousRevision,
            toRevision: current.revision,
          },
        ];
        item.updatedAt = now;
      } else if (action.action === 'archive_workstream') {
        const dispatchRoot = action.dispatchRoot.trim();
        const authorizationRef = action.authorizationRef.trim();
        const archivedByOpenId = action.archivedByOpenId?.trim() ?? '';
        const reason = boundedArchiveReason(action.reason);
        if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(dispatchRoot)) throw new Error('invalid_dispatch_root');
        if (!Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 1) {
          throw new Error('project_revision_invalid');
        }
        if (!COMPLETION_GATE_AUTHORIZATION_RE.test(authorizationRef)
          || !COMPLETION_GATE_AUTHORIZED_ACTOR_RE.test(archivedByOpenId)) {
          throw new Error('project_workstream_archive_authorization_required');
        }
        if (!reason) throw new Error('project_workstream_archive_reason_required');
        const item = current.workstreams.find(candidate => candidate.dispatchRoot === dispatchRoot);
        if (!item) throw new Error('workstream_not_found');
        const exactRetry = item.status === 'cancelled'
          && item.archivedFromStatus === 'failed'
          && item.archiveAuthorizationRef === authorizationRef
          && item.archivedByOpenId === archivedByOpenId
          && item.archiveReason === reason
          && previousRevision > action.expectedRevision;
        if (exactRetry) {
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (action.expectedRevision !== previousRevision) throw new Error('project_revision_conflict');
        if (item.status !== 'failed') throw new Error('project_workstream_archive_state_invalid');
        item.status = 'cancelled';
        item.archivedFromStatus = 'failed';
        item.archivedAt = now;
        item.archiveReason = reason;
        item.archiveAuthorizationRef = authorizationRef;
        item.archivedByOpenId = archivedByOpenId;
        item.updatedAt = now;
      } else if (action.action === 'mark_task_control_mapping') {
        const item = current.workstreams.find(candidate => candidate.dispatchRoot === action.dispatchRoot);
        if (!item?.taskControl) throw new Error('project_task_control_binding_not_found');
        if (item.taskControl.taskGuid !== action.taskGuid || item.taskControl.mappingRef !== action.mappingRef) {
          throw new Error('project_task_control_binding_conflict');
        }
        const registeredAt = action.status === 'registered'
          ? new Date(action.registeredAt ?? now).toISOString()
          : undefined;
        const failureCode = action.status === 'rejected'
          ? boundedText(action.failureCode, 160)
          : undefined;
        if (action.status === 'rejected' && !failureCode) throw new Error('project_task_control_failure_code_required');
        if (item.taskControl.mappingStatus === action.status
          && item.taskControl.registeredAt === registeredAt
          && item.taskControl.failureCode === failureCode) {
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (item.taskControl.mappingStatus !== 'pending') throw new Error('project_task_control_mapping_transition_invalid');
        item.taskControl.mappingStatus = action.status;
        if (registeredAt) item.taskControl.registeredAt = registeredAt;
        else delete item.taskControl.registeredAt;
        if (failureCode) item.taskControl.failureCode = failureCode;
        else delete item.taskControl.failureCode;
        item.updatedAt = now;
      } else if (action.action === 'fail_dispatch') {
        const item = current.workstreams.find(candidate => candidate.dispatchRoot === action.dispatchRoot);
        if (!item) throw new Error('workstream_not_found');
        if (item.status === 'failed' && item.blocker === boundedText(action.reason, 300)) {
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (item.status !== 'pending' || item.delivery || item.review) {
          throw new Error('project_dispatch_failure_transition_invalid');
        }
        item.status = 'failed';
        item.progress = 0;
        item.blocker = boundedText(action.reason, 300, 'dispatch delivery failed');
        delete item.delivery;
        delete item.review;
        item.updatedAt = now;
      } else if (action.action === 'update') {
        if (action.goal !== undefined) current.goal = boundedText(action.goal, 500, current.goal);
        if (action.phase !== undefined) current.phase = boundedText(action.phase, 80, current.phase);
        if (action.focus !== undefined) current.focus = boundedText(action.focus, 300, current.focus);
        const progress = validProgress(action.progress);
        if (action.progress !== undefined && progress === undefined) throw new Error('invalid_progress');
        if (progress === 100) this.refreshCompletionGatesForTerminal(current, registry, now);
        if (progress === 100 && projectCompletionGatesOpen(current, nowMs)) throw new Error('project_completion_gates_open');
        if (progress !== undefined) current.manualProgress = progress;
        if (action.remaining !== undefined) current.remaining = boundedText(action.remaining, 160) || undefined;
        if (action.clearBlockers) {
          current.blockerRecords = current.blockerRecords.filter(item => item.source !== 'manual');
          refreshProjectBlockerProjection(current);
        }
        const blocker = boundedText(action.blocker, 300);
        if (blocker && !current.blockers.includes(blocker)) {
          upsertProjectBlocker(current, {
            blockerId: projectBlockerId('manual', `project:${blocker}`),
            source: 'manual', summary: blocker, openedAt: now,
          });
        }
        const milestone = boundedText(action.milestone, 300);
        if (milestone) current.milestones.push({ content: milestone, createdAt: now });
        if (action.nextMilestone !== undefined) current.nextMilestone = boundedText(action.nextMilestone, 160) || undefined;
      } else if (action.action === 'add_completion_gate') {
        if (current.status !== 'active') throw new Error('project_not_active');
        const gate = newCompletionGate({ ...action, parentChatId: current.chatId, now });
        current.completionGates ??= [];
        const existing = current.completionGates.find(item => item.gateId === gate.gateId);
        if (existing) {
          if (existing.definitionFingerprint !== gate.definitionFingerprint || existing.label !== gate.label) {
            throw new Error('project_completion_gate_conflict');
          }
          if (existing.retirement) throw new Error('project_completion_gate_retired');
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (current.completionGates.length >= 32) throw new Error('project_completion_gate_limit');
        current.completionGates.push(gate);
        if (current.manualProgress === 100) current.manualProgress = 99;
      } else if (action.action === 'retire_completion_gate') {
        if (current.status !== 'active') throw new Error('project_not_active');
        const gateId = typeof action.gateId === 'string' ? action.gateId.trim() : '';
        const expectedDefinitionFingerprint = action.expectedDefinitionFingerprint.trim();
        const authorizationRef = typeof action.authorizationRef === 'string' ? action.authorizationRef.trim() : '';
        const authorizedByOpenId = typeof action.authorizedByOpenId === 'string' ? action.authorizedByOpenId.trim() : '';
        const reason = boundedText(action.reason, 160);
        if (!COMPLETION_GATE_ID_RE.test(gateId)) throw new Error('project_completion_gate_id_invalid');
        if (!expectedDefinitionFingerprint) throw new Error('project_completion_gate_fingerprint_required');
        if (!COMPLETION_GATE_AUTHORIZATION_RE.test(authorizationRef)) {
          throw new Error('project_completion_gate_authorization_required');
        }
        if (!COMPLETION_GATE_AUTHORIZED_ACTOR_RE.test(authorizedByOpenId)) {
          throw new Error('project_completion_gate_authorization_required');
        }
        if (!reason) throw new Error('project_completion_gate_retire_reason_required');
        const gate = current.completionGates?.find(item => item.gateId === gateId);
        if (!gate) throw new Error('project_completion_gate_not_found');
        if (gate.definitionFingerprint !== expectedDefinitionFingerprint) {
          throw new Error('project_completion_gate_definition_changed');
        }
        if (gate.retirement) {
          if (gate.retirement.authorizationRef !== authorizationRef
            || gate.retirement.authorizedByOpenId !== authorizedByOpenId || gate.retirement.reason !== reason
            || gate.retirement.replacementGateId !== undefined) {
            throw new Error('project_completion_gate_retired');
          }
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        gate.retirement = {
          retiredAt: now,
          retiredBySessionId: context.coordinatorSessionId,
          authorizationRef,
          authorizedByOpenId,
          reason,
        };
        gate.updatedAt = now;
      } else if (action.action === 'replace_completion_gate') {
        if (current.status !== 'active') throw new Error('project_not_active');
        const gateId = action.gateId.trim();
        const expectedDefinitionFingerprint = action.expectedDefinitionFingerprint.trim();
        const newGateId = typeof action.newGateId === 'string' ? action.newGateId.trim() : '';
        const authorizationRef = typeof action.authorizationRef === 'string' ? action.authorizationRef.trim() : '';
        const authorizedByOpenId = typeof action.authorizedByOpenId === 'string' ? action.authorizedByOpenId.trim() : '';
        const reason = boundedText(action.reason, 160);
        if (!COMPLETION_GATE_ID_RE.test(gateId) || !COMPLETION_GATE_ID_RE.test(newGateId) || newGateId === gateId) {
          throw new Error('project_completion_gate_id_invalid');
        }
        if (!expectedDefinitionFingerprint) throw new Error('project_completion_gate_fingerprint_required');
        if (!COMPLETION_GATE_AUTHORIZATION_RE.test(authorizationRef)) {
          throw new Error('project_completion_gate_authorization_required');
        }
        if (!COMPLETION_GATE_AUTHORIZED_ACTOR_RE.test(authorizedByOpenId)) {
          throw new Error('project_completion_gate_authorization_required');
        }
        if (!reason) throw new Error('project_completion_gate_replace_reason_required');
        const replacementGate = newCompletionGate({
          gateId: newGateId,
          sourceChatId: action.sourceChatId,
          dispatchRoot: action.dispatchRoot,
          taskGuid: action.taskGuid,
          label: action.label,
          parentChatId: current.chatId,
          now,
          replacesGateId: gateId,
        });
        current.completionGates ??= [];
        const gate = current.completionGates.find(item => item.gateId === gateId);
        if (!gate) throw new Error('project_completion_gate_not_found');
        if (gate.definitionFingerprint !== expectedDefinitionFingerprint) {
          throw new Error('project_completion_gate_definition_changed');
        }
        const replacement = current.completionGates.find(item => item.gateId === newGateId);
        if (gate.retirement) {
          const exactRetry = gate.retirement.replacementGateId === newGateId
            && gate.retirement.authorizationRef === authorizationRef
            && gate.retirement.authorizedByOpenId === authorizedByOpenId
            && gate.retirement.reason === reason
            && replacement?.definitionFingerprint === replacementGate.definitionFingerprint
            && replacement.label === replacementGate.label
            && replacement.replacesGateId === gateId;
          if (!exactRetry) {
            throw new Error(gate.retirement.replacementGateId
              ? 'project_completion_gate_replacement_conflict'
              : 'project_completion_gate_retired');
          }
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (replacement) throw new Error('project_completion_gate_replacement_conflict');
        if (current.completionGates.length >= 32) throw new Error('project_completion_gate_limit');
        gate.retirement = {
          retiredAt: now,
          retiredBySessionId: context.coordinatorSessionId,
          authorizationRef,
          authorizedByOpenId,
          reason,
          replacementGateId: newGateId,
        };
        gate.updatedAt = now;
        current.completionGates.push(replacementGate);
        if (current.manualProgress === 100) current.manualProgress = 99;
      } else if (action.action === 'sync_completion_gate') {
        if (current.status !== 'active') {
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        const gate = current.completionGates?.find(item => item.gateId === action.gateId);
        if (!gate) throw new Error('project_completion_gate_not_found');
        if (gate.retirement) {
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (!this.applyCompletionGateEvaluation(gate, action)) {
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        if (gate.status !== 'satisfied' && current.manualProgress === 100) current.manualProgress = 99;
      } else if (action.action === 'retire_task_control_canary_abandoned') {
        if (current.status !== 'active') throw new Error('project_not_active');
        const expected = action.expectedRecordFingerprint.trim();
        const authorizationRef = action.authorizationRef.trim();
        const actor = action.authorizedByOpenId?.trim() ?? '';
        const reason = boundedArchiveReason(action.reason);
        if (!/^pcbr1:[a-f0-9]{64}$/.test(expected)) {
          throw new Error('project_task_control_canary_abandoned_retirement_fingerprint_invalid');
        }
        if (!COMPLETION_GATE_AUTHORIZATION_RE.test(authorizationRef)
          || !COMPLETION_GATE_AUTHORIZED_ACTOR_RE.test(actor)) {
          throw new Error('project_task_control_canary_abandoned_retirement_authorization_required');
        }
        if (!reason) throw new Error('project_task_control_canary_abandoned_retirement_reason_required');

        const history = current.blockerRetirements ?? [];
        const replay = history.find(item => item.recordFingerprint === expected);
        if (replay) {
          if (replay.authorizationRef !== authorizationRef
            || replay.authorizedByOpenId !== actor || replay.reason !== reason) {
            throw new Error('project_task_control_canary_abandoned_retirement_conflict');
          }
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          if (replayDetection) replayDetection.wasReplay = true;
          return current;
        }

        const abandoned = current.blockerRecords.filter(
          item => item.code === TASK_CONTROL_CANARY_ABANDONED_CODE,
        );
        const target = abandoned.find(item => projectBlockerRecordFingerprint(item) === expected);
        if (!target) {
          throw new Error(abandoned.length > 0
            ? 'project_task_control_canary_abandoned_retirement_target_changed'
            : 'project_task_control_canary_abandoned_retirement_not_found');
        }
        projectTaskControlCanaryAbandonmentFromRecord(target);
        current.blockerRetirements = [...history, {
          schemaVersion: 'ProjectBlockerRetirement.v1',
          record: structuredClone(target),
          recordFingerprint: expected,
          authorizationRef,
          authorizedByOpenId: actor,
          reason,
          retiredAt: now,
          retiredBySessionId: context.coordinatorSessionId,
        }];
        current.blockerRecords = current.blockerRecords.filter(
          item => projectBlockerRecordFingerprint(item) !== expected,
        );
        refreshProjectBlockerProjection(current);
      } else if (action.action === 'close') {
        current.dispatchReservations = current.dispatchReservations.filter(item => Date.parse(item.expiresAt) > nowMs);
        if (current.dispatchReservations.length > 0) throw new Error('project_dispatch_reservations_active');
        if (current.workstreams.some(item => item.status === 'pending' || item.status === 'in_progress'
          || item.status === 'in_review' || item.status === 'blocked')) {
          throw new Error('project_workstreams_not_terminal');
        }
        this.refreshCompletionGatesForTerminal(current, registry, now);
        if (projectCompletionGatesOpen(current, nowMs)) throw new Error('project_completion_gates_open');
        if (current.blockerRecords.some(item => item.source !== 'manual')) {
          throw new Error('project_derived_blockers_open');
        }
        current.status = 'completed';
        current.manualProgress = 100;
        current.phase = '已完成';
        current.focus = '项目已完成';
        current.blockerRecords = [];
        refreshProjectBlockerProjection(current);
        current.remaining = '无';
        delete current.nextMilestone;
        const milestone = boundedText(action.milestone, 300, '项目完成');
        current.milestones.push({ content: milestone, createdAt: now });
      } else if (action.action === 'resume') {
        current.status = 'active';
        current.phase = boundedText(action.phase, 80, '继续推进');
        current.focus = boundedText(action.focus, 300, '恢复项目推进');
        if (current.manualProgress === 100) delete current.manualProgress;
      } else if (action.action === 'dispatch') {
        const root = action.dispatchRoot.trim();
        if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(root)) throw new Error('invalid_dispatch_root');
        const index = current.workstreams.findIndex(item => item.dispatchRoot === root);
        if (index >= 0) {
          const item = current.workstreams[index]!;
          if (item.access?.mode === 'write' && (action.status !== undefined || action.progress !== undefined)) {
            throw new Error('project_write_lifecycle_requires_report');
          }
          const requestedTitle = boundedText(action.title, 80);
          if (requestedTitle) {
            if (requestedTitle === '子任务' || requestedTitle === '子项目') throw new Error('project_workstream_title_required');
            if (Array.from(requestedTitle).length > 24) throw new Error('project_workstream_title_too_long');
            item.title = requestedTitle;
          }
          item.purpose = boundedText(action.purpose, 300, item.purpose);
          if (action.owners !== undefined) {
            item.owners = action.owners.map(owner => boundedText(owner, 80)).filter(Boolean).slice(0, 16);
          }
          if (action.status !== undefined || action.progress !== undefined) {
            const status = action.status ?? item.status;
            item.status = status;
            item.progress = statusProgress(status, action.progress, item.progress);
          }
          item.updatedAt = now;
        } else {
          if (readGroupCollaborationMode(context.dataDir, context.chatId)?.mode === 'project') {
            throw new Error('project_dispatch_reservation_required');
          }
          const status = action.status ?? 'pending';
          const title = boundedText(action.title, 80);
          if (!title || title === '子任务' || title === '子项目') throw new Error('project_workstream_title_required');
          if (Array.from(title).length > 24) throw new Error('project_workstream_title_too_long');
          current.workstreams.push({
            dispatchRoot: root,
            title,
            purpose: boundedText(action.purpose, 300, '等待补充任务说明'),
            owners: (action.owners ?? []).map(owner => boundedText(owner, 80)).filter(Boolean).slice(0, 16),
            status,
            progress: statusProgress(status, action.progress),
            createdAt: now, updatedAt: now,
          });
        }
      } else if (action.action === 'report') {
        const fenceRecord = current.blockerRecords.find(
          record => record.code === TASK_CONTROL_CANARY_QUARANTINE_CODE,
        );
        if (fenceRecord
          && action.dispatchRoot === validatedProjectTaskControlCanaryFence(fenceRecord).phaseA.historicalDispatchRoot) {
          throw new Error('project_task_control_phase_a_report_rejected');
        }
        const item = current.workstreams.find(candidate => candidate.dispatchRoot === action.dispatchRoot);
        if (!item) throw new Error('workstream_not_found');
        if (item.status === 'cancelled') throw new Error('project_workstream_cancelled');
        const beforeStage = structuredClone(item);
        if (item.access?.mode === 'write') {
          const reporterAppId = action.reporterAppId?.trim();
          if (!reporterAppId) throw new Error('project_reporter_identity_required');
          if (action.reviewVerdict) {
            if (!item.reviewerAppIds?.includes(reporterAppId) || item.workerAppIds?.includes(reporterAppId)) {
              throw new Error('project_reviewer_not_allowed');
            }
          } else if (!item.workerAppIds?.includes(reporterAppId)) {
            throw new Error('project_worker_not_allowed');
          }
          const content = boundedText(action.content, 1000);
          const resumesFailedReview = !action.reviewVerdict
            && item.status === 'blocked'
            && item.review?.verdict === 'fail'
            && action.status !== 'completed'
            && action.status !== 'failed';
          if (resumesFailedReview) {
            const previousLease = item.repositoryLeaseRef;
            const nextLease = action.repositoryLeaseRef;
            if (!previousLease || !nextLease
              || nextLease.repoKey !== previousLease.repoKey
              || nextLease.workingDir !== previousLease.workingDir
              || nextLease.leaseId === previousLease.leaseId
              || nextLease.fencingToken <= previousLease.fencingToken) {
              throw new Error('project_repository_lease_reacquire_required');
            }
            item.repositoryLeaseRef = structuredClone(nextLease);
          } else if (action.repositoryLeaseRef
            && !sameRepositoryLeaseRef(item.repositoryLeaseRef, action.repositoryLeaseRef)) {
            throw new Error('project_repository_lease_ref_conflict');
          }
          if (item.taskControl?.sourceKind === 'project_group'
            && (item.status === 'completed' || item.status === 'failed')) {
            const repeatedFailure = !action.reviewVerdict && action.status === 'failed'
              && item.status === 'failed'
              && item.lastReport === content
              && item.progress === statusProgress('failed', action.progress, item.progress)
              && item.remaining === (boundedText(action.remaining, 300) || undefined);
            const repeatedReview = action.reviewVerdict !== undefined
              && item.review?.reviewerAppId === reporterAppId
              && item.review.verdict === action.reviewVerdict
              && item.review.content === content
              && item.review.round === action.reviewRound;
            if (!repeatedFailure && !repeatedReview) throw new Error('project_task_control_terminal_workstream');
            current.coordinatorSessionId = previousCoordinatorSessionId;
            current.revision = previousRevision;
            current.updatedAt = previousUpdatedAt;
            return current;
          }
          if (action.reviewVerdict) {
            if (!item.delivery) throw new Error('project_delivery_required');
            if (action.reviewRound !== item.delivery.round) throw new Error('project_review_round_mismatch');
            if (item.review?.reviewerAppId === reporterAppId && item.review.verdict === action.reviewVerdict
              && item.review.content === content && item.review.round === action.reviewRound) {
              current.coordinatorSessionId = previousCoordinatorSessionId;
              current.revision = previousRevision;
              current.updatedAt = previousUpdatedAt;
              return current;
            }
            if (item.review) throw new Error('project_review_conflict');
            if (item.status !== 'in_review') throw new Error('project_delivery_not_in_review');
            item.review = {
              reviewerAppId: reporterAppId, verdict: action.reviewVerdict, content, reviewedAt: now,
              round: action.reviewRound,
            };
            item.status = action.reviewVerdict === 'pass' ? 'completed' : 'blocked';
            item.progress = action.reviewVerdict === 'pass' ? 100 : item.progress;
            if (action.reviewVerdict === 'fail') item.blocker = content;
            else delete item.blocker;
            item.updatedAt = now;
          } else {
            if (action.status !== 'completed') {
              const status = action.status ?? 'in_progress';
              const preserveTerminalAudit = status === 'failed' && item.taskControl?.sourceKind === 'project_group';
              item.status = status;
              item.progress = statusProgress(status, action.progress, item.progress);
              item.lastReport = content;
              item.remaining = boundedText(action.remaining, 300) || undefined;
              if (!preserveTerminalAudit) {
                delete item.delivery;
                delete item.review;
              }
              item.updatedAt = now;
              if (status === 'blocked' || preserveTerminalAudit) item.blocker = content;
              else delete item.blocker;
              current.milestones = current.milestones.slice(-50);
              appendProjectStageAdvanceEvent(current, beforeStage, item, now);
              return current;
            }
            if (item.status === 'in_review'
              && item.delivery?.reportedByAppId === reporterAppId
              && item.delivery.content === content) {
              current.coordinatorSessionId = previousCoordinatorSessionId;
              current.revision = previousRevision;
              current.updatedAt = previousUpdatedAt;
              return current;
            }
            if (item.status === 'completed'
              && item.delivery?.reportedByAppId === reporterAppId
              && item.delivery.content === content) {
              current.coordinatorSessionId = previousCoordinatorSessionId;
              current.revision = previousRevision;
              current.updatedAt = previousUpdatedAt;
              return current;
            }
            const round = (item.delivery?.round ?? 0) + 1;
            item.delivery = { reportedByAppId: reporterAppId, content, reportedAt: now, round };
            delete item.review;
            delete item.blocker;
            item.status = 'in_review';
            item.progress = 99;
            item.lastReport = content;
            item.updatedAt = now;
          }
          current.milestones = current.milestones.slice(-50);
          appendProjectStageAdvanceEvent(current, beforeStage, item, now);
          return current;
        }
        const status = action.status ?? 'in_progress';
        item.status = status;
        item.progress = statusProgress(status, action.progress, item.progress);
        item.lastReport = boundedText(action.content, 1000);
        item.remaining = boundedText(action.remaining, 300) || undefined;
        item.updatedAt = now;
        if (status === 'blocked' && item.lastReport) {
          const blocker = item.lastReport.slice(0, 300);
          const blockerId = projectBlockerId('manual', `workstream:${item.dispatchRoot}`);
          if (item.blocker && item.blocker !== blocker) {
            removeProjectBlocker(current, blockerId);
          }
          item.blocker = blocker;
          upsertProjectBlocker(current, {
            blockerId, source: 'manual', summary: blocker, openedAt: now,
          });
        } else if (item.blocker) {
          removeProjectBlocker(current, projectBlockerId('manual', `workstream:${item.dispatchRoot}`));
          delete item.blocker;
        }
        const milestone = boundedText(action.milestone, 300);
        if (milestone) current.milestones.push({ content: milestone, createdAt: now });
        appendProjectStageAdvanceEvent(current, beforeStage, item, now);
      }
      current.milestones = current.milestones.slice(-50);
      return current;
    });
    if (!next) throw new Error('project_not_found');
    return next;
  }

  private async publish(context: ProjectCoordinatorContext, initial: ProjectGroupState,
    resolveThreadIds = true, recordProjectionRevision = true,
    persistExistingCardRefresh = true,
  ): Promise<ProjectGroupState> {
    let project = initial;
    if (resolveThreadIds) {
      const resolutions = await Promise.all(project.workstreams
        .filter(item => !item.threadId)
        .map(async item => ({ dispatchRoot: item.dispatchRoot, threadId: await this.transport.resolveThreadId(project.larkAppId, item.dispatchRoot) })));
      const found = resolutions.filter((item): item is { dispatchRoot: string; threadId: string } => !!item.threadId);
      if (found.length > 0) {
        const byRoot = new Map(found.map(item => [item.dispatchRoot, item.threadId]));
        project = (await mutateProjectGroup(context.dataDir, context.chatId, current => {
          if (!current) throw new Error('project_not_found');
          for (const item of current.workstreams) item.threadId ??= byRoot.get(item.dispatchRoot);
          current.revision += 1;
          current.updatedAt = nowIso();
          return current;
        }))!;
      }
    }
    const mode = readGroupCollaborationMode(context.dataDir, context.chatId);
    const cardConfig = mode?.progressCard;
    const cardJson = JSON.stringify(buildProjectGroupCard(project, this.transport.brand(project.larkAppId), cardConfig));
    if (project.card?.messageId) {
      try {
        await this.transport.updateCard(project.larkAppId, project.card.messageId, cardJson);
        if (persistExistingCardRefresh) {
          project = (await mutateProjectGroup(context.dataDir, context.chatId, current => {
            if (!current) throw new Error('project_not_found');
            if (!current.card || current.card.messageId !== project.card?.messageId) return current;
            current.card.updatedAt = current.updatedAt;
            return current;
          }))!;
        }
        // If a previous first-publish attempt persisted and pinned the active
        // card but failed to retire the guide, retry that cleanup on refresh.
        await this.retireOnboardingCard(context);
        return project;
      } catch (error) {
        if (!this.transport.isMessageWithdrawn(error)) throw error;
      }
    }
    // Starting a project must be visible at the current point in the chat.
    // Never transform the older onboarding guide in place: publish and pin a
    // fresh formal card first, persist it, then retire the guide. If retirement
    // fails, its metadata remains so a later refresh can retry safely.
    const messageId = await this.transport.sendCard(project.larkAppId, project.chatId, cardJson);
    const pinned = await this.transport.pinMessage(project.larkAppId, messageId);
    project = (await mutateProjectGroup(context.dataDir, context.chatId, current => {
      if (!current) throw new Error('project_not_found');
      if (recordProjectionRevision) {
        current.revision += 1;
        current.updatedAt = nowIso();
      }
      // When recordProjectionRevision is false the card projection is an idempotent
      // refresh: persist the fresh card metadata against the existing durable state
      // without bumping the business revision or advancing the project updatedAt.
      current.card = { messageId, pinned, updatedAt: current.updatedAt };
      return current;
    }))!;
    await this.retireOnboardingCard(context);
    return project;
  }
}
