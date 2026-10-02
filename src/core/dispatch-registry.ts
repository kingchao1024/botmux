import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';

export type DispatchRegistry = Record<string, unknown>;

export interface DispatchOperationMatch {
  dispatchRoot: string;
  entry: Record<string, unknown>;
}

const TASK_CONTROL_TURN_ADMISSIONS_KEY = '__taskControlTurnAdmissionsV1';
const TASK_CONTROL_PHASE_A_OPERATIONS_KEY = '__taskControlPhaseAOperationsV1';
const TASK_CONTROL_PHASE_A_REPORTS_KEY = '__taskControlPhaseAReportsV1';
const TASK_CONTROL_SEED_OPERATIONS_KEY = '__taskControlSeedOperationsV1';
const TASK_CONTROL_KICKOFF_OPERATIONS_KEY = '__taskControlKickoffOperationsV1';
const TASK_CONTROL_SUCCESS_CERTIFICATES_KEY = '__taskControlSuccessCertificatesV1';
const TASK_CONTROL_TURN_ADMISSION_PER_ROOT_CAP = 32;
const TASK_CONTROL_TURN_ADMISSION_GLOBAL_CAP = 256;
const TASK_CONTROL_TURN_ADMISSION_TERMINAL_RETENTION_MS = 60 * 60_000;
const TASK_CONTROL_TURN_ADMISSION_EMPTY_CHAIN = `tcta1:${'0'.repeat(64)}`;
const TASK_CONTROL_PROVIDER_RETRY_WINDOW_MS = 54 * 60_000;

export interface TaskControlTurnAdmissionClaim {
  messageId: string;
  chatId: string;
  dispatchRoot: string;
  targetAppId: string;
  sessionId: string;
  workerGeneration?: number;
  state: 'pending' | 'active' | 'terminal';
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

type TaskControlTurnAdmissionClaimBase = Pick<
  TaskControlTurnAdmissionClaim,
  'messageId' | 'chatId' | 'dispatchRoot' | 'targetAppId' | 'sessionId'
>;

interface TaskControlTurnAdmissionRegistryV1 {
  claims: Record<string, TaskControlTurnAdmissionClaim>;
  terminalSummaries?: Record<string, {
    count: number;
    lastTerminalAt: string;
    chainedHash: string;
  }>;
  overflowMarkers?: Partial<Record<'perRoot' | 'global', {
    reason: 'per_root' | 'global';
    chatId: string;
    dispatchRoot: string;
    messageId: string;
    observedAt: string;
  }>>;
}

export interface TaskControlPhaseAAttemptCoordinates {
  wallTime: string;
  bootId: string;
  processStartedAt: string;
  monotonicMs: number;
}

export interface TaskControlProviderAttemptCoordinates {
  wallTime: string;
  bootId: string;
  processStartIdentity: string;
  monotonicMs: number;
}

export interface TaskControlSeedOperation {
  schemaVersion: 'TaskControlSeedOperation.v1';
  operationId: string;
  sourceAppId: string;
  targetChatId: string;
  messageType: 'text';
  payloadHash: string;
  providerUuid: string;
  attempt: TaskControlProviderAttemptCoordinates;
  state: 'pending' | 'delivered' | 'ambiguous';
  dispatchRoot?: string;
}

interface TaskControlSeedOperationRegistryV1 {
  operations: Record<string, TaskControlSeedOperation>;
}

export interface TaskControlKickoffOperation {
  schemaVersion: 'TaskControlKickoffOperation.v1';
  operationId: string;
  sourceAppId: string;
  chatId: string;
  dispatchRoot: string;
  fenceFingerprint: string;
  targetAppIds: string[];
  messageType: 'post';
  payloadHash: string;
  providerUuid: string;
  attempt: TaskControlProviderAttemptCoordinates;
  state: 'pending' | 'delivered' | 'ambiguous';
  messageId?: string;
}

interface TaskControlKickoffOperationRegistryV1 {
  operations: Record<string, TaskControlKickoffOperation>;
}

export interface TaskControlSuccessCertificate {
  schemaVersion: 'TaskControlSuccessCertificate.v1';
  operationId: string;
  chatId: string;
  fenceFingerprint: string;
  dispatchRoot: string;
  taskGuid: string;
  evidence: Record<string, unknown>;
  createdAt: string;
  certificateHash: string;
}

interface TaskControlSuccessCertificateRegistryV1 {
  certificates: Record<string, TaskControlSuccessCertificate>;
}

export interface TaskControlPhaseAOperation {
  schemaVersion: 'TaskControlPhaseAOperation.v1';
  operationId: string;
  chatId: string;
  fenceFingerprint: string;
  historicalDispatchRoot: string;
  historicalTaskGuid: string;
  targetAppId: string;
  payloadHash: string;
  providerUuid: string;
  attempt: TaskControlPhaseAAttemptCoordinates;
  state: 'pending' | 'delivered' | 'ambiguous';
  messageId?: string;
}

interface TaskControlPhaseAOperationRegistryV1 {
  operations: Record<string, TaskControlPhaseAOperation>;
}

export interface TaskControlPhaseAFailedReportClaim {
  schemaVersion: 'TaskControlPhaseAFailedReport.v1';
  operationId: string;
  fenceFingerprint: string;
  chatId: string;
  dispatchRoot: string;
  taskGuid: string;
  reporterAppId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  workerGeneration: number;
  reportRequestId: string;
  contentHash: string;
  logicalEvidenceKey: string;
  claimedAt: string;
}

interface TaskControlPhaseAFailedReportRegistryV1 {
  reports: Record<string, TaskControlPhaseAFailedReportClaim>;
}

function validatedTaskControlPhaseAFailedReport(
  value: TaskControlPhaseAFailedReportClaim,
): TaskControlPhaseAFailedReportClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 'TaskControlPhaseAFailedReport.v1'
    || !/^[a-f0-9]{50}$/.test(value.operationId)
    || !/^tccq1:[a-f0-9]{64}$/.test(value.fenceFingerprint)
    || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(value.chatId)
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(value.dispatchRoot)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.taskGuid)
    || !value.reporterAppId || !value.sourceSessionId
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(value.sourceTurnId)
    || !Number.isSafeInteger(value.workerGeneration) || value.workerGeneration < 1
    || !/^report:[a-f0-9]{64}$/.test(value.reportRequestId)
    || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || !/^tcpar1:[a-f0-9]{64}$/.test(value.logicalEvidenceKey)
    || !exactIsoTime(value.claimedAt)) {
    throw new Error('project_task_control_phase_a_report_registry_invalid');
  }
  const expectedLogicalEvidenceKey = `tcpar1:${createHash('sha256').update(JSON.stringify({
    schemaVersion: 'TaskControlPhaseAFailedReport.v1',
    operationId: value.operationId,
    sourceTurnId: value.sourceTurnId,
    reportRequestId: value.reportRequestId,
    contentHash: value.contentHash,
  })).digest('hex')}`;
  if (value.logicalEvidenceKey !== expectedLogicalEvidenceKey
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      'chatId', 'claimedAt', 'contentHash', 'dispatchRoot', 'fenceFingerprint',
      'logicalEvidenceKey', 'operationId', 'reportRequestId', 'reporterAppId',
      'schemaVersion', 'sourceSessionId', 'sourceTurnId', 'taskGuid', 'workerGeneration',
    ])) {
    throw new Error('project_task_control_phase_a_report_registry_invalid');
  }
  return value;
}

/** Stable provider idempotency token; Feishu message UUIDs are capped at 50 characters. */
export function createDispatchOperationId(input: object): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 50);
}

function readDispatchRegistry(path: string): DispatchRegistry {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('orchestrate-dispatch.json must contain an object');
  }
  return parsed as DispatchRegistry;
}

