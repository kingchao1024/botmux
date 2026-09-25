import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeHeartbeatTo,
  anyDaemonBusyTo,
  daemonHeartbeatForAppTo,
  heartbeatDirIn,
  HEARTBEAT_FRESH_MS,
  HEARTBEAT_FUTURE_SKEW_MS,
} from '../src/core/daemon-heartbeat.js';

const T0 = Date.parse('2026-06-07T04:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('daemon heartbeat / anyDaemonBusy', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-hb-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('false when there are no heartbeats at all', () => {
    expect(anyDaemonBusyTo(dir, T0)).toBe(false);
  });

  it('true when a fresh heartbeat reports busyCount > 0', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 2, iso(T0));
    expect(anyDaemonBusyTo(dir, T0 + 5_000)).toBe(true);
  });

  it('false when a fresh heartbeat reports busyCount 0 (idle daemon)', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 0, iso(T0));
    expect(anyDaemonBusyTo(dir, T0 + 5_000)).toBe(false);
  });

  it('ignores a stale heartbeat (daemon went down) — treated as not busy', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 5, iso(T0));
    expect(anyDaemonBusyTo(dir, T0 + HEARTBEAT_FRESH_MS + 1_000)).toBe(false);
  });

  it('true if ANY daemon is fresh+busy while others are idle', () => {
    writeHeartbeatTo(dir, 'cli_app_idle', 0, iso(T0));
    writeHeartbeatTo(dir, 'cli_app_busy', 1, iso(T0));
    expect(anyDaemonBusyTo(dir, T0 + 5_000)).toBe(true);
  });

  it('round-trips the busy count for a single daemon', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 3, iso(T0));
    writeHeartbeatTo(dir, 'cli_app_a', 0, iso(T0 + 1_000)); // overwrite same daemon
    expect(anyDaemonBusyTo(dir, T0 + 2_000)).toBe(false);
  });

  it('tolerates a corrupt heartbeat file (ignored, no throw)', () => {
    writeHeartbeatTo(dir, 'cli_app_busy', 1, iso(T0)); // creates the dir + a busy beat
    writeFileSync(join(heartbeatDirIn(dir), 'broken.json'), '{bad');
    expect(anyDaemonBusyTo(dir, T0 + 1_000)).toBe(true);
  });

  it('writes atomically (no .tmp leftover)', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 1, iso(T0));
    expect(readdirSync(heartbeatDirIn(dir)).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('daemon heartbeat / daemonHeartbeatForAppTo', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-hb-app-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reports a fresh zero-count heartbeat as idle', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 0, iso(T0));

    expect(daemonHeartbeatForAppTo(dir, 'cli_app_a', T0 + 5_000)).toEqual({
      availability: 'idle',
      busyCount: 0,
      observedAt: iso(T0),
    });
  });

  it('reports a fresh positive-count heartbeat as busy', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 2, '2026-06-07T04:00:00Z');

    expect(daemonHeartbeatForAppTo(dir, 'cli_app_a', T0 + 5_000)).toEqual({
      availability: 'busy',
      busyCount: 2,
      observedAt: iso(T0),
    });
  });

  it('returns no evidence for a stale heartbeat', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 1, iso(T0));

    expect(daemonHeartbeatForAppTo(dir, 'cli_app_a', T0 + HEARTBEAT_FRESH_MS + 1)).toBeNull();
  });

  it('accepts a heartbeat at the future clock-skew boundary', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 1, iso(T0 + HEARTBEAT_FUTURE_SKEW_MS));

    expect(daemonHeartbeatForAppTo(dir, 'cli_app_a', T0)).toMatchObject({
      availability: 'busy',
      observedAt: iso(T0 + HEARTBEAT_FUTURE_SKEW_MS),
    });
  });

  it('returns no evidence for a heartbeat beyond the future clock-skew boundary', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 1, iso(T0 + HEARTBEAT_FUTURE_SKEW_MS + 1));

    expect(daemonHeartbeatForAppTo(dir, 'cli_app_a', T0)).toBeNull();
  });

  it('returns no evidence for a corrupt heartbeat', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 1, iso(T0));
    writeFileSync(join(heartbeatDirIn(dir), 'cli_app_a.json'), '{bad');

    expect(daemonHeartbeatForAppTo(dir, 'cli_app_a', T0 + 1_000)).toBeNull();
  });

  it('returns no evidence for a negative busy count', () => {
    writeHeartbeatTo(dir, 'cli_app_a', -1, iso(T0));

    expect(daemonHeartbeatForAppTo(dir, 'cli_app_a', T0 + 1_000)).toBeNull();
    expect(anyDaemonBusyTo(dir, T0 + 1_000)).toBe(false);
  });

  it('returns no evidence when the heartbeat belongs to a different app', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 1, iso(T0));
    const path = join(heartbeatDirIn(dir), 'cli_app_a.json');
    writeFileSync(path, JSON.stringify({ larkAppId: 'cli_app_b', busyCount: 1, at: iso(T0) }));

    expect(daemonHeartbeatForAppTo(dir, 'cli_app_a', T0 + 1_000)).toBeNull();
  });
});
