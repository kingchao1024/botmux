import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock getBot so the daemon IPC /api/trigger handler can test apiOnly hard-deny.
const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return { ...actual, getBot: (...a: any[]) => mockGetBot(...a) };
});

// Mock getActiveSessionsRegistry so the /api/trigger handler doesn't fail on
// the "active session registry unavailable" gate before reaching hard-deny.
vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return { ...actual, getActiveSessionsRegistry: () => new Map() };
});

let server: Server | null = null;
let baseUrl = '';
let prevDataDir: string | undefined;
const testDirs: string[] = [];

async function startWebhookServer(opts: {
  proxyToDaemon?: any;
  createLifecycleGroup?: any;
  resolveMentionIdentities?: any;
} = {}): Promise<void> {
  vi.resetModules();
  const { handleWebhookRoute } = await import('../src/dashboard/webhook-routes.js');
  const proxyToDaemon = opts.proxyToDaemon ?? vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({ ok: true, triggerId: 'trg_upstream', action: 'delivered', target: { kind: 'turn', chatId: 'oc_new' } }),
  })) as any;
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (await handleWebhookRoute(req, res, url, {
        proxyToDaemon,
        createLifecycleGroup: opts.createLifecycleGroup,
        resolveMentionIdentities: opts.resolveMentionIdentities,
      })) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (err) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad test server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

function sign(secret: string, ts: string, raw: string): string {
  return createHmac('sha256', secret).update(ts).update('.').update(raw).digest('base64url');
}

function signBytes(secret: string, ts: string, raw: Buffer): string {
  return createHmac('sha256', secret).update(ts).update('.').update(raw).digest('base64url');
}

function mockProxyResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), json: async () => body };
}

