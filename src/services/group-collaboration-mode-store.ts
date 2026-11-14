import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';
import type { ProjectProgressCardConfig } from './project-progress-card-config.js';
import {
  canonicalProjectTaskControlCanaryFence,
  mutateProjectGroup,
  mutateProjectGroupSync,
  projectTaskControlCanaryFenceFingerprint,
  TASK_CONTROL_CANARY_QUARANTINE_CODE,
  withProjectTaskControlChatLock,
  withProjectTaskControlChatLockSync,
  type ProjectGroupState,
  type ProjectTaskControlCanaryFence,
} from './project-group-store.js';

export const GROUP_COLLABORATION_MODE_STORE_FILE = 'group-collaboration-modes.json';

export type GroupCollaborationMode = 'standard' | 'project';

export interface ProjectOnboardingCardState {
  messageId: string;
  larkAppId: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupCollaborationModeConfig {
  schemaVersion: 1;
  chatId: string;
  mode: GroupCollaborationMode;
  coordinatorAppId?: string;
  workerAppIds?: string[];
  /** Whether newly joined locally managed Bots should automatically become Workers. */
  autoEnrollWorkers?: boolean;
  taskControlPlane?: {
    mode: 'audit_only';
    acceptorAppId: string;
    maxActiveMappings: 1;
  };
  /** Opt-in metadata-only notification of imported sessions. Missing means
   * ignore; this preference is retained while project mode is disabled. */
  importedSessionPolicy?: 'ignore' | 'notify';
  progressCard?: ProjectProgressCardConfig;
  /** Internal projection state for the pinned "waiting to start" guide. */
  onboardingCard?: ProjectOnboardingCardState;
  createdAt: string;
  updatedAt: string;
}

export interface GroupTaskControlPlaneConfigCas {
  operation: 'enable' | 'disable';
  expectedConfigHash: string;
  expectedFenceFingerprint: string;
  now?: string;
}

interface GroupCollaborationModeRegistry {
  schemaVersion: 1;
  configs: Record<string, GroupCollaborationModeConfig>;
}

export type ProjectDispatchPolicyDecision =
  | {
      ok: true;
      projectMode: boolean;
      taskControlMode?: 'audit_only';
      acceptorAppId?: string;
      maxActiveMappings?: 1;
    }
  | {
      ok: false;
      error:
        | 'project_coordinator_required'
        | 'project_cross_chat_dispatch_forbidden'
        | 'project_dispatch_requires_app_ids'
        | 'project_dispatch_title_required'
        | 'project_dispatch_title_too_long'
        | 'project_dispatch_access_required'
        | 'project_dispatch_access_ambiguous'
        | 'project_existing_dispatch_access_forbidden'
        | 'project_workstream_bot_not_allowed'
        | 'project_worker_not_allowed'
        | 'project_task_control_not_configured'
        | 'project_task_control_write_required';
      disallowedAppIds?: string[];
    };

export type ProjectTaskControlEvidencePolicyDecision =
  | { ok: true; controllerAppId: string }
  | { ok: false; error: 'project_task_control_evidence_not_configured' | 'project_task_control_evidence_identity_mismatch' };

function registryPath(dataDir: string): string {
  return join(dataDir, GROUP_COLLABORATION_MODE_STORE_FILE);
}

function emptyRegistry(): GroupCollaborationModeRegistry {
  return { schemaVersion: 1, configs: {} };
}

function validTaskControlPlaneConfig(value: unknown): value is NonNullable<GroupCollaborationModeConfig['taskControlPlane']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 3
    && keys.every(key => ['mode', 'acceptorAppId', 'maxActiveMappings'].includes(key))
    && record.mode === 'audit_only'
    && typeof record.acceptorAppId === 'string' && record.acceptorAppId.trim().length > 0
    && record.maxActiveMappings === 1;
}

function validTaskControlPlaneGroupRelation(config: {
  mode?: unknown;
  coordinatorAppId?: unknown;
  workerAppIds?: unknown;
  taskControlPlane?: unknown;
}): boolean {
  if (!validTaskControlPlaneConfig(config.taskControlPlane)
    || config.mode !== 'project'
    || typeof config.coordinatorAppId !== 'string'
    || !Array.isArray(config.workerAppIds)
    || config.workerAppIds.some(value => typeof value !== 'string')) return false;
  const workers = config.workerAppIds as string[];
  return workers.includes(config.taskControlPlane.acceptorAppId)
    && config.taskControlPlane.acceptorAppId !== config.coordinatorAppId;
}

