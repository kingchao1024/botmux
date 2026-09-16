/**
 * `bots.json` 原子读写. Codex review 边界 #2 + #3:
 * - tmp 文件必须和 `bots.json` 同目录, 保证 `renameSync` 在同 fs 下原子覆盖
 * - 任意写入失败不留半截 JSON (renameSync 之前一切失败都不影响旧文件)
 * - 文件权限 0o600 (只有用户自己能读), secret 不外泄给同机器人其它用户
 */
import { writeFileSync, renameSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { withFileLock, withFileLockSync, type FileLockOptions } from '../utils/file-lock.js';
import { assertQuotaFallbackGraphAcyclic } from '../services/quota-fallback.js';
import {
  assertCanonicalBotsConfigTargetStable,
  resolveCanonicalBotsConfigTarget,
} from '../core/config-dir.js';

/**
 * Serialize an operation with every supported bots.json writer. When nesting
 * with device-isolation activation, acquire this config lock first: fleet
 * start/restart already uses config -> daemon startup activation in that order.
 */
export function withBotsJsonLockSync<T>(
  botsJsonPath: string,
  fn: (targetPath: string) => T,
  options: FileLockOptions = {},
): T {
  const target = resolveCanonicalBotsConfigTarget(botsJsonPath, { allowMissing: true });
  return withFileLockSync(target.targetPath, () => {
    assertCanonicalBotsConfigTargetStable(target);
    const result = fn(target.targetPath);
    if (target.requestedWasSymlink) assertCanonicalBotsConfigTargetStable(target);
    return result;
  }, options);
}

export function withBotsJsonLock<T>(
  botsJsonPath: string,
  fn: (targetPath: string, assertTargetStable: () => void) => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const target = resolveCanonicalBotsConfigTarget(botsJsonPath, { allowMissing: true });
  const assertTargetStable = (): void => assertCanonicalBotsConfigTargetStable(target);
  return withFileLock(target.targetPath, async () => {
    assertTargetStable();
    const result = await fn(target.targetPath, assertTargetStable);
    if (target.requestedWasSymlink) assertTargetStable();
    return result;
  }, options);
}

export function writeBotsJsonAtomic(botsJsonPath: string, bots: any[]): void {
  // PM2 start surfaces hold this same generation lock from snapshot through
  // post-start verification/rollback, so the ecosystem and its expected names
  // can never be built from different bots.json generations.
  const target = resolveCanonicalBotsConfigTarget(botsJsonPath, { allowMissing: true });
  withFileLockSync(target.targetPath, () => {
    assertCanonicalBotsConfigTargetStable(target);
    // Clone/onboarding callers pass the exact generation they intend to save.
    assertQuotaFallbackGraphAcyclic(bots);
    // 注意: tmp 必须在同一目录下 (同 fs), 否则 rename 可能跨文件系统失败.
    const tmp = target.targetPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(bots, null, 2) + '\n', { mode: 0o600 });
    try {
      if (target.requestedWasSymlink) assertCanonicalBotsConfigTargetStable(target);
      renameSync(tmp, target.targetPath);
      if (target.requestedWasSymlink) assertCanonicalBotsConfigTargetStable(target);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw error;
    }
  });
}

export function readBotsJsonOrEmpty(botsJsonPath: string): any[] {
  if (!existsSync(botsJsonPath)) return [];
  try {
    const target = resolveCanonicalBotsConfigTarget(botsJsonPath);
    return JSON.parse(readFileSync(target.targetPath, 'utf-8'));
  } catch {
    return [];
  }
}
