import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { runAskReceiptCommand } from '../src/core/ask-receipt-command.js';
import { askAnswerDigest, askQuestionDigest, askReceiptJti } from '../src/core/ask-receipt.js';
import { createAskReceiptSigner } from '../src/daemon/ask-receipt-authority.js';

function receiptFixture() {
  const pair = generateKeyPairSync('ed25519');
  const signer = createAskReceiptSigner({
    privateKey: pair.privateKey, publicKey: pair.publicKey, signerInstanceId: 'signer-command-test',
  });
  const answers = [['approve']];
  const receipt = signer.sign({
    askId: 'ask-1', larkAppId: 'cli-app', sessionId: 'session-1', chatId: 'oc-chat',
    rootMessageId: 'om-root',
    questionDigest: askQuestionDigest([{ prompt: 'Approve?', options: [
      { key: 'approve', label: 'Approve' }, { key: 'reject', label: 'Reject' },
    ], multiSelect: false }]),
    answerDigest: askAnswerDigest(answers, null), answers, selected: 'approve',
    actor: { kind: 'lark_user', identity: 'ou-reviewer' }, source: 'lark_card',
    platformEventId: 'event-1', cardMessageId: 'om-card', askNonce: 'nonce-1',
    answeredAt: 1_800_000_000_000, expiresAt: 1_800_000_300_000, daemonBootId: 'boot-1',
    jti: askReceiptJti({ larkAppId: 'cli-app', sessionId: 'session-1', askId: 'ask-1', platformEventId: 'event-1', cardMessageId: 'om-card' }),
  });
  return { signer, receipt };
}

describe('ask receipt verify command', () => {
  it('requires an external trust anchor', () => {
    const { receipt } = receiptFixture();
    const result = runAskReceiptCommand(['verify', '-', '--json'], JSON.stringify(receipt));
    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toContain('trust anchor');
  });

  it('verifies stdin with a pinned public key', () => {
    const { signer, receipt } = receiptFixture();
    const result = runAskReceiptCommand([
      'verify', '-', '--public-key', signer.publicKey, '--at', String(receipt.payload.answeredAt), '--json',
    ], JSON.stringify({ receipt }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, expired: false });
  });

  it('rejects a missing value for either trust flag', () => {
    const { receipt } = receiptFixture();
    for (const flag of ['--public-key', '--key-id']) {
      const result = runAskReceiptCommand(['verify', '-', flag], JSON.stringify(receipt));
      expect(result.code).toBe(2);
    }
  });
});
