import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { isBunRuntime, spawnTsScript } from './helpers/ts-runner.js';
import { waitForChildExit } from './helpers/child-process.js';

type LaunchRecord = {
  argv: string[];
  env: Record<string, string | null>;
};

type InitMessage = Extract<DaemonToWorker, { type: 'init' }>;

interface WorkerHarness {
  child: ChildProcess;
  capturePath: string;
  globalHooksPath: string;
  globalHooksBefore: string;
  logs: string[];
  messages: WorkerToDaemon[];
  projectHooksPath: string;
  projectHooksBefore: string;
  root: string;
  sessionId: string;
}

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxSessions = new Set<string>();
let sequence = 0;

const tmuxAvailable = probeTmuxFunctional().ok;
const directPtyUnavailableInBun = isBunRuntime();
const DIRECT_PTY_BUN_SKIP_REASON =
  'Bun 1.4.0 direct node-pty exits the fake CLI immediately with code 0 / signal 1 before the recorder runs; keep tmux/RPC coverage live.';

function hookOverrides(argv: string[]): string[] {
  return argv.flatMap((arg, index) =>
    arg === '-c' && argv[index + 1]?.startsWith('hooks.PreToolUse=')
      ? [argv[index + 1]!]
      : []);
}

function expectSingleNativeHook(record: LaunchRecord): void {
  const overrides = hookOverrides(record.argv);
  expect(overrides).toHaveLength(1);
  expect(overrides[0]).toContain('matcher="spawn_agent"');
  expect(overrides[0]).toContain('native-subagent-runtime-hook');
  expect(record.argv.join(' ').match(/native-subagent-runtime-hook/g)).toHaveLength(1);
}

function readLaunches(path: string): LaunchRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    if (!line) return [];
    try { return [JSON.parse(line) as LaunchRecord]; } catch { return []; }
  });
}

function isAppServerLaunch(record: LaunchRecord): boolean {
  return record.argv.includes('app-server');
}

function isRemoteViewerLaunch(record: LaunchRecord): boolean {
  return record.argv.includes('--remote');
}

async function waitFor(
  harness: WorkerHarness,
  predicate: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
      throw new Error(`worker exited before ${description}\n${harness.logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${description}\n${harness.logs.join('')}`);
}

function nonProbeLaunches(harness: WorkerHarness): LaunchRecord[] {
  return readLaunches(harness.capturePath).filter(record => record.argv[0] !== '--version');
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function processGroupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

function tmuxSessionAlive(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(error => error || !port
        ? rejectPromise(error ?? new Error('no free port'))
        : resolvePromise(port));
    });
  });
}

function waitForFile(path: string, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = setInterval(() => {
      if (existsSync(path)) finish();
      else if (Date.now() >= deadline) finish(new Error('timed out waiting for ' + description));
    }, 25);
    const finish = (error?: Error): void => {
      clearInterval(poll);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
  });
}

