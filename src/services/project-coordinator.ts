import {
  buildProjectGroupCard,
  buildProjectGroupOnboardingCard,
  type ProjectGroupOnboardingCardInput,
} from '../im/lark/project-group-card.js';
import type { Brand } from '../im/lark/lark-hosts.js';
import {
  normalizeDispatchWriteScopes,
  projectDispatchAccessConflicts,
  type ProjectDispatchAccess,
} from '../core/dispatch-write-scope.js';
import {
  mutateProjectGroup,
  readProjectGroup,
  type ProjectGroupState,
  type ProjectGroupStatus,
  type ProjectWorkstreamStatus,
} from './project-group-store.js';
import {
  readGroupCollaborationMode,
  writeProjectOnboardingCard,
  type ProjectOnboardingCardState,
} from './group-collaboration-mode-store.js';

export interface ProjectCoordinatorTransport {
  sendCard(larkAppId: string, chatId: string, cardJson: string): Promise<string>;
  updateCard(larkAppId: string, messageId: string, cardJson: string): Promise<void>;
  pinMessage(larkAppId: string, messageId: string): Promise<boolean>;
  unpinMessage(larkAppId: string, messageId: string): Promise<boolean>;
  resolveThreadId(larkAppId: string, dispatchRoot: string): Promise<string | null>;
  isMessageWithdrawn(error: unknown): boolean;
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
      action: 'reserve_dispatch'; reservationId: string; targetAppIds: string[];
      access: ProjectDispatchAccess; now?: string; ttlMs?: number;
    }
  | {
      action: 'commit_dispatch'; reservationId: string; targetAppIds: string[]; dispatchRoot: string;
      title: string; purpose?: string; owners?: string[]; workerAppIds?: string[]; reviewerAppIds?: string[];
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
    return {
      action, dispatchRoot, content, status, progress,
      remaining: stringField(body, 'remaining'), milestone: stringField(body, 'milestone'),
      reporterAppId: stringField(body, 'reporterAppId'),
      reviewVerdict: body.reviewVerdict === 'pass' || body.reviewVerdict === 'fail' ? body.reviewVerdict : undefined,
      reviewRound: Number.isSafeInteger(body.reviewRound) && (body.reviewRound as number) > 0
        ? body.reviewRound as number : undefined,
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

export const PROJECT_DISPATCH_RESERVATION_TTL_MS = 2 * 60_000;

function targetIdentity(targetAppIds: readonly string[]): string[] {
  const normalized = [...new Set(targetAppIds.map(id => id.trim()).filter(Boolean))].sort();
  if (normalized.length === 0) throw new Error('project_dispatch_targets_required');
  return normalized;
}

function sameTargets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameAccess(left: ProjectDispatchAccess, right: ProjectDispatchAccess): boolean {
  if (left.mode !== right.mode) return false;
  return left.mode === 'read_only'
    || (right.mode === 'write'
      && left.scopes.length === right.scopes.length
      && left.scopes.every((scope, index) => scope === right.scopes[index]));
}

function holdsWriteClaim(status: ProjectWorkstreamStatus): boolean {
  return status !== 'completed' && status !== 'failed';
}

function boundedText(value: string | undefined, max: number, fallback = ''): string {
  const text = value?.trim() ?? '';
  return (text || fallback).slice(0, max);
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
  constructor(private readonly transport: ProjectCoordinatorTransport) {}

  private async retireOnboardingCard(
    context: Pick<ProjectCoordinatorContext, 'dataDir' | 'chatId' | 'larkAppId'>,
  ): Promise<void> {
    const current = readGroupCollaborationMode(context.dataDir, context.chatId)?.onboardingCard;
    if (!current) return;
    if (current.larkAppId !== context.larkAppId) throw new Error('project_onboarding_coordinator_mismatch');
    if (current.pinned) {
      try {
        const unpinned = await this.transport.unpinMessage(context.larkAppId, current.messageId);
        if (!unpinned) return;
      } catch (error) {
        if (!this.transport.isMessageWithdrawn(error)) throw error;
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

  run(context: ProjectCoordinatorContext, action: ProjectCoordinatorAction): Promise<ProjectGroupState> {
    if (action.action === 'reserve_dispatch'
      || action.action === 'commit_dispatch'
      || action.action === 'abort_dispatch') {
      return this.apply(context, action);
    }
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      if (action.action === 'status') {
        const current = readProjectGroup(context.dataDir, context.chatId);
        if (!current) throw new Error('project_not_found');
        return current;
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

  runReport(
    context: ProjectCoordinatorContext,
    action: Extract<ProjectCoordinatorAction, { action: 'report' }>,
  ): Promise<{ project: ProjectGroupState; write: boolean; projectionWarning?: string }> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      const applied = await this.apply(context, action);
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
    });
  }

  private async apply(
    context: ProjectCoordinatorContext,
    action: Exclude<ProjectCoordinatorAction, { action: 'status' | 'refresh' }>,
  ): Promise<ProjectGroupState> {
    const reservedAccess = action.action === 'reserve_dispatch' && action.access.mode === 'write'
      ? { mode: 'write' as const, scopes: normalizeDispatchWriteScopes(action.access.scopes) }
      : action.action === 'reserve_dispatch' ? action.access : undefined;
    const next = await mutateProjectGroup(context.dataDir, context.chatId, current => {
      const now = (action.action === 'reserve_dispatch' || action.action === 'close') && action.now !== undefined
        ? new Date(action.now).toISOString()
        : nowIso();
      if (action.action === 'init') {
        if (current) throw new Error('project_already_exists');
        const title = boundedText(action.title, 80);
        const goal = boundedText(action.goal, 500);
        if (!title || !goal) throw new Error('title_and_goal_required');
        return {
          schemaVersion: 2, revision: 1,
          chatId: context.chatId, larkAppId: context.larkAppId,
          coordinatorSessionId: context.coordinatorSessionId,
          title, goal,
          phase: boundedText(action.phase, 80, '规划'),
          focus: boundedText(action.focus, 300, '拆解并派发首批子任务'),
          status: 'active' as ProjectGroupStatus,
          ...(boundedText(action.remaining, 160) ? { remaining: boundedText(action.remaining, 160) } : {}),
          blockers: [], workstreams: [], dispatchReservations: [], milestones: [], createdAt: now, updatedAt: now,
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
      current.coordinatorSessionId = context.coordinatorSessionId;
      current.revision += 1;
      current.updatedAt = now;
      const hadReservations = current.dispatchReservations !== undefined;
      current.dispatchReservations ??= [];
      const nowMs = Date.parse(now);
      if (action.action === 'reserve_dispatch') {
        if (current.status !== 'active') throw new Error('project_not_active');
        current.dispatchReservations = current.dispatchReservations.filter(item => Date.parse(item.expiresAt) > nowMs);
        const reservationId = action.reservationId.trim();
        if (!reservationId) throw new Error('project_dispatch_reservation_id_required');
        const targetAppIds = targetIdentity(action.targetAppIds);
        const existing = current.dispatchReservations.find(item => item.reservationId === reservationId);
        if (existing) {
          if (!sameTargets(existing.targetAppIds, targetAppIds) || !sameAccess(existing.access, reservedAccess!)) {
            throw new Error('project_dispatch_reservation_conflict');
          }
          current.coordinatorSessionId = previousCoordinatorSessionId;
          current.revision = previousRevision;
          current.updatedAt = previousUpdatedAt;
          return current;
        }
        const conflicts = current.workstreams.some(item => (
          item.access && holdsWriteClaim(item.status) && projectDispatchAccessConflicts(item.access, reservedAccess!)
        )) || current.dispatchReservations.some(item => projectDispatchAccessConflicts(item.access, reservedAccess!));
        if (conflicts) throw new Error('project_write_scope_conflict');
        const ttlMs = action.ttlMs ?? PROJECT_DISPATCH_RESERVATION_TTL_MS;
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
          throw new Error('project_dispatch_reservation_ttl_invalid');
        }
        current.dispatchReservations.push({
          reservationId, targetAppIds, access: structuredClone(reservedAccess!), createdAt: now,
          expiresAt: new Date(nowMs + ttlMs).toISOString(),
        });
      } else if (action.action === 'abort_dispatch') {
        const reservationId = action.reservationId.trim();
        if (!reservationId) throw new Error('project_dispatch_reservation_id_required');
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
        const targetAppIds = targetIdentity(action.targetAppIds);
        const reservationIndex = current.dispatchReservations.findIndex(item => item.reservationId === reservationId);
        if (reservationIndex < 0) throw new Error('project_dispatch_reservation_not_found');
        const reservation = current.dispatchReservations[reservationIndex]!;
        if (!sameTargets(reservation.targetAppIds, targetAppIds)) {
          throw new Error('project_dispatch_reservation_identity_mismatch');
        }
        current.dispatchReservations.splice(reservationIndex, 1);
        const root = action.dispatchRoot.trim();
        if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(root)) throw new Error('invalid_dispatch_root');
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
        const title = boundedText(action.title, 80);
        if (!title || title === '子任务' || title === '子项目') throw new Error('project_workstream_title_required');
        if (Array.from(title).length > 24) throw new Error('project_workstream_title_too_long');
        current.workstreams.push({
          dispatchRoot: root, title, purpose: boundedText(action.purpose, 300, '等待补充任务说明'),
          owners: (action.owners ?? []).map(owner => boundedText(owner, 80)).filter(Boolean).slice(0, 16),
          targetAppIds, access: reservation.access, status: 'pending', progress: 0,
          ...(workerAppIds.length > 0 ? { workerAppIds } : {}),
          ...(reviewerAppIds.length > 0 ? { reviewerAppIds } : {}),
          createdAt: now, updatedAt: now,
        });
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
        if (progress !== undefined) current.manualProgress = progress;
        if (action.remaining !== undefined) current.remaining = boundedText(action.remaining, 160) || undefined;
        if (action.clearBlockers) current.blockers = [];
        const blocker = boundedText(action.blocker, 300);
        if (blocker && !current.blockers.includes(blocker)) current.blockers.push(blocker);
        const milestone = boundedText(action.milestone, 300);
        if (milestone) current.milestones.push({ content: milestone, createdAt: now });
        if (action.nextMilestone !== undefined) current.nextMilestone = boundedText(action.nextMilestone, 160) || undefined;
      } else if (action.action === 'close') {
        current.dispatchReservations = current.dispatchReservations.filter(item => Date.parse(item.expiresAt) > nowMs);
        if (current.dispatchReservations.length > 0) throw new Error('project_dispatch_reservations_active');
        if (current.workstreams.some(item => item.status === 'pending' || item.status === 'in_progress'
          || item.status === 'in_review' || item.status === 'blocked')) {
          throw new Error('project_workstreams_not_terminal');
        }
        current.status = 'completed';
        current.manualProgress = 100;
        current.phase = '已完成';
        current.focus = '项目已完成';
        current.blockers = [];
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
        const item = current.workstreams.find(candidate => candidate.dispatchRoot === action.dispatchRoot);
        if (!item) throw new Error('workstream_not_found');
        if (item.access?.mode === 'write') {
          const reporterAppId = action.reporterAppId?.trim();
          if (!reporterAppId) throw new Error('project_reporter_identity_required');
          if (action.reviewVerdict) {
            if (!item.reviewerAppIds?.includes(reporterAppId) || item.workerAppIds?.includes(reporterAppId)) {
              throw new Error('project_reviewer_not_allowed');
            }
            if (!item.delivery) throw new Error('project_delivery_required');
            if (action.reviewRound !== item.delivery.round) throw new Error('project_review_round_mismatch');
            const content = boundedText(action.content, 1000);
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
            if (!item.workerAppIds?.includes(reporterAppId)) throw new Error('project_worker_not_allowed');
            const content = boundedText(action.content, 1000);
            if (action.status !== 'completed') {
              const status = action.status ?? 'in_progress';
              item.status = status;
              item.progress = statusProgress(status, action.progress, item.progress);
              item.lastReport = content;
              item.remaining = boundedText(action.remaining, 300) || undefined;
              delete item.delivery;
              delete item.review;
              item.updatedAt = now;
              if (status === 'blocked') item.blocker = content;
              else delete item.blocker;
              current.milestones = current.milestones.slice(-50);
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
          if (item.blocker && item.blocker !== blocker) {
            const previousBlocker = item.blocker;
            const sharedByAnotherWorkstream = current.workstreams.some(candidate => (
              candidate.dispatchRoot !== item.dispatchRoot
              && candidate.status === 'blocked'
              && candidate.blocker === previousBlocker
            ));
            if (!sharedByAnotherWorkstream) {
              current.blockers = current.blockers.filter(currentBlocker => currentBlocker !== previousBlocker);
            }
          }
          item.blocker = blocker;
          if (!current.blockers.includes(blocker)) current.blockers.push(blocker);
        } else if (item.blocker) {
          const previousBlocker = item.blocker;
          const sharedByAnotherWorkstream = current.workstreams.some(candidate => (
            candidate.dispatchRoot !== item.dispatchRoot
            && candidate.status === 'blocked'
            && candidate.blocker === previousBlocker
          ));
          if (!sharedByAnotherWorkstream) {
            current.blockers = current.blockers.filter(blocker => blocker !== previousBlocker);
          }
          delete item.blocker;
        }
        const milestone = boundedText(action.milestone, 300);
        if (milestone) current.milestones.push({ content: milestone, createdAt: now });
      }
      current.milestones = current.milestones.slice(-50);
      return current;
    });
    if (!next) throw new Error('project_not_found');
    return next;
  }

  private async publish(context: ProjectCoordinatorContext, initial: ProjectGroupState): Promise<ProjectGroupState> {
    let project = initial;
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
    const mode = readGroupCollaborationMode(context.dataDir, context.chatId);
    const cardConfig = mode?.progressCard;
    const cardJson = JSON.stringify(buildProjectGroupCard(project, this.transport.brand(project.larkAppId), cardConfig));
    if (project.card?.messageId) {
      try {
        await this.transport.updateCard(project.larkAppId, project.card.messageId, cardJson);
        project = (await mutateProjectGroup(context.dataDir, context.chatId, current => {
          if (!current) throw new Error('project_not_found');
          if (!current.card || current.card.messageId !== project.card?.messageId) return current;
          current.card.updatedAt = current.updatedAt;
          return current;
        }))!;
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
      current.revision += 1;
      current.updatedAt = nowIso();
      current.card = { messageId, pinned, updatedAt: current.updatedAt };
      return current;
    }))!;
    await this.retireOnboardingCard(context);
    return project;
  }
}
