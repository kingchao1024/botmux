import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFleetLaunchPlanMatchesRoster,
  decodeFleetLaunchPlan,
  encodeFleetLaunchPlan,
  fleetLaunchPlanFromRoster,
  validateFleetLaunchPlan,
  type FleetLaunchPlan,
} from '../src/core/fleet-launch-plan.js';
import {
  inspectFleetReadiness,
  restartFleet,
  type StartFleetResult,
} from '../src/core/fleet-runtime.js';
import type { FleetState } from '../src/core/fleet-supervisor-policy.js';
import type { OnlineDaemonInfo } from '../src/utils/daemon-discovery.js';
import { readDeviceIsolationRosterSnapshot } from '../src/services/device-isolation-roster.js';
import {
  commitRestartIntentAttemptTo,
  consumeRestartIntentTo,
  removeRestartIntentAttemptTo,
  writeRestartAttemptIntentTo,
} from '../src/services/restart-intent-store.js';
import { withBotsJsonLock } from '../src/setup/bots-store.js';
import { dashboardCurrentProvesReadiness } from '../src/cli/dashboard-endpoint.js';
import { SUPERVISOR_SHUTDOWN_PROTOCOL } from '../src/core/supervisor-shutdown-protocol.js';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-ready-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeConfig(path: string, appIds = ['cli_a', 'cli_b']): void {
  writeFileSync(path, `${JSON.stringify(appIds.map(larkAppId => ({
    larkAppId, larkAppSecret: `secret-${larkAppId}`,
  })))}\n`, { mode: 0o600 });
}

function planFixture(): FleetLaunchPlan {
  return validateFleetLaunchPlan({
    version: 1,
    requestedConfigPath: '/tmp/fleet-alias.json',
    canonicalConfigPath: '/tmp/fleet-target.json',
    rosterRevision: 'a'.repeat(64),
    bots: [{ name: 'botmux-0', appId: 'cli_a', botIndex: 0 }],
  });
}

function stateFixture(): FleetState {
  return {
    supervisorPid: 100,
    supervisorStartedAt: 'T',
    procs: [
      {
        name: 'botmux-0', appId: 'cli_a', pid: 200, generation: 1,
        status: 'online', restarts: 0, lastExitCode: null, startedAt: 'T',
      },
      {
        name: 'botmux-dashboard', appId: '', pid: 300, generation: 1,
        status: 'online', restarts: 0, lastExitCode: null, startedAt: 'T',
      },
    ],
  };
}

function descriptor(overrides: Partial<OnlineDaemonInfo> = {}): OnlineDaemonInfo {
  return {
    larkAppId: 'cli_a',
    botIndex: 0,
    ipcPort: 7950,
    pid: 200,
    processStartIdentity: 'bot-birth',
    rosterRevision: 'a'.repeat(64),
    bootInstanceId: 'boot-a',
    supervisorShutdownProtocol: SUPERVISOR_SHUTDOWN_PROTOCOL,
    lastHeartbeat: Date.now(),
    ...overrides,
  };
}

const processStarts = (pid: number): string | undefined => ({
  100: 'supervisor-birth',
  200: 'bot-birth',
  300: 'dashboard-birth',
}[pid]);

describe('immutable fleet launch plan', () => {
  it('is secret-free, round-trips strictly, and preserves a symlink alias', async () => {
    const root = tmp();
    const canonical = join(root, 'actual-bots.json');
    const alias = join(root, 'requested-bots.json');
    writeConfig(canonical);
    symlinkSync(canonical, alias);

    const captured = await withBotsJsonLock(alias, async lockedPath => {
      const roster = readDeviceIsolationRosterSnapshot({ configPath: alias });
      expect(lockedPath).toBe(canonical);
      return fleetLaunchPlanFromRoster(roster, lockedPath);
    });
    expect(captured.requestedConfigPath).toBe(alias);
    expect(captured.canonicalConfigPath).toBe(canonical);
    expect(captured.bots.map(bot => [bot.name, bot.appId, bot.botIndex])).toEqual([
      ['botmux-0', 'cli_a', 0],
      ['botmux-1', 'cli_b', 1],
    ]);
    const encoded = encodeFleetLaunchPlan(captured);
    expect(encoded).not.toContain('secret-cli_a');
    expect(decodeFleetLaunchPlan(encoded)).toEqual(captured);
    expect(() => decodeFleetLaunchPlan(`${encoded}=`)).toThrow(/fleet launch plan/);
    expect(() => decodeFleetLaunchPlan('a'.repeat(1024 * 1024 + 1))).toThrow(/oversized/);
  });

  it('fails closed on malformed, duplicate, or changed generations', () => {
    const plan = planFixture();
    expect(() => validateFleetLaunchPlan({ ...plan, extra: true })).toThrow(/malformed/);
    expect(() => validateFleetLaunchPlan({
      ...plan,
      bots: [...plan.bots, { name: 'botmux-0', appId: 'cli_b', botIndex: 1 }],
    })).toThrow(/duplicate/);

    const root = tmp();
    const path = join(root, 'bots.json');
    writeConfig(path, ['cli_a']);
    const r1 = readDeviceIsolationRosterSnapshot({ configPath: path });
    const pinned = fleetLaunchPlanFromRoster(r1);
    writeConfig(path, ['cli_a', 'cli_b']);
    const r2 = readDeviceIsolationRosterSnapshot({ configPath: path });
    expect(() => assertFleetLaunchPlanMatchesRoster(pinned, r2)).toThrow(/does not match/);
  });
});