async function stopProcess(child: ChildProcess, description: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onExit = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(() => {
      finish(new Error(description + ' pid ' + (child.pid ?? 'unknown') + ' did not exit within 5000ms'));
    }, 5_000);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
  if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
  else child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function makeHarness(options: {
  cliId: 'traex' | 'codex';
  backendType: 'pty' | 'tmux';
  root?: string;
  resume?: boolean;
  sessionId?: string;
  cliSessionId?: string;
  codexRpcInput?: boolean;
  existingAppServerEndpoint?: string;
  disableCliBypass?: boolean;
  bypassCodexHookTrust?: boolean;
  rpcFixtureEnv?: Record<string, string>;
}): WorkerHarness {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'botmux-traex-launch-'));
  if (!options.root) tempDirs.add(root);
  const dataDir = join(root, 'data');
  const workingDir = join(root, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, '.trae'), { recursive: true });
  mkdirSync(join(workingDir, '.trae'), { recursive: true });
  if (options.bypassCodexHookTrust !== undefined) {
    const botmuxDir = join(root, '.botmux');
    mkdirSync(botmuxDir, { recursive: true });
    writeFileSync(join(botmuxDir, 'config.json'), JSON.stringify({
      dashboard: { bypassCodexHookTrust: options.bypassCodexHookTrust },
    }));
  }
  const globalHooksPath = join(root, '.trae', 'hooks.json');
  const projectHooksPath = join(workingDir, '.trae', 'hooks.json');
  const globalHooksBefore = '{"hooks":{"PreToolUse":[{"matcher":"Read","hooks":[]}]}}\n';
  const projectHooksBefore = '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[]}]}}\n';
  writeFileSync(globalHooksPath, globalHooksBefore);
  writeFileSync(projectHooksPath, projectHooksBefore);

  const capturePath = join(root, 'launches.jsonl');
  const fakeCli = join(root, 'fake-cli.mjs');
  writeFileSync(fakeCli, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const argv = process.argv.slice(2);
const commandArgv = argv[0] === '--dangerously-bypass-hook-trust' ? argv.slice(1) : argv;
const keys = [
  'BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_LARK_APP_ID',
  'BOTMUX_ROOT_MESSAGE_ID', 'BOTMUX_SESSION_SCOPE',
  'BOTMUX_OWNER_OPEN_ID', '__OWNER_OPEN_ID',
  'LARK_APP_ID', 'LARK_APP_SECRET', 'BOTMUX_LARK_APP_SECRET',
];
const env = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
appendFileSync(process.env.LAUNCH_CAPTURE_PATH, JSON.stringify({ argv, env }) + '\\n');
if (commandArgv[0] === '--version') {
  process.stdout.write('fake cli 1.0.0\\n');
  process.exit(0);
}
if (commandArgv[0] === 'app-server') {
  await import(pathToFileURL(process.env.RPC_FIXTURE_PATH).href);
} else {
  if (commandArgv[0] === '--remote' && process.env.EXTERNAL_CONNECTION_FILE) {
    const socket = new WebSocket(commandArgv[1]);
    socket.addEventListener('open', () => writeFileSync(process.env.EXTERNAL_CONNECTION_FILE, 'connected'));
  }
  if (commandArgv[0] === '--remote' && process.env.EXTERNAL_VIEWER_FILE) {
    appendFileSync(process.env.EXTERNAL_VIEWER_FILE, 'viewer\\n');
  }
  process.stdout.write('\\n› \\n');
  process.stdin.resume();
  setInterval(() => {}, 1000);
}
`);
  chmodSync(fakeCli, 0o755);

  const sessionId = options.sessionId
    ?? `h${(++sequence).toString(36)}${process.pid.toString(36)}${Date.now().toString(36)}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const workerEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    NODE_ENV: 'test',
    BOTMUX_SANDBOX: '0',
    SESSION_DATA_DIR: dataDir,
    BOTMUX_SESSION_ID: sessionId,
    LARK_APP_ID: 'ambient-app-id-must-be-redacted',
    LARK_APP_SECRET: 'ambient-secret-must-be-redacted',
  };
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => {
    const message = raw as WorkerToDaemon;
    messages.push(message);
    if (message.type === 'error') logs.push(`[worker-ipc-error] ${message.message}\n`);
  });

  const init: InitMessage = {
    type: 'init',
    sessionId,
    chatId: 'oc_hook_test',
    chatType: 'group',
    rootMessageId: 'om_hook_root',
    workingDir,
    cliId: options.cliId,
    cliPathOverride: fakeCli,
    backendType: options.backendType,
    prompt: options.codexRpcInput ? 'exercise rpc launch' : '',
    larkAppId: 'app_hook_test',
    larkAppSecret: 'init-secret-must-be-redacted',
    ownerOpenId: 'ou_hook_owner',
    launchShell: process.platform === 'win32' ? undefined : '/bin/sh',
    env: {
      LAUNCH_CAPTURE_PATH: capturePath,
      RPC_FIXTURE_PATH: resolve('test/fixtures/fake-codex-rpc-server.mjs'),
      ...options.rpcFixtureEnv,
    },
    resume: options.resume,
    cliSessionId: options.cliSessionId,
    codexRpcInput: options.codexRpcInput,
    existingAppServerEndpoint: options.existingAppServerEndpoint,
    disableCliBypass: options.disableCliBypass,
    ...(options.codexRpcInput
      ? {
          cliRuntime: {
            id: 'fake-trae',
            displayName: 'Fake Trae',
            executable: fakeCli,
            source: 'configured',
            update: { provider: 'none' },
          },
        }
      : {}),
  };
  child.send(init);

  if (options.backendType === 'tmux') tmuxSessions.add(`bmx-${sessionId.slice(0, 8)}`);
  return {
    child, capturePath, globalHooksPath, globalHooksBefore, logs, messages,
    projectHooksPath, projectHooksBefore, root, sessionId,
  };
}