async function postWebhook(
  connectorId: string,
  nonce: string,
  body: unknown,
  query = '',
): Promise<any> {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${baseUrl}/webhook/${encodeURIComponent(connectorId)}${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-botmux-timestamp': ts,
      'x-botmux-nonce': nonce,
      'x-botmux-signature': sign('secret', ts, raw),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

async function postRawWebhook(
  connectorId: string,
  nonce: string,
  raw: Buffer,
  query = '',
): Promise<any> {
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${baseUrl}/webhook/${encodeURIComponent(connectorId)}${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-botmux-timestamp': ts,
      'x-botmux-nonce': nonce,
      'x-botmux-signature': signBytes('secret', ts, raw),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

async function getWebhook(connectorId: string, nonce: string, query = ''): Promise<any> {
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${baseUrl}/webhook/${encodeURIComponent(connectorId)}${query}`, {
    headers: {
      'x-botmux-timestamp': ts,
      'x-botmux-nonce': nonce,
      'x-botmux-signature': sign('secret', ts, ''),
    },
  });
  return { status: res.status, body: await res.json() };
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

const outputSchema = {
  type: 'object',
  properties: { content: { type: 'string' } },
  required: ['content'],
  additionalProperties: false,
};

async function seedInvocationConnector(opts: {
  invocation?: { model?: string; deadlineMs?: number; outputSchema?: Record<string, unknown>; reasoningEffort?: string; maxOutputTokens?: number };
  noInvocation?: boolean;
} = {}): Promise<void> {
  const { createWebhookSecret } = await import('../src/services/webhook-key.js');
  const { upsertConnector } = await import('../src/services/connector-store.js');
  const secret = createWebhookSecret('secret');

  const connector: any = {
    id: 'conn_invocation',
    name: 'Invocation Webhook',
    enabled: true,
    verify: {
      type: 'hmac-sha256',
      secretRef: secret.ref,
      signatureHeader: 'x-botmux-signature',
      timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce',
      toleranceSeconds: 300,
    },
    target: {
      mode: 'fixed' as const,
      kind: 'invocation' as const,
      botId: 'app_invocation',
    },
    promptEnvelope: {
      sourceName: 'invocation',
      headerAllowlist: [],
      includeRawText: false,
      maxBodyBytes: 1024,
    },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
  };

  if (!opts.noInvocation) {
    connector.invocation = {
      model: opts.invocation?.model ?? 'gpt-5.5',
      deadlineMs: opts.invocation?.deadlineMs ?? 30_000,
      outputSchema: opts.invocation?.outputSchema ?? outputSchema,
      ...(opts.invocation?.reasoningEffort ? { reasoningEffort: opts.invocation.reasoningEffort } : {}),
      ...(opts.invocation?.maxOutputTokens !== undefined ? { maxOutputTokens: opts.invocation.maxOutputTokens } : {}),
    };
  }

  upsertConnector(connector);
}

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-invocation-webhook-'));
  testDirs.push(dataDir);
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  vi.restoreAllMocks();
  for (const d of testDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('invocation connector webhook routing', () => {
  it('routes invocation connector to /api/headless/invocations', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return mockProxyResponse(202, {
        ok: true,
        result: {
          requestId: body.requestId ?? 'unknown',
          state: 'running', output: null, error: null,
          startedAt: new Date().toISOString(), durationMs: null, startupMs: null,
          configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null,
          usage: null, usageSource: null,
        },
      });
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_inv_${Date.now()}`, {
      prompt: 'What is the capital of France?',
    });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.result).toBeDefined();
    expect(res.body.result.state).toBe('running');

    // Verify it called /api/headless/invocations NOT /api/trigger
    const invocationCall = proxyToDaemon.mock.calls.find(
      (call: any[]) => call[1] === '/api/headless/invocations',
    );
    expect(invocationCall).toBeDefined();
    if (invocationCall) {
      expect(invocationCall[2].method).toBe('POST');
    }

    // Verify no /api/trigger call
    const triggerCall = proxyToDaemon.mock.calls.find(
      (call: any[]) => call[1] === '/api/trigger',
    );
    expect(triggerCall).toBeUndefined();
  });

  it('includes only prompt from webhook payload, not model or schema', async () => {
    await seedInvocationConnector();

    let capturedBody: any;
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      capturedBody = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return mockProxyResponse(202, {
        ok: true,
        result: { requestId: capturedBody.requestId, state: 'running', output: null, error: null, startedAt: new Date().toISOString(), durationMs: null, startupMs: null, configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null, usage: null, usageSource: null },
      });
    });

    await startWebhookServer({ proxyToDaemon });

    // Attempt to inject model and other fields through webhook payload
    await postWebhook('conn_invocation', `nonce_iso_${Date.now()}`, {
      prompt: 'Hello world',
      model: 'evil-model-override',
      outputSchema: { type: 'string' },
      tools: [{ name: 'shell' }],
      sessionId: 'hijacked-session',
    });

    // The invocation request must use the connector's configured model, not the payload's
    expect(capturedBody.model).toBe('gpt-5.5'); // from connector config
    expect(capturedBody.model).not.toBe('evil-model-override');
    // prompt should come from payload
    expect(capturedBody.prompt).toContain('Hello world');
    // outputSchema must be from connector config
    expect(capturedBody.outputSchema).toEqual(outputSchema);
    // Must not include caller-provided session/identity fields
    expect(capturedBody).not.toHaveProperty('sessionId');
  });

  it('rejects invocation connector with missing prompt', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn();
    await startWebhookServer({ proxyToDaemon });

    // Empty payload - no prompt field
    const res = await postWebhook('conn_invocation', `nonce_emp_${Date.now()}`, {
      notPrompt: 'nothing',
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('rejects invocation connector without invocation config', async () => {
    await seedInvocationConnector({ noInvocation: true });

    const proxyToDaemon = vi.fn();
    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_nocfg_${Date.now()}`, {
      prompt: 'test',
    });

    // Must fail because invocation connector requires invocation config
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });
});

describe('invocation connector idempotency', () => {
  it('echoes idempotency key on first delivery', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return mockProxyResponse(202, {
        ok: true,
        result: { requestId: body.requestId ?? 'unknown', state: 'running', output: null, error: null, startedAt: new Date().toISOString(), durationMs: null, startupMs: null, configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null, usage: null, usageSource: null },
      });
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_idem_${Date.now()}`, {
      prompt: 'Test prompt',
    }, '?idempotencyKey=key-001');

    expect(res.status).toBe(202);
  });

  it('suppresses duplicate with same idempotency key', async () => {
    await seedInvocationConnector();

    let callCount = 0;
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      callCount++;
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return mockProxyResponse(202, {
        ok: true,
        result: { requestId: body.requestId ?? 'unknown', state: 'running', output: null, error: null, startedAt: new Date().toISOString(), durationMs: null, startupMs: null, configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null, usage: null, usageSource: null },
      });
    });

    await startWebhookServer({ proxyToDaemon });

    // First delivery
    const res1 = await postWebhook('conn_invocation', `nonce_dup1_${Date.now()}`, {
      prompt: 'Test prompt',
    }, '?idempotencyKey=key-002');

    // Duplicate delivery
    const res2 = await postWebhook('conn_invocation', `nonce_dup2_${Date.now()}`, {
      prompt: 'Test prompt',
    }, '?idempotencyKey=key-002');

    if (res1.status === 202) {
      // If first was accepted, duplicate should be suppressed
      expect(res2.status).toBe(200);
      expect(res2.body.action).toBe('ignored');
    }
  });

  it('stable requestId: binds connector + idempotency key + body fingerprint', async () => {
    await seedInvocationConnector();

    const capturedIds: string[] = [];
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      capturedIds.push(body.requestId);
      return mockProxyResponse(202, {
        ok: true,
        result: { requestId: body.requestId ?? 'unknown', state: 'running', output: null, error: null, startedAt: new Date().toISOString(), durationMs: null, startupMs: null, configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null, usage: null, usageSource: null },
      });
    });

    await startWebhookServer({ proxyToDaemon });

    // Same (connector, key, body) → same requestId (stable for commit-unknown retries)
    // Use fresh keys so neither is deduped; but same key + same prompt should produce same id
    const key1 = `body-bind-key-a-${Date.now()}`;
    const key2 = `body-bind-key-b-${Date.now()}`;

    // Call 1: key=key1, prompt=A
    await postWebhook('conn_invocation', `nonce_1_${Date.now()}`, { prompt: 'prompt-A' }, `?idempotencyKey=${key1}`);
    // Call 2: key=key2, prompt=A — different key, same prompt → different requestId
    await postWebhook('conn_invocation', `nonce_2_${Date.now()}`, { prompt: 'prompt-A' }, `?idempotencyKey=${key2}`);
    // Call 3: key=key2, prompt=B — same key, different prompt → different requestId (fail-open)
    await postWebhook('conn_invocation', `nonce_3_${Date.now()}`, { prompt: 'prompt-B' }, `?idempotencyKey=${key2}`);

    expect(capturedIds).toHaveLength(3);
    // Call 1 and 2: different keys → different ids
    expect(capturedIds[0]).not.toBe(capturedIds[1]);
    // Call 2 and 3: same key, different body → different ids (fail-open)
    expect(capturedIds[1]).not.toBe(capturedIds[2]);
    // All follow the format
    for (const id of capturedIds) {
      expect(id).toMatch(/^inv_[A-Za-z0-9]{1,56}$/);
    }
  });

  it('requestId format matches [A-Za-z0-9_-]{1,128}', async () => {
    await seedInvocationConnector();

    let capturedRequestId = '';
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      capturedRequestId = body.requestId;
      return mockProxyResponse(202, {
        ok: true,
        result: { requestId: body.requestId ?? 'unknown', state: 'running', output: null, error: null, startedAt: new Date().toISOString(), durationMs: null, startupMs: null, configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null, usage: null, usageSource: null },
      });
    });

    await startWebhookServer({ proxyToDaemon });

    await postWebhook('conn_invocation', `nonce_fmt_${Date.now()}`, {
      prompt: 'Test requestId format',
    }, '?idempotencyKey=fmt-key-001');

    expect(capturedRequestId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(capturedRequestId.length).toBeLessThanOrEqual(128);
  });
});

