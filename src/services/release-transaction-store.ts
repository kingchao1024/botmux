export type ReleaseTerminalStatus = 'verified' | 'rolled_back' | 'rollback_failed' | 'unknown';

export interface ReleaseTransactionRequest {
  schemaVersion: 1;
  transactionId: string;
  repoKey: string;
  barrierId: string;
  barrierRevision: number;
  authorizationRef: string;
  operationId: string;
  commitSha: string;
  treeSha: string;
  artifactPath: string;
  artifactTreeHash: string;
  rollbackArtifactPath: string;
  rollbackTreeHash: string;
  targetRuntimeHash: string;
  oldRuntimeHash: string;
  requiredChecksHash: string;
  independentReviewHash: string;
  deploymentPath: string;
  unit: string;
  host: string;
}

export interface ReleaseJournalEventInput {
  at: string;
  type: string;
  phase: 'prepare' | 'commit' | 'verify' | 'rollback';
  action?: string;
  details?: Record<string, unknown>;
}

export interface ReleaseJournalEvent extends ReleaseJournalEventInput {
  sequence: number;
  previousHash: string | null;
  hash: string;
}

export interface ReleaseTransactionReceipt {
  schemaVersion: 1;
  transactionId: string;
  requestHash: string;
  journalHeadHash: string | null;
  journalLength: number;
  status: ReleaseTerminalStatus | 'in_progress';
  restartCount: number;
  renameCount: number;
  events: ReleaseJournalEvent[];
  residualEvidence?: Record<string, unknown>;
}

const MAX_TRANSACTION_FILE_BYTES = 16 * 1024 * 1024;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const REQUEST_KEYS = [
  'schemaVersion', 'transactionId', 'repoKey', 'barrierId', 'barrierRevision',
  'authorizationRef', 'operationId', 'commitSha', 'treeSha', 'artifactPath',
  'artifactTreeHash', 'rollbackArtifactPath', 'rollbackTreeHash',
  'targetRuntimeHash', 'oldRuntimeHash', 'requiredChecksHash', 'independentReviewHash',
  'deploymentPath', 'unit', 'host',
] as const;

function assertTransactionId(transactionId: string): void {
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error('release_transaction_id_invalid');
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeRequest(value: ReleaseTransactionRequest): ReleaseTransactionRequest {
  const keys = Object.keys(value).sort();
  const expected = [...REQUEST_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)
      || value.schemaVersion !== 1
      || !TRANSACTION_ID_PATTERN.test(value.transactionId)
      || !/^[a-f0-9]{64}$/.test(value.repoKey)
      || !Number.isSafeInteger(value.barrierRevision) || value.barrierRevision < 0
      || !value.barrierId || !value.authorizationRef || !value.operationId
      || !/^[a-f0-9]{40}$/.test(value.commitSha)
      || !/^[a-f0-9]{40}$/.test(value.treeSha)
      || !/^[a-f0-9]{64}$/.test(value.artifactTreeHash)
      || !/^[a-f0-9]{64}$/.test(value.rollbackTreeHash)
      || !/^[a-f0-9]{64}$/.test(value.targetRuntimeHash)
      || !/^[a-f0-9]{64}$/.test(value.oldRuntimeHash)
      || !/^[a-f0-9]{64}$/.test(value.requiredChecksHash)
      || !/^[a-f0-9]{64}$/.test(value.independentReviewHash)
      || !value.artifactPath.startsWith('/')
      || !value.rollbackArtifactPath.startsWith('/')
      || !value.deploymentPath.startsWith('/')
      || !value.unit || !value.host) {
    throw new Error('release_transaction_request_invalid');
  }
  return structuredClone(value);
}

function parseRequest(raw: string | null, transactionId: string): ReleaseTransactionRequest {
  if (raw === null) throw new Error('release_transaction_request_missing');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('release_transaction_request_corrupt'); }
  const request = normalizeRequest(value as ReleaseTransactionRequest);
  if (request.transactionId !== transactionId) throw new Error('release_transaction_request_conflict');
  return request;
}

function redactPersistedValue(value: unknown, key = ''): unknown {
  if (key === 'env' || key === 'environment') {
    const names = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).sort()
      : [];
    return { redacted: true, names };
  }
  if (/(?:secret|token|password|private.?key|credential|cookie)/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redactPersistedValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, redactPersistedValue(child, childKey)]));
  }
  return value;
}

function withTransactionDirectory<R>(
  dataDir: string,
  transactionId: string,
  create: boolean,
  fn: (directory: SecureHostParentHandle) => R,
): R {
  assertTransactionId(transactionId);
  const anchor = join(dataDir, 'deployments', '.release-transactions');
  return withSecureHostParentSync<unknown>(anchor, deployments => {
    const result = deployments.withChildDirectory<unknown>(transactionId, directory =>
      directory.withNamedLeafLock<unknown>('.transaction', () => fn(directory)), {
      create,
      exactMode: 0o700,
    });
    if (result === undefined) throw new Error('release_transaction_not_found');
    return result;
  }, { exactParentMode: 0o700 }) as R;
}

export function withReleaseTransactionExecutionLock<R>(
  dataDir: string,
  transactionId: string,
  fn: () => R,
): R {
  assertTransactionId(transactionId);
  const anchor = join(dataDir, 'deployments', '.release-transactions');
  return withSecureHostParentSync<unknown>(anchor, deployments => {
    const result = deployments.withChildDirectory<unknown>(transactionId, directory =>
      directory.withNamedLeafLock<unknown>('.execution', fn), {
      create: false,
      exactMode: 0o700,
    });
    if (result === undefined) throw new Error('release_transaction_not_found');
    return result;
  }, { exactParentMode: 0o700 }) as R;
}

