import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  managedOriginCapabilityPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const CHAT_ID = 'oc_project_group';
const SESSION_ID = 'project-group-session';
const THREAD_SESSION_ID = 'other-thread-session';
const APP_ID = 'cli_project_coordinator';
const ORIGIN_CHANNEL_ID = 'a'.repeat(64);

interface Fixture {
  home: string;
  dataDir: string;
  pluginLoadPath: string;
  taskStorePath: string;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function writeOriginCapability(dataDir: string, sessionId: string): void {
  replaceManagedOriginCapabilityFile(
    managedOriginCapabilityPath(dataDir, sessionId, ORIGIN_CHANNEL_ID),
    JSON.stringify({
      sessionId,
      channelId: ORIGIN_CHANNEL_ID,
      capability: 'ab'.repeat(32),
    }),
  );
}

function writeAncestorMarker(dataDir: string, value: Record<string, unknown>): void {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  mkdirSync(markersDir, { recursive: true });
  writeFileSync(join(markersDir, String(process.pid)), JSON.stringify(value));
}

function writeAuthenticatedAncestorMarker(dataDir: string, sessionId: string): void {
  const procStart = readProcessStartIdentity(process.pid);
  if (!procStart) throw new Error('test process start identity unavailable');
  writeAncestorMarker(dataDir, { sessionId, turnId: 'turn-current', procStart });
}

function makeFixture(
  projectGroup: boolean,
  scope: 'chat' | 'thread' = 'chat',
  pluginId = 'task-control',
): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'botmux-project-plugin-command-'));
  const dataDir = join(home, 'data');
  const pluginLoadPath = join(home, 'plugin-loaded');
  const taskStorePath = join(home, 'task-store.json');
  const pluginDir = join(home, '.botmux', 'plugins', pluginId, 'dist');

  writeJson(join(home, '.botmux', 'plugins-registry.json'), {
    schemaVersion: 1,
    plugins: {
      [pluginId]: {
        id: pluginId,
        packageName: '@test/' + pluginId,
        version: '0.0.0-test',
        manifest: { schemaVersion: 1, id: 'task-control' },
        contributions: {
          cli: {
            entry: 'cli/index.js',
            commandsPath: 'cli/commands.json',
            commands: [{ name: 'task:new' }],
          },
        },
      },
    },
  });
  writeJson(join(dataDir, 'sessions', SESSION_ID, 'plugin-manifest.json'), {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    source: 'bot',
    pluginIds: [pluginId],
    generatedAt: '2026-09-23T00:00:00.000Z',
  });
  writeJson(join(dataDir, 'sessions', THREAD_SESSION_ID, 'plugin-manifest.json'), {
    schemaVersion: 1,
    sessionId: THREAD_SESSION_ID,
    source: 'bot',
    pluginIds: [pluginId],
    generatedAt: '2026-09-23T00:00:00.000Z',
  });
  seedPersistedSessionRows(dataDir, APP_ID, {
    [SESSION_ID]: {
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      chatType: 'group',
      rootMessageId: scope === 'thread' ? 'om_project_thread' : 'om_project_chat_seed',
      scope,
      title: 'project command fixture',
      status: 'active',
      createdAt: '2026-09-23T00:00:00.000Z',
      larkAppId: APP_ID,
    },
    [THREAD_SESSION_ID]: {
      sessionId: THREAD_SESSION_ID,
      chatId: 'oc_thread_session',
      chatType: 'group',
      rootMessageId: 'om_other_thread',
      scope: 'thread',
      title: 'other thread fixture',
      status: 'active',
      createdAt: '2026-09-23T00:00:00.000Z',
      larkAppId: APP_ID,
    },
  });
  writeOriginCapability(dataDir, SESSION_ID);
  writeJson(join(pluginDir, 'cli', 'commands.json'), {
    schemaVersion: 1,
    commands: [{ name: 'task:new' }],
  });
  mkdirSync(join(pluginDir, 'cli'), { recursive: true });
  writeFileSync(join(pluginDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(pluginDir, 'cli', 'index.js'), [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.TEST_PLUGIN_LOAD, 'loaded\\n');",
    'export default {',
    "  'task:new'({ args }) {",
    "    appendFileSync(process.env.TEST_TASK_STORE, JSON.stringify(args) + '\\n');",
    "    return 'plugin forwarded';",
    '  },',
    '};',
    '',
  ].join('\n'));
  if (projectGroup) {
    writeJson(join(dataDir, 'group-collaboration-modes.json'), {
      schemaVersion: 1,
      configs: {
        [CHAT_ID]: {
          schemaVersion: 1,
          chatId: CHAT_ID,
          mode: 'project',
          coordinatorAppId: 'cli_coordinator',
          workerAppIds: [],
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
        },
      },
    });
  }

  return { home, dataDir, pluginLoadPath, taskStorePath };
}

