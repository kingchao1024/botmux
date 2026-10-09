import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export type ScheduleRuntimeStateKind =
  | 'patrol'
  | 'human-action'
  | 'coordinator-action'
  | 'delivery';

export interface ScheduleRuntimeStateSnapshot {
  kind: ScheduleRuntimeStateKind;
  chatId: string;
  path: string;
  sha256: string;
  state: Record<string, unknown> | null;
}

export interface WriteScheduleRuntimeStateInput {
  kind: ScheduleRuntimeStateKind;
  chatId: string;
  expectedSha256: string;
  next: unknown;
  dataDir?: string;
  now?: () => string;
}

export type WriteScheduleRuntimeStateResult = ScheduleRuntimeStateSnapshot;

const CHAT_ID_RE = /^oc_[A-Za-z0-9]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const DELIVERY_STATUSES = new Set(['sending', 'sent', 'delivered', 'delivery_failed']);

function statePath(kind: ScheduleRuntimeStateKind, chatId: string, dataDir: string): string {
  if (!CHAT_ID_RE.test(chatId)) throw new Error('invalid_chat_id');
  switch (kind) {
    case 'patrol':
      return join(dataDir, 'production-loop-watch-state.json');
    case 'human-action':
      return join(dataDir, 'human-action-watch', `${chatId}.json`);
    case 'coordinator-action':
      return join(dataDir, 'coordinator-action-watch', `${chatId}.json`);
    case 'delivery':
      return join(dataDir, 'schedule-delivery-watch', `${chatId}.json`);
  }
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function readRaw(path: string): string | null {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(fd);
    const pathStat = lstatSync(path);
    if (!before.isFile() || pathStat.isSymbolicLink()
      || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      throw new Error('unsafe_state_path');
    }
    if (before.size > MAX_STATE_BYTES) throw new Error('state_too_large');
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error('state_changed_while_reading');
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('unsafe_state_path');
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseRawState(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid_state_json:${path}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertIso(value: unknown, field: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid_${field}`);
  }
}

function validateItems(items: unknown): void {
  if (!Array.isArray(items)) throw new Error('invalid_items');
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.fingerprint !== 'string' || !item.fingerprint.trim()) {
      throw new Error('invalid_fingerprint');
    }
    if (seen.has(item.fingerprint)) throw new Error('duplicate_fingerprint');
    seen.add(item.fingerprint);
    if (typeof item.status !== 'string' || !item.status.trim()) throw new Error('invalid_item_status');
  }
}

function validateStringList(value: unknown, field: string, unique = false): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`invalid_${field}`);
  }
  const items = value as string[];
  if (unique && new Set(items).size !== items.length) throw new Error(`duplicate_${field}`);
  return items;
}

function deliveryRunAtMs(hourlyTaskId: string, runKey: string): number {
  const prefix = `${hourlyTaskId}:`;
  if (!runKey.startsWith(prefix)) throw new Error('invalid_run_key');
  const runAt = runKey.slice(prefix.length);
  const runAtMs = Date.parse(runAt);
  if (!Number.isFinite(runAtMs) || new Date(runAtMs).toISOString() !== runAt) {
    throw new Error('invalid_run_key');
  }
  return runAtMs;
}

function validateState(
  kind: ScheduleRuntimeStateKind,
  chatId: string,
  value: unknown,
  updatedAt?: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('state_must_be_object');
  const next = structuredClone(value);
  if (next.schemaVersion !== 1) throw new Error('invalid_schema_version');
  if (next.chatId !== chatId) throw new Error('chat_id_mismatch');

  if (kind === 'patrol') {
    if (!Array.isArray(next.keyTopics)) throw new Error('invalid_key_topics');
    const notes = validateStringList(next.notes, 'patrol_note');
    if (notes.length > 30) throw new Error('patrol_notes_limit');
    validateStringList(next.notifiedFingerprints, 'patrol_fingerprint', true);
    if (updatedAt !== undefined) next.updatedAt = updatedAt;
    assertIso(next.updatedAt, 'updated_at');
  } else if (kind === 'human-action' || kind === 'coordinator-action') {
    validateItems(next.items);
    if (updatedAt !== undefined) next.updatedAt = updatedAt;
    assertIso(next.updatedAt, 'updated_at');
  } else {
    if (typeof next.hourlyTaskId !== 'string' || !next.hourlyTaskId.trim()) {
      throw new Error('invalid_hourly_task_id');
    }
    if (typeof next.runKey !== 'string') {
      throw new Error('invalid_run_key');
    }
    deliveryRunAtMs(next.hourlyTaskId, next.runKey);
    if (typeof next.status !== 'string' || !DELIVERY_STATUSES.has(next.status)) {
      throw new Error('invalid_delivery_status');
    }
    if (next.status === 'sending' && next.messageId !== null) {
      throw new Error('delivery_sending_message_must_be_null');
    }
    if (next.status === 'delivery_failed'
      && next.messageId !== null
      && (typeof next.messageId !== 'string' || !next.messageId.startsWith('om_'))) {
      throw new Error('delivery_failed_message_invalid');
    }
    if ((next.status === 'sent' || next.status === 'delivered')
      && (typeof next.messageId !== 'string' || !next.messageId.startsWith('om_'))) {
      throw new Error('delivery_message_required');
    }
    if (next.status === 'delivered') assertIso(next.deliveryVerifiedAt, 'delivery_verified_at');
    if (next.claimedAt !== undefined && next.claimedAt !== null) assertIso(next.claimedAt, 'claimed_at');
  }
  return next;
}

function itemMap(state: Record<string, unknown>): Map<string, Record<string, unknown>> {
  return new Map((state.items as Record<string, unknown>[]).map(item => [item.fingerprint as string, item]));
}

function validateTransition(
  kind: ScheduleRuntimeStateKind,
  current: Record<string, unknown> | null,
  next: Record<string, unknown>,
): void {
  if (!current) {
    if (kind === 'delivery' && (next.status !== 'sending' || next.messageId !== null)) {
      throw new Error('delivery_initial_state_invalid');
    }
    return;
  }
  if (kind === 'human-action' || kind === 'coordinator-action') {
    const before = itemMap(current);
    const after = itemMap(next);
    for (const [fingerprint, item] of before) {
      const replacement = after.get(fingerprint);
      if (!replacement) throw new Error(`ledger_item_removed:${fingerprint}`);
      if (item.firstSeenAt !== undefined && replacement.firstSeenAt !== item.firstSeenAt) {
        throw new Error(`ledger_first_seen_changed:${fingerprint}`);
      }
    }
    return;
  }
  if (kind === 'patrol') {
    const before = new Set(current.notifiedFingerprints as unknown[]);
    const after = new Set(next.notifiedFingerprints as unknown[]);
    for (const fingerprint of before) {
      if (!after.has(fingerprint)) throw new Error(`patrol_fingerprint_removed:${String(fingerprint)}`);
    }
    return;
  }

  if (current.hourlyTaskId !== next.hourlyTaskId) throw new Error('delivery_task_changed');
  if (current.runKey !== next.runKey) {
    if (deliveryRunAtMs(next.hourlyTaskId as string, next.runKey as string)
      <= deliveryRunAtMs(current.hourlyTaskId as string, current.runKey as string)) {
      throw new Error('delivery_run_not_newer');
    }
    if (next.status !== 'sending' || next.messageId !== null) {
      throw new Error('delivery_new_run_must_start_sending');
    }
    return;
  }
  if (next.claimedAt !== current.claimedAt) {
    throw new Error('delivery_claimed_at_changed');
  }
  const currentStatus = current.status as string;
  const nextStatus = next.status as string;
  if (currentStatus === 'delivered') {
    throw new Error('delivery_already_delivered');
  }
  if (currentStatus === 'sending' && nextStatus === 'sending') {
    throw new Error('delivery_already_claimed');
  }
  if (currentStatus === 'delivery_failed' && nextStatus === 'sending'
    && current.messageId !== null) {
    throw new Error('delivery_retry_message_exists');
  }
  const allowed: Record<string, readonly string[]> = {
    sending: ['sending', 'sent', 'delivery_failed'],
    sent: ['sent', 'delivered', 'delivery_failed'],
    delivery_failed: ['sending', 'delivery_failed', 'delivered'],
    delivered: ['delivered'],
  };
  if (!(allowed[currentStatus] ?? []).includes(nextStatus)) {
    throw new Error(`delivery_transition_invalid:${currentStatus}:${nextStatus}`);
  }
  if (current.messageId === null && typeof next.messageId === 'string'
    && (currentStatus !== 'sending'
      || (nextStatus !== 'sent' && nextStatus !== 'delivery_failed'))) {
    throw new Error('delivery_message_introduction_invalid');
  }
  if (typeof current.messageId === 'string' && next.messageId !== current.messageId) {
    throw new Error('delivery_message_changed');
  }
}

export function readScheduleRuntimeState(
  kind: ScheduleRuntimeStateKind,
  chatId: string,
  dataDir: string = config.session.dataDir,
): ScheduleRuntimeStateSnapshot {
  const path = statePath(kind, chatId, dataDir);
  const raw = readRaw(path);
  if (raw === null) return { kind, chatId, path, sha256: 'missing', state: null };
  const state = validateState(kind, chatId, parseRawState(path, raw));
  return { kind, chatId, path, sha256: sha256(raw), state };
}

export function writeScheduleRuntimeState(
  input: WriteScheduleRuntimeStateInput,
): WriteScheduleRuntimeStateResult {
  if (input.expectedSha256 !== 'missing' && !SHA256_RE.test(input.expectedSha256)) {
    throw new Error('invalid_expected_sha256');
  }
  const dataDir = input.dataDir ?? config.session.dataDir;
  const path = statePath(input.kind, input.chatId, dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLockSync(path, () => {
    const currentRaw = readRaw(path);
    const currentSha256 = currentRaw === null ? 'missing' : sha256(currentRaw);
    if (currentSha256 !== input.expectedSha256) {
      throw new Error(`state_changed:${currentSha256}`);
    }
    const current = currentRaw === null
      ? null
      : validateState(input.kind, input.chatId, parseRawState(path, currentRaw));
    const next = validateState(input.kind, input.chatId, input.next, (input.now ?? (() => new Date().toISOString()))());
    validateTransition(input.kind, current, next);
    const raw = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) throw new Error('state_too_large');
    atomicWriteFileSync(path, raw, { mode: 0o600, durable: true, followTargetSymlink: false });
    return {
      kind: input.kind,
      chatId: input.chatId,
      path,
      sha256: sha256(raw),
      state: next,
    };
  });
}

export function isProjectActive(
  chatId: string,
  dataDir: string = config.session.dataDir,
): boolean {
  if (!CHAT_ID_RE.test(chatId)) throw new Error('invalid_chat_id');
  const path = join(dataDir, 'project-groups.json');
  const raw = readRaw(path);
  if (raw === null) throw new Error('project_state_missing');
  const parsed = parseRawState(path, raw);
  if (!isRecord(parsed) || !isRecord(parsed.projects)) throw new Error('invalid_project_state');
  const project = parsed.projects[chatId];
  if (project === undefined) return false;
  if (!isRecord(project) || typeof project.status !== 'string') throw new Error('invalid_project_entry');
  return project.status === 'active';
}
