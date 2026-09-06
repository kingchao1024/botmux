import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The reviewer signature root is deliberately independent from transport HMAC
 * and every other daemon proof. It is derived from the existing host-only
 * root plus the exact reviewer app id, so a signer for app A cannot mint a
 * verdict that verifies as app B.
 */
export const REVIEWER_VERDICT_TRUST_DOMAIN = 'botmux.task-control.reviewer-verdict.v1';
export const DESIGNATED_REVIEWER_TRUST_DOMAIN = 'botmux.task-control.designated-reviewer.v1';

export type ReviewerVerdictValue = 'pass' | 'fail' | 'conditional';
export type ReviewerVerdictRecordKind = 'verdict' | 'revocation';

export interface ReviewerConditionEvidence {
  evidenceRef: string;
  observedAt: string;
}

export interface DesignatedReviewerScope {
  projectId: string;
  phaseId: string;
  taskGuid: string;
  topicRootId: string;
  taskSetSnapshot: readonly string[];
  reviewRound: number;
}

export interface DesignatedReviewerMapping extends DesignatedReviewerScope {
  schemaVersion: 'DesignatedReviewer.v1';
  designatedReviewerRef: string;
  reviewerId: string;
  reviewerBotAppId: string;
  controllerId: string;
  controllerBotAppId: string;
  effectiveAt: string;
  expiresAt: string;
  issuedAt: string;
  /** Stable signer selector, bound to the signing domain and exact app id. */
  keyId: string;
  signature: string;
  supersedesDesignatedReviewerRef?: string;
}

export interface ReviewerVerdictV1 extends DesignatedReviewerScope {
  schemaVersion: 'ReviewerVerdict.v1';
  provider: 'ReviewerVerdict.v1';
  verdictId: string;
  designatedReviewerRef: string;
  reviewerId: string;
  reviewerBotAppId: string;
  sessionId: string;
  workerGeneration: number;
  capabilityHash: string;
  sourceCommentId?: string;
  sourceMessageId?: string;
  sourceVersionHash: string;
  kind: ReviewerVerdictRecordKind;
  verdict?: ReviewerVerdictValue;
  conditionIds: readonly string[];
  resolvedConditionEvidence: Readonly<Record<string, ReviewerConditionEvidence>>;
  docToken: string;
  docRevision: number;
  issuedAt: string;
  expiresAt: string;
  /** Stable reviewer-signer selector carried in the signed production record. */
  keyId: string;
  signature: string;
  revokesVerdictId?: string;
  supersedesVerdictId?: string;
}

export interface ReviewerVerdictAttestation {
  reviewerId: string;
  reviewerBotAppId: string;
  sessionId: string;
  workerGeneration: number;
  /** Reviewer daemon proves the raw capability locally and forwards only this hash. */
  capabilityHash?: string;
  /** Test-only/local issuing path. Never accepted by the controller submit route. */
  capability?: string;
}

export interface ReviewerVerdictMessageSource {
  messageId: string;
  topicRootId: string;
  senderId: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReviewerVerdictCommentSource {
  commentId: string;
  taskGuid: string;
  senderId: string;
  createdAt?: string;
  updatedAt?: string;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validAppId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(value);
}

function keyContext(domain: string, appId: string): string {
  if (!validAppId(appId)) throw new Error('task_control_reviewer_verdict_trust_root_invalid');
  return `${domain}\0${appId}`;
}

function stableKeyId(prefix: string, key: Buffer): string {
  return `${prefix}:${createHash('sha256').update(key).digest('hex')}`;
}

function sourceTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  if (/^\d{10,16}$/.test(raw)) {
    const numeric = Number(raw);
    const millis = raw.length <= 10 ? numeric * 1_000 : numeric;
    return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : undefined;
  }
  return Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : undefined;
}

function sortedStrings(value: readonly string[]): string[] {
  const out = new Set<string>();
  for (const item of value) {
    const text = nonBlank(item);
    if (!text) throw new Error('task_control_reviewer_verdict_invalid_string');
    out.add(text);
  }
  return [...out].sort();
}

