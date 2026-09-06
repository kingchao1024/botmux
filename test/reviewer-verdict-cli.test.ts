import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const CAPABILITY = 'ab'.repeat(32);
const WAIT_TIMEOUT_MS = 5_000;
const tempDirs: string[] = [];
let server: ReturnType<typeof createServer> | undefined;

function bounded<T>(promise: Promise<T>, condition: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`timed out waiting for ${condition}`));
    }, WAIT_TIMEOUT_MS);
    promise.then(
      value => { clearTimeout(timeout); resolve(value); },
      error => { clearTimeout(timeout); reject(error); },
    );
  });
}

afterEach(async () => {
  const currentServer = server;
  server = undefined;
  await bounded(
    new Promise<void>(resolve => currentServer?.close(() => resolve()) ?? resolve()),
    'reviewer verdict test server close',
    () => currentServer?.closeAllConnections(),
  );
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

function run(args: string[], input: { dataDir: string; relayDir: string; port: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  let child: ChildProcessWithoutNullStreams | undefined;
  const completed = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child = spawnTsScript(CLI_PATH, ['reviewer-verdict', ...args], {
      env: {
        ...process.env, SESSION_DATA_DIR: input.dataDir, BOTMUX_SESSION_ID: 'review-session', BOTMUX_LARK_APP_ID: 'reviewer-app',
        BOTMUX_SEND_RELAY: input.relayDir, BOTMUX_DAEMON_IPC_PORT: String(input.port), BOTMUX_TURN_ID: 'review-turn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
  return bounded(completed, 'reviewer verdict CLI child exit', () => child?.kill('SIGKILL'));
}

describe('botmux reviewer-verdict submit', () => {
  it('forwards only typed review fields plus the session-scoped capability; it cannot select reviewer identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-reviewer-verdict-cli-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-reviewer-verdict-cli-relay-'));
    tempDirs.push(dataDir, relayDir);
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({ token: CAPABILITY, turnId: 'review-turn' }), { mode: 0o600 });
    let path = ''; let body: Record<string, unknown> = {};
    server = createServer(async (req, res) => {
      path = req.url ?? ''; body = await readJson(req);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, verdictId: 'verdict-1' }));
    });
    await bounded(new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    }), 'reviewer verdict test server listen', () => server?.close());
    const port = (server.address() as AddressInfo).port;
    const result = await run([
      'submit', '--source-message-id', 'om_review', '--verdict-id', 'verdict-1', '--verdict', 'pass',
      '--doc-token', 'doc-token-12345678', '--doc-revision', '9', '--review-round', '1',
    ], { dataDir, relayDir, port });
    expect(result).toMatchObject({ status: 0, stdout: '{"ok":true,"verdictId":"verdict-1"}\n' });
    expect(path).toBe('/api/task-control/reviewer-verdicts/submit');
    expect(body).toEqual({
      originCapability: CAPABILITY, originTurnId: 'review-turn', sourceMessageId: 'om_review',
      verdictId: 'verdict-1', verdict: 'pass', docToken: 'doc-token-12345678', docRevision: 9, reviewRound: 1,
      conditionIds: [], resolvedConditionEvidence: {},
    });
    expect(JSON.stringify(body)).not.toMatch(/reviewerId|larkAppId|workerGeneration|keyId|signature|sourceVersionHash/);
  });

  it('rejects a caller-supplied identity field before contacting the daemon', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-reviewer-verdict-cli-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-reviewer-verdict-cli-relay-'));
    tempDirs.push(dataDir, relayDir);
    const result = await run([
      'submit', '--source-message-id', 'om_review', '--verdict-id', 'verdict-1', '--verdict', 'pass',
      '--doc-token', 'doc-token-12345678', '--doc-revision', '9', '--review-round', '1', '--reviewer-id', 'forged',
    ], { dataDir, relayDir, port: 1 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('未知参数');
  });
});
