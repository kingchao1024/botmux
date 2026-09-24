import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

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
