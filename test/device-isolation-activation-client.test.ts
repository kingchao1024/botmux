import { type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { OnlineDaemonInfo } from '../src/utils/daemon-discovery.js';
import {
  activateDeviceCredentialIsolation,
  DeviceIsolationDaemonActivationError,
} from '../src/platform/device-isolation-activation-client.js';
import { deviceCredentialIsolationMarkerPath } from '../src/adapters/cli/read-isolation.js';
import {
  ASK_RECEIPT_AUTHORITY_VERSION,
  ensureDeviceCredentialIsolationMarker,
  MAX_BOOT_INSTANCE_ID_BYTES,
  MAX_PARTICIPANTS,
  readDeviceCredentialIsolationMarker,
  withDeviceCredentialIsolationActivationLock,
} from '../src/platform/device-isolation.js';
import {
  adoptDeviceIsolationStartupReservation,
  bindDeviceIsolationStartupReservationToChild,
  clearDeviceIsolationStartupIntent,
  listBlockingDeviceIsolationStartupIntents,
  publishDeviceIsolationStartupIntent,
  reserveDeviceIsolationDaemonStartup,
} from '../src/services/device-isolation-startup-intent-store.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { readDeviceIsolationRosterSnapshot } from '../src/services/device-isolation-roster.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
let currentRosterRevision = 'a'.repeat(64);

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-device-activation-'));
  roots.push(root);
  writeRoster(root, ['cli_test']);
  return root;
}

function writeRoster(homeDir: string, appIds: string[]): void {
  const configDir = join(homeDir, '.botmux');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'bots.json'), `${JSON.stringify(appIds.map(larkAppId => ({
    larkAppId, larkAppSecret: 'test-secret',
  })), null, 2)}\n`, { mode: 0o600 });
  currentRosterRevision = readDeviceIsolationRosterSnapshot({ homeDir }).revision;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for lock-test barrier');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolvePromise());
  });
}

