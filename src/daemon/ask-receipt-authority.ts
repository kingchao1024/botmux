import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

import {
  ASK_RECEIPT_ALGORITHM,
  ASK_RECEIPT_SCHEMA,
  ASK_RECEIPT_TTL_MS,
  askAnswerDigest,
  askQuestionDigest,
  askReceiptJti,
  askReceiptKeyId,
  canonicalAskReceiptBytes,
  canonicalJson,
  exportAskReceiptPublicKey,
  hasExactAskCallbackValueKeys,
  hasOnlyLarkCardActionKeys,
  importAskReceiptPublicKey,
  normalizeAskSubmitValue,
  snapshotAskCallbackData,
  type AskAnswerProvenanceIssue,
  type AskAnswerProvenanceIssuer,
  type AskAnswerProvenanceRedeemer,
  type AskAnswerProvenanceToken,
  type AskPersistenceIntegrityAuthority,
  type AskPersistenceIntegrityV1,
  type AskProvenanceExpectation,
  type AskReceiptEventClaimResult,
  type AskReceiptPersistInput,
  type AskReceiptPayloadV1,
  type SignedAskReceiptV1,
} from '../core/ask-receipt.js';
import { withSecureHostParentSync } from '../platform/secure-host-file.js';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const ED25519_PKCS8_DER_BYTES = 48;
const ED25519_SIGNATURE_BYTES = 64;
const PERSISTENCE_SIGNING_DOMAIN = 'botmux.ask-persist.v3\0';
const MAX_STORED_KEY_BYTES = 4096;
const MAX_FUTURE_SKEW_MS = 60_000;

export interface AskReceiptSigningAuthority extends AskPersistenceIntegrityAuthority {
  readonly algorithm: typeof ASK_RECEIPT_ALGORITHM;
  readonly keyId: string;
  readonly publicKey: string;
  readonly signerInstanceId: string;
  sign(payload: Omit<AskReceiptPayloadV1, 'schema' | 'keyId' | 'signerInstanceId'>): SignedAskReceiptV1;
}

interface StoredAskReceiptKeyV1 {
  schema: 'botmux.ask-receipt-key.v1';
  algorithm: typeof ASK_RECEIPT_ALGORITHM;
  keyId: string;
  publicKey: string;
  privateKey: string;
  signerInstanceId: string;
  createdAt: number;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
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

function exportAskReceiptPrivateKey(key: KeyObject): string {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Ask receipt private key must be Ed25519');
  }
  return key.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
}

function importAskReceiptPrivateKey(encoded: string): KeyObject {
  const key = createPrivateKey({
    key: decodeCanonicalBase64url(encoded, ED25519_PKCS8_DER_BYTES, 'Ask receipt private key'),
    format: 'der',
    type: 'pkcs8',
  });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ask receipt private key must be Ed25519');
  return key;
}

export function createAskReceiptSigner(input: {
  privateKey: KeyObject;
  publicKey: KeyObject;
  signerInstanceId: string;
}): AskReceiptSigningAuthority {
  const publicKey = exportAskReceiptPublicKey(input.publicKey);
  const derivedPublicKey = exportAskReceiptPublicKey(createPublicKey(input.privateKey));
  if (derivedPublicKey !== publicKey) throw new Error('Ask receipt private/public key mismatch');
  if (!input.signerInstanceId) throw new Error('Ask receipt signer instance id is required');
  const keyId = askReceiptKeyId(publicKey);
  return {
    algorithm: ASK_RECEIPT_ALGORITHM,
    keyId,
    publicKey,
    signerInstanceId: input.signerInstanceId,
    sign(unsigned) {
      if (!safeTimestamp(unsigned.answeredAt) || !safeTimestamp(unsigned.expiresAt)
          || unsigned.expiresAt <= unsigned.answeredAt
          || unsigned.expiresAt - unsigned.answeredAt > ASK_RECEIPT_TTL_MS) {
        throw new Error('Ask receipt lifetime must be between 1 and 300 seconds');
      }
      const payload: AskReceiptPayloadV1 = {
        ...unsigned,
        schema: ASK_RECEIPT_SCHEMA,
        keyId,
        signerInstanceId: input.signerInstanceId,
      };
      return {
        payload,
        algorithm: ASK_RECEIPT_ALGORITHM,
        publicKey,
        signature: cryptoSign(null, canonicalAskReceiptBytes(payload), input.privateKey).toString('base64url'),
      };
    },
    sealPersistedState(value) {
      return {
        schema: 'botmux.ask-persist-signature.v1',
        algorithm: ASK_RECEIPT_ALGORITHM,
        keyId,
        signature: cryptoSign(
          null,
          Buffer.from(`${PERSISTENCE_SIGNING_DOMAIN}${canonicalJson(value)}`, 'utf8'),
          input.privateKey,
        ).toString('base64url'),
      };
    },
    verifyPersistedState(value, integrity) {
      if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) return false;
      const record = integrity as Record<string, unknown>;
      if (Object.keys(record).sort().join('\0') !== ['algorithm', 'keyId', 'schema', 'signature'].sort().join('\0')
          || record.schema !== 'botmux.ask-persist-signature.v1'
          || record.algorithm !== ASK_RECEIPT_ALGORITHM
          || record.keyId !== keyId
          || typeof record.signature !== 'string') return false;
      try {
        return cryptoVerify(
          null,
          Buffer.from(`${PERSISTENCE_SIGNING_DOMAIN}${canonicalJson(value)}`, 'utf8'),
          input.publicKey,
          decodeCanonicalBase64url(record.signature, ED25519_SIGNATURE_BYTES, 'Ask persistence signature'),
        );
      } catch {
        return false;
      }
    },
  };
}

