import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readScheduleRuntimeState } from '../src/services/schedule-runtime-state-store.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/send-schedule-once-capture.ts', import.meta.url));
const appId = 'cli_schedule';
const chatId = 'oc_schedule';
const sessionId = 'sid_schedule';
const taskId = 'task1234';
const runAt = '2026-09-28T10:00:00.000Z';
const turnId = `schedule:${taskId}:11111111-1111-4111-8111-111111111111`;

function setup(): { root: string; dataDir: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'botmux-send-schedule-once-'));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: appId,
    larkAppSecret: 'test-secret',
    cliId: 'claude-code',
    allowedUsers: ['ou_owner'],
  }]));
  const botHome = join(root, 'bots', appId);
  mkdirSync(botHome, { recursive: true });
  writeFileSync(join(botHome, 'schedules.json'), JSON.stringify({
    [taskId]: {
      id: taskId,
      name: 'hourly report',
      schedule: 'every 60m',
      parsed: { kind: 'interval', minutes: 60, display: 'every 60m' },
      prompt: 'report',
      workingDir: root,
      chatId,
      rootMessageId: 'om_root',
      scope: 'thread',
      executionPosition: 'topic',
      chatType: 'topic_group',
      larkAppId: appId,
      ownerOpenId: 'ou_owner',
      ownerUnionId: 'on_owner',
      enabled: true,
      createdAt: '2026-09-28T09:00:00.000Z',
      lastRunAt: runAt,
      lastStatus: 'running',
      lastRunId: 'run-1',
      silent: true,
    },
  }));
  seedPersistedSessionRows(dataDir, appId, {
    [sessionId]: {
      sessionId,
      status: 'active',
      cliId: 'claude-code',
      larkAppId: appId,
      chatId,
      chatType: 'topic_group',
      rootMessageId: 'om_root',
      scope: 'thread',
      workingDir: root,
    },
  });
  return {
    root,
    dataDir,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      SESSION_DATA_DIR: dataDir,
      BOTS_CONFIG: join(root, 'bots.json'),
      BOTMUX_SESSION_ID: sessionId,
      BOTMUX_TURN_ID: turnId,
      BOTMUX_LARK_APP_ID: appId,
    },
  };
}

function run(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSyncTsScript(fixture, args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('cmdSend --schedule-once', () => {
  it('claims before the provider send, records its message id, and blocks a replay', () => {
    const ctx = setup();
    try {
      const args = ['send', 'hourly report', '--top-level', '--chat-id', chatId, '--no-mention', '--schedule-once'];
      const first = run(ctx.env, args);
      expect(first.status, String(first.stderr)).toBe(0);
      const captured = String(first.stdout).split('\n').find(line => line.startsWith('CAPTURE_REQUEST='));
      expect(captured).toBeTruthy();
      const request = JSON.parse(captured!.slice('CAPTURE_REQUEST='.length));
      expect(request.data.uuid).toMatch(/^schedule-[a-f0-9]{41}$/);
      expect(readScheduleRuntimeState('delivery', chatId, ctx.dataDir).state).toMatchObject({
        hourlyTaskId: taskId,
        runKey: `${taskId}:${runAt}`,
        status: 'sent',
        messageId: 'om_schedule_once',
      });

      const replay = run(ctx.env, args);
      expect(replay.status).not.toBe(0);
      expect(replay.stderr).toMatch(/delivery_already_claimed|delivery_transition_invalid|delivery_claimed_at_changed/);
      expect(replay.stdout).not.toContain('CAPTURE_REQUEST=');
    } finally {
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it('refuses the flag outside an authenticated scheduled turn before sending', () => {
    const ctx = setup();
    try {
      const ordinaryTurnId = 'om_human_turn';
      writeFileSync(join(ctx.dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId: ordinaryTurnId }));
      seedPersistedSessionRows(ctx.dataDir, appId, {
        [sessionId]: {
          sessionId,
          status: 'active',
          cliId: 'claude-code',
          larkAppId: appId,
          chatId,
          chatType: 'topic_group',
          rootMessageId: 'om_root',
          quoteTargetId: ordinaryTurnId,
          lastCallerOpenId: 'ou_owner',
          scope: 'thread',
          workingDir: ctx.root,
        },
      });
      const result = run(ctx.env, [
        'send', 'must not send', '--top-level', '--chat-id', chatId, '--no-mention', '--schedule-once',
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--schedule-once 只允许当前定时任务');
      expect(result.stdout).not.toContain('CAPTURE_REQUEST=');
    } finally {
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it('rejects value-bearing forms instead of silently dropping the guard', () => {
    const ctx = setup();
    try {
      const result = run(ctx.env, [
        'send', 'must not send', '--top-level', '--chat-id', chatId, '--no-mention', '--schedule-once=yes',
      ]);
      expect(result.status).toBe(2);
      // The earliest preflight parses argv first, so a value-bearing boolean is
      // rejected by the shared parser; the contract is "refused", not the wording.
      expect(result.stderr).toMatch(/--schedule-once 不接受(参数|值)/);
      expect(result.stdout).not.toContain('CAPTURE_REQUEST=');
    } finally {
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it('refuses a cross-chat destination before sending', () => {
    const ctx = setup();
    try {
      const result = run(ctx.env, [
        'send', 'must not send', '--top-level', '--chat-id', 'oc_other', '--no-mention', '--schedule-once',
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('目标群必须与当前定时 turn 绑定群一致');
      expect(result.stdout).not.toContain('CAPTURE_REQUEST=');
    } finally {
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it('accepts the authenticated live turn of an auto-completed one-shot task', () => {
    const ctx = setup();
    try {
      const schedulePath = join(ctx.root, 'bots', appId, 'schedules.json');
      const schedules = JSON.parse(readFileSync(schedulePath, 'utf8'));
      schedules[taskId].parsed = { kind: 'once', runAt, display: 'once' };
      schedules[taskId].enabled = false;
      schedules[taskId].disabledReason = 'once_completed';
      writeFileSync(schedulePath, JSON.stringify(schedules));

      const result = run(ctx.env, [
        'send', 'one shot report', '--top-level', '--chat-id', chatId, '--no-mention', '--schedule-once',
      ]);
      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.stdout).toContain('CAPTURE_REQUEST=');
    } finally {
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});