function canonicalRecord(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))));
}

function encodedSignature(key: Buffer | string, value: Record<string, unknown>): string {
  return createHmac('sha256', key).update(canonicalRecord(value)).digest('hex');
}

function validSignature(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function reviewerVerdictCanonicalPayload(record: Omit<ReviewerVerdictV1, 'signature'>): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion, provider: record.provider, verdictId: record.verdictId,
    projectId: record.projectId, phaseId: record.phaseId, taskGuid: record.taskGuid, topicRootId: record.topicRootId,
    taskSetSnapshot: sortedStrings(record.taskSetSnapshot), reviewRound: record.reviewRound,
    designatedReviewerRef: record.designatedReviewerRef, reviewerId: record.reviewerId,
    reviewerBotAppId: record.reviewerBotAppId, sessionId: record.sessionId,
    workerGeneration: record.workerGeneration, capabilityHash: record.capabilityHash,
    sourceCommentId: record.sourceCommentId, sourceMessageId: record.sourceMessageId,
    sourceVersionHash: record.sourceVersionHash,
    kind: record.kind, verdict: record.verdict, conditionIds: sortedStrings(record.conditionIds),
    resolvedConditionEvidence: Object.fromEntries(Object.entries(record.resolvedConditionEvidence)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([conditionId, evidence]) => [conditionId, { evidenceRef: evidence.evidenceRef, observedAt: evidence.observedAt }])),
    docToken: record.docToken, docRevision: record.docRevision, issuedAt: record.issuedAt,
    expiresAt: record.expiresAt, keyId: record.keyId, revokesVerdictId: record.revokesVerdictId,
    supersedesVerdictId: record.supersedesVerdictId,
  };
}

export function designatedReviewerCanonicalPayload(record: Omit<DesignatedReviewerMapping, 'signature'>): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion, designatedReviewerRef: record.designatedReviewerRef,
    projectId: record.projectId, phaseId: record.phaseId, taskGuid: record.taskGuid, topicRootId: record.topicRootId,
    taskSetSnapshot: sortedStrings(record.taskSetSnapshot), reviewRound: record.reviewRound,
    reviewerId: record.reviewerId, reviewerBotAppId: record.reviewerBotAppId,
    controllerId: record.controllerId, controllerBotAppId: record.controllerBotAppId,
    effectiveAt: record.effectiveAt, expiresAt: record.expiresAt, issuedAt: record.issuedAt,
    keyId: record.keyId, supersedesDesignatedReviewerRef: record.supersedesDesignatedReviewerRef,
  };
}

export function reviewerVerdictPayloadHash(record: ReviewerVerdictV1): string {
  return `sha256:${createHash('sha256').update(canonicalRecord(reviewerVerdictCanonicalPayload(record))).digest('hex')}`;
}

export function reviewerCapabilityHash(capability: string): string {
  return `sha256:${createHash('sha256').update(capability).digest('hex')}`;
}

/** Stable controller/reviewer rendezvous id for one review round. It is derived
 * only from controller-bound dispatch scope and the selected reviewer app. */
export function reviewerDesignationRef(dispatchRoot: string, reviewerBotAppId: string, reviewRound: number): string {
  if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(dispatchRoot) || !validAppId(reviewerBotAppId)
    || !Number.isSafeInteger(reviewRound) || reviewRound < 1) {
    throw new Error('task_control_reviewer_designation_ref_invalid');
  }
  return `dr_${createHash('sha256').update(`${REVIEWER_VERDICT_TRUST_DOMAIN}\0${dispatchRoot}\0${reviewerBotAppId}\0${reviewRound}`).digest('hex').slice(0, 48)}`;
}

export function reviewerVerdictSourceVersionHash(source: ReviewerVerdictMessageSource | ReviewerVerdictCommentSource): string {
  const canonical = 'messageId' in source
    ? { kind: 'message', messageId: source.messageId, topicRootId: source.topicRootId, senderId: source.senderId, createdAt: source.createdAt, updatedAt: source.updatedAt }
    : { kind: 'task_comment', commentId: source.commentId, taskGuid: source.taskGuid, senderId: source.senderId, createdAt: source.createdAt, updatedAt: source.updatedAt };
  return `sha256:${createHash('sha256').update(canonicalRecord(canonical)).digest('hex')}`;
}

