/**
 * Cross-daemon busy heartbeat. botmux runs one daemon process per bot, but a
 * restart (auto-restart / auto-update) takes them all down at once — so the
 * "is anything mid-CLI-turn right now?" gate must see across processes, not
 * just the primary daemon's own sessions.
 *
 * Each daemon periodically writes `<dataDir>/heartbeats/<larkAppId>.json` with
 * its count of actively-working sessions. The primary daemon reads them all;
 * any fresh heartbeat with busyCount > 0 blocks a maintenance restart.
 * A daemon that is down leaves a stale file, which is ignored (restarting is
 * safe when a daemon isn't even running).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

export interface Heartbeat {
  larkAppId: string;
  busyCount: number;
  at: string; // ISO 8601
}

/** A heartbeat older than this is treated as "daemon not reporting" → ignored.
 *  Daemons should write well within this window (≈ every 15s). */
export const HEARTBEAT_FRESH_MS = 60_000;
export const HEARTBEAT_FUTURE_SKEW_MS = 2_000;

export type FreshDaemonHeartbeat = Readonly<{
  availability: 'idle' | 'busy';
  busyCount: number;
  observedAt: string;
}>;

export function heartbeatDirIn(dir: string): string {
  return join(dir, 'heartbeats');
}

export function writeHeartbeatTo(dir: string, larkAppId: string, busyCount: number, atIso: string): void {
  const hbDir = heartbeatDirIn(dir);
  if (!existsSync(hbDir)) mkdirSync(hbDir, { recursive: true });
  const path = join(hbDir, `${sanitize(larkAppId)}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  const beat: Heartbeat = { larkAppId, busyCount, at: atIso };
  writeFileSync(tmp, JSON.stringify(beat));
  renameSync(tmp, path);
}

/** True iff any daemon reports a fresh heartbeat with at least one busy session. */
export function anyDaemonBusyTo(dir: string, nowMs: number, freshMs: number = HEARTBEAT_FRESH_MS): boolean {
  const hbDir = heartbeatDirIn(dir);
  if (!existsSync(hbDir)) return false;
  let files: string[];
  try { files = readdirSync(hbDir); } catch { return false; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const beat = readBeat(join(hbDir, f));
    if (!beat) continue;
    const at = Date.parse(beat.at);
    if (!Number.isFinite(at)) continue;
    if (nowMs - at > freshMs) continue; // stale → ignore
    if (beat.busyCount > 0) return true;
  }
  return false;
}

/** Fresh runtime evidence for one configured app, or null when none is trustworthy. */
export function daemonHeartbeatForAppTo(
  dir: string,
  larkAppId: string,
  nowMs: number,
  freshMs: number = HEARTBEAT_FRESH_MS,
): FreshDaemonHeartbeat | null {
  const beat = readBeat(join(heartbeatDirIn(dir), `${sanitize(larkAppId)}.json`));
  if (!beat || beat.larkAppId !== larkAppId) return null;
  const at = Date.parse(beat.at);
  if (!Number.isFinite(at) || nowMs - at > freshMs || at - nowMs > HEARTBEAT_FUTURE_SKEW_MS) return null;
  return {
    availability: beat.busyCount > 0 ? 'busy' : 'idle',
    busyCount: beat.busyCount,
    observedAt: new Date(at).toISOString(),
  };
}

function readBeat(path: string): Heartbeat | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'));
    if (v && typeof v === 'object'
        && Number.isSafeInteger(v.busyCount)
        && v.busyCount >= 0
        && typeof v.at === 'string') {
      return v as Heartbeat;
    }
  } catch {
    /* corrupt/partial write → ignore */
  }
  return null;
}

/** App ids are already filesystem-safe (cli_…), but guard against separators. */
function sanitize(larkAppId: string): string {
  return larkAppId.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---- default-dir wrappers (production wiring) ----

export function writeHeartbeat(larkAppId: string, busyCount: number): void {
  writeHeartbeatTo(config.session.dataDir, larkAppId, busyCount, new Date().toISOString());
}

export function anyDaemonBusy(nowMs: number = Date.now()): boolean {
  return anyDaemonBusyTo(config.session.dataDir, nowMs);
}
