import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyS1ControllerRegisterThrownError,
  registerAskS1ControllerIpcRoutes,
  selectS1ControllerBinding,
  type AskS1ControllerExecutionBinding,
  type AskS1ControllerRecoverInput,
  type AskS1ControllerRegisterInput,
  type AskS1ControllerRouteDeps,
} from '../src/core/ask-s1-controller-route.js';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import type { AskResult } from '../src/core/ask-types.js';
import { AskS1WindowExpiredError } from '../src/core/ask-broker.js';
import { setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { larkTransportEnabled, type DaemonSession } from '../src/core/types.js';

const SECRET = 'ask-s1-route-test-secret';
const NOW = 1_700_000_000_500;

let handle: IpcServerHandle | null = null;
let routesRegistered = false;
let currentDeps: AskS1ControllerRouteDeps | null = null;
const activeSessions = new Map<string, DaemonSession>();

const baseBindingBody = {
  phase: 'binding',
  larkAppId: 'cli_test',
  chatId: 'oc_chat_1',
  requestId: 'a'.repeat(64),
  notBeforeMs: NOW - 500,
  expiresAtMs: NOW + 9_500,
  timeoutMs: 10_000,
  questions: [{
    prompt: 'Proceed?',
    multiSelect: false,
    options: [
      { key: 'yes', label: 'Yes' },
      { key: 'no', label: 'No' },
    ],
  }],
} as const;

const baseExecutionBody = {
  ...baseBindingBody,
  phase: 'execution',
  sessionId: 'sess-1',
  rootMessageId: 'om_root_1',
} as const;

const binding: AskS1ControllerExecutionBinding = {
  sessionId: 'sess-1',
  larkAppId: 'cli_test',
  chatId: 'oc_chat_1',
  rootMessageId: 'om_root_1',
  chatType: 'group',
  backendSurvivesRestart: true,
};

function makeSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sess-1',
      status: 'active',
      rootMessageId: 'om_root_1',
      backendType: 'tmux',
    } as any,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_test',
    chatId: 'oc_chat_1',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: NOW,
    cliVersion: 'test',
    lastMessageAt: NOW,
    hasHistory: true,
    initConfig: { backendType: 'tmux', apiOnly: false } as any,
    managedTurnOrigin: {
      capability: 'cap-1',
      turnId: 'turn-1',
      dispatchAttempt: 2,
    },
    ...overrides,
  } as DaemonSession;
}

function answeredResult(by = 'ou_owner'): Extract<AskResult, { kind: 'answered' }> {
  return {
    kind: 'answered',
    answers: [['yes']],
    by,
    comment: null,
    timedOut: false,
  };
}

function installRoutesOnce(): void {
  if (routesRegistered) return;
  registerAskS1ControllerIpcRoutes({
    selectBinding(input) {
      if (!currentDeps) throw new Error('test deps not installed');
      return currentDeps.selectBinding(input);
    },
    register(input) {
      if (!currentDeps) throw new Error('test deps not installed');
      return currentDeps.register(input);
    },
    recover(input) {
      if (!currentDeps) throw new Error('test deps not installed');
      return currentDeps.recover(input);
    },
    now: () => currentDeps?.now?.() ?? NOW,
  });
  routesRegistered = true;
}

async function ensureServer(deps: AskS1ControllerRouteDeps): Promise<void> {
  currentDeps = deps;
  installRoutesOnce();
  if (handle) return;
  setIpcAuthSecret(SECRET);
  setActiveSessionsRegistry(activeSessions);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
}

async function postS1(
  path: '/api/asks/s1-controller' | '/api/asks/s1-controller/recover',
  body: Record<string, unknown>,
  auth: 'signed' | 'none' = 'signed',
): Promise<Response> {
  if (!handle) throw new Error('server not started');
  const headers = auth === 'signed'
    ? daemonIpcAuthHeaders({
      secret: SECRET,
      port: handle.port,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
    })
    : new Headers({ 'content-type': 'application/json' });
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  currentDeps = null;
  activeSessions.clear();
  setActiveSessionsRegistry(undefined);
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
});