function parseStoredKey(raw: string, now = Date.now()): StoredAskReceiptKeyV1 {
  if (Buffer.byteLength(raw, 'utf8') > MAX_STORED_KEY_BYTES) {
    throw new Error('Ask receipt signing key file is too large');
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Ask receipt signing key is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ask receipt signing key has an invalid shape');
  }
  const record = value as Record<string, unknown>;
  const expected = ['algorithm', 'createdAt', 'keyId', 'privateKey', 'publicKey', 'schema', 'signerInstanceId'];
  if (Object.keys(record).sort().join('\0') !== expected.sort().join('\0')
      || record.schema !== 'botmux.ask-receipt-key.v1'
      || record.algorithm !== ASK_RECEIPT_ALGORITHM
      || typeof record.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(record.keyId)
      || typeof record.publicKey !== 'string'
      || typeof record.privateKey !== 'string'
      || !nonEmptyString(record.signerInstanceId)
      || !safeTimestamp(record.createdAt)
      || record.createdAt > now + MAX_FUTURE_SKEW_MS) {
    throw new Error('Ask receipt signing key has an invalid shape');
  }
  const privateKey = importAskReceiptPrivateKey(record.privateKey);
  const publicKey = importAskReceiptPublicKey(record.publicKey);
  if (exportAskReceiptPublicKey(createPublicKey(privateKey)) !== exportAskReceiptPublicKey(publicKey)
      || askReceiptKeyId(record.publicKey) !== record.keyId) {
    throw new Error('Ask receipt signing key identity mismatch');
  }
  return record as unknown as StoredAskReceiptKeyV1;
}

function signerFromStored(record: StoredAskReceiptKeyV1): AskReceiptSigningAuthority {
  return createAskReceiptSigner({
    privateKey: importAskReceiptPrivateKey(record.privateKey),
    publicKey: importAskReceiptPublicKey(record.publicKey),
    signerInstanceId: record.signerInstanceId,
  });
}

