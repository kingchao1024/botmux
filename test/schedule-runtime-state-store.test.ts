import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSyncTsScript, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import {
  isProjectActive,
  readScheduleRuntimeState,
  writeScheduleRuntimeState,
  type ScheduleRuntimeStateKind,
} from '../src/services/schedule-runtime-state-store.js';

const dirs: string[] = [];

function childExit(child: ReturnType<typeof spawnTsEvalWithRepoImports>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-schedule-runtime-state-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function state(kind: ScheduleRuntimeStateKind, chatId = 'oc_demo'): Record<string, unknown> {
  if (kind === 'patrol') {
    return {
      schemaVersion: 1,
      chatId,
      updatedAt: '2026-09-27T10:00:00.000Z',
      keyTopics: [],
      notes: [],
      notifiedFingerprints: [],
    };
  }
  if (kind === 'delivery') {
    return {
      schemaVersion: 1,
      chatId,
      hourlyTaskId: 'task1234',
      runKey: 'task1234:2026-09-27T10:00:00.000Z',
      status: 'sending',
      claimedAt: '2026-09-27T10:00:01.000Z',
      messageId: null,
      lastError: null,
    };
  }
  return {
    schemaVersion: 1,
    chatId,
    updatedAt: '2026-09-27T10:00:00.000Z',
    items: [],
  };
}

describe('schedule runtime state store', () => {
  it('creates and reads an allowlisted state file with a CAS token', () => {
    const dataDir = tempDataDir();
    const created = writeScheduleRuntimeState({
      kind: 'delivery',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: state('delivery'),
      dataDir,
    });

    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readScheduleRuntimeState('delivery', 'oc_demo', dataDir)).toEqual(created);
    expect(lstatSync(created.path).mode & 0o777).toBe(0o600);
  });

  it('rejects a stale writer without changing the file', () => {
    const dataDir = tempDataDir();
    const first = writeScheduleRuntimeState({
      kind: 'coordinator-action',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: state('coordinator-action'),
      dataDir,
      now: () => '2026-09-27T10:00:01.000Z',
    });
    const before = readFileSync(first.path, 'utf8');

    expect(() => writeScheduleRuntimeState({
      kind: 'coordinator-action',
      chatId: 'oc_demo',
      expectedSha256: '0'.repeat(64),
      next: { ...state('coordinator-action'), items: [{ fingerprint: 'new', status: 'open' }] },
      dataDir,
    })).toThrow(/state_changed/);
    expect(readFileSync(first.path, 'utf8')).toBe(before);
  });

  it('rejects a chat mismatch and duplicate ledger fingerprints', () => {
    const dataDir = tempDataDir();
    expect(() => writeScheduleRuntimeState({
      kind: 'human-action',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: state('human-action', 'oc_other'),
      dataDir,
    })).toThrow(/chat_id_mismatch/);

    expect(() => writeScheduleRuntimeState({
      kind: 'human-action',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: {
        ...state('human-action'),
        items: [
          { fingerprint: 'same', status: 'open' },
          { fingerprint: 'same', status: 'closed' },
        ],
      },
      dataDir,
    })).toThrow(/duplicate_fingerprint/);
  });

  it('rejects malformed patrol and delivery states', () => {
    const dataDir = tempDataDir();
    expect(() => writeScheduleRuntimeState({
      kind: 'patrol',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: { ...state('patrol'), notes: Array.from({ length: 31 }, (_, i) => String(i)) },
      dataDir,
    })).toThrow(/patrol_notes_limit/);

    expect(() => writeScheduleRuntimeState({
      kind: 'delivery',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: { ...state('delivery'), status: 'delivered', messageId: null },
      dataDir,
    })).toThrow(/delivery_message_required/);
  });

  it('rejects malformed or duplicate patrol history entries', () => {
    const dataDir = tempDataDir();
    expect(() => writeScheduleRuntimeState({
      kind: 'patrol',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: { ...state('patrol'), notes: ['ok', 1] },
      dataDir,
    })).toThrow(/invalid_patrol_note/);
    expect(() => writeScheduleRuntimeState({
      kind: 'patrol',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: { ...state('patrol'), notifiedFingerprints: ['same', 'same'] },
      dataDir,
    })).toThrow(/duplicate_patrol_fingerprint/);
  });

  it('refuses to replace a symlink leaf', () => {
    const dataDir = tempDataDir();
    const outside = join(dataDir, 'outside.json');
    writeFileSync(outside, JSON.stringify(state('delivery')));
    const targetDir = join(dataDir, 'schedule-delivery-watch');
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, 'oc_demo.json');
    symlinkSync(outside, target);

    expect(() => readScheduleRuntimeState('delivery', 'oc_demo', dataDir)).toThrow(/unsafe_state_path/);
    expect(readFileSync(outside, 'utf8')).toBe(JSON.stringify(state('delivery')));
    expect(existsSync(target)).toBe(true);
  });

  it('exposes read and CAS write through the dedicated command', () => {
    const dataDir = tempDataDir();
    const script = join(process.cwd(), 'scripts', 'schedule-runtime-state.ts');
    const next = JSON.stringify(state('delivery'));
    const write = spawnSyncTsScript(script, ['write', 'delivery', '--chat-id', 'oc_demo', '--expected-sha', 'missing'], {
      cwd: process.cwd(),
      env: { ...process.env, SESSION_DATA_DIR: dataDir },
      input: next,
      encoding: 'utf8',
    });
    expect(write.status).toBe(0);
    const written = JSON.parse(write.stdout);
    expect(written).toMatchObject({ ok: true, kind: 'delivery', chatId: 'oc_demo' });

    const read = spawnSyncTsScript(script, ['read', 'delivery', '--chat-id', 'oc_demo'], {
      cwd: process.cwd(),
      env: { ...process.env, SESSION_DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    expect(read.status).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      kind: 'delivery',
      chatId: 'oc_demo',
      sha256: written.sha256,
      state: { status: 'sending' },
    });
  });

  it('refuses to drop ledger items or reopen a delivered run', () => {
    const dataDir = tempDataDir();
    const first = writeScheduleRuntimeState({
      kind: 'coordinator-action',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: {
        ...state('coordinator-action'),
        items: [{ fingerprint: 'keep', status: 'closed', firstSeenAt: '2026-09-27T09:00:00.000Z' }],
      },
      dataDir,
    });
    expect(() => writeScheduleRuntimeState({
      kind: 'coordinator-action',
      chatId: 'oc_demo',
      expectedSha256: first.sha256,
      next: state('coordinator-action'),
      dataDir,
    })).toThrow(/ledger_item_removed/);

    const sendingState = state('delivery', 'oc_other');
    const sending = writeScheduleRuntimeState({
      kind: 'delivery',
      chatId: 'oc_other',
      expectedSha256: 'missing',
      next: sendingState,
      dataDir,
    });
    const sent = writeScheduleRuntimeState({
      kind: 'delivery',
      chatId: 'oc_other',
      expectedSha256: sending.sha256,
      next: {
        ...sendingState,
        status: 'sent',
        messageId: 'om_sent',
      },
      dataDir,
    });
    const delivered = writeScheduleRuntimeState({
      kind: 'delivery',
      chatId: 'oc_other',
      expectedSha256: sent.sha256,
      next: {
        ...sendingState,
        status: 'delivered',
        messageId: 'om_sent',
        deliveryVerifiedAt: '2026-09-27T10:00:02.000Z',
      },
      dataDir,
    });
    expect(() => writeScheduleRuntimeState({
      kind: 'delivery',
      chatId: 'oc_other',
      expectedSha256: delivered.sha256,
      next: { ...state('delivery', 'oc_other'), status: 'sending', messageId: null },
      dataDir,
    })).toThrow(/delivery_already_delivered/);
  });

  it('allows exactly one independent process to win the same CAS', async () => {
    const dataDir = tempDataDir();
    const initial = writeScheduleRuntimeState({
      kind: 'human-action',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: state('human-action'),
      dataDir,
    });
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'services', 'schedule-runtime-state-store.ts')).href;
    const childCode = `
      import { writeScheduleRuntimeState } from ${JSON.stringify(moduleUrl)};
      try {
        writeScheduleRuntimeState({
          kind: 'human-action',
          chatId: 'oc_demo',
          expectedSha256: process.env.EXPECTED_SHA,
          next: {
            schemaVersion: 1,
            chatId: 'oc_demo',
            updatedAt: '2026-09-27T10:00:00.000Z',
            items: [{ fingerprint: process.env.FINGERPRINT, status: 'open' }],
          },
          dataDir: process.env.STATE_DIR,
        });
        process.exit(0);
      } catch (error) {
        process.exit(String(error).includes('state_changed') ? 3 : 2);
      }
    `;
    const spawn = (fingerprint: string) => spawnTsEvalWithRepoImports(childCode, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EXPECTED_SHA: initial.sha256,
        FINGERPRINT: fingerprint,
        STATE_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const children = [spawn('writer-a'), spawn('writer-b')];
    const exits = await Promise.all(children.map(childExit));
    expect(exits.sort()).toEqual([0, 3]);
    const persisted = readScheduleRuntimeState('human-action', 'oc_demo', dataDir).state!;
    expect(['writer-a', 'writer-b']).toContain((persisted.items as Array<{ fingerprint: string }>)[0]?.fingerprint);
  });

  it('evaluates the project-active precondition from durable project state', () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, 'project-groups.json'), JSON.stringify({
      schemaVersion: 2,
      projects: {
        oc_demo: { status: 'active' },
        oc_closed: { status: 'completed' },
      },
    }));
    expect(isProjectActive('oc_demo', dataDir)).toBe(true);
    expect(isProjectActive('oc_closed', dataDir)).toBe(false);
    expect(isProjectActive('oc_missing', dataDir)).toBe(false);
  });

  it('prints exactly one or zero for the project-active precondition command', () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, 'project-groups.json'), JSON.stringify({
      schemaVersion: 2,
      projects: {
        oc_active: { status: 'active' },
        oc_closed: { status: 'completed' },
      },
    }));
    const script = join(process.cwd(), 'scripts', 'schedule-runtime-state.ts');
    const run = (chatId: string) => spawnSyncTsScript(
      script,
      ['project-active', '--chat-id', chatId],
      { cwd: process.cwd(), env: { ...process.env, SESSION_DATA_DIR: dataDir }, encoding: 'utf8' },
    );

    const active = run('oc_active');
    expect(active.status).toBe(0);
    expect(active.stdout).toBe('1\n');
    const closed = run('oc_closed');
    expect(closed.status).toBe(0);
    expect(closed.stdout).toBe('0\n');
  });

  it('rejects unknown command flags instead of silently ignoring them', () => {
    const dataDir = tempDataDir();
    const script = join(process.cwd(), 'scripts', 'schedule-runtime-state.ts');
    const result = spawnSyncTsScript(
      script,
      ['read', 'delivery', '--chat-id', 'oc_demo', '--bogus'],
      { cwd: process.cwd(), env: { ...process.env, SESSION_DATA_DIR: dataDir }, encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });

  it('preserves Unicode and unknown forward-compatible fields', () => {
    const dataDir = tempDataDir();
    const next = {
      ...state('human-action'),
      extension: { label: '巡检 ✅', literal: 'null', enabled: 'true' },
    };
    const written = writeScheduleRuntimeState({
      kind: 'human-action',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next,
      dataDir,
    });
    expect(written.state?.extension).toEqual(next.extension);
  });

  it('rejects oversized state and bad CLI arity without leaving a file', () => {
    const dataDir = tempDataDir();
    expect(() => writeScheduleRuntimeState({
      kind: 'patrol',
      chatId: 'oc_demo',
      expectedSha256: 'missing',
      next: { ...state('patrol'), extension: 'x'.repeat(4 * 1024 * 1024) },
      dataDir,
    })).toThrow(/state_too_large/);
    expect(readScheduleRuntimeState('patrol', 'oc_demo', dataDir).state).toBeNull();

    const script = join(process.cwd(), 'scripts', 'schedule-runtime-state.ts');
    const missingArgs = spawnSyncTsScript(script, [], {
      cwd: process.cwd(),
      env: { ...process.env, SESSION_DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    expect(missingArgs.status).toBe(2);
    const emptyInput = spawnSyncTsScript(
      script,
      ['write', 'delivery', '--chat-id', 'oc_demo', '--expected-sha', 'missing'],
      { cwd: process.cwd(), env: { ...process.env, SESSION_DATA_DIR: dataDir }, input: '', encoding: 'utf8' },
    );
    expect(emptyInput.status).toBe(2);
  });

  it('fails the project precondition closed on malformed durable state', () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, 'project-groups.json'), '{broken');
    expect(() => isProjectActive('oc_demo', dataDir)).toThrow(/invalid_state_json/);
  });
});

