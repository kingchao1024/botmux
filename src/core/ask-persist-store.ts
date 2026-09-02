/** Durable, restart-safe persistence for pending and terminal Botmux asks. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withSecureHostParentSync, type SecureHostParentHandle } from '../platform/secure-host-file.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { ASK_MAX_TIMEOUT_MS } from './ask-limits.js';
import {
  askAnswerDigest,
  askQuestionDigest,
  canonicalJson,
  verifyAskReceipt,
  type AskPersistenceIntegrityAuthority,
  type AskPersistenceIntegrityV1,
  type SignedAskReceiptV1,
} from './ask-receipt.js';
import type { AskQuestion, AskResult } from './ask-types.js';

export const ASK_STORE_SENTINEL = '.botmux-ask-store';
export const HANDOFF_RETENTION_MS = 24 * 60 * 60 * 1000;

const SIGNED_STATE_SCHEMA = 'botmux.ask-persist-state.v1' as const;
const TERMINAL_OUTBOX_SCHEMA = 'botmux.ask-terminal-receipt.v3' as const;
const MAX_SIGNED_RECORD_BYTES = 1024 * 1024;
const MAX_OUTBOX_RECORD_BYTES = 1024 * 1024;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_PENDING_RECORDS = 2048;
const MAX_TERMINAL_RECORDS = 2048;
const HASHED_JSON_NAME = /^[a-f0-9]{64}\.json$/;

interface PersistedAskFields {
  askKey: string;
  requestId: string;
  originKind: string;
  askId: string;
  nonce: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string | null;
  sessionId: string;
  chatType?: 'group' | 'p2p';
  questions: ReadonlyArray<AskQuestion>;
  createdAt: number;
  deadlineAt: number;
  /** Original absolute S1 activation window; both are absent for non-S1 asks. */
  notBeforeMs?: number;
  expiresAtMs?: number;
  cardMessageId?: string;
  selections: ReadonlyArray<ReadonlyArray<string>>;
  selectionActorIdentity?: string;
  answeredResult?: AskResult;
  answeredAt?: number;
}

export type PersistedAsk =
  | (PersistedAskFields & { v: 2; receiptEligible?: never; integrity?: never })
  | (PersistedAskFields & {
      v: 3;
      revision: number;
      receiptEligible: boolean;
      integrity: AskPersistenceIntegrityV1;
    });

export type PersistedAskWrite =
  | (PersistedAskFields & { v: 2; receiptEligible?: never })
  | (PersistedAskFields & { v: 3; receiptEligible: boolean });

export type SignedAskWrite = Extract<PersistedAskWrite, { v: 3 }>;
type AnsweredResult = Extract<AskResult, { kind: 'answered' }>;

interface SignedAskStateUnsignedV1 extends PersistedAskFields {
  schema: typeof SIGNED_STATE_SCHEMA;
  v: 3;
  revision: number;
  previousRevision: number;
  state: 'pending' | 'terminal';
  receiptEligible: boolean;
  committedAt: number;
  terminalResult?: AskResult;
  recoverUntil?: number;
  outboxSha256: string | null;
  receiptJti: string | null;
}

interface SignedAskStateV1 extends SignedAskStateUnsignedV1 {
  integrity: AskPersistenceIntegrityV1;
}

interface PersistTerminalReceiptInput {
  schema: typeof TERMINAL_OUTBOX_SCHEMA;
  askKey: string;
  requestId: string;
  originKind: string;
  larkAppId: string;
  sessionId: string;
  chatId: string;
  rootMessageId: string | null;
  questionDigest: string;
  notBeforeMs: number;
  expiresAtMs: number;
  answeredResult: AnsweredResult;
  receipt: SignedAskReceiptV1;
  receiptSha256: string;
  receiptJti: string;
  answeredAt: number;
  recoverUntil: number;
  persistedAt: number;
}

interface SignedTerminalOutboxV1 extends PersistTerminalReceiptInput {
  revision: number;
  integrity: AskPersistenceIntegrityV1;
}

export interface CommitTerminalSignedInput {
  ask: SignedAskWrite;
  expectedRevision: number;
  answeredResult: AnsweredResult;
  receipt: SignedAskReceiptV1;
  now?: number;
  recoverUntil?: number;
}

export interface TerminalizeSignedInput {
  ask: SignedAskWrite;
  expectedRevision: number;
  result: AskResult;
  now?: number;
  recoverUntil?: number;
}

export interface RecoverTerminalReceiptInput {
  askKey: string;
  requestId: string;
  originKind: string;
  larkAppId: string;
  sessionId: string;
  chatId: string;
  rootMessageId: string | null;
  questionDigest: string;
  notBeforeMs: number;
  expiresAtMs: number;
  now?: number;
}

export type RecoverTerminalReceiptResult =
  | {
      ok: true;
      receipt: SignedAskReceiptV1;
      answeredResult: AnsweredResult;
      receiptSha256: string;
      receiptJti: string;
      answeredAt: number;
      recoverUntil: number;
      revision: number;
    }
  | { ok: false; reason: 'missing' | 'mismatch' | 'expired' | 'storage_error' };

export interface AskPersistSweepResult {
  removedStates: number;
  removedOutboxes: number;
}

export type AskPersistStoreFaultPoint =
  | 'after_outbox_fsync'
  | 'after_state_fsync'
  | 'after_root_pin'
  | 'unlink_state_eacces'
  | 'unlink_outbox_eacces';

export interface AskPersistStoreOptions {
  faultInjection?: AskPersistStoreFaultPoint | ((point: AskPersistStoreFaultPoint) => void);
  maxPendingRecords?: number;
  maxTerminalRecords?: number;
}

interface PinnedStoreRoot {
  root: SecureHostParentHandle;
  outbox: SecureHostParentHandle | undefined;
}

export class AskPersistRevisionConflictError extends Error {
  readonly code = 'ASK_REVISION_CONFLICT';

