/**
 * Portable, versioned proof that a Lark card callback answered one Botmux Ask.
 *
 * The signature key is deliberately independent of the daemon IPC HMAC. The
 * embedded Ed25519 public key is transport/consistency material only: a
 * verifier must independently pin that public key or its key id and never
 * needs the daemon authority secret.
 */
import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { isProxy } from 'node:util/types';

import type { AskQuestion } from './ask-types.js';

export const ASK_RECEIPT_SCHEMA = 'botmux.ask-receipt.v1' as const;
export const ASK_RECEIPT_ALGORITHM = 'Ed25519' as const;
export const ASK_RECEIPT_TTL_MS = 5 * 60 * 1000;
const SIGNING_DOMAIN = `${ASK_RECEIPT_SCHEMA}\0`;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const ED25519_SPKI_DER_BYTES = 44;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_VALUES = 10_000;
const MAX_SNAPSHOT_STRING_BYTES = 1024 * 1024;
const MAX_CALLBACK_SNAPSHOT_DEPTH = 8;
const MAX_CALLBACK_SNAPSHOT_VALUES = 1_000;
const MAX_CALLBACK_SNAPSHOT_STRING_BYTES = 256 * 1024;
const askCallbackSnapshots = new WeakSet<object>();

export interface AskReceiptActorV1 {
  kind: 'lark_user';
  identity: string;
}

export interface AskReceiptPayloadV1 {
  schema: typeof ASK_RECEIPT_SCHEMA;
  askId: string;
  larkAppId: string;
  sessionId: string;
  chatId: string;
  rootMessageId: string | null;
  questionDigest: string;
  answerDigest: string;
  answers: ReadonlyArray<ReadonlyArray<string>>;
  selected: string | null;
  actor: AskReceiptActorV1;
  source: 'lark_card';
  platformEventId: string;
  cardMessageId: string;
  askNonce: string;
  answeredAt: number;
  expiresAt: number;
  daemonBootId: string;
  signerInstanceId: string;
  keyId: string;
  jti: string;
}

export interface SignedAskReceiptV1 {
  payload: AskReceiptPayloadV1;
  algorithm: typeof ASK_RECEIPT_ALGORITHM;
  publicKey: string;
  signature: string;
}

export interface AskPersistenceIntegrityV1 {
  schema: 'botmux.ask-persist-signature.v1';
  algorithm: typeof ASK_RECEIPT_ALGORITHM;
  keyId: string;
  signature: string;
}

export interface AskPersistenceIntegrityAuthority {
  /** Pinned receipt trust anchor. Persisted outboxes must never trust the
   * embedded receipt key merely because their outer record is signed. */
  readonly keyId: string;
  readonly publicKey: string;
  sealPersistedState(value: unknown): AskPersistenceIntegrityV1;
  verifyPersistedState(value: unknown, integrity: unknown): boolean;
}

declare const ASK_ANSWER_PROVENANCE: unique symbol;
/** Opaque process-local object capability issued through registered dispatcher wiring. */
export interface AskAnswerProvenanceToken {
  readonly [ASK_ANSWER_PROVENANCE]: true;
}

export type AskCardReceiptAction = 'ask_select' | 'ask_toggle' | 'ask_submit';

export interface AskProvenanceExpectation {
  larkAppId: string;
  actorIdentity: string;
  cardMessageId: string;
  action: AskCardReceiptAction;
  askId: string;
  askNonce: string;
  optionKey?: string;
  questionIndex?: number;
  hasFormValue: boolean;
  submitBinding?: NormalizedAskSubmitValue;
}

export interface NormalizedAskSubmitValue {
  readonly confirmEmpty: boolean;
  /** null identifies the cumulative-button path; arrays are legacy form answers. */
  readonly formAnswers: ReadonlyArray<ReadonlyArray<string>> | null;
}

export interface AskReceiptMintInput extends AskProvenanceExpectation {
  sessionId: string;
  chatId: string;
  rootMessageId: string | null;
  questions: ReadonlyArray<AskQuestion>;
  answers: ReadonlyArray<ReadonlyArray<string>>;
  comment: null;
  answeredAt: number;
  deadlineAt: number;
}