export function proveReviewerMessageSource(input: {
  source: ReviewerVerdictMessageSource; expectedMessageId: string; expectedTopicRootId: string; expectedReviewerId: string;
}): { sourceMessageId: string; sourceVersionHash: string } | undefined {
  const { source } = input;
  if (!nonBlank(source.messageId) || source.messageId !== input.expectedMessageId
    || source.topicRootId !== input.expectedTopicRootId || source.senderId !== input.expectedReviewerId
    || !sourceTimestamp(source.createdAt)) return undefined;
  return { sourceMessageId: source.messageId, sourceVersionHash: reviewerVerdictSourceVersionHash(source) };
}

/**
 * Convert the existing IM detail response into the only production review
 * source accepted today. Message body/title/status are intentionally ignored.
 */
export function reviewerMessageSourceFromLarkDetail(input: {
  detail: unknown; expectedMessageId: string; expectedTopicRootId: string; expectedReviewerId?: string;
}): { sourceMessageId: string; sourceVersionHash: string; createdAt: string; senderId: string } | undefined {
  const detail = input.detail && typeof input.detail === 'object' && !Array.isArray(input.detail)
    ? input.detail as Record<string, unknown>
    : undefined;
  const item = Array.isArray(detail?.items) && detail!.items.length === 1
    && detail!.items[0] && typeof detail!.items[0] === 'object' && !Array.isArray(detail!.items[0])
    ? detail!.items[0] as Record<string, unknown>
    : undefined;
  const sender = item?.sender && typeof item.sender === 'object' && !Array.isArray(item.sender)
    ? item.sender as Record<string, unknown>
    : undefined;
  const messageId = typeof item?.message_id === 'string' ? item.message_id : undefined;
  // `thread_id` is a platform thread identifier, not the stable `om_` topic
  // root used by the control plane. A missing root is acceptable only when
  // this exact message is itself the registered root; otherwise fail closed.
  const rootId = typeof item?.root_id === 'string' && item.root_id
    ? item.root_id
    : messageId === input.expectedTopicRootId ? messageId : undefined;
  const senderId = typeof sender?.id === 'string' ? sender.id : undefined;
  const createdAt = sourceTimestamp(item?.create_time);
  if (!messageId || !rootId || !senderId || !createdAt) return undefined;
  const updatedAt = sourceTimestamp(item?.update_time);
  const expectedReviewerId: string = input.expectedReviewerId ?? senderId;
  const proof = proveReviewerMessageSource({
    source: { messageId, topicRootId: rootId, senderId, createdAt, ...(updatedAt ? { updatedAt } : {}) },
    expectedMessageId: input.expectedMessageId, expectedTopicRootId: input.expectedTopicRootId, expectedReviewerId,
  });
  return proof ? { ...proof, createdAt, senderId } : undefined;
}

export function proveReviewerCommentSource(input: {
  source: ReviewerVerdictCommentSource; expectedCommentId: string; expectedTaskGuid: string; expectedReviewerId: string;
}): { sourceCommentId: string; sourceVersionHash: string } | undefined {
  const { source } = input;
  if (!nonBlank(source.commentId) || source.commentId !== input.expectedCommentId
    || source.taskGuid !== input.expectedTaskGuid || source.senderId !== input.expectedReviewerId) return undefined;
  return { sourceCommentId: source.commentId, sourceVersionHash: reviewerVerdictSourceVersionHash(source) };
}

