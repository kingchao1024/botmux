import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  registerAsk,
  restorePersistedAsks,
  submitAsk,
  toggleAsk,
  tryResolveAsk,
  setCardDispatcher,
  setCanTalkChecker,
  setAskPersistStore,
  setAskReceiptRedeemer,
  _pendingCount,
  _resetForTest,
} from '../src/core/ask-broker.js';
import { createAskPersistStore, askKeyFor, dispatchUuidForKey, ASK_STORE_SENTINEL, type PersistedAsk } from '../src/core/ask-persist-store.js';
import type { AskCardDispatcher, AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import { canonicalAskReceiptBytes, verifyAskReceipt } from '../src/core/ask-receipt.js';
import { createAskAnswerProvenanceAuthority, createAskReceiptSigner } from '../src/daemon/ask-receipt-authority.js';
import { createAskCardEventClaimStore } from '../src/services/ask-card-event-claim-store.js';

/**
 * Restart-resume for `botmux ask` — the AskUserQuestion picker-desync root fix,
 * hardened per codex's REQUEST_CHANGES. Covers BOTH restart orderings:
 *   - reattach → click  (hook reconnects first, then user answers)
 *   - click → reattach  (user answers the dormant card first — durable handoff)
 * plus card re-send when the restart lands before cardMessageId was recorded,
 * request-id/originKind identity, and dependency-injected store isolation.
 */

const OPTIONS = [
  { key: 'yes', label: '继续' },
  { key: 'no', label: '回滚' },
];

function makeInput(over: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    requestId: 'req-1',
    originKind: 'hook',
    backendSurvivesRestart: true, // tmux-backed hook: resumable (daemon-computed)
    questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: false }],
    timeoutMs: 60_000,
    ...over,
  };
}

/** Dispatcher that records sends and lets a test control the returned messageId
 *  (default: undefined-safe id). Also records onSettle for card-flip assertions. */
function mockDispatcher(sendImpl?: (ask: PendingAsk) => Promise<{ messageId?: string }>): AskCardDispatcher & {
  sendCalls: PendingAsk[];
  settleCalls: AskResult[];
} {
  const sendCalls: PendingAsk[] = [];
  const settleCalls: AskResult[] = [];
  return {
    async send(ask) { sendCalls.push(ask); return sendImpl ? sendImpl(ask) : { messageId: `om_card_${ask.askId}` }; },
    onSettle(_ask, result) { settleCalls.push(result); },
    sendCalls,
    settleCalls,
  };
}

let dataDir: string;
let prevDataDir: string | undefined;

/** Rebind a fresh injected store on the broker after a simulated restart. */
function bindStore() {
  setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
}

function createSignedAuthority() {
  const pair = generateKeyPairSync('ed25519');
  return createAskReceiptSigner({
    privateKey: pair.privateKey, publicKey: pair.publicKey, signerInstanceId: 'resume-authority',
  });
}

function bindSignedStore(authority = createSignedAuthority(), bootId = 'boot-test') {
  const store = createAskPersistStore(join(dataDir, 'asks'), authority);
  const provenance = createAskAnswerProvenanceAuthority({
    signer: authority, daemonBootId: bootId,
    claimEvent: async () => ({ ok: true, recovered: false }),
    completeEvent: async () => ({ ok: true, recovered: false }),
  });
  setAskReceiptRedeemer(provenance.redeemer);
  setAskPersistStore(store);
  return { authority, provenance };
}

beforeEach(() => {
  prevDataDir = process.env.SESSION_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-resume-'));
  _resetForTest();          // detaches store (never deletes)
  bindStore();
  setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
});

afterEach(() => {
  _resetForTest();
  // Teardown deletes ONLY this test's own temp dir, and only if it carries the
  // store sentinel (guard against ever reaping a shared/real dir — codex P1-4).
  const store = join(dataDir, 'asks');
  if (existsSync(join(store, ASK_STORE_SENTINEL)) || !existsSync(store)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
});

function persistedFiles(): string[] {
  const dir = join(dataDir, 'asks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json'));
}

function retainedReceiptFiles(): string[] {
  const dir = join(dataDir, 'asks', 'terminal-receipts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.receipt'));
}

function readOnlyRetainedReceiptFile() {
  const dir = join(dataDir, 'asks');
  const files = retainedReceiptFiles();
  if (files.length !== 1) throw new Error(`expected 1 retained receipt, got ${files.length}`);
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8')) as {
    receipt: ReturnType<typeof createSignedAuthority> extends { sign: (...args: never[]) => infer T } ? T : never;
  };
}

