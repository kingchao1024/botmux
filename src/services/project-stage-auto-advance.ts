import { createHash } from 'node:crypto';
import type { ProjectGroupState, ProjectWorkstream } from './project-group-store.js';
import type { TriggerRequest } from './trigger-types.js';

export type ProjectStageAdvanceKind =
  | 'delivery_ready'
  | 'review_passed'
  | 'review_failed'
  | 'workstream_failed'
  | 'workstream_completed';

export interface ProjectStageAdvanceIdentity {
  chatId: string;
  dispatchRoot: string;
  kind: ProjectStageAdvanceKind;
  deliveryRound?: number;
  reviewRound?: number;
}

export interface ProjectStageAdvanceEvent extends ProjectStageAdvanceIdentity {
  schemaVersion: 'ProjectStageAdvanceEvent.v1';
  fingerprint: `psa1:${string}`;
  projectRevision: number;
  status: 'pending' | 'dispatching' | 'dispatched' | 'blocked';
  createdAt: string;
  updatedAt: string;
  claimId?: string;
  claimExpiresAt?: string;
  targetSessionId?: string;
  triggerId?: string;
  attemptCount: number;
  lastErrorCode?: string;
}

export interface ClaimedProjectStageAdvance {
  event: ProjectStageAdvanceEvent;
  claimId: string;
}

export interface ProjectStageAdvanceTriggerRequest extends TriggerRequest {
  source: { type: 'ui'; connectorId: 'project-stage-auto-advance'; requestId: string };
  target: { kind: 'turn'; sessionId: string };
  presentation: { topicMessage: null };
  options: { asyncReturnSessionId: true; suppressFinalOutput: true; turnIdempotencyKey: string };
}

const kinds = new Set<ProjectStageAdvanceKind>([
  'delivery_ready', 'review_passed', 'review_failed', 'workstream_failed', 'workstream_completed',
]);

