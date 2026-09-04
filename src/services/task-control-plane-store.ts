/**
 * Minimal, isolated control-plane evidence store.
 *
 * The event ledger is the source of truth and is append-only. Task/phase state,
 * mappings, UNKNOWN boundaries, and freeze readiness are read-only projections
 * rebuilt from that ledger. Delivery attempts use a durable outbox plus an
 * append-only receipt log so an unavailable report relay is observable instead
 * of being mistaken for successful delivery.
 *
 * This module intentionally has no daemon wiring yet. It can be validated and
 * reviewed without changing live Botmux behavior.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabaseSync, type DatabaseSyncLike } from './sqlite-compat.js';

const SCHEMA_VERSION = 1;
const DATABASE_NAME = 'botmux-task-control-plane.sqlite';

export type TaskControlEventType =
  | 'phase.opened'
  | 'mapping.registered'
  | 'task.acceptance_requested'
  | 'task.accepted'
  | 'task.not_accepted'
  | 'task.acceptance_timed_out'
  | 'task.execution_started'
  | 'task.first_submitted'
  | 'task.reviewed'
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
  acceptorId: string;
  approvedAt: string;
}

export interface TaskControlAuthority {
  /** Resolve an opaque runtime-authenticated context. Caller-supplied ids/roles are never accepted. */
  authenticate(authentication: unknown): AuthenticatedTaskControlPrincipal | undefined;
  /** Verify an opaque approval proof against the exact phase and designated acceptor. */
  verifyApproval(input: {
    approval: unknown;
    projectId: string;
    phaseId: string;
    acceptorId: string;
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
  docToken?: string;
  docRevision?: number;
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

interface EventRow {
  seq: number | bigint;
  event_id: string;
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
  'task.execution_started': { from: ['accepted', 'blocked'], to: 'executing' },
  'task.first_submitted': { from: ['executing', 'rework'], to: 'submitted' },
  'task.reviewed': {
    from: ['submitted'],
    to: payload => {
      const verdict = parseReviewVerdict(payload.verdict);
      if (verdict === 'fail') return 'rework';
      if (verdict === 'unknown') return 'blocked';
      return 'reviewing';
    },
  },
  'task.rework_started': { from: ['reviewing', 'rework'], to: 'rework' },
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
    event_id TEXT NOT NULL UNIQUE,
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
    idempotency_key TEXT NOT NULL UNIQUE,
    causation_id TEXT,
    correlation_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
    error_class TEXT,
    ack_deadline TEXT,
    terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0,1)),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS control_events_phase_seq ON control_events(project_id,phase_id,seq);
  CREATE INDEX IF NOT EXISTS control_events_task_seq ON control_events(task_guid,seq);
  CREATE UNIQUE INDEX IF NOT EXISTS control_mapping_topic_unique
    ON control_events(topic_root_id) WHERE event_type='mapping.registered';
  CREATE UNIQUE INDEX IF NOT EXISTS control_mapping_task_unique
    ON control_events(task_guid) WHERE event_type='mapping.registered';

  CREATE TABLE IF NOT EXISTS control_outbox(
    outbox_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES control_events(event_id),
    destination_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','inflight','delivered','degraded')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    claim_token TEXT,
    claimed_at INTEGER,
    last_error TEXT,
    fallback_event_id TEXT REFERENCES control_events(event_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(event_id,destination_id)
  );
  CREATE INDEX IF NOT EXISTS control_outbox_due ON control_outbox(status,next_attempt_at,outbox_id);

  CREATE TABLE IF NOT EXISTS control_delivery_receipts(
    receipt_id TEXT PRIMARY KEY,
    outbox_id TEXT NOT NULL REFERENCES control_outbox(outbox_id),
    event_id TEXT NOT NULL REFERENCES control_events(event_id),
    destination_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('retry_scheduled','claim_recovered','delivered','degraded','fallback_verified')),
    error TEXT,
    fallback_event_id TEXT REFERENCES control_events(event_id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS control_receipts_event ON control_delivery_receipts(event_id,created_at,receipt_id);

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
  return sha256(JSON.stringify(canonicalize(semantic)));
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

function controlledEvidenceRef(value: unknown, field: string): string {
  const ref = nonEmpty(value, field);
  if (!/^(task-comment:[0-9]+|topic-message:om_[A-Za-z0-9]+|approval:[A-Za-z0-9][A-Za-z0-9._:-]*)$/.test(ref)) {
    throw new Error(`task_control_invalid:${field}`);
  }
  return ref;
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
  if (input.eventType === 'task.reviewed') {
    positiveInteger(payload.reviewRound, 'payload.reviewRound');
    nonEmpty(payload.reviewCommentId, 'payload.reviewCommentId');
    if (typeof payload.independent !== 'boolean') throw new Error('task_control_invalid:payload.independent');
    parseReviewVerdict(payload.verdict);
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
      case 'task.reviewed': {
        const verdict = parseReviewVerdict(event.payload.verdict);
        if (event.payload.independent === true) {
          independentReview = {
            eventId: event.eventId, seq: event.seq,
            reviewRound: positiveInteger(event.payload.reviewRound, 'payload.reviewRound'),
            reviewCommentId: nonEmpty(event.payload.reviewCommentId, 'payload.reviewCommentId'),
            reviewerId: event.actorId, independent: true, verdict,
            ...(optionalString(event.payload.docToken) ? { docToken: optionalString(event.payload.docToken)! } : {}),
            ...(typeof event.payload.docRevision === 'number' ? { docRevision: event.payload.docRevision } : {}),
          };
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
  ) {
    this.path = path;
  }

  static async open(dataDir: string, authority: TaskControlAuthority): Promise<TaskControlPlaneStore> {
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
      if (version === 0) {
        for (let attempt = 1; attempt <= 10; attempt++) {
          try {
            db.exec('BEGIN IMMEDIATE;');
            const lockedVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
            if (lockedVersion === 0) {
              db.exec(SCHEMA);
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
      return new TaskControlPlaneStore(db, path, false, authority);
    } catch (error) { db.close(); throw error; }
  }

  static async openReadOnly(dataDir: string): Promise<TaskControlPlaneStore> {
    const path = join(dataDir, DATABASE_NAME);
    const db = await openDatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=5000;');
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
      if (version !== SCHEMA_VERSION) throw new Error(`task_control_schema_unsupported:${version}`);
      return new TaskControlPlaneStore(db, path, true);
    } catch (error) { db.close(); throw error; }
  }

  close(): void { this.db.close(); }

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
    return (this.db.prepare('SELECT * FROM control_events ORDER BY seq').all() as unknown as EventRow[])
      .map(rowToEvent)
      .filter(event => (!filter.projectId || event.projectId === filter.projectId)
        && (!filter.phaseId || event.phaseId === filter.phaseId)
        && (!filter.taskGuid || event.taskGuid === filter.taskGuid));
  }

  private eventByIdempotencyKey(key: string): TaskControlEvent | undefined {
    const row = this.db.prepare('SELECT * FROM control_events WHERE idempotency_key=?').get(key) as unknown as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  private eventById(eventId: string): TaskControlEvent | undefined {
    const row = this.db.prepare('SELECT * FROM control_events WHERE event_id=?').get(eventId) as unknown as EventRow | undefined;
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
      const topicOwner = this.db.prepare(`SELECT task_guid FROM control_events WHERE event_type='mapping.registered' AND topic_root_id=?`)
        .get(input.topicRootId!) as { task_guid?: string } | undefined;
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

  private appendEventLocked(input: AuthenticatedAppendTaskControlEventInput, allowFrozen = false): AppendTaskControlEventResult {
    validateInput(input, allowFrozen);
    const payloadHash = eventPayloadHash(input);
    const existing = this.eventByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash === payloadHash) return { kind: 'duplicate', event: existing };
      const existingPhase = reducePhase(this.listEvents({ projectId: existing.projectId, phaseId: existing.phaseId })
        .filter(event => !event.taskGuid));
      if (existingPhase.lifecycleState === 'frozen') throw new Error(`task_control_phase_already_frozen:${existing.phaseId}`);
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
    if (phase.lifecycleState === 'frozen') throw new Error(`task_control_phase_already_frozen:${input.phaseId}`);
    this.validateMapping(input);
    return { kind: 'appended', event: this.insertEventLocked(input, payloadHash) };
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
      event_id,event_type,schema_version,project_id,phase_id,task_guid,topic_root_id,actor_id,actor_role,occurred_at,
      state_before,state_after,source_ref,payload_ref,evidence_ref,idempotency_key,causation_id,correlation_id,attempt,
      error_class,ack_deadline,terminal,payload_hash,payload_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.eventId, input.eventType, 1, input.projectId, input.phaseId, input.taskGuid ?? null, input.topicRootId ?? null,
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
        WHERE event_id=? AND destination_id=?`).get(
        fallback.deliveryEventId, fallback.destinationId,
      ) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`task_control_fallback_outbox_missing:${fallback.deliveryEventId}:${fallback.destinationId}`);
      const outbox = outboxFromRow(row);
      if (outbox.status !== 'degraded') throw new Error(`task_control_fallback_not_degraded:${outbox.outboxId}`);
      if (outbox.fallbackEventId) throw new Error(`task_control_fallback_already_verified:${outbox.outboxId}`);
      const linked = this.db.prepare(`UPDATE control_outbox SET fallback_event_id=?,updated_at=?
        WHERE outbox_id=? AND status='degraded' AND fallback_event_id IS NULL`).run(
        event.eventId, occurredAt, outbox.outboxId,
      );
      if (Number(linked.changes) !== 1) throw new Error(`task_control_fallback_link_failed:${outbox.outboxId}`);
      this.insertReceiptLocked(outbox, {
        state: 'fallback_verified', fallbackEventId: event.eventId, createdAt: occurredAt,
      });
    }
    const destinations = [...new Set(input.deliverTo ?? [])].sort();
    for (const destinationId of destinations) {
      const outboxId = stableId('out', event.eventId, destinationId);
      this.db.prepare(`INSERT INTO control_outbox(
        outbox_id,event_id,destination_id,status,attempts,next_attempt_at,created_at,updated_at
      ) VALUES(?,?,?,'pending',0,?,?,?)`).run(
        outboxId, event.eventId, destinationId, Date.parse(occurredAt) || Date.now(), occurredAt, occurredAt,
      );
    }
    return event;
  }

  getTaskProjection(taskGuid: string): TaskProjection {
    const projection = reduceTask(this.listEvents({ taskGuid })).projection;
    return { ...projection, taskGuid };
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
      JOIN control_events e ON e.event_id=o.event_id ORDER BY o.created_at,o.outbox_id`).all() as Record<string, unknown>[];
    return rows.map(outboxFromRow).filter(row => !filter.eventId || row.eventId === filter.eventId)
      .filter(row => {
        if (!filter.phaseId) return true;
        return this.eventById(row.eventId)?.phaseId === filter.phaseId;
      });
  }

  listReceipts(eventId?: string): DeliveryReceipt[] {
    return (this.db.prepare('SELECT * FROM control_delivery_receipts ORDER BY created_at,receipt_id').all() as Record<string, unknown>[])
      .map(receiptFromRow).filter(receipt => !eventId || receipt.eventId === eventId);
  }

  claimOutbox(input: { now: number; limit: number; claimToken: string }): DeliveryOutboxRow[] {
    nonEmpty(input.claimToken, 'claimToken');
    return this.withImmediateWrite(() => {
      const ids = (this.db.prepare(`SELECT outbox_id FROM control_outbox
        WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,outbox_id LIMIT ?`)
        .all(input.now, Math.max(1, Math.min(input.limit, 100))) as Array<{ outbox_id: string }>)
        .map(row => row.outbox_id);
      for (const outboxId of ids) {
        this.db.prepare(`UPDATE control_outbox SET status='inflight',attempts=attempts+1,claim_token=?,claimed_at=?,updated_at=?
          WHERE outbox_id=? AND status='pending'`).run(input.claimToken, input.now, new Date(input.now).toISOString(), outboxId);
      }
      const wanted = new Set(ids);
      return this.listOutbox().filter(row => wanted.has(row.outboxId) && row.claimToken === input.claimToken);
    });
  }

  settleOutboxDelivered(outboxId: string, claimToken: string, deliveredAt = new Date().toISOString()): boolean {
    return this.settleOutbox(outboxId, claimToken, { state: 'delivered', createdAt: deliveredAt });
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
        WHERE status='inflight' AND claimed_at<=? ORDER BY outbox_id`).all(now - staleAfterMs) as Record<string, unknown>[];
      for (const raw of rows) {
        const row = outboxFromRow(raw);
        this.db.prepare(`UPDATE control_outbox SET status='pending',claim_token=NULL,claimed_at=NULL,updated_at=?
          WHERE outbox_id=? AND status='inflight'`).run(recoveredAt, row.outboxId);
        this.insertReceiptLocked(row, {
          state: 'claim_recovered', error: 'delivery_claim_expired', createdAt: recoveredAt,
        });
      }
      return rows.length;
    });
  }

  private settleOutbox(outboxId: string, claimToken: string, input: {
    state: DeliveryAttemptReceiptState; error?: string; nextAttemptAt?: number; createdAt: string;
  }): boolean {
    nonEmpty(outboxId, 'outboxId');
    nonEmpty(claimToken, 'claimToken');
    return this.withImmediateWrite(() => {
      const row = this.db.prepare(`SELECT * FROM control_outbox WHERE outbox_id=? AND status='inflight' AND claim_token=?`)
        .get(outboxId, claimToken) as Record<string, unknown> | undefined;
      if (!row) return false;
      const outbox = outboxFromRow(row);
      const status: DeliveryOutboxStatus = input.state === 'retry_scheduled' ? 'pending' : input.state;
      this.db.prepare(`UPDATE control_outbox SET status=?,next_attempt_at=?,claim_token=NULL,claimed_at=NULL,last_error=?,fallback_event_id=NULL,updated_at=?
        WHERE outbox_id=? AND status='inflight' AND claim_token=?`).run(
        status, input.nextAttemptAt ?? outbox.nextAttemptAt, input.error ?? null, input.createdAt, outboxId, claimToken,
      );
      this.insertReceiptLocked(outbox, input);
      return true;
    });
  }

  private insertReceiptLocked(outbox: DeliveryOutboxRow, input: {
    state: DeliveryReceiptState; error?: string; fallbackEventId?: string; createdAt: string;
  }): void {
    this.db.prepare(`INSERT INTO control_delivery_receipts(
      receipt_id,outbox_id,event_id,destination_id,attempt,state,error,fallback_event_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      `rcpt_${randomUUID().replaceAll('-', '')}`, outbox.outboxId, outbox.eventId, outbox.destinationId, outbox.attempts,
      input.state, input.error ?? null, input.fallbackEventId ?? null, input.createdAt,
    );
  }

  private successfulDeliveryReceipt(outbox: DeliveryOutboxRow): DeliveryReceipt | undefined {
    const receipts = this.listReceipts(outbox.eventId)
      .filter(receipt => receipt.outboxId === outbox.outboxId);
    if (outbox.status === 'delivered') {
      return [...receipts].reverse().find(receipt => receipt.state === 'delivered');
    }
    if (outbox.status !== 'degraded' || !outbox.fallbackEventId) return undefined;
    const fallbackEvent = this.eventById(outbox.fallbackEventId);
    if (!fallbackEvent || fallbackEvent.eventType !== 'task.delivery_fallback_verified') return undefined;
    const fallback = parseDeliveryFallback(fallbackEvent.payload);
    if (fallback.deliveryEventId !== outbox.eventId || fallback.destinationId !== outbox.destinationId) return undefined;
    return [...receipts].reverse().find(receipt => receipt.state === 'fallback_verified'
      && receipt.fallbackEventId === outbox.fallbackEventId);
  }

  validatePhaseFreeze(projectId: string, phaseId: string, checkedAt = new Date().toISOString()): PhaseFreezeValidation {
    const events = this.listEvents({ projectId, phaseId });
    return this.validatePhaseFreezeFromEvents(projectId, phaseId, checkedAt, events);
  }

  private validatePhaseFreezeFromEvents(
    projectId: string, phaseId: string, checkedAt: string, events: readonly TaskControlEvent[],
  ): PhaseFreezeValidation {
    const issues: FreezeIssue[] = [];
    const phaseEvents = events.filter(event => !event.taskGuid);
    const phase = reducePhase(phaseEvents);
    const opened = [...phaseEvents].reverse().find(event => event.eventType === 'phase.opened');
    const freezeRequest = phase.latestFreezeRequest;
    if (!opened) issues.push({ code: 'phase_not_opened', message: 'phase.opened evidence is missing' });
    if (!freezeRequest) issues.push({ code: 'phase_freeze_not_requested', message: 'phase.freeze_requested evidence is missing' });
    if (phase.state !== 'freeze_pending' && phase.state !== 'frozen') {
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
    if (freezeRequest && JSON.stringify([...freezeRequest.taskGuids].sort()) !== JSON.stringify(expectedTaskGuids)) {
      issues.push({ code: 'phase_freeze_request_task_set_mismatch', message: 'freeze request task set differs from phase.opened snapshot', eventId: freezeRequest.eventId });
    }
    if (freezeRequest && freezeRequest.openIssueCodes.length > 0) {
      issues.push({ code: 'phase_freeze_request_open_issues', message: `freeze request carries open issues: ${freezeRequest.openIssueCodes.join(',')}`, eventId: freezeRequest.eventId });
    }
    for (const taskGuid of expectedTaskGuids) {
      const taskEvents = events.filter(event => event.taskGuid === taskGuid);
      const task = reduceTask(taskEvents).projection;
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
      if (task.mapping && review?.independent && review.reviewerId === task.mapping.ownerId) {
        issues.push({ code: 'reviewer_not_independent', message: 'reviewer is the mapped task owner', taskGuid, eventId: review.eventId });
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
    const freezeRequestEvent = freezeRequest ? events.find(event => event.eventId === freezeRequest.eventId) : undefined;
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
      const principal = this.authenticate(input.authentication);
      const prior = this.eventByIdempotencyKey(input.idempotencyKey);
      const checkedAt = prior?.eventType === 'phase.frozen' ? prior.occurredAt : input.occurredAt ?? new Date().toISOString();
      const events = this.listEvents({ projectId: input.projectId, phaseId: input.phaseId });
      const phase = reducePhase(events.filter(event => !event.taskGuid));
      if (!phase.designatedAcceptorId || phase.designatedAcceptorId !== principal.actorId) {
        throw new Error(`task_control_freeze_unauthorized_acceptor:${principal.actorId}`);
      }
      if (principal.actorRole !== 'acceptor') throw new Error(`task_control_freeze_unauthorized_role:${principal.actorRole}`);
      const approval = this.authority?.verifyApproval({
        approval: input.approval, projectId: input.projectId, phaseId: input.phaseId, acceptorId: principal.actorId,
      });
      if (!approval || approval.projectId !== input.projectId || approval.phaseId !== input.phaseId
        || approval.acceptorId !== principal.actorId) {
        throw new Error('task_control_freeze_approval_unverified');
      }
      const approvalRef = controlledEvidenceRef(approval.approvalRef, 'verifiedApproval.approvalRef');
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
      return { kind: 'frozen', validation, event: result.event };
    });
  }
}
