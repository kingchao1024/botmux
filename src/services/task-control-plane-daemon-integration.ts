import { getBotClient } from '../bot-registry.js';
import { getMessageDetail, larkGet, replyMessage } from '../im/lark/client.js';
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
import { TaskControlMappingTrust, taskControlMappingFacts } from './task-control-plane-mapping-trust.js';

const MAX_REFERENCE_POLL = 100;

type ReviewerVerdictVerifier = {
  verifyDesignatedReviewer(value: DesignatedReviewerMapping): boolean;
  verifyVerdict(value: ReviewerVerdictV1): boolean;
};

type TaskControlDeliveryClient = {
  listTaskComments(input: { taskGuid: string; pageToken?: string }): Promise<any>;
  createTaskComment(input: { taskGuid: string; content: string }): Promise<{ code?: number; commentId?: string }>;
  replyTopic(input: { topicRootId: string; content: string; uuid: string }): Promise<string>;
  readTopicMessage(input: { larkAppId: string; messageId: string }): Promise<unknown>;
  /** Read the entire topic before a fallback effect; unreadable means fail closed. */
  listTopicMessages(input: { larkAppId: string; topicRootId: string; pageToken?: string }): Promise<{ items: unknown[]; pageToken?: string; hasMore?: boolean }>;
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
  done?: boolean;
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
  if (response.data?.task?.status === 'done') records[0]!.done = true;
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
      /** Set only by the production daemon after host-only trust bootstrap. */
      mappingTrust?: TaskControlMappingTrust;
      receiptAllowedKeyIds?: readonly string[];
      receiptRevokedKeyIds?: readonly string[];
      /** Enable only when Pump is live; tests and Shadow keep receipt projection inert. */
      controlledWriteback?: boolean;
      /** Narrow test seam; production defaults to the existing Lark client. */
      deliveryClient?: TaskControlDeliveryClient;
    },
  ) {
    this.adapters = new TaskControlEventAdapters(input.lifecycle);
    this.collector = new TaskControlActiveCollector(input.lifecycle, this.collectionSource());
    this.restoreMappings();
  }

  private receiptMarkerOptions() {
    return { allowedKeyIds: this.input.receiptAllowedKeyIds, revokedKeyIds: this.input.receiptRevokedKeyIds };
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
    const prior = this.input.bridge.mapping(dispatchRoot);
    if (prior) {
      return JSON.stringify({
        controllerId: prior.controllerId, projectId: prior.projectId, phaseId: prior.phaseId, phaseTaskGuids: [...prior.phaseTaskGuids].sort(),
        taskGuid: prior.taskGuid, topicRootId: prior.topicRootId, ownerId: prior.ownerId, reviewerId: prior.reviewerId, acceptorId: prior.acceptorId,
        registrationRef: prior.registrationRef, registrationVersion: prior.registrationVersion, phaseRegistrationRefs: prior.phaseRegistrationRefs,
        approvalGate: prior.approvalGate, docToken: prior.docToken, docRevision: prior.docRevision,
      }) === JSON.stringify({
        controllerId, projectId: mapping.projectId, phaseId: mapping.phaseId, phaseTaskGuids: [...mapping.phaseTaskGuids].sort(),
        taskGuid: mapping.taskGuid, topicRootId: mapping.topicRootId, ownerId: mapping.ownerId, reviewerId: mapping.reviewerId, acceptorId: mapping.acceptorId,
        registrationRef: mapping.registrationRef, registrationVersion: mapping.registrationVersion, phaseRegistrationRefs: mapping.phaseRegistrationRefs,
        approvalGate: DaemonTaskControlBridge.bindApprovalGate(mapping.approvalGate), docToken: mapping.docToken, docRevision: mapping.docRevision,
      });
    }
    let controllerMapping: DaemonTaskControlMapping = {
      ...mapping, controllerId, approvalGate: DaemonTaskControlBridge.bindApprovalGate(mapping.approvalGate),
    };
    if (this.input.mappingTrust) {
      controllerMapping = {
        ...controllerMapping,
        mappingProof: this.input.mappingTrust.issueMapping(taskControlMappingFacts({
          dispatchRoot, projectId: controllerMapping.projectId, phaseId: controllerMapping.phaseId, phaseTaskGuids: controllerMapping.phaseTaskGuids,
          taskGuid: controllerMapping.taskGuid, topicRootId: controllerMapping.topicRootId, ownerId: controllerMapping.ownerId,
          reviewerId: controllerMapping.reviewerId, acceptorId: controllerMapping.acceptorId, registrationRef: controllerMapping.registrationRef, registrationVersion: controllerMapping.registrationVersion,
          phaseRegistrationRefs: controllerMapping.phaseRegistrationRefs, controllerId, approvalGate: controllerMapping.approvalGate, docToken: controllerMapping.docToken, docRevision: controllerMapping.docRevision,
        })),
      };
    }
    if (!this.input.bridge.registerMapping(dispatchRoot, controllerMapping, controllerId)) return false;
    try {
      const authentication = this.input.bridge.issueAuthentication(dispatchRoot, 'controller');
      if (!authentication) return false;
      const registered = this.input.store.registerTrustedMapping({
        dispatchRoot, projectId: controllerMapping.projectId, phaseId: controllerMapping.phaseId, phaseTaskGuids: controllerMapping.phaseTaskGuids,
        taskGuid: mapping.taskGuid, topicRootId: mapping.topicRootId, ownerId: mapping.ownerId, reviewerId: mapping.reviewerId,
        acceptorId: mapping.acceptorId, registrationRef: mapping.registrationRef, registrationVersion: mapping.registrationVersion, phaseRegistrationRefs: mapping.phaseRegistrationRefs, controllerId,
        approvalGate: controllerMapping.approvalGate, docToken: controllerMapping.docToken, docRevision: controllerMapping.docRevision, authentication,
        ...(controllerMapping.mappingProof ? { mappingProof: controllerMapping.mappingProof } : {}),
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

  /** Controller-owned freeze request; readiness is recomputed by the store. */
  requestFreeze(dispatchRoot: string, requestId = `legacy:${dispatchRoot}`): boolean {
    const mapping = this.input.bridge.mapping(dispatchRoot);
    const authentication = this.input.bridge.issueAuthentication(dispatchRoot, 'controller');
    if (!mapping || !authentication) return false;
    const requestRef = `approval:${requestId.replace(/[^A-Za-z0-9._:-]/g, '_')}`;
    const eventId = `tcp-phase.freeze_requested:${requestRef}`;
    // A retry of the same authenticated application is defined by its stable
    // request reference. Return the persisted event before recomputing current
    // readiness, whose underlying facts may legitimately have changed.
    const prior = this.input.store.listEvents({ projectId: mapping.projectId, phaseId: mapping.phaseId })
      .find(event => event.eventId === eventId);
    if (prior) {
      const priorTaskGuids = Array.isArray(prior.payload.taskGuids)
        ? prior.payload.taskGuids.filter((taskGuid): taskGuid is string => typeof taskGuid === 'string')
        : [];
      return prior.eventType === 'phase.freeze_requested'
        && prior.sourceRef === requestRef
        && prior.payload.requestRef === requestRef
        && JSON.stringify([...priorTaskGuids].sort()) === JSON.stringify([...mapping.phaseTaskGuids].sort());
    }
    const openIssueCodes = this.input.store.validateProspectivePhaseFreeze(mapping.projectId, mapping.phaseId).issues
      .map(issue => issue.code).sort();
    try {
      const result = this.input.store.appendEvent({
        eventId, eventType: 'phase.freeze_requested',
        projectId: mapping.projectId, phaseId: mapping.phaseId, authentication, sourceRef: requestRef,
        idempotencyKey: taskControlEventIdempotencyKey('phase.freeze_requested', requestRef),
        payload: { taskGuids: mapping.phaseTaskGuids, openIssueCodes, requestRef },
      });
      return result.kind === 'appended' || result.kind === 'duplicate';
    } catch { return false; }
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
    if (head.status === 'revoked' && input.verdict.kind === 'revocation') return head;
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
    if (this.input.controlledWriteback && verdict.verdict === 'pass' && verdict.conditionIds.length === 0) {
      this.deliverAfterReview(input.dispatchRoot, verdict, `reviewer-verdict:${verdict.verdictId}`);
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
    // The lifecycle hook is intentionally asynchronous. Wait for its durable
    // event before producing rework so accepted/executing order stays intact.
    setImmediate(() => this.startReworkAfterExecution(dispatchRoot, sourceRef));
  }

  private startReworkAfterExecution(dispatchRoot: string, sourceRef: string): void {
    const mapping = this.input.bridge.mapping(dispatchRoot);
    if (!mapping) return;
    const execution = this.input.store.listEvents({ taskGuid: mapping.taskGuid }).find(event =>
      event.eventType === 'task.execution_started' && event.sourceRef === sourceRef,
    );
    if (!execution) return;
    const task = this.input.store.getTaskProjection(mapping.taskGuid);
    const review = task.independentReview;
    if (review?.reviewerVerdictId && (review.verdict === 'fail' || (review.verdict === 'conditional' && task.unresolvedReviewConditionIds.length > 0))) {
      this.beginRework({
        dispatchRoot, sourceRef: `rework:${execution.eventId}`, sourceReviewerVerdictId: review.reviewerVerdictId,
        newExecutionEventId: execution.eventId, evidenceRef: sourceRef,
      });
    }
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

  /**
   * Daemon-owned rework producer. It consumes the currently verified FAIL or
   * CONDITIONAL head and a fresh worker execution fact; no worker text or
   * report body can infer this transition.
   */
  beginRework(input: {
    dispatchRoot: string; sourceRef: string; sourceReviewerVerdictId: string; newExecutionEventId: string; evidenceRef: string;
  }): { ok: true } | { ok: false; reason: string } {
    const event = this.bridgeEvent('task.rework_started', input.dispatchRoot, 'worker', input.sourceRef, {
      sourceReviewerVerdictId: input.sourceReviewerVerdictId, newExecutionEventId: input.newExecutionEventId,
    }, input.evidenceRef);
    if (!event) return { ok: false, reason: 'rework_mapping_unproven' };
    try {
      const result = this.input.store.appendEvent({ ...event, eventType: 'task.rework_started' });
      return result.kind === 'appended' || result.kind === 'duplicate'
        ? { ok: true }
        : { ok: false, reason: 'rework_idempotency_conflict' };
    } catch { return { ok: false, reason: 'rework_source_unproven' }; }
  }

  delivered(dispatchRoot: string, sourceRef: string, input: {
    docToken: string; docRevision: number; destinationId: string; receiptRef: string; evidenceRef: string;
  }): void {
    const controlledDestination = this.input.controlledWriteback
      ? `task-comment:${this.input.bridge.mapping(dispatchRoot)?.taskGuid ?? ''}`
      : input.destinationId;
    const event = this.bridgeEvent('task.delivered', dispatchRoot, 'worker', sourceRef, {
      docToken: input.docToken, docRevision: input.docRevision,
    }, input.evidenceRef, [controlledDestination], true);
    if (!event) return;
    if (this.input.controlledWriteback && !this.input.bridge.mapping(dispatchRoot)?.taskGuid) return;
    // Terminal provider confirmation is a durable side effect boundary. Append
    // its exact event/outbox synchronously, then bind the provider receipt to
    // that same event and destination. A write failure leaves the old path
    // untouched and cannot manufacture a receipt.
    this.input.lifecycle.append({ ...event, eventType: 'task.delivered', terminal: true, deliverTo: [controlledDestination] });
    // The synchronous lifecycle append is intentionally fail-soft and returns
    // void. Only settle after its own event/outbox row is observable; otherwise
    // leave the terminal fact unverified rather than inventing a receipt.
    if (this.input.controlledWriteback) return;
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

  private deliverAfterReview(dispatchRoot: string, verdict: ReviewerVerdictV1, sourceRef: string): void {
    const mapping = this.input.bridge.mapping(dispatchRoot);
    const authentication = this.input.bridge.issueAuthentication(dispatchRoot, 'worker');
    if (!mapping || !authentication) return;
    try {
      this.input.store.appendEvent({
        eventId: `tcp-task.delivered:${sourceRef}`, eventType: 'task.delivered', projectId: mapping.projectId, phaseId: mapping.phaseId,
        taskGuid: mapping.taskGuid, topicRootId: mapping.topicRootId, authentication, sourceRef, evidenceRef: `topic-message:${verdict.sourceMessageId}`,
        idempotencyKey: taskControlEventIdempotencyKey('task.delivered', sourceRef), terminal: true, deliverTo: [`task-comment:${mapping.taskGuid}`],
        payload: { docToken: verdict.docToken, docRevision: verdict.docRevision, reviewerVerdictId: verdict.verdictId },
      });
    } catch {
      this.reviewerVerdictUnknown(dispatchRoot, verdict.verdictId, 'delivery_after_review_unproven', sourceRef);
    }
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
      const submitted = this.bridgeEvent('task.first_submitted', dispatchRoot, 'worker', `${sourceRef}:submitted`,
        { docToken: input.docToken, docRevision: revision }, input.receiptRef);
      if (!submitted) throw new Error('submission_mapping_unproven');
      const result = this.input.store.appendEvent({ ...submitted, eventType: 'task.first_submitted' });
      if (result.kind === 'conflict') throw new Error('submission_append_conflict');
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
    const event = this.input.store.listEvents().find(candidate => candidate.eventId === row.eventId);
    if (!event || event.eventType !== 'task.delivered' || !event.taskGuid || !event.topicRootId) {
      return { kind: 'degraded', error: 'delivery_event_unproven' };
    }
    const marker = this.input.mappingTrust?.issueDeliveryReceiptMarker({
      eventId: event.eventId, destinationId: row.destinationId, issuedAt: event.occurredAt,
    });
    const content = JSON.stringify({
      task_control_event_id: event.eventId, project_id: event.projectId, phase_id: event.phaseId, task_guid: event.taskGuid,
      doc_token: event.payload.docToken, doc_revision: event.payload.docRevision,
      ...(marker ? { task_control_delivery_receipt: marker } : {}),
    });
    const uuid = `tcp-${row.outboxId}`.slice(0, 50);
    const deliveryClient = this.input.deliveryClient ?? {
      listTaskComments: ({ taskGuid, pageToken }: { taskGuid: string; pageToken?: string }) => larkGet(getBotClient(this.input.larkAppId), '/open-apis/task/v2/comments', {
        resource_type: 'task', resource_id: taskGuid, page_size: 100, direction: 'desc', ...(pageToken ? { page_token: pageToken } : {}),
      }),
      createTaskComment: async ({ taskGuid, content }: { taskGuid: string; content: string }) => {
        const response = await getBotClient(this.input.larkAppId).task.v2.comment.create({ data: { resource_type: 'task', resource_id: taskGuid, content } });
        return { code: response?.code, commentId: nonBlank(response?.data?.comment?.id) };
      },
      replyTopic: ({ topicRootId, content, uuid: replyUuid }: { topicRootId: string; content: string; uuid: string }) =>
        replyMessage(this.input.larkAppId, topicRootId, content, 'text', true, replyUuid),
      readTopicMessage: ({ messageId }: { larkAppId: string; messageId: string }) => getMessageDetail(this.input.larkAppId, messageId),
      listTopicMessages: async ({ topicRootId, pageToken }: { larkAppId: string; topicRootId: string; pageToken?: string }) => {
        const root = await getMessageDetail(this.input.larkAppId, topicRootId);
        const rootItem = root && typeof root === 'object' && Array.isArray((root as Record<string, unknown>).items)
          ? (root as Record<string, any>).items[0] : undefined;
        const threadId = typeof rootItem?.thread_id === 'string' ? rootItem.thread_id : undefined;
        if (!threadId) throw new Error('topic_thread_unreadable');
        const response = await larkGet(getBotClient(this.input.larkAppId), '/open-apis/im/v1/messages', {
          container_id_type: 'thread', container_id: threadId, page_size: 50, sort_type: 'ByCreateTimeDesc',
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        if (response?.code !== 0 || !Array.isArray(response?.data?.items)) throw new Error('topic_messages_unreadable');
        return { items: response.data.items, ...(response.data.page_token ? { pageToken: response.data.page_token } : {}), hasMore: response.data.has_more === true };
      },
    };
    try {
      if (row.destinationId === `task-comment:${event.taskGuid}`) {
        const alreadyWritten = await this.findTaskCommentReceipt({
          taskGuid: event.taskGuid, eventId: event.eventId, destinationId: row.destinationId, marker,
        });
        if (alreadyWritten) return { kind: 'delivered', receiptRef: `task-comment:${alreadyWritten}` };
        const response = await deliveryClient.createTaskComment({ taskGuid: event.taskGuid, content });
        const receiptRef = response.commentId;
        if (response.code !== 0 || !receiptRef) {
          // Provider business rejections are permanent; transient failures use
          // retry and do not enqueue topic fallback yet.
          const code = Number(response.code);
          const permanent = code === 1470403 || code === 99991672;
          return {
            kind: permanent ? 'degraded' : 'retry', error: `task_comment_write_rejected:${String(response.code ?? 'missing')}`,
            ...(permanent ? { fallbackDestinationId: `topic-message:${event.topicRootId}` } : {}),
          };
        }
        // This binds the provider-returned id to the signed marker. A process
        // crash between write and local settlement is reconciled by the same
        // exact marker scan before a reclaimed row is re-sent.
        const reread = await this.findTaskCommentReceipt({
          taskGuid: event.taskGuid, eventId: event.eventId, destinationId: row.destinationId, marker,
        });
        if (reread !== receiptRef) return { kind: 'retry', error: 'task_comment_receipt_reread_unproven' };
        return { kind: 'delivered', receiptRef: `task-comment:${receiptRef}` };
      }
      if (row.destinationId === `topic-message:${event.topicRootId}`) {
        const prior = await this.findTopicReceipt({ event, destinationId: row.destinationId, marker, deliveryClient });
        if (prior.kind === 'found') {
          this.resolveTopicEffectUnknown(event, row);
          this.recordTopicFallback(event, row, `topic-message:${prior.messageId}`, `topic-message:${prior.messageId}`);
          return { kind: 'delivered', receiptRef: `topic-message:${prior.messageId}` };
        }
        if (prior.kind === 'unreadable') {
          return { kind: 'retry', error: 'topic_receipt_scan_unproven' };
        }
        if (!this.startTopicEffectUnknown(event, row)) {
          // A previous process reached the durable pre-effect journal but no
          // matching signed receipt is readable now. UUID expiry can no longer
          // prove a retry is safe, so preserve UNKNOWN and never write again.
          this.requireTopicEffectUnknown(event, row);
          return { kind: 'degraded', error: 'topic_effect_uncertain' };
        }
        const receiptRef = await deliveryClient.replyTopic({ topicRootId: event.topicRootId, content, uuid });
        const reread = await deliveryClient.readTopicMessage({ larkAppId: this.input.larkAppId, messageId: receiptRef });
        if (!this.topicReceiptMatches(reread, receiptRef, event, marker)) {
          return { kind: 'degraded', error: 'topic_effect_uncertain' };
        }
        this.resolveTopicEffectUnknown(event, row);
        this.recordTopicFallback(event, row, `topic-message:${receiptRef}`, `topic-message:${receiptRef}`);
        return { kind: 'delivered', receiptRef: `topic-message:${receiptRef}` };
      }
      return { kind: 'degraded', error: 'delivery_destination_unrecognized' };
    } catch (error) {
      return { kind: 'retry', error: `delivery_write_failed:${String(error)}` };
    }
  }

  private topicReceiptMatches(detail: unknown, messageId: string, event: ReturnType<TaskControlPlaneStore['listEvents']>[number], marker: unknown): boolean {
    const root = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as Record<string, unknown> : undefined;
    const item = Array.isArray(root?.items) && root!.items.length === 1 && root!.items[0] && typeof root!.items[0] === 'object'
      ? root!.items[0] as Record<string, unknown> : undefined;
    const content = typeof item?.body === 'object' && item.body && !Array.isArray(item.body)
      ? (item.body as Record<string, unknown>).content : item?.content;
    if (item?.message_id !== messageId || typeof content !== 'string') return false;
    let payload: unknown;
    try { payload = JSON.parse(content); } catch { return false; }
    const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    return !!record && record.task_control_event_id === event.eventId && record.task_guid === event.taskGuid
      && !!this.input.mappingTrust?.verifyDeliveryReceiptMarker(record.task_control_delivery_receipt, { eventId: event.eventId, destinationId: `topic-message:${event.topicRootId}` }, this.receiptMarkerOptions());
  }

  private topicReceiptItemMatches(item: unknown, event: ReturnType<TaskControlPlaneStore['listEvents']>[number], marker: unknown): string | undefined {
    const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    const messageId = typeof record?.message_id === 'string' ? record.message_id : undefined;
    const content = record?.body && typeof record.body === 'object' && !Array.isArray(record.body)
      ? (record.body as Record<string, unknown>).content : record?.content;
    if (!messageId || typeof content !== 'string') return undefined;
    let payload: unknown;
    try { payload = JSON.parse(content); } catch { return undefined; }
    const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    return payloadRecord?.task_control_event_id === event.eventId
      && payloadRecord.task_guid === event.taskGuid
      && this.input.mappingTrust?.verifyDeliveryReceiptMarker(payloadRecord.task_control_delivery_receipt, { eventId: event.eventId, destinationId: `topic-message:${event.topicRootId}` }, this.receiptMarkerOptions())
      ? messageId : undefined;
  }

  private async findTopicReceipt(input: { event: ReturnType<TaskControlPlaneStore['listEvents']>[number]; destinationId: string; marker: unknown; deliveryClient: TaskControlDeliveryClient }): Promise<{ kind: 'found'; messageId: string } | { kind: 'missing' } | { kind: 'unreadable' }> {
    if (!input.event.topicRootId || !this.input.mappingTrust?.verifyDeliveryReceiptMarker(input.marker, { eventId: input.event.eventId, destinationId: input.destinationId }, this.receiptMarkerOptions())) return { kind: 'unreadable' };
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < 100; page++) {
        const response = await input.deliveryClient.listTopicMessages({ larkAppId: this.input.larkAppId, topicRootId: input.event.topicRootId, ...(pageToken ? { pageToken } : {}) });
        for (const item of response.items) {
          const messageId = this.topicReceiptItemMatches(item, input.event, input.marker);
          if (messageId) return { kind: 'found', messageId };
        }
        if (!response.hasMore || !response.pageToken) return { kind: 'missing' };
        pageToken = response.pageToken;
      }
    } catch { return { kind: 'unreadable' }; }
    return { kind: 'unreadable' };
  }

  private topicEffectUnknownKey(event: ReturnType<TaskControlPlaneStore['listEvents']>[number], row: DeliveryOutboxRow): string {
    return `topic-effect:${event.eventId}:${row.destinationId}`;
  }

  private startTopicEffectUnknown(event: ReturnType<TaskControlPlaneStore['listEvents']>[number], row: DeliveryOutboxRow): boolean {
    const unknownKey = this.topicEffectUnknownKey(event, row);
    const existing = this.input.store.listEvents({ taskGuid: event.taskGuid }).some(candidate =>
      candidate.eventType === 'unknown.required' && candidate.payload.unknownKey === unknownKey,
    );
    if (existing) return false;
    const authentication = this.input.bridge.issueAuthentication(event.topicRootId ?? '', 'collector');
    if (!authentication || !event.taskGuid || !event.topicRootId) return false;
    try {
      const result = this.input.store.appendEvent({
        eventId: `tcp-unknown-topic-effect:${event.eventId}:${row.destinationId}`, eventType: 'unknown.required',
        projectId: event.projectId, phaseId: event.phaseId, taskGuid: event.taskGuid, topicRootId: event.topicRootId, authentication,
        sourceRef: `topic-message:${event.topicRootId}`, idempotencyKey: taskControlEventIdempotencyKey('unknown.required', unknownKey),
        payload: { unknownKey },
      });
      return result.kind === 'appended';
    } catch { return false; }
  }

  private resolveTopicEffectUnknown(event: ReturnType<TaskControlPlaneStore['listEvents']>[number], row: DeliveryOutboxRow): void {
    const unknownKey = this.topicEffectUnknownKey(event, row);
    const authentication = this.input.bridge.issueAuthentication(event.topicRootId ?? '', 'collector');
    if (!authentication || !event.taskGuid || !event.topicRootId) return;
    try {
      this.input.store.appendEvent({
        eventId: `tcp-unknown-topic-effect-declared:${event.eventId}:${row.destinationId}`, eventType: 'unknown.declared',
        projectId: event.projectId, phaseId: event.phaseId, taskGuid: event.taskGuid, topicRootId: event.topicRootId, authentication,
        sourceRef: `topic-message:${event.topicRootId}`, idempotencyKey: taskControlEventIdempotencyKey('unknown.declared', unknownKey),
        payload: { unknownKey },
      });
      this.input.store.appendEvent({
        eventId: `tcp-unknown-topic-effect-resolved:${event.eventId}:${row.destinationId}`, eventType: 'unknown.resolved',
        projectId: event.projectId, phaseId: event.phaseId, taskGuid: event.taskGuid, topicRootId: event.topicRootId, authentication,
        sourceRef: `topic-message:${event.topicRootId}`, idempotencyKey: taskControlEventIdempotencyKey('unknown.resolved', unknownKey),
        payload: { unknownKey },
      });
    } catch { /* the delivered receipt remains unproven until a later recovery scan */ }
  }

  private requireTopicEffectUnknown(event: ReturnType<TaskControlPlaneStore['listEvents']>[number], row: DeliveryOutboxRow): void {
    const unknownKey = `${this.topicEffectUnknownKey(event, row)}:unreadable`;
    const authentication = this.input.bridge.issueAuthentication(event.topicRootId ?? '', 'collector');
    if (!authentication || !event.taskGuid || !event.topicRootId) return;
    try {
      this.input.store.appendEvent({
        eventId: `tcp-unknown-topic-effect-unreadable:${event.eventId}:${row.destinationId}`, eventType: 'unknown.required',
        projectId: event.projectId, phaseId: event.phaseId, taskGuid: event.taskGuid, topicRootId: event.topicRootId, authentication,
        sourceRef: `topic-message:${event.topicRootId}`, idempotencyKey: taskControlEventIdempotencyKey('unknown.required', unknownKey),
        payload: { unknownKey },
      });
    } catch { /* durable delivery degradation remains the independent freeze block */ }
  }

  private async findTaskCommentReceipt(input: {
    taskGuid: string; eventId: string; destinationId: string; marker: unknown;
  }): Promise<string | undefined> {
    if (!this.input.mappingTrust || !this.input.mappingTrust.verifyDeliveryReceiptMarker(input.marker, input, this.receiptMarkerOptions())) return undefined;
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const deliveryClient = this.input.deliveryClient;
      const response = deliveryClient
        ? await deliveryClient.listTaskComments({ taskGuid: input.taskGuid, ...(pageToken ? { pageToken } : {}) })
        : await larkGet(getBotClient(this.input.larkAppId), '/open-apis/task/v2/comments', {
          resource_type: 'task', resource_id: input.taskGuid, page_size: 100, direction: 'desc', ...(pageToken ? { page_token: pageToken } : {}),
        });
      if (response?.code !== 0 || !Array.isArray(response?.data?.items)) return undefined;
      for (const item of response.data.items) {
        const commentId = nonBlank(item?.id);
        if (!commentId || typeof item?.content !== 'string') continue;
        let body: unknown;
        try { body = JSON.parse(item.content); } catch { continue; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
        const record = body as Record<string, unknown>;
        if (record.task_control_event_id !== input.eventId || record.task_guid !== input.taskGuid
          || !this.input.mappingTrust.verifyDeliveryReceiptMarker(record.task_control_delivery_receipt, input, this.receiptMarkerOptions())) continue;
        return commentId;
      }
      if (!response.data.has_more || typeof response.data.page_token !== 'string' || !response.data.page_token) return undefined;
      pageToken = response.data.page_token;
    }
    return undefined;
  }

  private recordTopicFallback(event: ReturnType<TaskControlPlaneStore['listEvents']>[number], row: DeliveryOutboxRow, receiptRef: string, evidenceRef: string): void {
    const primaryDestinationId = `task-comment:${event.taskGuid}`;
    const authentication = this.input.bridge.issueAuthentication(event.topicRootId ?? '', 'collector');
    if (!authentication || !event.taskGuid || !event.topicRootId) throw new Error('topic_fallback_authentication_unproven');
    const result = this.input.store.appendEvent({
      eventId: `tcp-fallback:${event.eventId}:${primaryDestinationId}:${receiptRef}`,
      eventType: 'task.delivery_fallback_verified', projectId: event.projectId, phaseId: event.phaseId, taskGuid: event.taskGuid, topicRootId: event.topicRootId,
      authentication, sourceRef: evidenceRef,
      idempotencyKey: taskControlEventIdempotencyKey('task.delivery_fallback_verified', `${event.eventId}:${primaryDestinationId}:${receiptRef}`),
      payload: { deliveryEventId: event.eventId, destinationId: primaryDestinationId, method: 'topic_message', receiptRef },
    });
    if (result.kind === 'conflict') throw new Error('topic_fallback_receipt_conflict');
    void row;
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
          const taskRecords = await collectTaskReferences(this.input.larkAppId, mapping.taskGuid);
          records.push(...taskRecords);
          for (const record of taskRecords) if (record.done) this.doneObserved(dispatchRoot, record.sourceRef);
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

  private doneObserved(dispatchRoot: string, sourceRef: string): void {
    const event = this.input.bridge.event({
      dispatchRoot, principal: 'collector', eventId: `tcp-task.done_marked:${sourceRef}`,
      idempotencyKey: taskControlEventIdempotencyKey('task.done_marked', sourceRef), sourceRef, payload: { source: 'task_api_reread' },
    });
    if (!event) return;
    try { this.input.store.appendEvent({ ...event, eventType: 'task.done_marked' }); }
    catch { this.input.lifecycle.enqueueUnknownObservation({
      eventId: `tcp-unknown-task.done_marked:${sourceRef}`, attemptedEventType: 'task.done_marked', sourceRef,
      idempotencyKey: `tcp-unknown-task.done_marked:${sourceRef}`, payload: { reason: 'task_done_reread_unproven', referenceOnly: true },
    }); }
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
