import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendReleaseJournalEvent,
  createReleaseTransaction,
  inspectReleaseTransaction,
  type ReleaseTransactionRequest,
} from '../src/services/release-transaction-store.js';

const roots: string[] = [];

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-release-store-'));
  roots.push(root);
  return join(root, 'data');
}

function request(transactionId = 'tx-0123456789abcdef'): ReleaseTransactionRequest {
  return {
    schemaVersion: 1,
    transactionId,
    repoKey: 'a'.repeat(64),
    barrierId: 'barrier-1',
    barrierRevision: 7,
    authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c',
    operationId: 'op-1',
    commitSha: 'b'.repeat(40),
    treeSha: 'c'.repeat(40),
    artifactPath: '/srv/botmux-next',
    artifactTreeHash: 'd'.repeat(64),
    rollbackArtifactPath: '/srv/botmux-rollback',
    rollbackTreeHash: 'e'.repeat(64),
    targetRuntimeHash: 'f'.repeat(64),
    oldRuntimeHash: '1'.repeat(64),
    requiredChecksHash: '2'.repeat(64),
    independentReviewHash: '3'.repeat(64),
    deploymentPath: '/srv/botmux',
    unit: 'botmux.service',
    host: 'release-host',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release transaction durable store', () => {
  it('requires checks and independent review evidence hashes in the immutable request', () => {
    const dataDir = tempDataDir();
    const input = request();

    expect(() => createReleaseTransaction(dataDir, input)).not.toThrow();
    expect(() => createReleaseTransaction(dataDir, {
      ...input,
      transactionId: 'tx-missing-evidence-hash',
      independentReviewHash: undefined,
    } as unknown as ReleaseTransactionRequest)).toThrow('release_transaction_request_invalid');
  });

  it('creates an immutable request before the first prepared journal event', () => {
    const dataDir = tempDataDir();
    const input = request();
    try {
      createReleaseTransaction(dataDir, input);
    } catch {
      // A signature-only seam is setup, not the RED. The assertions below
      // identify the missing durable behavior.
    }

    const directory = join(dataDir, 'deployments', input.transactionId);
    expect(existsSync(join(directory, 'request.json'))).toBe(true);
    expect(existsSync(join(directory, 'journal.ndjson'))).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'))).toEqual(input);
  });

  it('rejects request replacement or transactionId input drift', () => {
    const dataDir = tempDataDir();
    const input = request();
    const first = createReleaseTransaction(dataDir, input);
    expect(createReleaseTransaction(dataDir, structuredClone(input))).toEqual(first);
    expect(() => createReleaseTransaction(dataDir, { ...input, treeSha: '9'.repeat(40) }))
      .toThrow('release_transaction_request_conflict');
  });

  it('chains every journal entry to the previous hash and sequence', () => {
    const dataDir = tempDataDir();
    const input = request();
    createReleaseTransaction(dataDir, input);
    const first = appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:00.000Z', type: 'prepared', phase: 'prepare',
    });
    const second = appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:01.000Z', type: 'intent', phase: 'commit', action: 'restart',
    });
    expect(first).toMatchObject({ sequence: 1, previousHash: null });
    expect(second).toMatchObject({ sequence: 2, previousHash: first.hash });
    expect(second.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rebuilds receipt from a valid journal after projection write interruption', () => {
    const dataDir = tempDataDir();
    const input = request();
    createReleaseTransaction(dataDir, input);
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:00.000Z', type: 'prepared', phase: 'prepare',
    });
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:01.000Z', type: 'terminal', phase: 'verify',
      details: { status: 'verified' },
    });
    const receiptPath = join(dataDir, 'deployments', input.transactionId, 'receipt.json');
    if (existsSync(receiptPath)) unlinkSync(receiptPath);

    const rebuilt = inspectReleaseTransaction(dataDir, input.transactionId);
    expect(rebuilt).toMatchObject({ transactionId: input.transactionId, status: 'verified', journalLength: 2 });
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(rebuilt);
  });

  it('marks a broken or truncated journal unknown without inventing success', () => {
    const dataDir = tempDataDir();
    const input = request();
    createReleaseTransaction(dataDir, input);
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:00.000Z', type: 'terminal', phase: 'verify',
      details: { status: 'verified' },
    });
    const journalPath = join(dataDir, 'deployments', input.transactionId, 'journal.ndjson');
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}not-json`, { mode: 0o600 });

    expect(inspectReleaseTransaction(dataDir, input.transactionId)).toMatchObject({ status: 'unknown' });
  });

  it('rejects symlink receipt paths and wrong modes', () => {
    if (process.platform === 'win32') return;
    const dataDir = tempDataDir();
    const input = request();
    createReleaseTransaction(dataDir, input);
    const directory = join(dataDir, 'deployments', input.transactionId);
    const receiptPath = join(directory, 'receipt.json');
    const victim = join(dataDir, 'victim');
    writeFileSync(victim, 'keep', { mode: 0o600 });
    symlinkSync(victim, receiptPath);
    expect(() => inspectReleaseTransaction(dataDir, input.transactionId)).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('keep');

    unlinkSync(receiptPath);
    writeFileSync(receiptPath, '{}', { mode: 0o644 });
    chmodSync(receiptPath, 0o644);
    expect(() => inspectReleaseTransaction(dataDir, input.transactionId)).toThrow(/0600/);
  });

  it('redacts secrets tokens and full environment values from every persisted record', () => {
    const dataDir = tempDataDir();
    const input = request();
    createReleaseTransaction(dataDir, input);
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:00.000Z', type: 'prepared', phase: 'prepare',
      details: {
        apiToken: 'token-value-must-not-persist',
        password: 'password-value-must-not-persist',
        env: { PRIVATE_KEY: 'private-value-must-not-persist', PATH: '/bin' },
        safe: 'kept',
      },
    });
    const directory = join(dataDir, 'deployments', input.transactionId);
    const persisted = ['request.json', 'journal.ndjson', 'receipt.json']
      .filter(name => existsSync(join(directory, name)))
      .map(name => readFileSync(join(directory, name), 'utf8'))
      .join('\n');
    expect(persisted).not.toContain('token-value-must-not-persist');
    expect(persisted).not.toContain('password-value-must-not-persist');
    expect(persisted).not.toContain('private-value-must-not-persist');
    expect(persisted).not.toContain('/bin');
    expect(persisted).toContain('kept');
  });
});
