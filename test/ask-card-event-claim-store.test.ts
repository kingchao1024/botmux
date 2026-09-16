import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ASK_CARD_EVENT_CLAIM_TTL_MS,
  createAskCardEventClaimStore,
} from '../src/services/ask-card-event-claim-store.js';

const roots: string[] = [];
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-ask-card-claim-'));
  roots.push(root);
  return root;
}

function findOnlyStoreFile(dir: string): string {
  const files = readdirSync(dir).filter((entry) => entry.endsWith('.json'));
  expect(files.length).toBe(1);
  return join(dir, files[0]!);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ask-card-event-claim-store', () => {
  it('rejects unsafe option and identifier bounds before touching storage', async () => {
    expect(() => createAskCardEventClaimStore(join(tempRoot(), 'claims'), {
      instanceId: 'boot-a', maxEntries: 5_001,
    })).toThrow(/capacity/);
    expect(() => createAskCardEventClaimStore(join(tempRoot(), 'claims'), {
      instanceId: 'boot-a', maxWaitMs: 1_501,
    })).toThrow(/lock wait/);
    const store = createAskCardEventClaimStore(join(tempRoot(), 'claims'), { instanceId: 'boot-a' });
    await expect(store.claim('a'.repeat(257), 'evt', DIGEST_A, 1_000))
      .resolves.toEqual({ ok: false, reason: 'invalid_event_id' });
    await expect(store.claim('app', 'e'.repeat(513), DIGEST_A, 1_000))
      .resolves.toEqual({ ok: false, reason: 'invalid_event_id' });
    await expect(store.claim('app', 'evt', DIGEST_A, Number.MAX_SAFE_INTEGER))
      .resolves.toEqual({ ok: false, reason: 'invalid_event_id' });
  });

  it('keeps processing and completed claims durable across restart during retention', async () => {
    const dir = join(tempRoot(), '.botmux', 'ask-card-event-claims');
    const now = 1_000;
    const appId = 'cli_a';
    const eventId = 'evt-1';

    const bootA = createAskCardEventClaimStore(dir, { instanceId: 'boot-a' });
    await expect(bootA.claim(appId, eventId, DIGEST_A, now)).resolves.toEqual({ ok: true, recovered: false });

    const bootB = createAskCardEventClaimStore(dir, { instanceId: 'boot-b' });
    await expect(bootB.claim(appId, eventId, DIGEST_A, now + 1)).resolves.toEqual({ ok: false, reason: 'duplicate' });
    await expect(bootB.complete(appId, eventId, DIGEST_A, now + 2)).resolves.toEqual({ ok: false, reason: 'duplicate' });

    await expect(bootA.complete(appId, eventId, DIGEST_A, now + 3)).resolves.toEqual({ ok: true, recovered: false });

    const bootC = createAskCardEventClaimStore(dir, { instanceId: 'boot-c' });
    await expect(bootC.claim(appId, eventId, DIGEST_A, now + 4)).resolves.toEqual({ ok: false, reason: 'duplicate' });
    await expect(bootC.complete(appId, eventId, DIGEST_A, now + 5)).resolves.toEqual({ ok: false, reason: 'duplicate' });
  });

  it('scopes replay fences by app id', async () => {
    const dir = join(tempRoot(), '.botmux', 'ask-card-event-claim-store');
    const store = createAskCardEventClaimStore(dir, { instanceId: 'boot-a' });
    const now = 2_000;

    await expect(store.claim('app-alpha', 'evt-1', DIGEST_A, now)).resolves.toEqual({ ok: true, recovered: false });
    await expect(store.claim('app-beta', 'evt-1', DIGEST_A, now)).resolves.toEqual({ ok: true, recovered: false });
    await expect(store.claim('app-alpha', 'evt-1', DIGEST_A, now + 1)).resolves.toEqual({ ok: false, reason: 'duplicate' });
  });

  it('reuses capacity only after expiry and never evicts a live claim', async () => {
    const dir = join(tempRoot(), '.botmux', 'ask-card-event-claim-store');
    const store = createAskCardEventClaimStore(dir, { instanceId: 'boot-a', maxEntries: 1 });
    const now = 5_000;

    await expect(store.claim('cli_a', 'evt-live', DIGEST_A, now)).resolves.toEqual({ ok: true, recovered: false });
    await expect(store.claim('cli_a', 'evt-next', DIGEST_B, now + 1)).resolves.toEqual({ ok: false, reason: 'capacity_exhausted' });

    const afterExpiry = now + ASK_CARD_EVENT_CLAIM_TTL_MS + 1;
    await expect(store.claim('cli_a', 'evt-next', DIGEST_B, afterExpiry)).resolves.toEqual({ ok: true, recovered: false });
    await expect(store.claim('cli_a', 'evt-live', DIGEST_A, afterExpiry + 1)).resolves.toEqual({ ok: false, reason: 'capacity_exhausted' });
  });

  it('admits exactly one concurrent winner for the same event', async () => {
    const dir = join(tempRoot(), '.botmux', 'ask-card-event-claim-store');
    const contenders = Array.from({ length: 8 }, (_, index) =>
      createAskCardEventClaimStore(dir, { instanceId: `boot-${index}` }),
    );

    const results = await Promise.all(contenders.map((store) =>
      store.claim('cli_a', 'evt-race', DIGEST_A, 10_000),
    ));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === 'duplicate')).toHaveLength(7);
  });

  it('fails closed on corruption, ambiguous duplicate records, and unsafe paths', async () => {
    const root = tempRoot();
    const dir = join(root, '.botmux', 'ask-card-event-claim-store');
    const appId = 'cli_a';
    const eventId = 'evt-unsafe';
    const store = createAskCardEventClaimStore(dir, { instanceId: 'boot-a' });

    await expect(store.claim(appId, eventId, DIGEST_A, 1_000)).resolves.toEqual({ ok: true, recovered: false });
    const file = findOnlyStoreFile(dir);

    writeFileSync(file, '{ not json', 'utf8');
    await expect(store.claim(appId, 'evt-corrupt', DIGEST_A, 1_001)).resolves.toEqual({ ok: false, reason: 'storage_error' });

    writeFileSync(file, JSON.stringify({
      version: 1,
      larkAppId: appId,
      claims: [
        { eventId, bindingDigest: DIGEST_A, ownerInstanceId: 'boot-a', state: 'processing', expiresAt: 2_000 },
        { eventId, bindingDigest: DIGEST_A, ownerInstanceId: 'boot-a', state: 'completed', expiresAt: 2_000 },
      ],
    }) + '\n', 'utf8');
    await expect(store.claim(appId, 'evt-dup-entry', DIGEST_A, 1_002)).resolves.toEqual({ ok: false, reason: 'storage_error' });

    writeFileSync(file, JSON.stringify({
      version: 1, larkAppId: appId, claims: [], unexpected: true,
    }) + '\n', { mode: 0o600 });
    await expect(store.claim(appId, 'evt-extra-key', DIGEST_A, 1_002))
      .resolves.toEqual({ ok: false, reason: 'storage_error' });

    if (process.platform !== 'win32') {
      chmodSync(dir, 0o770);
      await expect(store.claim(appId, 'evt-perms', DIGEST_A, 1_003)).resolves.toEqual({ ok: false, reason: 'storage_error' });
    }
  });

  it('fails closed on a symlinked leaf and trims expired claims on complete writes', async () => {
    const root = tempRoot();
    const dir = join(root, '.botmux', 'ask-card-event-claim-store');
    const appId = 'cli_a';
    const now = 20_000;

    const store = createAskCardEventClaimStore(dir, { instanceId: 'boot-a', maxEntries: 2 });
    await expect(store.claim(appId, 'evt-expiring', DIGEST_A, now)).resolves.toEqual({ ok: true, recovered: false });
    await expect(store.claim(appId, 'evt-live', DIGEST_B, now + 1_000)).resolves.toEqual({ ok: true, recovered: false });

    const completeAt = now + ASK_CARD_EVENT_CLAIM_TTL_MS + 500;
    await expect(store.complete(appId, 'evt-live', DIGEST_B, completeAt)).resolves.toEqual({ ok: true, recovered: false });

    const file = findOnlyStoreFile(dir);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { claims: Array<{ eventId: string; state: string }> };
    expect(stored.claims).toHaveLength(1);
    expect(stored.claims[0]).toMatchObject({ eventId: 'evt-live', state: 'completed' });

    if (process.platform !== 'win32') {
      rmSync(file);
      const target = join(root, 'target.json');
      writeFileSync(target, 'keep', { mode: 0o600 });
      symlinkSync(target, file);
      await expect(store.claim(appId, 'evt-symlink', DIGEST_A, completeAt + 1)).resolves.toEqual({ ok: false, reason: 'storage_error' });
      expect(readFileSync(target, 'utf8')).toBe('keep');
    }
  });

  it('can rewrite a valid ledger larger than the secure helper default 1 MiB', async () => {
    const dir = join(tempRoot(), '.botmux', 'ask-card-event-claim-store');
    const appId = 'cli_a';
    const now = 30_000;
    const store = createAskCardEventClaimStore(dir, { instanceId: 'boot-a' });
    await expect(store.claim(appId, 'seed', DIGEST_A, now)).resolves.toMatchObject({ ok: true });
    const file = findOnlyStoreFile(dir);
    const claims = Array.from({ length: 2_000 }, (_, index) => ({
      eventId: `evt-${String(index).padStart(4, '0')}-${'x'.repeat(490)}`,
      bindingDigest: DIGEST_A,
      ownerInstanceId: 'boot-a',
      state: 'processing',
      expiresAt: now + ASK_CARD_EVENT_CLAIM_TTL_MS,
    }));
    const encoded = `${JSON.stringify({ version: 1, larkAppId: appId, claims })}\n`;
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(1024 * 1024);
    writeFileSync(file, encoded, { mode: 0o600 });

    await expect(store.claim(appId, 'evt-after-large-ledger', DIGEST_B, now + 1))
      .resolves.toMatchObject({ ok: true });
  });
});