function runCli(
  fixture: Fixture,
  envOverrides: Partial<Record<'BOTMUX_SESSION_ID' | 'BOTMUX_SESSION_SCOPE' | 'BOTMUX_CHAT_ID' | 'BOTMUX_ORIGIN_CHANNEL_ID' | 'BOTMUX_SEND_RELAY', string | undefined>>,
): { status: number | null; stdout: string; stderr: string } {
  const { command, prefixArgs } = tsRunnerPrefix();
  const env = {
    ...process.env,
    HOME: fixture.home,
    SESSION_DATA_DIR: fixture.dataDir,
    BOTMUX_SESSION_ID: SESSION_ID,
    BOTMUX_CHAT_ID: CHAT_ID,
    BOTMUX_SESSION_SCOPE: 'chat',
    BOTMUX_LARK_APP_ID: APP_ID,
    BOTMUX_ORIGIN_CHANNEL_ID: ORIGIN_CHANNEL_ID,
    TEST_PLUGIN_LOAD: fixture.pluginLoadPath,
    TEST_TASK_STORE: fixture.taskStorePath,
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key as keyof typeof env];
    else env[key as keyof typeof env] = value;
  }
  try {
    return {
      status: 0,
      stdout: execFileSync(command, [...prefixArgs, CLI, 'task:new', '--title', 'test'], {
        cwd: process.cwd(), env, encoding: 'utf8',
      }),
      stderr: '',
    };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { status: result.status ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}

describe('project_group plugin command boundary', () => {
  it('rejects task:new before plugin execution for a project-group chat session', () => {
    const fixture = makeFixture(true);
    try {
      writeAuthenticatedAncestorMarker(fixture.dataDir, SESSION_ID);
      const result = runCli(fixture, {});

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('botmux dispatch');
      expect(result.stdout).not.toContain('plugin forwarded');
      expect(() => readFileSync(fixture.pluginLoadPath, 'utf8')).toThrow();
      expect(() => readFileSync(fixture.taskStorePath, 'utf8')).toThrow();
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('forwards a same-named command from a non-Task Control plugin', () => {
    const fixture = makeFixture(true, 'chat', 'other-plugin');
    try {
      writeAuthenticatedAncestorMarker(fixture.dataDir, SESSION_ID);
      const result = runCli(fixture, {});

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('plugin forwarded');
      expect(readFileSync(fixture.pluginLoadPath, 'utf8')).toContain('loaded');
      expect(readFileSync(fixture.taskStorePath, 'utf8')).toContain('--title');
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it.each([
    ['scope forged as thread', { BOTMUX_SESSION_SCOPE: 'thread' }],
    ['chat id forged as a non-project group', { BOTMUX_CHAT_ID: 'oc_unrelated' }],
    ['chat id removed', { BOTMUX_CHAT_ID: undefined }],
  ])('rejects task:new when a project chat session has %s', (_name, envOverrides) => {
    const fixture = makeFixture(true);
    try {
      writeAuthenticatedAncestorMarker(fixture.dataDir, SESSION_ID);
      const result = runCli(fixture, envOverrides);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('botmux dispatch');
      expect(() => readFileSync(fixture.pluginLoadPath, 'utf8')).toThrow();
      expect(() => readFileSync(fixture.taskStorePath, 'utf8')).toThrow();
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('rejects a detached project chat when its env session id is forged as another valid thread session', () => {
    const fixture = makeFixture(true);
    try {
      const result = runCli(fixture, { BOTMUX_SESSION_ID: THREAD_SESSION_ID });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('无法验证当前受管会话');
      expect(() => readFileSync(fixture.pluginLoadPath, 'utf8')).toThrow();
      expect(() => readFileSync(fixture.taskStorePath, 'utf8')).toThrow();
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('rejects a detached managed task when a caller-owned relay claim names a valid thread session', () => {
    const fixture = makeFixture(true);
    const relayDir = join(fixture.home, 'caller-owned-relay');
    try {
      mkdirSync(relayDir, { recursive: true });
      const claimPath = join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME);
      writeFileSync(claimPath, JSON.stringify({
        sessionId: THREAD_SESSION_ID,
        channelId: ORIGIN_CHANNEL_ID,
        capability: 'cd'.repeat(32),
      }), { mode: 0o600 });
      chmodSync(claimPath, 0o600);
      const result = runCli(fixture, {
        BOTMUX_SESSION_ID: THREAD_SESSION_ID,
        BOTMUX_SEND_RELAY: relayDir,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('无法验证当前受管会话');
      expect(() => readFileSync(fixture.pluginLoadPath, 'utf8')).toThrow();
      expect(() => readFileSync(fixture.taskStorePath, 'utf8')).toThrow();
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('rejects a malformed project group store before plugin execution', () => {
    const fixture = makeFixture(true);
    try {
      writeAuthenticatedAncestorMarker(fixture.dataDir, SESSION_ID);
      writeFileSync(join(fixture.dataDir, 'group-collaboration-modes.json'), '{not json\n');
      const result = runCli(fixture, {});

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('项目群配置无效');
      expect(result.stderr).not.toContain('SyntaxError');
      expect(() => readFileSync(fixture.pluginLoadPath, 'utf8')).toThrow();
      expect(() => readFileSync(fixture.taskStorePath, 'utf8')).toThrow();
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it.each([
    ['legacy marker without procStart', { sessionId: SESSION_ID, turnId: 'turn-current' }],
    ['stale marker with a mismatched procStart', { sessionId: SESSION_ID, turnId: 'turn-current', procStart: '1' }],
  ])('rejects task:new when the ancestor has a %s', (_name, marker) => {
    const fixture = makeFixture(false);
    try {
      writeAncestorMarker(fixture.dataDir, marker);
      const result = runCli(fixture, {});

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('无法验证当前受管会话');
      expect(() => readFileSync(fixture.pluginLoadPath, 'utf8')).toThrow();
      expect(() => readFileSync(fixture.taskStorePath, 'utf8')).toThrow();
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it.each([
    ['ordinary chat session', false, 'chat'],
    ['project-group thread session', true, 'thread'],
  ] as const)('forwards task:new for a %s', (_name, projectGroup, scope) => {
    const fixture = makeFixture(projectGroup, scope);
    try {
      writeAuthenticatedAncestorMarker(fixture.dataDir, SESSION_ID);
      const result = runCli(fixture, { BOTMUX_SESSION_SCOPE: scope });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('plugin forwarded');
      expect(readFileSync(fixture.pluginLoadPath, 'utf8')).toContain('loaded');
      expect(readFileSync(fixture.taskStorePath, 'utf8')).toContain('--title');
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });
});
