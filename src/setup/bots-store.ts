/**
 * `bots.json` 原子读写. Codex review 边界 #2 + #3:
 * - tmp 文件必须和 `bots.json` 同目录, 保证 `renameSync` 在同 fs 下原子覆盖
 * - 任意写入失败不留半截 JSON (renameSync 之前一切失败都不影响旧文件)
 * - 文件权限 0o600 (只有用户自己能读), secret 不外泄给同机器人其它用户
 */
import { writeFileSync, renameSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import {
  FileLockTimeoutError,
  withFileLock,
  withFileLockSync,
  type FileLockOptions,
} from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import { assertCodexInstanceConfigWrite } from '../services/codex-instance-config-guard.js';
import { assertQuotaFallbackGraphAcyclic } from '../services/quota-fallback.js';
import {
  assertCanonicalBotsConfigTargetStable,
  resolveCanonicalBotsConfigTarget,
} from '../core/config-dir.js';

export type BotsJsonLockCaller =
  | 'bots-store'
  | 'cli'
  | 'config-store'
  | 'daemon'
  | 'dashboard'
  | 'device-isolation'
  | 'sandbox-migration';

export type BotsJsonLockOperation =
  | 'atomic-write'
  | 'bot-entry-rmw'
  | 'bot-start'
  | 'fleet-restart'
  | 'fleet-start'
  | 'legacy-config-migration'
  | 'plugin-binding'
  | 'startup-admission'
  | 'vc-agent-profile';

export interface BotsJsonLockOptions extends FileLockOptions {
  /** Fixed component name for timeout observability; invalid values are redacted. */
  caller?: BotsJsonLockCaller;
  /** Fixed operation name for timeout observability; invalid values are redacted. */
  operation?: BotsJsonLockOperation;
}

const LOCK_CALLERS = new Set<BotsJsonLockCaller>([
  'bots-store',
  'cli',
  'config-store',
  'daemon',
  'dashboard',
  'device-isolation',
  'sandbox-migration',
]);

const LOCK_OPERATIONS = new Set<BotsJsonLockOperation>([
  'atomic-write',
  'bot-entry-rmw',
  'bot-start',
  'fleet-restart',
  'fleet-start',
  'legacy-config-migration',
  'plugin-binding',
  'startup-admission',
  'vc-agent-profile',
]);

function observableLockLabel(
  value: string | undefined,
  allowed: ReadonlySet<string>,
): string {
  if (value === undefined) return 'unspecified';
  return allowed.has(value) ? value : 'invalid';
}

function logOwnedBotsJsonLockTimeout(
  error: unknown,
  targetPath: string,
  options: BotsJsonLockOptions,
  startedAt: number,
): void {
  if (!(error instanceof FileLockTimeoutError) || error.lockPath !== targetPath + '.lock') return;

  logger.warn('[bots-lock] timeout', {
    lock: 'bots.json.lock',
    caller: observableLockLabel(options.caller, LOCK_CALLERS),
    operation: observableLockLabel(options.operation, LOCK_OPERATIONS),
    waitedMs: Math.max(0, Date.now() - startedAt),
    holderPid: error.holderPid ?? null,
    lockAgeMs: Number.isFinite(error.lockAgeMs) ? Math.round(error.lockAgeMs) : null,
  });
}

/**
 * Serialize an operation with every supported bots.json writer. When nesting
 * with device-isolation activation, acquire this config lock first: fleet
 * start/restart already uses config -> daemon startup activation in that order.
 */
export function withBotsJsonLockSync<T>(
  botsJsonPath: string,
  fn: (targetPath: string) => T,
  options: BotsJsonLockOptions = {},
): T {
  const target = resolveCanonicalBotsConfigTarget(botsJsonPath, { allowMissing: true });
  const assertTargetStable = (): void => assertCanonicalBotsConfigTargetStable(target);
  const startedAt = Date.now();
  try {
    return withFileLockSync(target.targetPath, () => {
      assertTargetStable();
      const result = fn(target.targetPath);
      if (target.requestedWasSymlink) assertTargetStable();
      return result;
    }, options);
  } catch (error) {
    logOwnedBotsJsonLockTimeout(error, target.targetPath, options, startedAt);
    throw error;
  }
}

export function withBotsJsonLock<T>(
  botsJsonPath: string,
  fn: (targetPath: string, assertTargetStable: () => void) => Promise<T>,
  options: BotsJsonLockOptions = {},
): Promise<T> {
  const target = resolveCanonicalBotsConfigTarget(botsJsonPath, { allowMissing: true });
  const assertTargetStable = (): void => assertCanonicalBotsConfigTargetStable(target);
  const startedAt = Date.now();
  return withFileLock(target.targetPath, async () => {
    assertTargetStable();
    const result = await fn(target.targetPath, assertTargetStable);
    if (target.requestedWasSymlink) assertTargetStable();
    return result;
  }, options).catch(error => {
    logOwnedBotsJsonLockTimeout(error, target.targetPath, options, startedAt);
    throw error;
  });
}

export function writeBotsJsonAtomic(botsJsonPath: string, bots: any[]): void {
  // PM2 start surfaces hold this same generation lock from snapshot through
  // post-start verification/rollback, so the ecosystem and its expected names
  // can never be built from different bots.json generations.
  const target = resolveCanonicalBotsConfigTarget(botsJsonPath, { allowMissing: true });
  const options: BotsJsonLockOptions = { caller: 'bots-store', operation: 'atomic-write' };
  const startedAt = Date.now();
  try {
    withFileLockSync(target.targetPath, () => {
      assertCanonicalBotsConfigTargetStable(target);
      const previous = existsSync(target.targetPath)
        ? JSON.parse(readFileSync(target.targetPath, 'utf8')) as any[]
        : [];
      assertCodexInstanceConfigWrite(previous, bots);
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
  } catch (error) {
    logOwnedBotsJsonLockTimeout(error, target.targetPath, options, startedAt);
    throw error;
  }
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
