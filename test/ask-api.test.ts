/**
 * Unit tests for the daemon-side `POST /api/asks` body parser (parseAskBody).
 * Pure-function tests, no HTTP server, no bot-registry mocking.
 *
 * Run:  pnpm vitest run test/ask-api.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  askOriginKindForPath,
  askPathClassificationForPath,
  parseAskBody,
  validateAskRouteContract,
  verifiedAskMention,
} from '../src/core/ask-api.js';

function validBody(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    chatId: 'oc_chat',
    larkAppId: 'cli_app',
    rootMessageId: 'om_root',
    options: [
      { key: 'yes', label: '继续' },
      { key: 'no', label: '回滚' },
    ],
    prompt: '继续发版吗？',
    timeoutMs: 60_000,
    ...over,
  };
}

function validS1Body(over: Record<string, unknown> = {}) {
  return {
    phase: 'binding',
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    questions: [
      {
        prompt: '继续发版吗？',
        multiSelect: false,
        options: [
          { key: 'yes', label: '继续' },
          { key: 'no', label: '回滚' },
        ],
      },
    ],
    timeoutMs: 60_000,
    requestId: 'a'.repeat(64),
    notBeforeMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_060_000,
    ...over,
  };
}

describe('parseAskBody — happy path', () => {
  it('accepts no deadline only for an explicit invocation with a stable request identity', () => {
    expect(parseAskBody(validBody({ timeoutMs: 0, originKind: 'explicit', requestId: 'stable' })))
      .toMatchObject({ timeoutMs: 0, deprecatedOriginKindHint: 'explicit', requestId: 'stable' });
    for (const originKind of [undefined, 'hook', 'permission', 'host_explicit']) {
      expect(parseAskBody(validBody({ timeoutMs: 0, originKind, requestId: 'stable' })))
        .toHaveProperty('error');
    }
    expect(parseAskBody(validBody({ timeoutMs: 0, originKind: 'explicit' })))
      .toHaveProperty('error');
  });

  it('parses explicit result acknowledgement without treating it as a new Ask', () => {
    expect(parseAskBody(validBody({ requestId: 'stable', originKind: 'explicit', acknowledge: true }))).toMatchObject({ acknowledge: true, requestId: 'stable' });
  });
  it.each(['true', 1, null])('rejects non-boolean acknowledgement %s', acknowledge => {
    expect(parseAskBody(validBody({ acknowledge }))).toEqual({ error: 'bad_acknowledge' });
  });
  it.each(['host_explicit', 'host_cross_principal_wait', 'host_anything'])
  ('rejects daemon-internal host_ originKind %s over HTTP', originKind => {
    // host_* claimants are constructed in-process only; a client typing one
    // would collect broker GC/handoff exemptions without a daemon-owned record.
    expect(parseAskBody(validBody({ originKind }))).toEqual({ error: 'bad_originKind' });
  });
  it('still accepts the client-facing explicit originKind', () => {
    const out = parseAskBody(validBody({ originKind: 'explicit' }));
    expect('error' in out).toBe(false);
  });

  it('accepts a fully populated body and returns the parsed shape', () => {
    const out = parseAskBody(validBody());
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.sessionId).toBe('sess-1');
    // 旧格式（options+prompt）归一化为 questions[0]
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0].options).toHaveLength(2);
    expect(out.questions[0].options[0]).toEqual({ key: 'yes', label: '继续' });
    expect(out.rootMessageId).toBe('om_root');
  });

  it('accepts rootMessageId=null (chat-scope ask)', () => {
    const out = parseAskBody(validBody({ rootMessageId: null }));
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.rootMessageId).toBeNull();
  });

  it('accepts exactly 24h and rejects 24h + 1ms', () => {
    expect(parseAskBody(validBody({ timeoutMs: 86_400_000 }))).not.toHaveProperty('error');
    expect(parseAskBody(validBody({ timeoutMs: 86_400_001 }))).toEqual({ error: 'bad_timeoutMs' });
  });
});

describe('parseAskBody — validation', () => {
  it.each([
    ['bad_body', null],
    ['bad_body', undefined],
    ['bad_body', []],
    ['bad_body', 'not an object'],
  ] as const)('returns %s for non-object raw=%j', (expected, raw) => {
    const out = parseAskBody(raw);
    expect(out).toEqual({ error: expected });
  });

  it.each([
    ['bad_sessionId', { sessionId: '' }],
    ['bad_sessionId', { sessionId: '   ' }],
    ['bad_chatId', { chatId: '' }],
    ['bad_larkAppId', { larkAppId: '' }],
    ['bad_rootMessageId', { rootMessageId: 42 }],
    ['bad_prompt', { prompt: '' }],
    ['bad_prompt', { prompt: '   ' }],
    ['bad_timeoutMs', { timeoutMs: 500 }],          // below minimum (1s)
    ['bad_timeoutMs', { timeoutMs: 60_000.5 }],
    ['bad_timeoutMs', { timeoutMs: NaN }],
    ['bad_timeoutMs', { timeoutMs: 'forever' }],
    ['bad_options', { options: [] }],
    ['bad_options', { options: [{ key: 'only', label: 'only' }] }],
    ['bad_options', { options: 'not-an-array' }],
  ] as const)('returns %s when %s', (expected, override) => {
    expect(parseAskBody(validBody(override))).toEqual({ error: expected });
  });

  it('rejects option with empty key', () => {
    const out = parseAskBody(
      validBody({
        options: [
          { key: '', label: 'bad' },
          { key: 'yes', label: 'good' },
        ],
      }),
    );
    expect(out).toEqual({ error: 'bad_option_key' });
  });

  it('rejects option without a string label', () => {
    const out = parseAskBody(
      validBody({
        options: [
          { key: 'yes', label: 1 as unknown as string },
          { key: 'no', label: 'no' },
        ],
      }),
    );
    expect(out).toEqual({ error: 'bad_option_label' });
  });

  it('rejects duplicate option keys', () => {
    const out = parseAskBody(
      validBody({
        options: [
          { key: 'yes', label: '继续' },
          { key: 'yes', label: '再继续' },
        ],
      }),
    );
    expect(out).toEqual({ error: 'duplicate_option_key' });
  });
});

describe('parseAskBody — supported request semantics', () => {
  it('rejects an unsupported request contract instead of reducing it to an ordinary Ask', () => {
    expect(parseAskBody(validBody({
      requestId: 'original-request', originKind: 'explicit',
      requiredContract: { kind: 'durable-approval', revision: 1 },
    }))).toEqual({ error: 'unsupported_fields' });
  });

  it('preserves native hook identity while leaving route claims to the authorizer', () => {
    const out = parseAskBody(validBody({
      requestId: 'original-hook', originKind: 'hook',
      originCapability: 'fixture-capability', originTurnId: 'original-turn', originDispatchAttempt: 2,
    }));
    expect(out).toMatchObject({ requestId: 'original-hook', deprecatedOriginKindHint: 'hook' });
    expect(out).not.toHaveProperty('originKind');
    expect(out).not.toHaveProperty('originCapability');
    expect(out).not.toHaveProperty('originTurnId');
    expect(out).not.toHaveProperty('originDispatchAttempt');
  });
});

describe('parseAskBody — questions[] 多问多选', () => {
  it('接受 questions[]（多问多选）', () => {
    const body = parseAskBody({
      sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null,
      timeoutMs: 60000,
      questions: [
        { prompt: 'q1', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: 'q2', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });
    expect('error' in body).toBe(false);
    if (!('error' in body)) { expect(body.questions).toHaveLength(2); expect(body.questions[1].multiSelect).toBe(true); }
  });

  it('兼容旧 options[]+prompt：归一成单问单选', () => {
    const body = parseAskBody({
      sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null,
      timeoutMs: 60000, prompt: 'go?', options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }],
    });
    if (!('error' in body)) { expect(body.questions).toHaveLength(1); expect(body.questions[0].prompt).toBe('go?'); expect(body.questions[0].multiSelect).toBe(false); }
  });

  it('每问 options<2 报错', () => {
    const body = parseAskBody({ sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null, timeoutMs: 60000, questions: [{ prompt: 'q', multiSelect: false, options: [{ key: 'x', label: 'X' }] }] });
    expect('error' in body).toBe(true);
  });
});

describe('parseAskBody — caller-controlled identity fields', () => {
  it('accepts requestId while keeping route-owned origin classification out of the body', () => {
    const out = parseAskBody(validBody({ requestId: 'req-abc' }));
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.requestId).toBe('req-abc');
      expect(out).not.toHaveProperty('originKind');
      expect(out).not.toHaveProperty('askId');
    }
  });

  it('缺省时 requestId 为 undefined（旧调用方兼容）', () => {
    const out = parseAskBody(validBody());
    if (!('error' in out)) {
      expect(out.requestId).toBeUndefined();
    }
  });

  it('非法 requestId（空 / 超 128 / 非字符串）报错', () => {
    expect('error' in parseAskBody(validBody({ requestId: '' }))).toBe(true);
    expect('error' in parseAskBody(validBody({ requestId: 'x'.repeat(129) }))).toBe(true);
    expect('error' in parseAskBody(validBody({ requestId: 123 }))).toBe(true);
  });

  it('accepts deprecated ordinary originKind=explicit|hook and strips it from parsed output', () => {
    for (const originKind of ['explicit', 'hook'] as const) {
      const out = parseAskBody(validBody({ originKind }));
      expect('error' in out).toBe(false);
      if ('error' in out) continue;
      expect(out).not.toHaveProperty('originKind');
      expect(out.deprecatedOriginKindHint).toBe(originKind);
      expect(out.sessionId).toBe('sess-1');
    }
  });

  it('rejects unsupported ordinary originKind values and askId', () => {
    expect(parseAskBody(validBody({ originKind: 's1-controller' }))).toEqual({ error: 'bad_originKind' });
    expect(parseAskBody(validBody({ originKind: 'weird' }))).toEqual({ error: 'bad_originKind' });
    expect(parseAskBody(validBody({ originKind: {}, askId: 42 }))).toEqual({ error: 'unexpected_field' });
  });

  it('accepts absolute S1 controller windows up to exactly 24h', () => {
    const out = parseAskBody(validS1Body({
      expiresAtMs: 1_700_086_400_000,
      timeoutMs: 86_400_000,
    }));
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out).not.toHaveProperty('sessionId');
      expect(out).not.toHaveProperty('rootMessageId');
      expect(out.chatId).toBe('oc_chat');
      expect(out.phase).toBe('binding');
      expect(out.questions).toEqual([{
        prompt: '继续发版吗？',
        multiSelect: false,
        options: [
          { key: 'yes', label: '继续' },
          { key: 'no', label: '回滚' },
        ],
      }]);
      expect(out.requestId).toBe('a'.repeat(64));
      expect(out.notBeforeMs).toBe(1_700_000_000_000);
      expect(out.expiresAtMs).toBe(1_700_086_400_000);
    }
  });

  it('rejects invalid absolute S1 controller windows', () => {
    expect(parseAskBody(validS1Body({
      expiresAtMs: 1_700_086_400_001,
      timeoutMs: 86_400_001,
    }))).toEqual({ error: 'bad_timeoutMs' });
    expect(parseAskBody(validS1Body({
      notBeforeMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_000_000,
    }))).toEqual({ error: 'bad_time_window' });
    expect(parseAskBody(validS1Body({
      notBeforeMs: 'x',
      expiresAtMs: 1_700_000_000_001,
    }))).toEqual({ error: 'bad_notBeforeMs' });
    expect(parseAskBody(validS1Body({
      notBeforeMs: 1_700_000_000_000,
      expiresAtMs: 'x',
    }))).toEqual({ error: 'bad_expiresAtMs' });
  });

  it('rejects S1 origin context fields from caller JSON', () => {
    expect(parseAskBody(validS1Body({ sessionId: 'sess-1' }))).toEqual({ error: 'bad_origin_context' });
    expect(parseAskBody(validS1Body({ rootMessageId: 'om_root' }))).toEqual({ error: 'bad_origin_context' });
    expect(parseAskBody(validS1Body({ originCapability: 'cap_1' }))).toEqual({ error: 'bad_origin_context' });
    expect(parseAskBody(validS1Body({ originTurnId: 'turn_1' }))).toEqual({ error: 'bad_origin_context' });
    expect(parseAskBody(validS1Body({ originDispatchAttempt: 1 }))).toEqual({ error: 'bad_origin_context' });
  });

  it('accepts S1 execution body with both session/root and optional capability', () => {
    const out = parseAskBody(validS1Body({
      phase: 'execution',
      sessionId: 'sess-1',
      rootMessageId: 'om_root',
      originCapability: 'cap_1',
      originTurnId: 'turn_1',
      originDispatchAttempt: 1,
    }));
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.phase).toBe('execution');
      expect(out.sessionId).toBe('sess-1');
      expect(out.rootMessageId).toBe('om_root');
      expect(out.originCapability).toBe('cap_1');
      expect(out.originTurnId).toBe('turn_1');
      expect(out.originDispatchAttempt).toBe(1);
    }
  });

  it('rejects partial S1 execution route context', () => {
    expect(parseAskBody(validS1Body({
      phase: 'execution',
      sessionId: 'sess-1',
    }))).toEqual({ error: 'bad_origin_context' });
    expect(parseAskBody(validS1Body({
      phase: 'execution',
      rootMessageId: 'om_root',
    }))).toEqual({ error: 'bad_origin_context' });
  });

  it('rejects missing S1 phase or chat selector', () => {
    expect(parseAskBody(validS1Body({ phase: undefined }))).toEqual({ error: 'bad_phase' });
    expect(parseAskBody(validS1Body({ chatId: '' }))).toEqual({ error: 'bad_chatId' });
  });

  it('rejects legacy prompt/options on S1 bodies', () => {
    expect(parseAskBody({
      phase: 'binding',
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      prompt: '继续发版吗？',
      options: [
        { key: 'yes', label: '继续' },
        { key: 'no', label: '回滚' },
      ],
      timeoutMs: 60_000,
      requestId: 'a'.repeat(64),
      notBeforeMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    })).toEqual({ error: 'unexpected_field' });
    expect(parseAskBody({
      phase: 'binding',
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      questions: [{
        prompt: '继续发版吗？',
        multiSelect: false,
        options: [
          { key: 'yes', label: '继续' },
          { key: 'no', label: '回滚' },
        ],
      }],
      originKind: 'explicit',
      timeoutMs: 60_000,
      requestId: 'a'.repeat(64),
      notBeforeMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    })).toEqual({ error: 'unexpected_field' });
  });

  it('rejects extra top-level fields on S1 bodies', () => {
    expect(parseAskBody(validS1Body({ extra: true }))).toEqual({ error: 'unexpected_field' });
    expect(parseAskBody(validS1Body({
      phase: 'execution',
      sessionId: 'sess-1',
      rootMessageId: 'om_root',
      extra: true,
    }))).toEqual({ error: 'unexpected_field' });
  });

  it('rejects extra fields on S1 questions and options', () => {
    expect(parseAskBody(validS1Body({
      questions: [{
        prompt: '继续发版吗？',
        multiSelect: false,
        options: [
          { key: 'yes', label: '继续' },
          { key: 'no', label: '回滚' },
        ],
        extra: true,
      }],
    }))).toEqual({ error: 'unexpected_field' });
    expect(parseAskBody(validS1Body({
      questions: [{
        prompt: '继续发版吗？',
        multiSelect: false,
        options: [
          { key: 'yes', label: '继续', extra: true },
          { key: 'no', label: '回滚' },
        ],
      }],
    }))).toEqual({ error: 'unexpected_field' });
  });
});

describe('Ask origin classification', () => {
  it('derives origin only from the authenticated endpoint path', () => {
    expect(askOriginKindForPath('/api/asks')).toBe('explicit');
    expect(askOriginKindForPath('/api/asks/hook')).toBe('hook');
    expect(askOriginKindForPath('/api/asks/s1-controller')).toBe('s1-controller');
    expect(askOriginKindForPath('/api/asks/s1-controller/recover')).toBe('s1-controller');
    expect(askOriginKindForPath('/api/asks/other')).toBeNull();
  });

  it('derives the trusted recovery marker from the endpoint path', () => {
    expect(askPathClassificationForPath('/api/asks')).toEqual({
      originKind: 'explicit',
      recoverOnly: false,
    });
    expect(askPathClassificationForPath('/api/asks/hook')).toEqual({
      originKind: 'hook',
      recoverOnly: false,
    });
    expect(askPathClassificationForPath('/api/asks/s1-controller')).toEqual({
      originKind: 's1-controller',
      recoverOnly: false,
    });
    expect(askPathClassificationForPath('/api/asks/s1-controller/recover')).toEqual({
      originKind: 's1-controller',
      recoverOnly: true,
    });
  });

  it('enforces lowercase 64hex and exact absolute-window identity at the S1 server boundary', () => {
    const route = askPathClassificationForPath('/api/asks/s1-controller')!;
    const base = parseAskBody(validS1Body());
    if ('error' in base) throw new Error(base.error);
    expect(validateAskRouteContract(base, route, 1_700_000_000_001)).toEqual({
      ok: true, deadlineAt: 1_700_000_060_000, timeoutMs: 59_999,
    });
    for (const requestId of ['a'.repeat(32), 'A'.repeat(64), `${'a'.repeat(63)}g`]) {
      expect(validateAskRouteContract({ ...base, requestId }, route, 1_700_000_000_001))
        .toEqual({ ok: false, status: 400, error: 'bad_requestId' });
    }
    expect(validateAskRouteContract({ ...base, timeoutMs: 59_999 }, route, 1_700_000_000_001))
      .toEqual({ ok: false, status: 400, error: 'bad_time_window' });
  });

  it('ordinary explicit route remains authoritative when deprecated originKind is present', () => {
    const body = parseAskBody(validBody({ originKind: 'hook' }));
    if ('error' in body) throw new Error(body.error);
    expect(validateAskRouteContract(body, askPathClassificationForPath('/api/asks')!, 1_700_000_000_000))
      .toEqual({ ok: true, deadlineAt: 1_700_000_060_000, timeoutMs: 60_000 });
  });

  it('ordinary hook route remains authoritative when deprecated originKind is present', () => {
    const body = parseAskBody(validBody({ originKind: 'explicit' }));
    if ('error' in body) throw new Error(body.error);
    expect(validateAskRouteContract(body, askPathClassificationForPath('/api/asks/hook')!, 1_700_000_000_000))
      .toEqual({ ok: true, deadlineAt: 1_700_000_060_000, timeoutMs: 60_000 });
  });

  it('rejects S1-only absolute fields on ordinary Ask routes', () => {
    expect(parseAskBody(validBody({
      notBeforeMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
      timeoutMs: 60_000,
    }))).toEqual({ error: 'unexpected_field' });
  });
});

describe('parseAskBody — mentionedOpenId (--mention)', () => {
  const explicit = (over: Record<string, unknown> = {}) => validBody({ requestId: 'r1', originKind: 'explicit', ...over });

  it.each(['ou_humanTarget0001', 'ou_proposer_bot', 'ou_a-b'])('显式 ask 接受与 --answerer 同形的 open_id：%s', (openId) => {
    expect(parseAskBody(explicit({ mentionedOpenId: openId }))).toMatchObject({ mentionedOpenId: openId });
  });

  it('只有显式 ask 能点名：hook / 无 origin 的请求带 mentionedOpenId 被拒', () => {
    expect(parseAskBody(validBody({ mentionedOpenId: 'ou_humanTarget0001' }))).toEqual({ error: 'bad_mentionedOpenId' });
    expect(parseAskBody(validBody({ requestId: 'r1', originKind: 'hook', mentionedOpenId: 'ou_humanTarget0001' })))
      .toEqual({ error: 'bad_mentionedOpenId' });
  });

  it('缺省时 mentionedOpenId 为 undefined（旧调用方兼容）', () => {
    const out = parseAskBody(explicit());
    expect('error' in out).toBe(false);
    if (!('error' in out)) expect(out.mentionedOpenId).toBeUndefined();
  });

  it.each([
    ['union_id', 'on_6741d98b6423c1b46e1ef7a5e6dd'],
    ['裸字符串', 'some-user'],
    ['空串', ''],
    ['带尖括号', 'ou_x><at id=all'],
    ['数字', 12345],
    ['对象', { id: 'ou_x' }],
    ['null', null],
  ])('%s', (_label, value) => {
    expect(parseAskBody(explicit({ mentionedOpenId: value }))).toEqual({ error: 'bad_mentionedOpenId' });
  });
});

describe('verifiedAskMention', () => {
  const human = async (openId: string) => openId === 'ou_human';

  it('只保留通讯录确认的真人', async () => {
    expect(await verifiedAskMention('ou_human', { isPeerBot: () => false, isHuman: human })).toBe('ou_human');
    expect(await verifiedAskMention('ou_unknown', { isPeerBot: () => false, isHuman: human })).toBeUndefined();
    expect(await verifiedAskMention(undefined, { isPeerBot: () => false, isHuman: human })).toBeUndefined();
  });

  it('已知的同伴 bot 不经通讯录就丢掉', async () => {
    let looked = false;
    const out = await verifiedAskMention('ou_human', { isPeerBot: () => true, isHuman: async (id) => { looked = true; return human(id); } });
    expect(out).toBeUndefined();
    expect(looked).toBe(false);
  });

  it('核实抛错时只丢掉点名，不让整张 ask 失败', async () => {
    await expect(verifiedAskMention('ou_human', { isPeerBot: () => false, isHuman: async () => { throw new Error('contact api down'); } }))
      .resolves.toBeUndefined();
    await expect(verifiedAskMention('ou_human', { isPeerBot: () => { throw new Error('bad cross-ref file'); }, isHuman: human }))
      .resolves.toBeUndefined();
  });
});

describe('parseAskBody — options[].description 透传', () => {
  it('新 questions 格式保留合法 description', () => {
    const out = parseAskBody({
      sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null, timeoutMs: 60000,
      questions: [{
        prompt: '选哪种发布方式？', multiSelect: false,
        options: [
          { key: 'gray', label: '灰度', description: '先放 5% 流量观察 30 分钟' },
          { key: 'full', label: '全量' },
        ],
      }],
    });
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.questions[0].options[0]).toEqual({ key: 'gray', label: '灰度', description: '先放 5% 流量观察 30 分钟' });
      expect(out.questions[0].options[1]).toEqual({ key: 'full', label: '全量' });
    }
  });

  it('旧 options+prompt 格式同样保留 description', () => {
    const out = parseAskBody(validBody({
      options: [
        { key: 'yes', label: '继续', description: '先灰度 10%' },
        { key: 'no', label: '停止' },
      ],
    }));
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.questions[0].options[0].description).toBe('先灰度 10%');
      expect(out.questions[0].options[1].description).toBeUndefined();
    }
  });

  it('空白 description 归一化为 undefined，非字符串/超长报错', () => {
    const ok = parseAskBody(validBody({
      options: [
        { key: 'yes', label: '继续', description: '   ' },
        { key: 'no', label: '停止' },
      ],
    }));
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) expect(ok.questions[0].options[0].description).toBeUndefined();

    expect('error' in parseAskBody(validBody({
      options: [
        { key: 'yes', label: '继续', description: 123 },
        { key: 'no', label: '停止' },
      ],
    }))).toBe(true);
    expect('error' in parseAskBody(validBody({
      options: [
        { key: 'yes', label: '继续', description: 'x'.repeat(1001) },
        { key: 'no', label: '停止' },
      ],
    }))).toBe(true);
  });
});

describe('parseAskBody — 超长选项说明', () => {
  const longOptions = (description: string) => [{ key: 'yes', label: '继续', description }, { key: 'no', label: '停止' }];

  it.each([
    ['questions[]', (description: string) => ({ questions: [{ prompt: '继续吗？', multiSelect: false, options: longOptions(description) }] })],
    ['旧 options', (description: string) => ({ options: longOptions(description) })],
  ])('hook 提问截到上限而不是整张拒收（%s）', (_shape, body) => {
    const out = parseAskBody(validBody({ requestId: 'tool-1', originKind: 'hook', ...body('x'.repeat(1500)) }));
    if ('error' in out) throw new Error(out.error);
    const description = out.questions[0].options[0].description!;
    expect(description.length).toBeLessThanOrEqual(1000);
    expect(description.endsWith('…')).toBe(true);
    expect(description.startsWith('x'.repeat(900))).toBe(true);
  });

  it('显式 ask 仍然 fail loud', () => {
    expect(parseAskBody(validBody({ requestId: 'r1', originKind: 'explicit', options: longOptions('x'.repeat(1001)) })))
      .toEqual({ error: 'bad_option_description' });
  });

  it('截断不留下孤立的 UTF-16 代理', () => {
    const out = parseAskBody(validBody({ requestId: 'tool-1', originKind: 'hook', options: longOptions(String.fromCodePoint(0x1f600).repeat(800)) }));
    if ('error' in out) throw new Error(out.error);
    expect(out.questions[0].options[0].description!.isWellFormed()).toBe(true);
  });
});
