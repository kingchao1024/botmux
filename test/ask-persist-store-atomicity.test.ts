import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AskPersistCapacityError,
  AskPersistRevisionConflictError,
  HANDOFF_RETENTION_MS,
  askKeyFor,
  createAskPersistStore,
  type PersistedAskWrite,
} from '../src/core/ask-persist-store.js';
import {
  ASK_RECEIPT_TTL_MS,
  askAnswerDigest,
  askQuestionDigest,
  askReceiptJti,
} from '../src/core/ask-receipt.js';
import { createAskReceiptSigner } from '../src/daemon/ask-receipt-authority.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const roots: string[] = [];
const BASE_TIME = Date.now();

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'botmux-ask-atomicity-'));
  roots.push(value);
  chmodSync(value, 0o700);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function authority() {
  const pair = generateKeyPairSync('ed25519');
  return createAskReceiptSigner({
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    signerInstanceId: 'atomicity-test',
  });
}

const QUESTIONS = [{
  prompt: 'continue?',
  options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }],
  multiSelect: false,
}];

function signedAsk(originKind = 's1-controller', suffix = 'one'): Extract<PersistedAskWrite, { v: 3 }> {
  const requestId = `request-${suffix}`;
  return {
    v: 3,
    askKey: askKeyFor('cli-app', 'session-one', originKind, requestId),
    requestId,
    originKind,
    askId: `ask-${suffix}`,
    nonce: `nonce-${suffix}`,
    larkAppId: 'cli-app',
    chatId: 'chat-one',
    rootMessageId: 'root-one',
    sessionId: 'session-one',
    questions: QUESTIONS,
    createdAt: BASE_TIME,
    deadlineAt: BASE_TIME + 60_000,
    ...(originKind === 's1-controller'
      ? { notBeforeMs: BASE_TIME, expiresAtMs: BASE_TIME + 60_000 }
      : {}),
    cardMessageId: `card-${suffix}`,
    selections: [[]],
    receiptEligible: true,
  };
}

function signedAnswer(
  signer: ReturnType<typeof authority>,
  ask: Extract<PersistedAskWrite, { v: 3 }>,
  answeredAt = BASE_TIME + 1_000,
) {
  const answers = [['yes']];
  const receipt = signer.sign({
    askId: ask.askId,
    larkAppId: ask.larkAppId,
    sessionId: ask.sessionId,
    chatId: ask.chatId,
    rootMessageId: ask.rootMessageId,
    questionDigest: askQuestionDigest(ask.questions),
    answerDigest: askAnswerDigest(answers, null),
    answers,
    selected: 'yes',
    actor: { kind: 'lark_user', identity: 'user-one' },
    source: 'lark_card',
    platformEventId: `event-${ask.requestId}`,
    cardMessageId: ask.cardMessageId!,
    askNonce: ask.nonce,
    answeredAt,
    expiresAt: Math.min(ask.deadlineAt, answeredAt + ASK_RECEIPT_TTL_MS),
    daemonBootId: 'boot-one',
    jti: askReceiptJti({
      larkAppId: ask.larkAppId, sessionId: ask.sessionId, askId: ask.askId,
      platformEventId: `event-${ask.requestId}`, cardMessageId: ask.cardMessageId!,
    }),
  });
  return {
    receipt,
    result: {
      kind: 'answered' as const, answers, by: 'user-one', comment: null,
      timedOut: false as const, receipt,
    },
  };
}

function files(dir: string): { states: string[]; outboxes: string[] } {
  const states = existsSync(dir)
    ? readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    : [];
  const outboxDir = join(dir, 'terminal-receipts');
  const outboxes = existsSync(outboxDir)
    ? readdirSync(outboxDir).filter((name) => name.endsWith('.json'))
    : [];
  return { states, outboxes };
}

function recoverInput(ask: Extract<PersistedAskWrite, { v: 3 }>, now = BASE_TIME + 1_001) {
  return {
    askKey: ask.askKey, requestId: ask.requestId, originKind: ask.originKind,
    larkAppId: ask.larkAppId, sessionId: ask.sessionId, chatId: ask.chatId,
    rootMessageId: ask.rootMessageId, questionDigest: askQuestionDigest(ask.questions), now,
    notBeforeMs: ask.notBeforeMs!,
    expiresAtMs: ask.expiresAtMs!,
  };
}