function validVerdictShape(record: Omit<ReviewerVerdictV1, 'signature'>): boolean {
  try {
    const sourceCount = Number(!!record.sourceCommentId) + Number(!!record.sourceMessageId);
    const common = !!nonBlank(record.projectId) && !!nonBlank(record.phaseId) && !!nonBlank(record.taskGuid) && !!nonBlank(record.topicRootId)
      && !!nonBlank(record.designatedReviewerRef) && !!nonBlank(record.reviewerId) && !!nonBlank(record.reviewerBotAppId)
      && !!nonBlank(record.sessionId) && Number.isSafeInteger(record.workerGeneration) && record.workerGeneration > 0
      && !!nonBlank(record.keyId)
      && /^sha256:[a-f0-9]{64}$/i.test(record.capabilityHash) && /^sha256:[a-f0-9]{64}$/i.test(record.sourceVersionHash)
      && !!nonBlank(record.docToken) && Number.isSafeInteger(record.docRevision) && record.docRevision > 0
      && sourceCount === 1 && record.reviewRound >= 1 && Number.isFinite(Date.parse(record.issuedAt))
      && Number.isFinite(Date.parse(record.expiresAt)) && Date.parse(record.expiresAt) > Date.parse(record.issuedAt);
    if (!common) return false;
    const conditions = sortedStrings(record.conditionIds);
    if (Object.keys(record.resolvedConditionEvidence).some(id => !conditions.includes(id))) return false;
    if (Object.values(record.resolvedConditionEvidence).some(evidence => !nonBlank(evidence?.evidenceRef)
      || !Number.isFinite(Date.parse(evidence?.observedAt ?? '')))) return false;
    if (record.kind === 'verdict') {
      return (record.verdict === 'pass' || record.verdict === 'fail' || record.verdict === 'conditional')
        && !record.revokesVerdictId
        && (record.verdict === 'conditional' ? conditions.length > 0 : conditions.length === 0);
    }
    return record.kind === 'revocation' && !record.verdict && conditions.length === 0
      && !!nonBlank(record.revokesVerdictId) && !record.supersedesVerdictId;
  } catch { return false; }
}

function validDesignationShape(record: Omit<DesignatedReviewerMapping, 'signature'>): boolean {
  try {
    return !!nonBlank(record.designatedReviewerRef) && !!nonBlank(record.projectId) && !!nonBlank(record.phaseId)
      && !!nonBlank(record.taskGuid) && !!nonBlank(record.topicRootId) && !!nonBlank(record.reviewerId)
      && !!nonBlank(record.reviewerBotAppId) && !!nonBlank(record.controllerId) && !!nonBlank(record.controllerBotAppId)
      && !!nonBlank(record.keyId)
      && record.reviewRound >= 1 && sortedStrings(record.taskSetSnapshot).includes(record.taskGuid)
      && Number.isFinite(Date.parse(record.effectiveAt)) && Number.isFinite(Date.parse(record.expiresAt))
      && Date.parse(record.expiresAt) > Date.parse(record.effectiveAt) && Number.isFinite(Date.parse(record.issuedAt));
  } catch { return false; }
}

export class DaemonReviewerVerdictProvider {
  constructor(private readonly input: { key: Buffer | string; keyId: string; now?: () => number }) {}

  get keyId(): string { return this.input.keyId; }

  issueDesignatedReviewer(input: Omit<DesignatedReviewerMapping, 'schemaVersion' | 'designatedReviewerRef' | 'keyId' | 'signature' | 'issuedAt'> & { designatedReviewerRef?: string; issuedAt?: string }): DesignatedReviewerMapping {
    const issuedAt = input.issuedAt ?? new Date(this.input.now?.() ?? Date.now()).toISOString();
    const ref = input.designatedReviewerRef ?? `dr_${randomBytes(20).toString('hex')}`;
    const unsigned: Omit<DesignatedReviewerMapping, 'signature'> = {
      ...input, schemaVersion: 'DesignatedReviewer.v1', designatedReviewerRef: ref,
      keyId: this.input.keyId, issuedAt,
      taskSetSnapshot: sortedStrings(input.taskSetSnapshot),
    };
    if (!validDesignationShape(unsigned)) throw new Error('task_control_designated_reviewer_invalid');
    return { ...unsigned, signature: encodedSignature(this.input.key, designatedReviewerCanonicalPayload(unsigned)) };
  }

