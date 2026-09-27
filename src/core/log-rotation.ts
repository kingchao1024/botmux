import { renameSync, statSync, unlinkSync } from 'node:fs';

export interface LogRotationOptions {
  /** Maximum file size in bytes before rotation. 0 or negative disables rotation. */
  maxSizeBytes: number;
  /** Number of rotated backup files to keep (1..N). */
  maxFiles: number;
}

/**
 * Default rotation policy: 10 MB per file, retain 3 backup generations.
 *
 * ## Scope and residual risk
 *
 * Rotation runs strictly before `openSync` at child spawn. An active child
 * that writes past `maxSizeBytes` while holding the log fd will continue to
 * grow until the child exits (crash / restart / stop). This is a documented
 * residual risk; the supervisor's periodic log monitor warns when an active
 * log exceeds the threshold. Full active-writer rotation would require either
 * a controlled child restart or a copytruncate reopen mechanism — both are
 * deferred to a later iteration.
 *
 * The exported `logSizeExceedsThreshold` helper is available for external
 * monitoring scripts and cron jobs that need the same size check.
 */
export const DEFAULT_LOG_ROTATION: LogRotationOptions = {
  maxSizeBytes: 10 * 1024 * 1024,
  maxFiles: 3,
};

/**
 * Rename `from` to `to`, removing `to` first if it exists — but only when `from`
 * also exists. When `from` is absent (sparse ring), the call is a no-op.
 * Required for portability: `renameSync` on Windows fails when the destination
 * exists (EPERM / EEXIST), and pre-emptive unlink of a target with no
 * replacement source would silently destroy valid backup data.
 */
function renameReplaceSync(from: string, to: string): void {
  let fromStat: ReturnType<typeof statSync>;
  try {
    fromStat = statSync(from);
  } catch {
    return; // source absent — no-op (sparse ring)
  }
  if (!fromStat.isFile()) return;
  try {
    unlinkSync(to);
  } catch {
    /* destination absent — expected */
  }
  renameSync(from, to);
}

/**
 * Rotate a log file BEFORE opening it for append, so the child never inherits
 * a stale inode. Renames:
 *
 *     file → file.1, file.1 → file.2, …, file.(maxFiles) → deleted.
 *
 * A no-op when the file is absent, smaller than maxSizeBytes, or rotation is
 * disabled (maxSizeBytes <= 0).
 *
 * Error handling:
 *
 * - ENOTFOUND/ENOENT during backup shifting is tolerated — a missing
 *   generation is normal while the ring is still filling.
 * - Rename of the live oversized file (`renameReplaceSync`) throws on
 *   non-trivial failures so the caller's catch block can fall back to
 *   inheriting stdio instead of silently pinning a stale inode.
 */
export function rotateLogIfNeeded(
  filePath: string,
  opts: LogRotationOptions = DEFAULT_LOG_ROTATION,
): void {
  if (opts.maxSizeBytes <= 0 || opts.maxFiles < 1) return;

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return; // file doesn't exist
  }
  if (size < opts.maxSizeBytes) return;

  // Drop the oldest retained rotation to make room.
  try {
    unlinkSync(`${filePath}.${opts.maxFiles}`);
  } catch {
    /* doesn't exist — expected */
  }

  // Shift retained generations upward.
  for (let i = opts.maxFiles - 1; i >= 1; i--) {
    try {
      renameReplaceSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
    } catch {
      /* file .i absent — expected while the ring is still filling */
    }
  }

  // Rotate the current oversized file out. This is the critical step: if it
  // fails we do NOT create a new file — the caller's catch block falls back
  // to inheriting stdio instead of pinning a stale inode.
  renameReplaceSync(filePath, `${filePath}.1`);
}

/**
 * Check whether the file at `filePath` exceeds the rotation threshold. Safe
 * to call on an active (open) file — this is a read-only stat, not a rotate.
 * Used by the supervisor's periodic monitor to log warnings.
 */
export function logSizeExceedsThreshold(
  filePath: string,
  opts: LogRotationOptions = DEFAULT_LOG_ROTATION,
): boolean {
  if (opts.maxSizeBytes <= 0) return false;
  try {
    return statSync(filePath).size >= opts.maxSizeBytes;
  } catch {
    return false;
  }
}