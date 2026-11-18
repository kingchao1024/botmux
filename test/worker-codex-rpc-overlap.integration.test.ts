import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import {
  prepareTraexNativeContext,
  settleTraexNativeContextReceipt,
} from '../src/core/traex-native-context.js';
import { CODEX_RPC_TERMINAL_HYDRATION_DELAYS_MS } from '../src/codex-rpc-lifecycle.js';

// 假 server 没有 rollout 文件；等待预算需包含原生终态补证窗口及正常输入等待。
const terminalFollowerWaitMs = CODEX_RPC_TERMINAL_HYDRATION_DELAYS_MS.reduce((sum, delay) => sum + delay, 0) + 15_000;

function requests(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function cleanupFixtureTmux(root: string): void {
  try {
    execFileSync('tmux', ['-L', 'botmux', 'kill-server'], {
      env: { ...process.env, TMUX_TMPDIR: root }, stdio: 'ignore',
    });
  } catch { /* 私有测试 server 未启动或已退出。 */ }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
  else child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolveExit => setTimeout(resolveExit, 3_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

it('re-drives a trusted steer queued before a resume turn/start ACK without releasing ordinary input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-rpc-overlap-'));
  const fakeCodex = join(root, 'fake-codex');
  const requestLog = join(root, 'requests.jsonl');
  const sessionId = `rpc-overlap-${process.pid}-${Date.now()}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  let child: ChildProcess | undefined;

  writeFileSync(fakeCodex, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fixture = ${JSON.stringify(resolve('test/fixtures/fake-codex-rpc-server.mjs'))};
if (process.argv.includes('app-server')) {
  const child = spawn(process.execPath, [fixture, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  // 首帧可能早于 pipe-pane 订阅；重复重绘让测试观察已初始化的真实 pane。
  const ready = '\\x1b[2J\\x1b[H│ model: fixture-model │\\r\\n│ directory: /tmp │\\r\\n› Ask Codex to do anything\\r\\n\\r\\n  fixture-model · /tmp\\x1b[3;3H';
  setTimeout(() => process.stdout.write(ready), 500);
  setInterval(() => process.stdout.write(ready), 2_500);
}
`);
  chmodSync(fakeCodex, 0o755);

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline || child?.exitCode !== null) {
        let screen: string;
        try {
          screen = execFileSync('tmux', ['-L', 'botmux', 'capture-pane', '-p', '-t', `bmx-${sessionId.slice(0, 8)}`], {
            env: { ...process.env, TMUX_TMPDIR: root }, encoding: 'utf8',
          });
        } catch (error) { screen = String(error); }
        throw new Error(`${logs.join('')}\nNative test pane:\n${screen}`);
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  };

  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root, TMUX_TMPDIR: root,
        NODE_ENV: 'test',
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_rpc_overlap',
        LARK_APP_SECRET: 'secret',
        FAKE_TURN_CONFIG_FILE: requestLog,
        FAKE_NO_TURN_TERMINAL: '1',
        FAKE_DELAY_TURN_ACK_MS: '600',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', message => messages.push(message as WorkerToDaemon));

    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_rpc_overlap',
      rootMessageId: 'om_rpc_overlap_root',
      workingDir: resolve('.'),
      cliId: 'codex',
      cliRuntime: {
        id: 'fixture-codex',
        displayName: 'Fixture Codex',
        executable: fakeCodex,
        source: 'configured',
        update: { provider: 'self' },
      },
      cliPathOverride: fakeCodex,
      backendType: 'tmux',
      launchShell: '/bin/sh',
      codexRpcInput: true,
      resume: true,
      cliSessionId: 'thread-resumed',
      prompt: '',
      larkAppId: 'app_rpc_overlap',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    await waitFor(() => messages.some(message => message.type === 'ready'));

    child.send({ type: 'message', content: 'ordinary root', turnId: 'om_root' } satisfies DaemonToWorker);
    await waitFor(() => requests(requestLog).some(request => request.clientUserMessageId === 'om_root'));

    child.send({
      type: 'message',
      content: 'trusted steer',
      turnId: 'om_steer',
      codexAppSteerable: true,
      trustedCaller: { requestUserOpenId: 'ou_peer', senderType: 'bot' },
    } satisfies DaemonToWorker);

    await waitFor(() => requests(requestLog).some(request => request.expectedTurnId === 'turn-fake-1'));
    child.send({ type: 'message', content: 'ordinary follower', turnId: 'om_ordinary' } satisfies DaemonToWorker);
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    const turnRequests = requests(requestLog);
    expect(turnRequests.filter(request => request.clientUserMessageId === 'om_root')).toHaveLength(1);
    expect(turnRequests.filter(request => request.expectedTurnId === 'turn-fake-1')).toHaveLength(1);
    expect(turnRequests.filter(request => request.clientUserMessageId === 'om_steer')).toHaveLength(0);
    expect(turnRequests.filter(request => request.clientUserMessageId === 'om_ordinary')).toHaveLength(0);
    expect(messages.filter(message => message.type === 'turn_terminal')).toEqual([]);
    expect(logs.join('')).not.toContain('rpc_engine_dead');
  } finally {
    if (child) await stop(child);
    cleanupFixtureTmux(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

it('fails a trusted steer whose root terminal arrived before the delayed ACK, then releases ordinary input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-rpc-terminal-first-'));
  const fakeCodex = join(root, 'fake-codex');
  const requestLog = join(root, 'requests.jsonl');
  const sessionId = `rpc-terminal-first-${process.pid}-${Date.now()}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  let child: ChildProcess | undefined;

  writeFileSync(fakeCodex, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fixture = ${JSON.stringify(resolve('test/fixtures/fake-codex-rpc-server.mjs'))};
if (process.argv.includes('app-server')) {
  const child = spawn(process.execPath, [fixture, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  const ready = '\\x1b[2J\\x1b[H│ model: fixture-model │\\r\\n│ directory: /tmp │\\r\\n› Ask Codex to do anything\\r\\n\\r\\n  fixture-model · /tmp\\x1b[3;3H';
  setTimeout(() => process.stdout.write(ready), 500);
  setInterval(() => process.stdout.write(ready), 2_500);
}
`);
  chmodSync(fakeCodex, 0o755);

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline || child?.exitCode !== null) throw new Error(logs.join(''));
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  };

  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root, TMUX_TMPDIR: root,
        NODE_ENV: 'test',
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_rpc_terminal_first',
        LARK_APP_SECRET: 'secret',
        FAKE_TURN_CONFIG_FILE: requestLog,
        FAKE_TERMINAL_BEFORE_RESPONSE: '1',
        FAKE_DELAY_TURN_ACK_MS: '600',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', message => messages.push(message as WorkerToDaemon));

    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_rpc_terminal_first',
      rootMessageId: 'om_rpc_terminal_first_root',
      workingDir: resolve('.'),
      cliId: 'codex',
      cliRuntime: {
        id: 'fixture-codex',
        displayName: 'Fixture Codex',
        executable: fakeCodex,
        source: 'configured',
        update: { provider: 'self' },
      },
      cliPathOverride: fakeCodex,
      backendType: 'tmux',
      launchShell: '/bin/sh',
      codexRpcInput: true,
      resume: true,
      cliSessionId: 'thread-resumed',
      prompt: '',
      larkAppId: 'app_rpc_terminal_first',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    await waitFor(() => messages.some(message => message.type === 'ready'));

    child.send({ type: 'message', content: 'ordinary root', turnId: 'om_root' } satisfies DaemonToWorker);
    await waitFor(() => requests(requestLog).some(request => request.clientUserMessageId === 'om_root'));
    child.send({
      type: 'message',
      content: 'trusted steer',
      turnId: 'om_steer',
      codexAppSteerable: true,
      trustedCaller: { requestUserOpenId: 'ou_peer', senderType: 'bot' },
    } satisfies DaemonToWorker);
    child.send({ type: 'message', content: 'ordinary follower', turnId: 'om_ordinary' } satisfies DaemonToWorker);

    await waitFor(() => messages.some(message => message.type === 'turn_terminal'
      && message.turnId === 'om_steer'));
    await waitFor(
      () => requests(requestLog).some(request => request.clientUserMessageId === 'om_ordinary'),
      terminalFollowerWaitMs,
    );

    const steerTerminals = messages.filter(
      (message): message is Extract<WorkerToDaemon, { type: 'turn_terminal' }> => message.type === 'turn_terminal'
        && message.turnId === 'om_steer',
    );
    expect(steerTerminals).toEqual([expect.objectContaining({
      status: 'failed',
      errorCode: 'steer_target_no_longer_active',
    })]);
    const turnRequests = requests(requestLog);
    expect(turnRequests.filter(request => request.expectedTurnId !== undefined)).toHaveLength(0);
    expect(turnRequests.filter(request => request.clientUserMessageId === 'om_root')).toHaveLength(1);
    expect(turnRequests.filter(request => request.clientUserMessageId === 'om_steer')).toHaveLength(0);
    expect(turnRequests.filter(request => request.clientUserMessageId === 'om_ordinary')).toHaveLength(1);
    expect(logs.join('')).not.toContain('rpc_engine_dead');
  } finally {
    if (child) await stop(child);
    cleanupFixtureTmux(root);
    rmSync(root, { recursive: true, force: true });
  }