/** Read the single persisted ask record (fails if not exactly one). */
function onlyPersisted(): PersistedAsk {
  const files = persistedFiles();
  if (files.length !== 1) throw new Error(`expected 1 persisted ask, got ${files.length}`);
  return JSON.parse(readFileSync(join(dataDir, 'asks', files[0]), 'utf-8')) as PersistedAsk;
}

describe('ask persistence (injected store)', () => {
  it('v3 integrity rejects tampering and a wrong authority key', async () => {
    const { authority } = bindSignedStore();
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const filename = persistedFiles()[0]!;
    const path = join(dataDir, 'asks', filename);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    expect(record.v).toBe(3);
    record.chatId = 'oc_tampered';
    writeFileSync(path, JSON.stringify(record));
    _resetForTest();
    setAskReceiptRedeemer(createAskAnswerProvenanceAuthority({
      signer: authority, daemonBootId: 'boot-test-2',
      claimEvent: async () => ({ ok: true, recovered: false }),
      completeEvent: async () => ({ ok: true, recovered: false }),
    }).redeemer);
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks'), authority));
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);

    const otherPair = generateKeyPairSync('ed25519');
    const other = createAskReceiptSigner({
      privateKey: otherPair.privateKey, publicKey: otherPair.publicKey, signerInstanceId: 'other',
    });
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks'), other));
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);
  });

  it('rejects a correctly signed v3 record whose Ask lifetime exceeds 24h', async () => {
    const { authority } = bindSignedStore();
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const filename = persistedFiles()[0]!;
    const path = join(dataDir, 'asks', filename);
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    const { integrity: _oldIntegrity, ...unsigned } = record;
    unsigned.deadlineAt = unsigned.createdAt + 86_400_001;
    record.deadlineAt = unsigned.deadlineAt;
    record.integrity = authority.sealPersistedState(unsigned);
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 });

    _resetForTest();
    bindSignedStore(authority, 'boot-timeout');
    setCardDispatcher(mockDispatcher());
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);
  });

  it('registerAsk writes a durable record; answering removes it', async () => {
    setCardDispatcher(mockDispatcher());
    const p = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(1);
    const rec = onlyPersisted();
    expect(tryResolveAsk({ askId: rec.askId, nonce: rec.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    await p;
    expect(persistedFiles()).toHaveLength(0);
  });

  it('legacy unsigned persisted selections are rejected outright and never become receipt eligible', async () => {
    const authority = createSignedAuthority();
    bindSignedStore(authority, 'boot-legacy-1');
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({
      questions: [{ prompt: 'pick', options: OPTIONS, multiSelect: true }],
    }));
    await new Promise((r) => setTimeout(r, 5));
    const filename = persistedFiles()[0]!;
    const path = join(dataDir, 'asks', filename);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.v = 2;
    delete record.receiptEligible;
    delete record.integrity;
    record.selections = [['yes']];
    writeFileSync(path, JSON.stringify(record));

    _resetForTest();
    bindSignedStore(authority, 'boot-legacy-2');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);
    expect(persistedFiles()).toHaveLength(1);

    const fresh = registerAsk(makeInput({
      requestId: 'req-2',
      questions: [{ prompt: 'pick', options: OPTIONS, multiSelect: true }],
    }));
    await new Promise((r) => setTimeout(r, 5));
    const files = persistedFiles();
    expect(files).toHaveLength(2);
    const records = files.map((name) =>
      JSON.parse(readFileSync(join(dataDir, 'asks', name), 'utf-8')) as PersistedAsk,
    );
    const live = records.find((entry) => entry.requestId === 'req-2');
    if (!live) throw new Error('expected fresh signed ask record');
    expect(live.v).toBe(3);
    expect(submitAsk({ askId: live.askId, nonce: live.nonce, by: 'ou_owner' })).toBe('needs_empty_confirm');
    expect(submitAsk({ askId: live.askId, nonce: live.nonce, by: 'ou_owner', confirmEmpty: true })).toBe('accepted');
    const result = await fresh;
    expect(result.kind).toBe('answered');
    if (result.kind === 'answered') {
      expect(result.answers).toEqual([[]]);
      expect(result.receipt).toBeUndefined();
    }
  });

  it('does nothing when no store is wired (no global-dir writes)', async () => {
    setAskPersistStore(null);
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(0); // never touched the dir
  });
});

describe('reattach → click (hook reconnects first)', () => {
  it('restores dormant (no re-post), hook re-registers, then click resolves', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = onlyPersisted();

    // Simulate restart: reset memory, rebind store (disk survives), restore.
    _resetForTest();
    bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    expect(d2.sendCalls).toHaveLength(0); // card still live → no re-post

    // Hook reconnects: same requestId → re-attach (no new card).
    const reattached = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(d2.sendCalls).toHaveLength(0);

    // Now the user clicks → resolves the re-attached waiter.
    expect(tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    const result = await reattached;
    expect(result.kind).toBe('answered');
    expect(persistedFiles()).toHaveLength(0);
  });
});

