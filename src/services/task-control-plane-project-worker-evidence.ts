import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ProjectWorkstreamStatus } from './project-group-store.js';
import type { ReviewerVerdictV1 } from './task-control-plane-reviewer-verdict.js';

export const PROJECT_WORKER_EVIDENCE_TRUST_DOMAIN = 'botmux.task-control.project-worker-evidence.v1';
export const PROJECT_REVIEWER_EVIDENCE_TRUST_DOMAIN = 'botmux.task-control.project-reviewer-evidence.v1';
export const PROJECT_WORKER_EVIDENCE_ROUTE = '/api/task-control/project-worker-evidence';
export const PROJECT_WORKER_EVIDENCE_MAX_BYTES = 32 * 1024;
export const PROJECT_WORKER_EVIDENCE_MAX_PENDING = 1_024;
export const PROJECT_WORKER_EVIDENCE_QUARANTINE_LANE_CAP = 64;
export const PROJECT_WORKER_EVIDENCE_ROW_CAP = 4_096;

export type ProjectWorkerEvidenceKind = 'accepted' | 'execution_started' | 'terminal' | 'submitted' | 'failed_report' | 'reviewed' | 'project_sync_failed';

export interface ProjectWorkerEvidenceFactsV1 {
  schemaVersion: 'ProjectWorkerEvidence.v1';
  eventKind: ProjectWorkerEvidenceKind;
  sourceAppId: string;
  controllerAppId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  workerGeneration: number;
  dispatchAttempt: number;
  dispatchRoot: string;
  occurredAt: string;
  terminalStatus?: 'completed' | 'failed' | 'interrupted';
  finalOutputPresent?: boolean;
  reportRequestId?: string;
  triggerId?: string;
  targetSessionId?: string;
  contentHash?: string;
  projectRevision?: number;
  projectSyncError?: string;
  reviewVerdict?: 'pass' | 'fail';
  reviewRound?: number;
  reviewerVerdict?: ReviewerVerdictV1;
}
export interface ProjectWorkerEvidenceV1 extends ProjectWorkerEvidenceFactsV1 {
  evidenceId: string;
  keyId: string;
  signature: string;
}

export function projectWorkerEvidenceKindForReport(input: {
  projectSynced: boolean;
  projectStatus?: ProjectWorkstreamStatus;
  reviewVerdict?: 'pass' | 'fail';
}): ProjectWorkerEvidenceKind {
  if (input.reviewVerdict) return input.projectSynced ? 'reviewed' : 'project_sync_failed';
  if (input.projectStatus === 'failed') return 'failed_report';
  if (!input.projectSynced) return 'project_sync_failed';
  return 'submitted';
}

export function projectWorkerEvidenceAttemptedEventType(
  evidence: Pick<ProjectWorkerEvidenceFactsV1, 'eventKind' | 'reviewVerdict'>,
): 'task.accepted' | 'task.execution_started' | 'task.reviewed' | 'task.first_submitted' | 'task.failed' | 'unknown.required' {
  if (evidence.eventKind === 'accepted') return 'task.accepted';
  if (evidence.eventKind === 'execution_started') return 'task.execution_started';
  if (evidence.eventKind === 'reviewed'
    || (evidence.eventKind === 'project_sync_failed' && evidence.reviewVerdict !== undefined)) return 'task.reviewed';
  if (evidence.eventKind === 'failed_report') return 'task.failed';
  if (evidence.eventKind === 'submitted' || evidence.eventKind === 'project_sync_failed') return 'task.first_submitted';
  return 'unknown.required';
}

