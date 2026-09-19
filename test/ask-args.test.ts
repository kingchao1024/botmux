/**
 * Pure-function tests for `botmux ask` argument parsing. Covers:
 *  - --options CSV (key only / key=label / dedupe / empty key / count floor)
 *  - --timeout bounds and integer-only enforcement
 *  - missing env detection in §5 order
 *
 * Run:  pnpm vitest run test/ask-args.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  AskArgsError,
  findMissingAskEnv,
  normalizeAskDispatch,
  parseAskOptions,
  parseS1ControllerAskArgs,
  parseAskTimeoutSeconds,
} from '../src/core/ask-args.js';

describe('parseAskOptions', () => {
  it('parses bare keys with key==label', () => {
    expect(parseAskOptions('yes,no')).toEqual([
      { key: 'yes', label: 'yes' },
      { key: 'no', label: 'no' },
    ]);
  });

  it('parses key=label form, label can be CJK', () => {
    expect(parseAskOptions('yes=继续,no=回滚')).toEqual([
      { key: 'yes', label: '继续' },
      { key: 'no', label: '回滚' },
    ]);
  });

  it('mixes key-only and key=label entries', () => {
    expect(parseAskOptions('go,abort=取消')).toEqual([
      { key: 'go', label: 'go' },
      { key: 'abort', label: '取消' },
    ]);
  });

  it('treats further "=" as part of label (only first "=" splits)', () => {
    expect(parseAskOptions('go=继续=右,no=不')).toEqual([
      { key: 'go', label: '继续=右' },
      { key: 'no', label: '不' },
    ]);
  });

  it('trims whitespace around items and around key/label halves', () => {
    expect(parseAskOptions('  yes  ,  no = 不要 ')).toEqual([
      { key: 'yes', label: 'yes' },
      { key: 'no', label: '不要' },
    ]);
  });

  it('drops empty items between commas (trailing comma is forgiving)', () => {
    expect(parseAskOptions('yes,,no,')).toEqual([
      { key: 'yes', label: 'yes' },
      { key: 'no', label: 'no' },
    ]);
  });

  it('falls back label to key when "key=" has empty label half', () => {
    expect(parseAskOptions('yes=,no')).toEqual([
      { key: 'yes', label: 'yes' },
      { key: 'no', label: 'no' },
    ]);
  });

  it('rejects undefined / empty input', () => {
    expect(() => parseAskOptions(undefined)).toThrowError(AskArgsError);
    expect(() => parseAskOptions('')).toThrowError(/缺少 --options/);
    expect(() => parseAskOptions('   ')).toThrowError(/缺少 --options/);
  });

  it('rejects fewer than 2 items', () => {
    expect(() => parseAskOptions('onlyone')).toThrowError(/至少需要 2 项/);
  });

  it('rejects empty key like "=label"', () => {
    expect(() => parseAskOptions('=label,yes')).toThrowError(/key 不能为空/);
  });

  it('rejects duplicate keys (no silent dedupe)', () => {
    expect(() => parseAskOptions('yes,no,yes')).toThrowError(/重复 key: yes/);
  });

  it('tags errors with structured code for upstream mapping', () => {
    try {
      parseAskOptions('yes,yes');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AskArgsError);
      expect((err as AskArgsError).code).toBe('options_duplicate_key');
    }
  });
});

describe('parseAskTimeoutSeconds', () => {
  it('defaults to 300s when unset', () => {
    expect(parseAskTimeoutSeconds(undefined)).toBe(300_000);
    expect(parseAskTimeoutSeconds('')).toBe(300_000);
  });

  it('parses integer seconds into ms', () => {
    expect(parseAskTimeoutSeconds('600')).toBe(600_000);
    expect(parseAskTimeoutSeconds('  10  ')).toBe(10_000);
  });

  it('rejects non-integer / non-numeric input', () => {
    expect(() => parseAskTimeoutSeconds('abc')).toThrowError(/必须是整数秒数/);
    expect(() => parseAskTimeoutSeconds('1.5')).toThrowError(/必须是整数秒数/);
  });

  it('rejects values outside [10, 3600]', () => {
    expect(() => parseAskTimeoutSeconds('5')).toThrowError(/范围/);
    expect(() => parseAskTimeoutSeconds('7200')).toThrowError(/范围/);
  });

  it('accepts custom bounds', () => {
    expect(parseAskTimeoutSeconds('1', { default: 5, min: 1, max: 2 })).toBe(1000);
    expect(() =>
      parseAskTimeoutSeconds('3', { default: 5, min: 1, max: 2 }),
    ).toThrowError(/范围/);
  });
});

describe('normalizeAskDispatch', () => {
  it('canonical form: `ask buttons --options ...` keeps sub=buttons', () => {
    expect(normalizeAskDispatch(['buttons', '--options', 'yes,no', 'prompt'])).toEqual({
      sub: 'buttons',
      rest: ['--options', 'yes,no', 'prompt'],
    });
  });

  it('bare alias: `ask --options ...` routes to sub="" with all flags in rest', () => {
    expect(normalizeAskDispatch(['--options', 'yes,no', 'prompt'])).toEqual({
      sub: '',
      rest: ['--options', 'yes,no', 'prompt'],
    });
  });

  it('bare alias: `ask --json --options ...` (any leading flag triggers alias)', () => {
    expect(
      normalizeAskDispatch(['--json', '--options', 'yes,no', 'prompt']),
    ).toEqual({
      sub: '',
      rest: ['--json', '--options', 'yes,no', 'prompt'],
    });
  });

  it('empty tail (just `botmux ask`) routes to sub="" with no rest', () => {
    expect(normalizeAskDispatch([])).toEqual({ sub: '', rest: [] });
  });

  it('unknown subcommand passes through so cmdAsk can emit a useful error', () => {
    expect(normalizeAskDispatch(['text', '--options', 'a,b'])).toEqual({
      sub: 'text',
      rest: ['--options', 'a,b'],
    });
  });

  it('canonical form equivalence: bare alias and `buttons` produce same `rest`', () => {
    const bare = normalizeAskDispatch(['--options', 'yes,no', 'p']);
    const explicit = normalizeAskDispatch(['buttons', '--options', 'yes,no', 'p']);
    expect(bare.rest).toEqual(explicit.rest);
  });
});

describe('findMissingAskEnv', () => {
  it('returns null when all four env vars are present', () => {
    expect(
      findMissingAskEnv({
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_CHAT_ID: 'oc_1',
        BOTMUX_LARK_APP_ID: 'cli_1',
        BOTMUX_ROOT_MESSAGE_ID: 'om_1',
      }),
    ).toBeNull();
  });

  it('allows S1 binding mode with BOTMUX_LARK_APP_ID only', () => {
    expect(
      findMissingAskEnv(
        {
          BOTMUX_LARK_APP_ID: 'cli_1',
        },
        { s1Controller: true, s1Phase: 'binding' },
      ),
    ).toBeNull();
  });

  it('requires app+session+root for S1 execution mode', () => {
    expect(
      findMissingAskEnv(
        {
          BOTMUX_LARK_APP_ID: 'cli_1',
          BOTMUX_SESSION_ID: 'sess-1',
          BOTMUX_ROOT_MESSAGE_ID: 'om_1',
        },
        { s1Controller: true, s1Phase: 'execution' },
      ),
    ).toBeNull();
  });

  it('reports the first missing var in §5 order', () => {
    expect(
      findMissingAskEnv({
        BOTMUX_CHAT_ID: 'oc_1',
        BOTMUX_LARK_APP_ID: 'cli_1',
        BOTMUX_ROOT_MESSAGE_ID: 'om_1',
      }),
    ).toBe('BOTMUX_SESSION_ID');
    expect(
      findMissingAskEnv({
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_LARK_APP_ID: 'cli_1',
        BOTMUX_ROOT_MESSAGE_ID: 'om_1',
      }),
    ).toBe('BOTMUX_CHAT_ID');
    expect(
      findMissingAskEnv(
        {
          BOTMUX_SESSION_ID: 'sess-1',
          BOTMUX_CHAT_ID: 'oc_1',
          BOTMUX_ROOT_MESSAGE_ID: 'om_1',
        },
        { s1Controller: true, s1Phase: 'binding' },
      ),
    ).toBe('BOTMUX_LARK_APP_ID');
    expect(
      findMissingAskEnv(
        {
          BOTMUX_LARK_APP_ID: 'cli_1',
          BOTMUX_ROOT_MESSAGE_ID: 'om_1',
        },
        { s1Controller: true, s1Phase: 'execution' },
      ),
    ).toBe('BOTMUX_SESSION_ID');
  });

  it('treats blank/whitespace as missing', () => {
    expect(
      findMissingAskEnv({
        BOTMUX_SESSION_ID: '   ',
        BOTMUX_CHAT_ID: 'oc_1',
        BOTMUX_LARK_APP_ID: 'cli_1',
        BOTMUX_ROOT_MESSAGE_ID: 'om_1',
      }),
    ).toBe('BOTMUX_SESSION_ID');
  });
});

describe('parseS1ControllerAskArgs', () => {
  it('returns null in ordinary mode with no S1-only flags', () => {
    expect(parseS1ControllerAskArgs(['--options', 'yes,no'], { json: false })).toBeNull();
  });

  it('rejects S1-only flags outside --s1-controller mode', () => {
    expect(() => parseS1ControllerAskArgs(['--request-id', 'a'.repeat(64)], { json: true }))
      .toThrowError(/仅可与 --s1-controller 一起使用/);
    expect(() => parseS1ControllerAskArgs(['--recover-only'], { json: true }))
      .toThrowError(/仅可与 --s1-controller 一起使用/);
  });

  it('requires --json for S1 controller asks', () => {
    expect(() => parseS1ControllerAskArgs(['--s1-controller'], { json: false }))
      .toThrowError(/requires --json/);
  });

  it('accepts a valid S1 controller contract and preserves recover-only', () => {
    expect(parseS1ControllerAskArgs([
      '--s1-controller',
      '--phase', 'binding',
      '--chat-id', 'oc_chat',
      '--request-id', 'a'.repeat(64),
      '--not-before-ms', '1700000000000',
      '--expires-at-ms', '1700086400000',
      '--recover-only',
    ], { json: true })).toEqual({
      phase: 'binding',
      chatId: 'oc_chat',
      requestId: 'a'.repeat(64),
      notBeforeMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      recoverOnly: true,
    });
  });

  it('accepts exactly 24h and rejects 24h+1ms', () => {
    expect(parseS1ControllerAskArgs([
      '--s1-controller',
      '--phase', 'execution',
      '--chat-id', 'oc_chat',
      '--request-id', 'b'.repeat(64),
      '--not-before-ms', '1700000000000',
      '--expires-at-ms', '1700086400000',
    ], { json: true })).toEqual({
      phase: 'execution',
      chatId: 'oc_chat',
      requestId: 'b'.repeat(64),
      notBeforeMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      recoverOnly: false,
    });
    expect(() => parseS1ControllerAskArgs([
      '--s1-controller',
      '--phase', 'execution',
      '--chat-id', 'oc_chat',
      '--request-id', 'b'.repeat(64),
      '--not-before-ms', '1700000000000',
      '--expires-at-ms', '1700086400001',
    ], { json: true })).toThrowError(/窗口不得超过/);
  });

  it('requires valid --phase and non-empty --chat-id', () => {
    expect(() => parseS1ControllerAskArgs([
      '--s1-controller',
      '--chat-id', 'oc_chat',
      '--request-id', 'd'.repeat(64),
      '--not-before-ms', '1700000000000',
      '--expires-at-ms', '1700086400000',
    ], { json: true })).toThrowError(/--phase/);
    expect(() => parseS1ControllerAskArgs([
      '--s1-controller',
      '--phase', 'binding',
      '--request-id', 'd'.repeat(64),
      '--not-before-ms', '1700000000000',
      '--expires-at-ms', '1700086400000',
    ], { json: true })).toThrowError(/--chat-id/);
  });

  it('rejects bad request ids and invalid absolute timestamps', () => {
    expect(() => parseS1ControllerAskArgs([
      '--s1-controller',
      '--phase', 'binding',
      '--chat-id', 'oc_chat',
      '--request-id', 'short',
      '--not-before-ms', '1700000000000',
      '--expires-at-ms', '1700086400000',
    ], { json: true })).toThrowError(/64hex/);
    expect(() => parseS1ControllerAskArgs([
      '--s1-controller',
      '--phase', 'binding',
      '--chat-id', 'oc_chat',
      '--request-id', 'A'.repeat(64),
      '--not-before-ms', '1700000000000',
      '--expires-at-ms', '1700086400000',
    ], { json: true })).toThrowError(/64hex/);
    expect(() => parseS1ControllerAskArgs([
      '--s1-controller',
      '--phase', 'binding',
      '--chat-id', 'oc_chat',
      '--request-id', 'c'.repeat(64),
      '--not-before-ms', 'NaN',
      '--expires-at-ms', '1700086400000',
    ], { json: true })).toThrowError(/--not-before-ms/);
    expect(() => parseS1ControllerAskArgs([
      '--s1-controller',
      '--phase', 'binding',
      '--chat-id', 'oc_chat',
      '--request-id', 'c'.repeat(64),
      '--not-before-ms', '1700000000000',
      '--expires-at-ms', 'NaN',
    ], { json: true })).toThrowError(/--expires-at-ms/);
    expect(() => parseS1ControllerAskArgs([
      '--s1-controller',
      '--phase', 'binding',
      '--chat-id', 'oc_chat',
      '--request-id', 'c'.repeat(64),
      '--not-before-ms', '1700086400000',
      '--expires-at-ms', '1700000000000',
    ], { json: true })).toThrowError(/必须小于/);
  });
});