function productionDeps(overrides: Partial<AskS1ControllerRouteDeps> = {}): AskS1ControllerRouteDeps {
  const now = overrides.now ?? (() => NOW);
  const registerImpl = overrides.register ?? ((input: AskS1ControllerRegisterInput) => ({ ok: true, result: {
    ...answeredResult('ou_registered'),
    by: input.ask.sessionId,
  } }));
  return {
    selectBinding: (input) => selectS1ControllerBinding(input, {
      listActiveSessions: () => [...activeSessions.values()],
      findActiveBySessionId: (sessionId) => [...activeSessions.values()]
        .find((candidate) => candidate.session.sessionId === sessionId),
      getLiveOrigin: (selected) => selected.managedTurnOrigin,
      hasLarkTransport: (candidate) => larkTransportEnabled({
        chatId: candidate.chatId,
        apiOnly: candidate.initConfig?.apiOnly,
      }),
    }),
    register: async (input) => {
      try {
        return await registerImpl(input);
      } catch (err) {
        const classified = classifyS1ControllerRegisterThrownError(err);
        return classified
          ? { ok: false, error: classified }
          : { ok: false, error: 'store_unavailable' };
      }
    },
    recover: overrides.recover ?? (() => ({ ok: false, error: 'receipt_not_found' })),
    now,
  };
}

