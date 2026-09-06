import { getBotClient } from '../bot-registry.js';
import { getMessageDetail, larkGet } from '../im/lark/client.js';
import { TaskControlActiveCollector, type TaskControlCollectionKind, type TaskControlCollectionSource } from './task-control-plane-collector.js';
import {
  DaemonTaskControlBridge,
  type DaemonTaskControlMapping,
  type DaemonTaskControlMappingRegistration,
} from './task-control-plane-daemon-bridge.js';
import { TaskControlEventAdapters, taskControlEventIdempotencyKey } from './task-control-plane-events.js';
import type { TaskControlPlaneDeliveryResult, TaskControlPlaneLifecycle } from './task-control-plane-runtime.js';
import { TaskControlPlaneStore, type DeliveryOutboxRow, type ReviewerVerdictHead } from './task-control-plane-store.js';
import type {
  DesignatedReviewerMapping,
  ReviewerConditionEvidence,
  ReviewerVerdictAttestation,
  ReviewerVerdictV1,
} from './task-control-plane-reviewer-verdict.js';

const MAX_REFERENCE_POLL = 100;

type ReviewerVerdictVerifier = {
  verifyDesignatedReviewer(value: DesignatedReviewerMapping): boolean;
  verifyVerdict(value: ReviewerVerdictV1): boolean;
};

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validDocToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,256}$/.test(value);
}

