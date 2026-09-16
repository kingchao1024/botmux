import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  askAnswerDigest,
  askQuestionDigest,
  askReceiptJti,
  snapshotAskCallbackData,
  verifyAskReceipt,
} from '../src/core/ask-receipt.js';
import { createAskAnswerProvenanceAuthority, createAskReceiptSigner } from '../src/daemon/ask-receipt-authority.js';

function fixture() {
  const pair = generateKeyPairSync('ed25519');
  const signer = createAskReceiptSigner({
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    signerInstanceId: 'signer-test-1',
  });
  const questions = [{
    prompt: 'Approve exact S1 binding?',
    options: [{ key: 'approve', label: 'Approve' }, { key: 'reject', label: 'Reject' }],
    multiSelect: false,
  }];
  const answers = [['approve']];
  const payload = {
    askId: 'ask-1', larkAppId: 'cli-app', sessionId: 'session-1', chatId: 'oc-chat',
    rootMessageId: 'om-root', questionDigest: askQuestionDigest(questions),
    answerDigest: askAnswerDigest(answers, null), answers, selected: 'approve',
    actor: { kind: 'lark_user' as const, identity: 'ou-reviewer' },
    source: 'lark_card' as const, platformEventId: 'evt-1', cardMessageId: 'om-card',
    askNonce: 'nonce-1', answeredAt: 1_800_000_000_000, expiresAt: 1_800_000_060_000,
    daemonBootId: 'boot-1',
    jti: askReceiptJti({
      larkAppId: 'cli-app', sessionId: 'session-1', askId: 'ask-1',
      platformEventId: 'evt-1', cardMessageId: 'om-card',
    }),
  };
  return { signer, receipt: signer.sign(payload) };
}

function callbackSnapshot<T>(value: T): T {
  return snapshotAskCallbackData(value) as T;
}