const GROUP_CONFIG_KEYS = new Set([
  'schemaVersion', 'chatId', 'mode', 'coordinatorAppId', 'workerAppIds', 'autoEnrollWorkers',
  'taskControlPlane', 'progressCard', 'onboardingCard', 'importedSessionPolicy', 'createdAt', 'updatedAt',
]);

function validTaskControlPlaneTopLevelConfig(config: Record<string, unknown>, expectedChatId?: string): boolean {
  return Object.keys(config).every(key => GROUP_CONFIG_KEYS.has(key))
    && config.schemaVersion === 1
    && typeof config.chatId === 'string'
    && (!expectedChatId || config.chatId === expectedChatId)
    && typeof config.createdAt === 'string' && Number.isFinite(Date.parse(config.createdAt))
    && typeof config.updatedAt === 'string' && Number.isFinite(Date.parse(config.updatedAt))
    && (config.importedSessionPolicy === undefined
      || config.importedSessionPolicy === 'ignore' || config.importedSessionPolicy === 'notify')
    && validTaskControlPlaneGroupRelation(config);
}

function readRegistry(path: string): GroupCollaborationModeRegistry {
  if (!existsSync(path)) return emptyRegistry();
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${GROUP_COLLABORATION_MODE_STORE_FILE} must contain an object`);
  }
  const raw = parsed as Partial<GroupCollaborationModeRegistry>;
  if (raw.schemaVersion !== 1 || !raw.configs || typeof raw.configs !== 'object' || Array.isArray(raw.configs)) {
    throw new Error(`${GROUP_COLLABORATION_MODE_STORE_FILE} has an unsupported schema`);
  }
  for (const [chatId, config] of Object.entries(raw.configs as Record<string, unknown>)) {
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      const taskControlPlane = (config as Record<string, unknown>).taskControlPlane;
      if (taskControlPlane !== undefined
        && !validTaskControlPlaneTopLevelConfig(config as Record<string, unknown>, chatId)) {
        throw new Error(`${GROUP_COLLABORATION_MODE_STORE_FILE} has invalid taskControlPlane config`);
      }
    }
  }
  return raw as GroupCollaborationModeRegistry;
}

function writeRegistry(path: string, registry: GroupCollaborationModeRegistry): void {
  atomicWriteFileSync(path, JSON.stringify(registry, null, 2), {
    mode: 0o600,
    followTargetSymlink: false,
  });
}

function hasTaskControlCanaryFence(project: ProjectGroupState | undefined): boolean {
  return project?.blockerRecords.some(record => record.code === TASK_CONTROL_CANARY_QUARANTINE_CODE) === true;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function groupCollaborationModeConfigFingerprint(config: GroupCollaborationModeConfig): string {
  return `pgc1:${createHash('sha256').update(canonicalJson(config)).digest('hex')}`;
}

function validatedTaskControlCanaryFence(
  project: ProjectGroupState | undefined,
  expectedFingerprint: string,
): ProjectTaskControlCanaryFence {
  const record = project?.blockerRecords.find(item => item.code === TASK_CONTROL_CANARY_QUARANTINE_CODE);
  if (!record) throw new Error('project_task_control_canary_fence_missing');
  try {
    const parsed = JSON.parse(record.summary) as ProjectTaskControlCanaryFence & { fingerprint?: unknown };
    const canonical = canonicalProjectTaskControlCanaryFence(parsed);
    const fingerprint = projectTaskControlCanaryFenceFingerprint(canonical);
    if (parsed.fingerprint !== fingerprint || expectedFingerprint !== fingerprint
      || record.eventId !== canonical.dispatchOperationId || record.taskGuid !== canonical.taskGuid) {
      throw new Error('project_task_control_canary_fence_conflict');
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message === 'project_task_control_canary_fence_conflict') throw error;
    throw new Error('project_task_control_canary_fence_conflict');
  }
}

function sameConfigSemantics(
  left: GroupCollaborationModeConfig | undefined,
  right: GroupCollaborationModeConfig | undefined,
): boolean {
  if (!left || !right) return left === right;
  const { updatedAt: _leftUpdatedAt, ...leftSemantic } = left;
  const { updatedAt: _rightUpdatedAt, ...rightSemantic } = right;
  return canonicalJson(leftSemantic) === canonicalJson(rightSemantic);
}

function withLockedGroupConfig<T>(
  dataDir: string,
  chatId: string,
  action: (
    registry: GroupCollaborationModeRegistry,
    current: GroupCollaborationModeConfig | undefined,
    project: ProjectGroupState | undefined,
  ) => T,
): T {
  return withProjectTaskControlChatLockSync(dataDir, chatId, () => {
    return withGroupCollaborationModeLockSync(dataDir, chatId, (registry, current) => {
      let result!: T;
      mutateProjectGroupSync(dataDir, chatId, project => {
        result = action(registry, current, project);
        return project;
      });
      return result;
    });
  });
}

export function withGroupCollaborationModeLockSync<T>(
  dataDir: string,
  chatId: string,
  action: (
    registry: GroupCollaborationModeRegistry,
    current: GroupCollaborationModeConfig | undefined,
  ) => T,
): T {
  const path = registryPath(dataDir);
  return withFileLockSync(path, () => {
    const registry = readRegistry(path);
    return action(registry, registry.configs[chatId]);
  });
}

export function readGroupCollaborationMode(
  dataDir: string,
  chatId: string,
): GroupCollaborationModeConfig | undefined {
  const config = readRegistry(registryPath(dataDir)).configs[chatId];
  return config ? structuredClone(config) : undefined;
}

export function listGroupCollaborationModes(dataDir: string): GroupCollaborationModeConfig[] {
  return Object.values(readRegistry(registryPath(dataDir)).configs).map(config => structuredClone(config));
}

/** Caller must hold the chat-scoped TaskControl outer lock. This keeps the
 * exact config CAS and the subsequent fence-to-tombstone mutation in one
 * cross-process exclusion window while preserving crash-safe re-entry from an
 * already-disabled config. */
export function disableTaskControlPlaneForAbandonmentSync(
  dataDir: string,
  input: {
    chatId: string;
    controllerAppId: string;
    acceptorAppId: string;
    expectedConfigHash: string;
  },
): GroupCollaborationModeConfig {
  return withGroupCollaborationModeLockSync(dataDir, input.chatId, (registry, current) => {
    if (!current || current.mode !== 'project' || current.coordinatorAppId !== input.controllerAppId) {
      throw new Error('project_task_control_config_cas_conflict');
    }
    const canary = {
      mode: 'audit_only' as const,
      acceptorAppId: input.acceptorAppId,
      maxActiveMappings: 1 as const,
    };
    if (current.taskControlPlane === undefined) {
      const reconstructedEnabled = { ...structuredClone(current), taskControlPlane: canary };
      if (groupCollaborationModeConfigFingerprint(reconstructedEnabled) !== input.expectedConfigHash) {
        throw new Error('project_task_control_config_cas_conflict');
      }
      return structuredClone(current);
    }
    if (groupCollaborationModeConfigFingerprint(current) !== input.expectedConfigHash
      || canonicalJson(current.taskControlPlane) !== canonicalJson(canary)) {
      throw new Error('project_task_control_config_cas_conflict');
    }
    const disabled = structuredClone(current);
    delete disabled.taskControlPlane;
    registry.configs[input.chatId] = disabled;
    writeRegistry(registryPath(dataDir), registry);
    if (registry.configs[input.chatId]?.taskControlPlane !== undefined) {
      throw new Error('project_task_control_canary_abandonment_requires_absence');
    }
    return structuredClone(disabled);
  });
}

export async function writeGroupCollaborationMode(
  dataDir: string,
  input: {
    chatId: string;
    mode: GroupCollaborationMode;
    coordinatorAppId?: string;
    workerAppIds?: string[];
    autoEnrollWorkers?: boolean;
    taskControlPlane?: GroupCollaborationModeConfig['taskControlPlane'] | null;
    taskControlPlaneCas?: GroupTaskControlPlaneConfigCas;
    importedSessionPolicy?: 'ignore' | 'notify';
    progressCard?: ProjectProgressCardConfig;
  },
  beforeWrite?: () => void,
): Promise<GroupCollaborationModeConfig> {
  if (input.importedSessionPolicy !== undefined
    && input.importedSessionPolicy !== 'ignore' && input.importedSessionPolicy !== 'notify') {
    throw new Error('invalid_imported_session_policy');
  }
  const path = registryPath(dataDir);
  const applyWrite = (
    registry: GroupCollaborationModeRegistry,
    current: GroupCollaborationModeConfig | undefined,
    project: ProjectGroupState | undefined,
  ): GroupCollaborationModeConfig => {
    // Runs under the task-control chat lock, mode file lock and project lock,
    // before this write mutates anything (public's pre-write validation hook).
    beforeWrite?.();
    const now = input.taskControlPlaneCas?.now === undefined
      ? new Date().toISOString()
      : new Date(input.taskControlPlaneCas.now).toISOString();
    const progressCard = input.progressCard ?? current?.progressCard;
    const taskControlPlane = input.taskControlPlane === null
      ? undefined
      : input.taskControlPlane ?? current?.taskControlPlane;
    const result: GroupCollaborationModeConfig = {
      schemaVersion: 1,
      chatId: input.chatId,
      mode: input.mode,
      importedSessionPolicy: input.importedSessionPolicy
        ?? (current?.importedSessionPolicy === 'notify' ? 'notify' : 'ignore'),
      ...(input.mode === 'project'
        ? {
            coordinatorAppId: input.coordinatorAppId,
            workerAppIds: [...new Set(input.workerAppIds ?? [])],
            autoEnrollWorkers: input.autoEnrollWorkers ?? current?.autoEnrollWorkers ?? false,
            ...(taskControlPlane
              ? { taskControlPlane: structuredClone(taskControlPlane) }
              : {}),
          }
        : {}),
      ...(progressCard ? { progressCard: structuredClone(progressCard) } : {}),
      ...(current?.onboardingCard ? { onboardingCard: structuredClone(current.onboardingCard) } : {}),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    if (input.taskControlPlaneCas?.operation === 'enable') {
      if (!current || groupCollaborationModeConfigFingerprint(current) !== input.taskControlPlaneCas.expectedConfigHash) {
        throw new Error('project_task_control_config_cas_conflict');
      }
      const fence = validatedTaskControlCanaryFence(project, input.taskControlPlaneCas.expectedFenceFingerprint);
      if (current.mode !== 'project' || current.taskControlPlane !== undefined
        || (project?.dispatchReservations ?? []).length !== 0) {
        throw new Error('project_task_control_config_enable_precondition_failed');
      }
      const taskControlPlane = input.taskControlPlane;
      if (!taskControlPlane || taskControlPlane.acceptorAppId !== fence.acceptorAppId
        || taskControlPlane.mode !== 'audit_only' || taskControlPlane.maxActiveMappings !== 1) {
        throw new Error('project_task_control_config_cas_conflict');
      }
      const exactPostimage: GroupCollaborationModeConfig = {
        ...structuredClone(current), taskControlPlane: structuredClone(taskControlPlane), updatedAt: now,
      };
      if (!sameConfigSemantics(result, exactPostimage)) {
        throw new Error('project_task_control_config_cas_field_scope');
      }
      registry.configs[input.chatId] = exactPostimage;
      writeRegistry(path, registry);
      return structuredClone(exactPostimage);
    }
    if (input.taskControlPlaneCas?.operation === 'disable') {
      if (!current || current.mode !== 'project' || input.taskControlPlane !== null) {
        throw new Error('project_task_control_config_disable_precondition_failed');
      }
      const fence = validatedTaskControlCanaryFence(project, input.taskControlPlaneCas.expectedFenceFingerprint);
      const canary = {
        mode: 'audit_only' as const, acceptorAppId: fence.acceptorAppId, maxActiveMappings: 1 as const,
      };
      if (current.taskControlPlane === undefined) {
        const reconstructedPostimage = { ...structuredClone(current), taskControlPlane: canary };
        if (groupCollaborationModeConfigFingerprint(reconstructedPostimage)
          !== input.taskControlPlaneCas.expectedConfigHash) {
          throw new Error('project_task_control_config_cas_conflict');
        }
        return structuredClone(current);
      }
      if (groupCollaborationModeConfigFingerprint(current) !== input.taskControlPlaneCas.expectedConfigHash
        || canonicalJson(current.taskControlPlane) !== canonicalJson(canary)) {
        throw new Error('project_task_control_config_cas_conflict');
      }
      const exactPostimage = structuredClone(current);
      delete exactPostimage.taskControlPlane;
      if (!sameConfigSemantics(result, exactPostimage)) {
        throw new Error('project_task_control_config_cas_field_scope');
      }
      registry.configs[input.chatId] = exactPostimage;
      writeRegistry(path, registry);
      return structuredClone(exactPostimage);
    }
    if (canonicalJson(current?.taskControlPlane) !== canonicalJson(result.taskControlPlane)) {
      throw new Error('project_task_control_config_cas_required');
    }
    if (sameConfigSemantics(current, result)) return structuredClone(current!);
    if (hasTaskControlCanaryFence(project)) {
      throw new Error('project_task_control_canary_fence_rejects_config_mutation');
    }
    registry.configs[input.chatId] = result;
    writeRegistry(path, registry);
    return structuredClone(result);
  };
  // Async locks here: a concurrent holder must not block the daemon event loop
  // for the lock's whole wait budget. The lock order stays chat → mode → project.
  return withProjectTaskControlChatLock(dataDir, input.chatId, () => withFileLock(path, async () => {
    let result!: GroupCollaborationModeConfig;
    await mutateProjectGroup(dataDir, input.chatId, project => {
      const registry = readRegistry(path);
      result = applyWrite(registry, registry.configs[input.chatId], project);
      return project;
    });
    return result;
  }));
}

/** Enroll a Bot that has just joined a project group configured for automatic enrollment.
 *
 * This is intentionally independent from the Bot's auto-start-on-join setting:
 * joining the project roster is control-plane state, while auto-start decides
 * whether the Bot should immediately create a conversation session. Groups with
 * an explicitly curated Worker subset remain unchanged.
 */
export async function addProjectWorkerIfNeeded(
  dataDir: string,
  chatId: string,
  larkAppId: string,
  options?: { onFencedNoop?: () => void },
): Promise<GroupCollaborationModeConfig | undefined> {
  const workerAppId = larkAppId.trim();
  if (!workerAppId) return undefined;

  let fencedNoop = false;
  const result = withLockedGroupConfig(dataDir, chatId, (registry, current, project) => {
    if (
      !current
      || current.mode !== 'project'
      || current.autoEnrollWorkers !== true
      || current.coordinatorAppId === workerAppId
      || (current.workerAppIds ?? []).includes(workerAppId)
    ) {
      return undefined;
    }
    if (hasTaskControlCanaryFence(project)) {
      fencedNoop = true;
      return undefined;
    }

    const next = {
      ...current,
      workerAppIds: [...(current.workerAppIds ?? []), workerAppId],
      updatedAt: new Date().toISOString(),
    };
    registry.configs[chatId] = next;
    writeRegistry(registryPath(dataDir), registry);
    return structuredClone(next);
  });
  if (fencedNoop) options?.onFencedNoop?.();
  return result;
}

/** Persist or clear the internal guide-card projection without rewriting the
 * user-owned collaboration policy. */
export async function writeProjectOnboardingCard(
  dataDir: string,
  chatId: string,
  card: ProjectOnboardingCardState | undefined,
): Promise<GroupCollaborationModeConfig> {
  return withLockedGroupConfig(dataDir, chatId, (registry, current, project) => {
    if (!current) throw new Error('group_collaboration_mode_not_found');
    if (card && (current.mode !== 'project' || current.coordinatorAppId !== card.larkAppId)) {
      throw new Error('project_onboarding_coordinator_mismatch');
    }
    const result = { ...current, updatedAt: new Date().toISOString() };
    if (card) result.onboardingCard = structuredClone(card);
    else delete result.onboardingCard;
    if (sameConfigSemantics(current, result)) return structuredClone(current);
    if (hasTaskControlCanaryFence(project)) {
      throw new Error('project_task_control_canary_fence_rejects_config_mutation');
    }
    registry.configs[chatId] = result;
    writeRegistry(registryPath(dataDir), registry);
    return structuredClone(result);
  });
}

export function evaluateProjectDispatchPolicy(input: {
  config: GroupCollaborationModeConfig | undefined;
  sourceAppId: string;
  sourceChatId: string;
  targetChatId: string;
  targetAppIds: string[];
  hasLegacyBots: boolean;
  title?: string;
  existingDispatch?: boolean;
  readOnly?: boolean;
  writeScopes?: string[];
  assignedAppIds?: string[];
  taskControlMode?: 'audit_only';
}): ProjectDispatchPolicyDecision {
  const config = input.config;
  if (!config || config.mode !== 'project') {
    return input.taskControlMode
      ? { ok: false, error: 'project_task_control_not_configured' }
      : { ok: true, projectMode: false };
  }
  if (config.taskControlPlane !== undefined
    && !validTaskControlPlaneTopLevelConfig(config as unknown as Record<string, unknown>)) {
    return { ok: false, error: 'project_task_control_not_configured' };
  }
  if (config.coordinatorAppId !== input.sourceAppId) {
    return { ok: false, error: 'project_coordinator_required' };
  }
  if (input.sourceChatId !== config.chatId || input.targetChatId !== config.chatId) {
    return { ok: false, error: 'project_cross_chat_dispatch_forbidden' };
  }
  if (input.hasLegacyBots) return { ok: false, error: 'project_dispatch_requires_app_ids' };
  const hasWriteScopes = (input.writeScopes?.length ?? 0) > 0;
  if (input.existingDispatch && (input.readOnly || hasWriteScopes)) {
    return { ok: false, error: 'project_existing_dispatch_access_forbidden' };
  }
  if (input.existingDispatch && input.assignedAppIds) {
    const assigned = new Set(input.assignedAppIds);
    const disallowedAppIds = [...new Set(input.targetAppIds.filter(appId => !assigned.has(appId)))];
    if (disallowedAppIds.length > 0) {
      return { ok: false, error: 'project_workstream_bot_not_allowed', disallowedAppIds };
    }
  }
  if (!input.existingDispatch) {
    if ((input.readOnly === true) === hasWriteScopes) {
      return {
        ok: false,
        error: input.readOnly ? 'project_dispatch_access_ambiguous' : 'project_dispatch_access_required',
      };
    }
    const title = input.title?.trim() ?? '';
    if (!title || title === '子任务' || title === '子项目') {
      return { ok: false, error: 'project_dispatch_title_required' };
    }
    if (Array.from(title).length > 24) {
      return { ok: false, error: 'project_dispatch_title_too_long' };
    }
  }
  const allowed = new Set(config.workerAppIds ?? []);
  const disallowedAppIds = [...new Set(input.targetAppIds.filter(appId => !allowed.has(appId)))];
  if (disallowedAppIds.length > 0) {
    return { ok: false, error: 'project_worker_not_allowed', disallowedAppIds };
  }
  if (input.taskControlMode === 'audit_only') {
    if (!config.taskControlPlane || config.taskControlPlane.mode !== 'audit_only') {
      return { ok: false, error: 'project_task_control_not_configured' };
    }
    if (input.readOnly || !hasWriteScopes) return { ok: false, error: 'project_task_control_write_required' };
    return {
      ok: true,
      projectMode: true,
      taskControlMode: 'audit_only',
      acceptorAppId: config.taskControlPlane.acceptorAppId,
      maxActiveMappings: config.taskControlPlane.maxActiveMappings,
    };
  }
  return { ok: true, projectMode: true };
}

export function evaluateProjectTaskControlEvidencePolicy(input: {
  config: GroupCollaborationModeConfig | undefined;
  chatId: string;
  sourceAppId: string;
  eventKind: 'accepted' | 'execution_started' | 'terminal' | 'submitted' | 'failed_report' | 'reviewed';
  taskControl: {
    mode?: unknown;
    controllerAppId?: unknown;
    workerAppId?: unknown;
    reviewerAppId?: unknown;
    acceptorAppId?: unknown;
  };
}): ProjectTaskControlEvidencePolicyDecision {
  const config = input.config;
  if (!config || config.mode !== 'project' || config.chatId !== input.chatId
    || !validTaskControlPlaneTopLevelConfig(config as unknown as Record<string, unknown>, input.chatId)) {
    return { ok: false, error: 'project_task_control_evidence_not_configured' };
  }
  const taskControl = input.taskControl;
  const controllerAppId = typeof taskControl.controllerAppId === 'string' ? taskControl.controllerAppId : '';
  const workerAppId = typeof taskControl.workerAppId === 'string' ? taskControl.workerAppId : '';
  const reviewerAppId = typeof taskControl.reviewerAppId === 'string' ? taskControl.reviewerAppId : '';
  const acceptorAppId = typeof taskControl.acceptorAppId === 'string' ? taskControl.acceptorAppId : '';
  const expectedSourceAppIds = input.eventKind === 'reviewed'
    ? [reviewerAppId]
    : input.eventKind === 'terminal'
      ? [workerAppId, reviewerAppId]
      : [workerAppId];
  const allowed = new Set(config.workerAppIds ?? []);
  if (taskControl.mode !== 'audit_only'
    || !controllerAppId || controllerAppId !== config.coordinatorAppId
    || !workerAppId || !reviewerAppId || !acceptorAppId
    || acceptorAppId !== config.taskControlPlane!.acceptorAppId
    || new Set([controllerAppId, workerAppId, reviewerAppId, acceptorAppId]).size !== 4
    || !allowed.has(workerAppId) || !allowed.has(reviewerAppId) || !allowed.has(acceptorAppId)
    || !expectedSourceAppIds.includes(input.sourceAppId)) {
    return { ok: false, error: 'project_task_control_evidence_identity_mismatch' };
  }
  return { ok: true, controllerAppId };
}