export function loadOrCreateAskReceiptSigner(filePath: string): AskReceiptSigningAuthority {
  return withSecureHostParentSync(filePath, (file) => file.withLeafLock(() => {
    const existing = file.readLeaf(MAX_STORED_KEY_BYTES);
    if (existing !== null) return signerFromStored(parseStoredKey(existing));

    const pair = generateKeyPairSync('ed25519');
    const publicKey = exportAskReceiptPublicKey(pair.publicKey);
    const stored: StoredAskReceiptKeyV1 = {
      schema: 'botmux.ask-receipt-key.v1',
      algorithm: ASK_RECEIPT_ALGORITHM,
      keyId: askReceiptKeyId(publicKey),
      publicKey,
      privateKey: exportAskReceiptPrivateKey(pair.privateKey),
      signerInstanceId: randomUUID(),
      createdAt: Date.now(),
    };
    const encoded = `${JSON.stringify(stored, null, 2)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_STORED_KEY_BYTES) {
      throw new Error('Ask receipt signing key file is too large');
    }
    file.writeLeaf(encoded);
    return signerFromStored(stored);
  }), { exactParentMode: 0o700 });
}

export function createAskAnswerProvenanceAuthority(input: {
  signer: AskReceiptSigningAuthority;
  daemonBootId: string;
  claimEvent: (larkAppId: string, eventId: string, bindingDigest: string) => Promise<AskReceiptEventClaimResult>;
  completeEvent: (larkAppId: string, eventId: string, bindingDigest: string) => Promise<AskReceiptEventClaimResult>;
}): AskAnswerProvenanceIssuer & { redeemer: AskAnswerProvenanceRedeemer } {
  type Captured = {
    larkAppId: string; actorIdentity: string; platformEventId: string; cardMessageId: string;
    action: AskProvenanceExpectation['action']; askId: string; askNonce: string; optionKey?: string;
    questionIndex?: number; hasFormValue: boolean;
    submitBinding?: import('../core/ask-receipt.js').NormalizedAskSubmitValue;
  };
  type RecordState = { callback: Captured; consumed: boolean; redeemed: boolean };
  const records = new WeakMap<object, RecordState>();
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  const integer = (value: unknown): number | undefined => {
    let parsed: number;
    if (typeof value === 'number') {
      parsed = value;
    } else if (typeof value === 'string' && /^\d+$/.test(value)) {
      parsed = Number(value);
    } else {
      return undefined;
    }
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const validSubmitConfirmEmpty = (value: unknown): boolean =>
    value === undefined || value === true || value === 'true';
  const validateAskCallbackShape = (
    action: Captured['action'],
    actionRecord: Record<string, unknown>,
    valueRecord: Record<string, unknown>,
    formValueOwn: boolean,
    formValueRecord: Record<string, unknown> | undefined,
  ): boolean => {
    if (action === 'ask_select') {
      return hasOnlyLarkCardActionKeys(actionRecord, false)
        && hasExactAskCallbackValueKeys(valueRecord, ['action', 'ask_id', 'nonce', 'key'])
        && nonEmptyString(valueRecord.key);
    }
    if (action === 'ask_toggle') {
      return hasOnlyLarkCardActionKeys(actionRecord, false)
        && hasExactAskCallbackValueKeys(valueRecord, ['action', 'ask_id', 'nonce', 'key', 'question_index'])
        && nonEmptyString(valueRecord.key)
        && integer(valueRecord.question_index) !== undefined;
    }
    const expectedValueKeys = Object.prototype.hasOwnProperty.call(valueRecord, 'confirm_empty')
      ? ['action', 'ask_id', 'nonce', 'confirm_empty']
      : ['action', 'ask_id', 'nonce'];
    return hasOnlyLarkCardActionKeys(actionRecord, formValueOwn)
      && hasExactAskCallbackValueKeys(valueRecord, expectedValueKeys)
      && validSubmitConfirmEmpty(valueRecord.confirm_empty)
      && (!formValueOwn || formValueRecord !== undefined);
  };
  const consumeState = (token: unknown): RecordState | undefined => {
    if (!token || typeof token !== 'object') return undefined;
    const state = records.get(token);
    if (!state || state.consumed) return undefined;
    // The capability is one-shot at the authority boundary. Broker-side shape
    // checks run before redemption, but once a token reaches this facet even a
    // binding mismatch burns it so it cannot be probed and retried.
    state.consumed = true;
    return state;
  };
  const submitBindingMatches = (
    captured: Captured['submitBinding'],
    expected: AskProvenanceExpectation['submitBinding'],
  ): boolean => {
    if (!captured || !expected) return false;
    try {
      return canonicalJson(captured) === canonicalJson(expected);
    } catch {
      return false;
    }
  };
  const matches = (record: Captured, expected: AskProvenanceExpectation): boolean =>
    record.larkAppId === expected.larkAppId
    && record.actorIdentity === expected.actorIdentity
    && record.cardMessageId === expected.cardMessageId
    && record.action === expected.action
    && record.askId === expected.askId
    && record.askNonce === expected.askNonce
    && record.optionKey === expected.optionKey
    && record.questionIndex === expected.questionIndex
    && record.hasFormValue === expected.hasFormValue
    && (record.action !== 'ask_submit'
      || submitBindingMatches(record.submitBinding, expected.submitBinding));
  return {
    async issue(larkAppId, data) {
      let event: Record<string, unknown>;
      try {
        const snapshot = snapshotAskCallbackData(data);
        if (!isPlainRecord(snapshot)) return { kind: 'not_ask' };
        event = snapshot;
      } catch {
        return { kind: 'rejected', reason: 'invalid_event_id' };
      }
      const actionRecord = isPlainRecord(event.action) ? event.action : undefined;
      const valueRecord = isPlainRecord(actionRecord?.value) ? actionRecord.value : undefined;
      const action = text(valueRecord?.action);
      if (action !== 'ask_select' && action !== 'ask_toggle' && action !== 'ask_submit') return { kind: 'not_ask' };
      const header = isPlainRecord(event.header) ? event.header : undefined;
      const eventInner = isPlainRecord(event.event) ? event.event : undefined;
      const context = isPlainRecord(event.context) ? event.context : undefined;
      const operator = isPlainRecord(event.operator) ? event.operator : undefined;
      const platformEventId = text(event.event_id ?? event.uuid ?? header?.event_id ?? eventInner?.event_id);
      const cardMessageId = text(context?.open_message_id ?? event.open_message_id);
      const actorIdentity = text(operator?.open_id);
      const askId = text(valueRecord?.ask_id);
      const askNonce = text(valueRecord?.nonce);
      const formValueOwn = !!actionRecord && Object.prototype.hasOwnProperty.call(actionRecord, 'form_value');
      const formValueRecord = formValueOwn && isPlainRecord(actionRecord.form_value)
        ? actionRecord.form_value
        : undefined;
      if (!larkAppId || !platformEventId || !cardMessageId || !actorIdentity || !askId || !askNonce) {
        return { kind: 'rejected', reason: 'invalid_event_id' };
      }
      if (!actionRecord || !valueRecord
          || !validateAskCallbackShape(action, actionRecord, valueRecord, formValueOwn, formValueRecord)) {
        return { kind: 'rejected', reason: 'invalid_event_id' };
      }
      const optionKey = text(valueRecord.key);
      const questionIndex = integer(valueRecord.question_index);
      const callback: Captured = Object.freeze({
        larkAppId, actorIdentity, platformEventId, cardMessageId, action, askId, askNonce,
        hasFormValue: !!formValueRecord && Object.keys(formValueRecord).length > 0,
        ...(optionKey ? { optionKey } : {}),
        ...(questionIndex !== undefined ? { questionIndex } : {}),
        ...(action === 'ask_submit' ? {
          submitBinding: normalizeAskSubmitValue(formValueRecord, valueRecord.confirm_empty),
        } : {}),
      });
      const bindingDigest = createHash('sha256')
        .update(`botmux.ask-card-event.v1\0${canonicalJson(callback)}`)
        .digest('hex');
      const claim = await input.claimEvent(larkAppId, platformEventId, bindingDigest);
      if (!claim.ok) return { kind: 'rejected', reason: claim.reason };
      const token = Object.freeze({}) as AskAnswerProvenanceToken;
      records.set(token, { callback, consumed: false, redeemed: false });
      return { kind: 'issued', token };
    },
    wasRedeemed(token) {
      if (!token || typeof token !== 'object') return false;
      return records.get(token)?.redeemed === true;
    },
    async complete(token) {
      if (!token || typeof token !== 'object') return { ok: false, reason: 'invalid_event_id' };
      const state = records.get(token);
      if (!state || !state.redeemed) return { ok: false, reason: 'invalid_event_id' };
      records.delete(token);
      const bindingDigest = createHash('sha256')
        .update(`botmux.ask-card-event.v1\0${canonicalJson(state.callback)}`)
        .digest('hex');
      return input.completeEvent(
        state.callback.larkAppId,
        state.callback.platformEventId,
        bindingDigest,
      );
    },
    revoke(token) { if (token && typeof token === 'object') records.delete(token); },
    redeemer: {
      consumeMutation(token, expected) {
        const state = consumeState(token);
        if (!state || !matches(state.callback, expected)) return false;
        state.redeemed = true;
        return true;
      },
      mintReceipt(token, mint) {
        const state = consumeState(token);
        if (!state || !matches(state.callback, mint) || mint.answeredAt >= mint.deadlineAt) return undefined;
        const answers = mint.answers.map((keys) => [...keys]);
        const receipt = input.signer.sign({
          askId: mint.askId,
          larkAppId: mint.larkAppId,
          sessionId: mint.sessionId,
          chatId: mint.chatId,
          rootMessageId: mint.rootMessageId,
          questionDigest: askQuestionDigest(mint.questions),
          answerDigest: askAnswerDigest(answers, mint.comment),
          answers,
          selected: answers.length === 1 && answers[0]?.length === 1 ? answers[0][0]! : null,
          actor: { kind: 'lark_user', identity: state.callback.actorIdentity },
          source: 'lark_card',
          platformEventId: state.callback.platformEventId,
          cardMessageId: state.callback.cardMessageId,
          askNonce: mint.askNonce,
          answeredAt: mint.answeredAt,
          expiresAt: Math.min(mint.deadlineAt, mint.answeredAt + ASK_RECEIPT_TTL_MS),
          daemonBootId: input.daemonBootId,
          jti: askReceiptJti({
            larkAppId: mint.larkAppId,
            sessionId: mint.sessionId,
            askId: mint.askId,
            platformEventId: state.callback.platformEventId,
            cardMessageId: state.callback.cardMessageId,
          }),
        });
        return receipt;
      },
      markReceiptCommitted(token) {
        if (!token || typeof token !== 'object') return false;
        const state = records.get(token);
        if (!state || !state.consumed || state.redeemed) return false;
        state.redeemed = true;
        return true;
      },
      revoke(token) { if (token && typeof token === 'object') records.delete(token); },
    },
  };
}