function taskControlTurnAdmissions(registry: DispatchRegistry): TaskControlTurnAdmissionRegistryV1 {
  const value = registry[TASK_CONTROL_TURN_ADMISSIONS_KEY];
  if (value === undefined) {
    const created: TaskControlTurnAdmissionRegistryV1 = { claims: {} };
    registry[TASK_CONTROL_TURN_ADMISSIONS_KEY] = created;
    return created;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('task_control_turn_admission_registry_invalid');
  }
  const claims = (value as { claims?: unknown }).claims;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('task_control_turn_admission_registry_invalid');
  }
  return value as unknown as TaskControlTurnAdmissionRegistryV1;
}

function taskControlPhaseAOperations(registry: DispatchRegistry): TaskControlPhaseAOperationRegistryV1 {
  const value = registry[TASK_CONTROL_PHASE_A_OPERATIONS_KEY];
  if (value === undefined) {
    const created: TaskControlPhaseAOperationRegistryV1 = { operations: {} };
    registry[TASK_CONTROL_PHASE_A_OPERATIONS_KEY] = created;
    return created;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('project_task_control_phase_a_operation_registry_invalid');
  }
  const operations = (value as { operations?: unknown }).operations;
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) {
    throw new Error('project_task_control_phase_a_operation_registry_invalid');
  }
  return value as unknown as TaskControlPhaseAOperationRegistryV1;
}

function taskControlSeedOperations(registry: DispatchRegistry): TaskControlSeedOperationRegistryV1 {
  const value = registry[TASK_CONTROL_SEED_OPERATIONS_KEY];
  if (value === undefined) {
    const created: TaskControlSeedOperationRegistryV1 = { operations: {} };
    registry[TASK_CONTROL_SEED_OPERATIONS_KEY] = created;
    return created;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('project_task_control_seed_operation_registry_invalid');
  }
  const operations = (value as { operations?: unknown }).operations;
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) {
    throw new Error('project_task_control_seed_operation_registry_invalid');
  }
  return value as unknown as TaskControlSeedOperationRegistryV1;
}

function taskControlKickoffOperations(registry: DispatchRegistry): TaskControlKickoffOperationRegistryV1 {
  const value = registry[TASK_CONTROL_KICKOFF_OPERATIONS_KEY];
  if (value === undefined) {
    const created: TaskControlKickoffOperationRegistryV1 = { operations: {} };
    registry[TASK_CONTROL_KICKOFF_OPERATIONS_KEY] = created;
    return created;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('project_task_control_kickoff_operation_registry_invalid');
  }
  const operations = (value as { operations?: unknown }).operations;
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) {
    throw new Error('project_task_control_kickoff_operation_registry_invalid');
  }
  return value as unknown as TaskControlKickoffOperationRegistryV1;
}