export interface AskReceiptPersistInput extends AskReceiptMintInput {
  askKey: string;
  requestId: string;
  originKind: string;
}

/** The broker receives this facet, never the signer or token issuer. */
export interface AskAnswerProvenanceRedeemer {
  consumeMutation(token: unknown, expected: AskProvenanceExpectation): boolean;
  /** Consume and bind one callback capability, then mint an in-memory receipt.
   * The broker publishes it only through the store's atomic terminal commit. */
  mintReceipt(token: unknown, input: AskReceiptPersistInput): SignedAskReceiptV1 | undefined;
  /** Mark the callback redeemed only after its terminal commit point: durable
   * for resumable asks, or in-memory for deliberately non-resumable asks. */
  markReceiptCommitted(token: unknown): boolean;
  revoke(token: unknown): void;
}

export interface AskAnswerProvenanceIssuer {
  issue(larkAppId: string, data: unknown): Promise<AskAnswerProvenanceIssue>;
  wasRedeemed(token: unknown): boolean;
  complete(token: unknown): Promise<AskReceiptEventClaimResult>;
  revoke(token: unknown): void;
}

export type AskReceiptEventClaimResult =
  | { ok: true; recovered: boolean }
  | { ok: false; reason: 'duplicate' | 'binding_mismatch' | 'invalid_event_id' | 'capacity_exhausted' | 'storage_error' };

export type AskAnswerProvenanceIssue =
  | { kind: 'not_ask' }
  | { kind: 'issued'; token: AskAnswerProvenanceToken }
  | { kind: 'rejected'; reason: 'invalid_event_id' | 'duplicate' | 'binding_mismatch' | 'capacity_exhausted' | 'storage_error' };

export type VerifiedAskReceiptPayloadV1 = Readonly<
  Omit<AskReceiptPayloadV1, 'actor' | 'answers'> & {
    actor: Readonly<AskReceiptActorV1>;
    answers: ReadonlyArray<ReadonlyArray<string>>;
  }
>;

export type AskReceiptVerification =
  | { ok: true; expired: boolean; payload: VerifiedAskReceiptPayloadV1 }
  | { ok: false; error: 'malformed' | 'untrusted_key' | 'binding_mismatch' | 'invalid_signature' | 'expired' };

export interface VerifyAskReceiptOptions {
  publicKey?: string;
  keyId?: string;
  now?: number;
  allowExpired?: boolean;
  expected?: Partial<Pick<AskReceiptPayloadV1,
    'askId' | 'larkAppId' | 'sessionId' | 'chatId' | 'rootMessageId' |
    'questionDigest' | 'answerDigest' | 'selected' | 'platformEventId' |
    'cardMessageId' | 'askNonce' | 'jti'>>;
}

function detachedVerifiedPayload(payload: AskReceiptPayloadV1): VerifiedAskReceiptPayloadV1 {
  const answers = payload.answers.map((answer) => Object.freeze([...answer]));
  const actor = Object.freeze({ ...payload.actor });
  return Object.freeze({
    ...payload,
    answers: Object.freeze(answers),
    actor,
  });
}

interface SnapshotBudget {
  values: number;
  stringBytes: number;
}

/**
 * Take the single bounded plain-data copy used throughout one card callback.
 * The root is process-locally branded so downstream provenance issuance can
 * reuse the ingress snapshot by identity instead of copying caller data again.
 */
export function snapshotAskCallbackData(
  value: unknown,
): unknown {
  return snapshotCallbackData(value, false);
}

/** Accept exactly the root metadata marker added by Lark's EventDispatcher. */
export function snapshotLarkCardActionCallbackData(value: unknown): unknown {
  return snapshotCallbackData(value, true);
}

function snapshotCallbackData(
  value: unknown,
  allowLarkEventTypeAtRoot: boolean,
): unknown {
  if (value !== null && typeof value === 'object' && askCallbackSnapshots.has(value)) {
    return value;
  }
  const snapshot = snapshotAskCallbackDataUnbranded(
    value, 0, { values: 0, stringBytes: 0 }, allowLarkEventTypeAtRoot,
  );
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  askCallbackSnapshots.add(snapshot);
  return snapshot;
}