export function projectStageAdvanceFingerprint(identity: ProjectStageAdvanceIdentity): `psa1:${string}` {
  const canonical = {
    schemaVersion: 'ProjectStageAdvanceEvent.v1',
    chatId: identity.chatId,
    dispatchRoot: identity.dispatchRoot,
    kind: identity.kind,
    deliveryRound: identity.deliveryRound ?? null,
    reviewRound: identity.reviewRound ?? null,
  };
  return `psa1:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function deriveProjectStageAdvanceEvent(input: {
  project: ProjectGroupState;
  before: ProjectWorkstream;
  after: ProjectWorkstream;
  nextProjectRevision: number;
  now: string;
}): ProjectStageAdvanceEvent | undefined {
  const { project, before, after, nextProjectRevision, now } = input;
  let kind: ProjectStageAdvanceKind | undefined;
  if (after.access?.mode === 'write') {
    if (before.status !== 'in_review' && after.status === 'in_review' && after.delivery) kind = 'delivery_ready';
    else if (before.status === 'in_review' && after.status === 'completed' && after.review?.verdict === 'pass') kind = 'review_passed';
    else if (before.status === 'in_review' && after.status === 'blocked' && after.review?.verdict === 'fail') kind = 'review_failed';
    else if ((before.status === 'pending' || before.status === 'in_progress') && after.status === 'failed') kind = 'workstream_failed';
  } else if (before.status !== 'completed' && after.status === 'completed') {
    kind = 'workstream_completed';
  }
  if (!kind) return undefined;
  const identity: ProjectStageAdvanceIdentity = {
    chatId: project.chatId,
    dispatchRoot: after.dispatchRoot,
    kind,
    ...(round(after.delivery?.round) !== undefined ? { deliveryRound: after.delivery!.round } : {}),
    ...(round(after.review?.round) !== undefined ? { reviewRound: after.review!.round } : {}),
  };
  const fingerprint = projectStageAdvanceFingerprint(identity);
  return {
    ...identity,
    targetSessionId: project.coordinatorSessionId,
    schemaVersion: 'ProjectStageAdvanceEvent.v1',
    fingerprint,
    projectRevision: nextProjectRevision,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    attemptCount: 0,
  };
}

export function appendProjectStageAdvanceEvent(
  project: ProjectGroupState,
  before: ProjectWorkstream,
  after: ProjectWorkstream,
  now: string,
): ProjectStageAdvanceEvent | undefined {
  const event = deriveProjectStageAdvanceEvent({
    project, before, after, nextProjectRevision: project.revision, now,
  });
  if (!event) return undefined;
  project.stageAdvanceEvents ??= [];
  if (project.stageAdvanceEvents.some(item => item.fingerprint === event.fingerprint)) return undefined;
  project.stageAdvanceEvents.push(event);
  while (project.stageAdvanceEvents.length > 64) {
    const index = project.stageAdvanceEvents.findIndex(item => item.status === 'dispatched');
    if (index < 0) throw new Error('project_stage_advance_outbox_full');
    project.stageAdvanceEvents.splice(index, 1);
  }
  return event;
}

export function normalizeProjectStageAdvanceEvents(value: unknown): ProjectStageAdvanceEvent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error('project-groups.json has invalid stage advance events');
  const seen = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('project-groups.json has invalid stage advance event');
    const event = raw as ProjectStageAdvanceEvent;
    const identity: ProjectStageAdvanceIdentity = {
      chatId: typeof event.chatId === 'string' ? event.chatId.trim() : '',
      dispatchRoot: typeof event.dispatchRoot === 'string' ? event.dispatchRoot.trim() : '',
      kind: event.kind,
      ...(event.deliveryRound !== undefined ? { deliveryRound: event.deliveryRound } : {}),
      ...(event.reviewRound !== undefined ? { reviewRound: event.reviewRound } : {}),
    };
    const fingerprint = projectStageAdvanceFingerprint(identity);
    if (event.schemaVersion !== 'ProjectStageAdvanceEvent.v1'
      || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(identity.chatId)
      || !/^om_[A-Za-z0-9_-]{1,128}$/.test(identity.dispatchRoot)
      || !kinds.has(identity.kind)
      || (identity.deliveryRound !== undefined && round(identity.deliveryRound) === undefined)
      || (identity.reviewRound !== undefined && round(identity.reviewRound) === undefined)
      || event.fingerprint !== fingerprint
      || seen.has(fingerprint)
      || !Number.isSafeInteger(event.projectRevision) || event.projectRevision < 1
      || !['pending', 'dispatching', 'dispatched', 'blocked'].includes(event.status)
      || !Number.isFinite(Date.parse(event.createdAt)) || !Number.isFinite(Date.parse(event.updatedAt))
      || !Number.isSafeInteger(event.attemptCount) || event.attemptCount < 0 || event.attemptCount > 3
      || (event.status === 'pending' && (event.claimId !== undefined || event.claimExpiresAt !== undefined
        || event.triggerId !== undefined
        || (event.targetSessionId !== undefined && !event.targetSessionId.trim())))
      || (event.status === 'dispatching' && (event.attemptCount < 1 || !event.claimId?.trim()
        || !event.claimExpiresAt || !Number.isFinite(Date.parse(event.claimExpiresAt))
        || (event.targetSessionId !== undefined && !event.targetSessionId.trim()) || event.triggerId !== undefined))
      || (event.status === 'dispatched' && (event.attemptCount < 1 || !event.targetSessionId?.trim()
        || !event.triggerId?.trim() || event.claimId !== undefined || event.claimExpiresAt !== undefined))
      || (event.status === 'blocked' && (event.attemptCount < 1 || !event.lastErrorCode?.trim()
        || event.claimId !== undefined || event.claimExpiresAt !== undefined))) {
      throw new Error('project-groups.json has invalid stage advance event');
    }
    seen.add(fingerprint);
    return {
      ...event,
      chatId: identity.chatId,
      dispatchRoot: identity.dispatchRoot,
      ...(event.claimId ? { claimId: event.claimId.trim() } : {}),
      ...(event.targetSessionId ? { targetSessionId: event.targetSessionId.trim() } : {}),
      ...(event.triggerId ? { triggerId: event.triggerId.trim() } : {}),
      ...(event.lastErrorCode ? { lastErrorCode: event.lastErrorCode.trim() } : {}),
      createdAt: new Date(event.createdAt).toISOString(),
      updatedAt: new Date(event.updatedAt).toISOString(),
      ...(event.claimExpiresAt ? { claimExpiresAt: new Date(event.claimExpiresAt).toISOString() } : {}),
    };
  });
}

export function buildProjectStageAdvanceTriggerRequest(
  project: ProjectGroupState,
  event: ProjectStageAdvanceEvent,
): ProjectStageAdvanceTriggerRequest {
  const targetSessionId = event.targetSessionId?.trim() || project.coordinatorSessionId.trim();
  if (event.chatId !== project.chatId || !targetSessionId) throw new Error('project_stage_advance_target_invalid');
  const requestId = `project-stage-auto-advance:${event.fingerprint}`;
  const instruction = [
    `可信阶段自动推进事件 ${event.fingerprint}。`,
    `来源 workstream=${event.dispatchRoot}，stage=${event.kind}，deliveryRound=${event.deliveryRound ?? 'none'}，reviewRound=${event.reviewRound ?? 'none'}。`,
    '重新读取当前 project status、来源 dispatchRoot 最新消息和本群 human-action ledger；旧快照只作线索。',
    '已有授权明确覆盖时，在原 root、原 owner、原工作树继续；不得扩大范围或创建重复 owner。',
    '下一步需要新授权或真人动作时，不执行该动作；human-action fingerprint 必须由当前 psa1 event fingerprint 与稳定动作摘要派生。',
    '同一 human-action fingerprint 已在 human-action ledger 的 waiting_human、in_progress 或 closed 状态时，不得重复询问或重复投递。',
    '所有真实推进只收敛 durable project 的 phase、focus、remaining、blocker；只有确实需要新 human action 时，才使用 ledger CAS upsert、发到专项群顶层并回读确认 rootId 为空。',
    '没有用户可见信息时保持静默。',
    '禁止在 daemon 或本 turn 中直接执行 push、merge、部署、重启、删除、生产配置、权限扩大或真实设备操作；另禁止 commit、迁移和外部协调。自动 turn 不得把旧快照或旧授权解释为当前授权覆盖。',
  ].join('\n');
  return {
    source: { type: 'ui', connectorId: 'project-stage-auto-advance', requestId },
    target: { kind: 'turn', sessionId: targetSessionId },
    envelope: {
      format: 'botmux.project-stage-auto-advance.v1', sourceName: 'project stage auto advance', trusted: false,
      payload: { fingerprint: event.fingerprint, chatId: project.chatId, dispatchRoot: event.dispatchRoot, kind: event.kind },
    },
    instruction,
    presentation: { topicMessage: null },
    options: { asyncReturnSessionId: true, suppressFinalOutput: true, turnIdempotencyKey: event.fingerprint },
  };
}
