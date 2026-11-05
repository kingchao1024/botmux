/**
 * `botmux send` 侧「事后开的话题」拦截：普通群里顶层 @ 进来的一轮，若被引用的那条消息
 * 事后被人开成了话题，回复不能再 quote 它——飞书 reply 会继承被引消息「此刻」的话题
 * 归属，把回复带进用户根本没在其中 @ 过 bot 的话题（#1023）。
 *
 * 纯函数 `shouldDropAfterTheFactTopicQuote` 全绿不能证明 cmdSend 真的用了它，所以这里
 * 跑真实 CLI（fixtures/send-reply-card-capture.ts 截获全部飞书读写），看主消息最终是
 * reply（带 quote）还是新发（不带 quote）。
 *
 * Run: bunx vitest run test/send-after-the-fact-topic-quote-wiring.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

/** Send one reply from turn `om_turn` of a 普通群 (chat-scope) session; return the primary write path. */
function sendFromTopLevelTurn(opts: { inThread?: boolean; threadId?: string; args?: string[]; staleSessionQuote?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-after-the-fact-topic-'));
  try {
    const data = join(root, 'data');
    mkdirSync(join(data, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(data, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'sid', turnId: 'om_turn' }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(data, 'cli_test', { sid: {
      sessionId: 'sid', status: 'active', cliId: 'codex', larkAppId: 'cli_test', chatId: 'oc_test',
      rootMessageId: 'om_root', scope: 'chat', chatType: 'group', workingDir: root,
      turnReplyContexts: { om_turn: {
        ...(opts.staleSessionQuote ? {} : { quoteTargetId: 'om_turn' }),
        ...(opts.inThread === undefined ? {} : { inThread: opts.inThread }),
      } },
      ...(opts.staleSessionQuote ? { quoteTargetId: opts.staleSessionQuote } : {}),
    } });
    const result = spawnSyncTsScript(fixture, ['send', '--no-mention', ...(opts.args ?? []), 'result'], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH, HOME: root, BOTS_CONFIG: join(root, 'bots.json'), SESSION_DATA_DIR: data,
        BOTMUX_SESSION_ID: 'sid', BOTMUX_TURN_ID: 'om_turn', BOTMUX_LARK_APP_ID: 'cli_test',
        ...(opts.threadId ? { BOTMUX_TEST_THREAD_ID: opts.threadId } : {}) },
    });
    expect(result.status, String(result.stderr)).toBe(0);
    const writes = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
      .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)) as { path: string });
    expect(writes.length, String(result.stdout)).toBeGreaterThan(0);
    return writes[0]!.path;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('botmux send: 事后开的话题不再被 quote 带进去', () => {
  it('顶层进来的一轮仍是顶层消息 → 照常 quote 回复', () => {
    expect(sendFromTopLevelTurn({ inThread: false })).toBe('/open-apis/im/v1/messages/om_turn/reply');
  }, 40000);

  it('被引消息事后被开成话题 → 收敛掉 quote，改为在群里新发', () => {
    expect(sendFromTopLevelTurn({ inThread: false, threadId: 'omt_after_the_fact' })).toBe('/open-apis/im/v1/messages');
  }, 40000);

  it('只 quote 本轮绑定的消息：会话级 quoteTargetId 是上一轮留下的，不得跨轮引用', () => {
    expect(sendFromTopLevelTurn({ inThread: false, staleSessionQuote: 'om_previous_turn' }))
      .toBe('/open-apis/im/v1/messages/om_turn/reply');
  }, 40000);

  it('判据命中 → 真的把 quote 收敛掉,而不是算完不用(MUT-E 拆的就是这一行)', () => {
    // ⚠️ 不能只 toMatch 一段含该赋值的正则：把那行注释掉后，注释里仍留着同样的
    // 字符，正则照样匹配 —— 实测这么写 98 个测试全绿、变异毫无牙。所以必须**逐行**
    // 检查：赋值语句必须以行首缩进开始，不能是 `//` 开头的注释行。
    const lines = cliSource.split('\n');
    const assignLines = lines.filter(l => /effectiveQuoteTargetId = undefined;/.test(l));
    expect(assignLines.length).toBeGreaterThan(0);
    // 至少有一行是**真正执行**的赋值（非注释）。
    const live = assignLines.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(live.length).toBeGreaterThan(0);
    // 且它落在判据的 if 块里。
    expect(convergenceBlock()).toMatch(/effectiveQuoteTargetId = undefined;/);
  });

  it('送进发送链的是**收敛后**的值,不是原始 quoteTargetId', () => {
    expect(cliSource).toMatch(
      /\.\.\.\(effectiveQuoteTargetId \? \{ quoteTargetId: effectiveQuoteTargetId \} : \{\}\)/,
    );
    // 原始值不得再直接进 proposedOutput（那样收敛就被绕过了）。
    expect(cliSource).not.toMatch(/\.\.\.\(quoteTargetId \? \{ quoteTargetId \} : \{\}\)/);
  });

  it('探测走 catch 兜底 ⇒ 飞书报错不阻断发送(失败方向=保持既有 quote)', () => {
    expect(cliSource).toMatch(/const probedThreadId = await getMessageThreadId\([^)]*\)\.catch/);
  });

  it('普通群聊顶层轮次优先解析本轮绑定的 quote 目标，同时防范跨轮污染', () => {
    expect(cliSource).toMatch(
      /const turnBoundQuoteTarget = turnReplyTarget\?\.rootMessageId\s*\?\?\s*s\.turnReplyContexts\?\.\[currentTurnId \?\? ''\]\?\.quoteTargetId\s*\?\?\s*\(turnReplyTarget\?\.turnId\?\.startsWith\('om_'\) \? turnReplyTarget\.turnId : undefined\);/,
    );
    expect(cliSource).toMatch(
      /sessionQuoteTargetId: vcMeetingDeliveryReplyOrigin[\s\S]*?\?\? turnBoundQuoteTarget\s*\?\? \(currentTurnId \? undefined : s\.quoteTargetId\)/,
    );
  });
  it('来路不明（旧记录没有 inThread）或显式 --quote → 保持 quote，不猜', () => {
    expect(sendFromTopLevelTurn({ threadId: 'omt_after_the_fact' })).toBe('/open-apis/im/v1/messages/om_turn/reply');
    expect(sendFromTopLevelTurn({ inThread: false, threadId: 'omt_after_the_fact', args: ['--quote', 'om_turn'] }))
      .toBe('/open-apis/im/v1/messages/om_turn/reply');
  }, 80000);
});
