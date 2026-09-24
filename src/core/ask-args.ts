/**
 * Pure helpers for `botmux ask` argument parsing.
 *
 * Kept in its own file (no I/O, no env reads) so the CSV / timeout parsing can
 * be unit-tested without spinning up a daemon. The actual CLI dispatch
 * (`cmdAsk`) lives in cli.ts and calls these helpers.
 */

import type { AskOption } from './ask-types.js';
import { ASK_MAX_TIMEOUT_MS } from './ask-limits.js';

export class AskArgsError extends Error {
  constructor(
    public readonly code:
      | 'options_missing'
      | 'options_too_few'
      | 'options_empty_key'
      | 'options_duplicate_key'
      | 'timeout_out_of_range'
      | 'timeout_not_number'
      | 's1_controller_only_flags'
      | 's1_controller_requires_json'
      | 's1_controller_bad_request_id'
      | 's1_controller_bad_not_before_ms'
      | 's1_controller_bad_expires_at_ms'
      | 's1_controller_bad_phase'
      | 's1_controller_bad_chat_id'
      | 's1_controller_bad_window',
    message: string,
  ) {
    super(message);
    this.name = 'AskArgsError';
  }
}

/** Parse `--options` CSV. Each item is either `key` (key==label) or `key=label`.
 *
 *  Rules:
 *   - Trims whitespace around each item and around `key=label` halves.
 *   - Drops empty items (trailing commas / `"a,,b"`); does not count them.
 *   - Requires ≥ 2 distinct keys after parsing.
 *   - Empty `key` (e.g. `"=label"`) is rejected.
 *   - Duplicate keys are rejected — let the caller surface a clear error rather
 *     than silently de-duping (which would change observable button count).
 *   - The first `=` splits key/label; subsequent `=` are part of the label, so
 *     `"go=继续=右"` → key=`go`, label=`继续=右`. */
export function parseAskOptions(raw: string | undefined): AskOption[] {
  if (raw === undefined || raw.trim() === '') {
    throw new AskArgsError('options_missing', '缺少 --options（需要 ≥ 2 项，例如 --options "yes,no" 或 --options "yes=继续,no=回滚"）');
  }
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const out: AskOption[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const eq = item.indexOf('=');
    let key: string;
    let label: string;
    if (eq < 0) {
      key = item;
      label = item;
    } else {
      key = item.slice(0, eq).trim();
      label = item.slice(eq + 1).trim();
      if (label === '') label = key; // `"yes="` → label falls back to key
    }
    if (key === '') {
      throw new AskArgsError(
        'options_empty_key',
        `--options 项的 key 不能为空（"${item}"）`,
      );
    }
    if (seen.has(key)) {
      throw new AskArgsError(
        'options_duplicate_key',
        `--options 出现重复 key: ${key}`,
      );
    }
    seen.add(key);
    out.push({ key, label });
  }

  if (out.length < 2) {
    throw new AskArgsError(
      'options_too_few',
      `--options 至少需要 2 项，收到 ${out.length}`,
    );
  }
  return out;
}

/** Parse `--timeout <seconds>` → milliseconds. Bounds match §7:
 *   - lower bound: 10s (sub-10s asks are almost always a bug)
 *   - upper bound: 3600s (1h — past that, recovery should kick in v0.1.8)
 *   - default: 300s (caller passes `undefined` to use it) */
export function parseAskTimeoutSeconds(
  raw: string | undefined,
  defaults: { default: number; min: number; max: number } = {
    default: 300,
    min: 10,
    max: 3600,
  },
): number {
  if (raw === undefined) return defaults.default * 1000;
  const trimmed = raw.trim();
  if (trimmed === '') return defaults.default * 1000;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AskArgsError(
      'timeout_not_number',
      `--timeout 必须是整数秒数，收到 "${raw}"`,
    );
  }
  if (n < defaults.min || n > defaults.max) {
    throw new AskArgsError(
      'timeout_out_of_range',
      `--timeout 范围 [${defaults.min}, ${defaults.max}] 秒，收到 ${n}`,
    );
  }
  return n * 1000;
}

