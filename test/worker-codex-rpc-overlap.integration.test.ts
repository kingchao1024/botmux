import { type ChildProcess } from 'node:child_process';
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

function requests(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
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
  setTimeout(() => process.stdout.write('› Ask Codex to do anything\\n'), 500);
  setInterval(() => {}, 1_000);
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
        HOME: root,
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
  setTimeout(() => process.stdout.write('› Ask Codex to do anything\\n'), 500);
  setInterval(() => {}, 1_000);
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
        HOME: root,
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
    await waitFor(() => requests(requestLog).some(request => request.clientUserMessageId === 'om_ordinary'));

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
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

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
  setTimeout(() => process.stdout.write('› Ask Codex to do anything\\n'), 500);
  setInterval(() => {}, 1_000);
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
        HOME: root,
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
  setTimeout(() => process.stdout.write('› Ask TraeX to do anything\\n'), 200);
  setInterval(() => {}, 1_000);
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
        ...process.env, HOME: root, NODE_ENV: 'test', SESSION_DATA_DIR: root,
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

    const secondPrompt = `${role}\n\n${skills}\n\n<user_message>second</user_message>`;
    const prepared = prepareTraexNativeContext(secondPrompt, 'thread-fake-1', receiptMessage.receipt);
    const { content, contextVersion: _contextVersion, ...traexNativeContext } = prepared;
    const secondMessages: WorkerToDaemon[] = [];
    secondChild = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root, NODE_ENV: 'test', SESSION_DATA_DIR: root,
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
      prompt: content, turnId: 'om_second', resume: true, cliSessionId: 'thread-fake-1',
      traexNativeContext, traexNativeContextReceipt: receiptMessage.receipt,
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
    rmSync(root, { recursive: true, force: true });
  }
}, 35_000);

it('revalidates two prepared TraeX FIFO entries against the latest accepted receipt', async () => {
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
  setTimeout(() => process.stdout.write('› Ask TraeX to do anything\\n'), 200);
  setInterval(() => process.stdout.write('\\x1b[2J\\x1b[H› Ask TraeX to do anything\\n'), 2_500);
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
  const preparedB = prepareTraexNativeContext(
    `${roleB}\n\n<user_message>B</user_message>`,
    'thread-resumed',
    receipt,
  );
  const preparedC = prepareTraexNativeContext(
    `${roleB}\n\n<user_message>C</user_message>`,
    'thread-resumed',
    receipt,
  );
  const { content: contentB, contextVersion: _versionB, ...metadataB } = preparedB;
  const { content: contentC, contextVersion: _versionC, ...metadataC } = preparedC;

  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
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
      traexNativeContext: metadataB,
    } satisfies DaemonToWorker);
    child.send({
      type: 'message', content: contentC, turnId: 'om_C', queueAfterActiveTurn: true,
      traexNativeContext: metadataC,
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
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

it('blocks a prepared TraeX resume when the latest same-thread receipt is unknown', async () => {
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
  setTimeout(() => process.stdout.write('› Ask TraeX to do anything\\n'), 200);
  setInterval(() => {}, 1_000);
}
`);
  chmodSync(fakeTraex, 0o755);

  const role = '<role context="group">AUTH_VERSION_A</role>';
  const first = prepareTraexNativeContext(
    `${role}\n\n<user_message>old</user_message>`,
    'thread-resumed',
  );
  const accepted = settleTraexNativeContextReceipt(first, 'om_old', 'accepted')!;
  const queued = prepareTraexNativeContext(
    `${role}\n\n<user_message>resumed-user</user_message>`,
    'thread-resumed',
    accepted,
  );
  const { content, contextVersion: _contextVersion, ...metadata } = queued;

  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
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
      codexRpcInput: true,
      promptInjection: 'none',
      larkAppId: 'app_traex_unknown',
      larkAppSecret: 'secret',
      resume: true,
      cliSessionId: 'thread-resumed',
      prompt: content,
      turnId: 'om_resume',
      traexNativeContext: metadata,
      traexNativeContextReceipt: { ...accepted, status: 'unknown' },
    } satisfies DaemonToWorker);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline
      && requests(requestLog).length === 0
      && !messages.some(message => message.type === 'error' || message.type === 'user_notify')) {
      if (child.exitCode !== null) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    expect(requests(requestLog)).toHaveLength(0);
  } finally {
    if (child) await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