// 总预算包含冷启动、首次派发，以及终态补证后后继输入的等待。
}, 30_000 + terminalFollowerWaitMs);

it('releases an ordinary follower when the native terminal arrives while turn/steer awaits its ACK', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-rpc-steer-terminal-race-'));
  const fakeCodex = join(root, 'fake-codex');
  const requestLog = join(root, 'requests.jsonl');
  const sessionId = `rpc-steer-terminal-race-${process.pid}-${Date.now()}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  let child: ChildProcess | undefined;

  writeFileSync(fakeCodex, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fixture = ${JSON.stringify(resolve('test/fixtures/fake-codex-rpc-server.mjs'))};
if (process.argv.includes('app-server')) {
  const child = spawn(process.execPath, [fixture, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  const ready = '\\x1b[2J\\x1b[H│ model: fixture-model │\\r\\n│ directory: /tmp │\\r\\n› Ask Codex to do anything\\r\\n\\r\\n  fixture-model · /tmp\\x1b[3;3H';
  setTimeout(() => process.stdout.write(ready), 500);
  setInterval(() => process.stdout.write(ready), 2_500);
}
`);
  chmodSync(fakeCodex, 0o755);

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline || child?.exitCode !== null) throw new Error(logs.join(''));
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  };

  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root, TMUX_TMPDIR: root,
        NODE_ENV: 'test',
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_rpc_steer_terminal_race',
        LARK_APP_SECRET: 'secret',
        FAKE_TURN_CONFIG_FILE: requestLog,
        FAKE_NO_TURN_TERMINAL: '1',
        FAKE_STEER_TERMINAL_BEFORE_RESPONSE: '1',
        FAKE_DELAY_STEER_ACK_MS: '600',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', message => messages.push(message as WorkerToDaemon));

    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_rpc_steer_terminal_race',
      rootMessageId: 'om_rpc_steer_terminal_race_root',
      workingDir: resolve('.'),
      cliId: 'codex',
      cliRuntime: {
        id: 'fixture-codex',
        displayName: 'Fixture Codex',
        executable: fakeCodex,
        source: 'configured',
        update: { provider: 'self' },
      },
      cliPathOverride: fakeCodex,
      backendType: 'tmux',
      launchShell: '/bin/sh',
      codexRpcInput: true,
      resume: true,
      cliSessionId: 'thread-resumed',
      prompt: '',
      larkAppId: 'app_rpc_steer_terminal_race',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    await waitFor(() => messages.some(message => message.type === 'ready'));

    child.send({ type: 'message', content: 'ordinary root', turnId: 'om_root' } satisfies DaemonToWorker);
    await waitFor(() => requests(requestLog).some(request => request.clientUserMessageId === 'om_root'));
    child.send({
      type: 'message',
      content: 'trusted steer',
      turnId: 'om_steer',
      codexAppSteerable: true,
      trustedCaller: { requestUserOpenId: 'ou_peer', senderType: 'bot' },
    } satisfies DaemonToWorker);
    await waitFor(() => requests(requestLog).some(request => request.expectedTurnId === 'turn-fake-1'));
    child.send({ type: 'message', content: 'ordinary follower', turnId: 'om_ordinary' } satisfies DaemonToWorker);

    await waitFor(() => requests(requestLog).some(request => request.clientUserMessageId === 'om_ordinary'), 3_000);
    const turnRequests = requests(requestLog);
    expect(turnRequests.filter(request => request.expectedTurnId === 'turn-fake-1')).toHaveLength(1);
    expect(turnRequests.filter(request => request.clientUserMessageId === 'om_ordinary')).toHaveLength(1);
    expect(logs.join('')).not.toContain('rpc_engine_dead');
  } finally {
    if (child) await stop(child);
    cleanupFixtureTmux(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

it('keeps accepted role and skill context out of a same-thread TraeX worker restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-traex-context-'));
  const fakeTraex = join(root, 'fake-traex');
  const requestLog = join(root, 'requests.jsonl');
  const role = '<role context="group">AUTHORIZATION_BOUNDARY</role>';
  const skills = '<botmux_skills mode="priority"><skill name="review" trigger="review" /></botmux_skills>';
  const firstPrompt = `${role}\n\n${skills}\n\n<user_message>first</user_message>`;
  const logs: string[] = [];
  let firstChild: ChildProcess | undefined;
  let secondChild: ChildProcess | undefined;

  writeFileSync(fakeTraex, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fixture = ${JSON.stringify(resolve('test/fixtures/fake-codex-rpc-server.mjs'))};
if (process.argv.includes('app-server')) {
  const child = spawn(process.execPath, [fixture, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  const ready = '\\x1b[2J\\x1b[H│ model: fixture-model │\\r\\n│ directory: /tmp │\\r\\n› Ask TRAE CLI to do anything\\r\\n\\r\\n  fixture-model · Context 100% left · /tmp\\x1b[3;3H';
  setTimeout(() => process.stdout.write(ready), 200);
  setInterval(() => process.stdout.write(ready), 2_500);
}
`);
  chmodSync(fakeTraex, 0o755);

  const waitFor = async (predicate: () => boolean, child: ChildProcess, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline || child.exitCode !== null) throw new Error(logs.join(''));
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  };
  const baseInit = {
    chatId: 'oc_traex_context',
    rootMessageId: 'om_traex_context_root',
    workingDir: resolve('.'),
    cliId: 'traex',
    cliRuntime: {
      id: 'fixture-traex', displayName: 'Fixture TraeX', executable: fakeTraex,
      source: 'configured', update: { provider: 'self' },
    },
    cliPathOverride: fakeTraex,
    backendType: 'tmux' as const,
    launchShell: '/bin/sh',
    codexRpcInput: true,
    promptInjection: 'none' as const,
    larkAppId: 'app_traex_context',
    larkAppSecret: 'secret',
  };

  try {
    const firstMessages: WorkerToDaemon[] = [];
    firstChild = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root, TMUX_TMPDIR: root, NODE_ENV: 'test', SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: 'sid-traex-context-first',
        LARK_APP_ID: 'app_traex_context', LARK_APP_SECRET: 'secret',
        FAKE_TURN_CONFIG_FILE: requestLog,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    firstChild.stdout?.on('data', chunk => logs.push(chunk.toString()));
    firstChild.stderr?.on('data', chunk => logs.push(chunk.toString()));
    firstChild.on('message', message => firstMessages.push(message as WorkerToDaemon));
    firstChild.send({
      type: 'init', ...baseInit, sessionId: 'sid-traex-context-first',
      prompt: firstPrompt, turnId: 'om_first',
    } satisfies DaemonToWorker);
    await waitFor(() => firstMessages.some(message =>
      message.type === 'traex_native_context_receipt'
      && message.receipt.status === 'accepted'), firstChild);
    const receiptMessage = firstMessages.find(
      (message): message is Extract<WorkerToDaemon, { type: 'traex_native_context_receipt' }> =>
        message.type === 'traex_native_context_receipt',
    )!;
    expect(receiptMessage.receipt).toMatchObject({
      nativeThreadId: 'thread-fake-1', turnId: 'om_first', status: 'accepted',
      roleDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      skillCatalogDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await stop(firstChild);
    cleanupFixtureTmux(root);

    const secondPrompt = `${role}\n\n${skills}\n\n<user_message>second</user_message>`;
    const secondMessages: WorkerToDaemon[] = [];
    secondChild = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root, TMUX_TMPDIR: root, NODE_ENV: 'test', SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: 'sid-traex-context-second',
        LARK_APP_ID: 'app_traex_context', LARK_APP_SECRET: 'secret',
        FAKE_TURN_CONFIG_FILE: requestLog,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    secondChild.stdout?.on('data', chunk => logs.push(chunk.toString()));
    secondChild.stderr?.on('data', chunk => logs.push(chunk.toString()));
    secondChild.on('message', message => secondMessages.push(message as WorkerToDaemon));
    secondChild.send({
      type: 'init', ...baseInit, sessionId: 'sid-traex-context-second',
      prompt: secondPrompt, turnId: 'om_second', resume: true, cliSessionId: 'thread-fake-1',
      traexNativeContextReceipt: receiptMessage.receipt,
    } satisfies DaemonToWorker);
    await waitFor(() => requests(requestLog).some(request =>
      request.clientUserMessageId === 'om_second'), secondChild);

    const secondRequest = requests(requestLog).find(request => request.clientUserMessageId === 'om_second')!;
    const sentText = (secondRequest.input as Array<{ text: string }>)[0]!.text;
    expect(sentText).toContain('<user_message>second</user_message>');
    expect(sentText).not.toContain('<role');
    expect(sentText).not.toContain('<botmux_skills');
  } finally {
    if (firstChild) await stop(firstChild);
    if (secondChild) await stop(secondChild);
    cleanupFixtureTmux(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 35_000);

it('deduplicates two self-contained TraeX FIFO entries against the latest accepted receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-traex-prepared-'));
  const fakeTraex = join(root, 'fake-traex');
  const requestLog = join(root, 'requests.jsonl');
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  let child: ChildProcess | undefined;

  writeFileSync(fakeTraex, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fixture = ${JSON.stringify(resolve('test/fixtures/fake-codex-rpc-server.mjs'))};
if (process.argv.includes('app-server')) {
  const child = spawn(process.execPath, [fixture, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  const ready = '\\x1b[2J\\x1b[H│ model: fixture-model │\\r\\n│ directory: /tmp │\\r\\n› Ask TRAE CLI to do anything\\r\\n\\r\\n  fixture-model · Context 100% left · /tmp\\x1b[3;3H';
  setTimeout(() => process.stdout.write(ready), 200);
  setInterval(() => process.stdout.write(ready), 2_500);
}
`);
  chmodSync(fakeTraex, 0o755);

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline || child?.exitCode !== null) throw new Error(logs.join(''));
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  };
  const roleA = '<role context="group">AUTH_VERSION_A</role>';
  const roleB = '<role context="group">AUTH_VERSION_B</role>';
  const first = prepareTraexNativeContext(
    `${roleA}\n\n<user_message>old</user_message>`,
    'thread-resumed',
  );
  const receipt = settleTraexNativeContextReceipt(first, 'om_old', 'accepted')!;
  const contentB = `${roleB}\n\n<user_message>B</user_message>`;
  const contentC = `${roleB}\n\n<user_message>C</user_message>`;

  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root, TMUX_TMPDIR: root,
        NODE_ENV: 'test',
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: 'sid-traex-prepared',
        LARK_APP_ID: 'app_traex_prepared',
        LARK_APP_SECRET: 'secret',
        FAKE_TURN_CONFIG_FILE: requestLog,
        FAKE_TURN_STATUS: 'failed',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', message => messages.push(message as WorkerToDaemon));
    child.send({
      type: 'init',
      sessionId: 'sid-traex-prepared',
      chatId: 'oc_traex_prepared',
      rootMessageId: 'om_traex_prepared_root',
      workingDir: resolve('.'),
      cliId: 'traex',
      cliRuntime: {
        id: 'fixture-traex', displayName: 'Fixture TraeX', executable: fakeTraex,
        source: 'configured', update: { provider: 'self' },
      },
      cliPathOverride: fakeTraex,
      backendType: 'tmux',
      launchShell: '/bin/sh',
      codexRpcInput: true,
      promptInjection: 'none',
      larkAppId: 'app_traex_prepared',
      larkAppSecret: 'secret',
      resume: true,
      cliSessionId: 'thread-resumed',
      prompt: '',
      traexNativeContextReceipt: receipt,
    } satisfies DaemonToWorker);
    await waitFor(() => messages.some(message => message.type === 'ready'));

    child.send({
      type: 'message', content: contentB, turnId: 'om_B', queueAfterActiveTurn: true,
    } satisfies DaemonToWorker);
    child.send({
      type: 'message', content: contentC, turnId: 'om_C', queueAfterActiveTurn: true,
    } satisfies DaemonToWorker);

    await waitFor(() => requests(requestLog).filter(request =>
      request.clientUserMessageId === 'om_B' || request.clientUserMessageId === 'om_C').length === 2);
    const sent = requests(requestLog).filter(request =>
      request.clientUserMessageId === 'om_B' || request.clientUserMessageId === 'om_C');
    expect(sent.map(request => request.clientUserMessageId)).toEqual(['om_B', 'om_C']);
    expect((sent[0]!.input as Array<{ text: string }>)[0]!.text).toContain(roleB);
    expect((sent[1]!.input as Array<{ text: string }>)[0]!.text).not.toContain('<role');
  } finally {
    if (child) await stop(child);
    cleanupFixtureTmux(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

it('resends full TraeX context when the latest same-thread receipt is unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-traex-unknown-'));
  const fakeTraex = join(root, 'fake-traex');
  const requestLog = join(root, 'requests.jsonl');
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  let child: ChildProcess | undefined;

  writeFileSync(fakeTraex, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fixture = ${JSON.stringify(resolve('test/fixtures/fake-codex-rpc-server.mjs'))};
if (process.argv.includes('app-server')) {
  const child = spawn(process.execPath, [fixture, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  const ready = '\\x1b[2J\\x1b[H│ model: fixture-model │\\r\\n│ directory: /tmp │\\r\\n› Ask TRAE CLI to do anything\\r\\n\\r\\n  fixture-model · Context 100% left · /tmp\\x1b[3;3H';
  setTimeout(() => process.stdout.write(ready), 200);
  setInterval(() => process.stdout.write(ready), 2_500);
}
`);
  chmodSync(fakeTraex, 0o755);

  const role = '<role context="group">AUTH_VERSION_A</role>';
  const first = prepareTraexNativeContext(
    `${role}\n\n<user_message>old</user_message>`,
    'thread-resumed',
  );
  const accepted = settleTraexNativeContextReceipt(first, 'om_old', 'accepted')!;
  const content = `${role}\n\n<user_message>resumed-user</user_message>`;

  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root, TMUX_TMPDIR: root,
        NODE_ENV: 'test',
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: 'sid-traex-unknown',
        LARK_APP_ID: 'app_traex_unknown',
        LARK_APP_SECRET: 'secret',
        FAKE_TURN_CONFIG_FILE: requestLog,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', message => messages.push(message as WorkerToDaemon));
    child.send({
      type: 'init',
      sessionId: 'sid-traex-unknown',
      chatId: 'oc_traex_unknown',
      rootMessageId: 'om_traex_unknown_root',
      workingDir: resolve('.'),
      cliId: 'traex',
      cliRuntime: {
        id: 'fixture-traex', displayName: 'Fixture TraeX', executable: fakeTraex,
        source: 'configured', update: { provider: 'self' },
      },
      cliPathOverride: fakeTraex,
      backendType: 'tmux',
      launchShell: '/bin/sh',
      codexRpcInput: true,
      promptInjection: 'none',
      larkAppId: 'app_traex_unknown',
      larkAppSecret: 'secret',
      resume: true,
      cliSessionId: 'thread-resumed',
      prompt: content,
      turnId: 'om_resume',
      traexNativeContextReceipt: { ...accepted, status: 'unknown' },
    } satisfies DaemonToWorker);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline
      && requests(requestLog).length === 0
      && !messages.some(message => message.type === 'error' || message.type === 'user_notify')) {
      if (child.exitCode !== null) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    const sent = requests(requestLog).filter(request => request.clientUserMessageId === 'om_resume');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.input as Array<{ text: string }>)[0]!.text).toBe(content);
  } finally {
    if (child) await stop(child);
    cleanupFixtureTmux(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it('resends full TraeX context when the saved receipt belongs to another native thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-traex-thread-mismatch-'));
  const fakeTraex = join(root, 'fake-traex');
  const requestLog = join(root, 'requests.jsonl');
  const ptyInputLog = join(root, 'pty-input.txt');
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  let child: ChildProcess | undefined;

  writeFileSync(fakeTraex, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fixture = ${JSON.stringify(resolve('test/fixtures/fake-codex-rpc-server.mjs'))};
if (process.argv.includes('app-server')) {
  const child = spawn(process.execPath, [fixture, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  process.stdin.on('data', data => require('node:fs').appendFileSync(${JSON.stringify(ptyInputLog)}, data));
  const ready = '\\x1b[2J\\x1b[H│ model: fixture-model │\\r\\n│ directory: /tmp │\\r\\n› Ask TRAE CLI to do anything\\r\\n\\r\\n  fixture-model · Context 100% left · /tmp\\x1b[3;3H';
  setTimeout(() => process.stdout.write(ready), 200);
  setInterval(() => process.stdout.write(ready), 2_500);
}
`);
  chmodSync(fakeTraex, 0o755);

  const role = '<role context="group">AUTH_VERSION_A</role>';
  const first = prepareTraexNativeContext(
    `${role}\n\n<user_message>old</user_message>`,
    'foreign-native-thread',
  );
  const accepted = settleTraexNativeContextReceipt(first, 'om_old', 'accepted')!;
  const content = `${role}\n\n<user_message>resumed-user</user_message>`;

  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root, TMUX_TMPDIR: root,
        NODE_ENV: 'test',
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: 'sid-traex-thread-mismatch',
        LARK_APP_ID: 'app_traex_thread_mismatch',
        LARK_APP_SECRET: 'secret',
        FAKE_TURN_CONFIG_FILE: requestLog,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', message => messages.push(message as WorkerToDaemon));
    child.send({
      type: 'init',
      sessionId: 'sid-traex-thread-mismatch',
      chatId: 'oc_traex_thread_mismatch',
      rootMessageId: 'om_traex_thread_mismatch_root',
      workingDir: resolve('.'),
      cliId: 'traex',
      cliRuntime: {
        id: 'fixture-traex', displayName: 'Fixture TraeX', executable: fakeTraex,
        source: 'configured', update: { provider: 'self' },
      },
      cliPathOverride: fakeTraex,
      backendType: 'tmux',
      launchShell: '/bin/sh',
      codexRpcInput: true,
      promptInjection: 'none',
      larkAppId: 'app_traex_thread_mismatch',
      larkAppSecret: 'secret',
      resume: true,
      cliSessionId: 'thread-resumed',
      prompt: content,
      turnId: 'om_resume',
      traexNativeContextReceipt: accepted,
    } satisfies DaemonToWorker);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline
      && requests(requestLog).length === 0
      && !messages.some(message => message.type === 'error' || message.type === 'user_notify')
      && !logs.join('').includes('falling back to paste mode')) {
      if (child.exitCode !== null) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));

    const sent = requests(requestLog).filter(request => request.clientUserMessageId === 'om_resume');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.input as Array<{ text: string }>)[0]!.text).toBe(content);
    expect(logs.join('')).not.toContain('falling back to paste mode');
    const pasted = existsSync(ptyInputLog) ? readFileSync(ptyInputLog, 'utf8') : '';
    expect(pasted).not.toContain('resumed-user');
    expect(messages.filter(message => message.type === 'error')).toHaveLength(0);
  } finally {
    if (child) await stop(child);
    cleanupFixtureTmux(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