export function isProjectWorkerEvidenceLiveTurn(input: {
  liveTurnId?: string;
  liveDispatchAttempt?: number;
  liveWorkerGeneration?: number;
  persistedWorkerGeneration?: number;
  sourceTurnId: string;
  dispatchAttempt: number;
  workerGeneration: number;
}): boolean {
  const liveDispatchAttempt = input.liveDispatchAttempt ?? 1;
  return input.liveTurnId === input.sourceTurnId
    && Number.isSafeInteger(input.dispatchAttempt) && input.dispatchAttempt >= 1
    && liveDispatchAttempt === input.dispatchAttempt
    && Number.isSafeInteger(input.workerGeneration) && input.workerGeneration >= 1
    && input.liveWorkerGeneration === input.workerGeneration
    && input.persistedWorkerGeneration === input.workerGeneration;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(canonical(item))));
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, JSON.parse(canonical(item))])));
}

function validFacts(facts: ProjectWorkerEvidenceFactsV1): boolean {
  if (facts.schemaVersion !== 'ProjectWorkerEvidence.v1'
    || !/^cli_[A-Za-z0-9_-]{16,128}$/.test(facts.sourceAppId)
    || !/^cli_[A-Za-z0-9_-]{16,128}$/.test(facts.controllerAppId)
    || !facts.sourceSessionId.trim() || !facts.sourceTurnId.trim()
    || !Number.isSafeInteger(facts.workerGeneration) || facts.workerGeneration < 1
    || !Number.isSafeInteger(facts.dispatchAttempt) || facts.dispatchAttempt < 1
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(facts.dispatchRoot)
    || !Number.isFinite(Date.parse(facts.occurredAt))) return false;
  if (facts.eventKind === 'terminal') {
    return (facts.terminalStatus === 'completed' || facts.terminalStatus === 'failed' || facts.terminalStatus === 'interrupted')
      && typeof facts.finalOutputPresent === 'boolean'
      && facts.reportRequestId === undefined && facts.triggerId === undefined
      && facts.targetSessionId === undefined && facts.contentHash === undefined
      && facts.projectRevision === undefined && facts.projectSyncError === undefined
      && facts.reviewVerdict === undefined && facts.reviewRound === undefined;
  }
  if (facts.eventKind === 'accepted' || facts.eventKind === 'execution_started') {
    return facts.terminalStatus === undefined && facts.finalOutputPresent === undefined
      && facts.reportRequestId === undefined && facts.triggerId === undefined
      && facts.targetSessionId === undefined && facts.contentHash === undefined
      && facts.projectRevision === undefined && facts.projectSyncError === undefined
      && facts.reviewVerdict === undefined && facts.reviewRound === undefined;
  }
  const reportValid = !!facts.reportRequestId?.trim() && !!facts.triggerId?.trim()
    && !!facts.targetSessionId?.trim() && /^sha256:[a-f0-9]{64}$/i.test(facts.contentHash ?? '')
    && facts.terminalStatus === undefined && facts.finalOutputPresent === undefined;
  if (facts.eventKind === 'project_sync_failed') {
    const reviewFieldsValid = (facts.reviewVerdict === undefined && facts.reviewRound === undefined)
      || ((facts.reviewVerdict === 'pass' || facts.reviewVerdict === 'fail')
        && Number.isSafeInteger(facts.reviewRound) && facts.reviewRound! > 0);
    return reportValid && !!facts.projectSyncError?.trim() && facts.projectRevision === undefined && reviewFieldsValid;
  }
  const syncedReportValid = reportValid
    && Number.isSafeInteger(facts.projectRevision) && facts.projectRevision! > 0
    && facts.projectSyncError === undefined;
  if (facts.eventKind === 'submitted') {
    return syncedReportValid && facts.reviewVerdict === undefined && facts.reviewRound === undefined;
  }
  if (facts.eventKind === 'failed_report') {
    const projectResultValid = (Number.isSafeInteger(facts.projectRevision) && facts.projectRevision! > 0
        && facts.projectSyncError === undefined)
      || (facts.projectRevision === undefined && !!facts.projectSyncError?.trim());
    return reportValid && projectResultValid
      && facts.reviewVerdict === undefined && facts.reviewRound === undefined
      && facts.reviewerVerdict === undefined;
  }
  return facts.eventKind === 'reviewed' && syncedReportValid
    && (facts.reviewVerdict === 'pass' || facts.reviewVerdict === 'fail')
    && Number.isSafeInteger(facts.reviewRound) && facts.reviewRound! > 0
    && !!facts.reviewerVerdict && typeof facts.reviewerVerdict === 'object';
}