function snapshotAskCallbackDataUnbranded(
  value: unknown,
  depth: number,
  budget: SnapshotBudget,
  allowLarkEventTypeAtRoot = false,
): unknown {
  if (++budget.values > MAX_CALLBACK_SNAPSHOT_VALUES) {
    throw new Error('Ask callback exceeds snapshot bounds');
  }
  if (depth > MAX_CALLBACK_SNAPSHOT_DEPTH) throw new Error('Ask callback exceeds snapshot bounds');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    budget.stringBytes += Buffer.byteLength(value, 'utf8');
    if (budget.stringBytes > MAX_CALLBACK_SNAPSHOT_STRING_BYTES) {
      throw new Error('Ask callback strings exceed snapshot bounds');
    }
    return value;
  }
  if (typeof value !== 'object' || isProxy(value)) {
    throw new Error('Ask callback must contain plain data');
  }

  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const symbolKeys = keys.filter((key): key is symbol => typeof key === 'symbol');
  const larkEventType = symbolKeys.length === 1
    ? Object.getOwnPropertyDescriptor(value, symbolKeys[0])
    : undefined;
  const hasOnlyExpectedLarkEventType = depth === 0
    && allowLarkEventTypeAtRoot
    && symbolKeys.length === 1
    && Symbol.keyFor(symbolKeys[0]) === undefined
    && symbolKeys[0].description === 'event-type'
    && !!larkEventType
    && 'value' in larkEventType
    && larkEventType.enumerable === true
    && larkEventType.value === 'card.action.trigger';
  if (symbolKeys.length > 0 && !hasOnlyExpectedLarkEventType) {
    throw new Error('Ask callback must not contain symbol properties');
  }
  const stringKeys = keys.filter((key): key is string => typeof key === 'string');

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new Error('Ask callback arrays must be plain');
    const length = descriptors.length;
    if (!length || 'get' in length || !Number.isSafeInteger(length.value) || length.value < 0) {
      throw new Error('Ask callback array length is invalid');
    }
    const out: unknown[] = [];
    for (const key of stringKeys) {
      if (key === 'length') continue;
      const index = Number(key);
      const descriptor = descriptors[key]!;
      if (!/^(0|[1-9]\d*)$/.test(key) || index >= length.value
          || 'get' in descriptor || descriptor.enumerable !== true) {
        throw new Error('Ask callback arrays must contain only data elements');
      }
    }
    for (let index = 0; index < length.value; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || 'get' in descriptor) throw new Error('Ask callback arrays must not be sparse');
      out.push(snapshotAskCallbackDataUnbranded(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(out);
  }
  if (prototype !== Object.prototype) throw new Error('Ask callback objects must be plain');
  const out: Record<string, unknown> = {};
  for (const key of stringKeys) {
    const descriptor = descriptors[key]!;
    if ('get' in descriptor || descriptor.enumerable !== true) {
      throw new Error('Ask callback objects must contain only enumerable data properties');
    }
    Object.defineProperty(out, key, {
      value: snapshotAskCallbackDataUnbranded(descriptor.value, depth + 1, budget),
      enumerable: true, configurable: false, writable: false,
    });
  }
  return Object.freeze(out);
}

/** Normalize legacy Lark form values exactly as the Ask card handler does. */
export function normalizeAskSubmitValue(
  formValue: Readonly<Record<string, unknown>> | undefined,
  confirmEmptyValue: unknown,
): NormalizedAskSubmitValue {
  const confirmEmpty = confirmEmptyValue === true || confirmEmptyValue === 'true';
  if (!formValue || Object.keys(formValue).length === 0) {
    return Object.freeze({ confirmEmpty, formAnswers: null });
  }
  let maxQuestionIndex = -1;
  for (const key of Object.keys(formValue)) {
    const match = /^q(\d+)$/.exec(key);
    if (match) maxQuestionIndex = Math.max(maxQuestionIndex, Number(match[1]));
  }
  const questionCount = maxQuestionIndex >= 0 ? maxQuestionIndex + 1 : 1;
  const formAnswers = Array.from({ length: questionCount }, (_, questionIndex) => {
    const raw = formValue[`q${questionIndex}`];
    const tokens = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string')
      : typeof raw === 'string'
        ? raw.split(/[,;]/).map((item) => item.trim()).filter(Boolean)
        : [];
    const prefix = `${questionIndex}::`;
    return Object.freeze(tokens.filter((token) => token.startsWith(prefix))
      .map((token) => token.slice(prefix.length)));
  });
  return Object.freeze({ confirmEmpty, formAnswers: Object.freeze(formAnswers) });
}