describe('signed Ask receipt', () => {
  it('uses an opaque one-shot callback capability and rejects clone, replay, and mismatch', async () => {
    const { signer } = fixture();
    const claimed = new Set<string>();
    const authority = createAskAnswerProvenanceAuthority({
      signer, daemonBootId: 'boot-capability',
      claimEvent: async (app, event) => claimed.has(`${app}:${event}`)
        ? { ok: false, reason: 'duplicate' as const }
        : (claimed.add(`${app}:${event}`), { ok: true, recovered: false as const }),
      completeEvent: async () => ({ ok: true, recovered: false }),
    });
    const callback = {
      event_id: 'evt-capability',
      operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: { action: 'ask_select', ask_id: 'ask-1', nonce: 'nonce-1', key: 'approve' } },
    };
    const expected = {
      larkAppId: 'cli-app', actorIdentity: 'ou-reviewer', cardMessageId: 'om-card',
      action: 'ask_select' as const, askId: 'ask-1', askNonce: 'nonce-1',
      optionKey: 'approve', hasFormValue: false,
    };
    const issued = await authority.issue('cli-app', callbackSnapshot(callback));
    if (issued.kind !== 'issued') throw new Error('expected issued callback capability');
    expect(authority.redeemer.consumeMutation({ ...issued.token }, expected)).toBe(false);
    expect(authority.wasRedeemed(issued.token)).toBe(false);
    const mismatched = await authority.issue('cli-app', callbackSnapshot({ ...callback, event_id: 'evt-mismatch' }));
    if (mismatched.kind !== 'issued') throw new Error('expected mismatched capability');
    expect(authority.redeemer.consumeMutation(mismatched.token, { ...expected, askId: 'wrong' })).toBe(false);
    expect(authority.wasRedeemed(mismatched.token)).toBe(false);
    expect(authority.redeemer.consumeMutation(mismatched.token, expected)).toBe(false);
    expect(authority.wasRedeemed(mismatched.token)).toBe(false);

    const fresh = await authority.issue('cli-app', callbackSnapshot({ ...callback, event_id: 'evt-fresh' }));
    if (fresh.kind !== 'issued') throw new Error('expected fresh capability');
    expect(authority.wasRedeemed(fresh.token)).toBe(false);
    expect(authority.redeemer.consumeMutation(fresh.token, expected)).toBe(true);
    expect(authority.wasRedeemed(fresh.token)).toBe(true);
    expect(authority.redeemer.consumeMutation(fresh.token, expected)).toBe(false);
    expect(await authority.issue('cli-app', callbackSnapshot(callback))).toEqual({ kind: 'rejected', reason: 'duplicate' });
  });

  it('lets exactly one concurrent redemption attempt burn a capability', async () => {
    const { signer } = fixture();
    const authority = createAskAnswerProvenanceAuthority({
      signer, daemonBootId: 'boot-race',
      claimEvent: async () => ({ ok: true, recovered: false }),
      completeEvent: async () => ({ ok: true, recovered: false }),
    });
    const issued = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-race', operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: { action: 'ask_select', ask_id: 'ask-1', nonce: 'nonce-1', key: 'approve' } },
    }));
    if (issued.kind !== 'issued') throw new Error('expected issued callback capability');
    const expected = {
      larkAppId: 'cli-app', actorIdentity: 'ou-reviewer', cardMessageId: 'om-card',
      action: 'ask_select' as const, askId: 'ask-1', askNonce: 'nonce-1',
      optionKey: 'approve', hasFormValue: false,
    };
    const attempts = await Promise.all([
      Promise.resolve().then(() => authority.redeemer.consumeMutation(issued.token, expected)),
      Promise.resolve().then(() => authority.redeemer.consumeMutation(issued.token, expected)),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
  });

  it('refuses to complete an issued callback until a matching mutation redeemed it', async () => {
    const { signer } = fixture();
    const completeEvent = vi.fn(async () => ({ ok: true, recovered: false } as const));
    const authority = createAskAnswerProvenanceAuthority({
      signer, daemonBootId: 'boot-complete',
      claimEvent: async () => ({ ok: true, recovered: false }),
      completeEvent,
    });
    const issued = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-unredeemed', operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: { action: 'ask_select', ask_id: 'ask-1', nonce: 'nonce-1', key: 'approve' } },
    }));
    if (issued.kind !== 'issued') throw new Error('expected issued callback capability');
    expect(await authority.complete(issued.token)).toEqual({ ok: false, reason: 'invalid_event_id' });
    expect(completeEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed ask callback shapes before durable claim', async () => {
    const { signer } = fixture();
    const claimEvent = vi.fn(async () => ({ ok: true, recovered: false } as const));
    const authority = createAskAnswerProvenanceAuthority({
      signer, daemonBootId: 'boot-shape',
      claimEvent,
      completeEvent: async () => ({ ok: true, recovered: false }),
    });

    const select = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-select-bad-shape',
      operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: {
        action: 'ask_select', ask_id: 'ask-1', nonce: 'nonce-1', key: 'approve', question_index: '0',
      } },
    }));
    expect(select).toEqual({ kind: 'rejected', reason: 'invalid_event_id' });

    const toggle = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-toggle-bad-shape',
      operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: {
        action: 'ask_toggle', ask_id: 'ask-1', nonce: 'nonce-1', key: 'approve',
      } },
    }));
    expect(toggle).toEqual({ kind: 'rejected', reason: 'invalid_event_id' });

    const submit = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-submit-bad-shape',
      operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: {
        action: 'ask_submit', ask_id: 'ask-1', nonce: 'nonce-1', key: 'approve',
      } },
    }));
    expect(submit).toEqual({ kind: 'rejected', reason: 'invalid_event_id' });

    expect(claimEvent).not.toHaveBeenCalled();
  });

  it('accepts only the supported closed callback shapes', async () => {
    const { signer } = fixture();
    const claimEvent = vi.fn(async () => ({ ok: true, recovered: false } as const));
    const authority = createAskAnswerProvenanceAuthority({
      signer, daemonBootId: 'boot-good-shape',
      claimEvent,
      completeEvent: async () => ({ ok: true, recovered: false }),
    });

    const select = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-select-good-shape',
      operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: {
        action: 'ask_select', ask_id: 'ask-1', nonce: 'nonce-1', key: 'approve',
      } },
    }));
    expect(select.kind).toBe('issued');

    const toggle = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-toggle-good-shape',
      operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: {
        action: 'ask_toggle', ask_id: 'ask-1', nonce: 'nonce-1', key: 'approve', question_index: '0',
      } },
    }));
    expect(toggle.kind).toBe('issued');

    const submitCumulative = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-submit-cumulative-good-shape',
      operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: {
        action: 'ask_submit', ask_id: 'ask-1', nonce: 'nonce-1',
      } },
    }));
    expect(submitCumulative.kind).toBe('issued');

    const submitConfirmEmpty = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-submit-confirm-empty-good-shape',
      operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: { value: {
        action: 'ask_submit', ask_id: 'ask-1', nonce: 'nonce-1', confirm_empty: 'true',
      } },
    }));
    expect(submitConfirmEmpty.kind).toBe('issued');

    const submitForm = await authority.issue('cli-app', callbackSnapshot({
      event_id: 'evt-submit-form-good-shape',
      operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: {
        value: { action: 'ask_submit', ask_id: 'ask-1', nonce: 'nonce-1' },
        form_value: { q0: '0::approve' },
      },
    }));
    expect(submitForm.kind).toBe('issued');

    expect(claimEvent).toHaveBeenCalledTimes(5);
  });

  it('binds one submit event to normalized form answers and confirm-empty intent', async () => {
    const { signer } = fixture();
    const claims = new Map<string, string>();
    const claimEvent = vi.fn(async (appId: string, eventId: string, bindingDigest: string) => {
      const key = `${appId}:${eventId}`;
      const existing = claims.get(key);
      if (existing !== undefined) {
        return existing === bindingDigest
          ? { ok: false, reason: 'duplicate' as const }
          : { ok: false, reason: 'binding_mismatch' as const };
      }
      claims.set(key, bindingDigest);
      return { ok: true, recovered: false as const };
    });
    const authority = createAskAnswerProvenanceAuthority({
      signer, daemonBootId: 'boot-submit-binding', claimEvent,
      completeEvent: async () => ({ ok: true, recovered: false }),
    });
    const submit = (formValue: Record<string, unknown>, confirmEmpty?: true | 'true') => ({
      event_id: 'evt-submit-binding', operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: {
        value: {
          action: 'ask_submit', ask_id: 'ask-1', nonce: 'nonce-1',
          ...(confirmEmpty === undefined ? {} : { confirm_empty: confirmEmpty }),
        },
        form_value: formValue,
      },
    });

    expect((await authority.issue('cli-app', snapshotAskCallbackData(
      submit({ q0: '0::approve, 0::reject', ignored: 42 }),
    ))).kind).toBe('issued');
    expect(await authority.issue('cli-app', snapshotAskCallbackData(
      submit({ ignored: 'different representation', q0: ['0::approve', '0::reject'] }),
    ))).toEqual({ kind: 'rejected', reason: 'duplicate' });
    expect(await authority.issue('cli-app', snapshotAskCallbackData(
      submit({ q0: ['0::reject'] }),
    ))).toEqual({ kind: 'rejected', reason: 'binding_mismatch' });
    expect(await authority.issue('cli-app', snapshotAskCallbackData(
      submit({ q0: '0::approve,0::reject' }, 'true'),
    ))).toEqual({ kind: 'rejected', reason: 'binding_mismatch' });
    expect(claimEvent).toHaveBeenCalledTimes(4);
  });

  it('creates an unforgeable deeply frozen callback snapshot', async () => {
    const formOptions = ['0::approve'];
    const original = {
      event_id: 'evt-frozen', operator: { open_id: 'ou-reviewer' },
      context: { open_message_id: 'om-card' },
      action: {
        value: { action: 'ask_submit', ask_id: 'ask-1', nonce: 'nonce-1', confirm_empty: 'true' },
        form_value: { q0: formOptions },
      },
    };
    const snapshot = snapshotAskCallbackData(original) as typeof original;

    expect(snapshot).not.toBe(original);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.action)).toBe(true);
    expect(Object.isFrozen(snapshot.action.value)).toBe(true);
    expect(Object.isFrozen(snapshot.action.form_value)).toBe(true);
    expect(Object.isFrozen(snapshot.action.form_value.q0)).toBe(true);
    expect(snapshotAskCallbackData(snapshot)).toBe(snapshot);
    expect(snapshotAskCallbackData(structuredClone(snapshot))).not.toBe(snapshot);
  });

  it('keeps getter-backed callback data fail-closed', async () => {
    const { signer } = fixture();
    const claimEvent = vi.fn(async () => ({ ok: true, recovered: false } as const));
    const authority = createAskAnswerProvenanceAuthority({
      signer, daemonBootId: 'boot-getter-shape',
      claimEvent,
      completeEvent: async () => ({ ok: true, recovered: false }),
    });

    const value = {
      action: 'ask_select',
      ask_id: 'ask-1',
      nonce: 'nonce-1',
      key: 'approve',
    } as Record<string, unknown>;
    Object.defineProperty(value, 'key', {
      enumerable: true,
      get() { throw new Error('getter must not run'); },
    });

    let snapshotError: unknown;
    try {
      callbackSnapshot({
        event_id: 'evt-getter-shape', operator: { open_id: 'ou-reviewer' },
        context: { open_message_id: 'om-card' }, action: { value },
      });
    } catch (error) {
      snapshotError = error;
    }

    expect(snapshotError).toBeInstanceOf(Error);
    expect(claimEvent).not.toHaveBeenCalled();
  });

  it('round-trips with a pinned key and exact binding', () => {
    const { signer, receipt } = fixture();
    expect(verifyAskReceipt(receipt, {
      publicKey: signer.publicKey,
      keyId: signer.keyId,
      now: receipt.payload.answeredAt,
      expected: { askId: 'ask-1', selected: 'approve', jti: receipt.payload.jti },
    })).toMatchObject({ ok: true, expired: false });
  });

  it('returns a detached deeply frozen verified payload', () => {
    const { signer, receipt } = fixture();
    const verified = verifyAskReceipt(receipt, {
      publicKey: signer.publicKey, now: receipt.payload.answeredAt,
    });
    if (!verified.ok) throw new Error('expected verified receipt');
    const originalChatId = verified.payload.chatId;
    const originalAnswer = verified.payload.answers[0]![0];
    const originalActor = verified.payload.actor.identity;

    receipt.payload.chatId = 'oc-mutated';
    receipt.payload.answers[0]![0] = 'reject';
    receipt.payload.actor.identity = 'ou-mutated';

    expect(verified.payload.chatId).toBe(originalChatId);
    expect(verified.payload.answers[0]![0]).toBe(originalAnswer);
    expect(verified.payload.actor.identity).toBe(originalActor);
    expect(Object.isFrozen(verified.payload)).toBe(true);
    expect(Object.isFrozen(verified.payload.answers)).toBe(true);
    expect(Object.isFrozen(verified.payload.answers[0])).toBe(true);
    expect(Object.isFrozen(verified.payload.actor)).toBe(true);
  });

  it('rejects non-canonical base64url aliases and invalid verification times', () => {
    const { signer, receipt } = fixture();
    const signature = receipt.signature;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const tail = alphabet.indexOf(signature.at(-1)!);
    const aliasedTail = alphabet[(tail ^ 1) & 63]!;
    const aliased = { ...receipt, signature: `${signature.slice(0, -1)}${aliasedTail}` };
    expect(Buffer.from(aliased.signature, 'base64url')).toEqual(Buffer.from(signature, 'base64url'));
    expect(verifyAskReceipt(aliased, { publicKey: signer.publicKey, now: receipt.payload.answeredAt }))
      .toEqual({ ok: false, error: 'malformed' });
    expect(verifyAskReceipt(receipt, { publicKey: signer.publicKey, now: receipt.payload.answeredAt - 1 }))
      .toEqual({ ok: false, error: 'malformed' });
    expect(verifyAskReceipt(receipt, { publicKey: signer.publicKey, now: 1.5 }))
      .toEqual({ ok: false, error: 'malformed' });
  });

  it('never trusts the public key embedded in the receipt by default', () => {
    const { receipt } = fixture();
    expect(verifyAskReceipt(receipt, { now: receipt.payload.answeredAt }))
      .toEqual({ ok: false, error: 'untrusted_key' });
  });

  it('rejects every signed binding mutation and a wrong trust anchor', () => {
    const { receipt } = fixture();
    const changed = structuredClone(receipt);
    changed.payload.sessionId = 'other_session';
    expect(verifyAskReceipt(changed, { publicKey: receipt.publicKey, now: receipt.payload.answeredAt })).toMatchObject({
      ok: false,
    });
    expect(verifyAskReceipt(receipt, { publicKey: 'ZmFrZQ', now: receipt.payload.answeredAt }))
      .toEqual({ ok: false, error: 'untrusted_key' });
  });

  it('rejects expired use but permits explicit historical verification', () => {
    const { receipt } = fixture();
    expect(verifyAskReceipt(receipt, { publicKey: receipt.publicKey, now: receipt.payload.expiresAt }))
      .toEqual({ ok: false, error: 'expired' });
    expect(verifyAskReceipt(receipt, { publicKey: receipt.publicKey, now: receipt.payload.expiresAt, allowExpired: true }))
      .toMatchObject({ ok: true, expired: true });
  });

  it('refuses zero or over-five-minute authorization lifetimes', () => {
    const pair = generateKeyPairSync('ed25519');
    const signer = createAskReceiptSigner({
      privateKey: pair.privateKey, publicKey: pair.publicKey, signerInstanceId: 'signer-test-1',
    });
    const { receipt } = fixture();
    const unsigned = {
      ...receipt.payload,
      schema: undefined, keyId: undefined, signerInstanceId: undefined,
    } as unknown as Parameters<typeof signer.sign>[0];
    expect(() => signer.sign({ ...unsigned, expiresAt: unsigned.answeredAt }))
      .toThrow(/lifetime/);
    expect(() => signer.sign({ ...unsigned, expiresAt: unsigned.answeredAt + 300_001 }))
      .toThrow(/lifetime/);
  });

  it('rejects malformed and non-card actor/source shapes', () => {
    const { receipt } = fixture();
    for (const candidate of [
      { ...receipt, extra: true },
      { ...receipt, algorithm: 'HMAC' },
      { ...receipt, payload: { ...receipt.payload, source: 'trusted_desktop' } },
      { ...receipt, payload: { ...receipt.payload, actor: { kind: 'desktop', identity: 'x' } } },
    ]) expect(verifyAskReceipt(candidate, { publicKey: receipt.publicKey, now: receipt.payload.answeredAt }).ok).toBe(false);
  });
});