describe('hostile: claimedAt immutability across same-run retries', () => {
  it('rejects rewriting claimedAt on a delivery_failed run to prevent dedupe-window extension', () => {
    const dataDir = tempDataDir();
    const chatId = 'oc_hostile';
    const initial = {
      schemaVersion: 1,
      chatId,
      hourlyTaskId: 'task1234',
      runKey: 'task1234:2026-09-28T10:00:00.000Z',
      status: 'sending',
      claimedAt: '2026-09-28T10:00:01.000Z',
      lastAttemptRunAt: '2026-09-28T10:00:01.000Z',
      turnId: 'schedule:task1234:11111111-1111-4111-8111-111111111111',
      messageId: null,
      lastError: null,
    };
    const claimed = writeScheduleRuntimeState({
      kind: 'delivery', chatId, expectedSha256: 'missing', next: initial, dataDir,
    });
    const failed = writeScheduleRuntimeState({
      kind: 'delivery', chatId, expectedSha256: claimed.sha256,
      next: { ...initial, status: 'delivery_failed', lastError: 'response lost' }, dataDir,
    });

    expect(() => writeScheduleRuntimeState({
      kind: 'delivery', chatId, expectedSha256: failed.sha256,
      next: {
        ...failed.state,
        claimedAt: '2026-09-28T12:00:00.000Z',
        lastAttemptRunAt: '2026-09-28T12:00:00.000Z',
      },
      dataDir,
    })).toThrow(/claimed_at/);

    expect(readScheduleRuntimeState('delivery', chatId, dataDir).state?.claimedAt)
      .toBe('2026-09-28T10:00:01.000Z');
  });

  it('rejects adding claimedAt when a legacy same-run state omitted it', () => {
    const dataDir = tempDataDir();
    const chatId = 'oc_legacy';
    const initial = {
      schemaVersion: 1,
      chatId,
      hourlyTaskId: 'task1234',
      runKey: 'task1234:2026-09-28T10:00:00.000Z',
      status: 'sending',
      messageId: null,
      lastError: null,
    };
    const claimed = writeScheduleRuntimeState({
      kind: 'delivery', chatId, expectedSha256: 'missing', next: initial, dataDir,
    });
    const failed = writeScheduleRuntimeState({
      kind: 'delivery', chatId, expectedSha256: claimed.sha256,
      next: { ...initial, status: 'delivery_failed', lastError: 'legacy response lost' }, dataDir,
    });

    expect(() => writeScheduleRuntimeState({
      kind: 'delivery', chatId, expectedSha256: failed.sha256,
      next: { ...failed.state, claimedAt: '2026-09-28T12:00:00.000Z' }, dataDir,
    })).toThrow(/delivery_claimed_at_changed/);
    expect(readScheduleRuntimeState('delivery', chatId, dataDir).state?.claimedAt).toBeUndefined();
  });
});