  constructor(askKey: string, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`ask-persist: revision conflict for ${askKey}: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'AskPersistRevisionConflictError';
  }
}

export class AskPersistCapacityError extends Error {
  readonly code = 'ASK_PERSIST_CAPACITY';

  constructor(kind: 'pending' | 'terminal') {
    super(`ask-persist: ${kind} capacity exhausted`);
    this.name = 'AskPersistCapacityError';
  }
}

export function askKeyFor(
  larkAppId: string,
  sessionId: string,
  originKind: string,
  requestId: string,
): string {
  return [larkAppId, sessionId, originKind, requestId]
    .map((segment) => `${String(segment).length}:${String(segment)}`)
    .join('|');
}

export function dispatchUuidForKey(askKey: string): string {
  return `ask-${createHash('sha256').update(`uuid|${askKey}`).digest('hex').slice(0, 40)}`;
}

export interface AskPersistStore {
  readonly dir: string;
  put(ask: PersistedAskWrite): void;
  remove(askKey: string): void;
  list(now?: number): PersistedAsk[];
  commitSigned(ask: SignedAskWrite, expectedRevision: number): number;
  commitTerminalSigned(input: CommitTerminalSignedInput): { revision: number };
  terminalizeSigned(input: TerminalizeSignedInput): { revision: number };
  recoverTerminalReceipt(input: RecoverTerminalReceiptInput): RecoverTerminalReceiptResult;
  sweep(now?: number): AskPersistSweepResult;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function answered(result: AskResult | undefined): result is AnsweredResult {
  return result?.kind === 'answered';
}

export function createAskPersistStore(
  dir: string,
  authority?: AskPersistenceIntegrityAuthority,
  options: AskPersistStoreOptions = {},
): AskPersistStore {
  const outboxDir = join(dir, 'terminal-receipts');
  const maxPendingRecords = options.maxPendingRecords ?? MAX_PENDING_RECORDS;
  const maxTerminalRecords = options.maxTerminalRecords ?? MAX_TERMINAL_RECORDS;
  if (!Number.isSafeInteger(maxPendingRecords) || maxPendingRecords < 1
      || !Number.isSafeInteger(maxTerminalRecords) || maxTerminalRecords < 1) {
    throw new Error('ask-persist: capacities must be positive safe integers');
  }
  const statePath = (askKey: string): string => join(dir, `${hash(askKey)}.json`);

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sentinel = join(dir, ASK_STORE_SENTINEL);
    if (!existsSync(sentinel)) {
      try { writeFileSync(sentinel, 'botmux ask persist store\n', { mode: 0o600 }); } catch { /* best effort */ }
    }
  }

  function inject(point: AskPersistStoreFaultPoint): void {
    const fault = options.faultInjection;
    if (typeof fault === 'function') {
      fault(point);
      return;
    }
    if (fault !== point) return;
    const error = new Error(`ask-persist fault injection: ${point}`) as NodeJS.ErrnoException;
    if (point.endsWith('_eacces')) error.code = 'EACCES';
    throw error;
  }

  function withCapacityLock<T>(fn: (pinned: PinnedStoreRoot) => T): T {
    ensureDir();
    let result: T | undefined;
    let completed = false;
    withSecureHostParentSync(
      join(dir, '.signed-capacity'),
      (root) => root.withNamedLeafLock('.signed-capacity', () => {
        inject('after_root_pin');
        const needsOutbox = authority !== undefined;
        const run = (outbox: SecureHostParentHandle | undefined): void => {
          result = fn({ root, outbox });
          completed = true;
        };
        if (needsOutbox) {
          root.withChildDirectory('terminal-receipts', (outbox) => run(outbox), {
            create: true, exactMode: 0o700,
          });
        } else {
          run(undefined);
        }
      }),
      { exactParentMode: 0o700 },
    );
    if (!completed) throw new Error('ask-persist: capacity lock callback did not complete');
    return result as T;
  }

  function withAskLock<T>(
    pinned: PinnedStoreRoot,
    askKey: string,
    fn: (parent: SecureHostParentHandle) => T,
  ): T {
    let result: T | undefined;
    let completed = false;
    const name = `${hash(askKey)}.json`;
    pinned.root.withNamedLeafLock(name, () => {
        result = fn(pinned.root);
        completed = true;
    });
    if (!completed) throw new Error('ask-persist: ask lock callback did not complete');
    return result as T;
  }

  function verifyIntegrity(unsigned: unknown, integrity: unknown): void {
    if (!authority?.verifyPersistedState(unsigned, integrity)) {
      throw new Error('ask-persist: tampered or untrusted signed state');
    }
  }

  function validateAskFields(ask: PersistedAskFields): void {
    if (!ask.askKey || !ask.requestId || !ask.originKind || !ask.askId || !ask.nonce
        || !ask.larkAppId || !ask.chatId || !ask.sessionId
        || ask.askKey !== askKeyFor(ask.larkAppId, ask.sessionId, ask.originKind, ask.requestId)
        || (ask.rootMessageId !== null && typeof ask.rootMessageId !== 'string')
        || (ask.chatType !== undefined && ask.chatType !== 'group' && ask.chatType !== 'p2p')
        || (ask.cardMessageId !== undefined
          && (typeof ask.cardMessageId !== 'string' || !ask.cardMessageId))
        || !safeTimestamp(ask.createdAt) || !safeTimestamp(ask.deadlineAt)
        || ask.deadlineAt <= ask.createdAt
        || ask.deadlineAt - ask.createdAt > ASK_MAX_TIMEOUT_MS
        || !Array.isArray(ask.questions) || !Array.isArray(ask.selections)
        || ask.questions.length !== ask.selections.length
        || !ask.questions.every((question) => question && typeof question.prompt === 'string'
          && typeof question.multiSelect === 'boolean' && Array.isArray(question.options))
        || !ask.selections.every((keys) => Array.isArray(keys)
          && keys.every((key) => typeof key === 'string' && key.length > 0))
        || (ask.selectionActorIdentity !== undefined
          && (typeof ask.selectionActorIdentity !== 'string' || !ask.selectionActorIdentity))) {
      throw new Error(`ask-persist: invalid ask state for ${ask.askKey || '<unknown>'}`);
    }
    if (ask.originKind === 's1-controller') {
      if (!safeTimestamp(ask.notBeforeMs) || !safeTimestamp(ask.expiresAtMs)
          || ask.expiresAtMs !== ask.deadlineAt
          || ask.expiresAtMs <= ask.notBeforeMs
          || ask.expiresAtMs - ask.notBeforeMs > ASK_MAX_TIMEOUT_MS) {
        throw new Error(`ask-persist: invalid S1 activation window for ${ask.askKey}`);
      }
    } else if (ask.notBeforeMs !== undefined || ask.expiresAtMs !== undefined) {
      throw new Error(`ask-persist: non-S1 state carries an activation window for ${ask.askKey}`);
    }
  }

  function validateExpectedRevision(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
      throw new Error('ask-persist: expectedRevision must be a non-negative safe integer');
    }
  }

  function validateRecoveryWindow(now: number, recoverUntil: number): void {
    if (!safeTimestamp(now) || !safeTimestamp(recoverUntil)
        || recoverUntil - now !== HANDOFF_RETENTION_MS) {
      throw new Error('ask-persist: invalid terminal recovery window');
    }
  }

  function validateReceiptBinding(
    ask: PersistedAskFields,
    result: AnsweredResult,
    receipt: SignedAskReceiptV1,
    answeredAt: number,
  ): void {
    const questionDigest = askQuestionDigest(ask.questions);
    const answerDigest = askAnswerDigest(result.answers, result.comment);
    const selected = result.answers.length === 1 && result.answers[0]?.length === 1
      ? result.answers[0][0]!
      : null;
    const verified = verifyAskReceipt(receipt, {
      publicKey: authority?.publicKey,
      keyId: authority?.keyId,
      now: answeredAt,
      allowExpired: true,
      expected: {
        askId: ask.askId,
        larkAppId: ask.larkAppId,
        sessionId: ask.sessionId,
        chatId: ask.chatId,
        rootMessageId: ask.rootMessageId,
        questionDigest,
        answerDigest,
        selected,
        cardMessageId: ask.cardMessageId ?? '',
        askNonce: ask.nonce,
      },
    });
    if (!verified.ok
        || !('receiptEligible' in ask)
        || ask.receiptEligible !== true
        || result.comment !== null
        || result.by !== receipt.payload.actor.identity
        || (ask.selectionActorIdentity !== undefined && ask.selectionActorIdentity !== result.by)
        || answeredAt >= ask.deadlineAt
        || receipt.payload.expiresAt > ask.deadlineAt
        || receipt.payload.answeredAt !== answeredAt
        || !canonicalEqual(result.answers, receipt.payload.answers)
        || !result.receipt
        || !canonicalEqual(result.receipt, receipt)) {
      throw new Error(`ask-persist: invalid terminal receipt binding for ${ask.askKey}`);
    }
  }

  function validateTerminalResult(ask: PersistedAskFields, result: AskResult): void {
    if (answered(result)) {
      if (!Array.isArray(result.answers) || result.answers.length !== ask.questions.length
          || !result.answers.every((keys, index) => Array.isArray(keys)
            && new Set(keys).size === keys.length
            && keys.every((key) => ask.questions[index]?.options.some((option) => option.key === key))
            && (ask.questions[index]?.multiSelect === true || keys.length === (result.comment === null ? 1 : 0)))
          || (result.comment !== null && result.answers.some((keys) => keys.length > 0))
          || typeof result.by !== 'string' || !result.by
          || (result.comment !== null && typeof result.comment !== 'string')
          || result.timedOut !== false) {
        throw new Error(`ask-persist: invalid answered terminal result for ${ask.askKey}`);
      }
      return;
    }
    if (result.kind === 'timedOut') {
      if (result.selected !== null || result.by !== null || result.comment !== null || result.timedOut !== true) {
        throw new Error(`ask-persist: invalid timedOut terminal result for ${ask.askKey}`);
      }
      return;
    }
    if (result.kind !== 'invalidated' || typeof result.reason !== 'string' || !result.reason
        || result.selected !== null || result.by !== null || result.comment !== null
        || result.timedOut !== false) {
      throw new Error(`ask-persist: invalid terminal result for ${ask.askKey}`);
    }
  }

  function parseSignedState(raw: string, expectedAskKey?: string, now = Date.now()): SignedAskStateV1 {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('ask-persist: invalid signed state JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ask-persist: invalid signed state');
    }
    const state = parsed as SignedAskStateV1;
    const { integrity, ...unsigned } = state;
    validateAskFields(unsigned);
    if (unsigned.schema !== SIGNED_STATE_SCHEMA || unsigned.v !== 3
        || (expectedAskKey !== undefined && unsigned.askKey !== expectedAskKey)
        || !Number.isSafeInteger(unsigned.revision) || unsigned.revision < 1
        || !Number.isSafeInteger(unsigned.previousRevision) || unsigned.previousRevision < 0
        || unsigned.previousRevision + 1 !== unsigned.revision
        || (unsigned.state !== 'pending' && unsigned.state !== 'terminal')
        || typeof unsigned.receiptEligible !== 'boolean'
        || !safeTimestamp(unsigned.committedAt)
        || unsigned.committedAt > now + MAX_FUTURE_SKEW_MS) {
      throw new Error(`ask-persist: invalid signed state for ${unsigned.askKey}`);
    }
    if (unsigned.state === 'pending') {
      if (unsigned.terminalResult !== undefined || unsigned.recoverUntil !== undefined
          || unsigned.answeredResult !== undefined || unsigned.answeredAt !== undefined
          || unsigned.outboxSha256 !== null || unsigned.receiptJti !== null) {
        throw new Error(`ask-persist: pending state carries terminal data for ${unsigned.askKey}`);
      }
    } else {
      if (!unsigned.terminalResult || unsigned.recoverUntil === undefined) {
        throw new Error(`ask-persist: terminal state is incomplete for ${unsigned.askKey}`);
      }
      validateTerminalResult(unsigned, unsigned.terminalResult);
      validateRecoveryWindow(unsigned.committedAt, unsigned.recoverUntil);
      if (answered(unsigned.terminalResult)) {
        if (!answered(unsigned.answeredResult)
            || !canonicalEqual(unsigned.answeredResult, unsigned.terminalResult)
            || !safeTimestamp(unsigned.answeredAt)) {
          throw new Error(`ask-persist: terminal answer mismatch for ${unsigned.askKey}`);
        }
        if (unsigned.terminalResult.receipt) {
          validateReceiptBinding(unsigned, unsigned.terminalResult, unsigned.terminalResult.receipt, unsigned.answeredAt);
        }
      } else if (unsigned.answeredResult !== undefined || unsigned.answeredAt !== undefined) {
        throw new Error(`ask-persist: non-answer terminal carries answer data for ${unsigned.askKey}`);
      }
      const requiresOutbox = unsigned.originKind === 's1-controller'
        && answered(unsigned.terminalResult)
        && unsigned.terminalResult.receipt !== undefined;
      if (requiresOutbox) {
        const terminalReceipt = (unsigned.terminalResult as AnsweredResult).receipt;
        if (typeof unsigned.outboxSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(unsigned.outboxSha256)
            || !terminalReceipt
            || unsigned.receiptJti !== terminalReceipt.payload.jti) {
          throw new Error(`ask-persist: terminal state has invalid outbox pointer for ${unsigned.askKey}`);
        }
      } else if (unsigned.outboxSha256 !== null || unsigned.receiptJti !== null) {
        throw new Error(`ask-persist: terminal state has unexpected outbox pointer for ${unsigned.askKey}`);
      }
    }
    verifyIntegrity(unsigned, integrity);
    return state;
  }

  function readStateLocked(
    parent: SecureHostParentHandle,
    askKey: string,
    now = Date.now(),
  ): SignedAskStateV1 | null {
    const raw = parent.readNamedLeaf(`${hash(askKey)}.json`, MAX_SIGNED_RECORD_BYTES);
    return raw === null ? null : parseSignedState(raw, askKey, now);
  }

  function writeStateLocked(parent: SecureHostParentHandle, unsigned: SignedAskStateUnsignedV1): void {
    if (!authority) throw new Error('ask-persist: signed state requires authority');
    const state: SignedAskStateV1 = {
      ...unsigned,
      integrity: authority.sealPersistedState(unsigned),
    };
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SIGNED_RECORD_BYTES) {
      throw new Error('ask-persist: signed state exceeds size limit');
    }
    parent.writeNamedLeaf(`${hash(unsigned.askKey)}.json`, serialized, MAX_SIGNED_RECORD_BYTES);
  }

  function parseOutbox(raw: string, expectedAskKey?: string, now = Date.now()): SignedTerminalOutboxV1 {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('ask-persist: invalid terminal outbox JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ask-persist: invalid terminal outbox');
    }
    const outbox = parsed as SignedTerminalOutboxV1;
    const { integrity, ...unsigned } = outbox;
    if (unsigned.schema !== TERMINAL_OUTBOX_SCHEMA
        || unsigned.originKind !== 's1-controller'
        || !unsigned.askKey || (expectedAskKey !== undefined && unsigned.askKey !== expectedAskKey)
        || !unsigned.requestId || !unsigned.larkAppId || !unsigned.sessionId || !unsigned.chatId
        || (unsigned.rootMessageId !== null && typeof unsigned.rootMessageId !== 'string')
        || !safeTimestamp(unsigned.notBeforeMs) || !safeTimestamp(unsigned.expiresAtMs)
        || unsigned.expiresAtMs <= unsigned.notBeforeMs
        || unsigned.expiresAtMs - unsigned.notBeforeMs > ASK_MAX_TIMEOUT_MS
        || !/^[a-f0-9]{64}$/.test(unsigned.questionDigest)
        || !/^[a-f0-9]{64}$/.test(unsigned.receiptSha256)
        || !unsigned.receiptJti || !answered(unsigned.answeredResult)
        || !safeTimestamp(unsigned.answeredAt) || !safeTimestamp(unsigned.persistedAt)
        || unsigned.persistedAt > now + MAX_FUTURE_SKEW_MS
        || !safeTimestamp(unsigned.recoverUntil) || unsigned.recoverUntil <= unsigned.answeredAt
        || unsigned.recoverUntil - unsigned.answeredAt > HANDOFF_RETENTION_MS
        || !Number.isSafeInteger(unsigned.revision) || unsigned.revision < 1
        || unsigned.receipt.payload.jti !== unsigned.receiptJti
        || unsigned.receipt.payload.answeredAt !== unsigned.answeredAt
        || hash(canonicalJson(unsigned.receipt)) !== unsigned.receiptSha256
        || !canonicalEqual(unsigned.answeredResult.receipt, unsigned.receipt)) {
      throw new Error(`ask-persist: invalid terminal outbox for ${unsigned.askKey || '<unknown>'}`);
    }
    const verification = verifyAskReceipt(unsigned.receipt, {
      publicKey: authority?.publicKey,
      keyId: authority?.keyId,
      now: unsigned.answeredAt,
      allowExpired: true,
      expected: {
        larkAppId: unsigned.larkAppId,
        sessionId: unsigned.sessionId,
        chatId: unsigned.chatId,
        rootMessageId: unsigned.rootMessageId,
        questionDigest: unsigned.questionDigest,
        answerDigest: askAnswerDigest(unsigned.answeredResult.answers, unsigned.answeredResult.comment),
        jti: unsigned.receiptJti,
      },
    });
    if (!verification.ok
        || unsigned.answeredResult.comment !== null
        || unsigned.answeredResult.by !== unsigned.receipt.payload.actor.identity
        || !canonicalEqual(unsigned.answeredResult.answers, unsigned.receipt.payload.answers)) {
      throw new Error(`ask-persist: terminal outbox receipt mismatch for ${unsigned.askKey}`);
    }
    verifyIntegrity(unsigned, integrity);
    return outbox;
  }

  function readOutbox(
    pinned: PinnedStoreRoot,
    askKey: string,
    now = Date.now(),
  ): { record: SignedTerminalOutboxV1; sha256: string } | null {
    if (!pinned.outbox) return null;
    const raw = pinned.outbox.readNamedLeaf(`${hash(askKey)}.json`, MAX_OUTBOX_RECORD_BYTES);
    return raw === null ? null : { record: parseOutbox(raw, askKey, now), sha256: hash(raw) };
  }

  function buildOutbox(
    ask: SignedAskWrite,
    revision: number,
    result: AnsweredResult,
    receipt: SignedAskReceiptV1,
    now: number,
    recoverUntil: number,
  ): Omit<SignedTerminalOutboxV1, 'integrity'> {
    return {
      schema: TERMINAL_OUTBOX_SCHEMA,
      askKey: ask.askKey,
      requestId: ask.requestId,
      originKind: 's1-controller',
      larkAppId: ask.larkAppId,
      sessionId: ask.sessionId,
      chatId: ask.chatId,
      rootMessageId: ask.rootMessageId,
      questionDigest: askQuestionDigest(ask.questions),
      notBeforeMs: ask.notBeforeMs!,
      expiresAtMs: ask.expiresAtMs!,
      answeredResult: result,
      receipt,
      receiptSha256: hash(canonicalJson(receipt)),
      receiptJti: receipt.payload.jti,
      answeredAt: receipt.payload.answeredAt,
      recoverUntil,
      persistedAt: now,
      revision,
    };
  }

  function sealOutbox(outbox: Omit<SignedTerminalOutboxV1, 'integrity'>): {
    serialized: string;
    sha256: string;
  } {
    if (!authority) throw new Error('ask-persist: signed outbox requires authority');
    const record: SignedTerminalOutboxV1 = {
      ...outbox,
      integrity: authority.sealPersistedState(outbox),
    };
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTBOX_RECORD_BYTES) {
      throw new Error('ask-persist: terminal outbox exceeds size limit');
    }
    return { serialized, sha256: hash(serialized) };
  }

  function writeOutbox(pinned: PinnedStoreRoot, askKey: string, serialized: string): void {
    if (!pinned.outbox) throw new Error('ask-persist: pinned outbox directory unavailable');
    pinned.outbox.writeNamedLeaf(`${hash(askKey)}.json`, serialized, MAX_OUTBOX_RECORD_BYTES);
  }

  function unlinkOutbox(pinned: PinnedStoreRoot, askKey: string): boolean {
    if (!pinned.outbox) return false;
    const name = `${hash(askKey)}.json`;
    if (pinned.outbox.readNamedLeaf(name, MAX_OUTBOX_RECORD_BYTES) === null) return false;
    inject('unlink_outbox_eacces');
    return pinned.outbox.unlinkNamedLeaf(name, MAX_OUTBOX_RECORD_BYTES);
  }

  function unlinkStateLocked(parent: SecureHostParentHandle, askKey: string): boolean {
    const name = `${hash(askKey)}.json`;
    if (parent.readNamedLeaf(name, MAX_SIGNED_RECORD_BYTES) === null) return false;
    inject('unlink_state_eacces');
    return parent.unlinkNamedLeaf(name, MAX_SIGNED_RECORD_BYTES);
  }

  function stateFileNames(root?: SecureHostParentHandle): string[] {
    if (root) return root.listLeafNames().filter((name) => HASHED_JSON_NAME.test(name));
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => HASHED_JSON_NAME.test(name));
  }

  function outboxFileNames(outbox?: SecureHostParentHandle): string[] {
    if (outbox) return outbox.listLeafNames().filter((name) => HASHED_JSON_NAME.test(name));
    if (!existsSync(outboxDir)) return [];
    return readdirSync(outboxDir).filter((name) => HASHED_JSON_NAME.test(name));
  }

  function stateForFilename(
    pinned: PinnedStoreRoot,
    name: string,
    now: number,
  ): SignedAskStateV1 | null {
    return pinned.root.withNamedLeafLock(name, () => {
      const raw = pinned.root.readNamedLeaf(name, MAX_SIGNED_RECORD_BYTES);
      if (raw === null) return null;
      const state = parseSignedState(raw, undefined, now);
      if (`${hash(state.askKey)}.json` !== name) throw new Error('ask-persist: state filename mismatch');
      return state;
    });
  }

  function sweepLocked(pinned: PinnedStoreRoot, now: number): AskPersistSweepResult {
    if (!safeTimestamp(now)) throw new Error('ask-persist: sweep time must be a non-negative safe integer');
    let removedStates = 0;
    let removedOutboxes = 0;

    for (const name of stateFileNames(pinned.root)) {
      let state: SignedAskStateV1 | null;
      try { state = stateForFilename(pinned, name, now); } catch { continue; }
      if (!state) continue;
      const expired = state.state === 'pending'
        ? state.deadlineAt <= now
        : state.recoverUntil! <= now;
      if (!expired) continue;
      withAskLock(pinned, state.askKey, (parent) => {
        const current = readStateLocked(parent, state!.askKey, now);
        if (!current || current.revision !== state!.revision) return;
        const stillExpired = current.state === 'pending'
          ? current.deadlineAt <= now
          : current.recoverUntil! <= now;
        if (!stillExpired) return;
        if (unlinkOutbox(pinned, current.askKey)) removedOutboxes++;
        if (unlinkStateLocked(parent, current.askKey)) removedStates++;
      });
    }

    for (const name of outboxFileNames(pinned.outbox)) {
      let askKey: string | undefined;
      let outbox: SignedTerminalOutboxV1 | undefined;
      let outboxSha256: string | undefined;
      try {
        const raw = pinned.outbox?.readNamedLeaf(name, MAX_OUTBOX_RECORD_BYTES);
        if (raw === null || raw === undefined) continue;
        const preliminary = JSON.parse(raw) as { askKey?: unknown };
        if (typeof preliminary.askKey !== 'string') throw new Error('ask-persist: orphan outbox has no ask key');
          askKey = preliminary.askKey;
          outbox = parseOutbox(raw, askKey, now);
          outboxSha256 = hash(raw);
      } catch { /* malformed outboxes are orphaned */ }
      let retained = false;
      if (askKey && outbox && `${hash(askKey)}.json` === name) {
        try {
          retained = withAskLock(pinned, askKey, (parent) => {
            const state = readStateLocked(parent, askKey!, now);
            return !!state && state.state === 'terminal'
              && state.originKind === 's1-controller'
              && state.revision === outbox!.revision
              && state.receiptJti === outbox!.receiptJti
              && state.outboxSha256 === outboxSha256;
          });
        } catch { retained = false; }
      }
      if (retained) continue;
      if (pinned.outbox) {
        // `askKey` came from untrusted file content and may intentionally hash
        // to a different filename. Sweep the exact directory entry we
        // enumerated so a malformed outbox cannot survive and consume a future
        // terminal reservation.
        inject('unlink_outbox_eacces');
        if (pinned.outbox.unlinkNamedRegularFile(name)) removedOutboxes++;
      }
    }
    return { removedStates, removedOutboxes };
  }

  function capacityCounts(pinned: PinnedStoreRoot, now: number): { pending: number; terminal: number } {
    let pending = 0;
    let terminal = 0;
    for (const name of stateFileNames(pinned.root)) {
      try {
        const state = stateForFilename(pinned, name, now);
        if (state?.state === 'pending') pending++;
        if (state?.state === 'terminal') terminal++;
      } catch { /* untrusted files are never counted as live signed state */ }
    }
    return { pending, terminal };
  }

  function prepareCapacity(pinned: PinnedStoreRoot, now: number): { pending: number; terminal: number } {
    sweepLocked(pinned, now);
    return capacityCounts(pinned, now);
  }

  function assertPendingAdmissionCapacity(counts: { pending: number; terminal: number }): void {
    if (counts.pending >= maxPendingRecords) throw new AskPersistCapacityError('pending');
    if (counts.pending + counts.terminal >= maxTerminalRecords) {
      throw new AskPersistCapacityError('terminal');
    }
  }

  function assertOutboxCapacity(pinned: PinnedStoreRoot, askKey: string): void {
    const names = outboxFileNames(pinned.outbox);
    const ownName = `${hash(askKey)}.json`;
    if (!names.includes(ownName) && names.length >= maxTerminalRecords) {
      throw new AskPersistCapacityError('terminal');
    }
  }

  function immutableAskIdentity(ask: PersistedAskFields) {
    return {
      askKey: ask.askKey, requestId: ask.requestId, originKind: ask.originKind, askId: ask.askId,
      nonce: ask.nonce, larkAppId: ask.larkAppId, chatId: ask.chatId,
      rootMessageId: ask.rootMessageId, sessionId: ask.sessionId, chatType: ask.chatType ?? null,
      questions: ask.questions, createdAt: ask.createdAt, deadlineAt: ask.deadlineAt,
      notBeforeMs: ask.notBeforeMs ?? null, expiresAtMs: ask.expiresAtMs ?? null,
    };
  }

  function assertImmutableIdentity(current: SignedAskStateV1, next: SignedAskWrite): void {
    if (!canonicalEqual(immutableAskIdentity(current), immutableAskIdentity(next))
        || (current.cardMessageId !== undefined && current.cardMessageId !== next.cardMessageId)
        || (!current.receiptEligible && next.receiptEligible)) {
      throw new Error(`ask-persist: immutable ask identity mismatch for ${next.askKey}`);
    }
  }

  function assertTerminalBaseMatches(current: SignedAskStateV1, next: SignedAskWrite): void {
    const projection = (ask: PersistedAskFields) => ({
      ...immutableAskIdentity(ask),
      cardMessageId: ask.cardMessageId ?? null, selections: ask.selections,
      selectionActorIdentity: ask.selectionActorIdentity ?? null,
      receiptEligible: 'receiptEligible' in ask ? ask.receiptEligible : null,
    });
    if (!canonicalEqual(projection(current), projection(next))) {
      throw new Error(`ask-persist: terminal state does not match authenticated pending state for ${next.askKey}`);
    }
  }

  function normalizeAsk(ask: SignedAskWrite): SignedAskWrite {
    const normalized = jsonClone(ask);
    validateAskFields(normalized);
    if (normalized.v !== 3 || typeof normalized.receiptEligible !== 'boolean') {
      throw new Error('ask-persist: invalid signed ask write');
    }
    return normalized;
  }

  function pendingState(
    ask: SignedAskWrite,
    previousRevision: number,
    now: number,
  ): SignedAskStateUnsignedV1 {
    const { answeredResult: _answer, answeredAt: _answeredAt, ...pendingAsk } = ask;
    return {
      ...pendingAsk,
      schema: SIGNED_STATE_SCHEMA,
      v: 3,
      revision: previousRevision + 1,
      previousRevision,
      state: 'pending',
      committedAt: now,
      outboxSha256: null,
      receiptJti: null,
    };
  }

  function terminalState(
    ask: SignedAskWrite,
    previousRevision: number,
    result: AskResult,
    now: number,
    recoverUntil: number,
    outboxSha256: string | null = null,
    receiptJti: string | null = null,
  ): SignedAskStateUnsignedV1 {
    const { answeredResult: _answer, answeredAt: _answeredAt, ...base } = ask;
    return {
      ...base,
      schema: SIGNED_STATE_SCHEMA,
      v: 3,
      revision: previousRevision + 1,
      previousRevision,
      state: 'terminal',
      committedAt: now,
      terminalResult: result,
      recoverUntil,
      outboxSha256,
      receiptJti,
      ...(answered(result) ? { answeredResult: result, answeredAt: now } : {}),
    };
  }

  function sameCommittedTerminal(
    current: SignedAskStateV1,
    expectedRevision: number,
    result: AskResult,
    recoverUntil: number,
  ): boolean {
    return current.state === 'terminal'
      && current.previousRevision === expectedRevision
      && current.recoverUntil === recoverUntil
      && canonicalEqual(current.terminalResult, result);
  }

  function commitSignedLocked(
    parent: SecureHostParentHandle,
    askInput: SignedAskWrite,
    expectedRevision: number,
    now: number,
    counts: { pending: number; terminal: number },
  ): number {
    const ask = normalizeAsk(askInput);
    const current = readStateLocked(parent, ask.askKey, now);
    if (current?.state === 'terminal') {
      throw new Error(`ask-persist: terminal state is absorbing for ${ask.askKey}`);
    }
    const actualRevision = current?.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      throw new AskPersistRevisionConflictError(ask.askKey, expectedRevision, actualRevision);
    }
    if (current) assertImmutableIdentity(current, ask);
    if (!current) assertPendingAdmissionCapacity(counts);

    if (ask.answeredResult !== undefined || ask.answeredAt !== undefined) {
      throw new Error('ask-persist: commitSigned accepts pending state only');
    }

    const state = pendingState(ask, actualRevision, now);
    writeStateLocked(parent, state);
    inject('after_state_fsync');
    return state.revision;
  }

  function commitSigned(ask: SignedAskWrite, expectedRevision: number): number {
    if (!authority) throw new Error('ask-persist: signed commit requires authority');
    validateExpectedRevision(expectedRevision);
    const now = Date.now();
    return withCapacityLock((pinned) => {
      const counts = prepareCapacity(pinned, now);
      return withAskLock(pinned, ask.askKey, (parent) =>
        commitSignedLocked(parent, ask, expectedRevision, now, counts));
    });
  }

  function terminalizeSigned(input: TerminalizeSignedInput): { revision: number } {
    if (!authority) throw new Error('ask-persist: signed terminal commit requires authority');
    validateExpectedRevision(input.expectedRevision);
    const ask = normalizeAsk(input.ask);
    const result = jsonClone(input.result);
    const now = input.now ?? Date.now();
    const recoverUntil = input.recoverUntil ?? now + HANDOFF_RETENTION_MS;
    validateRecoveryWindow(now, recoverUntil);
    validateTerminalResult(ask, result);
    if (ask.originKind === 's1-controller' && answered(result) && !result.receipt) {
      throw new Error('ask-persist: S1 answered terminal requires a signed receipt');
    }
    if (answered(result) && result.receipt) {
      return commitTerminalSigned({
        ask, expectedRevision: input.expectedRevision, answeredResult: result,
        receipt: result.receipt, now, recoverUntil,
      });
    }
    return withCapacityLock((pinned) => {
      return withAskLock(pinned, ask.askKey, (parent) => {
        const current = readStateLocked(parent, ask.askKey, now);
        if (current) {
          assertImmutableIdentity(current, ask);
          assertTerminalBaseMatches(current, ask);
        }
        if (current && sameCommittedTerminal(current, input.expectedRevision, result, recoverUntil)) {
          return { revision: current.revision };
        }
        if (current?.state === 'terminal') {
          throw new Error(`ask-persist: terminal state is absorbing for ${ask.askKey}`);
        }
        const actualRevision = current?.revision ?? 0;
        if (actualRevision !== input.expectedRevision) {
          throw new AskPersistRevisionConflictError(ask.askKey, input.expectedRevision, actualRevision);
        }
        if (!current) throw new Error(`ask-persist: terminal commit requires authenticated pending state for ${ask.askKey}`);
        const state = terminalState(ask, actualRevision, result, now, recoverUntil);
        writeStateLocked(parent, state);
        inject('after_state_fsync');
        return { revision: state.revision };
      });
    });
  }

  function commitTerminalSigned(input: CommitTerminalSignedInput): { revision: number } {
    if (!authority) throw new Error('ask-persist: signed terminal commit requires authority');
    validateExpectedRevision(input.expectedRevision);
    const ask = normalizeAsk(input.ask);
    const result = jsonClone(input.answeredResult);
    const receipt = jsonClone(input.receipt);
    const now = input.now ?? receipt.payload.answeredAt;
    const recoverUntil = input.recoverUntil ?? now + HANDOFF_RETENTION_MS;
    validateRecoveryWindow(now, recoverUntil);
    validateTerminalResult(ask, result);
    validateReceiptBinding(ask, result, receipt, now);

    return withCapacityLock((pinned) => {
      return withAskLock(pinned, ask.askKey, (parent) => {
        const current = readStateLocked(parent, ask.askKey, now);
        if (current) {
          assertImmutableIdentity(current, ask);
          assertTerminalBaseMatches(current, ask);
        }
        if (current && sameCommittedTerminal(current, input.expectedRevision, result, recoverUntil)) {
          if (ask.originKind === 's1-controller') {
            const outbox = readOutbox(pinned, ask.askKey, now);
            if (!outbox || outbox.record.revision !== current.revision
                || outbox.record.receiptJti !== current.receiptJti
                || outbox.sha256 !== current.outboxSha256) {
              throw new Error(`ask-persist: committed S1 terminal state has no matching outbox for ${ask.askKey}`);
            }
          }
          return { revision: current.revision };
        }
        if (current?.state === 'terminal') {
          throw new Error(`ask-persist: terminal state is absorbing for ${ask.askKey}`);
        }
        const actualRevision = current?.revision ?? 0;
        if (actualRevision !== input.expectedRevision) {
          throw new AskPersistRevisionConflictError(ask.askKey, input.expectedRevision, actualRevision);
        }
        if (!current) throw new Error(`ask-persist: terminal commit requires authenticated pending state for ${ask.askKey}`);
        let outboxSha256: string | null = null;
        let receiptJti: string | null = null;
        if (ask.originKind === 's1-controller') {
          assertOutboxCapacity(pinned, ask.askKey);
          const sealedOutbox = sealOutbox(buildOutbox(
            ask, actualRevision + 1, result, receipt, now, recoverUntil,
          ));
          writeOutbox(pinned, ask.askKey, sealedOutbox.serialized);
          outboxSha256 = sealedOutbox.sha256;
          receiptJti = receipt.payload.jti;
          inject('after_outbox_fsync');
        }
        const state = terminalState(
          ask, actualRevision, result, now, recoverUntil, outboxSha256, receiptJti,
        );
        writeStateLocked(parent, state);
        inject('after_state_fsync');
        return { revision: state.revision };
      });
    });
  }

  function recoveredResult(result: AnsweredResult, receipt: SignedAskReceiptV1): AnsweredResult {
    const detachedReceipt = deepFreeze(jsonClone(receipt));
    const detached = jsonClone(result);
    detached.answers = detached.answers.map((answer) => [...answer]);
    detached.receipt = detachedReceipt;
    return deepFreeze(detached);
  }

  function recoverTerminalReceipt(input: RecoverTerminalReceiptInput): RecoverTerminalReceiptResult {
    if (!authority) return { ok: false, reason: 'storage_error' };
    const now = input.now ?? Date.now();
    try {
      return withCapacityLock((pinned) => withAskLock(pinned, input.askKey, (parent) => {
        const state = readStateLocked(parent, input.askKey, now);
        if (!state || state.state !== 'terminal' || !answered(state.terminalResult)
            || !state.terminalResult.receipt) return { ok: false, reason: 'missing' };
        if (state.requestId !== input.requestId || state.originKind !== input.originKind
            || state.larkAppId !== input.larkAppId || state.sessionId !== input.sessionId
            || state.chatId !== input.chatId || state.rootMessageId !== input.rootMessageId
            || askQuestionDigest(state.questions) !== input.questionDigest
            || state.notBeforeMs !== input.notBeforeMs
            || state.expiresAtMs !== input.expiresAtMs) {
          return { ok: false, reason: 'mismatch' };
        }
        if (now >= state.recoverUntil!) return { ok: false, reason: 'expired' };

        let receipt = state.terminalResult.receipt;
        let result = state.terminalResult;
        if (state.originKind === 's1-controller') {
          const outbox = readOutbox(pinned, state.askKey, now);
          if (!outbox || outbox.record.revision !== state.revision
              || outbox.record.receiptJti !== state.receiptJti
              || outbox.sha256 !== state.outboxSha256
              || !canonicalEqual(outbox.record.answeredResult, result)
              || !canonicalEqual(outbox.record.receipt, receipt)) {
            return { ok: false, reason: 'missing' };
          }
          receipt = outbox.record.receipt;
          result = outbox.record.answeredResult;
        }
        validateReceiptBinding(state, result, receipt, state.answeredAt!);
        const detached = recoveredResult(result, receipt);
        return {
          ok: true,
          receipt: detached.receipt!,
          answeredResult: detached,
          receiptSha256: hash(canonicalJson(detached.receipt)),
          receiptJti: detached.receipt!.payload.jti,
          answeredAt: detached.receipt!.payload.answeredAt,
          recoverUntil: state.recoverUntil!,
          revision: state.revision,
        };
      }));
    } catch {
      return { ok: false, reason: 'storage_error' };
    }
  }

  function signedList(now: number): PersistedAsk[] {
    try { withCapacityLock((pinned) => sweepLocked(pinned, now)); }
    catch (error) {
      logger.warn?.(`ask-persist: signed sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const asks: PersistedAsk[] = [];
    withCapacityLock((pinned) => {
      for (const name of stateFileNames(pinned.root)) {
        try {
          const state = stateForFilename(pinned, name, now);
          if (!state) continue;
          if (state.state === 'pending'
              || (state.state === 'terminal' && state.originKind !== 's1-controller'
                && answered(state.terminalResult) && now < state.recoverUntil!)) {
            asks.push(state as PersistedAsk);
          }
        } catch (error) {
          logger.warn?.(`ask-persist: rejected signed record ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    return asks;
  }

  function unsignedList(now: number): PersistedAsk[] {
    if (!existsSync(dir)) return [];
    let names: string[];
    try { names = stateFileNames(); }
    catch (error) {
      logger.warn?.(`ask-persist: cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const asks: PersistedAsk[] = [];
    for (const name of names) {
      const path = join(dir, name);
      let ask: PersistedAsk;
      try { ask = JSON.parse(readFileSync(path, 'utf8')) as PersistedAsk; }
      catch {
        try { unlinkSync(path); } catch { /* best effort */ }
        continue;
      }
      if (!ask || ask.v !== 2 || !ask.askKey || !ask.requestId || !Array.isArray(ask.questions)) continue;
      if (ask.answeredResult !== undefined) {
        const stashedAt = typeof ask.answeredAt === 'number' ? ask.answeredAt : ask.createdAt;
        if (now - stashedAt > HANDOFF_RETENTION_MS) {
          try { unlinkSync(path); } catch { /* best effort */ }
          continue;
        }
      } else if (typeof ask.deadlineAt === 'number' && ask.deadlineAt <= now) {
        try { unlinkSync(path); } catch { /* best effort */ }
        continue;
      }
      asks.push(ask);
    }
    return asks;
  }

  return {
    dir,
    put(ask): void {
      if (ask.v === 3) throw new Error('ask-persist: signed writes require commitSigned');
      try {
        ensureDir();
        const normalized = jsonClone({ ...ask, v: 2 as const });
        delete (normalized as { receiptEligible?: boolean }).receiptEligible;
        atomicWriteFileSync(statePath(ask.askKey), JSON.stringify(normalized), { mode: 0o600, durable: true });
      } catch (error) {
        logger.warn?.(`ask-persist: failed to persist ${ask.askKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    remove(askKey): void {
      if (authority) {
        try { withCapacityLock((pinned) => sweepLocked(pinned, Date.now())); }
        catch (error) {
          logger.warn?.(`ask-persist: failed to reap ${askKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      try { unlinkSync(statePath(askKey)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn?.(`ask-persist: failed to remove ${askKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    list(now = Date.now()): PersistedAsk[] {
      return authority ? signedList(now) : unsignedList(now);
    },
    commitSigned,
    commitTerminalSigned,
    terminalizeSigned,
    recoverTerminalReceipt,
    sweep(now = Date.now()): AskPersistSweepResult {
      if (!authority) return { removedStates: 0, removedOutboxes: 0 };
      return withCapacityLock((pinned) => sweepLocked(pinned, now));
    },
  };
}
