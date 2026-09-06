/**
 * Minimal, isolated control-plane evidence store.
 *
 * The event ledger is the source of truth and is append-only. Task/phase state,
 * mappings, UNKNOWN boundaries, and freeze readiness are read-only projections
 * rebuilt from that ledger. Delivery attempts use a durable outbox plus an
 * append-only receipt log so an unavailable report relay is observable instead
 * of being mistaken for successful delivery.
 *
 * The daemon/runtime wire this ledger only behind default-off task-control
 * flags. Production ReviewerVerdict trust-root signing, Lark source resolution,
 * and restricted ingress are intentionally not wired here; absent proof remains
 * UNKNOWN rather than being inferred from daemon/report state.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabaseSync, type DatabaseSyncLike } from './sqlite-compat.js';
import {
  reviewerCapabilityHash, reviewerVerdictPayloadHash, type DesignatedReviewerMapping, type ReviewerConditionEvidence, type ReviewerVerdictAttestation, type ReviewerVerdictV1,
} from './task-control-plane-reviewer-verdict.js';

const SCHEMA_VERSION = 12;
const DATABASE_NAME = 'botmux-task-control-plane.sqlite';

export type TaskControlEventType =
  | 'phase.opened'
  | 'mapping.registered'
  | 'task.dispatch_requested'
  | 'task.acceptance_requested'
  | 'task.accepted'
  | 'task.not_accepted'
  | 'task.acceptance_timed_out'
  | 'task.execution_started'
  | 'task.first_submitted'
  | 'task.reviewed'
  | 'task.review_corrected'
  | 'task.rework_started'
  | 'task.delivery_fallback_verified'
  | 'task.delivered'
  | 'task.done_marked'
  | 'task.blocked'
  | 'task.failed'
  | 'task.cancelled'
  | 'unknown.required'
  | 'unknown.declared'
  | 'unknown.resolved'
  | 'event.conflict_detected'
  | 'event.conflict_resolved'
  | 'phase.freeze_requested'
  | 'phase.frozen'
  | 'phase.blocked'
  | 'phase.failed'
  | 'phase.cancelled';

export type TaskControlTaskState =
  | 'planned'
  | 'accepted'
  | 'executing'
  | 'submitted'
  | 'reviewing'
  | 'rework'
  | 'delivered'
  | 'task_done_pending_freeze'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type TaskControlPhaseState =
  | 'planned'
  | 'active'
  | 'freeze_pending'
  | 'frozen'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type ReviewVerdict = 'pass' | 'conditional' | 'fail' | 'unknown';
export type TaskControlActorRole = 'controller' | 'worker' | 'reviewer' | 'collector' | 'acceptor';

export interface AuthenticatedTaskControlPrincipal {
  actorId: string;
  actorRole: TaskControlActorRole;
}

export interface VerifiedTaskControlApproval {
  approvalRef: string;
  projectId: string;
  phaseId: string;
  /** Exact sorted task-set snapshot the approval was issued for. */
  taskSetSnapshot: readonly string[];
  acceptorId: string;
  approvedAt: string;
  /** Approval proofs are short lived and must not be used after this instant. */
  expiresAt: string;
}

export interface TaskControlAuthority {
  /** Resolve an opaque runtime-authenticated context. Caller-supplied ids/roles are never accepted. */
  authenticate(authentication: unknown): AuthenticatedTaskControlPrincipal | undefined;
  /** Verify an opaque approval proof against the exact phase and designated acceptor. */
  verifyApproval(input: {
    approval: unknown;
    projectId: string;
    phaseId: string;
    taskSetSnapshot: readonly string[];
    acceptorId: string;
    now: string;
  }): VerifiedTaskControlApproval | undefined;
}

export interface AppendTaskControlEventInput {
  eventId: string;
  eventType: TaskControlEventType;
  projectId: string;
  phaseId: string;
  taskGuid?: string;
  topicRootId?: string;
  authentication: unknown;
  occurredAt?: string;
  sourceRef?: string;
  payloadRef?: string;
  evidenceRef?: string;
  idempotencyKey: string;
  causationId?: string;
  correlationId?: string;
  attempt?: number;
  errorClass?: string;
  ackDeadline?: string;
  terminal?: boolean;
  payload?: Record<string, unknown>;
  /** Destinations are frozen into durable outbox rows in the same transaction. */
  deliverTo?: readonly string[];
}

type AuthenticatedAppendTaskControlEventInput = Omit<AppendTaskControlEventInput, 'authentication'>
  & AuthenticatedTaskControlPrincipal;

export interface TaskControlEvent {
  seq: number;
  eventId: string;
  eventType: TaskControlEventType;
  schemaVersion: 1;
  projectId: string;
  phaseId: string;
  taskGuid?: string;
  topicRootId?: string;
  actorId: string;
  actorRole: TaskControlActorRole;
  occurredAt: string;
  stateBefore: TaskControlTaskState | TaskControlPhaseState;
  stateAfter: TaskControlTaskState | TaskControlPhaseState;
  sourceRef?: string;
  payloadRef?: string;
  evidenceRef?: string;
  idempotencyKey: string;
  causationId?: string;
  correlationId?: string;
  attempt: number;
  errorClass?: string;
  ackDeadline?: string;
  terminal: boolean;
  payloadHash: string;
  payload: Record<string, unknown>;
}

/** Non-state observation retained when a real daemon signal has no verified task mapping. */
export interface TaskControlObservation {
  seq: number;
  eventId: string;
  attemptedEventType: TaskControlEventType;
  sourceRef: string;
  idempotencyKey: string;
  occurredAt: string;
  outcome: 'unknown' | 'conflict';
  payloadHash: string;
  payload: Record<string, unknown>;
}

export interface AppendTaskControlObservationInput {
  eventId: string;
  attemptedEventType: TaskControlEventType;
  sourceRef: string;
  idempotencyKey: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}

export interface TaskIdentityMapping {
  projectId: string;
  phaseId: string;
  taskGuid: string;
  topicRootId: string;
  ownerId: string;
  eventId: string;
  seq: number;
}

export interface UnknownProjection {
  key: string;
  required: boolean;
  declared: boolean;
  resolved: boolean;
  declarationEventId?: string;
  resolutionEventId?: string;
}

export interface TerminalBodyProjection {
  eventId: string;
  seq: number;
  docToken: string;
  docRevision: number;
}

export interface ReviewProjection {
  eventId: string;
  seq: number;
  reviewRound: number;
  reviewCommentId: string;
  reviewerId: string;
  independent: boolean;
  verdict: ReviewVerdict;
  conditionIds: string[];
  resolvedConditionEvidence: Record<string, ReviewerConditionEvidence>;
  docToken?: string;
  docRevision?: number;
  reviewerVerdictId?: string;
}

export interface TaskProjection {
  taskGuid: string;
  mapping?: TaskIdentityMapping;
  state: TaskControlTaskState;
  explicitlyAccepted: boolean;
  acceptedEventId?: string;
  acceptedActorId?: string;
  terminalBody?: TerminalBodyProjection;
  independentReview?: ReviewProjection;
  /** Present when a historical review event no longer has a current trusted verdict head. */
  reviewerVerdictIssue?: string;
  unresolvedReviewConditionIds: string[];
  doneEvent?: { eventId: string; seq: number };
  unknowns: UnknownProjection[];
  unresolvedConflictEventIds: string[];
  transitionViolations: Array<{ eventId: string; eventType: TaskControlEventType; stateBefore: TaskControlTaskState }>;
}

export interface PhaseProjection {
  projectId: string;
  phaseId: string;
  state: TaskControlPhaseState;
  expectedTaskGuids: string[];
  designatedAcceptorId?: string;
  tasks: TaskProjection[];
  unknowns: UnknownProjection[];
  unresolvedConflictEventIds: string[];
  transitionViolations: Array<{ eventId: string; eventType: TaskControlEventType; stateBefore: TaskControlPhaseState }>;
}

export type AppendTaskControlEventResult =
  | { kind: 'appended'; event: TaskControlEvent }
  | { kind: 'duplicate'; event: TaskControlEvent }
  | { kind: 'conflict'; existingEvent: TaskControlEvent; conflictEvent: TaskControlEvent };

export type AppendTaskControlObservationResult =
  | { kind: 'appended'; observation: TaskControlObservation }
  | { kind: 'duplicate'; observation: TaskControlObservation }
  | { kind: 'conflict'; existingObservation: TaskControlObservation; conflictObservation: TaskControlObservation };

export type DeliveryOutboxStatus = 'pending' | 'inflight' | 'delivered' | 'degraded';
export type DeliveryReceiptState = 'retry_scheduled' | 'claim_recovered' | 'delivered' | 'degraded' | 'fallback_verified';
type DeliveryAttemptReceiptState = Exclude<DeliveryReceiptState, 'claim_recovered' | 'fallback_verified'>;
export type DeliveryFallbackMethod = 'task_comment' | 'topic_message' | 'active_collection';

export interface DeliveryFallbackEvidence {
  deliveryEventId: string;
  destinationId: string;
  method: DeliveryFallbackMethod;
  receiptRef: string;
}