function reference(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function sameTaskSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

type CollectedReference = {
  kind: 'task' | 'task_comment';
  sourceRef: string;
  eventId: string;
  idempotencyKey: string;
};

function assertLarkReadSucceeded(response: any, resource: string): void {
  if (response?.code !== 0) throw new Error(`${resource}_read_failed:${String(response?.code ?? 'missing_code')}`);
}

async function collectTaskReferences(larkAppId: string, taskGuid: string): Promise<CollectedReference[]> {
  const response = await larkGet(getBotClient(larkAppId), `/open-apis/task/v2/tasks/${encodeURIComponent(taskGuid)}`);
  assertLarkReadSucceeded(response, 'task');
  const updatedAt = nonBlank(response.data?.task?.updated_at);
  const sourceRef = reference('task', updatedAt ? `${taskGuid}@${updatedAt}` : taskGuid);
  const records: CollectedReference[] = [{
    kind: 'task', sourceRef, eventId: DaemonTaskControlBridge.observationId('task', sourceRef),
    idempotencyKey: `tcp-collect:task:${sourceRef}`,
  }];
  if (response.data?.task?.status === 'done') {
    const doneRef = reference('task-done-unverified', updatedAt ? `${taskGuid}@${updatedAt}` : taskGuid);
    records.push({
      kind: 'task', sourceRef: doneRef, eventId: DaemonTaskControlBridge.observationId('task', doneRef),
      idempotencyKey: `tcp-collect:task:${doneRef}`,
    });
  }
  return records;
}

async function collectLatestTaskCommentReference(larkAppId: string, taskGuid: string): Promise<CollectedReference[]> {
  const response = await larkGet(getBotClient(larkAppId), '/open-apis/task/v2/comments', {
    resource_type: 'task', resource_id: taskGuid, page_size: 1, direction: 'desc',
  });
  assertLarkReadSucceeded(response, 'task_comment');
  const commentId = nonBlank(response.data?.items?.[0]?.id);
  if (!commentId) return [];
  const sourceRef = reference('task-comment', commentId);
  return [{
    kind: 'task_comment', sourceRef, eventId: DaemonTaskControlBridge.observationId('task_comment', sourceRef),
    idempotencyKey: `tcp-collect:task_comment:${sourceRef}`,
  }];
}

/**
 * The daemon-side integration intentionally owns only typed mappings and stable
 * remote references. It is not a report/body parser: if a controller has not
 * explicitly registered a mapping, lifecycle hooks emit only UNKNOWN.
 */
export class DaemonTaskControlIntegration {
  readonly adapters: TaskControlEventAdapters;
  readonly collector: TaskControlActiveCollector;

  constructor(
    private readonly input: {
      dataDir: string;
      larkAppId: string;
      lifecycle: TaskControlPlaneLifecycle;
      store: TaskControlPlaneStore;
      bridge: DaemonTaskControlBridge;
      logger: { warn(message: string): void };
      /** Production injection: a receipt must still name the live worker generation. */
      isLiveReceiptOwner?: (input: { sessionId: string; workerGeneration: number }) => boolean;
    },
  ) {
    this.adapters = new TaskControlEventAdapters(input.lifecycle);
    this.collector = new TaskControlActiveCollector(input.lifecycle, this.collectionSource());
    this.restoreMappings();
  }

  private restoreMappings(): void {
    for (const mapping of this.input.store.listTrustedMappings()) {
      if (!this.input.bridge.restoreMapping(mapping)) {
        this.input.logger.warn('[task-control] ignored invalid persisted mapping reference');
      }
    }
  }

  registerMapping(
    dispatchRoot: string,
    mapping: DaemonTaskControlMappingRegistration,
    controllerId: string,
  ): boolean {
    const controllerMapping: DaemonTaskControlMapping = {
      ...mapping, controllerId, approvalGate: DaemonTaskControlBridge.bindApprovalGate(mapping.approvalGate),
    };
    if (!this.input.bridge.registerMapping(dispatchRoot, controllerMapping, controllerId)) return false;
    try {
      const authentication = this.input.bridge.issueAuthentication(dispatchRoot, 'controller');
      if (!authentication) return false;
      const registered = this.input.store.registerTrustedMapping({
        dispatchRoot, projectId: controllerMapping.projectId, phaseId: controllerMapping.phaseId, phaseTaskGuids: controllerMapping.phaseTaskGuids,
        taskGuid: mapping.taskGuid, topicRootId: mapping.topicRootId, ownerId: mapping.ownerId, reviewerId: mapping.reviewerId,
        acceptorId: mapping.acceptorId, registrationRef: mapping.registrationRef, controllerId,
        approvalGate: controllerMapping.approvalGate, docToken: mapping.docToken, authentication,
      });
      return registered.kind === 'registered' || registered.kind === 'duplicate';
    } catch (error) {
      this.input.bridge.removeMapping(dispatchRoot);
      this.input.logger.warn(`[task-control] mapping registry persistence failed: ${String(error)}`);
      return false;
    }
  }

  /** Read-only bridge accessors keep daemon routes out of bridge internals. */
  mapping(dispatchRoot: string): DaemonTaskControlMapping | undefined {
    return this.input.bridge.mapping(dispatchRoot);
  }

  issueAuthentication(
    dispatchRoot: string,
    principal: 'controller' | 'worker' | 'reviewer' | 'acceptor' | 'collector',
  ) {
    return this.input.bridge.issueAuthentication(dispatchRoot, principal);
  }

  approval(dispatchRoot: string, approvalRef: string) {
    return this.input.bridge.approval(dispatchRoot, approvalRef);
  }

  /**
   * Internal submission seam. Production routes never accept a caller-selected
   * verifier: they resolve the fixed app-scoped verifier from the current
   * designation and pass it through `submitVerifiedReviewerVerdict()` below.
   */
  submitReviewerVerdict(input: {
    dispatchRoot: string;
    verdict: ReviewerVerdictV1;
    attestation: ReviewerVerdictAttestation;
    authentication: Parameters<TaskControlPlaneStore['appendReviewerVerdict']>[0]['authentication'];
    verifyVerdict: (value: ReviewerVerdictV1) => boolean;
    now?: string;
  }): ReviewerVerdictHead {
    const mapping = this.input.bridge.mapping(input.dispatchRoot);
    if (!mapping
      || input.verdict.projectId !== mapping.projectId
      || input.verdict.phaseId !== mapping.phaseId
      || input.verdict.taskGuid !== mapping.taskGuid
      || input.verdict.topicRootId !== mapping.topicRootId
      || !sameTaskSet(input.verdict.taskSetSnapshot, mapping.phaseTaskGuids)
      || input.verdict.reviewerBotAppId !== input.attestation.reviewerBotAppId) {
      return { status: 'unknown', reason: 'reviewer_verdict_mapping_unproven' };
    }
    const head = this.input.store.appendReviewerVerdict({
      verdict: input.verdict, attestation: input.attestation, authentication: input.authentication, verifyVerdict: input.verifyVerdict, now: input.now,
    });
    if (head.status !== 'active' || !head.verdict || head.verdict.kind !== 'verdict' || !head.verdict.verdict) {
      this.reviewerVerdictUnknown(input.dispatchRoot, input.verdict.verdictId, head.reason ?? 'reviewer_verdict_unverified');
      return head;
    }
    const verdict = head.verdict;
    const reviewed = this.appendVerifiedReviewed(input.dispatchRoot, `reviewer-verdict:${verdict.verdictId}`, {
      reviewRound: verdict.reviewRound, reviewCommentId: verdict.sourceCommentId ?? verdict.sourceMessageId ?? '',
      verdict: verdict.verdict as 'pass' | 'conditional' | 'fail', conditionIds: [...verdict.conditionIds],
      resolvedConditionEvidence: { ...verdict.resolvedConditionEvidence },
      docToken: verdict.docToken, docRevision: verdict.docRevision,
      reviewerVerdictId: verdict.verdictId,
      evidenceRef: verdict.sourceCommentId ? `task-comment:${verdict.sourceCommentId}` : `topic-message:${verdict.sourceMessageId}`,
    }, input.now);
    if (!reviewed.ok) {
      this.reviewerVerdictUnknown(input.dispatchRoot, verdict.verdictId, reviewed.reason, `reviewer-verdict:${verdict.verdictId}`);
      return { status: 'unknown', reason: reviewed.reason };
    }
    return head;
  }

  /** Production-only continuation after the route re-read Lark source and
   * derived a verifier from the designation's reviewer app. */
  submitVerifiedReviewerVerdict(input: {
    dispatchRoot: string;
    verdict: ReviewerVerdictV1;
    attestation: ReviewerVerdictAttestation;
    verifier: ReviewerVerdictVerifier;
    expectedReviewerBotAppId: string;
    expectedReviewerId: string;
    now?: string;
  }): ReviewerVerdictHead {
    const authentication = this.input.bridge.issueAuthentication(input.dispatchRoot, 'reviewer');
    if (!authentication) {
      this.reviewerVerdictUnknown(input.dispatchRoot, input.verdict.verdictId, 'reviewer_verdict_authentication_unproven');
      return { status: 'unknown', reason: 'reviewer_verdict_authentication_unproven' };
    }
    if (input.verdict.reviewerBotAppId !== input.expectedReviewerBotAppId
      || input.verdict.reviewerId !== input.expectedReviewerId
      || input.attestation.reviewerBotAppId !== input.expectedReviewerBotAppId
      || input.attestation.reviewerId !== input.expectedReviewerId) {
      this.reviewerVerdictUnknown(input.dispatchRoot, input.verdict.verdictId, 'reviewer_verdict_designation_unproven');
      return { status: 'unknown', reason: 'reviewer_verdict_designation_unproven' };
    }
    return this.submitReviewerVerdict({
      dispatchRoot: input.dispatchRoot, verdict: input.verdict, attestation: input.attestation, authentication,
      verifyVerdict: value => value.reviewerBotAppId === input.expectedReviewerBotAppId
        && value.reviewerId === input.expectedReviewerId
        && input.verifier.verifyVerdict(value), now: input.now,
    });
  }

  registerDesignatedReviewer(input: {
    mapping: DesignatedReviewerMapping;
    authentication: Parameters<TaskControlPlaneStore['appendDesignatedReviewer']>[1];
    verify: (value: DesignatedReviewerMapping) => boolean;
  }): void {
    this.input.store.appendDesignatedReviewer(input.mapping, input.authentication, input.verify);
  }

  /** Production registration has a fixed controller verifier; IPC cannot inject one. */
  registerVerifiedDesignatedReviewer(input: {
    mapping: DesignatedReviewerMapping;
    verifier: ReviewerVerdictVerifier;
  }): boolean {
    const authentication = this.input.bridge.issueAuthentication(this.dispatchRootForMapping(input.mapping), 'controller');
    if (!authentication || input.mapping.controllerBotAppId !== this.input.larkAppId) return false;
    try {
      this.input.store.setReviewerVerdictVerifier(input.verifier);
      this.input.store.appendDesignatedReviewer(input.mapping, authentication, value => input.verifier.verifyDesignatedReviewer(value));
      if (!this.input.bridge.setDesignatedReviewerPrincipal(this.dispatchRootForMapping(input.mapping), input.mapping.reviewerId)) {
        return false;
      }
      return true;
    } catch { return false; }
  }

  setReviewerVerdictVerifier(verifier: ReviewerVerdictVerifier): void {
    this.input.store.setReviewerVerdictVerifier(verifier);
  }

  currentDesignatedReviewer(dispatchRoot: string, reviewRound: number, now?: string): DesignatedReviewerMapping | undefined {
    const mapping = this.input.bridge.mapping(dispatchRoot);
    if (!mapping) return undefined;
    return this.input.store.getCurrentDesignatedReviewer({
      projectId: mapping.projectId, phaseId: mapping.phaseId, taskGuid: mapping.taskGuid, topicRootId: mapping.topicRootId,
      taskSetSnapshot: mapping.phaseTaskGuids, reviewRound, now,
    });
  }

  private dispatchRootForMapping(mapping: DesignatedReviewerMapping): string {
    for (const { dispatchRoot, mapping: trusted } of this.input.bridge.listMappings()) {
      if (trusted.projectId === mapping.projectId && trusted.phaseId === mapping.phaseId
        && trusted.taskGuid === mapping.taskGuid && trusted.topicRootId === mapping.topicRootId
        && trusted.phaseTaskGuids.includes(mapping.taskGuid)) return dispatchRoot;
    }
    return '';
  }

  dispatchRequested(dispatchRoot: string, sourceSessionId: string, occurredAt: string): void {
    const event = this.input.bridge.event({
      dispatchRoot, principal: 'controller',
      eventId: `tcp-dispatch:${dispatchRoot}`,
      idempotencyKey: taskControlEventIdempotencyKey('task.dispatch_requested', reference('dispatch', dispatchRoot)),
      sourceRef: reference('dispatch', dispatchRoot),
      payload: { sourceSessionId, dispatchRoot },
    });
    if (!event) {
      this.input.lifecycle.enqueueUnknownObservation({
        eventId: `tcp-unknown-dispatch:${dispatchRoot}`, attemptedEventType: 'task.dispatch_requested',
        sourceRef: reference('dispatch', dispatchRoot), idempotencyKey: `tcp-unknown-dispatch:${dispatchRoot}`,
        occurredAt, payload: { source: 'dispatch', referenceOnly: true },
      });
      return;
    }
    this.adapters.enqueue('task.dispatch_requested', { ...event, payload: { dispatchRoot, sourceSessionId } });
  }

  workerAccepted(dispatchRoot: string, sourceRef: string, occurredAt?: string): void {
    this.appendMapped('task.accepted', dispatchRoot, 'worker', sourceRef, occurredAt);
  }

  workerExecutionStarted(dispatchRoot: string, sourceRef: string, occurredAt?: string): void {
    this.appendMapped('task.execution_started', dispatchRoot, 'worker', sourceRef, occurredAt);
  }

  firstSubmitted(dispatchRoot: string, sourceRef: string, input: { docToken: string; docRevision: number; evidenceRef: string }): void {
    this.appendMapped('task.first_submitted', dispatchRoot, 'worker', sourceRef, undefined, input);
  }

  reviewed(dispatchRoot: string, sourceRef: string, input: {
    reviewRound: number; reviewCommentId: string; verdict: 'pass' | 'conditional' | 'fail' | 'unknown';
    conditionIds?: string[]; resolvedConditionEvidence?: Record<string, ReviewerConditionEvidence>; docToken: string; docRevision: number; evidenceRef: string; reviewerVerdictId: string;
  }): void {
    // A lifecycle review can originate only from submitReviewerVerdict(), after
    // the signed verdict, designation and current exact head were checked in
    // the same store. This public hook deliberately cannot turn a generic
    // daemon payload into task.reviewed, even if it carries an arbitrary id.
    this.reviewerVerdictUnknown(dispatchRoot, input.reviewerVerdictId, 'reviewer_verdict_submit_required', sourceRef);
  }

  private appendVerifiedReviewed(dispatchRoot: string, sourceRef: string, input: {
    reviewRound: number; reviewCommentId: string; verdict: 'pass' | 'conditional' | 'fail';
    conditionIds: string[]; resolvedConditionEvidence: Record<string, ReviewerConditionEvidence>;
    docToken: string; docRevision: number; evidenceRef: string; reviewerVerdictId: string;
  }, occurredAt?: string): { ok: true } | { ok: false; reason: string } {
    const bound = this.bridgeEvent('task.reviewed', dispatchRoot, 'reviewer', sourceRef, { ...input, independent: true }, input.evidenceRef);
    if (!bound) {
      return { ok: false, reason: 'reviewer_verdict_mapping_unproven' };
    }
    // A production receipt may report 201 only after its exact reviewed event
    // is durable (or an identical retry finds that same app-scoped event). The
    // general lifecycle append remains deliberately fail-soft for legacy hooks;
    // this narrow trusted ingress bypasses it so its HTTP result cannot claim a
    // review that only produced a runtime warning.
    try {
      const result = this.input.store.appendEvent({
        ...bound, eventType: 'task.reviewed',
        payload: { ...input, independent: true },
        ...(occurredAt ? { occurredAt } : {}),
      });
      if (result.kind === 'appended' || result.kind === 'duplicate') return { ok: true };
      return { ok: false, reason: 'reviewer_verdict_reviewed_append_conflict' };
    } catch {
      return { ok: false, reason: 'reviewer_verdict_reviewed_append_failed' };
    }
  }

  reviewerVerdictUnknown(dispatchRoot: string, verdictId: string, reason: string, sourceRef = `reviewer-verdict:${verdictId}`): void {
    this.input.lifecycle.enqueueUnknownObservation({
      eventId: `tcp-unknown-reviewed:${sourceRef}`, attemptedEventType: 'task.reviewed', sourceRef,
      idempotencyKey: `tcp-unknown-reviewed:${sourceRef}`,
      payload: { dispatchRoot, reviewerVerdictId: verdictId, reason, referenceOnly: true },
    });
  }

  reworkStarted(dispatchRoot: string, sourceRef: string, evidenceRef: string): void {
    // No revision-63 daemon-owned rework producer is wired yet. A worker/report
    // hint is retained as UNKNOWN rather than promoting FAIL/CONDITIONAL into a
    // state transition. A future producer must bind the active verdict id and a
    // fresh execution reference before it may write task.rework_started.
    this.input.lifecycle.enqueueUnknownObservation({
      eventId: `tcp-unknown-rework:${sourceRef}`, attemptedEventType: 'task.rework_started', sourceRef,
      idempotencyKey: `tcp-unknown-rework:${sourceRef}`,
      payload: { dispatchRoot, evidenceRef, source: 'rework_producer_unavailable', referenceOnly: true },
    });
  }

  delivered(dispatchRoot: string, sourceRef: string, input: {
    docToken: string; docRevision: number; destinationId: string; receiptRef: string; evidenceRef: string;
  }): void {
    const event = this.bridgeEvent('task.delivered', dispatchRoot, 'worker', sourceRef, {
      docToken: input.docToken, docRevision: input.docRevision,
    }, input.evidenceRef, [input.destinationId], true);
    if (!event) return;
    // Terminal provider confirmation is a durable side effect boundary. Append
    // its exact event/outbox synchronously, then bind the provider receipt to
    // that same event and destination. A write failure leaves the old path
    // untouched and cannot manufacture a receipt.
    this.input.lifecycle.append({ ...event, eventType: 'task.delivered', terminal: true, deliverTo: [input.destinationId] });
    // The synchronous lifecycle append is intentionally fail-soft and returns
    // void. Only settle after its own event/outbox row is observable; otherwise
    // leave the terminal fact unverified rather than inventing a receipt.
    const claimToken = `terminal:${event.eventId}`;
    const claimed = this.input.store.claimOutboxForEventDestination({
      eventId: event.eventId, destinationId: input.destinationId, now: Date.now(), claimToken,
    });
    if (!claimed) return;
    // Bind the opaque provider receipt to the exact event and destination only
    // after the event/outbox row exists. A readable topic/comment id alone is
    // never delivery proof for another event or another destination.
    const receiptRef = TaskControlPlaneStore.providerReceiptRef(event.eventId, input.destinationId, input.receiptRef);
    this.input.store.settleOutboxDelivered(claimed.outboxId, claimToken, { receiptRef });
  }

  doneMarked(dispatchRoot: string, sourceRef: string, evidenceRef?: string): void {
    this.appendMapped('task.done_marked', dispatchRoot, 'controller', sourceRef, undefined, evidenceRef ? { evidenceRef } : {});
  }

  terminalWithoutRevision(dispatchRoot: string, sourceRef: string, payload: Record<string, unknown>): void {
    this.input.lifecycle.enqueueUnknownObservation({
      eventId: `tcp-unknown-terminal:${sourceRef}`, attemptedEventType: 'task.delivered', sourceRef,
      idempotencyKey: `tcp-unknown-terminal:${sourceRef}`,
      payload: { dispatchRoot, source: 'turn_terminal', referenceOnly: true, ...payload },
    });
  }

  /**
   * Real final-output producer: a WorkerPool callback reaches here only after
   * the provider accepted the reply/comment and returned its receipt id. A
   * mapped doc token is then re-read for the exact revision. Every missing or
   * mismatched fact stays UNKNOWN; no response body, title, exit status or task
   * done bit participates in this decision.
   */
  async finalDeliveryReceived(
    dispatchRoot: string,
    sourceRef: string,
    input: { sessionId: string; workerGeneration: number; destinationId: string; receiptRef: string; docToken?: string },
  ): Promise<void> {
    if (!this.receiptOwnerStillLive(input)) {
      this.deliveryReceiptUnknown(sourceRef, input, 'receipt_worker_generation_unproven');
      return;
    }
    const mapping = this.input.bridge.mapping(dispatchRoot);
    if (!mapping || !input.docToken || input.docToken !== mapping.docToken) {
      this.terminalWithoutRevision(dispatchRoot, sourceRef, {
        destinationId: input.destinationId, receiptRef: input.receiptRef, reason: 'delivery_document_revision_unverified',
      });
      return;
    }
    try {
      const document = await larkGet(
        getBotClient(this.input.larkAppId),
        `/open-apis/docx/v1/documents/${encodeURIComponent(input.docToken)}`,
      );
      const revision = Number(document?.data?.document?.revision_id);
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('document_revision_unavailable');
      // The document read is an external await. Recheck the captured worker
      // generation before this receipt can create submission/delivery facts.
      if (!this.receiptOwnerStillLive(input)) {
        this.deliveryReceiptUnknown(sourceRef, input, 'receipt_worker_generation_changed_during_verification');
        return;
      }
      this.firstSubmitted(dispatchRoot, `${sourceRef}:submitted`, {
        docToken: input.docToken, docRevision: revision, evidenceRef: input.receiptRef,
      });
      this.delivered(dispatchRoot, sourceRef, {
        docToken: input.docToken, docRevision: revision, destinationId: input.destinationId,
        receiptRef: input.receiptRef, evidenceRef: input.receiptRef,
      });
    } catch (error) {
      this.terminalWithoutRevision(dispatchRoot, sourceRef, {
        destinationId: input.destinationId, receiptRef: input.receiptRef,
        reason: `delivery_document_revision_unavailable:${String(error)}`,
      });
    }
  }

  private receiptOwnerStillLive(input: { sessionId: string; workerGeneration: number }): boolean {
    // Receipt projection has no safe fallback: a missing resolver proves no
    // current worker ownership, so it must remain UNKNOWN rather than becoming
    // a terminal ledger fact.
    return this.input.isLiveReceiptOwner?.(input) === true;
  }

  /** A stale provider receipt is retained only as reference-only UNKNOWN. */
  deliveryReceiptUnknown(
    sourceRef: string,
    input: { sessionId: string; workerGeneration: number; destinationId: string; receiptRef: string; docToken?: string },
    reason: string,
  ): void {
    this.input.lifecycle.enqueueUnknownObservation({
      eventId: `tcp-unknown-delivery:${sourceRef}`, attemptedEventType: 'task.delivered', sourceRef,
      idempotencyKey: `tcp-unknown-delivery:${sourceRef}`,
      payload: {
        source: 'provider_receipt', referenceOnly: true, reason,
        sessionId: input.sessionId, workerGeneration: input.workerGeneration,
        destinationId: input.destinationId, receiptRef: input.receiptRef,
        ...(input.docToken ? { docToken: input.docToken } : {}),
      },
    });
  }

  reportFallbackUnknown(sourceRef: string, errorClass: string): void {
    this.input.lifecycle.enqueueUnknownObservation({
      eventId: `tcp-unknown-report:${sourceRef}`, attemptedEventType: 'task.delivery_fallback_verified', sourceRef,
      idempotencyKey: `tcp-unknown-report:${sourceRef}`,
      payload: { source: 'report-fallback', errorClass, referenceOnly: true },
    });
  }

  private appendMapped(
    eventType: 'task.accepted' | 'task.execution_started' | 'task.first_submitted' | 'task.reviewed' | 'task.rework_started' | 'task.done_marked',
    dispatchRoot: string,
    principal: 'worker' | 'reviewer' | 'controller',
    sourceRef: string,
    occurredAt?: string,
    details: Record<string, unknown> = {},
  ): void {
    const evidenceRef = typeof details.evidenceRef === 'string' ? details.evidenceRef : undefined;
    const { evidenceRef: _evidenceRef, ...payload } = details;
    const event = this.bridgeEvent(eventType, dispatchRoot, principal, sourceRef, payload, evidenceRef);
    if (!event) {
      this.input.lifecycle.enqueueUnknownObservation({
        eventId: `tcp-unknown-${eventType}:${sourceRef}`, attemptedEventType: eventType, sourceRef,
        idempotencyKey: `tcp-unknown-${eventType}:${sourceRef}`, occurredAt,
        payload: { source: 'daemon-hook', referenceOnly: true },
      });
      return;
    }
    this.adapters.enqueue(eventType, event);
  }

  private bridgeEvent(
    eventType: 'task.accepted' | 'task.execution_started' | 'task.first_submitted' | 'task.reviewed' | 'task.rework_started' | 'task.delivered' | 'task.done_marked',
    dispatchRoot: string,
    principal: 'worker' | 'reviewer' | 'controller',
    sourceRef: string,
    payload: Record<string, unknown>,
    evidenceRef?: string,
    deliverTo?: readonly string[],
    terminal?: boolean,
  ) {
    const event = this.input.bridge.event({
      dispatchRoot, principal, eventId: `tcp-${eventType}:${sourceRef}`,
      idempotencyKey: taskControlEventIdempotencyKey(eventType, sourceRef), sourceRef, payload, evidenceRef,
    });
    if (!event) {
      this.input.lifecycle.enqueueUnknownObservation({
        eventId: `tcp-unknown-${eventType}:${sourceRef}`, attemptedEventType: eventType, sourceRef,
        idempotencyKey: `tcp-unknown-${eventType}:${sourceRef}`,
        payload: { source: 'daemon-hook', referenceOnly: true },
      });
      return undefined;
    }
    return { ...event, ...(deliverTo ? { deliverTo } : {}), ...(terminal ? { terminal } : {}) };
  }

  async collectAll(): Promise<void> {
    await Promise.all((['task', 'task_comment', 'topic', 'doc_revision'] as const).map(async kind => {
      try { await this.collector.collect(kind); }
      catch (error) { this.input.logger.warn(`[task-control] ${kind} collector failed: ${String(error)}`); }
    }));
  }

  /** Controlled delivery: a stable task/topic reference is the destination. */
  async deliver(row: DeliveryOutboxRow): Promise<TaskControlPlaneDeliveryResult> {
    // Reading an existing Lark object only proves that object exists. It never
    // proves that THIS terminal event was delivered to its exact destination,
    // so the pump retains a retry/degraded claim until a typed receipt arrives.
    if (row.destinationId.startsWith('task-comment:')
      || row.destinationId.startsWith('topic-message:')
      || row.destinationId.startsWith('active-collection:')) {
      return { kind: 'retry', error: 'delivery_receipt_required_for_terminal_event' };
    }
    return { kind: 'degraded', error: 'delivery_destination_unrecognized' };
  }

  /**
   * Records a daemon-owned primary provider receipt for one exact terminal
   * event/destination. Unknown and visible-but-unbound objects are rejected.
   */
  terminalDelivered(input: { eventId: string; destinationId: string; receiptRef: string; deliveredAt?: string }): boolean {
    return this.input.store.settleOutboxDeliveredByReceipt({
      ...input,
      receiptRef: TaskControlPlaneStore.providerReceiptRef(input.eventId, input.destinationId, input.receiptRef),
    });
  }

  /**
   * A fallback can only settle an already degraded terminal destination when
   * the collector supplied an exact typed receipt reference. This does not infer
   * review/freeze or original report success.
   */
  fallbackVerified(input: {
    dispatchRoot: string; deliveryEventId: string; destinationId: string; method: 'task_comment' | 'topic_message' | 'active_collection'; receiptRef: string;
  }): void {
    const event = this.input.bridge.event({
      dispatchRoot: input.dispatchRoot, principal: 'collector',
      eventId: `tcp-fallback:${input.deliveryEventId}:${input.destinationId}:${input.receiptRef}`,
      idempotencyKey: taskControlEventIdempotencyKey('task.delivery_fallback_verified', `${input.deliveryEventId}:${input.destinationId}:${input.receiptRef}`),
      sourceRef: input.receiptRef, payload: {
        deliveryEventId: input.deliveryEventId, destinationId: input.destinationId, method: input.method, receiptRef: input.receiptRef,
      },
    });
    if (!event) {
      this.reportFallbackUnknown(input.receiptRef, 'fallback_mapping_unproven');
      return;
    }
    this.adapters.enqueue('task.delivery_fallback_verified', event);
  }

  private collectionSource(): TaskControlCollectionSource {
    return {
      list: async ({ kind, cursor }) => ({
        records: await this.collectReferences(kind, cursor),
        nextCursor: undefined,
      }),
    };
  }

  private async collectReferences(kind: TaskControlCollectionKind, _cursor?: string) {
    const records: Array<{ kind: TaskControlCollectionKind; sourceRef: string; eventId: string; idempotencyKey: string; occurredAt?: string }> = [];
    for (const { dispatchRoot, mapping } of this.input.bridge.listMappings().slice(0, MAX_REFERENCE_POLL)) {
      try {
        if (kind === 'topic') {
          await getMessageDetail(this.input.larkAppId, dispatchRoot, { userCardContent: false });
          const sourceRef = reference('topic-message', dispatchRoot);
          records.push({ kind, sourceRef, eventId: DaemonTaskControlBridge.observationId(kind, sourceRef), idempotencyKey: `tcp-collect:${kind}:${sourceRef}` });
        } else if (kind === 'doc_revision' && mapping.docToken && validDocToken(mapping.docToken)) {
          const document = await larkGet(getBotClient(this.input.larkAppId), `/open-apis/docx/v1/documents/${encodeURIComponent(mapping.docToken)}`);
          const revision = Number(document?.data?.document?.revision_id);
          if (Number.isSafeInteger(revision) && revision >= 0) {
            const sourceRef = reference('doc-revision', `${mapping.docToken}@${revision}`);
            records.push({ kind, sourceRef, eventId: DaemonTaskControlBridge.observationId(kind, sourceRef), idempotencyKey: `tcp-collect:${kind}:${sourceRef}` });
          }
        } else if (kind === 'task_comment') {
          records.push(...await collectLatestTaskCommentReference(this.input.larkAppId, mapping.taskGuid));
        } else if (kind === 'task') {
          records.push(...await collectTaskReferences(this.input.larkAppId, mapping.taskGuid));
        }
      } catch (error) {
        this.input.logger.warn(`[task-control] ${kind} reference unavailable for ${dispatchRoot}: ${String(error)}`);
        const sourceRef = reference('collection-error', `${kind}:${dispatchRoot}`);
        records.push({
          kind, sourceRef, eventId: DaemonTaskControlBridge.observationId(kind, sourceRef),
          idempotencyKey: `tcp-collect:${kind}:${sourceRef}`,
        });
      }
    }
    return records;
  }
}

/**
 * Narrow first-canary reader. It has no bridge, mapping, delivery, review or
 * freeze methods, so an exact task target cannot acquire control authority.
 */
export class DaemonTaskControlShadowCollector {
  readonly collector: TaskControlActiveCollector;
  private taskCommentUnavailable = false;

  constructor(
    private readonly input: {
      larkAppId: string;
      taskGuid: string;
      lifecycle: TaskControlPlaneLifecycle;
      logger: { warn(message: string): void };
    },
  ) {
    this.collector = new TaskControlActiveCollector(input.lifecycle, {
      list: async ({ kind }) => ({
        records: kind === 'task' || (kind === 'task_comment' && !this.taskCommentUnavailable)
          ? await this.collectReferences(kind)
          : [],
      }),
    });
  }

  async collectAll(): Promise<void> {
    await Promise.all((['task', 'task_comment'] as const).map(async kind => {
      try { await this.collector.collect(kind); }
      catch (error) { this.input.logger.warn(`[task-control] ${kind} collector failed: ${String(error)}`); }
    }));
  }

  private async collectReferences(kind: 'task' | 'task_comment') {
    const { larkAppId, taskGuid } = this.input;
    try {
      return kind === 'task'
        ? await collectTaskReferences(larkAppId, taskGuid)
        : await collectLatestTaskCommentReference(larkAppId, taskGuid);
    } catch (error) {
      if (kind === 'task_comment') this.taskCommentUnavailable = true;
      this.input.logger.warn(`[task-control] ${kind} reference unavailable for ${taskGuid}: ${String(error)}`);
      const sourceRef = reference('collection-error', `${kind}:${taskGuid}`);
      return [{ kind, sourceRef, eventId: DaemonTaskControlBridge.observationId(kind, sourceRef), idempotencyKey: `tcp-collect:${kind}:${sourceRef}` }];
    }
  }
}
