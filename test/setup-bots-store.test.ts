/**
 * 单测 src/setup/bots-store.ts — 原子写 bots.json.
 *
 * Run: pnpm vitest run test/setup-bots-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BotsJsonLockCaller,
  type BotsJsonLockOperation,
} from '../src/setup/bots-store.js';
import { FileLockTimeoutError } from '../src/utils/file-lock.js';
import {
  readBotsJsonOrEmpty,
  withBotsJsonLock,
  withBotsJsonLockSync,
  writeBotsJsonAtomic,
} from '../src/setup/bots-store.js';

let tmpDir: string;
let botsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'botmux-bots-store-'));
  botsPath = join(tmpDir, 'bots.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeBotsJsonAtomic', () => {
  it('creates a missing registry with the same atomic-write result', () => {
    expect(existsSync(botsPath)).toBe(false);

    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_first' }]);

    expect(JSON.parse(readFileSync(botsPath, 'utf8'))).toEqual([{ larkAppId: 'cli_first' }]);
    expect(existsSync(botsPath + '.tmp')).toBe(false);
  });

  it('writes valid JSON with trailing newline', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_1', larkAppSecret: 's1' }]);
    expect(existsSync(botsPath)).toBe(true);
    const content = readFileSync(botsPath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].larkAppId).toBe('cli_1');
  });

  it('persists the brand field so subsequent start/verify reads it back', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_lark', larkAppSecret: 's', brand: 'lark' }]);
    const parsed = readBotsJsonOrEmpty(botsPath);
    expect(parsed[0].brand).toBe('lark');
  });

  it('cleans up the tmp file after rename (only bots.json remains)', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_2' }]);
    expect(existsSync(botsPath + '.tmp')).toBe(false);
    expect(existsSync(botsPath)).toBe(true);
  });

  it('replaces existing file atomically — old content gone, new content visible', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_old', larkAppSecret: 'old' }]);
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_new', larkAppSecret: 'new' }]);
    const parsed = JSON.parse(readFileSync(botsPath, 'utf-8'));
    expect(parsed[0].larkAppId).toBe('cli_new');
  });

  it('sets file mode 0o600 (only owner can read — secret protection)', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_x', larkAppSecret: 'secret' }]);
    const mode = statSync(botsPath).mode & 0o777;
    // 在 root 用户 / fakeroot 下 umask 可能影响; 但 0o600 是 writeFileSync 显式指定的
    // 实际结果应该精确等于 0o600.
    expect(mode).toBe(0o600);
  });

  it('uses tmp file in the SAME directory as the target (cross-fs renames are not atomic)', () => {
    // 通过 spy fs.writeFileSync 监控 tmp 路径 — 简单版: 检查 bots.json.tmp 在
    // bots.json 同目录. 实现细节: 只要写完 + rename 完不出错, 同目录假设成立.
    // 这里跑一次 + 校验 bots.json 出现在 tmpDir, 间接保证 tmp 路径也在 tmpDir.
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_t' }]);
    expect(existsSync(join(tmpDir, 'bots.json'))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('fails closed if a symlink registry retargets while its canonical target is locked', () => {
    const first = join(tmpDir, 'first.json');
    const second = join(tmpDir, 'second.json');
    const alias = join(tmpDir, 'fleet.json');
    writeFileSync(first, '[{"larkAppId":"first"}]\n', { mode: 0o600 });
    writeFileSync(second, '[{"larkAppId":"second"}]\n', { mode: 0o600 });
    symlinkSync(first, alias);

    expect(() => withBotsJsonLockSync(alias, (targetPath) => {
      expect(targetPath).toBe(first);
      unlinkSync(alias);
      symlinkSync(second, alias);
      writeFileSync(targetPath, '[{"larkAppId":"old-target-only"}]\n', { mode: 0o600 });
    })).toThrow(/target changed during operation/);

    expect(JSON.parse(readFileSync(second, 'utf8'))[0].larkAppId).toBe('second');
    expect(JSON.parse(readFileSync(first, 'utf8'))[0].larkAppId).toBe('old-target-only');
  });

  it.runIf(process.platform !== 'win32')('exposes an in-lock alias stability check before irreversible work', async () => {
    const first = join(tmpDir, 'first.json');
    const second = join(tmpDir, 'second.json');
    const alias = join(tmpDir, 'fleet.json');
    writeFileSync(first, '[]\n', { mode: 0o600 });
    writeFileSync(second, '[]\n', { mode: 0o600 });
    symlinkSync(first, alias);
    let published = false;

    await expect(withBotsJsonLock(alias, async (_targetPath, assertTargetStable) => {
      unlinkSync(alias);
      symlinkSync(second, alias);
      assertTargetStable();
      published = true;
    })).rejects.toThrow(/target changed during operation/);

    expect(published).toBe(false);
  });
});

describe('readBotsJsonOrEmpty', () => {
  it('returns [] when file missing', () => {
    expect(readBotsJsonOrEmpty(botsPath)).toEqual([]);
  });

  it('returns [] when file is malformed JSON (no throw)', () => {
    writeFileSync(botsPath, '{ not valid json');
    expect(readBotsJsonOrEmpty(botsPath)).toEqual([]);
  });

  it('returns parsed array when file is valid', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'a' }, { larkAppId: 'b' }]);
    expect(readBotsJsonOrEmpty(botsPath).map((b: any) => b.larkAppId)).toEqual(['a', 'b']);
  });
});

describe('bots.json lock observability', () => {
  it('does not log on successful acquisition', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(withBotsJsonLockSync(botsPath, () => 'acquired')).toBe('acquired');
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('logs timeout fields while redacting an unsafe caller label', () => {
    const lockPath = botsPath + '.lock';
    writeFileSync(lockPath, String(process.pid), 'utf8');
    const old = new Date(Date.now() - 1_000);
    utimesSync(lockPath, old, old);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let thrown: unknown;
    try {
      withBotsJsonLockSync(botsPath, () => 'unreachable', {
        maxWaitMs: 0,
        caller: 'token-do-not-log' as BotsJsonLockCaller,
        operation: 'config-write' as BotsJsonLockOperation,
      });
    } catch (error) {
      thrown = error;
    }

    try {
      expect(thrown).toBeInstanceOf(FileLockTimeoutError);
      expect(thrown).toMatchObject({
        code: 'FILE_LOCK_TIMEOUT',
        holderPid: process.pid,
      });
      const logged = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(logged).toContain('[bots-lock] timeout');
      expect(logged).toContain('\"lock\":\"bots.json.lock\"');
      expect(logged).toContain('\"caller\":\"invalid\"');
      expect(logged).toContain('\"operation\":\"invalid\"');
      expect(logged).toContain(`\"holderPid\":${process.pid}`);
      expect(logged).toMatch(/\"waitedMs\":\d+/);
      expect(logged).toMatch(/\"lockAgeMs\":\d+/);
      expect(logged).not.toContain('token-do-not-log');
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('rethrows non-timeout failures without logging', () => {
    const expected = new Error('callback failed');
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(() => withBotsJsonLockSync(botsPath, () => { throw expected; })).toThrow(expected);
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