describe('click → reattach (durable handoff — codex P1-1)', () => {
  it('preserves the exact signed receipt across two daemon restarts', async () => {
    const authority = createSignedAuthority();
    let bound = bindSignedStore(authority, 'boot-1');
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const original = onlyPersisted();

    _resetForTest();
    bound = bindSignedStore(authority, 'boot-2');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    const issued = await bound.provenance.issue('cli_app', {
      event_id: 'evt-restart-answer',
      operator: { open_id: 'ou_owner' },
      context: { open_message_id: original.cardMessageId },
      action: { value: {
        action: 'ask_select', ask_id: original.askId, nonce: original.nonce, key: 'yes',
      } },
    });
    if (issued.kind !== 'issued') throw new Error('expected restart answer provenance token');
    expect(tryResolveAsk({
      askId: original.askId, nonce: original.nonce, selected: 'yes', by: 'ou_owner', provenance: issued.token,
    })).toBe('accepted');
    // The single authoritative file becomes an absorbing terminal record. Hook
    // answers stay inline; only S1-controller answers allocate an outbox.
    expect(persistedFiles()).toHaveLength(1);
    expect(retainedReceiptFiles()).toHaveLength(0);
    const retained = onlyPersisted();
    if (retained.answeredResult?.kind !== 'answered' || !retained.answeredResult.receipt) {
      throw new Error('signed inline terminal answer expected');
    }
    const originalReceipt = retained.answeredResult.receipt;
    const originalBytes = canonicalAskReceiptBytes(originalReceipt.payload);

    _resetForTest();
    bindSignedStore(authority, 'boot-3');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');

    _resetForTest();
    bindSignedStore(authority, 'boot-4');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    const claimed = await registerAsk(makeInput());
    if (claimed.kind !== 'answered' || !claimed.receipt) throw new Error('restored signed answer expected');
    expect(canonicalAskReceiptBytes(claimed.receipt.payload)).toEqual(originalBytes);
    expect(claimed.receipt).toEqual(originalReceipt);
    expect(verifyAskReceipt(claimed.receipt, {
      publicKey: authority.publicKey, now: claimed.receipt.payload.answeredAt,
    })).toMatchObject({ ok: true });

    const wrong = createSignedAuthority();
    expect(verifyAskReceipt(claimed.receipt, {
      publicKey: wrong.publicKey, now: claimed.receipt.payload.answeredAt,
    })).toEqual({ ok: false, error: 'untrusted_key' });
    const tampered = structuredClone(claimed.receipt);
    tampered.payload.chatId = 'oc_tampered';
    expect(verifyAskReceipt(tampered, {
      publicKey: authority.publicKey, now: claimed.receipt.payload.answeredAt,
    }).ok).toBe(false);
  });

  it('user answers dormant card first; hook reconnect delivers the stashed answer, 0 new cards', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = onlyPersisted();

    // Restart → restore dormant.
    _resetForTest();
    bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');

    // User clicks the dormant card BEFORE the hook reconnects.
    expect(tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    // Answer is stashed durably (record kept, not deleted) + card flipped.
    expect(persistedFiles()).toHaveLength(1);
    expect(d2.settleCalls).toHaveLength(1);

    // Hook reconnects (same requestId) → claims the stashed answer, no new card.
    const reattached = registerAsk(makeInput());
    const result = await reattached;
    expect(result.kind).toBe('answered');
    if (result.kind === 'answered') expect(result.answers).toEqual([['yes']]);
    expect(d2.sendCalls).toHaveLength(0);           // never posted a second card
    expect(persistedFiles()).toHaveLength(0);       // claimed → cleaned
  });

  it('stashed answer survives a SECOND restart before the hook claims it', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = onlyPersisted();

    _resetForTest(); bindStore(); setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'no', by: 'ou_owner' }); // answered while dormant
    expect(persistedFiles()).toHaveLength(1); // stashed

    // Second restart before claim: the stashed answer must persist.
    _resetForTest(); bindStore(); setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    const result = await registerAsk(makeInput());
    expect(result.kind).toBe('answered');
    if (result.kind === 'answered') expect(result.answers).toEqual([['no']]);
    expect(persistedFiles()).toHaveLength(0);
  });

  it('restart preserves selection actor ownership: A submit succeeds, B submit is rejected', async () => {
    const authority = createSignedAuthority();
    bindSignedStore(authority, 'boot-owner-1');
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({
      questions: [{ prompt: 'pick', options: OPTIONS, multiSelect: true }],
    }));
    await new Promise((r) => setTimeout(r, 5));
    const original = onlyPersisted();
    expect(toggleAsk({
      askId: original.askId,
      nonce: original.nonce,
      questionIndex: 0,
      key: 'yes',
      by: 'ou_owner',
    })).toBe('toggled');
    expect((onlyPersisted() as PersistedAsk & { selectionActorIdentity?: string }).selectionActorIdentity)
      .toBe('ou_owner');

    _resetForTest();
    bindSignedStore(authority, 'boot-owner-2');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner' || openId === 'ou_other');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);

    const reattached = registerAsk(makeInput({
      questions: [{ prompt: 'pick', options: OPTIONS, multiSelect: true }],
    }));
    await new Promise((r) => setTimeout(r, 5));
    expect(submitAsk({ askId: original.askId, nonce: original.nonce, by: 'ou_other' })).toBe('unauthorized');
    expect(submitAsk({ askId: original.askId, nonce: original.nonce, by: 'ou_owner' })).toBe('accepted');
    const result = await reattached;
    expect(result.kind).toBe('answered');
    if (result.kind === 'answered') expect(result.answers).toEqual([['yes']]);
  });

  it('restart rejects a delivered toggle replay and signs only the same actor submit', async () => {
    const authority = createSignedAuthority();
    const claimsDir = join(dataDir, 'claims');
    const claims1 = createAskCardEventClaimStore(claimsDir, { instanceId: 'boot-claim-1' });
    const store1 = createAskPersistStore(join(dataDir, 'asks'), authority);
    const provenance1 = createAskAnswerProvenanceAuthority({
      signer: authority, daemonBootId: 'boot-claim-1',
      claimEvent: claims1.claim, completeEvent: claims1.complete,
    });
    setAskReceiptRedeemer(provenance1.redeemer);
    setAskPersistStore(store1);
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({
      questions: [{ prompt: 'pick', options: OPTIONS, multiSelect: true }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const original = onlyPersisted();
    const toggleEvent = {
      event_id: 'evt-toggle-before-restart', operator: { open_id: 'ou_owner' },
      context: { open_message_id: original.cardMessageId },
      action: { value: {
        action: 'ask_toggle', ask_id: original.askId, nonce: original.nonce,
        question_index: '0', key: 'yes',
      } },
    };
    const toggleIssued = await provenance1.issue('cli_app', toggleEvent);
    if (toggleIssued.kind !== 'issued') throw new Error('expected toggle claim');
    expect(toggleAsk({
      askId: original.askId, nonce: original.nonce, questionIndex: 0, key: 'yes',
      by: 'ou_owner', provenance: toggleIssued.token,
    })).toBe('toggled');
    expect(await provenance1.complete(toggleIssued.token)).toMatchObject({ ok: true });

    _resetForTest();
    const claims2 = createAskCardEventClaimStore(claimsDir, { instanceId: 'boot-claim-2' });
    const store2 = createAskPersistStore(join(dataDir, 'asks'), authority);
    const provenance2 = createAskAnswerProvenanceAuthority({
      signer: authority, daemonBootId: 'boot-claim-2',
      claimEvent: claims2.claim, completeEvent: claims2.complete,
    });
    setAskReceiptRedeemer(provenance2.redeemer);
    setAskPersistStore(store2);
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner' || openId === 'ou_other');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);

    expect(await provenance2.issue('cli_app', toggleEvent))
      .toEqual({ kind: 'rejected', reason: 'duplicate' });

    const otherSubmit = await provenance2.issue('cli_app', {
      event_id: 'evt-submit-other', operator: { open_id: 'ou_other' },
      context: { open_message_id: original.cardMessageId },
      action: { value: { action: 'ask_submit', ask_id: original.askId, nonce: original.nonce } },
    });
    if (otherSubmit.kind !== 'issued') throw new Error('expected other submit claim');
    expect(submitAsk({
      askId: original.askId, nonce: original.nonce, by: 'ou_other',
      provenance: otherSubmit.token, provenanceAction: 'ask_submit', provenanceHasFormValue: false,
    })).toBe('unauthorized');
    expect(provenance2.wasRedeemed(otherSubmit.token)).toBe(false);

    const ownerSubmit = await provenance2.issue('cli_app', {
      event_id: 'evt-submit-owner', operator: { open_id: 'ou_owner' },
      context: { open_message_id: original.cardMessageId },
      action: { value: { action: 'ask_submit', ask_id: original.askId, nonce: original.nonce } },
    });
    if (ownerSubmit.kind !== 'issued') throw new Error('expected owner submit claim');
    expect(submitAsk({
      askId: original.askId, nonce: original.nonce, by: 'ou_owner',
      provenance: ownerSubmit.token, provenanceAction: 'ask_submit', provenanceHasFormValue: false,
    })).toBe('accepted');
    expect(await provenance2.complete(ownerSubmit.token)).toMatchObject({ ok: true });

    const result = await registerAsk(makeInput({
      questions: [{ prompt: 'pick', options: OPTIONS, multiSelect: true }],
    }));
    expect(result.kind).toBe('answered');
    if (result.kind !== 'answered') return;
    expect(result.answers).toEqual([['yes']]);
    expect(result.receipt?.payload).toMatchObject({
      actor: { identity: 'ou_owner' },
      platformEventId: 'evt-submit-owner',
      answers: [['yes']],
    });
  });
});

describe('signed persistence closure (terminal tombstone + fail-closed mutations)', () => {
  it('authoritative terminal state prevents stale signed payload revival', async () => {
    const authority = createSignedAuthority();
    const claimsDir = join(dataDir, 'claim-eacces');
    const claimsA = createAskCardEventClaimStore(claimsDir, { instanceId: 'claim-a' });
    const storeA = createAskPersistStore(join(dataDir, 'asks'), authority);
    const provenanceA = createAskAnswerProvenanceAuthority({
      signer: authority,
      daemonBootId: 'boot-eacces-a',
      claimEvent: claimsA.claim,
      completeEvent: claimsA.complete,
    });
    setAskReceiptRedeemer(provenanceA.redeemer);
    setAskPersistStore(storeA);
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner' || openId === 'ou_other');

    const first = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const original = onlyPersisted();

    const issuedA = await provenanceA.issue('cli_app', {
      event_id: 'evt-eacces-a',
      operator: { open_id: 'ou_owner' },
      context: { open_message_id: original.cardMessageId },
      action: { value: { action: 'ask_select', ask_id: original.askId, nonce: original.nonce, key: 'yes' } },
    });
    if (issuedA.kind !== 'issued') throw new Error('expected signed first issuance');
    expect(tryResolveAsk({
      askId: original.askId,
      nonce: original.nonce,
      selected: 'yes',
      by: 'ou_owner',
      provenance: issuedA.token,
    })).toBe('accepted');
    const firstResult = await first;
    expect(firstResult.kind).toBe('answered');
    if (firstResult.kind !== 'answered' || !firstResult.receipt) {
      throw new Error('expected first signed receipt');
    }
    const firstReceipt = firstResult.receipt;

    const askDir = join(dataDir, 'asks');
    const secondAuthority = bindSignedStore(authority, 'boot-eacces-b');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner' || openId === 'ou_other');
    // The retained signed terminal is an absorbing replay/recovery barrier. It
    // is visible to restore scanning but must never re-enter the pending set.
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    expect(_pendingCount()).toBe(0);

    const second = registerAsk(makeInput({ requestId: 'req-2' }));
    await new Promise((r) => setTimeout(r, 5));
    const live = persistedFiles()
      .map((name) => JSON.parse(readFileSync(join(dataDir, 'asks', name), 'utf8')) as PersistedAsk)
      .find((entry) => entry.requestId === 'req-2');
    if (!live) throw new Error('expected second live ask');
    const issuedB = await secondAuthority!.provenance.issue('cli_app', {
      event_id: 'evt-eacces-b',
      operator: { open_id: 'ou_other' },
      context: { open_message_id: live.cardMessageId },
      action: { value: { action: 'ask_select', ask_id: live.askId, nonce: live.nonce, key: 'no' } },
    });
    if (issuedB.kind !== 'issued') throw new Error('expected signed second issuance');
    expect(tryResolveAsk({
      askId: live.askId,
      nonce: live.nonce,
      selected: 'no',
      by: 'ou_other',
      provenance: issuedB.token,
    })).toBe('accepted');
    const secondResult = await second;
    expect(secondResult.kind).toBe('answered');
    if (secondResult.kind !== 'answered' || !secondResult.receipt) {
      throw new Error('expected second signed receipt');
    }
    expect(secondResult.receipt.payload.jti).not.toBe(firstReceipt.payload.jti);
    expect(secondResult.receipt.payload.answers).toEqual([['no']]);
    expect(firstReceipt.payload.answers).toEqual([['yes']]);
  });

  it('rejects stale signed rollback payload when a newer tombstone exists', async () => {
    const authority = createSignedAuthority();
    bindSignedStore(authority, 'boot-stale-a');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');

    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const before = onlyPersisted();
    const staleBytes = readFileSync(join(dataDir, 'asks', persistedFiles()[0]!), 'utf8');

    expect(tryResolveAsk({
      askId: before.askId,
      nonce: before.nonce,
      selected: 'yes',
      by: 'ou_owner',
    })).toBe('accepted');

    const stalePath = join(dataDir, 'asks', `${'x'.repeat(64)}.json`);
    writeFileSync(stalePath, staleBytes, { mode: 0o600 });

    _resetForTest();
    bindSignedStore(authority, 'boot-stale-b');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    // The terminal record is retained as an absorbing replay barrier; the
    // extra stale pending copy must not create a second live ask.
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    expect(_pendingCount()).toBe(0);
  });

  it('fails closed on signed toggle persistence write failure', async () => {
    const authority = createSignedAuthority();
    bindSignedStore(authority, 'boot-toggle-a');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');

    registerAsk(makeInput({
      questions: [{ prompt: 'pick', options: OPTIONS, multiSelect: true }],
    }));
    await new Promise((r) => setTimeout(r, 5));
    const original = onlyPersisted();
    const askDir = join(dataDir, 'asks');

    chmodSync(askDir, 0o500);
    try {
      expect(toggleAsk({
        askId: original.askId,
        nonce: original.nonce,
        questionIndex: 0,
        key: 'yes',
        by: 'ou_owner',
      })).toBe('stale');
    } finally {
      chmodSync(askDir, 0o700);
    }

    _resetForTest();
    bindSignedStore(authority, 'boot-toggle-b');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
  });

  it('restores full pre-mutation single-select state when signed toggle persistence fails', async () => {
    const authority = createSignedAuthority();
    const firstBoot = bindSignedStore(authority, 'boot-toggle-restore-a');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner' || openId === 'ou_other');

    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const original = onlyPersisted();

    const chooseYes = await firstBoot.provenance.issue('cli_app', {
      event_id: 'evt-toggle-restore-yes',
      operator: { open_id: 'ou_owner' },
      context: { open_message_id: original.cardMessageId },
      action: { value: { action: 'ask_toggle', ask_id: original.askId, nonce: original.nonce, key: 'yes', question_index: 0 } },
    });
    if (chooseYes.kind !== 'issued') throw new Error('expected signed initial toggle issuance');
    expect(toggleAsk({
      askId: original.askId,
      nonce: original.nonce,
      questionIndex: 0,
      key: 'yes',
      by: 'ou_owner',
      provenance: chooseYes.token,
    })).toBe('toggled');

    const afterYes = onlyPersisted() as PersistedAsk & { selectionActorIdentity?: string; receiptEligible?: boolean };
    expect(afterYes.selections).toEqual([['yes']]);
    expect(afterYes.selectionActorIdentity).toBe('ou_owner');
    expect(afterYes.receiptEligible).toBe(true);

    const askDir = join(dataDir, 'asks');
    chmodSync(askDir, 0o500);
    try {
      const chooseNo = await firstBoot.provenance.issue('cli_app', {
        event_id: 'evt-toggle-restore-no',
        operator: { open_id: 'ou_owner' },
        context: { open_message_id: original.cardMessageId },
        action: { value: { action: 'ask_toggle', ask_id: original.askId, nonce: original.nonce, key: 'no', question_index: 0 } },
      });
      if (chooseNo.kind !== 'issued') throw new Error('expected signed failing toggle issuance');
      expect(toggleAsk({
        askId: original.askId,
        nonce: original.nonce,
        questionIndex: 0,
        key: 'no',
        by: 'ou_owner',
        provenance: chooseNo.token,
      })).toBe('stale');
    } finally {
      chmodSync(askDir, 0o700);
    }

    const afterFailure = onlyPersisted() as PersistedAsk & { selectionActorIdentity?: string; receiptEligible?: boolean };
    expect(afterFailure.selections).toEqual([['yes']]);
    expect(afterFailure.selectionActorIdentity).toBe('ou_owner');
    expect(afterFailure.receiptEligible).toBe(true);

    _resetForTest();
    const secondBoot = bindSignedStore(authority, 'boot-toggle-restore-b');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner' || openId === 'ou_other');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    const resumed = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));

    expect(submitAsk({ askId: original.askId, nonce: original.nonce, by: 'ou_other' })).toBe('unauthorized');
    const submitIssued = await secondBoot.provenance.issue('cli_app', {
      event_id: 'evt-toggle-restore-submit',
      operator: { open_id: 'ou_owner' },
      context: { open_message_id: original.cardMessageId },
      action: { value: { action: 'ask_submit', ask_id: original.askId, nonce: original.nonce } },
    });
    if (submitIssued.kind !== 'issued') throw new Error('expected signed submit issuance');
    expect(submitAsk({
      askId: original.askId,
      nonce: original.nonce,
      by: 'ou_owner',
      provenance: submitIssued.token,
      provenanceAction: 'ask_submit',
      provenanceHasFormValue: false,
    })).toBe('accepted');

    const result = await resumed;
    expect(result.kind).toBe('answered');
    if (result.kind !== 'answered' || !result.receipt) {
      throw new Error('expected restored signed receipt');
    }
    expect(result.answers).toEqual([['yes']]);
    expect(result.receipt.payload.answers).toEqual([['yes']]);
    expect(result.receipt.payload.actor.identity).toBe('ou_owner');
  });
});

describe('card re-send when restart precedes cardMessageId (codex P1-2)', () => {
  it('a restored ask without cardMessageId re-sends exactly one card on re-attach', async () => {
    // Dispatcher that never resolves a messageId → simulates restart before the
    // .then() that records cardMessageId runs.
    let resolveSend: (v: { messageId?: string }) => void;
    const slow = mockDispatcher(() => new Promise((res) => { resolveSend = res; }));
    setCardDispatcher(slow);
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    // Record persisted WITHOUT cardMessageId (send still pending).
    const files = readdirSync(join(dataDir, 'asks')).filter(n => n.endsWith('.json'));
    const orig = onlyPersisted();
    expect(orig.cardMessageId).toBeUndefined();

    // Restart → restore → hook re-attach: MUST re-send the card exactly once.
    _resetForTest(); bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    expect(d2.sendCalls).toHaveLength(0);           // restore alone doesn't send
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(d2.sendCalls).toHaveLength(1);           // re-attach re-sends exactly one
    void resolveSend!;
  });
});

describe('startup restore sequencing', () => {
  it('initial unsigned fallback restore skips signed v3 state until a second signed restore runs', async () => {
    const authority = createSignedAuthority();
    bindSignedStore(authority, 'boot-startup-1');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');

    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const original = onlyPersisted();

    _resetForTest();
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);

    const signedBoot = bindSignedStore(authority, 'boot-startup-2');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);

    const resumed = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const issued = await signedBoot.provenance.issue('cli_app', {
      event_id: 'evt-startup-second-restore',
      operator: { open_id: 'ou_owner' },
      context: { open_message_id: original.cardMessageId },
      action: { value: {
        action: 'ask_select', ask_id: original.askId, nonce: original.nonce, key: 'yes',
      } },
    });
    if (issued.kind !== 'issued') throw new Error('expected signed startup issuance');
    expect(tryResolveAsk({
      askId: original.askId,
      nonce: original.nonce,
      selected: 'yes',
      by: 'ou_owner',
      provenance: issued.token,
    })).toBe('accepted');

    const result = await resumed;
    expect(result.kind).toBe('answered');
    if (result.kind !== 'answered' || !result.receipt) {
      throw new Error('expected signed receipt after second restore');
    }
    expect(result.receipt.payload.actor.identity).toBe('ou_owner');
  });

  it('a second signed restore recovers retained terminal receipts after unsigned fallback skipped them', async () => {
    const authority = createSignedAuthority();
    const firstBoot = bindSignedStore(authority, 'boot-startup-terminal-1');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');

    const firstAnswered = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const original = onlyPersisted();
    const issued = await firstBoot.provenance.issue('cli_app', {
      event_id: 'evt-startup-terminal-answer',
      operator: { open_id: 'ou_owner' },
      context: { open_message_id: original.cardMessageId },
      action: { value: {
        action: 'ask_select', ask_id: original.askId, nonce: original.nonce, key: 'yes',
      } },
    });
    if (issued.kind !== 'issued') throw new Error('expected signed terminal issuance');
    expect(tryResolveAsk({
      askId: original.askId,
      nonce: original.nonce,
      selected: 'yes',
      by: 'ou_owner',
      provenance: issued.token,
    })).toBe('accepted');

    const answered = await firstAnswered;
    if (answered.kind !== 'answered' || !answered.receipt) {
      throw new Error('expected signed terminal receipt on first boot');
    }

    _resetForTest();
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);

    bindSignedStore(authority, 'boot-startup-terminal-2');
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);

    const claimed = await registerAsk(makeInput());
    expect(claimed.kind).toBe('answered');
    if (claimed.kind !== 'answered' || !claimed.receipt) {
      throw new Error('expected retained terminal receipt recovery after second restore');
    }
    expect(claimed.receipt).toEqual(answered.receipt);
    expect(canonicalAskReceiptBytes(claimed.receipt.payload))
      .toEqual(canonicalAskReceiptBytes(answered.receipt.payload));
  });
});