  /**
   * Canonical signer. It deliberately performs no Lark reads: production
   * ingress supplies only daemon-resolved source/session/capability values,
   * while tests may call this pure signer directly.
   */
  issueVerdict(input: Omit<ReviewerVerdictV1, 'schemaVersion' | 'provider' | 'verdictId' | 'keyId' | 'signature' | 'issuedAt' | 'capabilityHash'> & { verdictId?: string; capability: string; issuedAt?: string }): ReviewerVerdictV1 {
    const issuedAt = input.issuedAt ?? new Date(this.input.now?.() ?? Date.now()).toISOString();
    const sourceId = input.sourceCommentId ?? input.sourceMessageId;
    if (!sourceId) throw new Error('task_control_reviewer_verdict_source_required');
    const verdictId = input.verdictId ?? `rv_${randomBytes(20).toString('hex')}`;
    const { capability: _capability, verdictId: _verdictId, issuedAt: _issuedAt, ...record } = input;
    const unsigned: Omit<ReviewerVerdictV1, 'signature'> = {
      ...record, schemaVersion: 'ReviewerVerdict.v1', provider: 'ReviewerVerdict.v1', verdictId,
      capabilityHash: reviewerCapabilityHash(input.capability),
      issuedAt, keyId: this.input.keyId, taskSetSnapshot: sortedStrings(record.taskSetSnapshot),
      conditionIds: sortedStrings(record.conditionIds),
      resolvedConditionEvidence: Object.fromEntries(Object.entries(record.resolvedConditionEvidence)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([conditionId, evidence]) => [conditionId, { evidenceRef: evidence.evidenceRef, observedAt: evidence.observedAt }])),
    };
    if (!validVerdictShape(unsigned)) throw new Error('task_control_reviewer_verdict_invalid');
    return { ...unsigned, signature: encodedSignature(this.input.key, reviewerVerdictCanonicalPayload(unsigned)) };
  }

  verifyDesignatedReviewer(record: DesignatedReviewerMapping): boolean {
    return validDesignationShape(record) && record.keyId === this.input.keyId
      && validSignature(record.signature, encodedSignature(this.input.key, designatedReviewerCanonicalPayload(record)));
  }

  verifyVerdict(record: ReviewerVerdictV1): boolean {
    return validVerdictShape(record) && record.keyId === this.input.keyId
      && validSignature(record.signature, encodedSignature(this.input.key, reviewerVerdictCanonicalPayload(record)));
  }
}

/**
 * Build the fixed per-reviewer-app signer/verifier from the already protected
 * daemon host root. The returned provider never exposes its key. Callers must
 * select `reviewerBotAppId` from a live self identity (signing) or a current
 * designated-reviewer mapping (verification), never from an IPC request.
 */
export function deriveDaemonReviewerVerdictProvider(input: {
  hostSecret: string;
  reviewerBotAppId: string;
  now?: () => number;
}): DaemonReviewerVerdictProvider {
  if (!nonBlank(input.hostSecret) || !validAppId(input.reviewerBotAppId)) {
    throw new Error('task_control_reviewer_verdict_trust_root_invalid');
  }
  const context = keyContext(REVIEWER_VERDICT_TRUST_DOMAIN, input.reviewerBotAppId);
  const key = createHmac('sha256', input.hostSecret).update(context, 'utf8').digest();
  return new DaemonReviewerVerdictProvider({
    key, keyId: reviewerVerdictKeyId(input.reviewerBotAppId, input.hostSecret), now: input.now,
  });
}

/** Stable selector for one app-scoped reviewer root generation. */
export function reviewerVerdictKeyId(reviewerBotAppId: string, hostSecret: string): string {
  return stableKeyId('rv1', createHmac('sha256', hostSecret).update(keyContext(REVIEWER_VERDICT_TRUST_DOMAIN, reviewerBotAppId), 'utf8').digest());
}

/** The controller signs designations with its own app-scoped root. This is a
 * distinct domain from reviewer verdict signatures even though both roots stem
 * from the same protected host secret. */
