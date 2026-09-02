/**
 * Crash-durable, app-scoped replay fence for Ask card callback event IDs.
 * This is an authorization gate: every storage failure is fail-closed.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { logger } from '../utils/logger.js';
import { ASK_RECEIPT_TTL_MS, type AskReceiptEventClaimResult } from '../core/ask-receipt.js';
import { ASK_MAX_TIMEOUT_MS } from '../core/ask-limits.js';
import { withSecureHostParent } from '../platform/secure-host-file.js';

/** Covers the maximum supported 24h Ask lifetime plus the 5m receipt window. */
export const ASK_CARD_EVENT_CLAIM_TTL_MS = ASK_MAX_TIMEOUT_MS + ASK_RECEIPT_TTL_MS;
export const ASK_CARD_EVENT_CLAIM_MAX_ENTRIES = 5_000;
export const ASK_CARD_EVENT_CLAIM_LOCK_WAIT_MS = 1_500;
// Large enough for the hard 5,000-entry ceiling even when every bounded ID is
// at its maximum encoded length.
const ASK_CARD_EVENT_CLAIM_MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_APP_ID_BYTES = 256;
const MAX_EVENT_ID_BYTES = 512;
const MAX_INSTANCE_ID_BYTES = 256;
const MAX_SERIALIZED_CLAIM_BYTES = 1_000;
const STORE_VERSION = 1 as const;

interface ClaimEntry {
  eventId: string;
  bindingDigest: string;
  ownerInstanceId: string;
  state: 'processing' | 'completed';
  expiresAt: number;
}
interface ClaimFile { version: typeof STORE_VERSION; larkAppId: string; claims: ClaimEntry[] }

export interface AskCardEventClaimStore {
  claim(larkAppId: string, eventId: string, bindingDigest: string, now?: number): Promise<AskReceiptEventClaimResult>;
  complete(larkAppId: string, eventId: string, bindingDigest: string, now?: number): Promise<AskReceiptEventClaimResult>;
}

function fileFor(dir: string, larkAppId: string): string {
  return join(dir, `${createHash('sha256').update(larkAppId).digest('hex')}.json`);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && /^[A-Za-z0-9._:-]+$/.test(value)
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isValidClaimInput(
  larkAppId: string,
  eventId: string,
  bindingDigest: string,
  now: number,
): boolean {
  return boundedText(larkAppId, MAX_APP_ID_BYTES)
    && boundedText(eventId, MAX_EVENT_ID_BYTES)
    && /^[a-f0-9]{64}$/.test(bindingDigest)
    && Number.isSafeInteger(now)
    && now >= 0
    && now <= Number.MAX_SAFE_INTEGER - ASK_CARD_EVENT_CLAIM_TTL_MS;
}

function parseState(raw: string | null, larkAppId: string, now: number): ClaimFile {
  if (raw === null) return { version: STORE_VERSION, larkAppId, claims: [] };
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error('invalid claim store');
  const state = parsed as Partial<ClaimFile>;
  if (!exactKeys(state, ['version', 'larkAppId', 'claims'])
      || state.version !== STORE_VERSION
      || !boundedText(state.larkAppId, MAX_APP_ID_BYTES)
      || state.larkAppId !== larkAppId || !Array.isArray(state.claims)
      || state.claims.length > ASK_CARD_EVENT_CLAIM_MAX_ENTRIES) throw new Error('invalid claim store');
  const eventIds = new Set<string>();
  for (const claim of state.claims) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)
        || Object.getPrototypeOf(claim) !== Object.prototype
        || !exactKeys(claim, ['eventId', 'bindingDigest', 'ownerInstanceId', 'state', 'expiresAt'])
        || !boundedText(claim.eventId, MAX_EVENT_ID_BYTES)
        || typeof claim.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(claim.bindingDigest)
        || !boundedText(claim.ownerInstanceId, MAX_INSTANCE_ID_BYTES)
        || (claim.state !== 'processing' && claim.state !== 'completed')
        || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt < 0
        || claim.expiresAt > now + ASK_CARD_EVENT_CLAIM_TTL_MS) {
      throw new Error('invalid claim entry');
    }
    if (eventIds.has(claim.eventId)) throw new Error('duplicate claim entry');
    eventIds.add(claim.eventId);
  }
  return state as ClaimFile;
}

function liveClaims(state: ClaimFile, now: number): ClaimEntry[] {
  return state.claims.filter((claim) => claim.expiresAt > now);
}

function serializeState(larkAppId: string, claims: ClaimEntry[]): string {
  const encoded = JSON.stringify({ version: STORE_VERSION, larkAppId, claims }) + '\n';
  if (Buffer.byteLength(encoded, 'utf8') > ASK_CARD_EVENT_CLAIM_MAX_STORE_BYTES) {
    throw new Error('claim store exceeds maximum size');
  }
  return encoded;
}

