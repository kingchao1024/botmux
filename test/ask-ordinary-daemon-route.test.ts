import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerAsk: vi.fn(async () => ({
    kind: 'answered' as const,
    answers: [['yes']],
    by: 'ou_test',
    comment: null,
    timedOut: false as const,
  })),
}));

vi.mock('../src/core/ask-broker.js', async () => {
  const actual = await vi.importActual<typeof import('../src/core/ask-broker.js')>(
    '../src/core/ask-broker.js',
  );
  return { ...actual, registerAsk: (...args: unknown[]) => mocks.registerAsk(...args) };
});

import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import type { DaemonSession } from '../src/core/types.js';
import { setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { __testOnly_activeSessions as activeSessions } from '../src/daemon.js';

const SECRET = 'ordinary-ask-route-compat-secret';
const APP = 'ordinary_route_app';
const SESSION = 'ordinary-route-session';
const CHAT = 'oc_ordinary_route_chat';
const ROOT = 'om_ordinary_route_root';
let handle: IpcServerHandle | null = null;

function session(): DaemonSession {
  return {
    session: {
      sessionId: SESSION,
      status: 'active',
      rootMessageId: ROOT,
      backendType: 'tmux',
    } as DaemonSession['session'],
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: 'test',
    lastMessageAt: Date.now(),
    hasHistory: true,
    initConfig: { backendType: 'tmux', apiOnly: false } as DaemonSession['initConfig'],
  } as DaemonSession;
}

async function postLegacy(path: '/api/asks' | '/api/asks/hook', originKind: 'explicit' | 'hook') {
  if (!handle) throw new Error('server not started');
  const headers = daemonIpcAuthHeaders({
    secret: SECRET,
    port: handle.port,
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
  });
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sessionId: SESSION,
      larkAppId: APP,
      chatId: CHAT,
      rootMessageId: ROOT,
      prompt: 'Continue?',
      options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }],
      timeoutMs: 60_000,
      requestId: 'legacy-request',
      originKind,
    }),
  });
}

async function postLegacyRaw(
  path: '/api/asks' | '/api/asks/hook',
  originKind: unknown,
) {
  if (!handle) throw new Error('server not started');
  const headers = daemonIpcAuthHeaders({
    secret: SECRET,
    port: handle.port,
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
  });
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sessionId: SESSION,
      larkAppId: APP,
      chatId: CHAT,
      rootMessageId: ROOT,
      prompt: 'Continue?',
      options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }],
      timeoutMs: 60_000,
      requestId: 'legacy-request',
      originKind,
    }),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  __testOnly_resetBotRegistry();
  activeSessions.clear();
  registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code' });
  activeSessions.set(`${ROOT}::${APP}`, session());
  setActiveSessionsRegistry(activeSessions);
  setIpcAuthSecret(SECRET);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  setActiveSessionsRegistry(undefined);
  activeSessions.clear();
  __testOnly_resetBotRegistry();
});

describe('ordinary Ask rolling compatibility through the daemon route', () => {
  it('accepts the HEAD old hook body on /api/asks and upgrades effective origin to hook', async () => {
    const response = await postLegacy('/api/asks', 'hook');

    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({ kind: 'answered', answers: [['yes']] });
    expect(mocks.registerAsk).toHaveBeenCalledTimes(1);
    expect(mocks.registerAsk.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SESSION,
      larkAppId: APP,
      chatId: CHAT,
      rootMessageId: ROOT,
      requestId: 'legacy-request',
      originKind: 'hook',
      backendSurvivesRestart: true,
      questions: [{
        prompt: 'Continue?',
        multiSelect: false,
        options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }],
      }],
    });
  });

  it('keeps /api/asks/hook path-authoritative hook even when deprecated hint says explicit', async () => {
    const response = await postLegacy('/api/asks/hook', 'explicit');

    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({ kind: 'answered', answers: [['yes']] });
    expect(mocks.registerAsk).toHaveBeenCalledTimes(1);
    expect(mocks.registerAsk.mock.calls[0]?.[0]).toMatchObject({
      originKind: 'hook',
      backendSurvivesRestart: true,
    });
  });

  it('keeps /api/asks explicit when deprecated hint says explicit', async () => {
    const response = await postLegacy('/api/asks', 'explicit');

    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({ kind: 'answered', answers: [['yes']] });
    expect(mocks.registerAsk).toHaveBeenCalledTimes(1);
    expect(mocks.registerAsk.mock.calls[0]?.[0]).toMatchObject({
      originKind: 'explicit',
      backendSurvivesRestart: true,
    });
  });

  it('rejects invalid deprecated originKind values', async () => {
    const response = await postLegacyRaw('/api/asks', 's1-controller');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'bad_originKind' });
    expect(mocks.registerAsk).not.toHaveBeenCalled();
  });
});