describe('true readiness', () => {
  it('does not accept PID-only state without a modern exact descriptor', () => {
    const result = inspectFleetReadiness(
      planFixture(),
      { pid: 100, processStartIdentity: 'supervisor-birth' },
      stateFixture(),
      [],
      processStarts,
    );
    expect(result.supervisorReady).toBe(true);
    expect(result.daemonReadyNames).toEqual([]);
    expect(result.pending).toContain('botmux-0');
  });

  it.each([
    ['predecessor pid', { pid: 199 }],
    ['wrong process birth', { processStartIdentity: 'old-birth' }],
    ['wrong roster revision', { rosterRevision: 'b'.repeat(64) }],
    ['wrong index', { botIndex: 4 }],
    ['missing shutdown readiness', { supervisorShutdownProtocol: undefined }],
  ] as const)('rejects a descriptor with %s', (_label, change) => {
    const result = inspectFleetReadiness(
      planFixture(),
      { pid: 100, processStartIdentity: 'supervisor-birth' },
      stateFixture(),
      [descriptor(change)],
      processStarts,
    );
    expect(result.daemonReadyNames).toEqual([]);
    expect(result.pending).toContain('botmux-0');
  });

  it('requires the exact new supervisor process generation', () => {
    const wrong = inspectFleetReadiness(
      planFixture(),
      { pid: 100, processStartIdentity: 'predecessor-birth' },
      stateFixture(),
      [descriptor()],
      processStarts,
    );
    expect(wrong.supervisorReady).toBe(false);
    expect(wrong.pending).toContain('fleet-supervisor');

    const ready = inspectFleetReadiness(
      planFixture(),
      { pid: 100, processStartIdentity: 'supervisor-birth' },
      stateFixture(),
      [descriptor()],
      processStarts,
    );
    expect(ready).toMatchObject({
      supervisorReady: true, daemonReadyNames: ['botmux-0'], dashboardProcessReady: true, pending: [],
    });
  });

  it('accepts only success or exact no-active-token as dashboard readiness', () => {
    expect(dashboardCurrentProvesReadiness({ ok: true, url: 'http://dashboard' })).toBe(true);
    expect(dashboardCurrentProvesReadiness({ ok: false, reason: 'no-active-token' })).toBe(true);
    expect(dashboardCurrentProvesReadiness({ ok: false, reason: 'http-error' })).toBe(false);
    expect(dashboardCurrentProvesReadiness({ ok: false, reason: 'wrong-service' })).toBe(false);
    expect(dashboardCurrentProvesReadiness({ ok: false, reason: 'auth-failed' })).toBe(false);
    expect(dashboardCurrentProvesReadiness({ ok: false, reason: 'unreachable' })).toBe(false);
  });
});

describe('restart safety and breadcrumb ordering', () => {
  it('does not start a successor when stop times out', () => {
    const start = vi.fn((): StartFleetResult => ({
      action: 'started', supervisorPid: 123, supervisorProcessStartIdentity: 'birth', botCount: 1,
    }));
    const result = restartFleet(planFixture(), 1, {
      stop: () => ({ action: 'timeout', supervisorPid: 99 }),
      start,
    });
    expect(result.action).toBe('stop-timeout');
    expect(result.stop.action).toBe('timeout');
    expect(start).not.toHaveBeenCalled();
  });

  it('persists committed and exact aborted restart-attempt transitions', () => {
    const dir = tmp();
    const at = new Date().toISOString();
    writeRestartAttemptIntentTo(dir, { kind: 'manual', at }, Date.now(), 'attempt-ready');
    expect(consumeRestartIntentTo(dir, Date.now())).toBeNull();
    expect(commitRestartIntentAttemptTo(dir, 'attempt-ready')).toBe(true);
    expect(consumeRestartIntentTo(dir, Date.now())).toMatchObject({
      attemptId: 'attempt-ready', attemptState: 'committed',
    });

    writeRestartAttemptIntentTo(dir, { kind: 'manual', at }, Date.now(), 'attempt-failed');
    expect(removeRestartIntentAttemptTo(dir, 'attempt-failed')).toBe(true);
    expect(commitRestartIntentAttemptTo(dir, 'attempt-failed')).toBe(false);
    expect(readFileSync(join(dir, 'restart-intent.json'), 'utf8')).toContain('aborted:attempt-failed');
  });
});