describe('identity + isolation (codex P1-3)', () => {
  it('askKeyFor scopes by larkAppId+session+originKind+requestId (not a bearer secret)', () => {
    const k = askKeyFor('cli_app', 'sess-1', 'hook', 'req-1');
    expect(k).toBe(askKeyFor('cli_app', 'sess-1', 'hook', 'req-1'));
    expect(k).not.toBe(askKeyFor('cli_app', 'sess-2', 'hook', 'req-1')); // diff session
    expect(k).not.toBe(askKeyFor('cli_b', 'sess-1', 'hook', 'req-1'));   // diff bot
    expect(k).not.toBe(askKeyFor('cli_app', 'sess-1', 'explicit', 'req-1')); // diff origin
    expect(k).not.toBe(askKeyFor('cli_app', 'sess-1', 'hook', 'req-2')); // diff request
  });

  it('session B CANNOT reclaim session A dormant ask by reusing the same requestId', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ sessionId: 'sess-A', requestId: 'shared-req' }));
    await new Promise((r) => setTimeout(r, 5));
    const a = onlyPersisted();

    // Restart → restore A's dormant ask.
    _resetForTest(); bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_x, _y, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');

    // Session B re-registers with the SAME requestId but its own session id.
    // Different scoped key → must NOT re-attach to A; posts B's own new card.
    const bPromise = registerAsk(makeInput({ sessionId: 'sess-B', requestId: 'shared-req' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(d2.sendCalls).toHaveLength(1); // B got its OWN card, did not steal A's

    // Answering A's original card must resolve nobody's B promise.
    tryResolveAsk({ askId: a.askId, nonce: a.nonce, selected: 'yes', by: 'ou_owner' });
    let bResolved = false;
    void bPromise.then(() => { bResolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(bResolved).toBe(false); // B never received A's answer
  });

  it('two concurrent same-question asks from one session get distinct records (distinct requestId)', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ requestId: 'req-A' }));
    registerAsk(makeInput({ requestId: 'req-B' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(2); // NOT collapsed by a questions hash
  });

  it('restore skips a different bot', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ larkAppId: 'cli_other', sessionId: 'sess-o', requestId: 'req-other' }));
    await new Promise((r) => setTimeout(r, 5));
    _resetForTest(); bindStore(); setCardDispatcher(mockDispatcher());
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);
  });
});