describe('atomic signed ask persistence', () => {
  it('uses one authoritative state file and enforces revision CAS plus absorbing terminal state', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const store = createAskPersistStore(dir, signer);
    const ask = signedAsk();

    expect(store.commitSigned(ask, 0)).toBe(1);
    expect(() => store.commitSigned({ ...ask, selections: [['yes']] }, 0))
      .toThrow(AskPersistRevisionConflictError);
    expect(() => store.commitSigned({ ...ask, answeredResult: {
      kind: 'answered', answers: [['yes']], by: 'user-one', comment: null, timedOut: false,
    }, answeredAt: BASE_TIME + 1_000 }, 1)).toThrow(/pending state only/);
    expect(store.commitSigned({ ...ask, selections: [['yes']], selectionActorIdentity: 'user-one' }, 1)).toBe(2);

    const { result, receipt } = signedAnswer(signer, {
      ...ask, selections: [['yes']], selectionActorIdentity: 'user-one',
    });
    expect(store.commitTerminalSigned({
      ask: { ...ask, selections: [['yes']], selectionActorIdentity: 'user-one' },
      expectedRevision: 2, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toEqual({ revision: 3 });
    expect(() => store.commitTerminalSigned({
      ask: { ...ask, selections: [[]], selectionActorIdentity: undefined },
      expectedRevision: 2, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toThrow(/terminal state does not match authenticated pending state/);
    expect(() => store.terminalizeSigned({
      ask: { ...ask, selections: [['yes']], selectionActorIdentity: 'user-one', receiptEligible: false },
      expectedRevision: 2,
      result: { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true },
      now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toThrow(/terminal state does not match authenticated pending state/);
    expect(files(dir)).toMatchObject({ states: [expect.stringMatching(/\.json$/)], outboxes: [expect.stringMatching(/\.json$/)] });
    expect(readdirSync(dir).some((name) => name.endsWith('.head') || name.endsWith('.receipt'))).toBe(false);
    expect(() => store.commitSigned(ask, 3)).toThrow(/terminal state is absorbing/);
    expect(store.commitTerminalSigned({
      ask: { ...ask, selections: [['yes']], selectionActorIdentity: 'user-one' },
      expectedRevision: 2, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toEqual({ revision: 3 });
  });

  it('ignores an orphan S1 outbox after a crash following outbox fsync', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const ask = signedAsk();
    const initial = createAskPersistStore(dir, signer);
    expect(initial.commitSigned(ask, 0)).toBe(1);
    const { result, receipt } = signedAnswer(signer, ask);
    const crashing = createAskPersistStore(dir, signer, { faultInjection: 'after_outbox_fsync' });

    expect(() => crashing.commitTerminalSigned({
      ask, expectedRevision: 1, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toThrow(/after_outbox_fsync/);
    expect(files(dir).outboxes).toHaveLength(1);
    expect(initial.recoverTerminalReceipt(recoverInput(ask))).toEqual({ ok: false, reason: 'missing' });
    expect(initial.sweep(BASE_TIME + 1_001)).toEqual({ removedStates: 0, removedOutboxes: 1 });
    expect(initial.list(BASE_TIME + 1_001)).toHaveLength(1);
  });

  it('binds S1 recovery to the exact original absolute activation window', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const ask = signedAsk();
    const store = createAskPersistStore(dir, signer);
    store.commitSigned(ask, 0);
    const { result, receipt } = signedAnswer(signer, ask);
    store.commitTerminalSigned({
      ask, expectedRevision: 1, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    });

    expect(store.recoverTerminalReceipt(recoverInput(ask)).ok).toBe(true);
    expect(store.recoverTerminalReceipt({
      ...recoverInput(ask), notBeforeMs: ask.notBeforeMs! + 1,
    })).toEqual({ ok: false, reason: 'mismatch' });
    expect(store.recoverTerminalReceipt({
      ...recoverInput(ask), expiresAtMs: ask.expiresAtMs! + 1,
    })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('never rolls back a terminal state and authenticates its forward outbox pointer', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const ask = signedAsk();
    const initial = createAskPersistStore(dir, signer);
    initial.commitSigned(ask, 0);
    const { result, receipt } = signedAnswer(signer, ask);
    const crashing = createAskPersistStore(dir, signer, { faultInjection: 'after_state_fsync' });

    expect(() => crashing.commitTerminalSigned({
      ask, expectedRevision: 1, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toThrow(/after_state_fsync/);
    expect(crashing.commitTerminalSigned({
      ask, expectedRevision: 1, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toEqual({ revision: 2 });
    expect(initial.list(BASE_TIME + 1_001)).toEqual([]);
    const recovered = initial.recoverTerminalReceipt(recoverInput(ask));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.revision).toBe(2);
    expect(Object.isFrozen(recovered.answeredResult)).toBe(true);
    expect(Object.isFrozen(recovered.answeredResult.answers)).toBe(true);
    expect(Object.isFrozen(recovered.receipt.payload)).toBe(true);
    const stateName = files(dir).states[0]!;
    const outboxName = files(dir).outboxes[0]!;
    const state = JSON.parse(readFileSync(join(dir, stateName), 'utf8')) as Record<string, unknown>;
    const outboxPath = join(dir, 'terminal-receipts', outboxName);
    const originalOutbox = readFileSync(outboxPath, 'utf8');
    const outbox = JSON.parse(originalOutbox) as Record<string, unknown>;
    expect(state.state).toBe('terminal');
    expect(outbox.revision).toBe(state.revision);
    expect(state.outboxSha256).toBe(createHash('sha256').update(originalOutbox).digest('hex'));
    expect(state.receiptJti).toBe(outbox.receiptJti);
    expect(outbox.stateSha256).toBeUndefined();
    const tamperedOutbox = { ...outbox, persistedAt: BASE_TIME + 1_001 };
    const { integrity: _integrity, ...unsignedOutbox } = tamperedOutbox;
    tamperedOutbox.integrity = signer.sealPersistedState(unsignedOutbox);
    writeFileSync(outboxPath, JSON.stringify(tamperedOutbox), { mode: 0o600 });
    expect(initial.recoverTerminalReceipt(recoverInput(ask))).toEqual({ ok: false, reason: 'missing' });
    writeFileSync(outboxPath, originalOutbox, { mode: 0o600 });
  });

  it('keeps signed hook terminal answers inline without allocating an outbox', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const ask = signedAsk('hook');
    const store = createAskPersistStore(dir, signer);
    store.commitSigned(ask, 0);
    const { result, receipt } = signedAnswer(signer, ask);
    expect(store.commitTerminalSigned({
      ask, expectedRevision: 1, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toEqual({ revision: 2 });
    expect(files(dir).outboxes).toEqual([]);
    expect(store.list(BASE_TIME + 1_001)).toHaveLength(1);
    expect(store.recoverTerminalReceipt(recoverInput(ask)).ok).toBe(true);
  });

  it('rejects a valid Ed25519 receipt that is signed by an unpinned authority', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const attacker = authority();
    const ask = signedAsk();
    const store = createAskPersistStore(dir, signer);
    store.commitSigned(ask, 0);
    const { result, receipt } = signedAnswer(attacker, ask);
    expect(() => store.commitTerminalSigned({
      ask, expectedRevision: 1, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toThrow(/terminal receipt binding/);
    expect(files(dir).outboxes).toEqual([]);
    expect(store.list(BASE_TIME + 1_001)).toHaveLength(1);
  });

  it('does not evict live pending or terminal records when capacity is exhausted', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const store = createAskPersistStore(dir, signer, {
      maxPendingRecords: 1,
      maxTerminalRecords: 1,
    });
    const first = signedAsk('hook', 'first');
    const second = signedAsk('hook', 'second');
    store.commitSigned(first, 0);
    expect(() => store.commitSigned(second, 0)).toThrow(AskPersistCapacityError);
    expect(store.list(BASE_TIME + 1)).toHaveLength(1);

    const timedOut = { kind: 'timedOut' as const, selected: null, by: null, comment: null, timedOut: true as const };
    expect(store.terminalizeSigned({
      ask: first,
      expectedRevision: 1,
      result: timedOut,
      now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toEqual({ revision: 2 });
    expect(() => store.commitSigned(second, 0)).toThrow(AskPersistCapacityError);
    expect(files(dir).states).toHaveLength(1);
  });

  it('reserves terminal capacity for every admitted pending answer and timeout', () => {
    for (const terminalKind of ['answered', 'timedOut'] as const) {
      const dir = join(root(), `asks-${terminalKind}`);
      const signer = authority();
      const store = createAskPersistStore(dir, signer, {
        maxPendingRecords: 2,
        maxTerminalRecords: 1,
      });
      const first = signedAsk('s1-controller', terminalKind);
      const second = signedAsk('hook', `blocked-${terminalKind}`);
      expect(store.commitSigned(first, 0)).toBe(1);
      expect(() => store.commitSigned(second, 0)).toThrow(AskPersistCapacityError);

      if (terminalKind === 'answered') {
        const { result, receipt } = signedAnswer(signer, first);
        expect(store.commitTerminalSigned({
          ask: first, expectedRevision: 1, answeredResult: result, receipt,
          now: BASE_TIME + 1_000,
          recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
        })).toEqual({ revision: 2 });
        expect(files(dir).outboxes).toHaveLength(1);
      } else {
        expect(store.terminalizeSigned({
          ask: first,
          expectedRevision: 1,
          result: { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true },
          now: BASE_TIME + 1_000,
          recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
        })).toEqual({ revision: 2 });
      }
    }
  });

  it('sweeps a filename-mismatched outbox before reserving terminal capacity', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const store = createAskPersistStore(dir, signer, {
      maxPendingRecords: 2,
      maxTerminalRecords: 1,
    });
    const outboxDir = join(dir, 'terminal-receipts');
    mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
    for (const [name, contents] of [
      [`${'a'.repeat(64)}.json`, JSON.stringify({ askKey: 'different-key' })],
      [`${'b'.repeat(64)}.json`, JSON.stringify({})],
      [`${'c'.repeat(64)}.json`, JSON.stringify({ askKey: 1 })],
      [`${'d'.repeat(64)}.json`, JSON.stringify([])],
    ] as const) {
      writeFileSync(join(outboxDir, name), contents, { mode: 0o600 });
    }

    const ask = signedAsk('s1-controller', 'after-malformed-outbox');
    expect(store.commitSigned(ask, 0)).toBe(1);
    expect(files(dir).outboxes).toEqual([]);
    const { result, receipt } = signedAnswer(signer, ask);
    expect(store.commitTerminalSigned({
      ask, expectedRevision: 1, answeredResult: result, receipt,
      now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    })).toEqual({ revision: 2 });
    expect(files(dir).outboxes).toHaveLength(1);
  });

  it('sweeps an oversized owner-0600 orphan outbox so admission can recover', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const store = createAskPersistStore(dir, signer, {
      maxPendingRecords: 1,
      maxTerminalRecords: 1,
    });
    const outboxDir = join(dir, 'terminal-receipts');
    mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
    const oversized = join(outboxDir, `${'e'.repeat(64)}.json`);
    writeFileSync(oversized, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });

    expect(store.commitSigned(signedAsk('s1-controller', 'after-oversized'), 0)).toBe(1);
    expect(existsSync(oversized)).toBe(false);
  });

  it('retries joint expiry cleanup after exact EACCES failures', () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const ask = signedAsk();
    const store = createAskPersistStore(dir, signer);
    store.commitSigned(ask, 0);
    const { result, receipt } = signedAnswer(signer, ask);
    store.commitTerminalSigned({
      ask, expectedRevision: 1, answeredResult: result, receipt, now: BASE_TIME + 1_000,
      recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
    });

    const outboxFailure = createAskPersistStore(dir, signer, { faultInjection: 'unlink_outbox_eacces' });
    expect(() => outboxFailure.sweep(BASE_TIME + 1_000 + HANDOFF_RETENTION_MS))
      .toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(files(dir)).toMatchObject({ states: [expect.any(String)], outboxes: [expect.any(String)] });

    const stateFailure = createAskPersistStore(dir, signer, { faultInjection: 'unlink_state_eacces' });
    expect(() => stateFailure.sweep(BASE_TIME + 1_000 + HANDOFF_RETENTION_MS))
      .toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(files(dir).states).toHaveLength(1);
    expect(files(dir).outboxes).toHaveLength(0);
    expect(store.sweep(BASE_TIME + 1_000 + HANDOFF_RETENTION_MS)).toEqual({ removedStates: 1, removedOutboxes: 0 });
  });

  it.runIf(process.platform === 'linux')(
    'pins one store-root inode across a hostile pathname swap during commit and sweep',
    () => {
      const parent = root();
      chmodSync(parent, 0o777);
      const dir = join(parent, 'asks');
      const moved = join(parent, 'asks-original');
      const signer = authority();
      const ask = signedAsk();
      createAskPersistStore(dir, signer).commitSigned(ask, 0);
      const { result, receipt } = signedAnswer(signer, ask);
      let swapped = false;
      const swappingStore = createAskPersistStore(dir, signer, {
        faultInjection(point) {
          if (point !== 'after_root_pin' || swapped) return;
          swapped = true;
          renameSync(dir, moved);
          mkdirSync(dir, { mode: 0o700 });
          mkdirSync(join(dir, 'terminal-receipts'), { mode: 0o700 });
        },
      });
      expect(swappingStore.commitTerminalSigned({
        ask, expectedRevision: 1, answeredResult: result, receipt, now: BASE_TIME + 1_000,
        recoverUntil: BASE_TIME + 1_000 + HANDOFF_RETENTION_MS,
      })).toEqual({ revision: 2 });
      expect(files(dir)).toEqual({ states: [], outboxes: [] });
      expect(files(moved)).toMatchObject({ states: [expect.any(String)], outboxes: [expect.any(String)] });

      const pinnedOriginal = createAskPersistStore(moved, signer);
      expect(pinnedOriginal.recoverTerminalReceipt(recoverInput(ask)).ok).toBe(true);

      const movedAgain = join(parent, 'asks-original-again');
      let sweepSwapped = false;
      const sweepingStore = createAskPersistStore(moved, signer, {
        faultInjection(point) {
          if (point !== 'after_root_pin' || sweepSwapped) return;
          sweepSwapped = true;
          renameSync(moved, movedAgain);
          mkdirSync(moved, { mode: 0o700 });
          mkdirSync(join(moved, 'terminal-receipts'), { mode: 0o700 });
        },
      });
      expect(sweepingStore.sweep(BASE_TIME + 1_000 + HANDOFF_RETENTION_MS))
        .toEqual({ removedStates: 1, removedOutboxes: 1 });
      expect(files(moved)).toEqual({ states: [], outboxes: [] });
      expect(files(movedAgain)).toEqual({ states: [], outboxes: [] });
    },
  );

  it('serializes concurrent compare-and-swap across child processes', async () => {
    const dir = join(root(), 'asks');
    const signer = authority();
    const ask = signedAsk('hook', 'cross-process');
    const store = createAskPersistStore(dir, signer);
    expect(store.commitSigned(ask, 0)).toBe(1);

    const source = `
      import { createAskPersistStore } from './src/core/ask-persist-store.js';
      import { createAskReceiptSigner } from './src/daemon/ask-receipt-authority.js';
      import { createPrivateKey, createPublicKey } from 'node:crypto';
      const ask = JSON.parse(process.env.ATOMIC_ASK);
      const privateKey = createPrivateKey({ key: Buffer.from(process.env.ATOMIC_PRIVATE, 'base64url'), format: 'der', type: 'pkcs8' });
      const publicKey = createPublicKey(privateKey);
      const signer = createAskReceiptSigner({ privateKey, publicKey, signerInstanceId: 'atomic-child' });
      const store = createAskPersistStore(process.env.ATOMIC_DIR, signer);
      process.send?.('ready');
      await new Promise((resolve) => process.once('message', resolve));
      try { console.log(JSON.stringify({ ok: true, revision: store.commitSigned(ask, 1) })); }
      catch (error) { console.log(JSON.stringify({ ok: false, code: error.code })); }
    `;
    // The production authority deliberately does not expose private material.
    // Use an independently exportable pair for this process-level lock test.
    const pair = generateKeyPairSync('ed25519');
    const sharedSigner = createAskReceiptSigner({
      privateKey: pair.privateKey, publicKey: pair.publicKey, signerInstanceId: 'atomic-child',
    });
    const sharedDir = join(root(), 'asks');
    const sharedAsk = signedAsk('hook', 'children');
    createAskPersistStore(sharedDir, sharedSigner).commitSigned(sharedAsk, 0);
    const env = {
      ...process.env, ATOMIC_DIR: sharedDir, ATOMIC_ASK: JSON.stringify({ ...sharedAsk, selections: [['yes']] }),
      ATOMIC_PRIVATE: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    };
    const children = [0, 1].map(() => spawnTsEvalWithRepoImports(source, {
      cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }));
    await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
    })));
    children.forEach((child) => child.send('go'));
    const outcomes = await Promise.all(children.map((child) => new Promise<{ status: number; stdout: string }>((resolve) => {
      let stdout = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
      child.once('exit', (code) => resolve({ status: code ?? -1, stdout }));
    })));
    expect(outcomes.map((outcome) => outcome.status)).toEqual([0, 0]);
    expect(outcomes.map((outcome) => JSON.parse(outcome.stdout)).sort((left, right) => Number(right.ok) - Number(left.ok)))
      .toEqual([{ ok: true, revision: 2 }, { ok: false, code: 'ASK_REVISION_CONFLICT' }]);
  });
});
