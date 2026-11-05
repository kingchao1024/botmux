import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('src/daemon.ts'), 'utf8');

function region(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('daemon Codex App workflow prompt lanes', () => {
  it('keeps a new-topic workflow command visible while hiding the generated skill prompt', () => {
    const block = region(
      'async function handleNewTopic',
      'const autoStartJoinInFlight',
    );

    expect(block.indexOf('const codexAppVisibleText = content;'))
      .toBeLessThan(block.indexOf('content = workflowGrillPrompt;'));
    // 话题上下文 (topicThreadContext) 必须双 lane 下发：既进 legacy promptContent，
    // 也进 codex-app 结构化 sidecar codexAppMessageContext，否则 codex-app bot 静默丢话题历史。
    // fork 侧恢复路径会重算回写这两个变量，故声明为 let（上游为 const）。
    expect(block).toContain("let codexAppMessageContext = topicThreadContext + codexAppQuoteContext + (workflowGrillPrompt ?? '');");
    expect(block).toContain(': topicThreadContext + codexAppQuoteContext + codexAppApplicationContext + content;');
    expect(block).toContain('pendingCodexAppText: codexAppVisibleText');
    expect(source).toContain('codexAppText: ds.pendingCodexAppText');
    expect(block.match(/forkReservedInitialSession\(ds, availableBots, trustedCaller, primaryAdmission\?\.options\)/g)).toHaveLength(2);
  });

  it('retains VC lifecycle context in rewritten legacy prompts without demoting it to untrusted', () => {
    const block = region(
      'async function handleThreadReply',
      'async function autoCreateDocSession',
    );

    expect(block).toMatch(
      /promptContent = initialCodexAppMessageContext\s*\+ initialCodexAppApplicationContext\s*\+ workflowPrompt;/,
    );
    expect(block).toContain(
      'rewrittenCodexAppMessageContext = initialCodexAppMessageContext + workflowPrompt;',
    );
    // 同上：fork 恢复路径会重算回写，声明为 let（上游为 const）。
    expect(block).toMatch(
      /let codexAppMessageContext = rewrittenCodexAppMessageContext\s*\?\? initialCodexAppMessageContext;/,
    );
    expect(block).toContain(
      'const codexAppApplicationContext = initialCodexAppApplicationContext;',
    );
  });

  it('does not buffer ordinary turns solely because repo commit UI cleanup is still in flight', () => {
    const block = region(
      'async function handleThreadReply',
      'async function autoCreateDocSession',
    );
    expect(block).toContain('if (ds?.pendingRepo || initialStartPending) {');
    expect(block).not.toContain('if (ds?.pendingRepo || ds?.pendingRepoCommitInFlight || initialStartPending)');
  });

  it('does not use the raw owner DM fallback for notifier card authorization', () => {
    const block = region(
      'const handleCodexNotifierCardAction',
      'const cardDeps',
    );
    expect(block).toContain('getExpectedOwnerOpenId: getOwnerOpenId,');
    expect(block).not.toContain('resolvePrimaryOwnerOpenId');
  });
});

describe('daemon Codex notifier card authorization', () => {
  // 源码结构护栏(K2)：Codex 完成通知卡的按钮回调只能用 daemon 解析出的运行时 owner（getOwnerOpenId）鉴权；
  // resolvePrimaryOwnerOpenId 会回退到 bots.json 里原样的 allowedUsers ou_，而 ou_ 是 app-scoped，不能当跨应用
  // 的身份事实（见 CLAUDE.md「飞书 owner 身份边界」）。handler 由 createCodexNotifierCardActionHandler 注入依赖，
  // 但选哪个 owner 解析器是在 daemon.ts 入口模块里接的线，没有行为 seam。
  it('authorizes notifier card actions with the resolved runtime owner, not the raw DM fallback', () => {
    const start = source.indexOf('createCodexNotifierCardActionHandler({');
    expect(start).toBeGreaterThan(-1);
    const deps = source.slice(start, source.indexOf('\n});', start));
    expect(deps).toMatch(/getExpectedOwnerOpenId:\s*getOwnerOpenId\b/);
    expect(deps).not.toContain('resolvePrimaryOwnerOpenId');
  });
});