describe('active same-requestId replay joins one ask (codex P1-1)', () => {
  it('a second live register with the same identity shares the ONE ask/card and both get the answer', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p1 = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    // Client reset → re-POST same requestId while still active: joins, no 2nd card.
    const p2 = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(d.sendCalls).toHaveLength(1);        // ONE card
    expect(persistedFiles()).toHaveLength(1);   // ONE record

    const rec = onlyPersisted();
    tryResolveAsk({ askId: rec.askId, nonce: rec.nonce, selected: 'yes', by: 'ou_owner' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('answered');
    expect(r2).toEqual(r1);                     // both waiters got the SAME result
  });
});

describe('dispatch uuid + non-resumable origins (codex P1-1/P1-4)', () => {
  it('resumable (hook) card send carries a stable dispatchUuid derived from the scoped key', async () => {
    let seenUuid: string | undefined = 'UNSET';
    const d = mockDispatcher((ask) => { seenUuid = ask.dispatchUuid; return Promise.resolve({ messageId: 'om_x' }); });
    setCardDispatcher(d);
    registerAsk(makeInput({ requestId: 'req-uuid-1' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(seenUuid).toBe(dispatchUuidForKey(askKeyFor('cli_app', 'sess-1', 'hook', 'req-uuid-1')));
  });

  it('explicit origin is NOT persisted but DOES carry a dispatchUuid (codex P1-1)', async () => {
    let seenUuid: string | undefined = 'UNSET';
    const d = mockDispatcher((ask) => { seenUuid = ask.dispatchUuid; return Promise.resolve({ messageId: 'om_x' }); });
    setCardDispatcher(d);
    // Explicit ask: originKind='explicit', no requestId → not resumable.
    registerAsk(makeInput({ originKind: 'explicit', requestId: undefined }));
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(0);   // never persisted → no orphan handoff
    // But it STILL carries a dedupe uuid: the bounded retry re-sends even a
    // non-resumable card, so it needs server-side dedupe. uuid gates dispatch
    // idempotency (intra-process); resumable gates persistence (cross-restart).
    expect(seenUuid).toBeTruthy();
  });
});