function parseJournal(raw: string | null): { events: ReleaseJournalEvent[]; corrupt: boolean } {
  if (raw === null || raw === '') return { events: [], corrupt: false };
  if (!raw.endsWith('\n')) return { events: [], corrupt: true };
  const events: ReleaseJournalEvent[] = [];
  try {
    for (const line of raw.slice(0, -1).split('\n')) {
      const event = JSON.parse(line) as ReleaseJournalEvent;
      const { hash, ...unsigned } = event;
      const expectedPrevious = events.at(-1)?.hash ?? null;
      if (!Number.isSafeInteger(event.sequence)
          || event.sequence !== events.length + 1
          || event.previousHash !== expectedPrevious
          || typeof hash !== 'string'
          || hashJson(unsigned) !== hash) return { events: [], corrupt: true };
      events.push(event);
    }
  } catch {
    return { events: [], corrupt: true };
  }
  return { events, corrupt: false };
}

function projectReceipt(
  requestHash: string,
  request: ReleaseTransactionRequest,
  events: ReleaseJournalEvent[],
  corrupt: boolean,
): ReleaseTransactionReceipt {
  const terminal = [...events].reverse().find(event => event.type === 'terminal');
  const requestedStatus = terminal?.details?.status;
  const terminalStatus = ['verified', 'rolled_back', 'rollback_failed', 'unknown'].includes(String(requestedStatus))
    ? requestedStatus as ReleaseTerminalStatus
    : undefined;
  return {
    schemaVersion: 1,
    transactionId: request.transactionId,
    requestHash,
    journalHeadHash: corrupt ? null : events.at(-1)?.hash ?? null,
    journalLength: corrupt ? 0 : events.length,
    status: corrupt ? 'unknown' : terminalStatus ?? 'in_progress',
    restartCount: events.filter(event => event.type === 'result' && event.action === 'restart').length,
    renameCount: events.filter(event => event.type === 'result' && event.action?.startsWith('rename_')).length,
    events: corrupt ? [] : structuredClone(events),
    ...(corrupt ? { residualEvidence: { journal: 'corrupt_or_truncated' } } : {}),
  };
}

export function createReleaseTransaction(
  dataDir: string,
  input: ReleaseTransactionRequest,
): { request: ReleaseTransactionRequest; requestHash: string } {
  const request = normalizeRequest(input);
  return withTransactionDirectory(dataDir, request.transactionId, true, directory => {
    const existingRaw = directory.readNamedLeaf('request.json', MAX_TRANSACTION_FILE_BYTES);
    const requestHash = hashJson(request);
    if (existingRaw !== null) {
      const existing = parseRequest(existingRaw, request.transactionId);
      if (hashJson(existing) !== requestHash) throw new Error('release_transaction_request_conflict');
      return { request: existing, requestHash };
    }
    directory.writeNamedLeaf('request.json', `${JSON.stringify(request, null, 2)}\n`, MAX_TRANSACTION_FILE_BYTES);
    return { request: structuredClone(request), requestHash };
  });
}

export function appendReleaseJournalEvent(
  dataDir: string,
  transactionId: string,
  input: ReleaseJournalEventInput,
): ReleaseJournalEvent {
  return withTransactionDirectory(dataDir, transactionId, false, directory => {
    parseRequest(directory.readNamedLeaf('request.json', MAX_TRANSACTION_FILE_BYTES), transactionId);
    const raw = directory.readNamedLeaf('journal.ndjson', MAX_TRANSACTION_FILE_BYTES);
    const parsed = parseJournal(raw);
    if (parsed.corrupt) throw new Error('release_transaction_journal_corrupt');
    if (!input.at || !input.type || !['prepare', 'commit', 'verify', 'rollback'].includes(input.phase)) {
      throw new Error('release_transaction_event_invalid');
    }
    const unsigned: Omit<ReleaseJournalEvent, 'hash'> = {
      at: input.at,
      type: input.type,
      phase: input.phase,
      ...(input.action ? { action: input.action } : {}),
      ...(input.details ? { details: redactPersistedValue(input.details) as Record<string, unknown> } : {}),
      sequence: parsed.events.length + 1,
      previousHash: parsed.events.at(-1)?.hash ?? null,
    };
    const event: ReleaseJournalEvent = { ...unsigned, hash: hashJson(unsigned) };
    directory.writeNamedLeaf(
      'journal.ndjson',
      `${raw ?? ''}${JSON.stringify(event)}\n`,
      MAX_TRANSACTION_FILE_BYTES,
    );
    return structuredClone(event);
  });
}

export function inspectReleaseTransaction(
  dataDir: string,
  transactionId: string,
): ReleaseTransactionReceipt {
  return withTransactionDirectory(dataDir, transactionId, false, directory => {
    const request = parseRequest(
      directory.readNamedLeaf('request.json', MAX_TRANSACTION_FILE_BYTES),
      transactionId,
    );
    // Validate an existing projection before replacing it. Unsafe symlink or
    // permission shapes must fail closed even though the journal is authoritative.
    directory.readNamedLeaf('receipt.json', MAX_TRANSACTION_FILE_BYTES);
    const journal = parseJournal(directory.readNamedLeaf('journal.ndjson', MAX_TRANSACTION_FILE_BYTES));
    const receipt = projectReceipt(hashJson(request), request, journal.events, journal.corrupt);
    directory.writeNamedLeaf('receipt.json', `${JSON.stringify(receipt, null, 2)}\n`, MAX_TRANSACTION_FILE_BYTES);
    return receipt;
  });
}
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  withSecureHostParentSync,
  type SecureHostParentHandle,
} from '../platform/secure-host-file.js';