function taskControlSuccessCertificates(registry: DispatchRegistry): TaskControlSuccessCertificateRegistryV1 {
  const value = registry[TASK_CONTROL_SUCCESS_CERTIFICATES_KEY];
  if (value === undefined) {
    const created: TaskControlSuccessCertificateRegistryV1 = { certificates: {} };
    registry[TASK_CONTROL_SUCCESS_CERTIFICATES_KEY] = created;
    return created;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('project_task_control_success_certificate_registry_invalid');
  }
  const certificates = (value as { certificates?: unknown }).certificates;
  if (!certificates || typeof certificates !== 'object' || Array.isArray(certificates)) {
    throw new Error('project_task_control_success_certificate_registry_invalid');
  }
  return value as unknown as TaskControlSuccessCertificateRegistryV1;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function taskControlSuccessCertificateHash(
  value: Omit<TaskControlSuccessCertificate, 'certificateHash'>,
): string {
  return `tcsc1:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function validatedTaskControlSuccessCertificate(
  value: TaskControlSuccessCertificate,
): TaskControlSuccessCertificate {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 'TaskControlSuccessCertificate.v1'
    || !/^[a-f0-9]{50}$/.test(value.operationId)
    || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(value.chatId)
    || !/^tccq1:[a-f0-9]{64}$/.test(value.fenceFingerprint)
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(value.dispatchRoot)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.taskGuid)
    || !value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)
    || !exactIsoTime(value.createdAt)
    || !/^tcsc1:[a-f0-9]{64}$/.test(value.certificateHash)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      'certificateHash', 'chatId', 'createdAt', 'dispatchRoot', 'evidence',
      'fenceFingerprint', 'operationId', 'schemaVersion', 'taskGuid',
    ])) {
    throw new Error('project_task_control_success_certificate_registry_invalid');
  }
  const { certificateHash, ...facts } = value;
  if (certificateHash !== taskControlSuccessCertificateHash(facts)) {
    throw new Error('project_task_control_success_certificate_registry_invalid');
  }
  return value;
}

function taskControlPhaseAFailedReports(registry: DispatchRegistry): TaskControlPhaseAFailedReportRegistryV1 {
  const value = registry[TASK_CONTROL_PHASE_A_REPORTS_KEY];
  if (value === undefined) {
    const created: TaskControlPhaseAFailedReportRegistryV1 = { reports: {} };
    registry[TASK_CONTROL_PHASE_A_REPORTS_KEY] = created;
    return created;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('project_task_control_phase_a_report_registry_invalid');
  }
  const reports = (value as { reports?: unknown }).reports;
  if (!reports || typeof reports !== 'object' || Array.isArray(reports)) {
    throw new Error('project_task_control_phase_a_report_registry_invalid');
  }
  return value as unknown as TaskControlPhaseAFailedReportRegistryV1;
}

function normalizeTaskControlTurnClaimBase(input: TaskControlTurnAdmissionClaimBase): TaskControlTurnAdmissionClaimBase {
  const normalized = {
    messageId: input.messageId.trim(), chatId: input.chatId.trim(),
    dispatchRoot: input.dispatchRoot.trim(), targetAppId: input.targetAppId.trim(),
    sessionId: input.sessionId.trim(),
  };
  if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(normalized.messageId)
    || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(normalized.chatId)
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(normalized.dispatchRoot)
    || !normalized.targetAppId || !normalized.sessionId) {
    throw new Error('project_task_control_turn_claim_invalid');
  }
  return normalized;
}

function sameTaskControlTurnClaim(
  claim: TaskControlTurnAdmissionClaim,
  input: TaskControlTurnAdmissionClaimBase,
): boolean {
  return claim.messageId === input.messageId && claim.chatId === input.chatId
    && claim.dispatchRoot === input.dispatchRoot && claim.targetAppId === input.targetAppId
    && claim.sessionId === input.sessionId;
}

function taskControlTurnAdmissionEntry(
  admissions: TaskControlTurnAdmissionRegistryV1,
  input: Pick<TaskControlTurnAdmissionClaimBase, 'messageId' | 'targetAppId'>,
): [string, TaskControlTurnAdmissionClaim] | undefined {
  const matches = Object.entries(admissions.claims).filter(([, claim]) => (
    claim.messageId === input.messageId && claim.targetAppId === input.targetAppId
  ));
  if (matches.length > 1) throw new Error('project_task_control_turn_claim_registry_invalid');
  return matches[0];
}

function taskControlTurnAdmissionStorageKey(
  admissions: TaskControlTurnAdmissionRegistryV1,
  input: Pick<TaskControlTurnAdmissionClaimBase, 'messageId' | 'targetAppId'>,
): string {
  if (admissions.claims[input.messageId] === undefined) return input.messageId;
  return `${input.messageId}:${createHash('sha256').update(input.targetAppId).digest('hex').slice(0, 16)}`;
}

function writeDispatchRegistry(path: string, registry: DispatchRegistry): void {
  atomicWriteFileSync(path, JSON.stringify(registry, null, 2));
}

function exactIsoTime(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function canonicalTaskControlPhaseAOperation(input: Omit<
  TaskControlPhaseAOperation,
  'schemaVersion' | 'providerUuid' | 'state'
>): Omit<TaskControlPhaseAOperation, 'state'> {
  const operationId = input.operationId.trim();
  const chatId = input.chatId.trim();
  const fenceFingerprint = input.fenceFingerprint.trim().toLowerCase();
  const historicalDispatchRoot = input.historicalDispatchRoot.trim();
  const historicalTaskGuid = input.historicalTaskGuid.trim().toLowerCase();
  const targetAppId = input.targetAppId.trim();
  const payloadHash = input.payloadHash.trim().toLowerCase();
  const attempt = {
    wallTime: input.attempt.wallTime,
    bootId: input.attempt.bootId.trim(),
    processStartedAt: input.attempt.processStartedAt,
    monotonicMs: input.attempt.monotonicMs,
  };
  if (!/^[a-f0-9]{50}$/.test(operationId)
    || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(chatId)
    || !/^tccq1:[a-f0-9]{64}$/.test(fenceFingerprint)
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(historicalDispatchRoot)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(historicalTaskGuid)
    || !targetAppId
    || !/^[a-f0-9]{64}$/.test(payloadHash)
    || !exactIsoTime(attempt.wallTime)
    || !attempt.bootId || attempt.bootId.length > 200
    || !exactIsoTime(attempt.processStartedAt)
    || !Number.isFinite(attempt.monotonicMs) || attempt.monotonicMs < 0) {
    throw new Error('project_task_control_phase_a_operation_invalid');
  }
  const providerUuid = createDispatchOperationId({
    schemaVersion: 'TaskControlPhaseAProvider.v1',
    effect: 'phase_a_instruction',
    operationId,
    chatId,
    historicalDispatchRoot,
    targetAppId,
    payloadHash,
  });
  return {
    schemaVersion: 'TaskControlPhaseAOperation.v1',
    operationId,
    chatId,
    fenceFingerprint,
    historicalDispatchRoot,
    historicalTaskGuid,
    targetAppId,
    payloadHash,
    providerUuid,
    attempt,
    ...(input.messageId ? { messageId: input.messageId.trim() } : {}),
  };
}

function canonicalTaskControlSeedOperation(input: Omit<
  TaskControlSeedOperation,
  'schemaVersion' | 'providerUuid' | 'state'
>): Omit<TaskControlSeedOperation, 'state'> {
  const operationId = input.operationId.trim();
  const sourceAppId = input.sourceAppId.trim();
  const targetChatId = input.targetChatId.trim();
  const payloadHash = input.payloadHash.trim().toLowerCase();
  const attempt = {
    wallTime: input.attempt.wallTime,
    bootId: input.attempt.bootId.trim(),
    processStartIdentity: input.attempt.processStartIdentity.trim(),
    monotonicMs: input.attempt.monotonicMs,
  };
  if (!/^[a-f0-9]{50}$/.test(operationId)
    || !/^cli_[A-Za-z0-9_-]{1,128}$/.test(sourceAppId)
    || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(targetChatId)
    || input.messageType !== 'text'
    || !/^[a-f0-9]{64}$/.test(payloadHash)
    || !exactIsoTime(attempt.wallTime)
    || !attempt.bootId || attempt.bootId.length > 200
    || !attempt.processStartIdentity || attempt.processStartIdentity.length > 200
    || !Number.isFinite(attempt.monotonicMs) || attempt.monotonicMs < 0) {
    throw new Error('project_task_control_seed_operation_invalid');
  }
  const providerUuid = createDispatchOperationId({
    schemaVersion: 'TaskControlProviderUuid.v1',
    effect: 'seed_root',
    operationId,
    targetChatId,
    targetRoot: null,
    messageType: 'text',
    payloadHash,
  });
  return {
    schemaVersion: 'TaskControlSeedOperation.v1', operationId, sourceAppId,
    targetChatId, messageType: 'text', payloadHash, providerUuid, attempt,
    ...(input.dispatchRoot ? { dispatchRoot: input.dispatchRoot.trim() } : {}),
  };
}

function validatedTaskControlSeedOperation(value: TaskControlSeedOperation): TaskControlSeedOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 'TaskControlSeedOperation.v1'
    || (value.state !== 'pending' && value.state !== 'delivered' && value.state !== 'ambiguous')
    || (value.state === 'delivered') !== (typeof value.dispatchRoot === 'string')
    || (value.dispatchRoot !== undefined && !/^om_[A-Za-z0-9_-]{1,128}$/.test(value.dispatchRoot))) {
    throw new Error('project_task_control_seed_operation_registry_invalid');
  }
  const canonical = canonicalTaskControlSeedOperation({
    operationId: value.operationId,
    sourceAppId: value.sourceAppId,
    targetChatId: value.targetChatId,
    messageType: value.messageType,
    payloadHash: value.payloadHash,
    attempt: value.attempt,
    ...(value.dispatchRoot ? { dispatchRoot: value.dispatchRoot } : {}),
  });
  const expectedKeys = [
    'attempt', 'messageType', 'operationId', 'payloadHash', 'providerUuid',
    'schemaVersion', 'sourceAppId', 'state', 'targetChatId',
    ...(value.dispatchRoot ? ['dispatchRoot'] : []),
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value.operationId !== canonical.operationId
    || value.sourceAppId !== canonical.sourceAppId
    || value.targetChatId !== canonical.targetChatId
    || value.messageType !== canonical.messageType
    || value.payloadHash !== canonical.payloadHash
    || value.providerUuid !== canonical.providerUuid
    || value.attempt.wallTime !== canonical.attempt.wallTime
    || value.attempt.bootId !== canonical.attempt.bootId
    || value.attempt.processStartIdentity !== canonical.attempt.processStartIdentity
    || value.attempt.monotonicMs !== canonical.attempt.monotonicMs
    || value.dispatchRoot !== canonical.dispatchRoot) {
    throw new Error('project_task_control_seed_operation_registry_invalid');
  }
  return value;
}

function taskControlSeedOperationWithInvalidAttempt(
  value: unknown,
): TaskControlSeedOperation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const stableKeys = [
    'messageType', 'operationId', 'payloadHash', 'providerUuid',
    'schemaVersion', 'sourceAppId', 'state', 'targetChatId',
  ];
  const expectedKeys = [
    ...stableKeys,
    ...(Object.hasOwn(record, 'attempt') ? ['attempt'] : []),
  ].sort();
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
    || record.schemaVersion !== 'TaskControlSeedOperation.v1'
    || (record.state !== 'pending' && record.state !== 'ambiguous')
    || typeof record.operationId !== 'string' || !/^[a-f0-9]{50}$/.test(record.operationId)
    || typeof record.sourceAppId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,128}$/.test(record.sourceAppId)
    || typeof record.targetChatId !== 'string' || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(record.targetChatId)
    || record.messageType !== 'text'
    || typeof record.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.payloadHash)
    || record.providerUuid !== createDispatchOperationId({
      schemaVersion: 'TaskControlProviderUuid.v1',
      effect: 'seed_root',
      operationId: record.operationId,
      targetChatId: record.targetChatId,
      targetRoot: null,
      messageType: 'text',
      payloadHash: record.payloadHash,
    })) {
    return undefined;
  }
  try {
    canonicalTaskControlSeedOperation({
      operationId: record.operationId,
      sourceAppId: record.sourceAppId,
      targetChatId: record.targetChatId,
      messageType: 'text',
      payloadHash: record.payloadHash,
      attempt: record.attempt as TaskControlProviderAttemptCoordinates,
    });
    return undefined;
  } catch {
    return record as unknown as TaskControlSeedOperation;
  }
}

export function beginTaskControlSeedOperationSync(
  path: string,
  input: Omit<TaskControlSeedOperation, 'schemaVersion' | 'providerUuid' | 'state' | 'dispatchRoot'>,
): TaskControlSeedOperation {
  const canonical = canonicalTaskControlSeedOperation(input);
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const operations = taskControlSeedOperations(registry).operations;
    const existingValue = operations[canonical.operationId];
    let existing: TaskControlSeedOperation | undefined;
    if (existingValue) {
      try {
        existing = validatedTaskControlSeedOperation(existingValue);
      } catch (error) {
        const invalidAttempt = taskControlSeedOperationWithInvalidAttempt(existingValue);
        if (!invalidAttempt
          || invalidAttempt.operationId !== canonical.operationId
          || invalidAttempt.sourceAppId !== canonical.sourceAppId
          || invalidAttempt.targetChatId !== canonical.targetChatId
          || invalidAttempt.messageType !== canonical.messageType
          || invalidAttempt.payloadHash !== canonical.payloadHash
          || invalidAttempt.providerUuid !== canonical.providerUuid) {
          throw error;
        }
        const ambiguous: TaskControlSeedOperation = { ...invalidAttempt, state: 'ambiguous' };
        if (invalidAttempt.state !== 'ambiguous') {
          operations[canonical.operationId] = ambiguous;
          writeDispatchRegistry(path, registry);
        }
        return structuredClone(ambiguous);
      }
    }
    if (existing) {
      if (existing.operationId !== canonical.operationId
        || existing.sourceAppId !== canonical.sourceAppId
        || existing.targetChatId !== canonical.targetChatId
        || existing.messageType !== canonical.messageType
        || existing.payloadHash !== canonical.payloadHash
        || existing.providerUuid !== canonical.providerUuid) {
        throw new Error('project_task_control_seed_operation_conflict');
      }
      if (existing.state !== 'pending') return structuredClone(existing);
      const elapsedMs = canonical.attempt.monotonicMs - existing.attempt.monotonicMs;
      const safeRetry = canonical.attempt.bootId === existing.attempt.bootId
        && canonical.attempt.processStartIdentity === existing.attempt.processStartIdentity
        && Number.isFinite(elapsedMs) && elapsedMs >= 0
        && elapsedMs < TASK_CONTROL_PROVIDER_RETRY_WINDOW_MS;
      if (safeRetry) return structuredClone(existing);
      const ambiguous: TaskControlSeedOperation = { ...existing, state: 'ambiguous' };
      operations[canonical.operationId] = ambiguous;
      writeDispatchRegistry(path, registry);
      return structuredClone(ambiguous);
    }
    const created: TaskControlSeedOperation = { ...canonical, state: 'pending' };
    operations[canonical.operationId] = created;
    writeDispatchRegistry(path, registry);
    return structuredClone(created);
  });
}

export function completeTaskControlSeedOperationSync(
  path: string,
  input: { operationId: string; dispatchRoot: string },
): TaskControlSeedOperation {
  const operationId = input.operationId.trim();
  const dispatchRoot = input.dispatchRoot.trim();
  if (!/^[a-f0-9]{50}$/.test(operationId)
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(dispatchRoot)) {
    throw new Error('project_task_control_seed_operation_invalid');
  }
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const operations = taskControlSeedOperations(registry).operations;
    const existingValue = operations[operationId];
    if (!existingValue) throw new Error('project_task_control_seed_operation_missing');
    const existing = validatedTaskControlSeedOperation(existingValue);
    if (existing.state === 'delivered') {
      if (existing.dispatchRoot !== dispatchRoot) {
        throw new Error('project_task_control_seed_operation_conflict');
      }
      return structuredClone(existing);
    }
    if (existing.state !== 'pending') {
      throw new Error('project_task_control_seed_operation_ambiguous');
    }
    const delivered: TaskControlSeedOperation = { ...existing, state: 'delivered', dispatchRoot };
    operations[operationId] = delivered;
    writeDispatchRegistry(path, registry);
    return structuredClone(delivered);
  });
}

export function readTaskControlSeedOperation(
  path: string,
  operationId: string,
): TaskControlSeedOperation | undefined {
  const normalized = operationId.trim();
  if (!/^[a-f0-9]{50}$/.test(normalized)) return undefined;
  const registry = readDispatchRegistry(path);
  const value = registry[TASK_CONTROL_SEED_OPERATIONS_KEY];
  if (value === undefined) return undefined;
  const operation = taskControlSeedOperations(registry).operations[normalized];
  if (!operation) return undefined;
  try {
    return structuredClone(validatedTaskControlSeedOperation(operation));
  } catch (error) {
    const invalidAttempt = taskControlSeedOperationWithInvalidAttempt(operation);
    if (!invalidAttempt) throw error;
    return structuredClone(invalidAttempt);
  }
}

function canonicalTaskControlKickoffOperation(input: Omit<
  TaskControlKickoffOperation,
  'schemaVersion' | 'providerUuid' | 'state'
>): Omit<TaskControlKickoffOperation, 'state'> {
  const operationId = input.operationId.trim();
  const sourceAppId = input.sourceAppId.trim();
  const chatId = input.chatId.trim();
  const dispatchRoot = input.dispatchRoot.trim();
  const fenceFingerprint = input.fenceFingerprint.trim().toLowerCase();
  const targetAppIds = [...new Set(input.targetAppIds.map(value => value.trim()).filter(Boolean))].sort();
  const payloadHash = input.payloadHash.trim().toLowerCase();
  const attempt = {
    wallTime: input.attempt.wallTime,
    bootId: input.attempt.bootId.trim(),
    processStartIdentity: input.attempt.processStartIdentity.trim(),
    monotonicMs: input.attempt.monotonicMs,
  };
  if (!/^[a-f0-9]{50}$/.test(operationId)
    || !/^cli_[A-Za-z0-9_-]{1,128}$/.test(sourceAppId)
    || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(chatId)
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(dispatchRoot)
    || !/^tccq1:[a-f0-9]{64}$/.test(fenceFingerprint)
    || targetAppIds.length === 0
    || targetAppIds.some(value => !/^cli_[A-Za-z0-9_-]{1,128}$/.test(value))
    || input.messageType !== 'post'
    || !/^[a-f0-9]{64}$/.test(payloadHash)
    || !exactIsoTime(attempt.wallTime)
    || !attempt.bootId || attempt.bootId.length > 200
    || !attempt.processStartIdentity || attempt.processStartIdentity.length > 200
    || !Number.isFinite(attempt.monotonicMs) || attempt.monotonicMs < 0) {
    throw new Error('project_task_control_kickoff_operation_invalid');
  }
  const providerUuid = createDispatchOperationId({
    schemaVersion: 'TaskControlProviderUuid.v1',
    effect: 'kickoff_thread',
    operationId,
    targetChatId: chatId,
    targetRoot: dispatchRoot,
    messageType: 'post',
    payloadHash,
  });
  return {
    schemaVersion: 'TaskControlKickoffOperation.v1', operationId, sourceAppId,
    chatId, dispatchRoot, fenceFingerprint, targetAppIds, messageType: 'post',
    payloadHash, providerUuid, attempt,
    ...(input.messageId ? { messageId: input.messageId.trim() } : {}),
  };
}

function validatedTaskControlKickoffOperation(
  value: TaskControlKickoffOperation,
): TaskControlKickoffOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 'TaskControlKickoffOperation.v1'
    || (value.state !== 'pending' && value.state !== 'delivered' && value.state !== 'ambiguous')
    || (value.state === 'delivered') !== (typeof value.messageId === 'string')
    || (value.messageId !== undefined && !/^om_[A-Za-z0-9_-]{1,128}$/.test(value.messageId))) {
    throw new Error('project_task_control_kickoff_operation_registry_invalid');
  }
  const canonical = canonicalTaskControlKickoffOperation({
    operationId: value.operationId,
    sourceAppId: value.sourceAppId,
    chatId: value.chatId,
    dispatchRoot: value.dispatchRoot,
    fenceFingerprint: value.fenceFingerprint,
    targetAppIds: value.targetAppIds,
    messageType: value.messageType,
    payloadHash: value.payloadHash,
    attempt: value.attempt,
    ...(value.messageId ? { messageId: value.messageId } : {}),
  });
  const expectedKeys = [
    'attempt', 'chatId', 'dispatchRoot', 'fenceFingerprint', 'messageType',
    'operationId', 'payloadHash', 'providerUuid', 'schemaVersion', 'sourceAppId',
    'state', 'targetAppIds', ...(value.messageId ? ['messageId'] : []),
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value.operationId !== canonical.operationId
    || value.sourceAppId !== canonical.sourceAppId
    || value.chatId !== canonical.chatId
    || value.dispatchRoot !== canonical.dispatchRoot
    || value.fenceFingerprint !== canonical.fenceFingerprint
    || JSON.stringify(value.targetAppIds) !== JSON.stringify(canonical.targetAppIds)
    || value.messageType !== canonical.messageType
    || value.payloadHash !== canonical.payloadHash
    || value.providerUuid !== canonical.providerUuid
    || value.attempt.wallTime !== canonical.attempt.wallTime
    || value.attempt.bootId !== canonical.attempt.bootId
    || value.attempt.processStartIdentity !== canonical.attempt.processStartIdentity
    || value.attempt.monotonicMs !== canonical.attempt.monotonicMs
    || value.messageId !== canonical.messageId) {
    throw new Error('project_task_control_kickoff_operation_registry_invalid');
  }
  return value;
}

export function beginTaskControlKickoffOperationSync(
  path: string,
  input: Omit<TaskControlKickoffOperation, 'schemaVersion' | 'providerUuid' | 'state' | 'messageId'>,
): TaskControlKickoffOperation {
  const canonical = canonicalTaskControlKickoffOperation(input);
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const operations = taskControlKickoffOperations(registry).operations;
    const existingValue = operations[canonical.operationId];
    const existing = existingValue ? validatedTaskControlKickoffOperation(existingValue) : undefined;
    if (existing) {
      const sameOperation = existing.operationId === canonical.operationId
        && existing.sourceAppId === canonical.sourceAppId
        && existing.chatId === canonical.chatId
        && existing.dispatchRoot === canonical.dispatchRoot
        && existing.fenceFingerprint === canonical.fenceFingerprint
        && JSON.stringify(existing.targetAppIds) === JSON.stringify(canonical.targetAppIds)
        && existing.messageType === canonical.messageType
        && existing.payloadHash === canonical.payloadHash
        && existing.providerUuid === canonical.providerUuid;
      if (!sameOperation) throw new Error('project_task_control_kickoff_operation_conflict');
      if (existing.state !== 'pending') return structuredClone(existing);
      const elapsedMs = canonical.attempt.monotonicMs - existing.attempt.monotonicMs;
      const safeRetry = canonical.attempt.bootId === existing.attempt.bootId
        && canonical.attempt.processStartIdentity === existing.attempt.processStartIdentity
        && Number.isFinite(elapsedMs) && elapsedMs >= 0
        && elapsedMs < TASK_CONTROL_PROVIDER_RETRY_WINDOW_MS;
      if (safeRetry) return structuredClone(existing);
      const ambiguous: TaskControlKickoffOperation = { ...existing, state: 'ambiguous' };
      operations[canonical.operationId] = ambiguous;
      writeDispatchRegistry(path, registry);
      return structuredClone(ambiguous);
    }
    const created: TaskControlKickoffOperation = { ...canonical, state: 'pending' };
    operations[canonical.operationId] = created;
    writeDispatchRegistry(path, registry);
    return structuredClone(created);
  });
}

export function completeTaskControlKickoffOperationSync(
  path: string,
  input: { operationId: string; messageId: string },
): TaskControlKickoffOperation {
  const operationId = input.operationId.trim();
  const messageId = input.messageId.trim();
  if (!/^[a-f0-9]{50}$/.test(operationId)
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(messageId)) {
    throw new Error('project_task_control_kickoff_operation_invalid');
  }
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const operations = taskControlKickoffOperations(registry).operations;
    const existingValue = operations[operationId];
    if (!existingValue) throw new Error('project_task_control_kickoff_operation_missing');
    const existing = validatedTaskControlKickoffOperation(existingValue);
    if (existing.state === 'delivered') {
      if (existing.messageId !== messageId) {
        throw new Error('project_task_control_kickoff_operation_conflict');
      }
      return structuredClone(existing);
    }
    if (existing.state !== 'pending') {
      throw new Error('project_task_control_kickoff_operation_ambiguous');
    }
    const delivered: TaskControlKickoffOperation = { ...existing, state: 'delivered', messageId };
    operations[operationId] = delivered;
    writeDispatchRegistry(path, registry);
    return structuredClone(delivered);
  });
}

export function markTaskControlKickoffOperationAmbiguousSync(
  path: string,
  operationId: string,
): TaskControlKickoffOperation {
  const normalized = operationId.trim();
  if (!/^[a-f0-9]{50}$/.test(normalized)) {
    throw new Error('project_task_control_kickoff_operation_invalid');
  }
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const operations = taskControlKickoffOperations(registry).operations;
    const existingValue = operations[normalized];
    if (!existingValue) throw new Error('project_task_control_kickoff_operation_missing');
    const existing = validatedTaskControlKickoffOperation(existingValue);
    if (existing.state !== 'pending') return structuredClone(existing);
    const ambiguous: TaskControlKickoffOperation = { ...existing, state: 'ambiguous' };
    operations[normalized] = ambiguous;
    writeDispatchRegistry(path, registry);
    return structuredClone(ambiguous);
  });
}

export function readTaskControlKickoffOperation(
  path: string,
  operationId: string,
): TaskControlKickoffOperation | undefined {
  const normalized = operationId.trim();
  if (!/^[a-f0-9]{50}$/.test(normalized)) return undefined;
  const registry = readDispatchRegistry(path);
  const value = registry[TASK_CONTROL_KICKOFF_OPERATIONS_KEY];
  if (value === undefined) return undefined;
  const operation = taskControlKickoffOperations(registry).operations[normalized];
  return operation ? structuredClone(validatedTaskControlKickoffOperation(operation)) : undefined;
}

export function persistTaskControlSuccessCertificateSync(
  path: string,
  input: Omit<TaskControlSuccessCertificate, 'schemaVersion' | 'certificateHash'>,
): TaskControlSuccessCertificate {
  const facts: Omit<TaskControlSuccessCertificate, 'certificateHash'> = {
    schemaVersion: 'TaskControlSuccessCertificate.v1',
    operationId: input.operationId.trim(),
    chatId: input.chatId.trim(),
    fenceFingerprint: input.fenceFingerprint.trim().toLowerCase(),
    dispatchRoot: input.dispatchRoot.trim(),
    taskGuid: input.taskGuid.trim().toLowerCase(),
    evidence: structuredClone(input.evidence),
    createdAt: input.createdAt,
  };
  const certificate = validatedTaskControlSuccessCertificate({
    ...facts,
    certificateHash: taskControlSuccessCertificateHash(facts),
  });
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const certificates = taskControlSuccessCertificates(registry).certificates;
    const existingValue = certificates[certificate.operationId];
    const existing = existingValue
      ? validatedTaskControlSuccessCertificate(existingValue)
      : undefined;
    if (existing) {
      const exactReplay = existing.operationId === certificate.operationId
        && existing.chatId === certificate.chatId
        && existing.fenceFingerprint === certificate.fenceFingerprint
        && existing.dispatchRoot === certificate.dispatchRoot
        && existing.taskGuid === certificate.taskGuid
        && canonicalJson(existing.evidence) === canonicalJson(certificate.evidence);
      if (!exactReplay) throw new Error('project_task_control_success_certificate_conflict');
      return structuredClone(existing);
    }
    certificates[certificate.operationId] = certificate;
    writeDispatchRegistry(path, registry);
    return structuredClone(certificate);
  });
}

export function readTaskControlSuccessCertificate(
  path: string,
  operationId: string,
): TaskControlSuccessCertificate | undefined {
  const normalized = operationId.trim();
  if (!/^[a-f0-9]{50}$/.test(normalized)) return undefined;
  const registry = readDispatchRegistry(path);
  const value = registry[TASK_CONTROL_SUCCESS_CERTIFICATES_KEY];
  if (value === undefined) return undefined;
  const certificate = taskControlSuccessCertificates(registry).certificates[normalized];
  return certificate
    ? structuredClone(validatedTaskControlSuccessCertificate(certificate))
    : undefined;
}

function validatedTaskControlPhaseAOperation(
  value: TaskControlPhaseAOperation,
): TaskControlPhaseAOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 'TaskControlPhaseAOperation.v1'
    || (value.state !== 'pending' && value.state !== 'delivered' && value.state !== 'ambiguous')
    || (value.state === 'delivered') !== (typeof value.messageId === 'string')
    || (value.messageId !== undefined && !/^om_[A-Za-z0-9_-]{1,128}$/.test(value.messageId))) {
    throw new Error('project_task_control_phase_a_operation_registry_invalid');
  }
  const canonical = canonicalTaskControlPhaseAOperation({
    operationId: value.operationId,
    chatId: value.chatId,
    fenceFingerprint: value.fenceFingerprint,
    historicalDispatchRoot: value.historicalDispatchRoot,
    historicalTaskGuid: value.historicalTaskGuid,
    targetAppId: value.targetAppId,
    payloadHash: value.payloadHash,
    attempt: value.attempt,
    ...(value.messageId ? { messageId: value.messageId } : {}),
  });
  const expectedKeys = [
    'attempt', 'chatId', 'fenceFingerprint', 'historicalDispatchRoot', 'historicalTaskGuid',
    'operationId', 'payloadHash', 'providerUuid', 'schemaVersion', 'state', 'targetAppId',
    ...(value.messageId ? ['messageId'] : []),
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value.operationId !== canonical.operationId
    || value.chatId !== canonical.chatId
    || value.fenceFingerprint !== canonical.fenceFingerprint
    || value.historicalDispatchRoot !== canonical.historicalDispatchRoot
    || value.historicalTaskGuid !== canonical.historicalTaskGuid
    || value.targetAppId !== canonical.targetAppId
    || value.payloadHash !== canonical.payloadHash
    || value.providerUuid !== canonical.providerUuid
    || value.attempt.wallTime !== canonical.attempt.wallTime
    || value.attempt.bootId !== canonical.attempt.bootId
    || value.attempt.processStartedAt !== canonical.attempt.processStartedAt
    || value.attempt.monotonicMs !== canonical.attempt.monotonicMs
    || value.messageId !== canonical.messageId) {
    throw new Error('project_task_control_phase_a_operation_registry_invalid');
  }
  return value;
}

export function beginTaskControlPhaseAInstructionSync(
  path: string,
  input: Omit<TaskControlPhaseAOperation, 'schemaVersion' | 'providerUuid' | 'state' | 'messageId'>,
): TaskControlPhaseAOperation {
  const canonical = canonicalTaskControlPhaseAOperation(input);
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const operations = taskControlPhaseAOperations(registry).operations;
    const existingValue = operations[canonical.operationId];
    const existing = existingValue ? validatedTaskControlPhaseAOperation(existingValue) : undefined;
    if (existing) {
      if (existing.operationId !== canonical.operationId
        || existing.chatId !== canonical.chatId
        || existing.fenceFingerprint !== canonical.fenceFingerprint
        || existing.historicalDispatchRoot !== canonical.historicalDispatchRoot
        || existing.historicalTaskGuid !== canonical.historicalTaskGuid
        || existing.targetAppId !== canonical.targetAppId
        || existing.payloadHash !== canonical.payloadHash
        || existing.providerUuid !== canonical.providerUuid) {
        throw new Error('project_task_control_phase_a_operation_conflict');
      }
      if (existing.state !== 'pending') return structuredClone(existing);
      const elapsedMs = canonical.attempt.monotonicMs - existing.attempt.monotonicMs;
      const safeRetry = canonical.attempt.bootId === existing.attempt.bootId
        && canonical.attempt.processStartedAt === existing.attempt.processStartedAt
        && Number.isFinite(elapsedMs) && elapsedMs >= 0
        && elapsedMs < TASK_CONTROL_PROVIDER_RETRY_WINDOW_MS;
      if (safeRetry) return structuredClone(existing);
      const ambiguous: TaskControlPhaseAOperation = { ...existing, state: 'ambiguous' };
      operations[canonical.operationId] = ambiguous;
      writeDispatchRegistry(path, registry);
      return structuredClone(ambiguous);
    }
    const created: TaskControlPhaseAOperation = { ...canonical, state: 'pending' };
    operations[canonical.operationId] = created;
    writeDispatchRegistry(path, registry);
    return structuredClone(created);
  });
}

export function completeTaskControlPhaseAInstructionSync(
  path: string,
  input: { operationId: string; fenceFingerprint: string; messageId: string },
): TaskControlPhaseAOperation {
  const operationId = input.operationId.trim();
  const fenceFingerprint = input.fenceFingerprint.trim().toLowerCase();
  const messageId = input.messageId.trim();
  if (!/^[a-f0-9]{50}$/.test(operationId)
    || !/^tccq1:[a-f0-9]{64}$/.test(fenceFingerprint)
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(messageId)) {
    throw new Error('project_task_control_phase_a_operation_invalid');
  }
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const operations = taskControlPhaseAOperations(registry).operations;
    const existingValue = operations[operationId];
    if (!existingValue) throw new Error('project_task_control_phase_a_operation_missing');
    const existing = validatedTaskControlPhaseAOperation(existingValue);
    if (existing.fenceFingerprint !== fenceFingerprint) {
      throw new Error('project_task_control_phase_a_operation_conflict');
    }
    if (existing.state === 'delivered') {
      if (existing.messageId !== messageId) {
        throw new Error('project_task_control_phase_a_operation_conflict');
      }
      return structuredClone(existing);
    }
    if (existing.state !== 'pending') {
      throw new Error('project_task_control_phase_a_operation_ambiguous');
    }
    const delivered: TaskControlPhaseAOperation = { ...existing, state: 'delivered', messageId };
    operations[operationId] = delivered;
    writeDispatchRegistry(path, registry);
    return structuredClone(delivered);
  });
}

export function readTaskControlPhaseAOperation(
  path: string,
  operationId: string,
): TaskControlPhaseAOperation | undefined {
  const normalized = operationId.trim();
  if (!/^[a-f0-9]{50}$/.test(normalized)) return undefined;
  const registry = readDispatchRegistry(path);
  const value = registry[TASK_CONTROL_PHASE_A_OPERATIONS_KEY];
  if (value === undefined) return undefined;
  const operation = taskControlPhaseAOperations(registry).operations[normalized];
  return operation ? structuredClone(validatedTaskControlPhaseAOperation(operation)) : undefined;
}

export function claimTaskControlPhaseAFailedReportSync(
  path: string,
  input: Omit<TaskControlPhaseAFailedReportClaim, 'schemaVersion' | 'logicalEvidenceKey' | 'claimedAt'>,
  now = new Date().toISOString(),
): TaskControlPhaseAFailedReportClaim {
  const normalized = {
    operationId: input.operationId.trim(),
    fenceFingerprint: input.fenceFingerprint.trim().toLowerCase(),
    chatId: input.chatId.trim(),
    dispatchRoot: input.dispatchRoot.trim(),
    taskGuid: input.taskGuid.trim().toLowerCase(),
    reporterAppId: input.reporterAppId.trim(),
    sourceSessionId: input.sourceSessionId.trim(),
    sourceTurnId: input.sourceTurnId.trim(),
    workerGeneration: input.workerGeneration,
    reportRequestId: input.reportRequestId.trim(),
    contentHash: input.contentHash.trim().toLowerCase(),
  };
  if (!/^[a-f0-9]{50}$/.test(normalized.operationId)
    || !/^tccq1:[a-f0-9]{64}$/.test(normalized.fenceFingerprint)
    || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(normalized.chatId)
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(normalized.dispatchRoot)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized.taskGuid)
    || !normalized.reporterAppId || !normalized.sourceSessionId
    || !/^om_[A-Za-z0-9_-]{1,128}$/.test(normalized.sourceTurnId)
    || !Number.isSafeInteger(normalized.workerGeneration) || normalized.workerGeneration < 1
    || !/^report:[a-f0-9]{64}$/.test(normalized.reportRequestId)
    || !/^[a-f0-9]{64}$/.test(normalized.contentHash)
    || !exactIsoTime(now)) {
    throw new Error('project_task_control_phase_a_report_invalid');
  }
  const logicalEvidenceKey = `tcpar1:${createHash('sha256').update(JSON.stringify({
    schemaVersion: 'TaskControlPhaseAFailedReport.v1',
    operationId: normalized.operationId,
    sourceTurnId: normalized.sourceTurnId,
    reportRequestId: normalized.reportRequestId,
    contentHash: normalized.contentHash,
  })).digest('hex')}`;
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const operationValue = taskControlPhaseAOperations(registry).operations[normalized.operationId];
    if (!operationValue) throw new Error('project_task_control_phase_a_operation_missing');
    const operation = validatedTaskControlPhaseAOperation(operationValue);
    const exactOperation = operation.state === 'delivered'
      && operation.messageId === normalized.sourceTurnId
      && operation.chatId === normalized.chatId
      && operation.fenceFingerprint === normalized.fenceFingerprint
      && operation.historicalDispatchRoot === normalized.dispatchRoot
      && operation.historicalTaskGuid === normalized.taskGuid
      && operation.targetAppId === normalized.reporterAppId;
    if (!exactOperation) throw new Error('project_task_control_phase_a_report_rejected');

    const reports = taskControlPhaseAFailedReports(registry).reports;
    const existingValue = reports[normalized.operationId];
    const existing = existingValue ? validatedTaskControlPhaseAFailedReport(existingValue) : undefined;
    if (existing) {
      const comparableExisting = { ...existing, claimedAt: now };
      const expected: TaskControlPhaseAFailedReportClaim = {
        schemaVersion: 'TaskControlPhaseAFailedReport.v1', ...normalized, logicalEvidenceKey, claimedAt: now,
      };
      if (JSON.stringify(comparableExisting) !== JSON.stringify(expected)) {
        throw new Error('project_task_control_phase_a_report_rejected');
      }
      return structuredClone(existing);
    }

    const turnClaim = taskControlTurnAdmissionEntry(taskControlTurnAdmissions(registry), {
      messageId: normalized.sourceTurnId,
      targetAppId: normalized.reporterAppId,
    })?.[1];
    if (!turnClaim || turnClaim.state !== 'active'
      || !sameTaskControlTurnClaim(turnClaim, {
        messageId: normalized.sourceTurnId,
        chatId: normalized.chatId,
        dispatchRoot: normalized.dispatchRoot,
        targetAppId: normalized.reporterAppId,
        sessionId: normalized.sourceSessionId,
      })
      || turnClaim.workerGeneration !== normalized.workerGeneration) {
      throw new Error('project_task_control_phase_a_report_rejected');
    }
    const claimed: TaskControlPhaseAFailedReportClaim = {
      schemaVersion: 'TaskControlPhaseAFailedReport.v1', ...normalized, logicalEvidenceKey, claimedAt: now,
    };
    reports[normalized.operationId] = claimed;
    writeDispatchRegistry(path, registry);
    return structuredClone(claimed);
  });
}

export function readTaskControlPhaseAFailedReport(
  path: string,
  operationId: string,
): TaskControlPhaseAFailedReportClaim | undefined {
  const normalized = operationId.trim();
  if (!/^[a-f0-9]{50}$/.test(normalized)) return undefined;
  const registry = readDispatchRegistry(path);
  const value = registry[TASK_CONTROL_PHASE_A_REPORTS_KEY];
  if (value === undefined) return undefined;
  const report = taskControlPhaseAFailedReports(registry).reports[normalized];
  return report ? structuredClone(validatedTaskControlPhaseAFailedReport(report)) : undefined;
}

function compactTaskControlTurnAdmissions(
  admissions: TaskControlTurnAdmissionRegistryV1,
  now: string,
): boolean {
  const cutoff = Date.parse(now) - TASK_CONTROL_TURN_ADMISSION_TERMINAL_RETENTION_MS;
  const compactable = Object.entries(admissions.claims).filter(([, claim]) => claim.state === 'terminal'
    && claim.terminalAt !== undefined && Date.parse(claim.terminalAt) <= cutoff)
    .sort(([, left], [, right]) => left.terminalAt!.localeCompare(right.terminalAt!)
      || left.messageId.localeCompare(right.messageId)
      || left.targetAppId.localeCompare(right.targetAppId));
  if (compactable.length === 0) return false;
  admissions.terminalSummaries ??= {};
  for (const [claimKey, claim] of compactable) {
    const previous = admissions.terminalSummaries[claim.dispatchRoot];
    const chainedHash = `tcta1:${createHash('sha256').update(JSON.stringify({
      previousHash: previous?.chainedHash ?? TASK_CONTROL_TURN_ADMISSION_EMPTY_CHAIN,
      messageId: claim.messageId, chatId: claim.chatId, dispatchRoot: claim.dispatchRoot,
      targetAppId: claim.targetAppId, sessionId: claim.sessionId,
      workerGeneration: claim.workerGeneration, terminalAt: claim.terminalAt,
    })).digest('hex')}`;
    admissions.terminalSummaries[claim.dispatchRoot] = {
      count: (previous?.count ?? 0) + 1,
      lastTerminalAt: !previous || previous.lastTerminalAt < claim.terminalAt!
        ? claim.terminalAt!
        : previous.lastTerminalAt,
      chainedHash,
    };
    delete admissions.claims[claimKey];
  }
  return true;
}

function recordTaskControlTurnAdmissionOverflow(
  admissions: TaskControlTurnAdmissionRegistryV1,
  kind: 'perRoot' | 'global',
  input: TaskControlTurnAdmissionClaimBase,
  now: string,
): void {
  admissions.overflowMarkers ??= {};
  admissions.overflowMarkers[kind] ??= {
    reason: kind === 'perRoot' ? 'per_root' : 'global',
    chatId: input.chatId, dispatchRoot: input.dispatchRoot,
    messageId: input.messageId, observedAt: now,
  };
}

export function openTaskControlTurnAdmissions(
  path: string,
  chatId: string,
): TaskControlTurnAdmissionClaim[] {
  const registry = readDispatchRegistry(path);
  const value = registry[TASK_CONTROL_TURN_ADMISSIONS_KEY];
  if (value === undefined) return [];
  const admissions = taskControlTurnAdmissions(registry);
  return Object.values(admissions.claims).filter(claim => claim.chatId === chatId
    && (claim.state === 'pending' || claim.state === 'active'));
}

export function readTaskControlTurnAdmission(
  path: string,
  messageId: string,
  targetAppId?: string,
): TaskControlTurnAdmissionClaim | undefined {
  const normalized = messageId.trim();
  if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(normalized)) return undefined;
  const normalizedTarget = targetAppId?.trim();
  if (targetAppId !== undefined && !normalizedTarget) return undefined;
  const registry = readDispatchRegistry(path);
  const value = registry[TASK_CONTROL_TURN_ADMISSIONS_KEY];
  if (value === undefined) return undefined;
  const admissions = taskControlTurnAdmissions(registry);
  const claim = normalizedTarget
    ? taskControlTurnAdmissionEntry(admissions, { messageId: normalized, targetAppId: normalizedTarget })?.[1]
    : admissions.claims[normalized];
  if (!claim) return undefined;
  normalizeTaskControlTurnClaimBase(claim);
  if ((claim.state !== 'pending' && claim.state !== 'active' && claim.state !== 'terminal')
    || !exactIsoTime(claim.createdAt) || !exactIsoTime(claim.updatedAt)
    || (claim.workerGeneration !== undefined
      && (!Number.isSafeInteger(claim.workerGeneration) || claim.workerGeneration < 1))
    || (claim.state === 'terminal') !== (typeof claim.terminalAt === 'string')
    || (claim.terminalAt !== undefined && !exactIsoTime(claim.terminalAt))) {
    throw new Error('project_task_control_turn_claim_registry_invalid');
  }
  return structuredClone(claim);
}

export function claimTaskControlTurnAdmissionPendingSync(
  path: string,
  input: TaskControlTurnAdmissionClaimBase,
  now = new Date().toISOString(),
): TaskControlTurnAdmissionClaim {
  const normalized = normalizeTaskControlTurnClaimBase(input);
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const admissions = taskControlTurnAdmissions(registry);
    const compacted = compactTaskControlTurnAdmissions(admissions, now);
    const existing = taskControlTurnAdmissionEntry(admissions, normalized)?.[1];
    if (existing) {
      if (!sameTaskControlTurnClaim(existing, normalized)) {
        throw new Error('project_task_control_turn_claim_conflict');
      }
      if (compacted) writeDispatchRegistry(path, registry);
      return structuredClone(existing);
    }
    const openClaims = Object.values(admissions.claims)
      .filter(claim => claim.state === 'pending' || claim.state === 'active');
    if (openClaims.filter(claim => claim.dispatchRoot === normalized.dispatchRoot).length
      >= TASK_CONTROL_TURN_ADMISSION_PER_ROOT_CAP) {
      recordTaskControlTurnAdmissionOverflow(admissions, 'perRoot', normalized, now);
      writeDispatchRegistry(path, registry);
      throw new Error('project_task_control_turn_claim_per_root_capacity');
    }
    if (openClaims.length >= TASK_CONTROL_TURN_ADMISSION_GLOBAL_CAP) {
      recordTaskControlTurnAdmissionOverflow(admissions, 'global', normalized, now);
      writeDispatchRegistry(path, registry);
      throw new Error('project_task_control_turn_claim_global_capacity');
    }
    const created: TaskControlTurnAdmissionClaim = {
      ...normalized, state: 'pending', createdAt: now, updatedAt: now,
    };
    admissions.claims[taskControlTurnAdmissionStorageKey(admissions, normalized)] = created;
    writeDispatchRegistry(path, registry);
    return structuredClone(created);
  });
}

export function activateTaskControlTurnAdmissionSync(
  path: string,
  input: TaskControlTurnAdmissionClaimBase & { workerGeneration: number },
  now = new Date().toISOString(),
): TaskControlTurnAdmissionClaim {
  const normalized = normalizeTaskControlTurnClaimBase(input);
  if (!Number.isSafeInteger(input.workerGeneration) || input.workerGeneration <= 0) {
    throw new Error('project_task_control_turn_claim_generation_invalid');
  }
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const admissions = taskControlTurnAdmissions(registry);
    const entry = taskControlTurnAdmissionEntry(admissions, normalized);
    const existing = entry?.[1];
    if (!existing || !sameTaskControlTurnClaim(existing, normalized)) {
      throw new Error('project_task_control_turn_claim_conflict');
    }
    if (existing.state === 'terminal') throw new Error('project_task_control_turn_claim_terminal');
    if (existing.state === 'active') {
      if (existing.workerGeneration !== input.workerGeneration) {
        throw new Error('project_task_control_turn_claim_conflict');
      }
      return structuredClone(existing);
    }
    const active: TaskControlTurnAdmissionClaim = {
      ...existing, workerGeneration: input.workerGeneration, state: 'active', updatedAt: now,
    };
    admissions.claims[entry![0]] = active;
    writeDispatchRegistry(path, registry);
    return structuredClone(active);
  });
}

/** Stable seam for the daemon's exact turn-terminal boundary. */
export function terminalizeTaskControlTurnAdmissionSync(
  path: string,
  input: TaskControlTurnAdmissionClaimBase & { workerGeneration: number },
  now = new Date().toISOString(),
): TaskControlTurnAdmissionClaim | undefined {
  const normalized = normalizeTaskControlTurnClaimBase(input);
  return withFileLockSync(path, () => {
    const registry = readDispatchRegistry(path);
    const value = registry[TASK_CONTROL_TURN_ADMISSIONS_KEY];
    if (value === undefined) return undefined;
    const admissions = taskControlTurnAdmissions(registry);
    const entry = taskControlTurnAdmissionEntry(admissions, normalized);
    const existing = entry?.[1];
    if (!existing) return undefined;
    if (!sameTaskControlTurnClaim(existing, normalized)
      || existing.workerGeneration !== input.workerGeneration) {
      throw new Error('project_task_control_turn_claim_conflict');
    }
    if (existing.state === 'terminal') return structuredClone(existing);
    if (existing.state !== 'active') {
      throw new Error('project_task_control_turn_claim_not_active');
    }
    const terminal: TaskControlTurnAdmissionClaim = {
      ...existing, state: 'terminal', terminalAt: now, updatedAt: now,
    };
    admissions.claims[entry![0]] = terminal;
    writeDispatchRegistry(path, registry);
    return structuredClone(terminal);
  });
}

export function findDispatchOperation(path: string, operationId: string): DispatchOperationMatch | undefined {
  const matches = listDispatchOperations(path, operationId);
  return matches.at(-1);
}

export function listDispatchOperations(path: string, operationId: string): DispatchOperationMatch[] {
  if (!operationId) return [];
  const matches: DispatchOperationMatch[] = [];
  for (const [dispatchRoot, value] of Object.entries(readDispatchRegistry(path))) {
    if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(dispatchRoot)
      || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.dispatchOperationId === operationId) {
      matches.push({ dispatchRoot, entry });
    }
  }
  return matches;
}

/**
 * Serialize a dispatch-registry read-modify-write across CLI processes.
 *
 * Atomic rename alone only prevents torn JSON; without the surrounding lock,
 * two dispatch commands can both read the same snapshot and the last rename
 * silently drops the other command's seed. Keep the mutation inside the lock
 * so report-back retains every concurrently-created thread.
 */
export async function updateDispatchRegistry(
  path: string,
  mutate: (registry: DispatchRegistry) => void | Promise<void>,
): Promise<void> {
  await withFileLock(path, async () => {
    const registry = readDispatchRegistry(path);
    await mutate(registry);
    writeDispatchRegistry(path, registry);
  });
}

export async function recordDispatchRegistryEntry(
  path: string,
  seedId: string,
  entry: unknown,
): Promise<void> {
  await updateDispatchRegistry(path, registry => {
    const existing = registry[seedId];
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(entry)) return;
      throw new Error(`dispatch registry entry already exists for ${seedId}`);
    }
    registry[seedId] = entry;
  });
}