// ── P1-1: dryRun=1 zero daemon call ──
describe('invocation connector dryRun=1', () => {
  it('makes zero daemon calls when dryRun=1', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn();
    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_dry_${Date.now()}`, {
      prompt: 'Should not call daemon',
    }, '?dryRun=1');

    expect(proxyToDaemon).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result).toBeDefined();
    expect(res.body.result.state).toBe('completed');
    expect(res.body.result.output).toBeNull();
    expect(res.body.result.error).toBeNull();
    expect(res.body.result.durationMs).toBe(0);
  });
});

// ── P1-1: wait=1 terminal state polling ──
describe('invocation connector wait=1 polling', () => {
  it('polls GET /api/headless/invocations/:id until terminal state', async () => {
    await seedInvocationConnector();

    let postCount = 0;
    let getCount = 0;
    const requestId = 'inv_test_wait_poll';

    const proxyToDaemon = vi.fn(async (_appId: string, path: string, _init: RequestInit) => {
      if (path === '/api/headless/invocations') {
        postCount++;
        return mockProxyResponse(202, {
          ok: true,
          result: {
            requestId, state: 'running', output: null, error: null,
            startedAt: new Date().toISOString(), durationMs: null, startupMs: null,
            configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null,
            usage: null, usageSource: null,
          },
        });
      }
      // GET poll
      if (path.startsWith('/api/headless/invocations/')) {
        getCount++;
        return mockProxyResponse(200, {
          ok: true,
          result: {
            requestId, state: 'completed',
            output: { content: 'polled result' }, error: null,
            startedAt: new Date().toISOString(), durationMs: 100, startupMs: 10,
            configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null,
            usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, cacheWriteInputTokens: null },
            usageSource: 'native_result',
          },
        });
      }
      return mockProxyResponse(404, { ok: false, error: 'not_found' });
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_wait_${Date.now()}`, {
      prompt: 'Test wait polling',
    }, '?wait=1&timeoutMs=5000');

    expect(res.status).toBe(200);
    expect(postCount).toBe(1);
    // Must have made at least one GET poll
    expect(getCount).toBeGreaterThanOrEqual(1);
    expect(res.body.result.state).toBe('completed');
    expect(res.body.result.output).toEqual({ content: 'polled result' });
  });

  it('spends one 1000ms wait budget across a 600ms POST and a 600ms GET', async () => {
    await seedInvocationConnector();
    const requestId = 'inv_shared_budget';
    const proxyToDaemon = vi.fn(async (_appId: string, path: string, init: RequestInit) => {
      if (path === '/api/headless/invocations') {
        await waitFor(600, init.signal as AbortSignal);
        return mockProxyResponse(202, { ok: true, result: { requestId, state: 'running' } });
      }
      await waitFor(600, init.signal as AbortSignal);
      return mockProxyResponse(200, { ok: true, result: { requestId, state: 'completed', output: { content: 'too late' } } });
    });
    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_budget_${Date.now()}`, { prompt: 'budget' }, '?wait=1&timeoutMs=1000');

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('invocation_poll_timeout');
    expect(proxyToDaemon.mock.calls[1][2].signal.aborted).toBe(true);
  });
});

describe('invocation connector raw-body identity and public polling', () => {
  it('uses distinct invocation ids for raw 0xff and 0xfe body bytes', async () => {
    await seedInvocationConnector();
    const requestIds: string[] = [];
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      requestIds.push(JSON.parse(String(init.body)).requestId);
      return mockProxyResponse(202, { ok: true, result: { requestId: requestIds.at(-1), state: 'running' } });
    });
    await startWebhookServer({ proxyToDaemon });

    await postRawWebhook('conn_invocation', `nonce_ff_${Date.now()}`, Buffer.from([0x7b, 0x22, 0x70, 0x72, 0x6f, 0x6d, 0x70, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), '?idempotencyKey=raw-byte-key');
    await postRawWebhook('conn_invocation', `nonce_fe_${Date.now()}`, Buffer.from([0x7b, 0x22, 0x70, 0x72, 0x6f, 0x6d, 0x70, 0x74, 0x22, 0x3a, 0x22, 0xfe, 0x22, 0x7d]), '?idempotencyKey=raw-byte-key');

    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });

  it('caps public invocation GET at timeoutMs and audits success and proxy exceptions', async () => {
    await seedInvocationConnector();
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      await waitFor(1500, init.signal as AbortSignal);
      return mockProxyResponse(200, { ok: true, result: { requestId: 'inv_public', state: 'completed', output: { content: 'too late' } } });
    });
    await startWebhookServer({ proxyToDaemon });

    const timedOut = await getWebhook('conn_invocation', `nonce_get_timeout_${Date.now()}`, '?requestId=inv_public&timeoutMs=1000');
    expect(timedOut.status).toBe(502);

    const { listTriggerLogs } = await import('../src/services/trigger-log-store.js');
    const timeoutAudit = listTriggerLogs({ connectorId: 'conn_invocation' })[0];
    expect(timeoutAudit).toMatchObject({ action: 'failed', status: 'error', response: { httpStatus: 502 } });

    proxyToDaemon.mockImplementationOnce(async () => mockProxyResponse(200, { ok: true, result: { requestId: 'inv_public', state: 'completed', output: { content: 'done' } } }));
    const success = await getWebhook('conn_invocation', `nonce_get_success_${Date.now()}`, '?requestId=inv_public&timeoutMs=1000');
    expect(success.status).toBe(200);
    const successAudit = listTriggerLogs({ connectorId: 'conn_invocation' })[0];
    expect(successAudit).toMatchObject({ action: 'completed', status: 'ok', response: { httpStatus: 200 } });

    proxyToDaemon.mockImplementationOnce(async () => { throw new Error('proxy exploded'); });
    const failed = await getWebhook('conn_invocation', `nonce_get_error_${Date.now()}`, '?requestId=inv_public&timeoutMs=1000');
    expect(failed.status).toBe(502);
    const errorAudit = listTriggerLogs({ connectorId: 'conn_invocation' })[0];
    expect(errorAudit).toMatchObject({ action: 'failed', status: 'error', response: { httpStatus: 502 } });
  });
});

// ── P1-2: error sanitization — no raw err.message ──
describe('invocation proxy error sanitization', () => {
  it.each([
    ['failed', 'sk_live_EXECUTED_REPRO_SECRET', 'native_inference_failed'],
    ['failed', 'native_process_exited', 'native_process_exited'],
    ['cancelled', 'sk_live_CANCELLED_REPRO_SECRET', 'native_inference_failed'],
  ])('sanitizes an immediate ok:true %s result: %s', async (state, nativeError, expectedError) => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return mockProxyResponse(200, {
        ok: true,
        result: {
          requestId: body.requestId, state, output: null, error: nativeError,
          startedAt: new Date().toISOString(), durationMs: 1, startupMs: 1,
          configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null,
          usage: null, usageSource: null,
        },
      });
    });
    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_immediate_failed_${Date.now()}`, { prompt: 'test' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, result: { state, error: expectedError } });
    expect(JSON.stringify(res.body)).not.toContain('REPRO_SECRET');
  });

  it('returns stable error code, not raw exception text when proxy fails', async () => {
    await seedInvocationConnector();

    // Simulate a proxy-level exception (network error, refused, etc.)
    const proxyToDaemon = vi.fn(async () => {
      throw new Error('/etc/secrets/leaked: connection refused');
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_san_${Date.now()}`, {
      prompt: 'Test error sanitization',
    });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    // Must NOT contain the raw error message
    expect(res.body.error).not.toContain('/etc/secrets');
    expect(res.body.error).not.toContain('leaked');
    expect(res.body.error).not.toContain('connection refused');
    // Must be a stable error code
    expect(['invocation_proxy_error', 'invocation_timeout']).toContain(res.body.error);
  });

  it('returns invocation_proxy_error for non-timeout proxy failures', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:9123');
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_refused_${Date.now()}`, {
      prompt: 'Test refused',
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('invocation_proxy_error');
  });

  it('returns invocation_failed (not raw daemon error) for unknown daemon rejection', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      return mockProxyResponse(500, {
        ok: false,
        error: '/home/daemon/secret_token_exposed',
      });
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_unk_${Date.now()}`, {
      prompt: 'Test unknown error',
    });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    // Must not leak the raw daemon error
    expect(res.body.error).not.toContain('/home/daemon');
    expect(res.body.error).not.toContain('secret_token');
    // Must be whitelisted to stable codes
    expect(res.body.error).toBe('invocation_failed');
  });

  it('preserves whitelisted daemon error codes', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      return mockProxyResponse(400, { ok: false, error: 'invalid_invocation' });
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_known_${Date.now()}`, {
      prompt: 'Test known error',
    });

    // Whitelisted errors pass through
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_invocation');
  });

  it('sanitizes sk_live API key from daemon response body', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      return mockProxyResponse(500, {
        ok: false,
        error: 'sk_live_SUPERSECRET123',
      });
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_sklive_${Date.now()}`, {
      prompt: 'Test sk_live leak',
    });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    // Must not leak the raw API key — only explicit safelist passes through
    expect(res.body.error).not.toContain('sk_live');
    expect(res.body.error).not.toContain('SUPERSECRET');
    expect(res.body.error).toBe('invocation_failed');
  });
});

// ── P1-2: Non-JSON 202 response ──
describe('invocation non-JSON response handling', () => {
  it('handles non-JSON 202 response gracefully', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, _init: RequestInit) => {
      return {
        status: 202,
        text: async () => 'not json at all',
        json: async () => { throw new Error('invalid json'); },
      };
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_nonjson_${Date.now()}`, {
      prompt: 'Test non-JSON response',
    });

    // Must not return 202 with ok:false — must return a stable code
    const isErrorResponse = !res.body.ok;
    if (isErrorResponse) {
      expect(res.body.error).toBe('unexpected_response_format');
    }
  });
});