describe('S1 ask daemon route core', () => {
  it('rejects an unsigned request through the real authRequired IPC server', async () => {
    activeSessions.set('thread:1', makeSession());
    await ensureServer(productionDeps());

    const res = await postS1('/api/asks/s1-controller', { ...baseBindingBody }, 'none');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('binding rejects unresolved or PTY-only candidates and accepts exactly one persistent session', async () => {
    await ensureServer(productionDeps());

    let res = await postS1('/api/asks/s1-controller', { ...baseBindingBody });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'session_selector_unresolved' });

    activeSessions.set('pty', makeSession({
      session: { sessionId: 'sess-pty', status: 'active', rootMessageId: 'om_pty', backendType: 'pty' } as any,
      initConfig: { backendType: 'pty', apiOnly: false } as any,
    }));
    res = await postS1('/api/asks/s1-controller', { ...baseBindingBody });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'session_selector_unresolved' });

    activeSessions.clear();
    activeSessions.set('tmux', makeSession());
    res = await postS1('/api/asks/s1-controller', { ...baseBindingBody });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'answered', by: 'sess-1' });
  });

  it('binds exact persistent execution identity for initial calls', async () => {
    const registerInputs: AskS1ControllerRegisterInput[] = [];
    activeSessions.set('tmux', makeSession());
    await ensureServer(productionDeps({
      register: (input) => {
        registerInputs.push(input);
        return { ok: true, result: answeredResult('ou_bind') };
      },
    }));

    const res = await postS1('/api/asks/s1-controller', { ...baseBindingBody });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: 'answered',
      by: 'ou_bind',
      answers: [['yes']],
    });
    expect(registerInputs).toHaveLength(1);
    expect(registerInputs[0]!.binding).toEqual(binding);
    expect(registerInputs[0]!.ask).toMatchObject({
      larkAppId: 'cli_test',
      chatId: 'oc_chat_1',
      rootMessageId: 'om_root_1',
      sessionId: 'sess-1',
      requestId: baseBindingBody.requestId,
      originKind: 's1-controller',
      backendSurvivesRestart: true,
      chatType: 'group',
      deadlineAt: baseBindingBody.expiresAtMs,
    });
  });

  it('uses recover only path without invoking register/card flow', async () => {
    let registerCalls = 0;
    const recoverInputs: AskS1ControllerRecoverInput[] = [];
    activeSessions.set('tmux', makeSession());
    await ensureServer(productionDeps({
      register: () => {
        registerCalls += 1;
        return { ok: true, result: answeredResult() };
      },
      recover: (input) => {
        recoverInputs.push(input);
        return { ok: true, result: answeredResult('ou_recovered') };
      },
    }));

    const res = await postS1('/api/asks/s1-controller/recover', { ...baseExecutionBody });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: 'answered',
      by: 'ou_recovered',
      answers: [['yes']],
    });
    expect(registerCalls).toBe(0);
    expect(recoverInputs).toHaveLength(1);
    expect(recoverInputs[0]!.binding).toEqual(binding);
    expect(recoverInputs[0]!.body.requestId).toBe(baseExecutionBody.requestId);
  });

  it('allows signed execution and recover for the exact live tuple', async () => {
    let registerCalls = 0;
    let recoverCalls = 0;
    activeSessions.set('tmux', makeSession());
    await ensureServer(productionDeps({
      register: () => {
        registerCalls += 1;
        return { ok: true, result: answeredResult('ou_hmac_exec') };
      },
      recover: () => {
        recoverCalls += 1;
        return { ok: true, result: answeredResult('ou_hmac_recover') };
      },
    }));

    let res = await postS1('/api/asks/s1-controller', { ...baseExecutionBody });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: 'answered',
      by: 'ou_hmac_recover',
    });

    res = await postS1('/api/asks/s1-controller/recover', { ...baseExecutionBody });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: 'answered',
      by: 'ou_hmac_recover',
    });
    expect(registerCalls).toBe(0);
    expect(recoverCalls).toBe(2);
  });

  it('execution/recover auth matrix supports exact capability and rejects stale or wrong binding', async () => {
    activeSessions.set('tmux', makeSession());
    let registerCalls = 0;
    let recoverCalls = 0;
    let recoverMode: 'missing' | 'answered' = 'missing';
    await ensureServer(productionDeps({
      register: () => {
        registerCalls += 1;
        return { ok: true, result: answeredResult('ou_exact_cap') };
      },
      recover: () => {
        recoverCalls += 1;
        return recoverMode === 'answered'
          ? { ok: true, result: answeredResult('ou_recovered_cap') }
          : { ok: false, error: 'receipt_not_found' };
      },
      now: () => NOW,
    }));

    let res = await postS1('/api/asks/s1-controller', {
      ...baseExecutionBody,
      originCapability: 'cap-1',
      originTurnId: 'turn-1',
      originDispatchAttempt: 2,
    }, 'none');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: 'answered',
      by: 'ou_exact_cap',
      answers: [['yes']],
    });

    recoverMode = 'answered';
    res = await postS1('/api/asks/s1-controller/recover', {
      ...baseExecutionBody,
      originCapability: 'cap-1',
      originTurnId: 'turn-1',
      originDispatchAttempt: 2,
    }, 'none');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: 'answered',
      by: 'ou_recovered_cap',
    });

    const completedCounts = { registerCalls, recoverCalls };
    const capability = {
      originCapability: 'cap-1', originTurnId: 'turn-1', originDispatchAttempt: 2,
    };
    const rejectedBodies = [
      { ...baseExecutionBody },
      { ...baseExecutionBody, ...capability, originCapability: 'stale-cap' },
      { ...baseExecutionBody, ...capability, sessionId: 'sess-missing' },
      { ...baseExecutionBody, ...capability, rootMessageId: 'om_wrong' },
      { ...baseExecutionBody, ...capability, larkAppId: 'cli_wrong' },
      { ...baseExecutionBody, ...capability, chatId: 'oc_wrong' },
    ];
    for (const body of rejectedBodies) {
      for (const path of ['/api/asks/s1-controller', '/api/asks/s1-controller/recover'] as const) {
        res = await postS1(path, body, 'none');
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ ok: false, error: 'binding_mismatch' });
      }
    }
    expect({ registerCalls, recoverCalls }).toEqual(completedCounts);
  });

  it('rejects missing or wrong execution tuple before recover/register/card work', async () => {
    let registerCalls = 0;
    let recoverCalls = 0;
    activeSessions.set('tmux', makeSession());
    await ensureServer(productionDeps({
      register: () => {
        registerCalls += 1;
        return { ok: true, result: answeredResult() };
      },
      recover: () => {
        recoverCalls += 1;
        return { ok: false, error: 'receipt_not_found' };
      },
    }));

    const badBodies = [
      { ...baseExecutionBody, sessionId: 'sess-missing' },
      { ...baseExecutionBody, rootMessageId: 'om_wrong' },
      { ...baseExecutionBody, larkAppId: 'cli_wrong' },
      { ...baseExecutionBody, chatId: 'oc_wrong' },
    ] as const;

    for (const body of badBodies) {
      const initial = await postS1('/api/asks/s1-controller', { ...body });
      expect(initial.status).toBe(409);
      expect(await initial.json()).toMatchObject({ ok: false, error: 'binding_mismatch' });

      const recover = await postS1('/api/asks/s1-controller/recover', { ...body });
      expect(recover.status).toBe(409);
      expect(await recover.json()).toMatchObject({ ok: false, error: 'binding_mismatch' });
    }

    expect(registerCalls).toBe(0);
    expect(recoverCalls).toBe(0);
  });

  it('rejects PTY execution and recover before recover/register work', async () => {
    let registerCalls = 0;
    let recoverCalls = 0;
    activeSessions.set('pty', makeSession({
      session: { sessionId: 'sess-1', status: 'active', rootMessageId: 'om_root_1', backendType: 'pty' } as any,
      initConfig: { backendType: 'pty', apiOnly: false } as any,
    }));
    await ensureServer(productionDeps({
      register: () => {
        registerCalls += 1;
        return { ok: true, result: answeredResult() };
      },
      recover: () => {
        recoverCalls += 1;
        return { ok: false, error: 'receipt_not_found' };
      },
    }));

    for (const auth of ['signed', 'none'] as const) {
      const body = auth === 'none'
        ? { ...baseExecutionBody, originCapability: 'cap-1' }
        : { ...baseExecutionBody };
      for (const path of ['/api/asks/s1-controller', '/api/asks/s1-controller/recover'] as const) {
        const res = await postS1(path, body, auth);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ ok: false, error: 'binding_mismatch' });
      }
    }
    expect(registerCalls).toBe(0);
    expect(recoverCalls).toBe(0);
  });

  it('rejects apiOnly execution and recover before register or recover lookup work', async () => {
    let registerCalls = 0;
    let recoverCalls = 0;
    activeSessions.set('apiOnly', makeSession({
      initConfig: { backendType: 'tmux', apiOnly: true } as any,
    }));
    await ensureServer(productionDeps({
      register: () => {
        registerCalls += 1;
        return { ok: true, result: answeredResult() };
      },
      recover: () => {
        recoverCalls += 1;
        return { ok: false, error: 'receipt_not_found' };
      },
    }));

    for (const auth of ['signed', 'none'] as const) {
      const body = auth === 'none'
        ? { ...baseExecutionBody, originCapability: 'cap-1' }
        : { ...baseExecutionBody };
      for (const path of ['/api/asks/s1-controller', '/api/asks/s1-controller/recover'] as const) {
        const res = await postS1(path, body, auth);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ ok: false, error: 'binding_mismatch' });
      }
    }
    expect(registerCalls).toBe(0);
    expect(recoverCalls).toBe(0);
  });

  it('rejects inactive, receiver, and HTTP-virtual sessions for both auth paths before work', async () => {
    let registerCalls = 0;
    let recoverCalls = 0;
    await ensureServer(productionDeps({
      register: () => {
        registerCalls += 1;
        return { ok: true, result: answeredResult() };
      },
      recover: () => {
        recoverCalls += 1;
        return { ok: false, error: 'receipt_not_found' };
      },
    }));

    const live = makeSession();
    const rejected = [
      makeSession({ session: { ...live.session, status: 'closed' } as any }),
      makeSession({ session: { ...live.session, vcMeetingReceiver: true } as any }),
      makeSession({ chatId: 'http_async_s1' }),
    ];
    for (const session of rejected) {
      activeSessions.clear();
      activeSessions.set(session.session.sessionId, session);
      const exactBody = {
        ...baseExecutionBody,
        larkAppId: session.larkAppId,
        chatId: session.chatId,
        sessionId: session.session.sessionId,
        rootMessageId: session.session.rootMessageId,
      };
      for (const auth of ['signed', 'none'] as const) {
        const body = auth === 'none'
          ? { ...exactBody, originCapability: 'cap-1' }
          : exactBody;
        for (const path of ['/api/asks/s1-controller', '/api/asks/s1-controller/recover'] as const) {
          const res = await postS1(path, body, auth);
          expect(res.status).toBe(409);
          expect(await res.json()).toMatchObject({ ok: false, error: 'binding_mismatch' });
        }
      }
    }
    expect(registerCalls).toBe(0);
    expect(recoverCalls).toBe(0);
  });

  it('maps recover terminal receipt outcomes to requested HTTP codes', async () => {
    activeSessions.set('tmux', makeSession());
    await ensureServer(productionDeps({
      recover: () => ({ ok: false, error: 'recovery_expired' }),
    }));

    const expired = await postS1('/api/asks/s1-controller/recover', { ...baseExecutionBody });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ ok: false, error: 'recovery_expired' });

    currentDeps = productionDeps({
      recover: () => ({ ok: false, error: 'receipt_not_found' }),
    });

    const missing = await postS1('/api/asks/s1-controller/recover', { ...baseExecutionBody });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, error: 'receipt_not_found' });
  });

  it('returns 410 when the ask expires between validation and register', async () => {
    activeSessions.set('tmux', makeSession());
    let nowCall = 0;
    let registerCalls = 0;
    await ensureServer(productionDeps({
      now: () => {
        nowCall += 1;
        return nowCall === 1 ? NOW : baseBindingBody.expiresAtMs;
      },
      register: () => {
        registerCalls += 1;
        return { ok: true, result: answeredResult() };
      },
    }));

    const res = await postS1('/api/asks/s1-controller', { ...baseBindingBody });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ ok: false, error: 'recovery_expired' });
    expect(registerCalls).toBe(0);
  });

  it('maps only the typed S1 expiry error to recovery_expired', async () => {
    activeSessions.set('tmux', makeSession());
    await ensureServer(productionDeps({
      register: () => {
        throw new AskS1WindowExpiredError(baseBindingBody.expiresAtMs, baseBindingBody.expiresAtMs + 1);
      },
      now: () => baseBindingBody.expiresAtMs + 1,
    }));

    const expired = await postS1('/api/asks/s1-controller', { ...baseBindingBody });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ ok: false, error: 'recovery_expired' });

    currentDeps = productionDeps({
      register: () => {
        throw new RangeError('ask-broker timeout window rejected');
      },
      now: () => NOW,
    });

    const generic = await postS1('/api/asks/s1-controller', { ...baseBindingBody });
    expect(generic.status).toBe(503);
    expect(await generic.json()).toMatchObject({ ok: false, error: 'store_unavailable' });
  });

  it('classifies only the broker typed S1 expiry error as recovery_expired', () => {
    expect(classifyS1ControllerRegisterThrownError(
      new AskS1WindowExpiredError(baseBindingBody.expiresAtMs, baseBindingBody.expiresAtMs + 1),
    )).toBe('recovery_expired');

    expect(classifyS1ControllerRegisterThrownError(
      new RangeError('another broker range error'),
    )).toBeUndefined();
  });
});