export function createAskCardEventClaimStore(
  dir: string,
  options: { instanceId: string; maxEntries?: number; maxWaitMs?: number },
): AskCardEventClaimStore {
  if (!boundedText(options.instanceId, MAX_INSTANCE_ID_BYTES)) {
    throw new Error('Ask card event claim instance id is invalid');
  }
  const maxEntries = options.maxEntries ?? ASK_CARD_EVENT_CLAIM_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1
      || maxEntries > ASK_CARD_EVENT_CLAIM_MAX_ENTRIES) {
    throw new Error(`Ask card event claim capacity must be in [1, ${ASK_CARD_EVENT_CLAIM_MAX_ENTRIES}]`);
  }
  if (maxEntries * MAX_SERIALIZED_CLAIM_BYTES > ASK_CARD_EVENT_CLAIM_MAX_STORE_BYTES) {
    throw new Error('Ask card event claim capacity exceeds the durable store byte budget');
  }
  const maxWaitMs = options.maxWaitMs ?? ASK_CARD_EVENT_CLAIM_LOCK_WAIT_MS;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0
      || maxWaitMs > ASK_CARD_EVENT_CLAIM_LOCK_WAIT_MS) {
    throw new Error(`Ask card event claim lock wait must be in [0, ${ASK_CARD_EVENT_CLAIM_LOCK_WAIT_MS}]`);
  }
  return {
    async claim(larkAppId, eventId, bindingDigest, now = Date.now()) {
      if (!isValidClaimInput(larkAppId, eventId, bindingDigest, now)) {
        return { ok: false, reason: 'invalid_event_id' };
      }
      const file = fileFor(dir, larkAppId);
      try {
        return await withSecureHostParent(file, async (hostFile) => hostFile.withLeafLock(async () => {
          const live = liveClaims(parseState(
            await hostFile.readLeaf(ASK_CARD_EVENT_CLAIM_MAX_STORE_BYTES), larkAppId, now,
          ), now);
          const existing = live.find((claim) => claim.eventId === eventId);
          if (existing) {
            if (existing.bindingDigest !== bindingDigest) {
              return { ok: false, reason: 'binding_mismatch' } as const;
            }
            // Strict at-most-once: a processing claim is as irreversible as a
            // completed one. A crash after claim can lose the callback, but a
            // redelivery may never repeat a toggle or settlement side effect.
            return { ok: false, reason: 'duplicate' } as const;
          }
          // Never evict a live replay fence merely to make room: that would turn
          // load into an authorization bypass. Capacity exhaustion fails closed
          // until the oldest claim expires.
          if (live.length >= maxEntries) {
            return { ok: false, reason: 'capacity_exhausted' } as const;
          }
          live.push({
            eventId, bindingDigest, ownerInstanceId: options.instanceId, state: 'processing',
            expiresAt: now + ASK_CARD_EVENT_CLAIM_TTL_MS,
          });
          await hostFile.writeLeaf(
            serializeState(larkAppId, live), ASK_CARD_EVENT_CLAIM_MAX_STORE_BYTES,
          );
          return { ok: true, recovered: false } as const;
        }, { maxWaitMs }), { exactParentMode: 0o700 });
      } catch (error) {
        logger.warn(`[ask-card-event-claim] fail-closed for app=${larkAppId}: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, reason: 'storage_error' };
      }
    },
    async complete(larkAppId, eventId, bindingDigest, now = Date.now()) {
      if (!isValidClaimInput(larkAppId, eventId, bindingDigest, now)) {
        return { ok: false, reason: 'invalid_event_id' };
      }
      const file = fileFor(dir, larkAppId);
      try {
        return await withSecureHostParent(file, async (hostFile) => hostFile.withLeafLock(async () => {
          const live = liveClaims(parseState(
            await hostFile.readLeaf(ASK_CARD_EVENT_CLAIM_MAX_STORE_BYTES), larkAppId, now,
          ), now);
          const claim = live.find((entry) => entry.eventId === eventId);
          if (!claim || claim.state === 'completed') return { ok: false, reason: 'duplicate' } as const;
          if (claim.bindingDigest !== bindingDigest) return { ok: false, reason: 'binding_mismatch' } as const;
          if (claim.ownerInstanceId !== options.instanceId) return { ok: false, reason: 'duplicate' } as const;
          claim.state = 'completed';
          await hostFile.writeLeaf(
            serializeState(larkAppId, live), ASK_CARD_EVENT_CLAIM_MAX_STORE_BYTES,
          );
          return { ok: true, recovered: false } as const;
        }, { maxWaitMs }), { exactParentMode: 0o700 });
      } catch (error) {
        logger.warn(`[ask-card-event-claim] completion failed closed for app=${larkAppId}: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, reason: 'storage_error' };
      }
    },
  };
}