export interface DeliveryOutboxRow {
  outboxId: string;
  eventId: string;
  destinationId: string;
  status: DeliveryOutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  claimToken?: string;
  claimedAt?: number;
  lastError?: string;
  fallbackEventId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryReceipt {
  receiptId: string;
  outboxId: string;
  eventId: string;
  destinationId: string;
  attempt: number;
  state: DeliveryReceiptState;
  receiptRef?: string;
  error?: string;
  fallbackEventId?: string;
  createdAt: string;
}

export type FreezeIssueCode =
  | 'phase_not_opened'
  | 'phase_task_set_empty'
  | 'phase_task_set_mismatch'
  | 'phase_freeze_not_requested'
  | 'phase_freeze_request_task_set_mismatch'
  | 'phase_freeze_request_open_issues'
  | 'phase_freeze_request_too_early'
  | 'task_mapping_missing'
  | 'task_acceptance_missing'
  | 'task_acceptance_actor_mismatch'
  | 'task_execution_missing'
  | 'task_submission_missing'
  | 'terminal_body_missing'
  | 'independent_review_missing'
  | 'reviewer_not_independent'
  | 'reviewer_verdict_unverified'
  | 'review_conditions_unresolved'
  | 'review_terminal_mismatch'
  | 'task_done_missing'
  | 'task_done_precedes_terminal_body'
  | 'task_done_precedes_review'
  | 'delivery_receipt_missing'
  | 'outbox_unsettled'
  | 'delivery_degraded_unhandled'
  | 'unknown_declaration_missing'
  | 'idempotency_conflict_unresolved'
  | 'invalid_transition_detected'
  | 'task_state_not_ready'
  | 'phase_state_not_ready';

export interface FreezeIssue {
  code: FreezeIssueCode;
  message: string;
  taskGuid?: string;
  eventId?: string;
  unknownKey?: string;
}

export interface PhaseFreezeValidation {
  ok: boolean;
  projectId: string;
  phaseId: string;
  checkedAt: string;
  taskGuids: string[];
  issues: FreezeIssue[];
}

export interface TaskFreezeSnapshot {
  taskGuid: string;
  topicRootId: string;
  ownerId: string;
  acceptanceEventId: string;
  terminalBody: TerminalBodyProjection;
  independentReview: ReviewProjection;
  doneEvent: { eventId: string; seq: number };
  deliveryReceipts: Array<{
    destinationId: string;
    status: 'delivered' | 'fallback_verified';
    receiptId: string;
    fallbackEventId?: string;
  }>;
  unknowns: UnknownProjection[];
}

export interface PhaseFreezeSnapshot {
  projectId: string;
  phaseId: string;
  freezeRequestedEventId: string;
  requestedTaskGuids: string[];
  requestedOpenIssueCodes: string[];
  requestRef: string;
  acceptorId: string;
  approvalRef: string;
  approvedAt: string;
  checkedAt: string;
  tasks: TaskFreezeSnapshot[];
  phaseUnknowns: UnknownProjection[];
  issues: FreezeIssue[];
}

export interface ApprovalConsumption {
  approvalRef: string;
  projectId: string;
  phaseId: string;
  taskSetHash: string;
  acceptorId: string;
  freezeIdempotencyKey: string;
  frozenEventId: string;
  approvedAt: string;
  consumedAt: string;
}

/** Durable, host-authenticated control identity. This is a reference record, not a task body. */
export interface TrustedTaskControlMappingRecord {
  dispatchRoot: string;
  projectId: string;
  phaseId: string;
  phaseTaskGuids: readonly string[];
  taskGuid: string;
  topicRootId: string;
  ownerId: string;
  reviewerId: string;
  acceptorId: string;
  registrationRef: string;
  registrationVersion?: string;
  phaseRegistrationRefs?: Record<string, string>;
  controllerId: string;
  approvalGate: {
    approvalRef: string;
    runId: string;
    nodeId: string;
    instanceId: string;
    waitId: string;
    operatorId: string;
    approverPolicy: readonly string[];
  };
  docToken?: string;
  docRevision?: number;
  mappingProof?: import('./task-control-plane-mapping-trust.js').TaskControlMappingProof;
  createdAt: string;
}

export interface RegisterTrustedTaskControlMappingInput {
  dispatchRoot: string;
  projectId: string;
  phaseId: string;
  phaseTaskGuids: readonly string[];
  taskGuid: string;
  topicRootId: string;
  ownerId: string;
  reviewerId: string;
  acceptorId: string;
  registrationRef: string;
  registrationVersion?: string;
  phaseRegistrationRefs?: Record<string, string>;
  controllerId: string;
  approvalGate: TrustedTaskControlMappingRecord['approvalGate'];
  docToken?: string;
  docRevision?: number;
  mappingProof?: import('./task-control-plane-mapping-trust.js').TaskControlMappingProof;
  authentication: unknown;
  occurredAt?: string;
}

export interface ReviewerVerdictHead {
  status: 'active' | 'superseded' | 'revoked' | 'unknown';
  verdict?: ReviewerVerdictV1;
  reason?: string;
}

export type RegisterTrustedTaskControlMappingResult =
  | { kind: 'registered'; mapping: TrustedTaskControlMappingRecord }
  | { kind: 'duplicate'; mapping: TrustedTaskControlMappingRecord };

interface EventRow {
  seq: number | bigint;
  event_id: string;
  lark_app_id: string;
  event_type: string;
  schema_version: number | bigint;
  project_id: string;
  phase_id: string;
  task_guid: string | null;
  topic_root_id: string | null;
  actor_id: string;
  actor_role: string;
  occurred_at: string;
  state_before: string;
  state_after: string;
  source_ref: string | null;
  payload_ref: string | null;
  evidence_ref: string | null;
  idempotency_key: string;
  causation_id: string | null;
  correlation_id: string | null;
  attempt: number | bigint;
  error_class: string | null;
  ack_deadline: string | null;
  terminal: number | bigint;
  payload_hash: string;
  payload_json: string;
}

interface TaskReduction {
  projection: TaskProjection;
  lifecycleState: TaskControlTaskState;
}

interface PhaseReduction {
  state: TaskControlPhaseState;
  lifecycleState: TaskControlPhaseState;
  expectedTaskGuids: string[];
  designatedAcceptorId?: string;
  latestFreezeRequest?: { eventId: string; taskGuids: string[]; openIssueCodes: string[]; requestRef: string };
  unknowns: UnknownProjection[];
  unresolvedConflictEventIds: string[];
  transitionViolations: PhaseProjection['transitionViolations'];
}

interface TaskTransitionRule {
  from: readonly TaskControlTaskState[];
  to: TaskControlTaskState | ((payload: Record<string, unknown>, current: TaskControlTaskState) => TaskControlTaskState);
}

const ALL_OPEN_TASK_STATES: readonly TaskControlTaskState[] = [
  'planned', 'accepted', 'executing', 'submitted', 'reviewing', 'rework', 'delivered', 'blocked',
];

const TASK_TRANSITIONS: Partial<Record<TaskControlEventType, TaskTransitionRule>> = {
  'task.acceptance_requested': { from: ['planned', 'blocked'], to: (_payload, current) => current },
  'task.accepted': { from: ['planned', 'blocked'], to: 'accepted' },
  'task.not_accepted': { from: ['planned', 'blocked'], to: 'blocked' },
  'task.acceptance_timed_out': { from: ['planned', 'blocked'], to: 'blocked' },
  // A rework execution must be evidenced after the reviewer result but before
  // task.rework_started can consume that result. Keep reviewing while recording
  // this fresh worker execution; the explicit rework event is the only state
  // transition into rework and is never inferred from FAIL/CONDITIONAL.
  'task.execution_started': {
    from: ['accepted', 'blocked', 'reviewing'],
    to: (_payload, current) => current === 'reviewing' ? 'reviewing' : 'executing',
  },
  'task.first_submitted': { from: ['executing', 'rework'], to: 'submitted' },
  'task.reviewed': {
    from: ['submitted'],
    to: payload => {
      const verdict = parseReviewVerdict(payload.verdict);
      if (verdict === 'unknown') return 'blocked';
      return 'reviewing';
    },
  },
  // A signed superseding verdict replaces review evidence but never repeats the
  // submitted→reviewing lifecycle transition.
  'task.review_corrected': { from: ['reviewing'], to: 'reviewing' },
  'task.rework_started': { from: ['reviewing'], to: 'rework' },
  'task.delivered': { from: ['reviewing'], to: 'delivered' },
  'task.done_marked': { from: ['delivered'], to: 'task_done_pending_freeze' },
  'task.blocked': { from: ALL_OPEN_TASK_STATES, to: 'blocked' },
  'task.failed': { from: ALL_OPEN_TASK_STATES, to: 'failed' },
  'task.cancelled': { from: ALL_OPEN_TASK_STATES, to: 'cancelled' },
  'event.conflict_detected': { from: ALL_OPEN_TASK_STATES, to: 'blocked' },
};

interface PhaseTransitionRule {
  from: readonly TaskControlPhaseState[];
  to: TaskControlPhaseState;
}

const PHASE_TRANSITIONS: Partial<Record<TaskControlEventType, PhaseTransitionRule>> = {
  'phase.opened': { from: ['planned'], to: 'active' },
  'phase.freeze_requested': { from: ['active', 'blocked', 'freeze_pending'], to: 'freeze_pending' },
  'phase.frozen': { from: ['freeze_pending'], to: 'frozen' },
  'phase.blocked': { from: ['planned', 'active', 'freeze_pending'], to: 'blocked' },
  'phase.failed': { from: ['planned', 'active', 'freeze_pending', 'blocked'], to: 'failed' },
  'phase.cancelled': { from: ['planned', 'active', 'freeze_pending', 'blocked'], to: 'cancelled' },
  'event.conflict_detected': { from: ['planned', 'active', 'freeze_pending', 'blocked'], to: 'blocked' },
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS control_events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    lark_app_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    project_id TEXT NOT NULL,
    phase_id TEXT NOT NULL,
    task_guid TEXT,
    topic_root_id TEXT,
    actor_id TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    state_before TEXT NOT NULL,
    state_after TEXT NOT NULL,
    source_ref TEXT,
    payload_ref TEXT,
    evidence_ref TEXT,
    idempotency_key TEXT NOT NULL,
    causation_id TEXT,
    correlation_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
    error_class TEXT,
    ack_deadline TEXT,
    terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0,1)),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(lark_app_id,event_id),
    UNIQUE(lark_app_id,idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS control_events_phase_seq ON control_events(lark_app_id,project_id,phase_id,seq);
  CREATE INDEX IF NOT EXISTS control_events_task_seq ON control_events(lark_app_id,task_guid,seq);
  CREATE UNIQUE INDEX IF NOT EXISTS control_mapping_topic_unique
    ON control_events(lark_app_id,topic_root_id) WHERE event_type='mapping.registered';
  CREATE UNIQUE INDEX IF NOT EXISTS control_mapping_task_unique
    ON control_events(lark_app_id,task_guid) WHERE event_type='mapping.registered';

  CREATE TABLE IF NOT EXISTS control_observations(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    lark_app_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    attempted_event_type TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('unknown','conflict')),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(lark_app_id,event_id),
    UNIQUE(lark_app_id,idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS control_observations_source_seq ON control_observations(lark_app_id,source_ref,seq);
  CREATE TRIGGER IF NOT EXISTS control_observations_no_update BEFORE UPDATE ON control_observations
  BEGIN SELECT RAISE(ABORT,'control_observation_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS control_observations_no_delete BEFORE DELETE ON control_observations
  BEGIN SELECT RAISE(ABORT,'control_observation_immutable'); END;

  CREATE TABLE IF NOT EXISTS control_approval_consumptions(
    lark_app_id TEXT NOT NULL,
    approval_ref TEXT NOT NULL,
    project_id TEXT NOT NULL,
    phase_id TEXT NOT NULL,
    task_set_hash TEXT NOT NULL,
    acceptor_id TEXT NOT NULL,
    freeze_idempotency_key TEXT NOT NULL,
    frozen_event_id TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    consumed_at TEXT NOT NULL,
    PRIMARY KEY(lark_app_id,approval_ref),
    UNIQUE(lark_app_id,freeze_idempotency_key),
    UNIQUE(lark_app_id,frozen_event_id),
    FOREIGN KEY(lark_app_id,frozen_event_id) REFERENCES control_events(lark_app_id,event_id)
  );
  CREATE TRIGGER IF NOT EXISTS control_approval_consumptions_no_update BEFORE UPDATE ON control_approval_consumptions
  BEGIN SELECT RAISE(ABORT,'control_approval_consumption_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS control_approval_consumptions_no_delete BEFORE DELETE ON control_approval_consumptions
  BEGIN SELECT RAISE(ABORT,'control_approval_consumption_immutable'); END;

  CREATE TABLE IF NOT EXISTS control_trusted_mappings(
    lark_app_id TEXT NOT NULL,
    dispatch_root TEXT NOT NULL,
    project_id TEXT NOT NULL,
    phase_id TEXT NOT NULL,
    phase_task_guids_json TEXT NOT NULL,
    task_guid TEXT NOT NULL,
    topic_root_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    acceptor_id TEXT NOT NULL,
    registration_ref TEXT NOT NULL,
    registration_version TEXT,
    phase_registration_refs_json TEXT,
    controller_id TEXT NOT NULL,
    approval_gate_json TEXT NOT NULL,
    doc_token TEXT,
    doc_revision INTEGER,
    mapping_proof_json TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(lark_app_id,dispatch_root),
    UNIQUE(lark_app_id,task_guid),
    UNIQUE(lark_app_id,topic_root_id),
    UNIQUE(lark_app_id,registration_ref)
  );
  CREATE TRIGGER IF NOT EXISTS control_trusted_mappings_no_update BEFORE UPDATE ON control_trusted_mappings
  BEGIN SELECT RAISE(ABORT,'control_mapping_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS control_trusted_mappings_no_delete BEFORE DELETE ON control_trusted_mappings
  BEGIN SELECT RAISE(ABORT,'control_mapping_immutable'); END;

  CREATE TABLE IF NOT EXISTS control_outbox(
    lark_app_id TEXT NOT NULL,
    outbox_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    destination_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','inflight','delivered','degraded')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    claim_token TEXT,
    claimed_at INTEGER,
    last_error TEXT,
    fallback_event_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(lark_app_id,outbox_id),
    UNIQUE(lark_app_id,event_id,destination_id),
    FOREIGN KEY(lark_app_id,event_id) REFERENCES control_events(lark_app_id,event_id),
    FOREIGN KEY(lark_app_id,fallback_event_id) REFERENCES control_events(lark_app_id,event_id)
  );
  CREATE INDEX IF NOT EXISTS control_outbox_due ON control_outbox(lark_app_id,status,next_attempt_at,outbox_id);

  CREATE TABLE IF NOT EXISTS control_delivery_receipts(
    lark_app_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    outbox_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    destination_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('retry_scheduled','claim_recovered','delivered','degraded','fallback_verified')),
    receipt_ref TEXT,
    error TEXT,
    fallback_event_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(lark_app_id,receipt_id),
    FOREIGN KEY(lark_app_id,outbox_id) REFERENCES control_outbox(lark_app_id,outbox_id),
    FOREIGN KEY(lark_app_id,event_id) REFERENCES control_events(lark_app_id,event_id),
    FOREIGN KEY(lark_app_id,fallback_event_id) REFERENCES control_events(lark_app_id,event_id)
  );
  CREATE INDEX IF NOT EXISTS control_receipts_event ON control_delivery_receipts(lark_app_id,event_id,created_at,receipt_id);

  CREATE TABLE IF NOT EXISTS control_designated_reviewers(
    designated_reviewer_ref TEXT NOT NULL,
    lark_app_id TEXT NOT NULL,
    project_id TEXT NOT NULL, phase_id TEXT NOT NULL, task_guid TEXT NOT NULL, topic_root_id TEXT NOT NULL, task_set_json TEXT NOT NULL, review_round INTEGER NOT NULL,
    reviewer_id TEXT NOT NULL, reviewer_bot_app_id TEXT NOT NULL, controller_id TEXT NOT NULL, controller_bot_app_id TEXT NOT NULL,
    effective_at TEXT NOT NULL, expires_at TEXT NOT NULL, issued_at TEXT NOT NULL, key_id TEXT NOT NULL, signature TEXT NOT NULL,
    supersedes_ref TEXT,
    PRIMARY KEY(lark_app_id,designated_reviewer_ref)
  );
  CREATE TRIGGER IF NOT EXISTS control_designated_reviewers_no_update BEFORE UPDATE ON control_designated_reviewers
  BEGIN SELECT RAISE(ABORT,'control_designated_reviewer_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS control_designated_reviewers_no_delete BEFORE DELETE ON control_designated_reviewers
  BEGIN SELECT RAISE(ABORT,'control_designated_reviewer_immutable'); END;

  CREATE TABLE IF NOT EXISTS control_reviewer_verdicts(
    verdict_id TEXT NOT NULL,
    lark_app_id TEXT NOT NULL, project_id TEXT NOT NULL, phase_id TEXT NOT NULL, task_guid TEXT NOT NULL, task_set_json TEXT NOT NULL, review_round INTEGER NOT NULL,
    canonical_hash TEXT NOT NULL, canonical_json TEXT NOT NULL, issued_at TEXT NOT NULL,
    PRIMARY KEY(lark_app_id,verdict_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS control_reviewer_verdict_payload_unique ON control_reviewer_verdicts(lark_app_id,verdict_id,canonical_hash);
  CREATE TRIGGER IF NOT EXISTS control_reviewer_verdicts_no_update BEFORE UPDATE ON control_reviewer_verdicts
  BEGIN SELECT RAISE(ABORT,'control_reviewer_verdict_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS control_reviewer_verdicts_no_delete BEFORE DELETE ON control_reviewer_verdicts
  BEGIN SELECT RAISE(ABORT,'control_reviewer_verdict_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS control_events_no_update BEFORE UPDATE ON control_events
  BEGIN SELECT RAISE(ABORT,'control_event_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS control_events_no_delete BEFORE DELETE ON control_events
  BEGIN SELECT RAISE(ABORT,'control_event_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS control_receipts_no_update BEFORE UPDATE ON control_delivery_receipts
  BEGIN SELECT RAISE(ABORT,'control_receipt_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS control_receipts_no_delete BEFORE DELETE ON control_delivery_receipts
  BEGIN SELECT RAISE(ABORT,'control_receipt_immutable'); END;
`;

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`task_control_invalid:${field}`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`task_control_invalid:${field}`);
  return value;
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`task_control_invalid:${field}`);
  const items = value.map((item, index) => nonEmpty(item, `${field}[${index}]`));
  return [...new Set(items)];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonicalize(child)]));
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

function payloadHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function eventPayloadHash(input: AuthenticatedAppendTaskControlEventInput): string {
  const semantic = {
    eventType: input.eventType,
    projectId: input.projectId,
    phaseId: input.phaseId,
    taskGuid: input.taskGuid ?? null,
    topicRootId: input.topicRootId ?? null,
    actorId: input.actorId,
    actorRole: input.actorRole,
    sourceRef: input.sourceRef ?? null,
    payloadRef: input.payloadRef ?? null,
    evidenceRef: input.evidenceRef ?? null,
    causationId: input.causationId ?? null,
    correlationId: input.correlationId ?? null,
    attempt: input.attempt ?? 1,
    errorClass: input.errorClass ?? null,
    ackDeadline: input.ackDeadline ?? null,
    terminal: input.terminal ?? false,
    payload: input.payload ?? {},
    deliverTo: [...new Set(input.deliverTo ?? [])].sort(),
  };
  return payloadHash(semantic);
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  return message.includes('database is locked') || message.includes('database table is locked')
    || message.includes('sqlite_busy') || message.includes('sqlite_locked');
}

function sleepShort(attempt: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20 * attempt, 100)); }
  catch { /* unavailable only on unusual JS runtimes */ }
}

function parseReviewVerdict(value: unknown): ReviewVerdict {
  if (value === 'pass' || value === 'conditional' || value === 'fail' || value === 'unknown') return value;
  throw new Error('task_control_invalid:payload.verdict');
}

function conditionEvidenceRefs(value: unknown): Record<string, ReviewerConditionEvidence> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('task_control_invalid:payload.resolvedConditionEvidence');
  }
  const result: Record<string, ReviewerConditionEvidence> = {};
  for (const [conditionId, evidence] of Object.entries(value as Record<string, unknown>)) {
    nonEmpty(conditionId, 'payload.resolvedConditionEvidence.conditionId');
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new Error(`task_control_invalid:payload.resolvedConditionEvidence.${conditionId}`);
    }
    const item = evidence as Record<string, unknown>;
    result[conditionId] = {
      evidenceRef: controlledEvidenceRef(item.evidenceRef, `payload.resolvedConditionEvidence.${conditionId}.evidenceRef`),
      observedAt: new Date(timestampMs(item.observedAt, `payload.resolvedConditionEvidence.${conditionId}.observedAt`)).toISOString(),
    };
  }
  return result;
}

function exactTaskSetSnapshot(value: unknown, field: string): string[] {
  return uniqueStrings(value, field).sort();
}

function taskSetHash(value: readonly string[]): string {
  return sha256(JSON.stringify(exactTaskSetSnapshot(value, 'taskSetSnapshot')));
}

function timestampMs(value: unknown, field: string): number {
  const normalized = nonEmpty(value, field);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`task_control_invalid:${field}`);
  return parsed;
}

function parseDeliveryFallback(payload: Record<string, unknown>): DeliveryFallbackEvidence {
  const deliveryEventId = nonEmpty(payload.deliveryEventId, 'payload.deliveryEventId');
  const destinationId = nonEmpty(payload.destinationId, 'payload.destinationId');
  const receiptRef = nonEmpty(payload.receiptRef, 'payload.receiptRef');
  const method = payload.method;
  if (method !== 'task_comment' && method !== 'topic_message' && method !== 'active_collection') {
    throw new Error('task_control_invalid:payload.method');
  }
  const pattern: Record<DeliveryFallbackMethod, RegExp> = {
    task_comment: /^task-comment:[0-9]+$/,
    topic_message: /^topic-message:om_[A-Za-z0-9]+$/,
    active_collection: /^active-collection:[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  };
  if (!pattern[method].test(receiptRef)) {
    throw new Error('task_control_invalid:payload.receiptRef');
  }
  return { deliveryEventId, destinationId, method, receiptRef };
}

function receiptRefBindsEventAndDestination(receiptRef: string, eventId: string, destinationId: string): boolean {
  // A generic readable message/comment id proves neither which terminal event
  // caused it nor which outbox destination it acknowledges. Terminal receipts
  // must carry a stable provider-issued binding envelope, preserving all three
  // dimensions without exposing payload/body text. Legacy stored evidence stays
  // readable but cannot settle a new row through this path.
  const match = /^provider-receipt:([a-f0-9]{32}):([a-f0-9]{32}):([a-f0-9]{32})$/.exec(receiptRef);
  if (!match) return false;
  return match[1] === sha256(eventId).slice(7, 39)
    && match[2] === sha256(destinationId).slice(7, 39)
    && match[3] !== '';
}

function receiptRefForEventDestination(eventId: string, destinationId: string, providerReceiptId: string): string {
  return `provider-receipt:${sha256(eventId).slice(7, 39)}:${sha256(destinationId).slice(7, 39)}:${sha256(nonEmpty(providerReceiptId, 'providerReceiptId')).slice(7, 39)}`;
}

function controlledEvidenceRef(value: unknown, field: string): string {
  const ref = nonEmpty(value, field);
  if (!/^(task-comment:[0-9]+|topic-message:om_[A-Za-z0-9]+|approval:[A-Za-z0-9][A-Za-z0-9._:-]*)$/.test(ref)) {
    throw new Error(`task_control_invalid:${field}`);
  }
  return ref;
}

function parseApprovalGate(value: unknown): TrustedTaskControlMappingRecord['approvalGate'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('task_control_invalid:approvalGate');
  const gate = value as Record<string, unknown>;
  return {
    approvalRef: controlledEvidenceRef(gate.approvalRef, 'approvalGate.approvalRef'),
    runId: nonEmpty(gate.runId, 'approvalGate.runId'),
    nodeId: nonEmpty(gate.nodeId, 'approvalGate.nodeId'),
    instanceId: nonEmpty(gate.instanceId, 'approvalGate.instanceId'),
    waitId: nonEmpty(gate.waitId, 'approvalGate.waitId'),
    operatorId: nonEmpty(gate.operatorId, 'approvalGate.operatorId'),
    approverPolicy: exactTaskSetSnapshot(gate.approverPolicy, 'approvalGate.approverPolicy'),
  };
}

function tableColumns(db: DatabaseSyncLike, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
    .map(row => typeof row.name === 'string' ? row.name : ''));
}

function hasCompositePrimaryKey(db: DatabaseSyncLike, table: string, expected: readonly string[]): boolean {
  const keys = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown; pk?: unknown }>)
    .map(row => ({ name: typeof row.name === 'string' ? row.name : '', pk: Number(row.pk) }))
    .filter(row => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(row => row.name);
  return JSON.stringify(keys) === JSON.stringify(expected);
}

function hasUniqueKey(db: DatabaseSyncLike, table: string, expected: readonly string[]): boolean {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name?: unknown; unique?: unknown }>)
    .some(index => index.unique === 1 && typeof index.name === 'string'
      && JSON.stringify((db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name?: unknown }>)
        .map(row => row.name)) === JSON.stringify(expected));
}

function hasCompositeForeignKey(
  db: DatabaseSyncLike, table: string, targetTable: string, from: readonly string[], to: readonly string[],
): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ id?: unknown; seq?: unknown; table?: unknown; from?: unknown; to?: unknown }> ;
  const groups = new Map<number, Array<{ seq: number; table: string; from: string; to: string }>>();
  for (const row of rows) {
    const id = Number(row.id);
    const entry = { seq: Number(row.seq), table: String(row.table), from: String(row.from), to: String(row.to) };
    groups.set(id, [...(groups.get(id) ?? []), entry]);
  }
  return [...groups.values()].some(group => {
    const ordered = [...group].sort((left, right) => left.seq - right.seq);
    return ordered.length === from.length
      && ordered.every((row, index) => row.table === targetTable && row.from === from[index] && row.to === to[index]);
  });
}

function migrateReviewerTablesToAppCompositeKeys(db: DatabaseSyncLike): void {
  const designationReady = hasCompositePrimaryKey(db, 'control_designated_reviewers', ['lark_app_id', 'designated_reviewer_ref']);
  const verdictReady = hasCompositePrimaryKey(db, 'control_reviewer_verdicts', ['lark_app_id', 'verdict_id']);
  if (designationReady && verdictReady) return;
  if (!designationReady && tableColumns(db, 'control_designated_reviewers').size === 0) throw new Error('task_control_schema_reviewer_designation_missing');
  if (!verdictReady && tableColumns(db, 'control_reviewer_verdicts').size === 0) throw new Error('task_control_schema_reviewer_verdict_missing');
  db.exec(`
    DROP TRIGGER IF EXISTS control_designated_reviewers_no_update;
    DROP TRIGGER IF EXISTS control_designated_reviewers_no_delete;
    DROP TRIGGER IF EXISTS control_reviewer_verdicts_no_update;
    DROP TRIGGER IF EXISTS control_reviewer_verdicts_no_delete;
    DROP INDEX IF EXISTS control_reviewer_verdict_payload_unique;
    ALTER TABLE control_designated_reviewers RENAME TO control_designated_reviewers_v7;
    ALTER TABLE control_reviewer_verdicts RENAME TO control_reviewer_verdicts_v7;
    CREATE TABLE control_designated_reviewers(
      designated_reviewer_ref TEXT NOT NULL,lark_app_id TEXT NOT NULL,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_guid TEXT NOT NULL,topic_root_id TEXT NOT NULL,task_set_json TEXT NOT NULL,review_round INTEGER NOT NULL,
      reviewer_id TEXT NOT NULL,reviewer_bot_app_id TEXT NOT NULL,controller_id TEXT NOT NULL,controller_bot_app_id TEXT NOT NULL,effective_at TEXT NOT NULL,expires_at TEXT NOT NULL,issued_at TEXT NOT NULL,key_id TEXT NOT NULL,signature TEXT NOT NULL,supersedes_ref TEXT,
      PRIMARY KEY(lark_app_id,designated_reviewer_ref)
    );
    CREATE TABLE control_reviewer_verdicts(
      verdict_id TEXT NOT NULL,lark_app_id TEXT NOT NULL,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_guid TEXT NOT NULL,task_set_json TEXT NOT NULL,review_round INTEGER NOT NULL,canonical_hash TEXT NOT NULL,canonical_json TEXT NOT NULL,issued_at TEXT NOT NULL,
      PRIMARY KEY(lark_app_id,verdict_id)
    );
    INSERT INTO control_designated_reviewers(
      designated_reviewer_ref,lark_app_id,project_id,phase_id,task_guid,topic_root_id,task_set_json,review_round,reviewer_id,reviewer_bot_app_id,controller_id,controller_bot_app_id,effective_at,expires_at,issued_at,key_id,signature,supersedes_ref
    ) SELECT designated_reviewer_ref,lark_app_id,project_id,phase_id,task_guid,topic_root_id,task_set_json,review_round,reviewer_id,reviewer_bot_app_id,controller_id,controller_bot_app_id,effective_at,expires_at,issued_at,key_id,signature,supersedes_ref FROM control_designated_reviewers_v7;
    INSERT INTO control_reviewer_verdicts(
      verdict_id,lark_app_id,project_id,phase_id,task_guid,task_set_json,review_round,canonical_hash,canonical_json,issued_at
    ) SELECT verdict_id,lark_app_id,project_id,phase_id,task_guid,task_set_json,review_round,canonical_hash,canonical_json,issued_at FROM control_reviewer_verdicts_v7;
    DROP TABLE control_designated_reviewers_v7;
    DROP TABLE control_reviewer_verdicts_v7;
    CREATE UNIQUE INDEX control_reviewer_verdict_payload_unique ON control_reviewer_verdicts(lark_app_id,verdict_id,canonical_hash);
    CREATE TRIGGER control_designated_reviewers_no_update BEFORE UPDATE ON control_designated_reviewers BEGIN SELECT RAISE(ABORT,'control_designated_reviewer_immutable'); END;
    CREATE TRIGGER control_designated_reviewers_no_delete BEFORE DELETE ON control_designated_reviewers BEGIN SELECT RAISE(ABORT,'control_designated_reviewer_immutable'); END;
    CREATE TRIGGER control_reviewer_verdicts_no_update BEFORE UPDATE ON control_reviewer_verdicts BEGIN SELECT RAISE(ABORT,'control_reviewer_verdict_immutable'); END;
    CREATE TRIGGER control_reviewer_verdicts_no_delete BEFORE DELETE ON control_reviewer_verdicts BEGIN SELECT RAISE(ABORT,'control_reviewer_verdict_immutable'); END;
  `);
}

/**
 * v9 scopes every durable logical identifier by lark_app_id. Earlier versions
 * filtered reads by app but retained global SQLite UNIQUE/PRIMARY KEY clauses,
 * so one controller could reserve an idempotency key, event id, outbox id or
 * receipt name for every other controller. Rebuild the related graph together
 * so foreign references stay inside the same app domain.
 *
 * This runs inside the caller's BEGIN IMMEDIATE transaction. Inserts preserve
 * every physical seq and payload verbatim; any duplicate or foreign-key defect
 * aborts the transaction rather than deleting or silently rewriting evidence.
 */
function migrateLogicalIdsToAppScope(db: DatabaseSyncLike): void {
  const ready = hasUniqueKey(db, 'control_events', ['lark_app_id', 'event_id'])
    && hasUniqueKey(db, 'control_events', ['lark_app_id', 'idempotency_key'])
    && hasUniqueKey(db, 'control_observations', ['lark_app_id', 'event_id'])
    && hasUniqueKey(db, 'control_observations', ['lark_app_id', 'idempotency_key'])
    && hasCompositePrimaryKey(db, 'control_approval_consumptions', ['lark_app_id', 'approval_ref'])
    && hasUniqueKey(db, 'control_approval_consumptions', ['lark_app_id', 'freeze_idempotency_key'])
    && hasUniqueKey(db, 'control_approval_consumptions', ['lark_app_id', 'frozen_event_id'])
    && hasCompositeForeignKey(db, 'control_approval_consumptions', 'control_events', ['lark_app_id', 'frozen_event_id'], ['lark_app_id', 'event_id'])
    && hasCompositePrimaryKey(db, 'control_trusted_mappings', ['lark_app_id', 'dispatch_root'])
    && hasUniqueKey(db, 'control_trusted_mappings', ['lark_app_id', 'task_guid'])
    && hasUniqueKey(db, 'control_trusted_mappings', ['lark_app_id', 'topic_root_id'])
    && hasUniqueKey(db, 'control_trusted_mappings', ['lark_app_id', 'registration_ref'])
    && hasCompositePrimaryKey(db, 'control_outbox', ['lark_app_id', 'outbox_id'])
    && hasUniqueKey(db, 'control_outbox', ['lark_app_id', 'event_id', 'destination_id'])
    && hasCompositeForeignKey(db, 'control_outbox', 'control_events', ['lark_app_id', 'event_id'], ['lark_app_id', 'event_id'])
    && hasCompositeForeignKey(db, 'control_outbox', 'control_events', ['lark_app_id', 'fallback_event_id'], ['lark_app_id', 'event_id'])
    && hasCompositePrimaryKey(db, 'control_delivery_receipts', ['lark_app_id', 'receipt_id'])
    && hasCompositeForeignKey(db, 'control_delivery_receipts', 'control_outbox', ['lark_app_id', 'outbox_id'], ['lark_app_id', 'outbox_id'])
    && hasCompositeForeignKey(db, 'control_delivery_receipts', 'control_events', ['lark_app_id', 'event_id'], ['lark_app_id', 'event_id'])
    && hasCompositeForeignKey(db, 'control_delivery_receipts', 'control_events', ['lark_app_id', 'fallback_event_id'], ['lark_app_id', 'event_id']);
  if (ready) return;
  const required = [
    'control_events', 'control_observations', 'control_approval_consumptions',
    'control_trusted_mappings', 'control_outbox', 'control_delivery_receipts',
  ];
  if (required.some(table => tableColumns(db, table).size === 0)) {
    throw new Error('task_control_schema_app_scope_tables_missing');
  }
  // Existing v8 databases can carry the former single-column foreign keys.
  // Rebuilding the connected graph swaps parents and children in one existing
  // BEGIN IMMEDIATE transaction, so defer enforcement until the replacement
  // graph is complete and then explicitly check it below.
  db.exec('PRAGMA defer_foreign_keys=ON;');
  db.exec(`
    DROP TRIGGER IF EXISTS control_events_no_update;
    DROP TRIGGER IF EXISTS control_events_no_delete;
    DROP TRIGGER IF EXISTS control_observations_no_update;
    DROP TRIGGER IF EXISTS control_observations_no_delete;
    DROP TRIGGER IF EXISTS control_approval_consumptions_no_update;
    DROP TRIGGER IF EXISTS control_approval_consumptions_no_delete;
    DROP TRIGGER IF EXISTS control_trusted_mappings_no_update;
    DROP TRIGGER IF EXISTS control_trusted_mappings_no_delete;
    DROP TRIGGER IF EXISTS control_receipts_no_update;
    DROP TRIGGER IF EXISTS control_receipts_no_delete;

    ALTER TABLE control_events RENAME TO control_events_v8;
    ALTER TABLE control_observations RENAME TO control_observations_v8;
    ALTER TABLE control_approval_consumptions RENAME TO control_approval_consumptions_v8;
    ALTER TABLE control_trusted_mappings RENAME TO control_trusted_mappings_v8;
    ALTER TABLE control_outbox RENAME TO control_outbox_v8;
    ALTER TABLE control_delivery_receipts RENAME TO control_delivery_receipts_v8;

    CREATE TABLE control_events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      lark_app_id TEXT NOT NULL,event_id TEXT NOT NULL,event_type TEXT NOT NULL,schema_version INTEGER NOT NULL CHECK(schema_version=1),
      project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_guid TEXT,topic_root_id TEXT,actor_id TEXT NOT NULL,actor_role TEXT NOT NULL,occurred_at TEXT NOT NULL,
      state_before TEXT NOT NULL,state_after TEXT NOT NULL,source_ref TEXT,payload_ref TEXT,evidence_ref TEXT,idempotency_key TEXT NOT NULL,
      causation_id TEXT,correlation_id TEXT,attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),error_class TEXT,ack_deadline TEXT,terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0,1)),
      payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,
      UNIQUE(lark_app_id,event_id),UNIQUE(lark_app_id,idempotency_key)
    );
    CREATE TABLE control_observations(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      lark_app_id TEXT NOT NULL,event_id TEXT NOT NULL,attempted_event_type TEXT NOT NULL,source_ref TEXT NOT NULL,idempotency_key TEXT NOT NULL,occurred_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('unknown','conflict')),payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,
      UNIQUE(lark_app_id,event_id),UNIQUE(lark_app_id,idempotency_key)
    );
    CREATE TABLE control_approval_consumptions(
      lark_app_id TEXT NOT NULL,approval_ref TEXT NOT NULL,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_set_hash TEXT NOT NULL,acceptor_id TEXT NOT NULL,
      freeze_idempotency_key TEXT NOT NULL,frozen_event_id TEXT NOT NULL,approved_at TEXT NOT NULL,consumed_at TEXT NOT NULL,
      PRIMARY KEY(lark_app_id,approval_ref),UNIQUE(lark_app_id,freeze_idempotency_key),UNIQUE(lark_app_id,frozen_event_id),
      FOREIGN KEY(lark_app_id,frozen_event_id) REFERENCES control_events(lark_app_id,event_id)
    );
    CREATE TABLE control_trusted_mappings(
      lark_app_id TEXT NOT NULL,dispatch_root TEXT NOT NULL,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,phase_task_guids_json TEXT NOT NULL,task_guid TEXT NOT NULL,topic_root_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,reviewer_id TEXT NOT NULL,acceptor_id TEXT NOT NULL,registration_ref TEXT NOT NULL,controller_id TEXT NOT NULL,approval_gate_json TEXT NOT NULL,doc_token TEXT,created_at TEXT NOT NULL,
      PRIMARY KEY(lark_app_id,dispatch_root),UNIQUE(lark_app_id,task_guid),UNIQUE(lark_app_id,topic_root_id),UNIQUE(lark_app_id,registration_ref)
    );
    CREATE TABLE control_outbox(
      lark_app_id TEXT NOT NULL,outbox_id TEXT NOT NULL,event_id TEXT NOT NULL,destination_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','inflight','delivered','degraded')),
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,claim_token TEXT,claimed_at INTEGER,last_error TEXT,fallback_event_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(lark_app_id,outbox_id),UNIQUE(lark_app_id,event_id,destination_id),
      FOREIGN KEY(lark_app_id,event_id) REFERENCES control_events(lark_app_id,event_id),
      FOREIGN KEY(lark_app_id,fallback_event_id) REFERENCES control_events(lark_app_id,event_id)
    );
    CREATE TABLE control_delivery_receipts(
      lark_app_id TEXT NOT NULL,receipt_id TEXT NOT NULL,outbox_id TEXT NOT NULL,event_id TEXT NOT NULL,destination_id TEXT NOT NULL,attempt INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('retry_scheduled','claim_recovered','delivered','degraded','fallback_verified')),receipt_ref TEXT,error TEXT,fallback_event_id TEXT,created_at TEXT NOT NULL,
      PRIMARY KEY(lark_app_id,receipt_id),
      FOREIGN KEY(lark_app_id,outbox_id) REFERENCES control_outbox(lark_app_id,outbox_id),
      FOREIGN KEY(lark_app_id,event_id) REFERENCES control_events(lark_app_id,event_id),
      FOREIGN KEY(lark_app_id,fallback_event_id) REFERENCES control_events(lark_app_id,event_id)
    );

    INSERT INTO control_events(
      seq,lark_app_id,event_id,event_type,schema_version,project_id,phase_id,task_guid,topic_root_id,actor_id,actor_role,occurred_at,state_before,state_after,source_ref,payload_ref,evidence_ref,idempotency_key,causation_id,correlation_id,attempt,error_class,ack_deadline,terminal,payload_hash,payload_json
    ) SELECT
      seq,lark_app_id,event_id,event_type,schema_version,project_id,phase_id,task_guid,topic_root_id,actor_id,actor_role,occurred_at,state_before,state_after,source_ref,payload_ref,evidence_ref,idempotency_key,causation_id,correlation_id,attempt,error_class,ack_deadline,terminal,payload_hash,payload_json
    FROM control_events_v8;
    INSERT INTO control_observations(
      seq,lark_app_id,event_id,attempted_event_type,source_ref,idempotency_key,occurred_at,outcome,payload_hash,payload_json
    ) SELECT
      seq,lark_app_id,event_id,attempted_event_type,source_ref,idempotency_key,occurred_at,outcome,payload_hash,payload_json
    FROM control_observations_v8;
    INSERT INTO control_trusted_mappings(
      lark_app_id,dispatch_root,project_id,phase_id,phase_task_guids_json,task_guid,topic_root_id,owner_id,reviewer_id,acceptor_id,registration_ref,controller_id,approval_gate_json,doc_token,created_at
    ) SELECT
      lark_app_id,dispatch_root,project_id,phase_id,phase_task_guids_json,task_guid,topic_root_id,owner_id,reviewer_id,acceptor_id,registration_ref,controller_id,approval_gate_json,doc_token,created_at
    FROM control_trusted_mappings_v8;
    INSERT INTO control_approval_consumptions(
      lark_app_id,approval_ref,project_id,phase_id,task_set_hash,acceptor_id,freeze_idempotency_key,frozen_event_id,approved_at,consumed_at
    ) SELECT
      lark_app_id,approval_ref,project_id,phase_id,task_set_hash,acceptor_id,freeze_idempotency_key,frozen_event_id,approved_at,consumed_at
    FROM control_approval_consumptions_v8;
    INSERT INTO control_outbox(
      lark_app_id,outbox_id,event_id,destination_id,status,attempts,next_attempt_at,claim_token,claimed_at,last_error,fallback_event_id,created_at,updated_at
    ) SELECT
      lark_app_id,outbox_id,event_id,destination_id,status,attempts,next_attempt_at,claim_token,claimed_at,last_error,fallback_event_id,created_at,updated_at
    FROM control_outbox_v8;
    INSERT INTO control_delivery_receipts(
      lark_app_id,receipt_id,outbox_id,event_id,destination_id,attempt,state,receipt_ref,error,fallback_event_id,created_at
    ) SELECT
      lark_app_id,receipt_id,outbox_id,event_id,destination_id,attempt,state,receipt_ref,error,fallback_event_id,created_at
    FROM control_delivery_receipts_v8;

    DROP TABLE control_delivery_receipts_v8;
    DROP TABLE control_outbox_v8;
    DROP TABLE control_approval_consumptions_v8;
    DROP TABLE control_trusted_mappings_v8;
    DROP TABLE control_observations_v8;
    DROP TABLE control_events_v8;
  `);
  if ((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length > 0) {
    throw new Error('task_control_schema_app_scope_foreign_key_invalid');
  }
  db.exec(SCHEMA);
}

/** Upgrade v4 in place. Every new owner/provenance column defaults empty so
 * legacy evidence remains readable but is never claimed by a v5 bot. */
function migrateSchema(db: DatabaseSyncLike, fromVersion: number): void {
  const add = (table: string, column: string, definition: string): void => {
    if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  };
  if (fromVersion < 5) {
    // v4 rows are preserved under an unclaimable legacy owner. They are visible
    // to a forensic raw SQLite read but cannot be picked up by a v5 daemon.
    add('control_events', 'lark_app_id', "lark_app_id TEXT NOT NULL DEFAULT 'legacy:v4'");
    add('control_observations', 'lark_app_id', "lark_app_id TEXT NOT NULL DEFAULT 'legacy:v4'");
    add('control_approval_consumptions', 'lark_app_id', "lark_app_id TEXT NOT NULL DEFAULT 'legacy:v4'");
    add('control_trusted_mappings', 'lark_app_id', "lark_app_id TEXT NOT NULL DEFAULT 'legacy:v4'");
    // v4 mappings are preserved but have no durable gate provenance, so they
    // cannot be restored as trusted v5 bindings. No rows are deleted or rewritten.
    add('control_trusted_mappings', 'approval_gate_json', "approval_gate_json TEXT NOT NULL DEFAULT ''");
    add('control_outbox', 'lark_app_id', "lark_app_id TEXT NOT NULL DEFAULT 'legacy:v4'");
    add('control_delivery_receipts', 'lark_app_id', "lark_app_id TEXT NOT NULL DEFAULT 'legacy:v4'");
    add('control_delivery_receipts', 'receipt_ref', 'receipt_ref TEXT');
  }
  // Existing v4 receipts can share a historic provider reference. New writes
  // are protected in insertReceiptLocked after their exact triple is checked.
  if (fromVersion < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS control_designated_reviewers(
        designated_reviewer_ref TEXT NOT NULL,lark_app_id TEXT NOT NULL,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_guid TEXT NOT NULL,topic_root_id TEXT NOT NULL DEFAULT '',task_set_json TEXT NOT NULL,review_round INTEGER NOT NULL,
        reviewer_id TEXT NOT NULL,reviewer_bot_app_id TEXT NOT NULL,controller_id TEXT NOT NULL,controller_bot_app_id TEXT NOT NULL,effective_at TEXT NOT NULL,expires_at TEXT NOT NULL,issued_at TEXT NOT NULL,key_id TEXT NOT NULL,signature TEXT NOT NULL,supersedes_ref TEXT,PRIMARY KEY(lark_app_id,designated_reviewer_ref)
      );
      CREATE TABLE IF NOT EXISTS control_reviewer_verdicts(
        verdict_id TEXT NOT NULL,lark_app_id TEXT NOT NULL,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_guid TEXT NOT NULL,task_set_json TEXT NOT NULL,review_round INTEGER NOT NULL,canonical_hash TEXT NOT NULL,canonical_json TEXT NOT NULL,issued_at TEXT NOT NULL,PRIMARY KEY(lark_app_id,verdict_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS control_reviewer_verdict_payload_unique ON control_reviewer_verdicts(lark_app_id,verdict_id,canonical_hash);
    `);
  }
  if (fromVersion < 7) {
    // Old ReviewerVerdict rows lack a canonical topic binding and are retained
    // only as forensic evidence. The empty default cannot validate a v7 verdict.
    add('control_designated_reviewers', 'topic_root_id', "topic_root_id TEXT NOT NULL DEFAULT ''");
  }
  // v4/v5 create the reviewer tables above in their final composite-key
  // shape. Only the original v6/v7 layouts need the v8 table rebuild.
  if (fromVersion >= 6 && fromVersion < 8) migrateReviewerTablesToAppCompositeKeys(db);
  if (fromVersion < 9) migrateLogicalIdsToAppScope(db);
  if (fromVersion < 10) add('control_trusted_mappings', 'mapping_proof_json', 'mapping_proof_json TEXT');
  if (fromVersion < 11) add('control_trusted_mappings', 'registration_version', 'registration_version TEXT');
  if (fromVersion < 12) {
    add('control_trusted_mappings', 'phase_registration_refs_json', 'phase_registration_refs_json TEXT');
    add('control_trusted_mappings', 'doc_revision', 'doc_revision INTEGER');
  }
}

function taskEvent(type: TaskControlEventType): boolean {
  return type === 'mapping.registered' || type.startsWith('task.');
}

function phaseEvent(type: TaskControlEventType): boolean {
  return type.startsWith('phase.');
}

function validateInput(input: AuthenticatedAppendTaskControlEventInput, allowFrozen: boolean): void {
  nonEmpty(input.eventId, 'eventId');
  nonEmpty(input.projectId, 'projectId');
  nonEmpty(input.phaseId, 'phaseId');
  nonEmpty(input.actorId, 'actorId');
  nonEmpty(input.actorRole, 'actorRole');
  if (!['controller', 'worker', 'reviewer', 'collector', 'acceptor'].includes(input.actorRole)) {
    throw new Error('task_control_invalid:actorRole');
  }
  nonEmpty(input.idempotencyKey, 'idempotencyKey');
  if ((input.attempt ?? 1) < 1 || !Number.isInteger(input.attempt ?? 1)) throw new Error('task_control_invalid:attempt');
  if (input.eventType === 'phase.frozen' && !allowFrozen) throw new Error('task_control_phase_freeze_requires_validator');
  if (input.taskGuid) nonEmpty(input.topicRootId, 'topicRootId');
  if (taskEvent(input.eventType)) {
    nonEmpty(input.taskGuid, 'taskGuid');
    nonEmpty(input.topicRootId, 'topicRootId');
  } else if (phaseEvent(input.eventType) && input.taskGuid) {
    throw new Error('task_control_invalid:phase_event_task_guid');
  }
  const payload = input.payload ?? {};
  if (input.eventType === 'phase.opened') {
    if (input.actorRole !== 'controller') throw new Error('task_control_invalid:phase_opener_role');
    uniqueStrings(payload.taskGuids, 'payload.taskGuids');
    const designatedAcceptorId = nonEmpty(payload.designatedAcceptorId, 'payload.designatedAcceptorId');
    if (designatedAcceptorId === input.actorId) throw new Error('task_control_invalid:acceptor_must_be_independent');
  }
  if (input.eventType === 'phase.freeze_requested') {
    if (input.actorRole !== 'controller') throw new Error('task_control_invalid:freeze_requester_role');
    uniqueStrings(payload.taskGuids, 'payload.taskGuids');
    uniqueStrings(payload.openIssueCodes, 'payload.openIssueCodes');
    const requestRef = controlledEvidenceRef(payload.requestRef, 'payload.requestRef');
    if (input.sourceRef !== requestRef) throw new Error('task_control_invalid:freeze_request_source_ref');
  }
  if (input.eventType === 'mapping.registered') nonEmpty(payload.ownerId, 'payload.ownerId');
  if (input.eventType === 'task.first_submitted' || input.eventType === 'task.delivered') {
    nonEmpty(payload.docToken, 'payload.docToken');
    positiveInteger(payload.docRevision, 'payload.docRevision');
  }
  if (input.eventType === 'task.reviewed' || input.eventType === 'task.review_corrected') {
    if (input.actorRole !== 'reviewer') throw new Error('task_control_invalid:reviewer_role');
    positiveInteger(payload.reviewRound, 'payload.reviewRound');
    nonEmpty(payload.reviewCommentId, 'payload.reviewCommentId');
    if (typeof payload.independent !== 'boolean') throw new Error('task_control_invalid:payload.independent');
    const verdict = parseReviewVerdict(payload.verdict);
    const conditionIds = payload.conditionIds === undefined
      ? []
      : exactTaskSetSnapshot(payload.conditionIds, 'payload.conditionIds');
    if (verdict === 'conditional' && conditionIds.length === 0) {
      throw new Error('task_control_invalid:payload.conditionIds_required');
    }
    if (verdict !== 'conditional' && conditionIds.length > 0) {
      throw new Error('task_control_invalid:payload.conditionIds_unexpected');
    }
    const resolvedConditionEvidence = conditionEvidenceRefs(payload.resolvedConditionEvidence);
    if (verdict === 'conditional'
      && Object.keys(resolvedConditionEvidence).some(conditionId => !conditionIds.includes(conditionId))) {
      throw new Error('task_control_invalid:payload.resolvedConditionEvidence_unknown_condition');
    }
    nonEmpty(payload.reviewerVerdictId, 'payload.reviewerVerdictId');
  }
  if (input.eventType === 'task.rework_started') {
    if (input.actorRole !== 'worker') throw new Error('task_control_invalid:rework_worker_role');
    nonEmpty(payload.sourceReviewerVerdictId, 'payload.sourceReviewerVerdictId');
    nonEmpty(payload.newExecutionEventId, 'payload.newExecutionEventId');
  }
  if (input.eventType === 'task.delivery_fallback_verified') {
    const fallback = parseDeliveryFallback(payload);
    if (input.actorRole !== 'controller' && input.actorRole !== 'collector') {
      throw new Error('task_control_invalid:fallback_verifier_role');
    }
    if (input.sourceRef !== fallback.receiptRef) throw new Error('task_control_invalid:fallback_source_ref');
  }
  if (input.eventType.startsWith('unknown.')) nonEmpty(payload.unknownKey, 'payload.unknownKey');
  if (input.eventType === 'event.conflict_resolved') nonEmpty(payload.conflictEventId, 'payload.conflictEventId');
  for (const destination of input.deliverTo ?? []) nonEmpty(destination, 'deliverTo');
}

function rowToEvent(row: EventRow): TaskControlEvent {
  return {
    seq: Number(row.seq),
    eventId: row.event_id,
    eventType: row.event_type as TaskControlEventType,
    schemaVersion: 1,
    projectId: row.project_id,
    phaseId: row.phase_id,
    ...(row.task_guid ? { taskGuid: row.task_guid } : {}),
    ...(row.topic_root_id ? { topicRootId: row.topic_root_id } : {}),
    actorId: row.actor_id,
    actorRole: row.actor_role as TaskControlActorRole,
    occurredAt: row.occurred_at,
    stateBefore: row.state_before as TaskControlTaskState | TaskControlPhaseState,
    stateAfter: row.state_after as TaskControlTaskState | TaskControlPhaseState,
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.payload_ref ? { payloadRef: row.payload_ref } : {}),
    ...(row.evidence_ref ? { evidenceRef: row.evidence_ref } : {}),
    idempotencyKey: row.idempotency_key,
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    attempt: Number(row.attempt),
    ...(row.error_class ? { errorClass: row.error_class } : {}),
    ...(row.ack_deadline ? { ackDeadline: row.ack_deadline } : {}),
    terminal: Number(row.terminal) === 1,
    payloadHash: row.payload_hash,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function rowToObservation(row: Record<string, unknown>): TaskControlObservation {
  return {
    seq: Number(row.seq),
    eventId: String(row.event_id),
    attemptedEventType: String(row.attempted_event_type) as TaskControlEventType,
    sourceRef: String(row.source_ref),
    idempotencyKey: String(row.idempotency_key),
    occurredAt: String(row.occurred_at),
    outcome: String(row.outcome) as TaskControlObservation['outcome'],
    payloadHash: String(row.payload_hash),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
  };
}

function approvalConsumptionFromRow(row: Record<string, unknown>): ApprovalConsumption {
  return {
    approvalRef: String(row.approval_ref),
    projectId: String(row.project_id),
    phaseId: String(row.phase_id),
    taskSetHash: String(row.task_set_hash),
    acceptorId: String(row.acceptor_id),
    freezeIdempotencyKey: String(row.freeze_idempotency_key),
    frozenEventId: String(row.frozen_event_id),
    approvedAt: String(row.approved_at),
    consumedAt: String(row.consumed_at),
  };
}

function outboxFromRow(row: Record<string, unknown>): DeliveryOutboxRow {
  return {
    outboxId: String(row.outbox_id),
    eventId: String(row.event_id),
    destinationId: String(row.destination_id),
    status: String(row.status) as DeliveryOutboxStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    ...(row.claim_token ? { claimToken: String(row.claim_token) } : {}),
    ...(row.claimed_at !== null && row.claimed_at !== undefined ? { claimedAt: Number(row.claimed_at) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    ...(row.fallback_event_id ? { fallbackEventId: String(row.fallback_event_id) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function receiptFromRow(row: Record<string, unknown>): DeliveryReceipt {
  return {
    receiptId: String(row.receipt_id),
    outboxId: String(row.outbox_id),
    eventId: String(row.event_id),
    destinationId: String(row.destination_id),
    attempt: Number(row.attempt),
    state: String(row.state) as DeliveryReceiptState,
    ...(row.receipt_ref ? { receiptRef: String(row.receipt_ref) } : {}),
    ...(row.error ? { error: String(row.error) } : {}),
    ...(row.fallback_event_id ? { fallbackEventId: String(row.fallback_event_id) } : {}),
    createdAt: String(row.created_at),
  };
}

function reduceUnknowns(events: readonly TaskControlEvent[]): UnknownProjection[] {
  const values = new Map<string, UnknownProjection>();
  for (const event of events) {
    if (!event.eventType.startsWith('unknown.')) continue;
    const key = optionalString(event.payload.unknownKey);
    if (!key) continue;
    const prior = values.get(key) ?? { key, required: false, declared: false, resolved: false };
    if (event.eventType === 'unknown.required') prior.required = true;
    if (event.eventType === 'unknown.declared') {
      prior.declared = true;
      prior.resolved = false;
      prior.declarationEventId = event.eventId;
      delete prior.resolutionEventId;
    }
    if (event.eventType === 'unknown.resolved') {
      prior.resolved = true;
      prior.resolutionEventId = event.eventId;
    }
    values.set(key, prior);
  }
  return [...values.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function unresolvedConflicts(events: readonly TaskControlEvent[]): string[] {
  const conflicts = new Set<string>();
  for (const event of events) {
    if (event.eventType === 'event.conflict_detected') conflicts.add(event.eventId);
    if (event.eventType === 'event.conflict_resolved') {
      const conflictEventId = optionalString(event.payload.conflictEventId);
      if (conflictEventId) conflicts.delete(conflictEventId);
    }
  }
  return [...conflicts];
}

function reduceTask(events: readonly TaskControlEvent[]): TaskReduction {
  let lifecycleState: TaskControlTaskState = 'planned';
  let mapping: TaskIdentityMapping | undefined;
  let explicitlyAccepted = false;
  let acceptedEventId: string | undefined;
  let acceptedActorId: string | undefined;
  let terminalBody: TerminalBodyProjection | undefined;
  let independentReview: ReviewProjection | undefined;
  let doneEvent: { eventId: string; seq: number } | undefined;
  const unresolvedReviewConditions = new Set<string>();
  const transitionViolations: TaskProjection['transitionViolations'] = [];

  for (const event of events) {
    if (!taskTransitionAllowed(event.eventType, lifecycleState)) {
      transitionViolations.push({ eventId: event.eventId, eventType: event.eventType, stateBefore: lifecycleState });
    }
    switch (event.eventType) {
      case 'mapping.registered':
        mapping = {
          projectId: event.projectId, phaseId: event.phaseId, taskGuid: event.taskGuid!,
          topicRootId: event.topicRootId!, ownerId: nonEmpty(event.payload.ownerId, 'payload.ownerId'),
          eventId: event.eventId, seq: event.seq,
        };
        break;
      case 'task.accepted':
        explicitlyAccepted = true; acceptedEventId = event.eventId; acceptedActorId = event.actorId; break;
      case 'task.reviewed':
      case 'task.review_corrected': {
        const verdict = parseReviewVerdict(event.payload.verdict);
        if (event.payload.independent === true) {
          const conditionIds = event.payload.conditionIds === undefined
            ? []
            : exactTaskSetSnapshot(event.payload.conditionIds, 'payload.conditionIds');
          independentReview = {
            eventId: event.eventId, seq: event.seq,
            reviewRound: positiveInteger(event.payload.reviewRound, 'payload.reviewRound'),
            reviewCommentId: nonEmpty(event.payload.reviewCommentId, 'payload.reviewCommentId'),
            reviewerId: event.actorId, independent: true, verdict,
            conditionIds,
            resolvedConditionEvidence: conditionEvidenceRefs(event.payload.resolvedConditionEvidence),
            ...(optionalString(event.payload.reviewerVerdictId) ? { reviewerVerdictId: optionalString(event.payload.reviewerVerdictId)! } : {}),
            ...(optionalString(event.payload.docToken) ? { docToken: optionalString(event.payload.docToken)! } : {}),
            ...(typeof event.payload.docRevision === 'number' ? { docRevision: event.payload.docRevision } : {}),
          };
          if (verdict === 'conditional') {
            for (const conditionId of conditionIds) unresolvedReviewConditions.add(conditionId);
          }
          for (const conditionId of Object.keys(independentReview.resolvedConditionEvidence)) {
            unresolvedReviewConditions.delete(conditionId);
          }
        }
        break;
      }
      case 'task.delivered':
        if (event.terminal) {
          terminalBody = {
            eventId: event.eventId, seq: event.seq,
            docToken: nonEmpty(event.payload.docToken, 'payload.docToken'),
            docRevision: positiveInteger(event.payload.docRevision, 'payload.docRevision'),
          };
        }
        break;
      case 'task.done_marked':
        doneEvent = { eventId: event.eventId, seq: event.seq };
        break;
      default: break;
    }
    lifecycleState = taskStateAfter(event.eventType, event.payload, lifecycleState);
  }
  const conflicts = unresolvedConflicts(events);
  return {
    lifecycleState,
    projection: {
      taskGuid: events.find(event => !!event.taskGuid)?.taskGuid ?? '',
      ...(mapping ? { mapping } : {}),
      state: conflicts.length > 0 || transitionViolations.length > 0 ? 'blocked' : lifecycleState,
      explicitlyAccepted,
      ...(acceptedEventId ? { acceptedEventId } : {}),
      ...(acceptedActorId ? { acceptedActorId } : {}),
      ...(terminalBody ? { terminalBody } : {}),
      ...(independentReview ? { independentReview } : {}),
      unresolvedReviewConditionIds: [...unresolvedReviewConditions].sort(),
      ...(doneEvent ? { doneEvent } : {}),
      unknowns: reduceUnknowns(events),
      unresolvedConflictEventIds: conflicts,
      transitionViolations,
    },
  };
}

function reducePhase(events: readonly TaskControlEvent[]): PhaseReduction {
  let lifecycleState: TaskControlPhaseState = 'planned';
  let expectedTaskGuids: string[] = [];
  let designatedAcceptorId: string | undefined;
  let latestFreezeRequest: PhaseReduction['latestFreezeRequest'];
  const transitionViolations: PhaseProjection['transitionViolations'] = [];
  for (const event of events) {
    if (!phaseTransitionAllowed(event.eventType, lifecycleState)) {
      transitionViolations.push({ eventId: event.eventId, eventType: event.eventType, stateBefore: lifecycleState });
    }
    switch (event.eventType) {
      case 'phase.opened':
        expectedTaskGuids = uniqueStrings(event.payload.taskGuids, 'payload.taskGuids');
        designatedAcceptorId = nonEmpty(event.payload.designatedAcceptorId, 'payload.designatedAcceptorId');
        break;
      case 'phase.freeze_requested':
        latestFreezeRequest = {
          eventId: event.eventId,
          taskGuids: uniqueStrings(event.payload.taskGuids, 'payload.taskGuids'),
          openIssueCodes: uniqueStrings(event.payload.openIssueCodes, 'payload.openIssueCodes'),
          requestRef: controlledEvidenceRef(event.payload.requestRef, 'payload.requestRef'),
        };
        break;
      default: break;
    }
    lifecycleState = phaseStateAfter(event.eventType, lifecycleState);
  }
  const conflicts = unresolvedConflicts(events);
  return {
    lifecycleState,
    state: lifecycleState === 'frozen'
      ? 'frozen'
      : conflicts.length > 0 || transitionViolations.length > 0 ? 'blocked' : lifecycleState,
    expectedTaskGuids,
    ...(designatedAcceptorId ? { designatedAcceptorId } : {}),
    ...(latestFreezeRequest ? { latestFreezeRequest } : {}),
    unknowns: reduceUnknowns(events),
    unresolvedConflictEventIds: conflicts,
    transitionViolations,
  };
}

function taskStateAfter(type: TaskControlEventType, payload: Record<string, unknown>, current: TaskControlTaskState): TaskControlTaskState {
  const target = TASK_TRANSITIONS[type]?.to;
  if (!target) return current;
  return typeof target === 'function' ? target(payload, current) : target;
}

function phaseStateAfter(type: TaskControlEventType, current: TaskControlPhaseState): TaskControlPhaseState {
  // Late conflict evidence is append-only audit material. It must not reopen
  // or overwrite a terminal frozen projection.
  if (current === 'frozen' && type === 'event.conflict_detected') return 'frozen';
  return PHASE_TRANSITIONS[type]?.to ?? current;
}

function taskTransitionAllowed(type: TaskControlEventType, current: TaskControlTaskState): boolean {
  const rule = TASK_TRANSITIONS[type];
  return !rule || rule.from.includes(current);
}

function phaseTransitionAllowed(type: TaskControlEventType, current: TaskControlPhaseState): boolean {
  const rule = PHASE_TRANSITIONS[type];
  return !rule || rule.from.includes(current);
}

export class TaskControlPlaneStore {
  readonly path: string;
  private constructor(
    private readonly db: DatabaseSyncLike,
    path: string,
    private readonly readOnly: boolean,
    private readonly authority?: TaskControlAuthority,
    private readonly larkAppId: string = 'test:unscoped',
  ) {
    this.path = path;
  }
  private reviewerVerifier?: {
    verifyDesignatedReviewer(value: DesignatedReviewerMapping): boolean;
    verifyVerdict(value: ReviewerVerdictV1): boolean;
  };

  setReviewerVerdictVerifier(verifier: {
    verifyDesignatedReviewer(value: DesignatedReviewerMapping): boolean;
    verifyVerdict(value: ReviewerVerdictV1): boolean;
  } | undefined): void {
    this.reviewerVerifier = verifier;
  }

  static async open(dataDir: string, authority: TaskControlAuthority, larkAppId = 'test:unscoped'): Promise<TaskControlPlaneStore> {
    if (!authority || typeof authority.authenticate !== 'function' || typeof authority.verifyApproval !== 'function') {
      throw new Error('task_control_authority_required');
    }
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, DATABASE_NAME);
    const db = await openDatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout=5000;');
      db.exec('PRAGMA foreign_keys=ON;');
      let mode = '';
      for (let attempt = 1; attempt <= 10; attempt++) {
        try {
          mode = String((db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode?: unknown } | undefined)?.journal_mode ?? '').toLowerCase();
          if (mode === 'wal') break;
        } catch (error) {
          if (!isBusy(error) || attempt === 10) throw error;
        }
        sleepShort(attempt);
      }
      if (mode !== 'wal') throw new Error(`task_control_wal_mode_not_set:${mode || 'unknown'}`);
      db.exec('PRAGMA synchronous=FULL;');
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
      if (version > SCHEMA_VERSION) throw new Error(`task_control_schema_newer:${version}`);
      if (version < SCHEMA_VERSION) {
        for (let attempt = 1; attempt <= 10; attempt++) {
          try {
            db.exec('BEGIN IMMEDIATE;');
            const lockedVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
            if (lockedVersion < SCHEMA_VERSION) {
              // v4 lacks lark_app_id, so creating v9's app-scoped indexes
              // first fails before the compatibility columns exist. Later
              // versions already carry the column but may lack tables added by
              // a newer schema, so retain the established schema-first path.
              if (lockedVersion > 0 && lockedVersion < 5) {
                migrateSchema(db, lockedVersion);
                db.exec(SCHEMA);
              } else {
                db.exec(SCHEMA);
                migrateSchema(db, lockedVersion);
              }
              db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
            } else if (lockedVersion > SCHEMA_VERSION) {
              throw new Error(`task_control_schema_newer:${lockedVersion}`);
            }
            db.exec('COMMIT;');
            break;
          } catch (error) {
            try { db.exec('ROLLBACK;'); } catch { /* no active transaction */ }
            if (isBusy(error) && attempt < 10) { sleepShort(attempt); continue; }
            throw error;
          }
        }
      }
      return new TaskControlPlaneStore(db, path, false, authority, nonEmpty(larkAppId, 'larkAppId'));
    } catch (error) { db.close(); throw error; }
  }

  static async openReadOnly(dataDir: string, larkAppId = 'test:unscoped'): Promise<TaskControlPlaneStore> {
    const path = join(dataDir, DATABASE_NAME);
    const db = await openDatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=5000;');
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
      if (version !== SCHEMA_VERSION) throw new Error(`task_control_schema_unsupported:${version}`);
      return new TaskControlPlaneStore(db, path, true, undefined, nonEmpty(larkAppId, 'larkAppId'));
    } catch (error) { db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  /** Encodes one opaque provider receipt for exactly one control event/outbox destination. */
  static providerReceiptRef(eventId: string, destinationId: string, providerReceiptId: string): string {
    return receiptRefForEventDestination(eventId, destinationId, providerReceiptId);
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error('task_control_read_only');
  }

  private authenticate(authentication: unknown): AuthenticatedTaskControlPrincipal {
    const principal = this.authority?.authenticate(authentication);
    if (!principal) throw new Error('task_control_authentication_failed');
    nonEmpty(principal.actorId, 'authenticated.actorId');
    if (!['controller', 'worker', 'reviewer', 'collector', 'acceptor'].includes(principal.actorRole)) {
      throw new Error('task_control_invalid:authenticated.actorRole');
    }
    return principal;
  }

  private withImmediateWrite<T>(fn: () => T): T {
    this.assertWritable();
    for (let attempt = 1; ; attempt++) {
      try { this.db.exec('BEGIN IMMEDIATE;'); }
      catch (error) {
        if (isBusy(error) && attempt < 8) { sleepShort(attempt); continue; }
        throw error;
      }
      try {
        const result = fn();
        this.db.exec('COMMIT;');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK;'); } catch { /* already unwound */ }
        throw error;
      }
    }
  }

  listEvents(filter: { projectId?: string; phaseId?: string; taskGuid?: string } = {}): TaskControlEvent[] {
    return (this.db.prepare('SELECT * FROM control_events WHERE lark_app_id=? ORDER BY seq').all(this.larkAppId) as unknown as EventRow[])
      .map(rowToEvent)
      .filter(event => (!filter.projectId || event.projectId === filter.projectId)
        && (!filter.phaseId || event.phaseId === filter.phaseId)
        && (!filter.taskGuid || event.taskGuid === filter.taskGuid));
  }

  listObservations(): TaskControlObservation[] {
    return (this.db.prepare('SELECT * FROM control_observations WHERE lark_app_id=? ORDER BY seq').all(this.larkAppId) as Record<string, unknown>[])
      .map(rowToObservation);
  }

  listTrustedMappings(): TrustedTaskControlMappingRecord[] {
    return (this.db.prepare('SELECT * FROM control_trusted_mappings WHERE lark_app_id=? ORDER BY created_at,dispatch_root').all(this.larkAppId) as Record<string, unknown>[])
      .map(row => ({
        larkAppId: String(row.lark_app_id), dispatchRoot: String(row.dispatch_root), projectId: String(row.project_id), phaseId: String(row.phase_id),
        phaseTaskGuids: exactTaskSetSnapshot(JSON.parse(String(row.phase_task_guids_json)), 'phaseTaskGuids'),
        taskGuid: String(row.task_guid), topicRootId: String(row.topic_root_id), ownerId: String(row.owner_id),
        reviewerId: String(row.reviewer_id), acceptorId: String(row.acceptor_id), registrationRef: String(row.registration_ref),
        ...(row.registration_version ? { registrationVersion: String(row.registration_version) } : {}),
        ...(row.phase_registration_refs_json ? { phaseRegistrationRefs: JSON.parse(String(row.phase_registration_refs_json)) as Record<string, string> } : {}),
        controllerId: String(row.controller_id), approvalGate: parseApprovalGate(JSON.parse(String(row.approval_gate_json))),
        ...(row.doc_token ? { docToken: String(row.doc_token) } : {}),
        ...(row.doc_revision !== null && row.doc_revision !== undefined ? { docRevision: Number(row.doc_revision) } : {}),
        ...(row.mapping_proof_json ? { mappingProof: JSON.parse(String(row.mapping_proof_json)) } : {}),
        createdAt: String(row.created_at),
      }));
  }

  appendDesignatedReviewer(mapping: DesignatedReviewerMapping, authentication: unknown, verify: (value: DesignatedReviewerMapping) => boolean): void {
    this.assertWritable();
    const principal = this.authenticate(authentication);
    if (principal.actorRole !== 'controller' || principal.actorId !== mapping.controllerId
      || mapping.controllerBotAppId !== this.larkAppId || !verify(mapping)) {
      throw new Error('task_control_designated_reviewer_unauthorized');
    }
    const snapshot = exactTaskSetSnapshot(mapping.taskSetSnapshot, 'designatedReviewer.taskSetSnapshot');
    if (!snapshot.includes(mapping.taskGuid) || mapping.reviewRound < 1
      || timestampMs(mapping.expiresAt, 'designatedReviewer.expiresAt') <= timestampMs(mapping.effectiveAt, 'designatedReviewer.effectiveAt')) {
      throw new Error('task_control_designated_reviewer_invalid');
    }
    this.withImmediateWrite(() => {
      const existing = this.db.prepare('SELECT * FROM control_designated_reviewers WHERE lark_app_id=? AND designated_reviewer_ref=?')
        .get(this.larkAppId, mapping.designatedReviewerRef) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.signature) === mapping.signature && String(existing.key_id) === (mapping.keyId ?? '')) return;
        throw new Error(`task_control_designated_reviewer_conflict:${mapping.designatedReviewerRef}`);
      }
      if (mapping.supersedesDesignatedReviewerRef) {
        const prior = this.db.prepare('SELECT * FROM control_designated_reviewers WHERE designated_reviewer_ref=? AND lark_app_id=?')
          .get(mapping.supersedesDesignatedReviewerRef, this.larkAppId) as Record<string, unknown> | undefined;
        if (!prior
          || String(prior.project_id) !== mapping.projectId
          || String(prior.phase_id) !== mapping.phaseId
          || String(prior.task_guid) !== mapping.taskGuid
          || String(prior.topic_root_id) !== mapping.topicRootId
          || Number(prior.review_round) !== mapping.reviewRound
          || JSON.stringify(exactTaskSetSnapshot(JSON.parse(String(prior.task_set_json)), 'prior.taskSetSnapshot')) !== JSON.stringify(snapshot)) {
          throw new Error('task_control_designated_reviewer_supersedes_invalid');
        }
      }
      this.db.prepare(`INSERT INTO control_designated_reviewers(
        designated_reviewer_ref,lark_app_id,project_id,phase_id,task_guid,topic_root_id,task_set_json,review_round,reviewer_id,reviewer_bot_app_id,controller_id,controller_bot_app_id,effective_at,expires_at,issued_at,key_id,signature,supersedes_ref
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        mapping.designatedReviewerRef, this.larkAppId, mapping.projectId, mapping.phaseId, mapping.taskGuid, mapping.topicRootId, JSON.stringify(snapshot), mapping.reviewRound,
        mapping.reviewerId, mapping.reviewerBotAppId, mapping.controllerId, mapping.controllerBotAppId, mapping.effectiveAt, mapping.expiresAt, mapping.issuedAt, mapping.keyId ?? '', mapping.signature, mapping.supersedesDesignatedReviewerRef ?? null,
      );
    });
  }

  appendReviewerVerdict(input: {
    verdict: ReviewerVerdictV1;
    attestation: ReviewerVerdictAttestation;
    authentication: unknown;
    verifyVerdict: (value: ReviewerVerdictV1) => boolean;
    now?: string;
  }): ReviewerVerdictHead {
    this.assertWritable();
    const verdict = input.verdict;
    const now = input.now ?? new Date().toISOString();
    const snapshot = exactTaskSetSnapshot(verdict.taskSetSnapshot, 'reviewerVerdict.taskSetSnapshot');
    let principal: AuthenticatedTaskControlPrincipal;
    try { principal = this.authenticate(input.authentication); }
    catch { return { status: 'unknown', reason: 'reviewer_verdict_authentication_unproven' }; }
    if (principal.actorRole !== 'reviewer' || principal.actorId !== verdict.reviewerId
      || !input.verifyVerdict(verdict) || verdict.reviewerId !== input.attestation.reviewerId
      || verdict.reviewerBotAppId !== input.attestation.reviewerBotAppId
      || verdict.sessionId !== input.attestation.sessionId
      || verdict.workerGeneration !== input.attestation.workerGeneration
      || verdict.capabilityHash !== (input.attestation.capabilityHash
        ?? (input.attestation.capability ? reviewerCapabilityHash(input.attestation.capability) : ''))
      || timestampMs(verdict.expiresAt, 'reviewerVerdict.expiresAt') <= timestampMs(now, 'reviewerVerdict.now')
      || snapshot.length === 0 || !snapshot.includes(verdict.taskGuid)
      || verdict.reviewRound < 1
      || (!verdict.sourceCommentId && !verdict.sourceMessageId)
      || (!!verdict.revokesVerdictId && !!verdict.supersedesVerdictId)) {
      return { status: 'unknown', reason: 'reviewer_verdict_unverified' };
    }
    return this.withImmediateWrite(() => {
      const designated = this.recomputeDesignatedReviewerHead(verdict.projectId, verdict.phaseId, verdict.taskGuid, verdict.topicRootId, snapshot, verdict.reviewRound, now);
      if (!designated || designated.designatedReviewerRef !== verdict.designatedReviewerRef
        || designated.reviewerId !== verdict.reviewerId
        || designated.reviewerBotAppId !== verdict.reviewerBotAppId) return { status: 'unknown', reason: 'designated_reviewer_mapping_unproven' };
      const hash = reviewerVerdictPayloadHash(verdict);
      const existing = this.db.prepare('SELECT * FROM control_reviewer_verdicts WHERE lark_app_id=? AND verdict_id=?')
        .get(this.larkAppId, verdict.verdictId) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.canonical_hash) !== hash) {
          const prior = JSON.parse(String(existing.canonical_json)) as ReviewerVerdictV1;
          this.appendReviewerVerdictConflictObservationLocked({
            verdictId: verdict.verdictId, existingCanonicalHash: String(existing.canonical_hash), incomingCanonicalHash: hash,
            existingSourceRef: this.reviewerVerdictSourceRef(prior), incomingSourceRef: this.reviewerVerdictSourceRef(verdict),
          });
          return { status: 'unknown', reason: 'reviewer_verdict_id_conflict' };
        }
        return this.recomputeReviewerVerdictHead(verdict.projectId, verdict.phaseId, verdict.taskGuid, verdict.topicRootId, snapshot, verdict.reviewRound, now);
      }
      if (verdict.kind === 'verdict' && !verdict.verdict) return { status: 'unknown', reason: 'reviewer_verdict_missing_verdict' };
      if (verdict.kind === 'revocation' && (!verdict.revokesVerdictId || verdict.verdict !== undefined || verdict.supersedesVerdictId)) {
        return { status: 'unknown', reason: 'reviewer_verdict_invalid_revocation' };
      }
      this.db.prepare(`INSERT INTO control_reviewer_verdicts(
        verdict_id,lark_app_id,project_id,phase_id,task_guid,task_set_json,review_round,canonical_hash,canonical_json,issued_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        verdict.verdictId, this.larkAppId, verdict.projectId, verdict.phaseId, verdict.taskGuid, JSON.stringify(snapshot), verdict.reviewRound, hash, JSON.stringify(verdict), verdict.issuedAt,
      );
      return this.recomputeReviewerVerdictHead(verdict.projectId, verdict.phaseId, verdict.taskGuid, verdict.topicRootId, snapshot, verdict.reviewRound, now);
    });
  }

  getReviewerVerdictHead(projectId: string, phaseId: string, taskGuid: string, topicRootId: string, taskSetSnapshot: readonly string[], reviewRound: number, now = new Date().toISOString()): ReviewerVerdictHead {
    return this.recomputeReviewerVerdictHead(projectId, phaseId, taskGuid, topicRootId, exactTaskSetSnapshot(taskSetSnapshot, 'reviewerVerdict.taskSetSnapshot'), reviewRound, now);
  }

  /**
   * Route-only lookup for the current verified designation. It intentionally
   * recomputes the historical chain every time, so expiry, supersession, forks
   * and a missing verifier all stay fail-closed before an ingress selects a
   * reviewer-app verifier.
   */
  getCurrentDesignatedReviewer(input: {
    projectId: string; phaseId: string; taskGuid: string; topicRootId: string; taskSetSnapshot: readonly string[]; reviewRound: number; now?: string;
  }): DesignatedReviewerMapping | undefined {
    try {
      return this.recomputeDesignatedReviewerHead(
        input.projectId, input.phaseId, input.taskGuid, input.topicRootId,
        exactTaskSetSnapshot(input.taskSetSnapshot, 'designatedReviewer.taskSetSnapshot'),
        input.reviewRound, input.now ?? new Date().toISOString(),
      );
    } catch { return undefined; }
  }

  private reviewerVerdictHeadById(verdictId: string, now: string): ReviewerVerdictHead {
    const raw = this.db.prepare('SELECT canonical_json FROM control_reviewer_verdicts WHERE verdict_id=? AND lark_app_id=?')
      .get(verdictId, this.larkAppId) as Record<string, unknown> | undefined;
    if (!raw) return { status: 'unknown', reason: 'reviewer_verdict_missing' };
    try {
      const verdict = JSON.parse(String(raw.canonical_json)) as ReviewerVerdictV1;
      const head = this.recomputeReviewerVerdictHead(
        verdict.projectId, verdict.phaseId, verdict.taskGuid, verdict.topicRootId,
        exactTaskSetSnapshot(verdict.taskSetSnapshot, 'reviewerVerdict.taskSetSnapshot'), verdict.reviewRound, now,
      );
      return head.status === 'active' && head.verdict?.verdictId === verdictId
        ? head
        : { status: 'unknown', reason: `reviewer_verdict_not_active:${head.status}` };
    } catch { return { status: 'unknown', reason: 'reviewer_verdict_malformed' }; }
  }

  private recomputeDesignatedReviewerHead(projectId: string, phaseId: string, taskGuid: string, topicRootId: string, taskSetSnapshot: readonly string[], reviewRound: number, now: string): DesignatedReviewerMapping | undefined {
    const rows = this.db.prepare(`SELECT * FROM control_designated_reviewers
      WHERE lark_app_id=? AND project_id=? AND phase_id=? AND task_guid=? AND topic_root_id=? AND review_round=?`)
      .all(this.larkAppId, projectId, phaseId, taskGuid, topicRootId, reviewRound) as Record<string, unknown>[];
    if (!this.reviewerVerifier) return undefined;
    const mappings = rows.map(row => ({
      schemaVersion: 'DesignatedReviewer.v1' as const, designatedReviewerRef: String(row.designated_reviewer_ref),
      projectId: String(row.project_id), phaseId: String(row.phase_id), taskGuid: String(row.task_guid), topicRootId: String(row.topic_root_id ?? ''),
      taskSetSnapshot: exactTaskSetSnapshot(JSON.parse(String(row.task_set_json)), 'mapping.taskSetSnapshot'), reviewRound: Number(row.review_round),
      reviewerId: String(row.reviewer_id), reviewerBotAppId: String(row.reviewer_bot_app_id), controllerId: String(row.controller_id), controllerBotAppId: String(row.controller_bot_app_id),
      effectiveAt: String(row.effective_at), expiresAt: String(row.expires_at), issuedAt: String(row.issued_at),
      keyId: String(row.key_id), signature: String(row.signature),
      ...(row.supersedes_ref ? { supersedesDesignatedReviewerRef: String(row.supersedes_ref) } : {}),
    })).filter(mapping => JSON.stringify(mapping.taskSetSnapshot) === JSON.stringify(taskSetSnapshot)
      && this.reviewerVerifier!.verifyDesignatedReviewer(mapping));
    if (mappings.length === 0) return undefined;
    const byRef = new Map(mappings.map(mapping => [mapping.designatedReviewerRef, mapping]));
    const superseded = new Set<string>();
    for (const mapping of mappings) {
      if (!mapping.supersedesDesignatedReviewerRef) continue;
      if (!byRef.has(mapping.supersedesDesignatedReviewerRef)) return undefined;
      superseded.add(mapping.supersedesDesignatedReviewerRef);
    }
    const heads = mappings.filter(mapping => !superseded.has(mapping.designatedReviewerRef));
    if (heads.length !== 1) return undefined;
    const head = heads[0]!;
    // Supersession is historical: a new head permanently retires the old one.
    // Apply its temporal validity only after the chain is resolved so an expired
    // successor cannot make its superseded predecessor appear current again.
    return timestampMs(head.effectiveAt, 'designatedReviewer.effectiveAt') <= timestampMs(now, 'designatedReviewer.now')
      && timestampMs(head.expiresAt, 'designatedReviewer.expiresAt') > timestampMs(now, 'designatedReviewer.now')
      ? head
      : undefined;
  }

  private recomputeReviewerVerdictHead(projectId: string, phaseId: string, taskGuid: string, topicRootId: string, taskSetSnapshot: readonly string[], reviewRound: number, now: string): ReviewerVerdictHead {
    const rows = this.db.prepare(`SELECT canonical_json FROM control_reviewer_verdicts
      WHERE lark_app_id=? AND project_id=? AND phase_id=? AND task_guid=? AND review_round=? ORDER BY issued_at,verdict_id`)
      .all(this.larkAppId, projectId, phaseId, taskGuid, reviewRound) as Record<string, unknown>[];
    if (!this.reviewerVerifier) return { status: 'unknown', reason: 'reviewer_verdict_verifier_missing' };
    const records = rows.map(row => JSON.parse(String(row.canonical_json)) as ReviewerVerdictV1)
      .filter(record => record.topicRootId === topicRootId
        && JSON.stringify(exactTaskSetSnapshot(record.taskSetSnapshot, 'reviewerVerdict.taskSetSnapshot')) === JSON.stringify(taskSetSnapshot)
        && this.reviewerVerifier!.verifyVerdict(record));
    if (records.length === 0) return { status: 'unknown', reason: 'reviewer_verdict_missing' };
    const byId = new Map(records.map(record => [record.verdictId, record]));
    const children = new Map<string, ReviewerVerdictV1[]>();
    for (const record of records) {
      const target = record.revokesVerdictId ?? record.supersedesVerdictId;
      if (!target) continue;
      if (!byId.has(target) || target === record.verdictId) return { status: 'unknown', reason: 'reviewer_verdict_target_missing_or_cycle' };
      const list = children.get(target) ?? []; list.push(record); children.set(target, list);
    }
    for (const [id, list] of children) if (list.length > 1) return { status: 'unknown', reason: `reviewer_verdict_fork:${id}` };
    for (const record of records) {
      const seen = new Set<string>();
      let cursor: ReviewerVerdictV1 | undefined = record;
      while (cursor) {
        if (seen.has(cursor.verdictId)) return { status: 'unknown', reason: 'reviewer_verdict_cycle' };
        seen.add(cursor.verdictId);
        const target: string | undefined = cursor.revokesVerdictId ?? cursor.supersedesVerdictId;
        cursor = target ? byId.get(target) : undefined;
      }
    }
    const superseded = new Set(records.filter(record => !!record.supersedesVerdictId).map(record => record.supersedesVerdictId!));
    const revoked = new Set(records.filter(record => !!record.revokesVerdictId).map(record => record.revokesVerdictId!));
    const heads = records.filter(record => !children.has(record.verdictId));
    if (heads.length !== 1) return { status: 'unknown', reason: 'reviewer_verdict_head_ambiguous' };
    const head = heads[0]!;
    if (timestampMs(head.expiresAt, 'reviewerVerdict.expiresAt') <= timestampMs(now, 'reviewerVerdict.now')) return { status: 'unknown', reason: 'reviewer_verdict_expired' };
    if (head.kind === 'revocation' || revoked.has(head.verdictId)) return { status: 'revoked', verdict: head };
    if (superseded.has(head.verdictId)) return { status: 'superseded', verdict: head };
    return { status: 'active', verdict: head };
  }

  private verifiedReviewerVerdictForReview(task: TaskProjection, review: ReviewProjection, now: string): boolean {
    if (!review.reviewerVerdictId || !task.mapping) return false;
    const head = this.reviewerVerdictHeadById(review.reviewerVerdictId, now);
    const verdict = head.status === 'active' ? head.verdict : undefined;
    const designated = verdict
      ? this.recomputeDesignatedReviewerHead(
        verdict.projectId, verdict.phaseId, verdict.taskGuid, verdict.topicRootId,
        exactTaskSetSnapshot(verdict.taskSetSnapshot, 'reviewerVerdict.taskSetSnapshot'), verdict.reviewRound, now,
      )
      : undefined;
    return !!verdict
      && head.verdict?.verdictId === review.reviewerVerdictId
      && designated?.designatedReviewerRef === verdict.designatedReviewerRef
      && designated.reviewerId === verdict.reviewerId
      && designated.reviewerBotAppId === verdict.reviewerBotAppId
      && verdict.projectId === task.mapping.projectId
      && verdict.phaseId === task.mapping.phaseId
      && verdict.taskGuid === task.taskGuid
      && verdict.topicRootId === task.mapping.topicRootId
      && verdict.reviewerId === review.reviewerId
      && verdict.reviewRound === review.reviewRound
      && verdict.verdict === review.verdict
      && verdict.docToken === review.docToken
      && verdict.docRevision === review.docRevision
      && JSON.stringify([...verdict.conditionIds].sort()) === JSON.stringify([...review.conditionIds].sort())
      && JSON.stringify(verdict.resolvedConditionEvidence) === JSON.stringify(review.resolvedConditionEvidence);
  }

  private reviewerVerdictSourceRef(verdict: ReviewerVerdictV1): string {
    return verdict.sourceCommentId
      ? `task-comment:${verdict.sourceCommentId}`
      : `topic-message:${verdict.sourceMessageId}`;
  }

  private hasReviewerVerdictConflict(verdictId: string): boolean {
    const rows = this.db.prepare(`SELECT payload_json FROM control_observations
      WHERE lark_app_id=? AND attempted_event_type='task.reviewed' AND outcome='conflict'`)
      .all(this.larkAppId) as Array<{ payload_json?: unknown }> ;
    return rows.some(row => {
      try {
        const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        return payload.conflictKind === 'reviewer_verdict_id_canonical_hash' && payload.verdictId === verdictId;
      } catch { return true; }
    });
  }

  /**
   * A duplicate verdict id with a different canonical payload is not a normal
   * UNKNOWN boundary: it is immutable contradictory evidence. Keep the
   * original and incoming references/hashes together, and replay the same
   * collision idempotently without ever changing the first verdict row.
   */
  private appendReviewerVerdictConflictObservationLocked(input: {
    verdictId: string; existingCanonicalHash: string; incomingCanonicalHash: string; existingSourceRef: string; incomingSourceRef: string;
  }): void {
    const sourceRef = input.incomingSourceRef;
    const idempotencyKey = `reviewer-verdict-conflict:${this.larkAppId}:${input.verdictId}:${input.incomingCanonicalHash}`;
    const existing = this.db.prepare('SELECT event_id FROM control_observations WHERE idempotency_key=? AND lark_app_id=?')
      .get(idempotencyKey, this.larkAppId) as { event_id?: unknown } | undefined;
    if (existing) return;
    const payload = {
      conflictKind: 'reviewer_verdict_id_canonical_hash', verdictId: input.verdictId,
      existingCanonicalHash: input.existingCanonicalHash, incomingCanonicalHash: input.incomingCanonicalHash,
      existingSourceRef: input.existingSourceRef, incomingSourceRef: input.incomingSourceRef,
    };
    const eventId = stableId('obs_reviewer_verdict_conflict', this.larkAppId, input.verdictId, input.incomingCanonicalHash);
    this.db.prepare(`INSERT INTO control_observations(
      event_id,lark_app_id,attempted_event_type,source_ref,idempotency_key,occurred_at,outcome,payload_hash,payload_json
    ) VALUES(?,?,?,?,?,?,'conflict',?,?)`).run(
      eventId, this.larkAppId, 'task.reviewed', sourceRef, idempotencyKey, new Date().toISOString(),
      payloadHash({ attemptedEventType: 'task.reviewed', sourceRef, payload }), JSON.stringify(payload),
    );
  }

  private refreshReviewerVerdictProjection(task: TaskProjection, checkedAt: string): TaskProjection {
    const review = task.independentReview;
    if (!review) return task;
    if (review.reviewerVerdictId && this.hasReviewerVerdictConflict(review.reviewerVerdictId)) {
      return { ...task, independentReview: undefined, reviewerVerdictIssue: 'reviewer verdict canonical-hash conflict is unresolved' };
    }
    if (!this.verifiedReviewerVerdictForReview(task, review, checkedAt)) {
      return { ...task, independentReview: undefined, reviewerVerdictIssue: 'independent review lacks an active exact ReviewerVerdict' };
    }
    return task;
  }

  private assertReviewedVerdictCurrentLocked(input: AuthenticatedAppendTaskControlEventInput): void {
    const taskGuid = input.taskGuid!;
    const mapping = this.mappingForTask(taskGuid);
    if (!mapping || mapping.projectId !== input.projectId || mapping.phaseId !== input.phaseId || mapping.topicRootId !== input.topicRootId) {
      throw new Error('task_control_reviewer_verdict_mapping_unproven');
    }
    const payload = input.payload ?? {};
    const review: ReviewProjection = {
      eventId: input.eventId, seq: 0, reviewRound: positiveInteger(payload.reviewRound, 'payload.reviewRound'),
      reviewCommentId: nonEmpty(payload.reviewCommentId, 'payload.reviewCommentId'), reviewerId: input.actorId,
      independent: payload.independent === true, verdict: parseReviewVerdict(payload.verdict),
      conditionIds: payload.conditionIds === undefined ? [] : exactTaskSetSnapshot(payload.conditionIds, 'payload.conditionIds'),
      resolvedConditionEvidence: conditionEvidenceRefs(payload.resolvedConditionEvidence),
      reviewerVerdictId: nonEmpty(payload.reviewerVerdictId, 'payload.reviewerVerdictId'),
      ...(optionalString(payload.docToken) ? { docToken: optionalString(payload.docToken)! } : {}),
      ...(typeof payload.docRevision === 'number' ? { docRevision: payload.docRevision } : {}),
    };
    const task: TaskProjection = {
      taskGuid, mapping, state: 'submitted', explicitlyAccepted: true, unresolvedReviewConditionIds: [],
      unknowns: [], unresolvedConflictEventIds: [], transitionViolations: [], independentReview: review,
    };
    if (!review.independent || !this.verifiedReviewerVerdictForReview(task, review, input.occurredAt ?? new Date().toISOString())) {
      throw new Error('task_control_reviewer_verdict_unverified');
    }
  }

  private assertReworkSourceCurrentLocked(input: AuthenticatedAppendTaskControlEventInput): void {
    const taskGuid = input.taskGuid!;
    const mapping = this.mappingForTask(taskGuid);
    if (!mapping || mapping.projectId !== input.projectId || mapping.phaseId !== input.phaseId || mapping.topicRootId !== input.topicRootId) {
      throw new Error('task_control_rework_mapping_unproven');
    }
    const now = input.occurredAt ?? new Date().toISOString();
    const sourceVerdictId = nonEmpty(input.payload?.sourceReviewerVerdictId, 'payload.sourceReviewerVerdictId');
    const projection = this.getTaskProjection(taskGuid, now);
    const review = projection.independentReview;
    const execution = this.eventById(nonEmpty(input.payload?.newExecutionEventId, 'payload.newExecutionEventId'));
    const head = this.reviewerVerdictHeadById(sourceVerdictId, now);
    if (!review || review.reviewerVerdictId !== sourceVerdictId
      || !this.verifiedReviewerVerdictForReview(projection, review, now)
      || head.status !== 'active' || !head.verdict
      || (head.verdict.verdict !== 'fail' && head.verdict.verdict !== 'conditional')
      || !execution || execution.eventType !== 'task.execution_started'
      || execution.taskGuid !== taskGuid || execution.seq <= review.seq) {
      throw new Error('task_control_rework_source_unproven');
    }
  }

  private trustedMappingExists(taskGuid: string): boolean {
    return !!this.db.prepare('SELECT dispatch_root FROM control_trusted_mappings WHERE lark_app_id=? AND task_guid=?')
      .get(this.larkAppId, taskGuid);
  }

  registerTrustedMapping(input: RegisterTrustedTaskControlMappingInput): RegisterTrustedTaskControlMappingResult {
    this.assertWritable();
    const dispatchRoot = nonEmpty(input.dispatchRoot, 'dispatchRoot');
    const projectId = nonEmpty(input.projectId, 'projectId');
    const phaseId = nonEmpty(input.phaseId, 'phaseId');
    const phaseTaskGuids = exactTaskSetSnapshot(input.phaseTaskGuids, 'phaseTaskGuids');
    const taskGuid = nonEmpty(input.taskGuid, 'taskGuid');
    const topicRootId = nonEmpty(input.topicRootId, 'topicRootId');
    const ownerId = nonEmpty(input.ownerId, 'ownerId');
    const reviewerId = nonEmpty(input.reviewerId, 'reviewerId');
    const acceptorId = nonEmpty(input.acceptorId, 'acceptorId');
    const registrationRef = controlledEvidenceRef(input.registrationRef, 'registrationRef');
    const registrationVersion = input.registrationVersion === undefined ? undefined : nonEmpty(input.registrationVersion, 'registrationVersion');
    const phaseRegistrationRefs = input.phaseRegistrationRefs;
    const docRevision = input.docRevision === undefined ? undefined : positiveInteger(input.docRevision, 'docRevision');
    const controllerId = nonEmpty(input.controllerId, 'controllerId');
    const approvalGate = parseApprovalGate(input.approvalGate);
    const docToken = input.docToken === undefined ? undefined : nonEmpty(input.docToken, 'docToken');
    const mappingProof = input.mappingProof;
    if (!phaseTaskGuids.includes(taskGuid) || topicRootId !== dispatchRoot
      || ownerId === reviewerId || ownerId === acceptorId || reviewerId === acceptorId) {
      throw new Error('task_control_mapping_invalid');
    }
    if (phaseRegistrationRefs && (Object.keys(phaseRegistrationRefs).length !== phaseTaskGuids.length
      || phaseTaskGuids.some(phaseTaskGuid => controlledEvidenceRef(phaseRegistrationRefs[phaseTaskGuid], `phaseRegistrationRefs.${phaseTaskGuid}`) === ''))) {
      throw new Error('task_control_mapping_registration_refs_invalid');
    }
    const principal = this.authenticate(input.authentication);
    if (principal.actorRole !== 'controller' || principal.actorId !== controllerId) {
      throw new Error('task_control_mapping_unauthorized_controller');
    }
    const mapping: TrustedTaskControlMappingRecord = {
      dispatchRoot, projectId, phaseId, phaseTaskGuids, taskGuid, topicRootId, ownerId, reviewerId, acceptorId,
      registrationRef, ...(registrationVersion ? { registrationVersion } : {}), ...(phaseRegistrationRefs ? { phaseRegistrationRefs } : {}), controllerId, approvalGate, ...(docToken ? { docToken } : {}), ...(docRevision ? { docRevision } : {}), ...(mappingProof ? { mappingProof } : {}), createdAt: input.occurredAt ?? new Date().toISOString(),
    };
    return this.withImmediateWrite(() => {
      const existing = this.db.prepare('SELECT * FROM control_trusted_mappings WHERE dispatch_root=? AND lark_app_id=?')
        .get(dispatchRoot, this.larkAppId) as Record<string, unknown> | undefined;
      if (existing) {
        const existingMapping = this.listTrustedMappings().find(item => item.dispatchRoot === dispatchRoot)!;
        if (JSON.stringify(existingMapping) !== JSON.stringify(mapping)) {
          throw new Error(`task_control_mapping_conflict:${dispatchRoot}`);
        }
        return { kind: 'duplicate', mapping: existingMapping };
      }
      // One phase opening is shared by every signed task mapping in its exact
      // frozen task set. Using a per-task registration ref here turned a real
      // two-task phase into a second invalid phase.opened transition.
      const phaseRef = `phase:${projectId}:${phaseId}:${taskSetHash(phaseTaskGuids)}:${acceptorId}`;
      const phaseResult = this.appendEventLocked({
        eventId: stableId('evt_phase', phaseRef), eventType: 'phase.opened', projectId, phaseId,
        actorId: principal.actorId, actorRole: principal.actorRole, idempotencyKey: phaseRef,
        occurredAt: mapping.createdAt, sourceRef: phaseRef,
        payload: { taskGuids: phaseTaskGuids, designatedAcceptorId: acceptorId },
      });
      if (phaseResult.kind === 'conflict') throw new Error(`task_control_mapping_phase_conflict:${dispatchRoot}`);
      const mappingRef = `mapping:${registrationRef}`;
      const mappingResult = this.appendEventLocked({
        eventId: stableId('evt_mapping', mappingRef), eventType: 'mapping.registered', projectId, phaseId, taskGuid, topicRootId,
        actorId: principal.actorId, actorRole: principal.actorRole, idempotencyKey: mappingRef,
        occurredAt: mapping.createdAt, sourceRef: mappingRef,
        payload: { ownerId, reviewerId, controllerId, ...(docToken ? { docToken } : {}) },
      });
      if (mappingResult.kind === 'conflict') throw new Error(`task_control_mapping_event_conflict:${dispatchRoot}`);
      this.db.prepare(`INSERT INTO control_trusted_mappings(
        dispatch_root,lark_app_id,project_id,phase_id,phase_task_guids_json,task_guid,topic_root_id,owner_id,reviewer_id,acceptor_id,registration_ref,registration_version,phase_registration_refs_json,controller_id,approval_gate_json,doc_token,doc_revision,mapping_proof_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        dispatchRoot, this.larkAppId, projectId, phaseId, JSON.stringify(phaseTaskGuids), taskGuid, topicRootId, ownerId, reviewerId, acceptorId,
        registrationRef, registrationVersion ?? null, phaseRegistrationRefs ? JSON.stringify(phaseRegistrationRefs) : null, controllerId, JSON.stringify(approvalGate), docToken ?? null, docRevision ?? null, mappingProof ? JSON.stringify(mappingProof) : null, mapping.createdAt,
      );
      return { kind: 'registered', mapping };
    });
  }

  getApprovalConsumption(approvalRef: string): ApprovalConsumption | undefined {
    const row = this.db.prepare('SELECT * FROM control_approval_consumptions WHERE approval_ref=? AND lark_app_id=?')
      .get(approvalRef, this.larkAppId) as Record<string, unknown> | undefined;
    return row ? approvalConsumptionFromRow(row) : undefined;
  }

  private approvalConsumptionForFreezeIdempotency(key: string): ApprovalConsumption | undefined {
    const row = this.db.prepare('SELECT * FROM control_approval_consumptions WHERE freeze_idempotency_key=? AND lark_app_id=?')
      .get(key, this.larkAppId) as Record<string, unknown> | undefined;
    return row ? approvalConsumptionFromRow(row) : undefined;
  }

  appendUnknownObservation(input: AppendTaskControlObservationInput): AppendTaskControlObservationResult {
    this.assertWritable();
    return this.withImmediateWrite(() => this.appendUnknownObservationLocked(input));
  }

  /**
   * Bounded sidecar path for latency-sensitive daemon hooks.  It never waits
   * behind the regular five-second SQLite busy timeout; callers may drop the
   * observation while preserving the primary dispatch/report availability.
   */
  tryAppendUnknownObservation(input: AppendTaskControlObservationInput): AppendTaskControlObservationResult | undefined {
    this.assertWritable();
    this.db.exec('PRAGMA busy_timeout=0;');
    try {
      try { this.db.exec('BEGIN IMMEDIATE;'); }
      catch (error) {
        if (isBusy(error)) return undefined;
        throw error;
      }
      try {
        const result = this.appendUnknownObservationLocked(input);
        this.db.exec('COMMIT;');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK;'); } catch { /* no active transaction */ }
        throw error;
      }
    } finally {
      this.db.exec('PRAGMA busy_timeout=5000;');
    }
  }

  private appendUnknownObservationLocked(input: AppendTaskControlObservationInput): AppendTaskControlObservationResult {
    const eventId = nonEmpty(input.eventId, 'observation.eventId');
    const sourceRef = nonEmpty(input.sourceRef, 'observation.sourceRef');
    const idempotencyKey = nonEmpty(input.idempotencyKey, 'observation.idempotencyKey');
    const payload = input.payload ?? {};
    const semanticHash = payloadHash({
      attemptedEventType: input.attemptedEventType, sourceRef, payload,
    });
    const existingRaw = this.db.prepare('SELECT * FROM control_observations WHERE idempotency_key=? AND lark_app_id=?')
      .get(idempotencyKey, this.larkAppId) as Record<string, unknown> | undefined;
      if (existingRaw) {
        const existing = rowToObservation(existingRaw);
        if (existing.payloadHash === semanticHash) return { kind: 'duplicate', observation: existing };
        const conflictIdempotencyKey = `observation-conflict:${sha256(idempotencyKey).slice(7)}:${semanticHash.slice(7)}`;
        const priorConflict = this.db.prepare('SELECT * FROM control_observations WHERE idempotency_key=? AND lark_app_id=?')
          .get(conflictIdempotencyKey, this.larkAppId) as Record<string, unknown> | undefined;
        if (priorConflict) return {
          kind: 'conflict', existingObservation: existing, conflictObservation: rowToObservation(priorConflict),
        };
        const conflictEventId = stableId('obs_conflict', idempotencyKey, semanticHash);
        const occurredAt = input.occurredAt ?? new Date().toISOString();
        this.db.prepare(`INSERT INTO control_observations(
          event_id,lark_app_id,attempted_event_type,source_ref,idempotency_key,occurred_at,outcome,payload_hash,payload_json
        ) VALUES(?,?,?,?,?,?,'conflict',?,?)`).run(
          conflictEventId, this.larkAppId, input.attemptedEventType, sourceRef, conflictIdempotencyKey, occurredAt, semanticHash,
          JSON.stringify({ existingEventId: existing.eventId, incomingEventId: eventId, sourceRef, payload }),
        );
        const conflict = this.db.prepare('SELECT * FROM control_observations WHERE event_id=? AND lark_app_id=?')
          .get(conflictEventId, this.larkAppId) as Record<string, unknown> | undefined;
        if (!conflict) throw new Error('task_control_observation_insert_failed');
        return { kind: 'conflict', existingObservation: existing, conflictObservation: rowToObservation(conflict) };
      }
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      this.db.prepare(`INSERT INTO control_observations(
        event_id,lark_app_id,attempted_event_type,source_ref,idempotency_key,occurred_at,outcome,payload_hash,payload_json
      ) VALUES(?,?,?,?,?,?,'unknown',?,?)`).run(
        eventId, this.larkAppId, input.attemptedEventType, sourceRef, idempotencyKey, occurredAt, semanticHash, JSON.stringify(payload),
      );
      const row = this.db.prepare('SELECT * FROM control_observations WHERE event_id=? AND lark_app_id=?')
        .get(eventId, this.larkAppId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('task_control_observation_insert_failed');
    return { kind: 'appended', observation: rowToObservation(row) };
  }

  private eventByIdempotencyKey(key: string): TaskControlEvent | undefined {
    const row = this.db.prepare('SELECT * FROM control_events WHERE idempotency_key=? AND lark_app_id=?').get(key, this.larkAppId) as unknown as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  private eventById(eventId: string): TaskControlEvent | undefined {
    const row = this.db.prepare('SELECT * FROM control_events WHERE event_id=? AND lark_app_id=?').get(eventId, this.larkAppId) as unknown as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  private mappingForTask(taskGuid: string): TaskIdentityMapping | undefined {
    return reduceTask(this.listEvents({ taskGuid })).projection.mapping;
  }

  private validateMapping(input: AuthenticatedAppendTaskControlEventInput): void {
    if (!input.taskGuid) return;
    if (input.eventType === 'mapping.registered') {
      const prior = this.mappingForTask(input.taskGuid);
      if (prior) throw new Error(`task_control_mapping_already_registered:${input.taskGuid}`);
      const topicOwner = this.db.prepare(`SELECT task_guid FROM control_events WHERE event_type='mapping.registered' AND topic_root_id=? AND lark_app_id=?`)
        .get(input.topicRootId!, this.larkAppId) as { task_guid?: string } | undefined;
      if (topicOwner && topicOwner.task_guid !== input.taskGuid) throw new Error(`task_control_topic_mapping_conflict:${input.topicRootId}`);
      return;
    }
    const mapping = this.mappingForTask(input.taskGuid);
    if (!mapping) throw new Error(`task_control_mapping_missing:${input.taskGuid}`);
    if (mapping.projectId !== input.projectId || mapping.phaseId !== input.phaseId || mapping.topicRootId !== input.topicRootId) {
      throw new Error(`task_control_mapping_mismatch:${input.taskGuid}`);
    }
  }

  appendEvent(input: AppendTaskControlEventInput): AppendTaskControlEventResult {
    this.assertWritable();
    const { authentication: _authentication, ...eventInput } = input;
    const authenticated: AuthenticatedAppendTaskControlEventInput = {
      ...eventInput,
      ...this.authenticate(input.authentication),
    };
    validateInput(authenticated, false);
    return this.withImmediateWrite(() => this.appendEventLocked(authenticated));
  }

  /** Zero-wait append for daemon hot paths. Returns undefined on SQLite contention. */
  tryAppendEvent(input: AppendTaskControlEventInput): AppendTaskControlEventResult | undefined {
    this.assertWritable();
    const { authentication: _authentication, ...eventInput } = input;
    const authenticated: AuthenticatedAppendTaskControlEventInput = {
      ...eventInput,
      ...this.authenticate(input.authentication),
    };
    validateInput(authenticated, false);
    this.db.exec('PRAGMA busy_timeout=0;');
    try {
      try { this.db.exec('BEGIN IMMEDIATE;'); }
      catch (error) {
        if (isBusy(error)) return undefined;
        throw error;
      }
      try {
        const result = this.appendEventLocked(authenticated);
        this.db.exec('COMMIT;');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK;'); } catch { /* no active transaction */ }
        throw error;
      }
    } finally {
      this.db.exec('PRAGMA busy_timeout=5000;');
    }
  }

  private appendEventLocked(input: AuthenticatedAppendTaskControlEventInput, allowFrozen = false): AppendTaskControlEventResult {
    validateInput(input, allowFrozen);
    if (input.eventType === 'task.reviewed' || input.eventType === 'task.review_corrected') this.assertReviewedVerdictCurrentLocked(input);
    if (input.eventType === 'task.rework_started') this.assertReworkSourceCurrentLocked(input);
    const payloadHash = eventPayloadHash(input);
    const existing = this.eventByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash === payloadHash) return { kind: 'duplicate', event: existing };
      const existingPhase = reducePhase(this.listEvents({ projectId: existing.projectId, phaseId: existing.phaseId })
        .filter(event => !event.taskGuid));
      if (existingPhase.lifecycleState === 'frozen') {
        return this.appendFrozenConflictLocked(input, payloadHash, existing, 'idempotency_payload_conflict_after_frozen');
      }
      const conflictKeyHash = sha256(input.idempotencyKey).slice(7);
      const conflictEventId = stableId('evt_conflict', input.idempotencyKey, payloadHash);
      const conflictIdempotencyKey = `conflict:${conflictKeyHash}:${payloadHash.slice(7)}`;
      const priorConflict = this.eventByIdempotencyKey(conflictIdempotencyKey);
      if (priorConflict) return { kind: 'conflict', existingEvent: existing, conflictEvent: priorConflict };
      const conflictInput: AuthenticatedAppendTaskControlEventInput = {
        eventId: conflictEventId, eventType: 'event.conflict_detected',
        projectId: existing.projectId, phaseId: existing.phaseId,
        ...(existing.taskGuid ? { taskGuid: existing.taskGuid } : {}),
        ...(existing.topicRootId ? { topicRootId: existing.topicRootId } : {}),
        actorId: input.actorId, actorRole: input.actorRole, occurredAt: input.occurredAt,
        sourceRef: input.sourceRef, evidenceRef: input.evidenceRef,
        idempotencyKey: conflictIdempotencyKey, causationId: existing.eventId,
        correlationId: input.correlationId, errorClass: 'idempotency_payload_conflict',
        payload: {
          conflictKey: input.idempotencyKey, existingEventId: existing.eventId,
          existingPayloadHash: existing.payloadHash, incomingEventId: input.eventId, incomingPayloadHash: payloadHash,
        },
      };
      const conflictEvent = this.insertEventLocked(conflictInput, eventPayloadHash(conflictInput));
      return { kind: 'conflict', existingEvent: existing, conflictEvent };
    }
    const phase = reducePhase(this.listEvents({ projectId: input.projectId, phaseId: input.phaseId })
      .filter(event => !event.taskGuid));
    if (phase.lifecycleState === 'frozen') {
      return this.appendFrozenConflictLocked(input, payloadHash, undefined, 'late_after_frozen');
    }
    this.validateMapping(input);
    return { kind: 'appended', event: this.insertEventLocked(input, payloadHash) };
  }

  /** Frozen is terminal: append late/contradictory evidence without reopening or overwriting it. */
  private appendFrozenConflictLocked(
    input: AuthenticatedAppendTaskControlEventInput, incomingPayloadHash: string, existing: TaskControlEvent | undefined, errorClass: string,
  ): AppendTaskControlEventResult {
    const frozen = this.listEvents({ projectId: input.projectId, phaseId: input.phaseId })
      .filter(event => event.eventType === 'phase.frozen').at(-1);
    if (!frozen) throw new Error(`task_control_phase_already_frozen:${input.phaseId}`);
    const conflictKey = `frozen-conflict:${sha256(input.idempotencyKey).slice(7)}:${incomingPayloadHash.slice(7)}`;
    const prior = this.eventByIdempotencyKey(conflictKey);
    if (prior) return { kind: 'conflict', existingEvent: existing ?? frozen, conflictEvent: prior };
    const conflictInput: AuthenticatedAppendTaskControlEventInput = {
      eventId: stableId('evt_frozen_conflict', input.projectId, input.phaseId, input.idempotencyKey, incomingPayloadHash),
      eventType: 'event.conflict_detected', projectId: input.projectId, phaseId: input.phaseId,
      actorId: input.actorId, actorRole: input.actorRole, occurredAt: input.occurredAt,
      sourceRef: input.sourceRef, evidenceRef: input.evidenceRef, idempotencyKey: conflictKey,
      causationId: existing?.eventId ?? frozen.eventId, correlationId: input.correlationId, errorClass,
      payload: {
        frozenEventId: frozen.eventId, incomingEventId: input.eventId, incomingEventType: input.eventType,
        incomingTaskGuid: input.taskGuid ?? null, incomingTopicRootId: input.topicRootId ?? null,
        incomingIdempotencyKeyHash: sha256(input.idempotencyKey), incomingPayloadHash,
        ...(existing ? { existingEventId: existing.eventId, existingPayloadHash: existing.payloadHash } : {}),
      },
    };
    const conflictEvent = this.insertEventLocked(conflictInput, eventPayloadHash(conflictInput));
    return { kind: 'conflict', existingEvent: existing ?? frozen, conflictEvent };
  }

  private insertEventLocked(input: AuthenticatedAppendTaskControlEventInput, payloadHash: string): TaskControlEvent {
    const payload = input.payload ?? {};
    const taskEvents = input.taskGuid ? this.listEvents({ taskGuid: input.taskGuid }) : [];
    const phaseOnlyEvents = this.listEvents({ projectId: input.projectId, phaseId: input.phaseId }).filter(event => !event.taskGuid);
    const beforeTask = reduceTask(taskEvents);
    const beforePhase = reducePhase(phaseOnlyEvents);
    const stateBefore = input.taskGuid ? beforeTask.projection.state : beforePhase.state;
    const stateAfter = input.taskGuid
      ? taskStateAfter(input.eventType, payload, beforeTask.lifecycleState)
      : phaseStateAfter(input.eventType, beforePhase.lifecycleState);
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO control_events(
      event_id,lark_app_id,event_type,schema_version,project_id,phase_id,task_guid,topic_root_id,actor_id,actor_role,occurred_at,
      state_before,state_after,source_ref,payload_ref,evidence_ref,idempotency_key,causation_id,correlation_id,attempt,
      error_class,ack_deadline,terminal,payload_hash,payload_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.eventId, this.larkAppId, input.eventType, 1, input.projectId, input.phaseId, input.taskGuid ?? null, input.topicRootId ?? null,
      input.actorId, input.actorRole, occurredAt, stateBefore, stateAfter, input.sourceRef ?? null, input.payloadRef ?? null,
      input.evidenceRef ?? null, input.idempotencyKey, input.causationId ?? null, input.correlationId ?? null, input.attempt ?? 1,
      input.errorClass ?? null, input.ackDeadline ?? null, input.terminal ? 1 : 0, payloadHash, JSON.stringify(payload),
    );
    const event = this.eventById(input.eventId);
    if (!event || Number(result.changes) !== 1) throw new Error('task_control_event_insert_failed');
    if (input.eventType === 'task.delivery_fallback_verified') {
      const fallback = parseDeliveryFallback(payload);
      const deliveryEvent = this.eventById(fallback.deliveryEventId);
      if (!deliveryEvent || deliveryEvent.eventType !== 'task.delivered'
        || deliveryEvent.taskGuid !== input.taskGuid || deliveryEvent.topicRootId !== input.topicRootId) {
        throw new Error(`task_control_fallback_delivery_mismatch:${fallback.deliveryEventId}`);
      }
      const row = this.db.prepare(`SELECT * FROM control_outbox
        WHERE event_id=? AND destination_id=? AND lark_app_id=?`).get(
        fallback.deliveryEventId, fallback.destinationId, this.larkAppId,
      ) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`task_control_fallback_outbox_missing:${fallback.deliveryEventId}:${fallback.destinationId}`);
      const outbox = outboxFromRow(row);
      if (outbox.status !== 'degraded') throw new Error(`task_control_fallback_not_degraded:${outbox.outboxId}`);
      if (outbox.fallbackEventId) throw new Error(`task_control_fallback_already_verified:${outbox.outboxId}`);
      const linked = this.db.prepare(`UPDATE control_outbox SET fallback_event_id=?,updated_at=?
        WHERE outbox_id=? AND lark_app_id=? AND status='degraded' AND fallback_event_id IS NULL`).run(
        event.eventId, occurredAt, outbox.outboxId, this.larkAppId,
      );
      if (Number(linked.changes) !== 1) throw new Error(`task_control_fallback_link_failed:${outbox.outboxId}`);
      this.insertReceiptLocked(outbox, {
        state: 'fallback_verified', receiptRef: fallback.receiptRef, fallbackEventId: event.eventId, createdAt: occurredAt,
      });
    }
    const destinations = [...new Set(input.deliverTo ?? [])].sort();
    for (const destinationId of destinations) {
      const outboxId = stableId('out', event.eventId, destinationId);
      this.db.prepare(`INSERT INTO control_outbox(
        outbox_id,lark_app_id,event_id,destination_id,status,attempts,next_attempt_at,created_at,updated_at
      ) VALUES(?,?,?,?,'pending',0,?,?,?)`).run(
        outboxId, this.larkAppId, event.eventId, destinationId, Date.parse(occurredAt) || Date.now(), occurredAt, occurredAt,
      );
    }
    return event;
  }

  getTaskProjection(taskGuid: string, checkedAt = new Date().toISOString()): TaskProjection {
    const projection = reduceTask(this.listEvents({ taskGuid })).projection;
    return this.refreshReviewerVerdictProjection({ ...projection, taskGuid }, checkedAt);
  }

  getPhaseProjection(projectId: string, phaseId: string): PhaseProjection {
    const events = this.listEvents({ projectId, phaseId });
    const phaseEvents = events.filter(event => !event.taskGuid);
    const phase = reducePhase(phaseEvents);
    const mapped = events.filter(event => event.eventType === 'mapping.registered').map(event => event.taskGuid!);
    const taskGuids = [...new Set([...phase.expectedTaskGuids, ...mapped])].sort();
    return {
      projectId, phaseId, state: phase.state, expectedTaskGuids: phase.expectedTaskGuids,
      ...(phase.designatedAcceptorId ? { designatedAcceptorId: phase.designatedAcceptorId } : {}),
      tasks: taskGuids.map(taskGuid => this.getTaskProjection(taskGuid)),
      unknowns: phase.unknowns, unresolvedConflictEventIds: phase.unresolvedConflictEventIds,
      transitionViolations: phase.transitionViolations,
    };
  }

  listOutbox(filter: { eventId?: string; phaseId?: string } = {}): DeliveryOutboxRow[] {
    const rows = this.db.prepare(`SELECT o.* FROM control_outbox o
      JOIN control_events e ON e.event_id=o.event_id AND e.lark_app_id=o.lark_app_id
      WHERE o.lark_app_id=? ORDER BY o.created_at,o.outbox_id`).all(this.larkAppId) as Record<string, unknown>[];
    return rows.map(outboxFromRow).filter(row => !filter.eventId || row.eventId === filter.eventId)
      .filter(row => {
        if (!filter.phaseId) return true;
        return this.eventById(row.eventId)?.phaseId === filter.phaseId;
      });
  }

  listReceipts(eventId?: string): DeliveryReceipt[] {
    return (this.db.prepare('SELECT * FROM control_delivery_receipts WHERE lark_app_id=? ORDER BY created_at,receipt_id').all(this.larkAppId) as Record<string, unknown>[])
      .map(receiptFromRow).filter(receipt => !eventId || receipt.eventId === eventId);
  }

  claimOutbox(input: { now: number; limit: number; claimToken: string }): DeliveryOutboxRow[] {
    nonEmpty(input.claimToken, 'claimToken');
    return this.withImmediateWrite(() => {
      const ids = (this.db.prepare(`SELECT outbox_id FROM control_outbox
        WHERE lark_app_id=? AND status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,outbox_id LIMIT ?`)
        .all(this.larkAppId, input.now, Math.max(1, Math.min(input.limit, 100))) as Array<{ outbox_id: string }>)
        .map(row => row.outbox_id);
      for (const outboxId of ids) {
        this.db.prepare(`UPDATE control_outbox SET status='inflight',attempts=attempts+1,claim_token=?,claimed_at=?,updated_at=?
          WHERE outbox_id=? AND lark_app_id=? AND status='pending'`).run(input.claimToken, input.now, new Date(input.now).toISOString(), outboxId, this.larkAppId);
      }
      const wanted = new Set(ids);
      return this.listOutbox().filter(row => wanted.has(row.outboxId) && row.claimToken === input.claimToken);
    });
  }

  /** Atomically claim exactly one known event/destination row without touching unrelated pending outbox work. */
  claimOutboxForEventDestination(input: {
    eventId: string; destinationId: string; now: number; claimToken: string;
  }): DeliveryOutboxRow | undefined {
    const eventId = nonEmpty(input.eventId, 'eventId');
    const destinationId = nonEmpty(input.destinationId, 'destinationId');
    const claimToken = nonEmpty(input.claimToken, 'claimToken');
    if (!Number.isFinite(input.now)) throw new Error('task_control_invalid:outbox_claim_now');
    return this.withImmediateWrite(() => {
      const raw = this.db.prepare(`SELECT * FROM control_outbox
        WHERE lark_app_id=? AND event_id=? AND destination_id=? AND status='pending'`)
        .get(this.larkAppId, eventId, destinationId) as Record<string, unknown> | undefined;
      if (!raw) return undefined;
      const outbox = outboxFromRow(raw);
      const changed = this.db.prepare(`UPDATE control_outbox
        SET status='inflight',attempts=attempts+1,claim_token=?,claimed_at=?,updated_at=?
        WHERE outbox_id=? AND lark_app_id=? AND status='pending'`).run(
        claimToken, input.now, new Date(input.now).toISOString(), outbox.outboxId, this.larkAppId,
      );
      if (Number(changed.changes) !== 1) return undefined;
      const claimed = this.db.prepare(`SELECT * FROM control_outbox
        WHERE outbox_id=? AND lark_app_id=? AND status='inflight' AND claim_token=?`)
        .get(outbox.outboxId, this.larkAppId, claimToken) as Record<string, unknown> | undefined;
      return claimed ? outboxFromRow(claimed) : undefined;
    });
  }

  /**
   * Atomically degrade an in-flight primary and queue its only fallback. This
   * closes the crash window where both destinations could later be reclaimed.
   */
  degradeOutboxWithFallback(input: {
    eventId: string; sourceDestinationId: string; fallbackDestinationId: string; claimToken: string; error: string; now?: number;
  }): DeliveryOutboxRow {
    const eventId = nonEmpty(input.eventId, 'eventId');
    const sourceDestinationId = nonEmpty(input.sourceDestinationId, 'sourceDestinationId');
    const fallbackDestinationId = nonEmpty(input.fallbackDestinationId, 'fallbackDestinationId');
    const claimToken = nonEmpty(input.claimToken, 'claimToken');
    const error = nonEmpty(input.error, 'error');
    if (!fallbackDestinationId.startsWith('topic-message:')) throw new Error('task_control_fallback_destination_invalid');
    const now = input.now ?? Date.now();
    return this.withImmediateWrite(() => {
      const source = this.db.prepare(`SELECT * FROM control_outbox
        WHERE lark_app_id=? AND event_id=? AND destination_id=? AND status='inflight' AND claim_token=?`)
        .get(this.larkAppId, eventId, sourceDestinationId, claimToken) as Record<string, unknown> | undefined;
      if (!source) throw new Error('task_control_fallback_source_not_inflight');
      const event = this.eventById(eventId);
      if (!event || event.eventType !== 'task.delivered') throw new Error('task_control_fallback_event_invalid');
      const existing = this.db.prepare(`SELECT * FROM control_outbox
        WHERE lark_app_id=? AND event_id=? AND destination_id=?`)
        .get(this.larkAppId, eventId, fallbackDestinationId) as Record<string, unknown> | undefined;
      const occurredAt = new Date(now).toISOString();
      let fallback = existing ? outboxFromRow(existing) : undefined;
      if (!fallback) {
        const outboxId = stableId('out', eventId, fallbackDestinationId);
        this.db.prepare(`INSERT INTO control_outbox(
          outbox_id,lark_app_id,event_id,destination_id,status,attempts,next_attempt_at,created_at,updated_at
        ) VALUES(?,?,?,?,'pending',0,?,?,?)`).run(
          outboxId, this.larkAppId, eventId, fallbackDestinationId, now, occurredAt, occurredAt,
        );
        const row = this.db.prepare('SELECT * FROM control_outbox WHERE lark_app_id=? AND outbox_id=?')
          .get(this.larkAppId, outboxId) as Record<string, unknown> | undefined;
        if (!row) throw new Error('task_control_fallback_outbox_insert_failed');
        fallback = outboxFromRow(row);
      }
      const sourceOutbox = outboxFromRow(source);
      const changed = this.db.prepare(`UPDATE control_outbox SET status='degraded',claim_token=NULL,claimed_at=NULL,last_error=?,updated_at=?
        WHERE lark_app_id=? AND outbox_id=? AND status='inflight' AND claim_token=?`).run(
        error, occurredAt, this.larkAppId, sourceOutbox.outboxId, claimToken,
      );
      if (Number(changed.changes) !== 1) throw new Error('task_control_fallback_primary_degrade_failed');
      this.insertReceiptLocked(sourceOutbox, { state: 'degraded', error, createdAt: occurredAt });
      return fallback;
    });
  }

  settleOutboxDelivered(
    outboxId: string,
    claimToken: string,
    input: { receiptRef: string; deliveredAt?: string },
  ): boolean {
    const receiptRef = nonEmpty(input.receiptRef, 'receiptRef');
    return this.settleOutbox(outboxId, claimToken, {
      state: 'delivered', receiptRef,
      createdAt: input.deliveredAt ?? new Date().toISOString(),
    });
  }

  /** A daemon-owned provider receipt may settle its exact terminal row without a pump claim. */
  settleOutboxDeliveredByReceipt(input: { eventId: string; destinationId: string; receiptRef: string; deliveredAt?: string }): boolean {
    const eventId = nonEmpty(input.eventId, 'eventId');
    const destinationId = nonEmpty(input.destinationId, 'destinationId');
    const receiptRef = nonEmpty(input.receiptRef, 'receiptRef');
    const deliveredAt = input.deliveredAt ?? new Date().toISOString();
    return this.withImmediateWrite(() => {
      const raw = this.db.prepare(`SELECT * FROM control_outbox
        WHERE event_id=? AND destination_id=? AND lark_app_id=? AND status IN ('pending','inflight')`)
        .get(eventId, destinationId, this.larkAppId) as Record<string, unknown> | undefined;
      if (!raw) return false;
      const outbox = outboxFromRow(raw);
      if (!receiptRefBindsEventAndDestination(receiptRef, eventId, destinationId)) return false;
      const changed = this.db.prepare(`UPDATE control_outbox SET status='delivered',claim_token=NULL,claimed_at=NULL,updated_at=?
        WHERE outbox_id=? AND lark_app_id=? AND status IN ('pending','inflight')`).run(deliveredAt, outbox.outboxId, this.larkAppId);
      if (Number(changed.changes) !== 1) return false;
      this.insertReceiptLocked(outbox, { state: 'delivered', receiptRef, createdAt: deliveredAt });
      return true;
    });
  }

  settleOutboxDegraded(outboxId: string, claimToken: string, input: { error: string; createdAt?: string }): boolean {
    return this.settleOutbox(outboxId, claimToken, {
      state: 'degraded', error: nonEmpty(input.error, 'error'),
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }

  rescheduleOutbox(outboxId: string, claimToken: string, input: { error: string; nextAttemptAt: number; createdAt?: string }): boolean {
    return this.settleOutbox(outboxId, claimToken, {
      state: 'retry_scheduled', error: nonEmpty(input.error, 'error'), nextAttemptAt: input.nextAttemptAt,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }

  /** Requeue claims left inflight by a crashed delivery worker. */
  resetExpiredOutboxClaims(now: number, staleAfterMs: number): number {
    if (!Number.isFinite(now) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
      throw new Error('task_control_invalid:outbox_claim_expiry');
    }
    return this.withImmediateWrite(() => {
      const recoveredAt = new Date(now).toISOString();
      const rows = this.db.prepare(`SELECT * FROM control_outbox
        WHERE lark_app_id=? AND status='inflight' AND claimed_at<=? ORDER BY outbox_id`).all(this.larkAppId, now - staleAfterMs) as Record<string, unknown>[];
      for (const raw of rows) {
        const row = outboxFromRow(raw);
        this.db.prepare(`UPDATE control_outbox SET status='pending',claim_token=NULL,claimed_at=NULL,updated_at=?
          WHERE outbox_id=? AND lark_app_id=? AND status='inflight'`).run(recoveredAt, row.outboxId, this.larkAppId);
        this.insertReceiptLocked(row, {
          state: 'claim_recovered', error: 'delivery_claim_expired', createdAt: recoveredAt,
        });
      }
      return rows.length;
    });
  }

  private settleOutbox(outboxId: string, claimToken: string, input: {
    state: DeliveryAttemptReceiptState; error?: string; receiptRef?: string; nextAttemptAt?: number; createdAt: string;
  }): boolean {
    nonEmpty(outboxId, 'outboxId');
    nonEmpty(claimToken, 'claimToken');
    return this.withImmediateWrite(() => {
      const row = this.db.prepare(`SELECT * FROM control_outbox WHERE outbox_id=? AND lark_app_id=? AND status='inflight' AND claim_token=?`)
        .get(outboxId, this.larkAppId, claimToken) as Record<string, unknown> | undefined;
      if (!row) return false;
      const outbox = outboxFromRow(row);
      if (input.state === 'delivered' && (!input.receiptRef
        || !receiptRefBindsEventAndDestination(input.receiptRef, outbox.eventId, outbox.destinationId))) return false;
      const status: DeliveryOutboxStatus = input.state === 'retry_scheduled' ? 'pending' : input.state;
      this.db.prepare(`UPDATE control_outbox SET status=?,next_attempt_at=?,claim_token=NULL,claimed_at=NULL,last_error=?,fallback_event_id=NULL,updated_at=?
        WHERE outbox_id=? AND lark_app_id=? AND status='inflight' AND claim_token=?`).run(
        status, input.nextAttemptAt ?? outbox.nextAttemptAt, input.error ?? null, input.createdAt, outboxId, this.larkAppId, claimToken,
      );
      this.insertReceiptLocked(outbox, input);
      return true;
    });
  }

  private insertReceiptLocked(outbox: DeliveryOutboxRow, input: {
    state: DeliveryReceiptState; error?: string; receiptRef?: string; fallbackEventId?: string; createdAt: string;
  }): void {
    if (input.receiptRef) {
      if (input.state === 'delivered' && !receiptRefBindsEventAndDestination(input.receiptRef, outbox.eventId, outbox.destinationId)) {
        throw new Error(`task_control_receipt_binding_unproven:${outbox.eventId}:${outbox.destinationId}`);
      }
      const existing = this.db.prepare(`SELECT receipt_id FROM control_delivery_receipts
        WHERE lark_app_id=? AND event_id=? AND destination_id=? AND receipt_ref=?`)
        .get(this.larkAppId, outbox.eventId, outbox.destinationId, input.receiptRef) as Record<string, unknown> | undefined;
      if (existing) throw new Error(`task_control_receipt_replayed:${outbox.eventId}:${outbox.destinationId}`);
      if (input.state === 'delivered') {
        const crossBound = this.db.prepare(`SELECT receipt_id FROM control_delivery_receipts
          WHERE lark_app_id=? AND receipt_ref=? AND (event_id<>? OR destination_id<>?)`)
          .get(this.larkAppId, input.receiptRef, outbox.eventId, outbox.destinationId) as Record<string, unknown> | undefined;
        if (crossBound) throw new Error(`task_control_receipt_cross_binding:${outbox.eventId}:${outbox.destinationId}`);
      }
    }
    this.db.prepare(`INSERT INTO control_delivery_receipts(
      receipt_id,lark_app_id,outbox_id,event_id,destination_id,attempt,state,receipt_ref,error,fallback_event_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      `rcpt_${randomUUID().replaceAll('-', '')}`, this.larkAppId, outbox.outboxId, outbox.eventId, outbox.destinationId, outbox.attempts,
      input.state, input.receiptRef ?? null, input.error ?? null, input.fallbackEventId ?? null, input.createdAt,
    );
  }

  private successfulDeliveryReceipt(outbox: DeliveryOutboxRow): DeliveryReceipt | undefined {
    const receipts = this.listReceipts(outbox.eventId)
      .filter(receipt => receipt.outboxId === outbox.outboxId);
    if (outbox.status === 'delivered') {
      return [...receipts].reverse().find(receipt => receipt.state === 'delivered' && !!receipt.receiptRef);
    }
    if (outbox.status !== 'degraded' || !outbox.fallbackEventId) return undefined;
    const fallbackEvent = this.eventById(outbox.fallbackEventId);
    if (!fallbackEvent || fallbackEvent.eventType !== 'task.delivery_fallback_verified') return undefined;
    const fallback = parseDeliveryFallback(fallbackEvent.payload);
    if (fallback.deliveryEventId !== outbox.eventId || fallback.destinationId !== outbox.destinationId) return undefined;
    return [...receipts].reverse().find(receipt => receipt.state === 'fallback_verified'
      && receipt.fallbackEventId === outbox.fallbackEventId && receipt.receiptRef === fallback.receiptRef);
  }

  validatePhaseFreeze(projectId: string, phaseId: string, checkedAt = new Date().toISOString()): PhaseFreezeValidation {
    const events = this.listEvents({ projectId, phaseId });
    return this.validatePhaseFreezeFromEvents(projectId, phaseId, checkedAt, events);
  }

  /** Current readiness before a new request exists: remove historic request wrappers, not their underlying task evidence. */
  validateProspectivePhaseFreeze(projectId: string, phaseId: string, checkedAt = new Date().toISOString()): PhaseFreezeValidation {
    const events = this.listEvents({ projectId, phaseId }).filter(event => event.eventType !== 'phase.freeze_requested');
    return this.validatePhaseFreezeFromEvents(projectId, phaseId, checkedAt, events, { prospective: true });
  }

  private validatePhaseFreezeFromEvents(
    projectId: string, phaseId: string, checkedAt: string, events: readonly TaskControlEvent[], options: { prospective?: boolean } = {},
  ): PhaseFreezeValidation {
    const issues: FreezeIssue[] = [];
    const phaseEvents = events.filter(event => !event.taskGuid);
    const phase = reducePhase(phaseEvents);
    const opened = [...phaseEvents].reverse().find(event => event.eventType === 'phase.opened');
    const freezeRequest = phase.latestFreezeRequest;
    if (!opened) issues.push({ code: 'phase_not_opened', message: 'phase.opened evidence is missing' });
    if (!options.prospective && !freezeRequest) issues.push({ code: 'phase_freeze_not_requested', message: 'phase.freeze_requested evidence is missing' });
    if (!options.prospective && phase.state !== 'freeze_pending' && phase.state !== 'frozen') {
      issues.push({ code: 'phase_state_not_ready', message: `phase state is ${phase.state}` });
    }
    for (const conflictEventId of phase.unresolvedConflictEventIds) {
      issues.push({ code: 'idempotency_conflict_unresolved', message: 'phase has an unresolved idempotency conflict', eventId: conflictEventId });
    }
    for (const violation of phase.transitionViolations) {
      issues.push({ code: 'invalid_transition_detected', message: `invalid phase transition from ${violation.stateBefore} via ${violation.eventType}`, eventId: violation.eventId });
    }

    const mappedTaskGuids = events.filter(event => event.eventType === 'mapping.registered').map(event => event.taskGuid!);
    const expectedTaskGuids = [...new Set(phase.expectedTaskGuids.length > 0 ? phase.expectedTaskGuids : mappedTaskGuids)].sort();
    if (expectedTaskGuids.length === 0) {
      issues.push({ code: 'phase_task_set_empty', message: 'phase has no frozen task set' });
    }
    const unexpectedMappedTasks = [...new Set(mappedTaskGuids.filter(taskGuid => !expectedTaskGuids.includes(taskGuid)))];
    if (unexpectedMappedTasks.length > 0) {
      issues.push({ code: 'phase_task_set_mismatch', message: `mapped tasks are absent from phase.opened snapshot: ${unexpectedMappedTasks.join(',')}` });
    }
    if (!options.prospective && freezeRequest && JSON.stringify([...freezeRequest.taskGuids].sort()) !== JSON.stringify(expectedTaskGuids)) {
      issues.push({ code: 'phase_freeze_request_task_set_mismatch', message: 'freeze request task set differs from phase.opened snapshot', eventId: freezeRequest.eventId });
    }
    if (!options.prospective && freezeRequest && freezeRequest.openIssueCodes.length > 0) {
      issues.push({ code: 'phase_freeze_request_open_issues', message: `freeze request carries open issues: ${freezeRequest.openIssueCodes.join(',')}`, eventId: freezeRequest.eventId });
    }
    for (const taskGuid of expectedTaskGuids) {
      const taskEvents = events.filter(event => event.taskGuid === taskGuid);
      const task = this.getTaskProjection(taskGuid, checkedAt);
      if (!task.mapping) {
        issues.push({ code: 'task_mapping_missing', message: 'canonical task/topic mapping is missing', taskGuid });
        continue;
      }
      if (!task.explicitlyAccepted) issues.push({ code: 'task_acceptance_missing', message: 'explicit task.accepted event is missing', taskGuid });
      if (task.mapping && task.acceptedActorId && task.mapping.ownerId !== task.acceptedActorId) {
        issues.push({ code: 'task_acceptance_actor_mismatch', message: 'task.accepted actor does not match mapped owner', taskGuid, eventId: task.acceptedEventId });
      }
      if (!task.terminalBody) issues.push({ code: 'terminal_body_missing', message: 'terminal task.delivered doc token/revision is missing', taskGuid });
      if (!taskEvents.some(event => event.eventType === 'task.execution_started')) {
        issues.push({ code: 'task_execution_missing', message: 'task.execution_started evidence is missing', taskGuid });
      }
      if (!taskEvents.some(event => event.eventType === 'task.first_submitted')) {
        issues.push({ code: 'task_submission_missing', message: 'task.first_submitted evidence is missing', taskGuid });
      }
      const review = task.independentReview;
      if (!review || (review.verdict !== 'pass' && review.verdict !== 'conditional')) {
        issues.push({ code: 'independent_review_missing', message: 'independent accepting review is missing', taskGuid });
      }
      if (task.unresolvedReviewConditionIds.length > 0) {
        issues.push({
          code: 'review_conditions_unresolved',
          message: `conditional review has unresolved conditions: ${task.unresolvedReviewConditionIds.join(',')}`,
          taskGuid, eventId: review?.eventId,
        });
      }
      if (task.mapping && review?.independent && review.reviewerId === task.mapping.ownerId) {
        issues.push({ code: 'reviewer_not_independent', message: 'reviewer is the mapped task owner', taskGuid, eventId: review.eventId });
      }
      if (task.reviewerVerdictIssue) {
        issues.push({ code: 'reviewer_verdict_unverified', message: task.reviewerVerdictIssue, taskGuid, eventId: review?.eventId });
      }
      if (task.terminalBody && review && (review.docToken !== task.terminalBody.docToken || review.docRevision !== task.terminalBody.docRevision)) {
        issues.push({ code: 'review_terminal_mismatch', message: 'review does not identify the terminal document revision', taskGuid, eventId: review.eventId });
      }
      if (!task.doneEvent) issues.push({ code: 'task_done_missing', message: 'task.done_marked evidence is missing', taskGuid });
      if (task.doneEvent && task.terminalBody && task.doneEvent.seq < task.terminalBody.seq) {
        issues.push({ code: 'task_done_precedes_terminal_body', message: 'task done predates terminal body', taskGuid, eventId: task.doneEvent.eventId });
      }
      if (task.doneEvent && review && task.doneEvent.seq < review.seq) {
        issues.push({ code: 'task_done_precedes_review', message: 'task done predates independent review', taskGuid, eventId: task.doneEvent.eventId });
      }
      if (review && task.terminalBody && review.seq > task.terminalBody.seq) {
        issues.push({ code: 'review_terminal_mismatch', message: 'independent review was recorded after terminal delivery', taskGuid, eventId: review.eventId });
      }
      if (task.state !== 'task_done_pending_freeze') {
        issues.push({ code: 'task_state_not_ready', message: `task state is ${task.state}`, taskGuid });
      }
      for (const conflictEventId of task.unresolvedConflictEventIds) {
        issues.push({ code: 'idempotency_conflict_unresolved', message: 'task has an unresolved idempotency conflict', taskGuid, eventId: conflictEventId });
      }
      for (const violation of task.transitionViolations) {
        issues.push({ code: 'invalid_transition_detected', message: `invalid task transition from ${violation.stateBefore} via ${violation.eventType}`, taskGuid, eventId: violation.eventId });
      }
      for (const unknown of task.unknowns) {
        if (unknown.required && !unknown.declared) {
          issues.push({ code: 'unknown_declaration_missing', message: 'required UNKNOWN boundary was not declared', taskGuid, unknownKey: unknown.key });
        }
      }
      if (task.terminalBody) {
        const deliveryRows = this.listOutbox({ eventId: task.terminalBody.eventId });
        if (deliveryRows.length === 0 || !deliveryRows.every(row => !!this.successfulDeliveryReceipt(row))) {
          issues.push({ code: 'delivery_receipt_missing', message: 'terminal delivery has no delivered receipt', taskGuid, eventId: task.terminalBody.eventId });
        }
      }
    }
    for (const unknown of phase.unknowns) {
      if (unknown.required && !unknown.declared) {
        issues.push({ code: 'unknown_declaration_missing', message: 'required phase UNKNOWN boundary was not declared', unknownKey: unknown.key });
      }
    }
    const phaseOutbox = this.listOutbox({ phaseId });
    for (const row of phaseOutbox) {
      if (row.status === 'pending' || row.status === 'inflight') {
        issues.push({ code: 'outbox_unsettled', message: `delivery outbox is ${row.status}`, eventId: row.eventId });
      }
      if (row.status === 'degraded' && !this.successfulDeliveryReceipt(row)) {
        issues.push({ code: 'delivery_degraded_unhandled', message: 'degraded delivery has no verified fallback receipt event', eventId: row.eventId });
      }
    }
    const latestFreezeEvidenceSeq = Math.max(0, ...events
      .filter(event => !!event.taskGuid || event.eventType.startsWith('unknown.') || event.eventType.startsWith('event.conflict_'))
      .map(event => event.seq));
    const freezeRequestEvent = !options.prospective && freezeRequest ? events.find(event => event.eventId === freezeRequest.eventId) : undefined;
    if (freezeRequestEvent && freezeRequestEvent.seq < latestFreezeEvidenceSeq) {
      issues.push({ code: 'phase_freeze_request_too_early', message: 'phase freeze request predates the latest task or boundary evidence', eventId: freezeRequestEvent.eventId });
    }
    return { ok: issues.length === 0, projectId, phaseId, checkedAt, taskGuids: expectedTaskGuids, issues };
  }

  private buildFreezeSnapshot(
    validation: PhaseFreezeValidation, events: readonly TaskControlEvent[], checkedAt: string,
    acceptorId: string, approvalRef: string, approvedAt: string,
  ): PhaseFreezeSnapshot {
    const phase = reducePhase(events.filter(event => !event.taskGuid));
    const freezeRequest = phase.latestFreezeRequest;
    if (!freezeRequest) throw new Error('task_control_freeze_snapshot_missing_request');
    const tasks = validation.taskGuids.map(taskGuid => {
      const task = reduceTask(events.filter(event => event.taskGuid === taskGuid)).projection;
      if (!task.mapping || !task.acceptedEventId || !task.terminalBody || !task.independentReview || !task.doneEvent) {
        throw new Error(`task_control_freeze_snapshot_incomplete:${taskGuid}`);
      }
      const deliveryReceipts = this.listOutbox({ eventId: task.terminalBody.eventId }).map(outbox => {
        const receipt = this.successfulDeliveryReceipt(outbox);
        if (!receipt) throw new Error(`task_control_freeze_snapshot_receipt_missing:${outbox.outboxId}`);
        return {
          destinationId: outbox.destinationId,
          status: receipt.state === 'delivered' ? 'delivered' as const : 'fallback_verified' as const,
          receiptId: receipt.receiptId,
          ...(receipt.fallbackEventId ? { fallbackEventId: receipt.fallbackEventId } : {}),
        };
      });
      return {
        taskGuid, topicRootId: task.mapping.topicRootId, ownerId: task.mapping.ownerId,
        acceptanceEventId: task.acceptedEventId, terminalBody: task.terminalBody,
        independentReview: task.independentReview, doneEvent: task.doneEvent,
        deliveryReceipts, unknowns: task.unknowns,
      };
    });
    const phaseUnknowns = reduceUnknowns(events.filter(event => !event.taskGuid));
    return {
      projectId: validation.projectId, phaseId: validation.phaseId,
      freezeRequestedEventId: freezeRequest.eventId, requestedTaskGuids: freezeRequest.taskGuids,
      requestedOpenIssueCodes: freezeRequest.openIssueCodes, requestRef: freezeRequest.requestRef,
      acceptorId, approvalRef, approvedAt, checkedAt,
      tasks, phaseUnknowns, issues: validation.issues,
    };
  }

  freezePhase(input: {
    eventId: string; projectId: string; phaseId: string; authentication: unknown; approval: unknown;
    idempotencyKey: string; occurredAt?: string; evidenceRef?: string;
  }): { kind: 'frozen'; validation: PhaseFreezeValidation; event: TaskControlEvent }
    | { kind: 'rejected'; validation: PhaseFreezeValidation } {
    return this.withImmediateWrite(() => {
      const prior = this.eventByIdempotencyKey(input.idempotencyKey);
      const checkedAt = prior?.eventType === 'phase.frozen' ? prior.occurredAt : input.occurredAt ?? new Date().toISOString();
      const events = this.listEvents({ projectId: input.projectId, phaseId: input.phaseId });
      if (prior) {
        if (prior.eventType !== 'phase.frozen'
          || prior.projectId !== input.projectId
          || prior.phaseId !== input.phaseId) {
          throw new Error(`task_control_freeze_idempotency_conflict:${prior.eventId}`);
        }
        const consumption = this.approvalConsumptionForFreezeIdempotency(input.idempotencyKey);
        if (!consumption || consumption.frozenEventId !== prior.eventId
          || consumption.projectId !== input.projectId
          || consumption.phaseId !== input.phaseId) {
          throw new Error(`task_control_freeze_consumption_inconsistent:${prior.eventId}`);
        }
        return {
          kind: 'frozen',
          validation: this.validatePhaseFreezeFromEvents(input.projectId, input.phaseId, checkedAt, events),
          event: prior,
        };
      }
      const principal = this.authenticate(input.authentication);
      const phase = reducePhase(events.filter(event => !event.taskGuid));
      if (!phase.designatedAcceptorId || phase.designatedAcceptorId !== principal.actorId) {
        throw new Error(`task_control_freeze_unauthorized_acceptor:${principal.actorId}`);
      }
      if (principal.actorRole !== 'acceptor') throw new Error(`task_control_freeze_unauthorized_role:${principal.actorRole}`);
      const taskSetSnapshot = [...phase.expectedTaskGuids].sort();
      const approval = this.authority?.verifyApproval({
        approval: input.approval, projectId: input.projectId, phaseId: input.phaseId,
        taskSetSnapshot, acceptorId: principal.actorId, now: checkedAt,
      });
      if (!approval || approval.projectId !== input.projectId || approval.phaseId !== input.phaseId
        || approval.acceptorId !== principal.actorId
        || JSON.stringify(exactTaskSetSnapshot(approval.taskSetSnapshot, 'verifiedApproval.taskSetSnapshot'))
          !== JSON.stringify(taskSetSnapshot)
        || timestampMs(approval.expiresAt, 'verifiedApproval.expiresAt') <= timestampMs(checkedAt, 'checkedAt')) {
        throw new Error('task_control_freeze_approval_unverified');
      }
      const approvalRef = controlledEvidenceRef(approval.approvalRef, 'verifiedApproval.approvalRef');
      if (this.getApprovalConsumption(approvalRef)) {
        throw new Error(`task_control_freeze_approval_already_consumed:${approvalRef}`);
      }
      const validation = this.validatePhaseFreezeFromEvents(input.projectId, input.phaseId, checkedAt, events);
      if (!validation.ok) return { kind: 'rejected', validation };
      const approvedAt = nonEmpty(approval.approvedAt, 'verifiedApproval.approvedAt');
      const snapshot = this.buildFreezeSnapshot(validation, events, checkedAt, principal.actorId, approvalRef, approvedAt);
      const result = this.appendEventLocked({
        eventId: input.eventId, eventType: 'phase.frozen', projectId: input.projectId, phaseId: input.phaseId,
        actorId: principal.actorId, actorRole: principal.actorRole, idempotencyKey: input.idempotencyKey,
        occurredAt: checkedAt, sourceRef: approvalRef, evidenceRef: input.evidenceRef, terminal: true,
        payload: { snapshot },
      }, true);
      if (result.kind === 'conflict') {
        throw new Error(`task_control_freeze_idempotency_conflict:${result.conflictEvent.eventId}`);
      }
      this.db.prepare(`INSERT INTO control_approval_consumptions(
        approval_ref,lark_app_id,project_id,phase_id,task_set_hash,acceptor_id,freeze_idempotency_key,frozen_event_id,approved_at,consumed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        approvalRef, this.larkAppId, input.projectId, input.phaseId, taskSetHash(taskSetSnapshot), principal.actorId,
        input.idempotencyKey, result.event.eventId, approvedAt, checkedAt,
      );
      return { kind: 'frozen', validation, event: result.event };
    });
  }
}