function expectAuthenticatedSessionEnv(record: LaunchRecord, sessionId: string): void {
  expect(record.env).toMatchObject({
    BOTMUX_SESSION_ID: sessionId,
    BOTMUX_CHAT_ID: 'oc_hook_test',
    BOTMUX_LARK_APP_ID: 'app_hook_test',
    BOTMUX_ROOT_MESSAGE_ID: 'om_hook_root',
    BOTMUX_OWNER_OPEN_ID: 'ou_hook_owner',
    __OWNER_OPEN_ID: 'ou_hook_owner',
    LARK_APP_ID: null,
    LARK_APP_SECRET: null,
    BOTMUX_LARK_APP_SECRET: null,
  });
  expect(JSON.stringify(record)).not.toContain('ambient-secret-must-be-redacted');
  expect(JSON.stringify(record)).not.toContain('init-secret-must-be-redacted');
}

function expectHookFilesUnchanged(harness: WorkerHarness): void {
  // This is the strongest deterministic seam available without running a real
  // Trae binary: worker launch must leave both persisted hook layers byte-for-
  // byte intact. Proving that Trae executes all three layers belongs to the
  // Task 6 live smoke, where the real CLI owns the merge semantics.
  expect(readFileSync(harness.globalHooksPath, 'utf8')).toBe(harness.globalHooksBefore);
  expect(readFileSync(harness.projectHooksPath, 'utf8')).toBe(harness.projectHooksBefore);
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const session of tmuxSessions) {
    try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch { /* gone */ }
  }
  tmuxSessions.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('TRAE native subagent hook worker launches', () => {
  it.skipIf(directPtyUnavailableInBun).each([
    ['fresh', false, undefined],
    ['resume', true, 'trae-native-session'],
  ] as const)(
    // Bun 1.4.0 cannot keep the fake CLI alive under direct node-pty here.
    // Existing Bun-running evidence stays in test/cli-adapters.test.ts:
    //  - "adds one process-scoped native subagent hook for resume=%s"
    //  - "does not attach the native subagent hook to the remote viewer"
    //  - "does not attach the Trae-only hook argument to another adapter"
    // This file keeps the real worker coverage on Node/Vitest and still runs
    // the real tmux/RPC worker paths on Bun.
    `launches a Trae %s PTY with one hook and authenticated non-secret env (${DIRECT_PTY_BUN_SKIP_REASON})`,
    async (_label, resume, cliSessionId) => {
    const harness = makeHarness({ cliId: 'traex', backendType: 'pty', resume, cliSessionId });
    await waitFor(harness, () => (
      harness.messages.some(message => message.type === 'ready')
      && nonProbeLaunches(harness).length === 1
    ), 'worker ready and CLI launch capture');
    const launches = nonProbeLaunches(harness);
    expect(launches).toHaveLength(1);
    const [launch] = launches;
    expectSingleNativeHook(launch);
    if (resume) {
      expect(launch.argv[0]).toBe('resume');
      expect(launch.argv.at(-1)).toBe(cliSessionId);
    } else {
      expect(launch.argv[0]).not.toBe('resume');
    }
    expectAuthenticatedSessionEnv(launch, harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 20_000);

  it.skipIf(!tmuxAvailable)('launches a persistent Trae tmux pane with the same one-hook/env contract', async () => {
    const harness = makeHarness({ cliId: 'traex', backendType: 'tmux' });
    await waitFor(harness, () => (
      harness.messages.some(message => message.type === 'ready')
      && nonProbeLaunches(harness).length === 1
    ), 'tmux worker ready and CLI launch capture');
    const launches = nonProbeLaunches(harness);
    expect(launches).toHaveLength(1);
    expectSingleNativeHook(launches[0]);
    expectAuthenticatedSessionEnv(launches[0], harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 25_000);

  it.skipIf(!tmuxAvailable)('puts the hook-trust bypass on both managed Trae RPC processes before --remote', async () => {
    const harness = makeHarness({ cliId: 'traex', backendType: 'tmux', codexRpcInput: true });
    await waitFor(
      harness,
      () => {
        const launches = readLaunches(harness.capturePath);
        return launches.some(isAppServerLaunch)
          && launches.some(isRemoteViewerLaunch)
          && harness.messages.some(message => message.type === 'ready');
      },
      'Trae app-server and remote viewer launches',
      20_000,
    );
    const launches = readLaunches(harness.capturePath);
    const appServer = launches.find(isAppServerLaunch);
    const viewer = launches.find(isRemoteViewerLaunch);
    expect(appServer).toBeDefined();
    expect(viewer).toBeDefined();
    expectSingleNativeHook(appServer!);
    expect(appServer!.argv[0]).toBe('--dangerously-bypass-hook-trust');
    expect(appServer!.argv[1]).toBe('app-server');
    expect(appServer!.argv).toContain('default_mode_request_user_input');
    expect(viewer!.argv).toEqual([
      '--dangerously-bypass-hook-trust',
      '--remote', expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      'resume', '--no-alt-screen', '-c', 'check_for_update_on_startup=false',
      '-c', 'notice.hide_rate_limit_model_nudge=true', 'thread-fake-1',
    ]);
    expectAuthenticatedSessionEnv(appServer!, harness.sessionId);
    expectAuthenticatedSessionEnv(viewer!, harness.sessionId);
    expect(appServer!.env.BOTMUX_SESSION_SCOPE).toBe('thread');
    expectHookFilesUnchanged(harness);
  }, 25_000);

  it.skipIf(!tmuxAvailable)('keeps the Trae RPC app-server interactive when the global hook-trust toggle is off', async () => {
    const harness = makeHarness({
      cliId: 'traex',
      backendType: 'tmux',
      codexRpcInput: true,
      bypassCodexHookTrust: false,
    });
    await waitFor(
      harness,
      () => {
        const launches = readLaunches(harness.capturePath);
        return launches.some(isAppServerLaunch)
          && launches.some(isRemoteViewerLaunch)
          && harness.messages.some(message => message.type === 'ready');
      },
      'Trae app-server and remote viewer launches',
      20_000,
    );
    const launches = readLaunches(harness.capturePath);
    const appServer = launches.find(isAppServerLaunch);
    const viewer = launches.find(isRemoteViewerLaunch);
    expect(appServer).toBeDefined();
    expect(viewer).toBeDefined();
    expect(appServer!.argv[0]).toBe('app-server');
    expect(appServer!.argv).not.toContain('--dangerously-bypass-hook-trust');
    expect(viewer!.argv).not.toContain('--dangerously-bypass-hook-trust');
    expectSingleNativeHook(appServer!);
    expect(hookOverrides(viewer!.argv)).toEqual([]);
    expectAuthenticatedSessionEnv(appServer!, harness.sessionId);
    expectAuthenticatedSessionEnv(viewer!, harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 25_000);

  it.skipIf(!tmuxAvailable)('falls back to a non-bypassed TUI when the bot disables CLI bypasses', async () => {
    const harness = makeHarness({
      cliId: 'traex',
      backendType: 'tmux',
      codexRpcInput: true,
      disableCliBypass: true,
    });
    await waitFor(harness, () => (
      harness.messages.some(message => message.type === 'ready')
      && nonProbeLaunches(harness).length === 1
    ), 'restricted Trae TUI fallback');
    const launches = nonProbeLaunches(harness);
    expect(launches).toHaveLength(1);
    expect(launches.some(isAppServerLaunch)).toBe(false);
    expect(launches[0]!.argv).not.toContain('--dangerously-bypass-hook-trust');
    expectAuthenticatedSessionEnv(launches[0]!, harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 25_000);

  it.skipIf(directPtyUnavailableInBun)(`keeps a non-Trae worker launch free of the Trae hook (${DIRECT_PTY_BUN_SKIP_REASON})`, async () => {
    const harness = makeHarness({ cliId: 'codex', backendType: 'pty' });
    await waitFor(harness, () => (
      harness.messages.some(message => message.type === 'ready')
      && nonProbeLaunches(harness).length === 1
    ), 'Codex worker ready and CLI launch capture');
    const launches = nonProbeLaunches(harness);
    expect(launches).toHaveLength(1);
    expect(hookOverrides(launches[0].argv)).toEqual([]);
    expectAuthenticatedSessionEnv(launches[0], harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 20_000);

  it.skipIf(!tmuxAvailable)('keeps both processes in a non-Trae RPC launch free of the Trae hook', async () => {
    const harness = makeHarness({ cliId: 'codex', backendType: 'tmux', codexRpcInput: true });
    await waitFor(
      harness,
      () => {
        const launches = readLaunches(harness.capturePath);
        return launches.some(record => record.argv[0] === 'app-server')
          && launches.some(isRemoteViewerLaunch)
          && harness.messages.some(message => message.type === 'ready');
      },
      'Codex app-server and remote viewer launches',
      20_000,
    );
    const launches = readLaunches(harness.capturePath);
    const appServer = launches.find(record => record.argv[0] === 'app-server');
    const viewer = launches.find(isRemoteViewerLaunch);
    expect(appServer).toBeDefined();
    expect(viewer).toBeDefined();
    expect(hookOverrides(appServer!.argv)).toEqual([]);
    expect(hookOverrides(viewer!.argv)).toEqual([]);
    expectAuthenticatedSessionEnv(appServer!, harness.sessionId);
    expectAuthenticatedSessionEnv(viewer!, harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 25_000);

  it.skipIf(!tmuxAvailable)('reaps the Botmux-owned RPC group before SIGTERM exits the worker, while preserving its tmux viewer', async () => {
    const groupChildPidFile = join(tmpdir(), 'botmux-worker-rpc-group-' + process.pid + '-' + Date.now() + '.pid');
    const harness = makeHarness({
      cliId: 'codex',
      backendType: 'tmux',
      codexRpcInput: true,
      rpcFixtureEnv: {
        FAKE_GROUP_CHILD_PID_FILE: groupChildPidFile,
        FAKE_LEADER_EXITS_ON_SIGTERM: '1',
      },
    });
    const markerPath = join(
      harness.root,
      '.botmux',
      'data',
      'codex-rpc-app-servers',
      harness.sessionId + '.pid',
    );
    const tmuxName = 'bmx-' + harness.sessionId.slice(0, 8);
    let groupLeaderPid: number | undefined;
    let groupChildPid: number | undefined;
    try {
      await waitFor(
        harness,
        () => (
          existsSync(markerPath)
          && existsSync(groupChildPidFile)
          && harness.messages.some(message => message.type === 'ready')
        ),
        'RPC marker, group child, and worker readiness',
      );
      groupLeaderPid = Number.parseInt(readFileSync(markerPath, 'utf8'), 10);
      groupChildPid = Number.parseInt(readFileSync(groupChildPidFile, 'utf8'), 10);
      expect(processAlive(groupChildPid)).toBe(true);
      expect(processGroupAlive(groupLeaderPid)).toBe(true);

      const startedAt = Date.now();
      harness.child.kill('SIGTERM');
      await waitForChildExit(harness.child, { description: 'RPC worker', logs: harness.logs });
      expect(Date.now() - startedAt).toBeLessThanOrEqual(3_000);
      expect(processGroupAlive(groupLeaderPid)).toBe(false);
      expect(processAlive(groupChildPid)).toBe(false);
      expect(tmuxSessionAlive(tmuxName)).toBe(true);
    } finally {
      if (groupLeaderPid && processGroupAlive(groupLeaderPid)) {
        try { process.kill(-groupLeaderPid, 'SIGKILL'); } catch { /* gone */ }
      }
      if (groupChildPid && processAlive(groupChildPid)) {
        try { process.kill(groupChildPid, 'SIGKILL'); } catch { /* gone */ }
      }
      rmSync(groupChildPidFile, { force: true });
    }
  }, 25_000);

  it.skipIf(!tmuxAvailable)('local close awaits managed RPC group reaping before a clean worker exit', async () => {
    const groupChildPidFile = join(tmpdir(), 'botmux-local-close-rpc-' + process.pid + '-' + Date.now() + '.pid');
    const harness = makeHarness({
      cliId: 'codex',
      backendType: 'tmux',
      codexRpcInput: true,
      rpcFixtureEnv: {
        FAKE_GROUP_CHILD_PID_FILE: groupChildPidFile,
        FAKE_LEADER_EXITS_ON_SIGTERM: '1',
      },
    });
    const markerPath = join(
      harness.root,
      '.botmux',
      'data',
      'codex-rpc-app-servers',
      harness.sessionId + '.pid',
    );
    let groupLeaderPid: number | undefined;
    let groupChildPid: number | undefined;
    try {
      await waitFor(
        harness,
        () => (
          existsSync(markerPath)
          && existsSync(groupChildPidFile)
          && harness.messages.some(message => message.type === 'ready')
        ),
        'local-close RPC marker, group child, and readiness',
      );
      groupLeaderPid = Number.parseInt(readFileSync(markerPath, 'utf8'), 10);
      groupChildPid = Number.parseInt(readFileSync(groupChildPidFile, 'utf8'), 10);
      harness.child.send({ type: 'close' } as DaemonToWorker);
      await waitForChildExit(harness.child, { description: 'local close RPC worker', logs: harness.logs });
      expect(harness.child.exitCode).toBe(0);
      expect(processGroupAlive(groupLeaderPid)).toBe(false);
      expect(processAlive(groupChildPid)).toBe(false);
    } finally {
      if (groupLeaderPid && processGroupAlive(groupLeaderPid)) {
        try { process.kill(-groupLeaderPid, 'SIGKILL'); } catch { /* gone */ }
      }
      if (groupChildPid && processAlive(groupChildPid)) {
        try { process.kill(groupChildPid, 'SIGKILL'); } catch { /* gone */ }
      }
      rmSync(groupChildPidFile, { force: true });
    }
  }, 25_000);

  it.skipIf(!tmuxAvailable)('local close refuses an unverified surviving RPC group and exits nonzero', async () => {
    const groupChildPidFile = join(tmpdir(), 'botmux-local-close-unverified-' + process.pid + '-' + Date.now() + '.pid');
    const harness = makeHarness({
      cliId: 'codex',
      backendType: 'tmux',
      codexRpcInput: true,
      rpcFixtureEnv: {
        FAKE_GROUP_CHILD_PID_FILE: groupChildPidFile,
        FAKE_GROUP_CHILD_UNVERIFIED: '1',
        FAKE_LEADER_EXITS_ON_SIGTERM: '1',
      },
    });
    const markerPath = join(
      harness.root,
      '.botmux',
      'data',
      'codex-rpc-app-servers',
      harness.sessionId + '.pid',
    );
    let groupLeaderPid: number | undefined;
    let groupChildPid: number | undefined;
    try {
      await waitFor(
        harness,
        () => (
          existsSync(markerPath)
          && existsSync(groupChildPidFile)
          && harness.messages.some(message => message.type === 'ready')
        ),
        'unverified local-close RPC marker, group child, and readiness',
      );
      groupLeaderPid = Number.parseInt(readFileSync(markerPath, 'utf8'), 10);
      groupChildPid = Number.parseInt(readFileSync(groupChildPidFile, 'utf8'), 10);
      harness.child.send({ type: 'close' } as DaemonToWorker);
      await waitForChildExit(harness.child, { description: 'unverified local close worker', logs: harness.logs });
      expect(harness.child.exitCode).toBe(1);
      expect(processAlive(groupChildPid)).toBe(true);
      expect(harness.logs.join('')).toContain('Local close RPC teardown failed: exact app-server identity could not be verified');
    } finally {
      if (groupLeaderPid && processGroupAlive(groupLeaderPid)) {
        try { process.kill(-groupLeaderPid, 'SIGKILL'); } catch { /* gone */ }
      }
      if (groupChildPid && processAlive(groupChildPid)) {
        try { process.kill(groupChildPid, 'SIGKILL'); } catch { /* gone */ }
      }
      rmSync(groupChildPidFile, { force: true });
    }
  }, 25_000);

  it.skipIf(!tmuxAvailable)('preserves an ordinary tmux session when SIGTERM exits a non-RPC worker', async () => {
    const harness = makeHarness({ cliId: 'codex', backendType: 'tmux' });
    const tmuxName = 'bmx-' + harness.sessionId.slice(0, 8);
    await waitFor(
      harness,
      () => harness.messages.some(message => message.type === 'ready'),
      'non-RPC tmux worker readiness',
    );

    harness.child.kill('SIGTERM');
    await waitForChildExit(harness.child, { description: 'non-RPC worker', logs: harness.logs });
    expect(tmuxSessionAlive(tmuxName)).toBe(true);
  }, 20_000);

  it.skipIf(!tmuxAvailable)('preserves an external app-server viewer without starting or stopping a Botmux RPC group', async () => {
    const harness = makeHarness({
      cliId: 'codex',
      backendType: 'tmux',
      cliSessionId: 'external-thread',
      existingAppServerEndpoint: 'ws://127.0.0.1:65535',
    });
    const tmuxName = 'bmx-' + harness.sessionId.slice(0, 8);
    await waitFor(
      harness,
      () => (
        harness.messages.some(message => message.type === 'ready')
        && readLaunches(harness.capturePath).some(isRemoteViewerLaunch)
      ),
      'external app-server viewer readiness',
    );
    expect(readLaunches(harness.capturePath).some(isAppServerLaunch)).toBe(false);

    harness.child.kill('SIGTERM');
    await waitForChildExit(harness.child, { description: 'external viewer worker', logs: harness.logs });
    expect(tmuxSessionAlive(tmuxName)).toBe(true);
  }, 20_000);

  it.skipIf(!tmuxAvailable)('re-forks and reattaches a persistent tmux session after worker restart', async () => {
    const first = makeHarness({ cliId: 'codex', backendType: 'tmux' });
    const tmuxName = 'bmx-' + first.sessionId.slice(0, 8);
    try {
      await waitFor(first, () => first.messages.some(message => message.type === 'ready'), 'first worker readiness');
      expect(tmuxSessionAlive(tmuxName)).toBe(true);
      const firstLaunchCount = nonProbeLaunches(first).length;

      first.child.kill('SIGTERM');
      await waitForChildExit(first.child, { description: 'first re-fork worker', logs: first.logs });
      expect(tmuxSessionAlive(tmuxName)).toBe(true);

      const second = makeHarness({
        cliId: 'codex',
        backendType: 'tmux',
        root: first.root,
        sessionId: first.sessionId,
        resume: true,
      });
      await waitFor(second, () => second.messages.some(message => message.type === 'ready'), 're-forked worker readiness');
      expect(tmuxSessionAlive(tmuxName)).toBe(true);
      // The second worker attaches the pre-existing bmx-* session rather than
      // spawning a replacement CLI into it.
      expect(nonProbeLaunches(second)).toHaveLength(firstLaunchCount);
      expect(firstLaunchCount).toBe(1);
      second.child.kill('SIGTERM');
      await waitForChildExit(second.child, { description: 'second re-fork worker', logs: second.logs });
    } finally {
      // afterEach owns the persistent tmux session and the first root cleanup.
    }
  }, 25_000);

  it.skipIf(!tmuxAvailable)('keeps a real external app-server alive across worker restart and viewer reattach', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-external-app-server-'));
    tempDirs.add(root);
    const port = await findFreePort();
    const pidFile = join(root, 'external.pid');
    const readyFile = join(root, 'external.ready');
    const connectionFile = join(root, 'external.connected');
    const viewerFile = join(root, 'external.viewers');
    const external = spawn(process.execPath, [
      resolve('test/fixtures/fake-codex-rpc-server.mjs'),
      'app-server',
      '--listen', 'ws://127.0.0.1:' + port,
    ], {
      env: {
        ...process.env,
        FAKE_EXTERNAL_PID_FILE: pidFile,
        FAKE_EXTERNAL_READY_FILE: readyFile,
        FAKE_EXTERNAL_CONNECTION_FILE: connectionFile,
      },
      stdio: 'ignore',
    });
    let externalPid: number | undefined;
    try {
      await waitForFile(pidFile, 5_000, 'external app-server pid file');
      await waitForFile(readyFile, 5_000, 'external app-server listener');
      externalPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      expect(processAlive(externalPid)).toBe(true);

      const first = makeHarness({
        cliId: 'codex', backendType: 'tmux', root, sessionId: 'x' + process.pid + '-' + Date.now() + '-external',
        cliSessionId: 'external-thread', existingAppServerEndpoint: 'ws://127.0.0.1:' + port,
        rpcFixtureEnv: {
          EXTERNAL_CONNECTION_FILE: connectionFile,
          EXTERNAL_VIEWER_FILE: viewerFile,
        },
      });
      const tmuxName = 'bmx-' + first.sessionId.slice(0, 8);
      await waitFor(first, () => first.messages.some(message => message.type === 'ready'), 'external first worker readiness');
      expect(readLaunches(first.capturePath).some(isAppServerLaunch)).toBe(false);
      await waitForFile(connectionFile, 5_000, 'first external viewer WebSocket connection');
      expect(readFileSync(viewerFile, 'utf8').trim().split('\n')).toHaveLength(1);
      const firstLaunchCount = nonProbeLaunches(first).length;
      expect(processAlive(externalPid)).toBe(true);

      first.child.kill('SIGTERM');
      await waitForChildExit(first.child, { description: 'first external viewer worker', logs: first.logs });
      expect(processAlive(externalPid)).toBe(true);
      expect(tmuxSessionAlive(tmuxName)).toBe(true);

      const second = makeHarness({
        cliId: 'codex', backendType: 'tmux', root, sessionId: first.sessionId, resume: true,
        cliSessionId: 'external-thread', existingAppServerEndpoint: 'ws://127.0.0.1:' + port,
      });
      await waitFor(second, () => second.messages.some(message => message.type === 'ready'), 'external re-forked worker readiness');
      expect(readLaunches(second.capturePath).some(isAppServerLaunch)).toBe(false);
      expect(nonProbeLaunches(second)).toHaveLength(firstLaunchCount);
      expect(readFileSync(viewerFile, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(processAlive(externalPid)).toBe(true);
      second.child.kill('SIGTERM');
      await waitForChildExit(second.child, { description: 'second external viewer worker', logs: second.logs });
    } finally {
      await stopProcess(external, 'external app-server');
      rmSync(pidFile, { force: true });
      rmSync(readyFile, { force: true });
      rmSync(connectionFile, { force: true });
      rmSync(viewerFile, { force: true });
    }
  }, 30_000);
});