export interface S1ControllerAskArgs {
  phase: 'binding' | 'execution';
  chatId: string;
  requestId: string;
  notBeforeMs: number;
  expiresAtMs: number;
  recoverOnly: boolean;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag && i + 1 < args.length) return args[i + 1];
    if (arg.startsWith(flag + '=')) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function parseAbsoluteSafeIntegerMs(
  raw: string | undefined,
  code: 's1_controller_bad_not_before_ms' | 's1_controller_bad_expires_at_ms',
  flag: '--not-before-ms' | '--expires-at-ms',
): number {
  if (raw === undefined || raw.trim() === '') {
    throw new AskArgsError(code, `${flag} 必须是绝对毫秒时间戳（safe integer）`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new AskArgsError(code, `${flag} 必须是绝对毫秒时间戳（safe integer），收到 "${raw}"`);
  }
  return n;
}

/** Parse the dedicated S1-controller ask contract.
 *
 *  Contract:
 *   - disabled: S1-only flags are forbidden in ordinary ask mode
 *   - enabled: requires `--json`, `--request-id <64hex>`,
 *     `--not-before-ms <abs-safe-int>`, `--expires-at-ms <abs-safe-int>`
 *   - `expiresAtMs - notBeforeMs` must be in `(0, 24h]`
 *   - `--recover-only` only has meaning when S1 mode is enabled */
export function parseS1ControllerAskArgs(
  args: readonly string[],
  options: { json: boolean },
): S1ControllerAskArgs | null {
  const s1Enabled = hasFlag(args, '--s1-controller');
  const hasS1OnlyFlag =
    hasFlag(args, '--recover-only')
    || valueAfter(args, '--request-id') !== undefined
    || hasFlag(args, '--request-id')
    || valueAfter(args, '--not-before-ms') !== undefined
    || hasFlag(args, '--not-before-ms')
    || valueAfter(args, '--expires-at-ms') !== undefined
    || hasFlag(args, '--expires-at-ms')
    || valueAfter(args, '--phase') !== undefined
    || hasFlag(args, '--phase')
    || valueAfter(args, '--chat-id') !== undefined
    || hasFlag(args, '--chat-id');

  if (!s1Enabled) {
    if (hasS1OnlyFlag) {
      throw new AskArgsError(
        's1_controller_only_flags',
        '--phase / --chat-id / --request-id / --not-before-ms / --expires-at-ms / --recover-only 仅可与 --s1-controller 一起使用',
      );
    }
    return null;
  }

  if (!options.json) {
    throw new AskArgsError(
      's1_controller_requires_json',
      '--s1-controller requires --json',
    );
  }

  const phase = valueAfter(args, '--phase');
  if (phase !== 'binding' && phase !== 'execution') {
    throw new AskArgsError(
      's1_controller_bad_phase',
      '--phase 必须是 binding 或 execution',
    );
  }
  const chatId = valueAfter(args, '--chat-id');
  if (!chatId || !chatId.trim()) {
    throw new AskArgsError('s1_controller_bad_chat_id', '--chat-id 必须是非空字符串');
  }

  const requestId = valueAfter(args, '--request-id');
  if (!requestId || !/^[0-9a-f]{64}$/.test(requestId)) {
    throw new AskArgsError(
      's1_controller_bad_request_id',
      '--request-id 必须是固定 64hex 字符串',
    );
  }

  const notBeforeMs = parseAbsoluteSafeIntegerMs(
    valueAfter(args, '--not-before-ms'),
    's1_controller_bad_not_before_ms',
    '--not-before-ms',
  );
  const expiresAtMs = parseAbsoluteSafeIntegerMs(
    valueAfter(args, '--expires-at-ms'),
    's1_controller_bad_expires_at_ms',
    '--expires-at-ms',
  );
  const windowMs = expiresAtMs - notBeforeMs;
  if (windowMs <= 0 || windowMs > ASK_MAX_TIMEOUT_MS) {
    throw new AskArgsError(
      's1_controller_bad_window',
      `--not-before-ms 必须小于 --expires-at-ms，且窗口不得超过 ${ASK_MAX_TIMEOUT_MS}ms`,
    );
  }

  return {
    phase,
    chatId,
    requestId,
    notBeforeMs,
    expiresAtMs,
    recoverOnly: hasFlag(args, '--recover-only'),
  };
}

/** Resolve the `(sub, rest)` pair for `botmux ask`'s top-level dispatch.
 *
 *  Input: positional args *after* the `ask` token. So for the user typing
 *  `botmux ask buttons --options yes,no "prompt"` we get
 *  `['buttons', '--options', 'yes,no', 'prompt']`; for the bare alias
 *  `botmux ask --options yes,no "prompt"` we get
 *  `['--options', 'yes,no', 'prompt']`.
 *
 *  The first positional starting with `--` means the user skipped the
 *  subcommand and went straight to flags — that's the bare-alias path; we
 *  return `sub=''` and let `cmdAsk` apply its v0.1.7 `buttons` default.
 *  Otherwise the first positional is the subcommand. */
export function normalizeAskDispatch(
  tail: ReadonlyArray<string>,
): { sub: string; rest: string[] } {
  const next = tail[0] ?? '';
  if (next.startsWith('--')) {
    return { sub: '', rest: tail.slice(0) };
  }
  return { sub: next, rest: tail.slice(1) };
}

/** Required env vars on the CLI side (§5). Returns the first missing one so
 *  the caller can produce a single, specific error message.
 *
 *  Ordinary asks still require the full trusted session context from the
 *  parent shell. S1-controller asks bind by explicit app/chat selection, then
 *  optionally carry trusted session/root execution hints only in execution
 *  phase. */
export function findMissingAskEnv(
  env: NodeJS.ProcessEnv,
  options: { s1Controller?: boolean; s1Phase?: 'binding' | 'execution' } = {},
): string | null {
  let required: string[];
  if (!options.s1Controller) {
    required = [
      'BOTMUX_SESSION_ID',
      'BOTMUX_CHAT_ID',
      'BOTMUX_LARK_APP_ID',
      'BOTMUX_ROOT_MESSAGE_ID',
    ];
  } else if (options.s1Phase === 'execution') {
    required = ['BOTMUX_LARK_APP_ID', 'BOTMUX_SESSION_ID', 'BOTMUX_ROOT_MESSAGE_ID'];
  } else {
    required = ['BOTMUX_LARK_APP_ID'];
  }
  for (const k of required) {
    if (!env[k] || !env[k]!.trim()) return k;
  }
  return null;
}