/** Copy one untrusted JSON-like graph without invoking accessors or retaining
 * caller-owned references. Proxy objects are rejected explicitly; descriptor
 * lookup failures and changing proxy traps are caught by the verifier. */
function snapshotPlainData(
  value: unknown,
  depth = 0,
  budget: SnapshotBudget = { values: 0, stringBytes: 0 },
): unknown {
  if (++budget.values > MAX_SNAPSHOT_VALUES || depth > MAX_SNAPSHOT_DEPTH) {
    throw new Error('Ask receipt exceeds snapshot bounds');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    budget.stringBytes += Buffer.byteLength(value, 'utf8');
    if (budget.stringBytes > MAX_SNAPSHOT_STRING_BYTES) {
      throw new Error('Ask receipt strings exceed snapshot bounds');
    }
    return value;
  }
  if (typeof value !== 'object' || isProxy(value)) {
    throw new Error('Ask receipt must contain plain data');
  }

  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new Error('Ask receipt must not contain symbol properties');
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new Error('Ask receipt arrays must be plain');
    const length = descriptors.length;
    if (!length || 'get' in length || !Number.isSafeInteger(length.value) || length.value < 0) {
      throw new Error('Ask receipt array length is invalid');
    }
    const out: unknown[] = [];
    for (const key of keys as string[]) {
      if (key === 'length') continue;
      const index = Number(key);
      const descriptor = descriptors[key]!;
      if (!/^(0|[1-9]\d*)$/.test(key) || index >= length.value
          || 'get' in descriptor || descriptor.enumerable !== true) {
        throw new Error('Ask receipt arrays must contain only data elements');
      }
    }
    for (let index = 0; index < length.value; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || 'get' in descriptor) throw new Error('Ask receipt arrays must not be sparse');
      out.push(snapshotPlainData(descriptor.value, depth + 1, budget));
    }
    return out;
  }

  if (prototype !== Object.prototype) throw new Error('Ask receipt objects must be plain');
  const out: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]!;
    if ('get' in descriptor || descriptor.enumerable !== true) {
      throw new Error('Ask receipt objects must contain only enumerable data properties');
    }
    Object.defineProperty(out, key, {
      value: snapshotPlainData(descriptor.value, depth + 1, budget),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** RFC 8785-style key ordering for the JSON value subset used by this schema. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error('ask receipt numbers must be finite safe integers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error('ask receipt arrays must not be sparse');
    }
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      const member = value[key];
      if (member === undefined) throw new Error('ask receipt values must not be undefined');
      return `${JSON.stringify(key)}:${canonicalJson(member)}`;
    }).join(',')}}`;
  }
  throw new Error('unsupported ask receipt value');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

const LARK_CARD_ACTION_METADATA_KEYS = ['tag', 'name', 'option', 'timezone'] as const;
export const BOTMUX_ASK_CALLBACK_MARKER_KEY = '__bm_cb';
export const BOTMUX_ASK_CALLBACK_MARKER_VERSION = 1;

/** Validate the documented Lark transport metadata around action.value. */
export function hasOnlyLarkCardActionKeys(
  action: Record<string, unknown>,
  includeFormValue: boolean,
): boolean {
  const required = includeFormValue ? ['value', 'form_value'] : ['value'];
  const allowed = new Set([...required, ...LARK_CARD_ACTION_METADATA_KEYS]);
  if (!required.every(key => Object.prototype.hasOwnProperty.call(action, key))
      || Object.keys(action).some(key => !allowed.has(key))) {
    return false;
  }
  return LARK_CARD_ACTION_METADATA_KEYS.every(key =>
    action[key] === undefined || action[key] === null || typeof action[key] === 'string',
  );
}

/** Allow the egress ownership marker that Botmux itself stamps onto every
 * callback button while keeping all other callback value keys exact. */
export function hasExactAskCallbackValueKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const marker = value[BOTMUX_ASK_CALLBACK_MARKER_KEY];
  const expectedKeys = marker === undefined
    ? expected
    : [...expected, BOTMUX_ASK_CALLBACK_MARKER_KEY];
  return exactKeys(value, expectedKeys)
    && (marker === undefined || marker === BOTMUX_ASK_CALLBACK_MARKER_VERSION);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeCanonicalBase64url(
  encoded: string,
  expectedBytes: number,
  label: string,
): Buffer {
  if (!nonEmptyString(encoded) || !BASE64URL_RE.test(encoded)) {
    throw new Error(`invalid ${label} encoding`);
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== encoded) {
    throw new Error(`invalid ${label} encoding`);
  }
  return decoded;
}

function validAnswers(value: unknown): value is string[][] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) return false;
    const answer = value[i];
    if (!Array.isArray(answer)) return false;
    for (let j = 0; j < answer.length; j++) {
      if (!Object.prototype.hasOwnProperty.call(answer, j) || !nonEmptyString(answer[j])) return false;
    }
  }
  return true;
}

export function isAskReceiptPayloadV1(value: unknown): value is AskReceiptPayloadV1 {
  if (!isPlainRecord(value) || !exactKeys(value, [
    'schema', 'askId', 'larkAppId', 'sessionId', 'chatId', 'rootMessageId',
    'questionDigest', 'answerDigest', 'answers', 'selected', 'actor', 'source',
    'platformEventId', 'cardMessageId', 'askNonce', 'answeredAt', 'expiresAt',
    'daemonBootId', 'signerInstanceId', 'keyId', 'jti',
  ])) return false;
  if (!isPlainRecord(value.actor) || !exactKeys(value.actor, ['kind', 'identity'])) return false;
  return value.schema === ASK_RECEIPT_SCHEMA
    && nonEmptyString(value.askId)
    && nonEmptyString(value.larkAppId)
    && nonEmptyString(value.sessionId)
    && nonEmptyString(value.chatId)
    && nullableString(value.rootMessageId)
    && /^[a-f0-9]{64}$/.test(String(value.questionDigest))
    && /^[a-f0-9]{64}$/.test(String(value.answerDigest))
    && validAnswers(value.answers)
    && nullableString(value.selected)
    && value.actor.kind === 'lark_user'
    && nonEmptyString(value.actor.identity)
    && value.source === 'lark_card'
    && nonEmptyString(value.platformEventId)
    && nonEmptyString(value.cardMessageId)
    && nonEmptyString(value.askNonce)
    && safeTimestamp(value.answeredAt)
    && safeTimestamp(value.expiresAt)
    && value.expiresAt > value.answeredAt
    && value.expiresAt - value.answeredAt <= 300_000
    && nonEmptyString(value.daemonBootId)
    && nonEmptyString(value.signerInstanceId)
    && /^[a-f0-9]{64}$/.test(String(value.keyId))
    && nonEmptyString(value.jti)
    && value.answerDigest === askAnswerDigest(value.answers, null)
    && value.selected === (value.answers.length === 1 && value.answers[0]?.length === 1
      ? value.answers[0][0]!
      : null)
    && value.jti === askReceiptJti({
      larkAppId: value.larkAppId,
      sessionId: value.sessionId,
      askId: value.askId,
      platformEventId: value.platformEventId,
      cardMessageId: value.cardMessageId,
    });
}

function isSignedAskReceiptSnapshot(value: unknown): value is SignedAskReceiptV1 {
  if (!isPlainRecord(value) || !exactKeys(value, ['payload', 'algorithm', 'publicKey', 'signature'])) return false;
  if (value.algorithm !== ASK_RECEIPT_ALGORITHM
      || !nonEmptyString(value.publicKey) || !BASE64URL_RE.test(value.publicKey)
      || !nonEmptyString(value.signature) || !BASE64URL_RE.test(value.signature)
      || !isAskReceiptPayloadV1(value.payload)) return false;
  try {
    const publicKey = importAskReceiptPublicKey(value.publicKey);
    return askReceiptKeyId(value.publicKey) === value.payload.keyId
      && decodeCanonicalBase64url(value.signature, ED25519_SIGNATURE_BYTES, 'Ask receipt signature').length === ED25519_SIGNATURE_BYTES
      && publicKey.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export function isSignedAskReceiptV1(value: unknown): value is SignedAskReceiptV1 {
  try {
    return isSignedAskReceiptSnapshot(snapshotPlainData(value));
  } catch {
    return false;
  }
}

export function canonicalAskReceiptBytes(payload: AskReceiptPayloadV1): Buffer {
  if (!isAskReceiptPayloadV1(payload)) throw new Error('invalid botmux.ask-receipt.v1 payload');
  return Buffer.from(`${SIGNING_DOMAIN}${canonicalJson(payload)}`, 'utf8');
}

export function askQuestionDigest(questions: ReadonlyArray<AskQuestion>): string {
  const canonical = questions.map((question) => ({
    prompt: question.prompt,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({ key: option.key, label: option.label })),
  }));
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

export function askAnswerDigest(answers: ReadonlyArray<ReadonlyArray<string>>, comment: string | null): string {
  return createHash('sha256').update(canonicalJson({
    answers: answers.map((answer) => [...answer]),
    comment,
  })).digest('hex');
}

export function askReceiptKeyId(publicKey: string): string {
  return createHash('sha256')
    .update(decodeCanonicalBase64url(publicKey, ED25519_SPKI_DER_BYTES, 'Ask receipt public key'))
    .digest('hex');
}

export function askReceiptJti(input: {
  larkAppId: string;
  sessionId: string;
  askId: string;
  platformEventId: string;
  cardMessageId: string;
}): string {
  return createHash('sha256')
    .update(`botmux.ask-receipt.jti.v1\0${canonicalJson(input)}`)
    .digest('base64url');
}

export function exportAskReceiptPublicKey(key: KeyObject): string {
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Ask receipt public key must be Ed25519');
  }
  return key.export({ format: 'der', type: 'spki' }).toString('base64url');
}

export function importAskReceiptPublicKey(encoded: string): KeyObject {
  const key = createPublicKey({
    key: decodeCanonicalBase64url(encoded, ED25519_SPKI_DER_BYTES, 'Ask receipt public key'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ask receipt public key must be Ed25519');
  return key;
}

export function verifyAskReceipt(
  candidate: unknown,
  options: VerifyAskReceiptOptions = {},
): AskReceiptVerification {
  let receipt: unknown;
  try { receipt = snapshotPlainData(candidate); }
  catch { return { ok: false, error: 'malformed' }; }
  if (!isSignedAskReceiptSnapshot(receipt)) return { ok: false, error: 'malformed' };
  // Authenticity requires an independently pinned trust anchor. The embedded
  // key is transport material only and must never be trusted by default.
  if (!options.publicKey && !options.keyId) return { ok: false, error: 'untrusted_key' };
  if ((options.publicKey && receipt.publicKey !== options.publicKey)
      || (options.keyId && receipt.payload.keyId !== options.keyId)) {
    return { ok: false, error: 'untrusted_key' };
  }
  if (options.expected) {
    for (const [key, expected] of Object.entries(options.expected)) {
      if (canonicalJson(receipt.payload[key as keyof AskReceiptPayloadV1]) !== canonicalJson(expected)) {
        return { ok: false, error: 'binding_mismatch' };
      }
    }
  }
  try {
    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) return { ok: false, error: 'malformed' };
    if (!cryptoVerify(
      null,
      canonicalAskReceiptBytes(receipt.payload),
      importAskReceiptPublicKey(receipt.publicKey),
      decodeCanonicalBase64url(receipt.signature, ED25519_SIGNATURE_BYTES, 'Ask receipt signature'),
    )) return { ok: false, error: 'invalid_signature' };
    if (now < receipt.payload.answeredAt) return { ok: false, error: 'malformed' };
    const expired = now >= receipt.payload.expiresAt;
    if (expired && !options.allowExpired) return { ok: false, error: 'expired' };
    return { ok: true, expired, payload: detachedVerifiedPayload(receipt.payload) };
  } catch {
    return { ok: false, error: 'malformed' };
  }
}