export function deriveDaemonDesignatedReviewerProvider(input: {
  hostSecret: string;
  controllerBotAppId: string;
  now?: () => number;
}): DaemonReviewerVerdictProvider {
  if (!nonBlank(input.hostSecret) || !validAppId(input.controllerBotAppId)) {
    throw new Error('task_control_designated_reviewer_trust_root_invalid');
  }
  const context = keyContext(DESIGNATED_REVIEWER_TRUST_DOMAIN, input.controllerBotAppId);
  const key = createHmac('sha256', input.hostSecret).update(context, 'utf8').digest();
  return new DaemonReviewerVerdictProvider({
    key, keyId: stableKeyId('dr1', key), now: input.now,
  });
}

/** Fixed controller-side verifier set. Resolution is keyed only by the signed
 * record's app scope; controller routes select that scope from designation, not
 * from a requester-supplied key id or verifier callback. */
export function createDaemonReviewerVerdictVerifier(input: {
  hostSecret: string;
  previousHostSecret?: string;
  controllerBotAppId: string;
  now?: () => number;
  allowedKeyIds?: readonly string[];
  revokedKeyIds?: readonly string[];
}): {
  providerForApp(reviewerBotAppId: string): DaemonReviewerVerdictProvider | undefined;
  verifyDesignatedReviewer(value: DesignatedReviewerMapping): boolean;
  verifyVerdict(value: ReviewerVerdictV1): boolean;
} {
  const providers = new Map<string, DaemonReviewerVerdictProvider[]>();
  const permitted = (keyId: string): boolean => !input.revokedKeyIds?.includes(keyId)
    && (input.allowedKeyIds === undefined || input.allowedKeyIds.includes(keyId));
  const providerForApp = (reviewerBotAppId: string): DaemonReviewerVerdictProvider | undefined => {
    if (!validAppId(reviewerBotAppId)) return undefined;
    let provider = providers.get(reviewerBotAppId);
    if (!provider) {
      provider = [deriveDaemonReviewerVerdictProvider({ hostSecret: input.hostSecret, reviewerBotAppId, now: input.now })];
      if (input.previousHostSecret && input.previousHostSecret !== input.hostSecret) {
        provider.push(deriveDaemonReviewerVerdictProvider({ hostSecret: input.previousHostSecret, reviewerBotAppId, now: input.now }));
      }
      providers.set(reviewerBotAppId, provider);
    }
    return provider.find(candidate => permitted(candidate.keyId));
  };
  const verifyDesignation = (value: DesignatedReviewerMapping): boolean => {
    if (value.controllerBotAppId !== input.controllerBotAppId || !permitted(value.keyId)) return false;
    const candidates = [deriveDaemonDesignatedReviewerProvider({ hostSecret: input.hostSecret, controllerBotAppId: input.controllerBotAppId, now: input.now })];
    if (input.previousHostSecret && input.previousHostSecret !== input.hostSecret) candidates.push(deriveDaemonDesignatedReviewerProvider({ hostSecret: input.previousHostSecret, controllerBotAppId: input.controllerBotAppId, now: input.now }));
    return candidates.some(candidate => candidate.verifyDesignatedReviewer(value));
  };
  return {
    providerForApp,
    verifyDesignatedReviewer: verifyDesignation,
    verifyVerdict: value => {
      if (!permitted(value.keyId) || !validAppId(value.reviewerBotAppId)) return false;
      const candidates = providers.get(value.reviewerBotAppId) ?? [
        deriveDaemonReviewerVerdictProvider({ hostSecret: input.hostSecret, reviewerBotAppId: value.reviewerBotAppId, now: input.now }),
        ...(input.previousHostSecret && input.previousHostSecret !== input.hostSecret ? [deriveDaemonReviewerVerdictProvider({ hostSecret: input.previousHostSecret, reviewerBotAppId: value.reviewerBotAppId, now: input.now })] : []),
      ];
      providers.set(value.reviewerBotAppId, candidates);
      return candidates.some(candidate => candidate.verifyVerdict(value));
    },
  };
}