export function projectWorkerEvidenceFacts(evidence: ProjectWorkerEvidenceV1): ProjectWorkerEvidenceFactsV1 {
  return {
    schemaVersion: evidence.schemaVersion,
    eventKind: evidence.eventKind,
    sourceAppId: evidence.sourceAppId,
    controllerAppId: evidence.controllerAppId,
    sourceSessionId: evidence.sourceSessionId,
    sourceTurnId: evidence.sourceTurnId,
    workerGeneration: evidence.workerGeneration,
    dispatchAttempt: evidence.dispatchAttempt,
    dispatchRoot: evidence.dispatchRoot,
    occurredAt: evidence.occurredAt,
    ...(evidence.terminalStatus ? { terminalStatus: evidence.terminalStatus } : {}),
    ...(evidence.finalOutputPresent !== undefined ? { finalOutputPresent: evidence.finalOutputPresent } : {}),
    ...(evidence.reportRequestId ? { reportRequestId: evidence.reportRequestId } : {}),
    ...(evidence.triggerId ? { triggerId: evidence.triggerId } : {}),
    ...(evidence.targetSessionId ? { targetSessionId: evidence.targetSessionId } : {}),
    ...(evidence.contentHash ? { contentHash: evidence.contentHash } : {}),
    ...(evidence.projectRevision !== undefined ? { projectRevision: evidence.projectRevision } : {}),
    ...(evidence.projectSyncError ? { projectSyncError: evidence.projectSyncError } : {}),
    ...(evidence.reviewVerdict ? { reviewVerdict: evidence.reviewVerdict } : {}),
    ...(evidence.reviewRound !== undefined ? { reviewRound: evidence.reviewRound } : {}),
    ...(evidence.reviewerVerdict ? { reviewerVerdict: evidence.reviewerVerdict } : {}),
  };
}

function keyFor(hostSecret: string, sourceAppId: string, domain = PROJECT_WORKER_EVIDENCE_TRUST_DOMAIN): Buffer {
  return createHmac('sha256', hostSecret)
    .update(`${domain}\0${sourceAppId}`, 'utf8')
    .digest();
}

function keyId(key: Buffer, prefix: 'tcpe1' | 'tcper1' = 'tcpe1'): string {
  return `${prefix}:${createHash('sha256').update(key).digest('hex')}`;
}

function signature(key: Buffer, evidenceId: string, facts: ProjectWorkerEvidenceFactsV1): string {
  return createHmac('sha256', key).update(canonical({ evidenceId, facts })).digest('hex');
}

