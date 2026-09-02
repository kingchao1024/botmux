/**
 * CLI boundary regression for `botmux ask` custom replies.
 *
 * Runs the real cmdAsk dispatch in a subprocess against a tiny fake daemon so
 * stdout, stderr, and the process exit code are covered together. Using the
 * source entry through tsx keeps this unit test independent of a prior build.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runAsk(
  dataDir: string,
  args = ['ask', 'buttons', '--options', 'yes,no', '请作答'],
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(
      CLI_PATH,
      args,
      {
        env: {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'sess_test',
          BOTMUX_CHAT_ID: 'oc_test',
          BOTMUX_LARK_APP_ID: 'cli_test',
          BOTMUX_ROOT_MESSAGE_ID: 'om_test',
          ...envOverrides,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as ChildProcessWithoutNullStreams;

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('botmux ask — CLI boundary', () => {
  it('--multi 发送多选问题并输出逗号分隔的 keys', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);
    let requestBody: Record<string, unknown> | undefined;

    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [['a', 'c']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir, [
        'ask', 'buttons', '--multi', '--options', 'a=A,b=B,c=C', '请选择',
      ]);
      expect(result).toMatchObject({ status: 0, stdout: 'a,c\n', stderr: '' });
      expect(requestBody?.questions).toEqual([{
        prompt: '请选择',
        multiSelect: true,
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
          { key: 'c', label: 'C' },
        ],
      }]);
      expect(requestBody).not.toHaveProperty('originKind');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it('--multi --json 恰好选 1 项时 selected 恒为 null（不因形状退化成 key）', async () => {
    // 回归护栏：`selected` 是「单问单选」的向后兼容值（toLegacySelected 的形状判据
    // 恰好 1 问 × 1 key）。多选恰好选 1 项时形状同样是 1×1，若不显式清零，`selected`
    // 会退化出一个 key，令其含义随选中数量漂移。--multi 下必须恒 null，调用方读
    // `answers[0]`。
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);

    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [['b']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir, [
        'ask', 'buttons', '--multi', '--json', '--options', 'a=A,b=B,c=C', '请选择',
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        selected: null,
        answers: [['b']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
        receipt: null,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it('文字作答保持空 stdout / exit 0，并在 stderr 指明用 --json 读取 comment', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [[]],
        by: 'ou_test',
        comment: '我想先灰度 10% 再全量',
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('\n');
      expect(result.stderr).toContain('用户以文字作答');
      expect(result.stderr).toContain('--json');
      expect(result.stderr).toContain('comment');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it('S1 controller asks use the dedicated endpoint and carry absolute window fields only', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);
    let requestPath = '';
    let requestBody: Record<string, unknown> | undefined;

    const server = createServer(async (req, res) => {
      requestPath = req.url ?? '';
      let body = '';
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [['yes']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir, [
        'ask', 'buttons', '--json', '--s1-controller',
        '--phase', 'binding',
        '--chat-id', 'oc_binding',
        '--request-id', 'a'.repeat(64),
        '--not-before-ms', '1700000000000',
        '--expires-at-ms', '1700086400000',
        '--options', 'yes,no',
        'S1 controller question',
      ]);
      expect(result.status).toBe(0);
      expect(requestPath).toBe('/api/asks/s1-controller');
      expect(requestBody).toMatchObject({
        phase: 'binding',
        larkAppId: 'cli_test',
        chatId: 'oc_binding',
        requestId: 'a'.repeat(64),
        notBeforeMs: 1_700_000_000_000,
        expiresAtMs: 1_700_086_400_000,
      });
      expect(requestBody).not.toHaveProperty('sessionId');
      expect(requestBody).not.toHaveProperty('rootMessageId');
      expect(requestBody).not.toHaveProperty('originKind');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it('S1 recover-only selects the recovery endpoint', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);
    let requestPath = '';

    const server = createServer(async (req, res) => {
      requestPath = req.url ?? '';
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [['yes']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir, [
        'ask', 'buttons', '--json', '--s1-controller', '--recover-only',
        '--phase', 'binding',
        '--chat-id', 'oc_binding',
        '--request-id', 'b'.repeat(64),
        '--not-before-ms', '1700000000000',
        '--expires-at-ms', '1700086400000',
        '--options', 'yes,no',
        'S1 recovery question',
      ]);
      expect(result.status).toBe(0);
      expect(requestPath).toBe('/api/asks/s1-controller/recover');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it('S1 binding asks still work when session/root env is absent after restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);
    let requestBody: Record<string, unknown> | undefined;

    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [['yes']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(
        dataDir,
        [
          'ask', 'buttons', '--json', '--s1-controller',
          '--phase', 'binding',
          '--chat-id', 'oc_binding',
          '--request-id', 'c'.repeat(64),
          '--not-before-ms', '1700000000000',
          '--expires-at-ms', '1700086400000',
          '--options', 'yes,no',
          'S1 controller question',
        ],
        {
          BOTMUX_SESSION_ID: undefined,
          BOTMUX_ROOT_MESSAGE_ID: undefined,
          BOTMUX_CHAT_ID: undefined,
        },
      );
      expect(result.status).toBe(0);
      expect(requestBody).toMatchObject({
        phase: 'binding',
        larkAppId: 'cli_test',
        chatId: 'oc_binding',
        requestId: 'c'.repeat(64),
      });
      expect(requestBody).not.toHaveProperty('sessionId');
      expect(requestBody).not.toHaveProperty('rootMessageId');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it('S1 execution asks carry chat selector plus exact session/root hints', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);
    let requestBody: Record<string, unknown> | undefined;

    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [['yes']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir, [
        'ask', 'buttons', '--json', '--s1-controller',
        '--phase', 'execution',
        '--chat-id', 'oc_exec',
        '--request-id', 'd'.repeat(64),
        '--not-before-ms', '1700000000000',
        '--expires-at-ms', '1700086400000',
        '--options', 'yes,no',
        'S1 execution question',
      ]);
      expect(result.status).toBe(0);
      expect(requestBody).toMatchObject({
        phase: 'execution',
        larkAppId: 'cli_test',
        chatId: 'oc_exec',
        sessionId: 'sess_test',
        rootMessageId: 'om_test',
        requestId: 'd'.repeat(64),
        notBeforeMs: 1_700_000_000_000,
        expiresAtMs: 1_700_086_400_000,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });
});
