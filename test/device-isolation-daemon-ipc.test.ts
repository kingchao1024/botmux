import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { cliAuthBind, signCliAuth } from '../src/dashboard/auth.js';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import {
  DEVICE_ISOLATION_COMMIT_PATH,
  DEVICE_ISOLATION_PREPARE_PATH,
  DEVICE_ISOLATION_RELEASE_PATH,
  resetDeviceIsolationDaemonForTest,
  setDeviceIsolationDaemonDependenciesForTest,
  setDeviceIsolationDaemonIdentity,
} from '../src/core/device-isolation-daemon.js';
import { resetDeviceIsolationActivationForTest } from '../src/core/device-isolation-activation.js';
import { ASK_RECEIPT_AUTHORITY_VERSION } from '../src/platform/device-isolation.js';

const SECRET = 'device-isolation-ipc-test-secret';
const NONCE = 'i'.repeat(43);
const ROSTER_REVISION = 'a'.repeat(64);
const BOTS_CONFIG_PATH = '/tmp/device-isolation-ipc-bots.json';
let handle: IpcServerHandle | null = null;

function digest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function headers(path: string, port: number): Record<string, string> {
  const auth = signCliAuth(SECRET, cliAuthBind('POST', path, port));
  return {
    'content-type': 'application/json',
    'x-botmux-cli-ts': auth.ts,
    'x-botmux-cli-nonce': auth.nonce,
    'x-botmux-cli-auth': auth.sig,
  };
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  if (!handle) throw new Error('server not started');
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers: headers(path, handle.port),
    body: JSON.stringify({ rosterRevision: ROSTER_REVISION, ...body }),
  });
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  resetDeviceIsolationDaemonForTest();
  resetDeviceIsolationActivationForTest();
});

describe('device-isolation daemon IPC', () => {
  it('requires route-bound host HMAC and completes prepare/commit/release', async () => {
    const now = Date.now();
    let marker = `${JSON.stringify({
      version: 1,
      state: 'pending',
      enabledAt: new Date(now).toISOString(),
    })}\n`;
    setIpcAuthSecret(SECRET);
    setDeviceIsolationDaemonIdentity({
      larkAppId: 'cli_ipc',
      bootInstanceId: 'boot-ipc',
      botsConfigPath: BOTS_CONFIG_PATH,
      rosterRevision: ROSTER_REVISION,
    });
    setDeviceIsolationDaemonDependenciesForTest({
      now: () => now,
      dataDir: () => '/tmp/device-isolation-ipc-data',
      listSessions: () => [],
      processStart: pid => pid === process.pid ? 'daemon-start' : undefined,
      processExists: () => false,
      readRosterRevision: () => ROSTER_REVISION,
      readMarker: () => marker,
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

    const unauthenticated = await fetch(
      `http://127.0.0.1:${handle.port}${DEVICE_ISOLATION_PREPARE_PATH}`,
      { method: 'POST', body: '{}' },
    );
    expect(unauthenticated.status).toBe(401);

    const preparedResponse = await post(DEVICE_ISOLATION_PREPARE_PATH, {
      activationVersion: 1,
      nonce: NONCE,
    });
    expect(preparedResponse.status).toBe(200);
    const prepared = await preparedResponse.json() as Record<string, unknown>;
    expect(prepared).toMatchObject({
      ok: true,
      nonce: NONCE,
      phase: 'prepared',
      receiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
      receiptAuthorityProtocolVersion: 1,
      daemon: {
        larkAppId: 'cli_ipc',
        bootInstanceId: 'boot-ipc',
        rosterRevision: 'a'.repeat(64),
      },
    });

    const leaseId = prepared.leaseId as string;
    const committed = await post(DEVICE_ISOLATION_COMMIT_PATH, {
      activationVersion: 1,
      nonce: NONCE,
      leaseId,
      markerSha256: digest(marker),
    });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ ok: true, phase: 'committed' });

    marker = `${JSON.stringify({
      version: 1,
      state: 'active',
      enabledAt: new Date(now).toISOString(),
      activatedAt: new Date(now + 1).toISOString(),
      askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
      askReceiptAuthorityProof: {
        activationEpoch: 'a'.repeat(43),
        protocolVersion: 1,
        participants: [{
          larkAppId: 'cli_ipc',
          bootInstanceId: 'boot-ipc',
          pid: process.pid,
          procStart: 'daemon-start',
        }],
      },
    })}\n`;
    const released = await post(DEVICE_ISOLATION_RELEASE_PATH, {
      activationVersion: 1,
      nonce: NONCE,
      leaseId,
      markerSha256: digest(marker),
    });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ ok: true, released: true });
  });
});