function equalSignature(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function projectWorkerEvidenceId(facts: ProjectWorkerEvidenceFactsV1): string {
  if (!validFacts(facts)) throw new Error('task_control_project_worker_evidence_invalid');
  return `tcpe_${createHash('sha256').update(canonical(facts)).digest('hex')}`;
}

/** Logical identity of a lifecycle attempt. An exact retry (same lane, same
 *  event, same attempt, same review round) must reuse the first evidenceId,
 *  occurredAt, and signature. Changed semantics under this key are a permanent
 *  conflict — retries never mint a fresh time or extend verdict authority. */
export function projectWorkerEvidenceLogicalKey(facts: ProjectWorkerEvidenceFactsV1): string {
  const artifactRef = facts.reportRequestId ?? facts.sourceTurnId;
  return [
    facts.sourceAppId,
    facts.controllerAppId,
    facts.dispatchRoot,
    artifactRef,
    facts.eventKind,
    String(facts.dispatchAttempt),
    facts.reviewRound !== undefined ? String(facts.reviewRound) : '',
  ].join('\0');
}

/** Hash of every semantic fact except `occurredAt`. Two evidences with the
 *  same logical key must agree on this hash; otherwise the retry semantically
 *  disagrees with the original row and is a permanent conflict. */
export function projectWorkerEvidenceSemanticHash(facts: ProjectWorkerEvidenceFactsV1): string {
  const { occurredAt: _occurredAt, ...semantic } = facts;
  return createHash('sha256').update(canonical(semantic)).digest('hex');
}

export class ProjectWorkerEvidenceTrust {
  private readonly key: Buffer;
  private readonly previousKey?: Buffer;
  private readonly reviewerKey: Buffer;
  private readonly previousReviewerKey?: Buffer;
  readonly keyId: string;
  readonly previousKeyId?: string;
  readonly reviewerKeyId: string;
  readonly previousReviewerKeyId?: string;

  constructor(private readonly input: { hostSecret: string; previousHostSecret?: string; sourceAppId: string }) {
    if (!input.hostSecret.trim() || !/^cli_[A-Za-z0-9_-]{16,128}$/.test(input.sourceAppId)) {
      throw new Error('task_control_project_worker_evidence_trust_root_invalid');
    }
    this.key = keyFor(input.hostSecret, input.sourceAppId);
    this.reviewerKey = keyFor(input.hostSecret, input.sourceAppId, PROJECT_REVIEWER_EVIDENCE_TRUST_DOMAIN);
    this.previousKey = input.previousHostSecret && input.previousHostSecret !== input.hostSecret
      ? keyFor(input.previousHostSecret, input.sourceAppId)
      : undefined;
    this.previousReviewerKey = input.previousHostSecret && input.previousHostSecret !== input.hostSecret
      ? keyFor(input.previousHostSecret, input.sourceAppId, PROJECT_REVIEWER_EVIDENCE_TRUST_DOMAIN)
      : undefined;
    this.keyId = keyId(this.key);
    this.previousKeyId = this.previousKey ? keyId(this.previousKey) : undefined;
    this.reviewerKeyId = keyId(this.reviewerKey, 'tcper1');
    this.previousReviewerKeyId = this.previousReviewerKey
      ? keyId(this.previousReviewerKey, 'tcper1')
      : undefined;
  }

  issue(facts: ProjectWorkerEvidenceFactsV1): ProjectWorkerEvidenceV1 {
    if (facts.sourceAppId !== this.input.sourceAppId || !validFacts(facts)) {
      throw new Error('task_control_project_worker_evidence_invalid');
    }
    const evidenceId = projectWorkerEvidenceId(facts);
    const reviewer = facts.eventKind === 'reviewed'
      || (facts.eventKind === 'project_sync_failed' && facts.reviewVerdict !== undefined);
    const key = reviewer ? this.reviewerKey : this.key;
    return {
      ...facts, evidenceId, keyId: reviewer ? this.reviewerKeyId : this.keyId,
      signature: signature(key, evidenceId, facts),
    };
  }

  verify(
    evidence: ProjectWorkerEvidenceV1,
    options: { allowedKeyIds?: readonly string[]; revokedKeyIds?: readonly string[] } = {},
  ): boolean {
    const allowed = new Set([
      'schemaVersion', 'eventKind', 'sourceAppId', 'controllerAppId', 'sourceSessionId', 'sourceTurnId',
      'workerGeneration', 'dispatchAttempt', 'dispatchRoot', 'occurredAt', 'terminalStatus',
      'finalOutputPresent', 'reportRequestId', 'triggerId', 'targetSessionId', 'contentHash',
      'projectRevision', 'reviewVerdict', 'reviewRound', 'evidenceId', 'keyId', 'signature',
      'projectSyncError', 'reviewerVerdict',
    ]);
    if (!evidence || typeof evidence !== 'object'
      || Object.keys(evidence).some(field => !allowed.has(field))
      || evidence.sourceAppId !== this.input.sourceAppId
      || options.revokedKeyIds?.includes(evidence.keyId)
      || (options.allowedKeyIds !== undefined && !options.allowedKeyIds.includes(evidence.keyId))) return false;
    const facts = projectWorkerEvidenceFacts(evidence);
    if (!validFacts(facts)) return false;
    let expectedId: string;
    try { expectedId = projectWorkerEvidenceId(facts); } catch { return false; }
    if (evidence.evidenceId !== expectedId) return false;
    const reviewer = evidence.eventKind === 'reviewed'
      || (evidence.eventKind === 'project_sync_failed' && evidence.reviewVerdict !== undefined);
    const key = reviewer
      ? evidence.keyId === this.reviewerKeyId ? this.reviewerKey
        : evidence.keyId === this.previousReviewerKeyId ? this.previousReviewerKey : undefined
      : evidence.keyId === this.keyId ? this.key
        : evidence.keyId === this.previousKeyId ? this.previousKey : undefined;
    return !!key && equalSignature(evidence.signature, signature(key, evidence.evidenceId, facts));
  }
}

export interface ProjectWorkerEvidenceRelayStore {
  enqueueProjectWorkerEvidence(
    evidence: ProjectWorkerEvidenceV1,
    verify: (value: ProjectWorkerEvidenceV1) => boolean,
    maxPending?: number,
    limits?: { quarantineCap: number; evidenceRowCap: number },
  ): { kind: 'appended' | 'duplicate' | 'overflow'; evidence: ProjectWorkerEvidenceV1 };
  claimProjectWorkerEvidence(input: {
    now: number;
    claimToken: string;
    staleClaimMs: number;
  }): { outboxId: string; evidenceId: string; attempts: number } | undefined;
  listProjectWorkerEvidence(): ProjectWorkerEvidenceV1[];
  listProjectWorkerEvidenceOutbox?(): Array<{
    evidenceId: string;
    status: 'pending' | 'inflight' | 'delivered';
    lastError?: string;
  }>;
  findProjectWorkerEvidenceByLogicalKey?(logicalKey: string, semanticHash: string): ProjectWorkerEvidenceV1 | undefined;
  settleProjectWorkerEvidenceDelivered(outboxId: string, claimToken: string, receiptRef: string, now: number): void;
  settleProjectWorkerEvidenceRetry(outboxId: string, claimToken: string, error: string, nextAttemptAt: number, now: number): void;
}

export class ProjectWorkerEvidenceRelay {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly activeFlushes = new Set<Promise<void>>();
  private closing = false;
  private readonly activeControllers = new Set<AbortController>();
  constructor(private readonly input: {
    store: ProjectWorkerEvidenceRelayStore;
    trust: ProjectWorkerEvidenceTrust;
    deliver(evidence: ProjectWorkerEvidenceV1, signal: AbortSignal): Promise<string>;
    now?: () => number;
    staleClaimMs?: number;
    maxPending?: number;
    /** Per-attempt provider deadline. Aborts the delivery signal and resets the
     *  claim for retry. Defaults to 5 seconds per the frozen design. */
    deliveryDeadlineMs?: number;
    /** Per-source quarantine backlog cap. Once reached, `capture` throws
     *  `task_control_project_evidence_quarantine_cap` and existing rows stay
     *  audit-visible. */
    quarantineCap?: number;
    /** Overall retained-evidence cap across all lanes for this source. Reaching
     *  this cap emits exactly one bounded overflow observation via `onOverallOverflow`
     *  and stops new evidence admission (`task_control_project_evidence_row_cap`).
     *  Existing rows are never dropped; audit continues. */
    evidenceRowCap?: number;
    onOverflow?(evidence: ProjectWorkerEvidenceV1): void;
    onOverallOverflow?(evidence: ProjectWorkerEvidenceV1): void;
    allowedKeyIds?: readonly string[];
    revokedKeyIds?: readonly string[];
  }) {
    if (input.maxPending !== undefined
      && (!Number.isSafeInteger(input.maxPending) || input.maxPending < 1)) {
      throw new Error('task_control_project_evidence_max_pending_invalid');
    }
    if (input.deliveryDeadlineMs !== undefined
      && (!Number.isSafeInteger(input.deliveryDeadlineMs) || input.deliveryDeadlineMs < 1)) {
      throw new Error('task_control_project_evidence_deadline_invalid');
    }
    if (input.quarantineCap !== undefined
      && (!Number.isSafeInteger(input.quarantineCap) || input.quarantineCap < 1)) {
      throw new Error('task_control_project_evidence_quarantine_cap_invalid');
    }
    if (input.evidenceRowCap !== undefined
      && (!Number.isSafeInteger(input.evidenceRowCap) || input.evidenceRowCap < 1)) {
      throw new Error('task_control_project_evidence_row_cap_invalid');
    }
  }

  capture(facts: ProjectWorkerEvidenceFactsV1): ProjectWorkerEvidenceV1 {
    // Logical get-or-create: an exact retry (same lane, same event, same attempt,
    // same review round) reuses the first evidenceId/occurredAt/signature. Any
    // change to the semantic payload under this key is a permanent conflict.
    const logicalKey = projectWorkerEvidenceLogicalKey(facts);
    const semanticHash = projectWorkerEvidenceSemanticHash(facts);
    const existing = this.input.store.findProjectWorkerEvidenceByLogicalKey?.(logicalKey, semanticHash);
    if (existing) return existing;
    const evidence = this.input.trust.issue(facts);
    let result: ReturnType<ProjectWorkerEvidenceRelayStore['enqueueProjectWorkerEvidence']>;
    try {
      result = this.input.store.enqueueProjectWorkerEvidence(evidence, value => this.input.trust.verify(value, {
        allowedKeyIds: this.input.allowedKeyIds,
        revokedKeyIds: this.input.revokedKeyIds,
      }), this.input.maxPending ?? PROJECT_WORKER_EVIDENCE_MAX_PENDING, {
        quarantineCap: this.input.quarantineCap ?? PROJECT_WORKER_EVIDENCE_QUARANTINE_LANE_CAP,
        evidenceRowCap: this.input.evidenceRowCap ?? PROJECT_WORKER_EVIDENCE_ROW_CAP,
      });
    } catch (error) {
      const overflowObservationCreated = (error as Error & {
        overflowObservationCreated?: boolean;
      }).overflowObservationCreated !== false;
      if (overflowObservationCreated
        && error instanceof Error
        && error.message === 'task_control_project_evidence_row_cap') {
        this.input.onOverallOverflow?.(evidence);
      } else if (overflowObservationCreated
        && error instanceof Error
        && error.message === 'task_control_project_evidence_quarantine_cap') {
        this.input.onOverflow?.(evidence);
      }
      throw error;
    }
    if (result.kind === 'overflow') {
      this.input.onOverflow?.(evidence);
      throw new Error('task_control_project_evidence_backlog_full');
    }
    return result.evidence;
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    const tick = (): void => {
      if (this.running) return;
      this.running = this.flushOnce().finally(() => { this.running = undefined; });
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  async close(remainingBudgetMs?: number): Promise<{ quiesced: number; pending: number; inflight: number }> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const deadlineError = new Error('task_control_project_evidence_close');
    for (const controller of this.activeControllers) controller.abort(deadlineError);
    // `undefined` is the explicit unbounded form used by local/test callers.
    // A supplied zero means the shared shutdown deadline is already exhausted,
    // so report the durable state immediately after issuing aborts.
    const budgetDeadline = remainingBudgetMs === undefined
      ? undefined
      : Date.now() + Math.max(0, remainingBudgetMs);
    while (this.activeFlushes.size > 0 && (budgetDeadline === undefined || Date.now() < budgetDeadline)) {
      await Promise.race([
        Promise.allSettled([...this.activeFlushes]).then(() => undefined),
        new Promise(resolve => setTimeout(resolve, budgetDeadline === undefined ? 5 : Math.max(1, budgetDeadline - Date.now()))),
      ]);
      if (this.activeFlushes.size === 0) break;
    }
    let quiesced = 0;
    let pending = 0;
    let inflight = 0;
    for (const row of this.input.store.listProjectWorkerEvidenceOutbox?.() ?? []) {
      if (row.lastError?.startsWith('permanent:')) continue;
      if (row.status === 'delivered') quiesced += 1;
      else if (row.status === 'inflight') inflight += 1;
      else pending += 1;
    }
    return { quiesced, pending, inflight };
  }

  async flushOnce(now = this.input.now?.() ?? Date.now()): Promise<void> {
    if (this.closing) return;
    const tracked = this.flushOnceInternal(now).finally(() => {
      this.activeFlushes.delete(tracked);
      if (this.running === tracked) this.running = undefined;
    });
    this.activeFlushes.add(tracked);
    this.running = tracked;
    return tracked;
  }

  private async flushOnceInternal(now: number): Promise<void> {
    const claimToken = randomUUID();
    const claim = this.input.store.claimProjectWorkerEvidence({
      now,
      claimToken,
      staleClaimMs: this.input.staleClaimMs ?? 30_000,
    });
    if (!claim) return;
    const evidence = this.input.store.listProjectWorkerEvidence()
      .find(item => item.evidenceId === claim.evidenceId);
    if (!evidence) {
      this.input.store.settleProjectWorkerEvidenceRetry(
        claim.outboxId, claimToken, 'evidence_missing', now + 1_000, now,
      );
      return;
    }
    const deadlineMs = this.input.deliveryDeadlineMs ?? 5_000;
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const deadlineError = new Error('task_control_project_evidence_deadline');
    const deadline = new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => {
        controller.abort(deadlineError);
        reject(deadlineError);
      }, deadlineMs);
      timeout.unref?.();
    });
    try {
      const receiptRef = await Promise.race([this.input.deliver(evidence, controller.signal), deadline]);
      try {
        this.input.store.settleProjectWorkerEvidenceDelivered(claim.outboxId, claimToken, receiptRef, this.input.now?.() ?? now);
      } catch (settleError) {
        // Delivery succeeded but the durable settle failed (SQLite busy, claim lost, etc.).
        // Leave the row inflight and rely on stale-claim recovery in the next process.
        void settleError;
      }
    } catch (error) {
      const settleAt = this.input.now?.() ?? now;
      const permanentCode = permanentDeliveryErrorCode(error);
      const permanent = permanentCode !== undefined;
      const detail = error instanceof Error ? error.message : String(error);
      const errorCode = permanent
        ? `permanent:${permanentCode}:${detail}`
        : detail;
      const nextAttemptAt = permanent
        ? Number.MAX_SAFE_INTEGER
        : settleAt + Math.min(1_000 * 2 ** Math.max(0, claim.attempts - 1), 60_000);
      try {
        this.input.store.settleProjectWorkerEvidenceRetry(claim.outboxId, claimToken, errorCode, nextAttemptAt, settleAt);
      } catch (settleError) {
        // Reset failed under SQLite busy / claim loss. Do not force a state change; the
        // durable inflight row remains recoverable by the stale-claim path.
        void settleError;
      }
    } finally {
      this.activeControllers.delete(controller);
      controller.abort(deadlineError);
    }
  }
}

const PERMANENT_CONTROLLER_REJECTION_REASONS = new Set([
  'project_worker_evidence_identity_invalid',
  'project_worker_evidence_mapping_unproven',
  'project_worker_evidence_conflict',
  'project_worker_evidence_future_skew',
  'reviewer_verdict_unverified',
  'reviewer_verdict_expired',
  'reviewer_verdict_superseded',
  'reviewer_verdict_revoked',
]);

function permanentDeliveryErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ((error as { permanent?: unknown }).permanent === true) {
    return (error as { code?: string }).code ?? 'controller_rejection';
  }
  const reason = error instanceof Error ? error.message : undefined;
  return reason !== undefined && PERMANENT_CONTROLLER_REJECTION_REASONS.has(reason) ? reason : undefined;
}