function spawnStartupLockHolder(
  homeDir: string,
  acquiredPath: string,
  releasePath?: string,
): ChildProcess {
  const moduleUrl = pathToFileURL(resolve('src/platform/device-isolation.ts')).href;
  const source = `
    const { existsSync, writeFileSync } = await import('node:fs');
    const { withDeviceCredentialIsolationActivationLock } = await import(${JSON.stringify(moduleUrl)});
    await withDeviceCredentialIsolationActivationLock(async () => {
      writeFileSync(${JSON.stringify(acquiredPath)}, 'acquired');
      ${releasePath
        ? `while (!existsSync(${JSON.stringify(releasePath)})) await new Promise(r => setTimeout(r, 10));`
        : 'await new Promise(() => { setInterval(() => {}, 1_000); });'}
    }, { homeDir: ${JSON.stringify(homeDir)} });
  `;
  const child = spawnTsEvalWithRepoImports(source, {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  return child;
}

function spawnBotsConfigWriter(
  configPath: string,
  acquiredPath: string,
): ChildProcess {
  const moduleUrl = pathToFileURL(resolve('src/setup/bots-store.ts')).href;
  const source = `
    const { writeFileSync } = await import('node:fs');
    const { withBotsJsonLockSync } = await import(${JSON.stringify(moduleUrl)});
    withBotsJsonLockSync(${JSON.stringify(configPath)}, () => {
      writeFileSync(${JSON.stringify(acquiredPath)}, 'acquired');
    });
  `;
  const child = spawnTsEvalWithRepoImports(source, {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  return child;
}

function daemonDescriptor(overrides: Partial<OnlineDaemonInfo> = {}): OnlineDaemonInfo {
  return {
    larkAppId: 'cli_test',
    ipcPort: 12345,
    bootInstanceId: 'boot-1',
    rosterRevision: currentRosterRevision,
    pid: 321,
    processStartIdentity: 'proc-321',
    lastHeartbeat: Date.now(),
    ...overrides,
  };
}

describe('activateDeviceCredentialIsolation', () => {
  it.each([
    { name: 'missing', configured: ['cli_a', 'cli_b'], online: [daemonDescriptor({ larkAppId: 'cli_a' })] },
    { name: 'extra', configured: ['cli_a'], online: [daemonDescriptor({ larkAppId: 'cli_a' }), daemonDescriptor({ larkAppId: 'cli_extra', ipcPort: 12346 })] },
    { name: 'duplicate', configured: ['cli_a'], online: [daemonDescriptor({ larkAppId: 'cli_a' }), daemonDescriptor({ larkAppId: 'cli_a', ipcPort: 12346, pid: 322, processStartIdentity: 'proc-322' })] },
  ])('rejects $name online membership before creating PENDING', async ({ configured, online }) => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeRoster(homeDir, configured);
    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: { listDaemons: () => online, expectedDataDir: dataDir },
    })).rejects.toThrow(/inventory_changed/);
    expect(readDeviceCredentialIsolationMarker({ homeDir })).toBeNull();
  });

  it('refuses to reach ACTIVE while another daemon startup intent is still live, then succeeds after it clears', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeRoster(homeDir, ['cli_a', 'cli_b']);
    const startupIntent = publishDeviceIsolationStartupIntent({
      homeDir,
      larkAppId: 'cli_b',
      bootInstanceId: 'boot-b',
    });
    const first = daemonDescriptor({
      larkAppId: 'cli_a',
      ipcPort: 12345,
      bootInstanceId: 'boot-a',
      pid: 321,
      processStartIdentity: 'proc-a',
    });
    const second = daemonDescriptor({
      larkAppId: 'cli_b',
      ipcPort: 12346,
      bootInstanceId: 'boot-b',
      pid: startupIntent.pid,
      processStartIdentity: startupIntent.processStartIdentity,
    });
    let prepareCalls = 0;
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path.endsWith('/prepare')) prepareCalls += 1;
      const descriptor = _port === first.ipcPort ? first : second;
      return new Response(JSON.stringify({
        ok: true,
        activationVersion: 1,
        receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1,
        nonce: body.nonce,
        leaseId: `${descriptor.larkAppId}-lease-${prepareCalls}`,
        expiresAt: Date.now() + 30_000,
        inventoryGeneration: `g${prepareCalls}`,
        daemon: {
          larkAppId: descriptor.larkAppId,
          bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid,
          procStart: descriptor.processStartIdentity,
          dataDir,
        },
      }));
    };

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [first, second],
        fetchDaemon: fakeFetch,
        processStart: pid => new Map<number, string>([
          [321, 'proc-a'],
          [startupIntent.pid, startupIntent.processStartIdentity],
        ]).get(pid),
        nonceFactory: () => 'i'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).rejects.toThrow(/inventory_changed/);

    expect(readDeviceCredentialIsolationMarker({ homeDir })).toBeNull();
    expect(listBlockingDeviceIsolationStartupIntents({ homeDir })).toHaveLength(1);

    expect(clearDeviceIsolationStartupIntent({
      homeDir,
      intentId: startupIntent.intentId,
      processIdentity: {
        pid: startupIntent.pid,
        processStartIdentity: startupIntent.processStartIdentity,
      },
    })).toBe(true);

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [first, second],
        fetchDaemon: fakeFetch,
        processStart: pid => new Map<number, string>([
          [321, 'proc-a'],
          [startupIntent.pid, startupIntent.processStartIdentity],
        ]).get(pid),
        nonceFactory: () => 'j'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).resolves.toMatchObject({ activated: true, daemonCount: 2 });
  });

  it('serializes a real startup holder against activation before daemon discovery', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const acquiredPath = join(homeDir, 'startup-acquired');
    const releasePath = join(homeDir, 'release-startup');
    const child = spawnStartupLockHolder(homeDir, acquiredPath, releasePath);
    await waitUntil(() => existsSync(acquiredPath));

    const descriptor = daemonDescriptor();
    let discoveryCalls = 0;
    const activation = activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => { discoveryCalls += 1; return [descriptor]; },
        fetchDaemon: async (_port, path, init) => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({
            ok: true,
            activationVersion: 1,
            receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
            receiptAuthorityProtocolVersion: 1,
            nonce: body.nonce,
            leaseId: 'lease-serialized',
            expiresAt: Date.now() + 30_000,
            inventoryGeneration: path.endsWith('/prepare') ? 'g1' : 'g2',
            daemon: {
              larkAppId: descriptor.larkAppId,
              bootInstanceId: descriptor.bootInstanceId,
              rosterRevision: descriptor.rosterRevision,
              pid: descriptor.pid,
              procStart: descriptor.processStartIdentity,
              dataDir,
            },
          }));
        },
        processStart: () => descriptor.processStartIdentity,
        nonceFactory: () => 's'.repeat(43),
        expectedDataDir: dataDir,
      },
    });

    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    expect(discoveryCalls).toBe(0);
    writeFileSync(releasePath, 'release');
    await waitForExit(child);
    await expect(activation).resolves.toMatchObject({ activated: true, daemonCount: 1 });
    expect(discoveryCalls).toBe(3);
  });

  it('releases the shared activation lock when activation setup fails', async () => {
    const homeDir = tempRoot();
    mkdirSync(join(homeDir, '.botmux'), { recursive: true, mode: 0o700 });
    const failure = new Error('injected discovery failure');

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: { listDaemons: () => { throw failure; } },
    })).rejects.toBe(failure);
    expect(existsSync(`${deviceCredentialIsolationMarkerPath(homeDir)}.lock`)).toBe(false);
    await expect(withDeviceCredentialIsolationActivationLock(
      async () => 'reacquired',
      { homeDir, lock: { maxWaitMs: 500 } },
    )).resolves.toBe('reacquired');
  });

  it('reclaims the shared startup lock after the daemon process crashes', async () => {
    const homeDir = tempRoot();
    mkdirSync(join(homeDir, '.botmux'), { recursive: true, mode: 0o700 });
    const acquiredPath = join(homeDir, 'crashed-startup-acquired');
    const child = spawnStartupLockHolder(homeDir, acquiredPath);
    await waitUntil(() => existsSync(acquiredPath));

    child.kill('SIGKILL');
    await waitForExit(child);
    await expect(withDeviceCredentialIsolationActivationLock(
      async () => 'recovered',
      { homeDir, lock: { maxWaitMs: 2_000, minStaleAgeMs: 0 } },
    )).resolves.toBe('recovered');
    expect(existsSync(`${deviceCredentialIsolationMarkerPath(homeDir)}.lock`)).toBe(false);
  });

  it('reclaims a stale startup intent after a SIGKILL using exact pid/process-start proof', async () => {
    const homeDir = tempRoot();
    const moduleUrl = pathToFileURL(resolve('src/services/device-isolation-startup-intent-store.ts')).href;
    const source = `
      const { publishDeviceIsolationStartupIntent } = await import(${JSON.stringify(moduleUrl)});
      const published = publishDeviceIsolationStartupIntent({
        homeDir: ${JSON.stringify(homeDir)},
        larkAppId: 'cli_b',
        bootInstanceId: 'boot-b',
      });
      process.stdout.write(JSON.stringify(published));
      await new Promise(() => { setInterval(() => {}, 1_000); });
    `;
    const child = spawnTsEvalWithRepoImports(source, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const raw = await new Promise<string>((resolvePromise, reject) => {
      let stdout = '';
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.once('error', reject);
      child.stdout?.once('data', () => resolvePromise(stdout + ''));
    });
    const published = JSON.parse(raw) as ReturnType<typeof publishDeviceIsolationStartupIntent>;
    child.kill('SIGKILL');
    await waitForExit(child);

    expect(listBlockingDeviceIsolationStartupIntents({ homeDir })).toEqual([]);
  });

  it('binds and adopts a parent pre-spawn reservation with exact token, pid and roster revision', () => {
    const homeDir = tempRoot();
    const reservation = reserveDeviceIsolationDaemonStartup({
      homeDir, larkAppId: 'cli_test', rosterRevision: 'a'.repeat(64),
    });
    expect(bindDeviceIsolationStartupReservationToChild({
      homeDir, ...reservation, childPid: process.pid,
    })).toBe(true);
    const adopted = adoptDeviceIsolationStartupReservation({
      homeDir, ...reservation, larkAppId: 'cli_test',
      bootInstanceId: 'boot-child', rosterRevision: 'a'.repeat(64),
    });
    expect(adopted).toMatchObject({
      phase: 'starting', larkAppId: 'cli_test', pid: process.pid,
    });
    expect(clearDeviceIsolationStartupIntent({
      homeDir, intentId: reservation.intentId, reservationToken: reservation.reservationToken,
    })).toBe(true);
  });

  it('rejects reservation adoption after non-App roster configuration drifts', () => {
    const homeDir = tempRoot();
    const configPath = join(homeDir, '.botmux', 'bots.json');
    const before = readDeviceIsolationRosterSnapshot({ configPath });
    const reservation = reserveDeviceIsolationDaemonStartup({
      homeDir, larkAppId: 'cli_test', rosterRevision: before.revision,
    });
    expect(bindDeviceIsolationStartupReservationToChild({
      homeDir, ...reservation, childPid: process.pid,
    })).toBe(true);
    writeFileSync(configPath, `${JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'changed-secret', backendType: 'zellij',
    }])}\n`, { mode: 0o600 });
    const after = readDeviceIsolationRosterSnapshot({ configPath });
    expect(after.appIds).toEqual(before.appIds);
    expect(after.rosterSha256).toBe(before.rosterSha256);
    expect(after.revision).not.toBe(before.revision);
    expect(() => adoptDeviceIsolationStartupReservation({
      homeDir, ...reservation, larkAppId: 'cli_test',
      bootInstanceId: 'boot-child', rosterRevision: after.revision,
    })).toThrow(/identity mismatch/);
    clearDeviceIsolationStartupIntent({
      homeDir, intentId: reservation.intentId, reservationToken: reservation.reservationToken,
    });
  });

  it('freezes every daemon before marker write, commits, reasserts and releases', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const calls: Array<{ path: string; body: Record<string, unknown>; markerExists: boolean }> = [];
    const descriptor = daemonDescriptor();
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({
        path,
        body,
        markerExists: (() => {
          try { readFileSync(deviceCredentialIsolationMarkerPath(homeDir)); return true; }
          catch { return false; }
        })(),
      });
      return new Response(JSON.stringify({
        ok: true,
        activationVersion: 1,
        receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1,
        nonce: body.nonce,
        leaseId: 'lease-1',
        expiresAt: Date.now() + 30_000,
        inventoryGeneration: path.endsWith('/prepare') ? 'g1' : 'g2',
        daemon: {
          larkAppId: descriptor.larkAppId,
          bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid,
          procStart: 'proc-321',
          dataDir,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await activateDeviceCredentialIsolation({
      homeDir,
      now: () => new Date('2026-07-22T00:00:00.000Z'),
      dependencies: {
        listDaemons: () => [descriptor],
        fetchDaemon: fakeFetch,
        processStart: pid => pid === 321 ? 'proc-321' : undefined,
        nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    });

    expect(result).toMatchObject({ activated: true, daemonCount: 1 });
    expect(result.markerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls.map(call => call.path)).toEqual([
      '/api/device-isolation/activation/prepare',
      '/api/device-isolation/activation/commit',
      '/api/device-isolation/activation/release',
    ]);
    expect(calls.every(call => call.body.rosterRevision === descriptor.rosterRevision)).toBe(true);
    expect(calls[0].markerExists).toBe(false);
    expect(calls[1].markerExists).toBe(true);
    expect(calls[2].markerExists).toBe(true);
    expect(calls[1].body.markerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[1].body.markerSha256).not.toBe(result.markerSha256);
    expect(calls[2].body.markerSha256).toBe(result.markerSha256);
  });

  it('rejects a 257-participant ACTIVE marker before any commit and preserves PENDING', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const appIds = Array.from(
      { length: MAX_PARTICIPANTS + 1 },
      (_, index) => `cli_capacity_${index}`,
    );
    writeRoster(homeDir, appIds);
    const daemons = appIds.map((larkAppId, index) => daemonDescriptor({
      larkAppId,
      ipcPort: 20_000 + index,
      bootInstanceId: `boot-${index}`,
      pid: 10_000 + index,
      processStartIdentity: `proc-${index}`,
    }));
    const daemonByPort = new Map(daemons.map(daemon => [daemon.ipcPort, daemon]));
    const pending = ensureDeviceCredentialIsolationMarker({ homeDir });
    const pendingRaw = readFileSync(pending.path, 'utf8');
    const paths: string[] = [];

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => daemons,
        fetchDaemon: async (port, path, init) => {
          paths.push(path);
          const daemon = daemonByPort.get(port)!;
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({
            ok: true,
            activationVersion: 1,
            receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
            receiptAuthorityProtocolVersion: 1,
            nonce: body.nonce,
            leaseId: `lease-${daemon.pid}`,
            expiresAt: Date.now() + 30_000,
            inventoryGeneration: 'capacity-generation',
            daemon: {
              larkAppId: daemon.larkAppId,
              bootInstanceId: daemon.bootInstanceId,
              rosterRevision: daemon.rosterRevision,
              pid: daemon.pid,
              procStart: daemon.processStartIdentity,
              dataDir,
            },
          }));
        },
        processStart: pid => daemonByPort.get(20_000 + pid - 10_000)?.processStartIdentity,
        nonceFactory: () => 'c'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).rejects.toThrow();

    expect(paths.filter(path => path.endsWith('/commit'))).toHaveLength(0);
    expect(readFileSync(pending.path, 'utf8')).toBe(pendingRaw);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');
  });

  it('rejects an oversized participant field before any commit and preserves PENDING', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const descriptor = daemonDescriptor({
      bootInstanceId: 'b'.repeat(MAX_BOOT_INSTANCE_ID_BYTES + 1),
    });
    const pending = ensureDeviceCredentialIsolationMarker({ homeDir });
    const pendingRaw = readFileSync(pending.path, 'utf8');
    const paths: string[] = [];

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor],
        fetchDaemon: async (_port, path, init) => {
          paths.push(path);
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({
            ok: true,
            activationVersion: 1,
            receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
            receiptAuthorityProtocolVersion: 1,
            nonce: body.nonce,
            leaseId: 'lease-oversized-field',
            expiresAt: Date.now() + 30_000,
            inventoryGeneration: 'oversized-field-generation',
            daemon: {
              larkAppId: descriptor.larkAppId,
              bootInstanceId: descriptor.bootInstanceId,
              rosterRevision: descriptor.rosterRevision,
              pid: descriptor.pid,
              procStart: descriptor.processStartIdentity,
              dataDir,
            },
          }));
        },
        processStart: () => descriptor.processStartIdentity,
        nonceFactory: () => 'f'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).rejects.toThrow();

    expect(paths.filter(path => path.endsWith('/commit'))).toHaveLength(0);
    expect(readFileSync(pending.path, 'utf8')).toBe(pendingRaw);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');
  });

  it('treats an existing valid marker as a completed one-way transition', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const deps = {
      listDaemons: () => { throw new Error('must not enumerate daemons'); },
      expectedDataDir: dataDir,
    };
    // First call creates the marker through the full fake transaction.
    const descriptor = daemonDescriptor();
    const fakeFetch = async (_port: number, _path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1,
        nonce: body.nonce, leaseId: 'lease-1',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g1',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid, procStart: 'proc-321', dataDir,
        },
      }));
    };
    await activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => 'proc-321', nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    });
    const result = await activateDeviceCredentialIsolation({ homeDir, dependencies: deps });
    expect(result.activated).toBe(false);
    expect(result.daemonCount).toBe(0);
  });

  it('rejects an old daemon before creating the marker', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [daemonDescriptor({ bootInstanceId: undefined })],
        expectedDataDir: dataDir,
      },
    })).rejects.toBeInstanceOf(DeviceIsolationDaemonActivationError);
    expect(() => readFileSync(deviceCredentialIsolationMarkerPath(homeDir))).toThrow();
  });

  it('rejects an R1 descriptor after the authoritative roster advances to R2', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const r1 = currentRosterRevision;
    writeFileSync(join(homeDir, '.botmux', 'bots.json'), `${JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'rotated-secret', sandbox: true,
    }])}\n`, { mode: 0o600 });
    const r2 = readDeviceIsolationRosterSnapshot({ homeDir }).revision;
    expect(r2).not.toBe(r1);
    let fetchCalls = 0;

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [daemonDescriptor({ rosterRevision: r1 })],
        fetchDaemon: async () => { fetchCalls += 1; return new Response(); },
        expectedDataDir: dataDir,
      },
    })).rejects.toThrow(/inventory_changed/);
    expect(fetchCalls).toBe(0);
    expect(readDeviceCredentialIsolationMarker({ homeDir })).toBeNull();
  });

  it('rejects an activation response that omits the descriptor roster revision', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const descriptor = daemonDescriptor();
    const paths: string[] = [];
    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor],
        fetchDaemon: async (_port, path, init) => {
          paths.push(path);
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({
            ok: true,
            activationVersion: 1,
            receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
            receiptAuthorityProtocolVersion: 1,
            nonce: body.nonce,
            leaseId: 'lease-r1',
            expiresAt: Date.now() + 30_000,
            inventoryGeneration: 'g-r1',
            daemon: {
              larkAppId: descriptor.larkAppId,
              bootInstanceId: descriptor.bootInstanceId,
              pid: descriptor.pid,
              procStart: descriptor.processStartIdentity,
              dataDir,
            },
          }));
        },
        processStart: () => descriptor.processStartIdentity,
        nonceFactory: () => 'r'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).rejects.toThrow(/身份字段无效/);
    expect(paths).toEqual(['/api/device-isolation/activation/prepare']);
    expect(readDeviceCredentialIsolationMarker({ homeDir })).toBeNull();
  });

  it('rejects a response bound to another daemon instance and releases its lease', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const paths: string[] = [];
    const descriptor = daemonDescriptor();
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      paths.push(path);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1,
        nonce: body.nonce, leaseId: 'lease-1',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g1',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: 'wrong-boot',
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid, procStart: 'proc-321', dataDir,
        },
      }));
    };
    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => 'proc-321', nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).rejects.toThrow(/身份不匹配/);
    expect(paths).toEqual([
      '/api/device-isolation/activation/prepare',
      '/api/device-isolation/activation/release',
    ]);
  });

  it('never treats a marker left by a failed commit as completed', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const descriptor = daemonDescriptor();
    let failCommit = true;
    let prepareCalls = 0;
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path.endsWith('/prepare')) prepareCalls += 1;
      if (path.endsWith('/commit') && failCommit) {
        return new Response(JSON.stringify({ error: 'quiesce_failed' }), { status: 503 });
      }
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1,
        nonce: body.nonce, leaseId: 'lease-1',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g1',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid, procStart: 'proc-321', dataDir,
        },
      }));
    };
    const options = {
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => 'proc-321', nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    };

    await expect(activateDeviceCredentialIsolation(options)).rejects.toThrow(/quiesce_failed/);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');
    failCommit = false;
    await expect(activateDeviceCredentialIsolation(options)).resolves.toMatchObject({ activated: true });
    expect(prepareCalls).toBe(2);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('active');
  });

  it('automatically retries once when commit reports inventory_changed', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const descriptor = daemonDescriptor();
    let prepareCalls = 0;
    let commitCalls = 0;
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path.endsWith('/prepare')) prepareCalls += 1;
      if (path.endsWith('/commit')) {
        commitCalls += 1;
        if (commitCalls === 1) {
          return new Response(JSON.stringify({ error: 'inventory_changed' }), { status: 409 });
        }
      }
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1,
        nonce: body.nonce, leaseId: `lease-${prepareCalls}`,
        expiresAt: Date.now() + 30_000, inventoryGeneration: `g${prepareCalls}`,
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid, procStart: 'proc-321', dataDir,
        },
      }));
    };

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => 'proc-321', nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).resolves.toMatchObject({ activated: true, daemonCount: 1 });
    expect(prepareCalls).toBe(2);
    expect(commitCalls).toBe(2);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('active');
  });

  it('rechecks daemon membership immediately before ACTIVE and retries when it changed', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeRoster(homeDir, ['cli_a', 'cli_b']);
    const first = daemonDescriptor({
      larkAppId: 'cli_a',
      ipcPort: 12345,
      bootInstanceId: 'boot-a',
      pid: 321,
      processStartIdentity: 'proc-a',
    });
    const second = daemonDescriptor({
      larkAppId: 'cli_b',
      ipcPort: 12346,
      bootInstanceId: 'boot-b',
      pid: 322,
      processStartIdentity: 'proc-b',
    });
    let membershipRead = 0;
    const listDaemons = () => {
      membershipRead += 1;
      if (membershipRead === 2) {
        return [first, { ...second, bootInstanceId: 'boot-b-restarted', pid: 323, processStartIdentity: 'proc-b-restarted' }];
      }
      return [first, second];
    };
    let prepareCalls = 0;
    let commitCalls = 0;
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path.endsWith('/prepare')) prepareCalls += 1;
      if (path.endsWith('/commit')) commitCalls += 1;
      const descriptor = _port === first.ipcPort ? first : second;
      return new Response(JSON.stringify({
        ok: true,
        activationVersion: 1,
        receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1,
        nonce: body.nonce,
        leaseId: `${descriptor.larkAppId}-lease-${prepareCalls}`,
        expiresAt: Date.now() + 30_000,
        inventoryGeneration: `g${prepareCalls}`,
        daemon: {
          larkAppId: descriptor.larkAppId,
          bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid,
          procStart: descriptor.processStartIdentity,
          dataDir,
        },
      }));
    };

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons,
        fetchDaemon: fakeFetch,
        processStart: pid => new Map<number, string>([
          [321, 'proc-a'],
          [322, 'proc-b'],
          [323, 'proc-b-restarted'],
        ]).get(pid),
        nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).resolves.toMatchObject({ activated: true, daemonCount: 2 });

    expect(prepareCalls).toBe(4);
    expect(commitCalls).toBe(2);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('active');
  });

  it('completes without retry when daemon membership is unchanged at the pre-ACTIVE recheck', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeRoster(homeDir, ['cli_a', 'cli_b']);
    const first = daemonDescriptor({
      larkAppId: 'cli_a',
      ipcPort: 12345,
      bootInstanceId: 'boot-a',
      pid: 321,
      processStartIdentity: 'proc-a',
    });
    const second = daemonDescriptor({
      larkAppId: 'cli_b',
      ipcPort: 12346,
      bootInstanceId: 'boot-b',
      pid: 322,
      processStartIdentity: 'proc-b',
    });
    let prepareCalls = 0;
    let commitCalls = 0;
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path.endsWith('/prepare')) prepareCalls += 1;
      if (path.endsWith('/commit')) commitCalls += 1;
      const descriptor = _port === first.ipcPort ? first : second;
      return new Response(JSON.stringify({
        ok: true,
        activationVersion: 1,
        receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1,
        nonce: body.nonce,
        leaseId: `${descriptor.larkAppId}-lease-${prepareCalls}`,
        expiresAt: Date.now() + 30_000,
        inventoryGeneration: `g${prepareCalls}`,
        daemon: {
          larkAppId: descriptor.larkAppId,
          bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid,
          procStart: descriptor.processStartIdentity,
          dataDir,
        },
      }));
    };

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [first, second],
        fetchDaemon: fakeFetch,
        processStart: pid => new Map<number, string>([
          [321, 'proc-a'],
          [322, 'proc-b'],
        ]).get(pid),
        nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).resolves.toMatchObject({ activated: true, daemonCount: 2 });

    expect(prepareCalls).toBe(2);
    expect(commitCalls).toBe(2);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('active');
  });

  it('does not accept a legacy active marker without the receipt epoch as already complete', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const markerPath = deviceCredentialIsolationMarkerPath(homeDir);
    writeFileSync(markerPath, `${JSON.stringify({
      version: 1,
      state: 'active',
      enabledAt: '2026-07-22T00:00:00.000Z',
      activatedAt: '2026-07-22T00:01:00.000Z',
    }, null, 2)}\n`, { mode: 0o600 });
    const descriptor = daemonDescriptor();
    const calls: string[] = [];
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      calls.push(path);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        ok: true,
        activationVersion: 1,
        receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1,
        nonce: body.nonce,
        leaseId: 'lease-1',
        expiresAt: Date.now() + 30_000,
        inventoryGeneration: 'g1',
        daemon: {
          larkAppId: descriptor.larkAppId,
          bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid,
          procStart: 'proc-321',
          dataDir,
        },
      }));
    };

    const result = await activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor],
        fetchDaemon: fakeFetch,
        processStart: () => 'proc-321',
        nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    });

    expect(result).toMatchObject({ activated: true, daemonCount: 1 });
    expect(calls).toEqual([
      '/api/device-isolation/activation/prepare',
      '/api/device-isolation/activation/commit',
      '/api/device-isolation/activation/release',
    ]);
    expect(readDeviceCredentialIsolationMarker({ homeDir })).toMatchObject({
      state: 'active',
      askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
    });
  });

  it('never publishes ACTIVE when a daemon reserves startup after commit', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const descriptor = daemonDescriptor();
    let reservation: ReturnType<typeof reserveDeviceIsolationDaemonStartup> | undefined;
    const fakeFetch = async (_port: number, _path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1, nonce: body.nonce, leaseId: 'lease-final-gap',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g-final-gap',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision,
          pid: descriptor.pid, procStart: descriptor.processStartIdentity, dataDir,
        },
      }));
    };
    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => descriptor.processStartIdentity,
        nonceFactory: () => 'z'.repeat(43), expectedDataDir: dataDir,
        beforeActive: () => {
          reservation ??= reserveDeviceIsolationDaemonStartup({
            homeDir, larkAppId: 'cli_test', rosterRevision: 'b'.repeat(64),
          });
        },
      },
    })).rejects.toThrow(/inventory_changed/);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');
    expect(reservation).toBeDefined();
    clearDeviceIsolationStartupIntent({
      homeDir, intentId: reservation!.intentId, reservationToken: reservation!.reservationToken,
    });
  });

  it('never publishes ACTIVE when non-App roster configuration drifts after commit', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    const configPath = join(homeDir, '.botmux', 'bots.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const descriptor = daemonDescriptor();
    const currentDescriptor = () => ({
      ...descriptor,
      rosterRevision: readDeviceIsolationRosterSnapshot({ homeDir }).revision,
    });
    let driftGeneration = 0;
    const fakeFetch = async (_port: number, _path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1, nonce: body.nonce, leaseId: 'lease-config-drift',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g-config-drift',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: currentDescriptor().rosterRevision,
          pid: descriptor.pid, procStart: descriptor.processStartIdentity, dataDir,
        },
      }));
    };
    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [currentDescriptor()], fetchDaemon: fakeFetch,
        processStart: () => descriptor.processStartIdentity,
        nonceFactory: () => 'y'.repeat(43), expectedDataDir: dataDir,
        beforeActive: () => {
          driftGeneration += 1;
          writeFileSync(configPath, `${JSON.stringify([{
            larkAppId: 'cli_test',
            larkAppSecret: `rotated-secret-${driftGeneration}`,
            sandbox: true,
          }])}\n`, { mode: 0o600 });
        },
      },
    })).rejects.toThrow(/inventory_changed/);
    expect(driftGeneration).toBe(2);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');
  });

  it('holds the real bots-config writer lock through activation and releases it afterwards', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    const configPath = join(homeDir, '.botmux', 'bots.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const descriptor = daemonDescriptor();
    const acquiredPath = join(homeDir, 'writer-acquired');
    let writer: ChildProcess | undefined;
    let observedBlocked = false;
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path.endsWith('/prepare')) {
        writer = spawnBotsConfigWriter(configPath, acquiredPath);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
        observedBlocked = !existsSync(acquiredPath);
      }
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1, nonce: body.nonce, leaseId: 'lease-lock-order',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g-lock-order',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision, pid: descriptor.pid,
          procStart: descriptor.processStartIdentity, dataDir,
        },
      }));
    };

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => descriptor.processStartIdentity,
        nonceFactory: () => 'l'.repeat(43), expectedDataDir: dataDir,
      },
    })).resolves.toMatchObject({ activated: true });
    expect(observedBlocked).toBe(true);
    expect(writer).toBeDefined();
    await waitForExit(writer!);
    expect(readFileSync(acquiredPath, 'utf8')).toBe('acquired');
  });

  it.runIf(process.platform !== 'win32')('fails closed when the configured alias retargets before lock acquisition', async () => {
    const homeDir = tempRoot();
    const configDir = join(homeDir, '.botmux');
    const aliasPath = join(configDir, 'bots.json');
    const firstTarget = join(configDir, 'fleet-a.json');
    const secondTarget = join(configDir, 'fleet-b.json');
    renameSync(aliasPath, firstTarget);
    writeFileSync(secondTarget, readFileSync(firstTarget), { mode: 0o600 });
    symlinkSync(firstTarget, aliasPath);
    let daemonReads = 0;
    let initialRead = true;

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        readRoster: (lockedConfigPath) => {
          const roster = readDeviceIsolationRosterSnapshot({
            configPath: lockedConfigPath ?? aliasPath,
          });
          if (initialRead) {
            initialRead = false;
            unlinkSync(aliasPath);
            symlinkSync(secondTarget, aliasPath);
          }
          return roster;
        },
        listDaemons: () => { daemonReads += 1; return []; },
      },
    })).rejects.toThrow(/inventory_changed/);

    expect(daemonReads).toBe(0);
    expect(readDeviceCredentialIsolationMarker({ homeDir })).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('never publishes ACTIVE when the configured alias retargets during activation', async () => {
    const homeDir = tempRoot();
    const configDir = join(homeDir, '.botmux');
    const dataDir = join(configDir, 'data');
    const aliasPath = join(configDir, 'bots.json');
    const firstTarget = join(configDir, 'fleet-a.json');
    const secondTarget = join(configDir, 'fleet-b.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    renameSync(aliasPath, firstTarget);
    writeFileSync(secondTarget, readFileSync(firstTarget), { mode: 0o600 });
    symlinkSync(firstTarget, aliasPath);
    const roster = readDeviceIsolationRosterSnapshot({ configPath: aliasPath });
    const descriptor = daemonDescriptor({ rosterRevision: roster.revision });
    const paths: string[] = [];
    let committed = false;
    let abortReleaseCalls = 0;
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      paths.push(path);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path.endsWith('/commit')) committed = true;
      if (path.endsWith('/release') && body.abort === true && committed) {
        abortReleaseCalls += 1;
        return new Response(JSON.stringify({ error: 'activation_committed' }), { status: 409 });
      }
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1, nonce: body.nonce, leaseId: 'lease-alias-retarget',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g-alias-retarget',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision, pid: descriptor.pid,
          procStart: descriptor.processStartIdentity, dataDir,
        },
      }));
    };

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        readRoster: configPath => readDeviceIsolationRosterSnapshot({
          configPath: configPath ?? aliasPath,
        }),
        listDaemons: () => [descriptor],
        fetchDaemon: fakeFetch,
        processStart: () => descriptor.processStartIdentity,
        nonceFactory: () => 't'.repeat(43),
        expectedDataDir: dataDir,
        beforeActive: () => {
          unlinkSync(aliasPath);
          symlinkSync(secondTarget, aliasPath);
        },
      },
    })).rejects.toThrow(/target changed during operation/);

    expect(paths).toContain('/api/device-isolation/activation/release');
    expect(abortReleaseCalls).toBe(1);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');
  });

  it.runIf(process.platform !== 'win32')('serializes a symlink-addressed writer on the same canonical target lock as activation', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    const configPath = join(homeDir, '.botmux', 'bots.json');
    const aliasPath = join(homeDir, '.botmux', 'fleet-alias.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    symlinkSync(configPath, aliasPath);
    const descriptor = daemonDescriptor();
    const acquiredPath = join(homeDir, 'symlink-writer-acquired');
    let writer: ChildProcess | undefined;
    let observedBlocked = false;
    const fakeFetch = async (_port: number, _path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (_path.endsWith('/prepare')) {
        writer = spawnBotsConfigWriter(aliasPath, acquiredPath);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
        observedBlocked = !existsSync(acquiredPath);
      }
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        receiptAuthorityProtocolVersion: 1, nonce: body.nonce, leaseId: 'lease-symlink-lock',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g-symlink-lock',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          rosterRevision: descriptor.rosterRevision, pid: descriptor.pid,
          procStart: descriptor.processStartIdentity, dataDir,
        },
      }));
    };

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => descriptor.processStartIdentity,
        nonceFactory: () => 'q'.repeat(43), expectedDataDir: dataDir,
      },
    })).resolves.toMatchObject({ activated: true });
    expect(observedBlocked).toBe(true);
    expect(writer).toBeDefined();
    await waitForExit(writer!);
    expect(readFileSync(acquiredPath, 'utf8')).toBe('acquired');
  });
});