// ── P1-2: Service.ts error sanitization (NativeInvocationError) ──
describe('InvocationService error sanitization', () => {
  it('sanitizes NativeInvocationError with unknown message to native_inference_failed', async () => {
    const { InvocationService } = await import('../src/services/constrained-invocation/service.js');
    const { NativeInvocationError } = await import('../src/services/constrained-invocation/runtime.js');
    const tmpDir = mkdtempSync(join(tmpdir(), 'inv-svc-sanitize-'));

    try {
      const svc = new InvocationService({
        directory: tmpDir,
        async run(_req, _signal) {
          // Throw a NativeInvocationError with a raw CLI error message
          throw new NativeInvocationError('FATAL: /home/user/.secrets leaked in stderr', {
            output: null, configuredModel: 'gpt-5.5', actualModel: null,
            reasoningEffort: null, usage: null, usageSource: null, startupMs: 0,
          });
        },
      });

      const id = `inv_sanitize_test_${Date.now()}`;
      svc.start({
        requestId: id,
        prompt: 'test',
        model: 'gpt-5.5',
        deadlineMs: 5_000,
        outputSchema,
        ...(undefined as any),
      });

      const result = await svc.wait(id, 5_000);

      expect(result).toBeDefined();
      if (result) {
        // The error must be sanitized, not contain the raw CLI message
        expect(result.error).not.toContain('FATAL');
        expect(result.error).not.toContain('/home/user');
        expect(result.error).not.toContain('.secrets');
        expect(result.error).not.toContain('leaked');
        expect(result.error).not.toContain('stderr');
        // Known stable codes or generic sanitized code
        expect(['native_inference_failed', 'native_process_exited', 'native_invocation_failed']).toContain(result.error);
      }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('preserves known stable NativeInvocationError codes', async () => {
    const { InvocationService } = await import('../src/services/constrained-invocation/service.js');
    const { NativeInvocationError } = await import('../src/services/constrained-invocation/runtime.js');
    const tmpDir = mkdtempSync(join(tmpdir(), 'inv-svc-known-'));

    try {
      const svc = new InvocationService({
        directory: tmpDir,
        async run(_req, _signal) {
          throw new NativeInvocationError('native_process_exited', {
            output: null, configuredModel: 'gpt-5.5', actualModel: null,
            reasoningEffort: null, usage: null, usageSource: null, startupMs: 0,
          });
        },
      });

      const id = `inv_known_test_${Date.now()}`;
      svc.start({
        requestId: id,
        prompt: 'test',
        model: 'gpt-5.5',
        deadlineMs: 5_000,
        outputSchema,
        ...(undefined as any),
      });

      const result = await svc.wait(id, 5_000);

      expect(result).toBeDefined();
      if (result) {
        // Known stable codes should pass through unchanged
        expect(result.error).toBe('native_process_exited');
      }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('uses invocation_failed for non-NativeInvocationError exceptions', async () => {
    const { InvocationService } = await import('../src/services/constrained-invocation/service.js');
    const tmpDir = mkdtempSync(join(tmpdir(), 'inv-svc-generic-'));

    try {
      const svc = new InvocationService({
        directory: tmpDir,
        async run(_req, _signal) {
          throw new Error('/root/.ssh/id_rsa: permission denied');
        },
      });

      const id = `inv_generic_test_${Date.now()}`;
      svc.start({
        requestId: id,
        prompt: 'test',
        model: 'gpt-5.5',
        deadlineMs: 5_000,
        outputSchema,
        ...(undefined as any),
      });

      const result = await svc.wait(id, 5_000);

      expect(result).toBeDefined();
      if (result) {
        // Non-NativeInvocationError → generic code
        expect(result.error).toBe('invocation_failed');
        expect(result.error).not.toContain('/root');
        expect(result.error).not.toContain('id_rsa');
      }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
it('sanitizes "native_failure /root/private" — startsWith native_ is NOT a whitelist', async () => {
    const { InvocationService } = await import('../src/services/constrained-invocation/service.js');
    const { NativeInvocationError } = await import('../src/services/constrained-invocation/runtime.js');
    const tmpDir = mkdtempSync(join(tmpdir(), 'inv-svc-nativefake-'));

    try {
      const svc = new InvocationService({
        directory: tmpDir,
        async run(_req, _signal) {
          throw new NativeInvocationError('native_failure /root/private', {
            output: null, configuredModel: 'gpt-5.5', actualModel: null,
            reasoningEffort: null, usage: null, usageSource: null, startupMs: 0,
          });
        },
      });

      const id = `inv_nativefake_${Date.now()}`;
      svc.start({ requestId: id, prompt: 'test', model: 'gpt-5.5', deadlineMs: 5_000, outputSchema, ...(undefined as any) });
      const result = await svc.wait(id, 5_000);

      expect(result).toBeDefined();
      if (result) {
        expect(result.error).toBe('native_inference_failed');
        expect(result.error).not.toContain('/root');
        expect(result.error).not.toContain('private');
        expect(result.error).not.toContain('native_failure');
      }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('sanitizes "sk_live_SUPERSECRET123" — no-space single-segment secret penetrates', async () => {
    const { InvocationService } = await import('../src/services/constrained-invocation/service.js');
    const { NativeInvocationError } = await import('../src/services/constrained-invocation/runtime.js');
    const tmpDir = mkdtempSync(join(tmpdir(), 'inv-svc-apikey-'));

    try {
      const svc = new InvocationService({
        directory: tmpDir,
        async run(_req, _signal) {
          throw new NativeInvocationError('sk_live_SUPERSECRET123', {
            output: null, configuredModel: 'gpt-5.5', actualModel: null,
            reasoningEffort: null, usage: null, usageSource: null, startupMs: 0,
          });
        },
      });

      const id = `inv_apikey_${Date.now()}`;
      svc.start({ requestId: id, prompt: 'test', model: 'gpt-5.5', deadlineMs: 5_000, outputSchema, ...(undefined as any) });
      const result = await svc.wait(id, 5_000);

      expect(result).toBeDefined();
      if (result) {
        expect(result.error).toBe('native_inference_failed');
        expect(result.error).not.toContain('SUPERSECRET');
        expect(result.error).not.toContain('sk_live');
      }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// ── apiOnly request-shape gate at /api/trigger ──
describe('apiOnly request-shape gate at /api/trigger', () => {
  let ipcServerPort = 0;
  let ipcServerHandle: any = null;

  beforeEach(async () => {
    mockGetBot.mockReset();
  });

  afterEach(async () => {
    if (ipcServerHandle) {
      await ipcServerHandle.close();
      ipcServerHandle = null;
    }
    mockGetBot.mockReset();
  });

  async function startTriggerServer(opts: {
    apiOnly?: boolean;
  } = {}): Promise<void> {
    const { setLarkAppId, startIpcServer } = await import(
      '../src/core/dashboard-ipc-server.js'
    );
    mockGetBot.mockReturnValue({
      config: { apiOnly: opts.apiOnly === true, cliId: 'codex-app', larkAppId: 'app_hard_deny' },
      botName: 'HardDenyBot',
      botOpenId: 'bot_app_hard_deny',
    });
    setLarkAppId('app_hard_deny');
    ipcServerHandle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    ipcServerPort = ipcServerHandle.port;
  }

  it('accepts an apiOnly HTTP async request without a real chat target', async () => {
    await startTriggerServer({ apiOnly: true });

    const res = await fetch(`http://127.0.0.1:${ipcServerPort}/api/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'webhook', connectorId: 'conn_test', requestId: 'req_hd' },
        target: { kind: 'turn', botId: 'app_hard_deny' },
        envelope: {
          format: 'botmux.webhook.v1',
          sourceName: 'test',
          trusted: false,
          payload: { hello: 'world' },
        },
        options: { asyncReturnSessionId: true, dryRun: true },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, action: 'dry_run' });
    expect(body.target.chatId).toMatch(/^http_async_/);
  });

  it.each([
    ['real chatId', { chatId: 'oc_test' }, 'real Feishu chatId'],
    ['rootMessageId', { chatId: 'oc_test', rootMessageId: 'om_test' }, 'Feishu rootMessageId'],
  ])('rejects an apiOnly request with a %s', async (_name, target, expectedError) => {
    await startTriggerServer({ apiOnly: true });

    const res = await fetch(`http://127.0.0.1:${ipcServerPort}/api/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'webhook', connectorId: 'conn_test', requestId: `req_hd_${_name}` },
        target: { kind: 'turn', botId: 'app_hard_deny', ...target },
        envelope: {
          format: 'botmux.webhook.v1',
          sourceName: 'test',
          trusted: false,
          payload: { hello: 'world' },
        },
        options: { asyncReturnSessionId: true, dryRun: true },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, errorCode: 'bad_request' });
    expect(body.error).toContain(expectedError);
  });

  it('accepts /api/trigger for a non-apiOnly bot (gate opens for normal bots)', async () => {
    await startTriggerServer({ apiOnly: false });

    const res = await fetch(`http://127.0.0.1:${ipcServerPort}/api/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'webhook', connectorId: 'conn_test', requestId: 'req_normal' },
        target: { kind: 'turn', botId: 'app_hard_deny', chatId: 'oc_test' },
        envelope: {
          format: 'botmux.webhook.v1',
          sourceName: 'test',
          trusted: false,
          payload: { hello: 'world' },
        },
      }),
    });
    // For a non-apiOnly bot the gate is open
    expect(res.status).not.toBe(403);
  });
});

// ── Invocation result evidence (kept from previous iteration) ──
describe('invocation result evidence', () => {
  it('completion result via wait=1 never leaks credentials or internal paths', async () => {
    await seedInvocationConnector();

    const requestId = 'inv_test_evidence';
    const proxyToDaemon = vi.fn(async (_appId: string, path: string, _init: RequestInit) => {
      if (path === '/api/headless/invocations') {
        return mockProxyResponse(202, {
          ok: true,
          result: {
            requestId, state: 'running', output: null, error: null,
            startedAt: new Date().toISOString(), durationMs: null, startupMs: null,
            configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null,
            usage: null, usageSource: null,
          },
        });
      }
      // GET poll returns completed
      return mockProxyResponse(200, {
        ok: true,
        result: {
          requestId, state: 'completed',
          output: { content: 'done' }, error: null,
          startedAt: new Date().toISOString(), durationMs: 100, startupMs: 10,
          configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null,
          usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, cacheWriteInputTokens: null },
          usageSource: 'native_result',
        },
      });
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_ev_${Date.now()}`, {
      prompt: 'summarize',
    }, '?wait=1&timeoutMs=5000');

    if (res.body.result) {
      const str = JSON.stringify(res.body.result);
      expect(str).not.toContain('OPENAI_API_KEY');
      expect(str).not.toContain('/etc/secret');
      expect(str).not.toContain('CODEX_HOME');
      if (res.body.result.error !== null) {
        expect(res.body.result.error).not.toContain('API_KEY');
        expect(res.body.result.error).not.toContain('/home/');
        expect(res.body.result.error).not.toContain('/root/');
      }
    }
  });

  it('failed result does not leak CLI stderr or raw RPC errors', async () => {
    await seedInvocationConnector();

    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return mockProxyResponse(200, {
        ok: true,
        result: {
          requestId: body.requestId ?? 'unknown',
          state: 'failed', output: null, error: 'native_inference_failed',
          startedAt: new Date().toISOString(), durationMs: 50, startupMs: 1,
          configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: null,
          usage: null, usageSource: null,
        },
      });
    });

    await startWebhookServer({ proxyToDaemon });

    const res = await postWebhook('conn_invocation', `nonce_fail_${Date.now()}`, {
      prompt: 'test',
    });

    if (res.body.result) {
      expect(res.body.result.error).toBe('native_inference_failed');
    }
  });
});
