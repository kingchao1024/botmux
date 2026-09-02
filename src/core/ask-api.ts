/**
 * Pure helpers for the daemon's `POST /api/asks` IPC route.
 *
 * Kept separate from daemon.ts so the body-validator is unit-testable without
 * spinning up an HTTP server, registering bots, or mounting a full session map.
 */

import type { AskOption, AskQuestion } from './ask-types.js';
import { isSupportedAskTimeoutMs } from './ask-limits.js';

export interface AskApiContextBody {
  sessionId: string;
  chatId: string;
  larkAppId: string;
  rootMessageId: string | null;
}

export interface AskApiPayloadBody {
  /** v0.1.8：替换旧的 options/prompt，支持多问多选。 */
  questions: AskQuestion[];
  /** Already in milliseconds. CLI side converts from `--timeout` seconds. */
  timeoutMs: number;
}

export interface AskApiOrdinaryBody extends AskApiContextBody, AskApiPayloadBody {
  /** Per-invocation identity (hook generates once, reuses across reconnect
   *  retries) so a re-POST after a daemon restart re-attaches to the same ask.
   *  Optional — legacy callers omit it and the broker synthesizes one. */
  requestId?: string;
  /** Deprecated ordinary-client hint kept only for rolling compatibility.
   *  The daemon may consult it when the authenticated route is `/api/asks`,
   *  but the endpoint path remains authoritative and S1 never accepts it. */
  deprecatedOriginKindHint?: 'explicit' | 'hook';
}

export interface AskApiS1ControllerBody extends AskApiPayloadBody {
  phase: 'binding' | 'execution';
  larkAppId: string;
  chatId: string;
  /** Dedicated S1-controller contract: absolute activation window. Ordinary
   *  asks omit these and rely on relative timeoutMs only. */
  requestId: string;
  notBeforeMs: number;
  expiresAtMs: number;
}

export interface AskApiS1ExecutionBody extends AskApiS1ControllerBody {
  phase: 'execution';
  sessionId: string;
  rootMessageId: string;
  originCapability?: string;
  originTurnId?: string;
  originDispatchAttempt?: number;
}

export type AskApiBody =
  | AskApiOrdinaryBody
  | AskApiS1ControllerBody
  | AskApiS1ExecutionBody;

export type AskOriginKind = 'explicit' | 'hook' | 's1-controller';

export interface AskPathClassification {
  originKind: AskOriginKind;
  recoverOnly: boolean;
}

export type AskRouteContractDecision =
  | { ok: true; deadlineAt: number; timeoutMs: number }
  | {
      ok: false;
      status: 400 | 409 | 410;
      error: 'unexpected_field' | 'bad_requestId' | 'bad_time_window' | 'ask_not_active' | 'recovery_expired';
    };

/** The authenticated endpoint, never request JSON, classifies an Ask's origin. */
export function askPathClassificationForPath(pathname: string): AskPathClassification | null {
  if (pathname === '/api/asks') return { originKind: 'explicit', recoverOnly: false };
  if (pathname === '/api/asks/hook') return { originKind: 'hook', recoverOnly: false };
  if (pathname === '/api/asks/s1-controller') {
    return { originKind: 's1-controller', recoverOnly: false };
  }
  if (pathname === '/api/asks/s1-controller/recover') {
    return { originKind: 's1-controller', recoverOnly: true };
  }
  return null;
}

export function askOriginKindForPath(pathname: string): AskOriginKind | null {
  return askPathClassificationForPath(pathname)?.originKind ?? null;
}

/** Enforce fields whose validity depends on the authenticated route. The
 * generic parser deliberately cannot infer whether absolute S1 timestamps are
 * authorized merely from their presence in caller JSON. */
export function validateAskRouteContract(
  body: AskApiBody,
  route: AskPathClassification,
  now = Date.now(),
): AskRouteContractDecision {
  if (route.originKind !== 's1-controller') {
    if ('notBeforeMs' in body || 'expiresAtMs' in body) {
      return { ok: false, status: 400, error: 'unexpected_field' };
    }
    return { ok: true, deadlineAt: now + body.timeoutMs, timeoutMs: body.timeoutMs };
  }
  if (!('requestId' in body) || typeof body.requestId !== 'string'
      || !/^[0-9a-f]{64}$/.test(body.requestId)) {
    return { ok: false, status: 400, error: 'bad_requestId' };
  }
  if (!('notBeforeMs' in body) || !('expiresAtMs' in body)
      || body.expiresAtMs - body.notBeforeMs !== body.timeoutMs) {
    return { ok: false, status: 400, error: 'bad_time_window' };
  }
  if (!route.recoverOnly && now < body.notBeforeMs) {
    return { ok: false, status: 409, error: 'ask_not_active' };
  }
  if (!route.recoverOnly && now >= body.expiresAtMs) {
    return { ok: false, status: 410, error: 'recovery_expired' };
  }
  return { ok: true, deadlineAt: body.expiresAtMs, timeoutMs: Math.max(0, body.expiresAtMs - now) };
}

export type AskApiBodyError =
  | 'bad_body'
  | 'bad_sessionId'
  | 'bad_chatId'
  | 'bad_larkAppId'
  | 'bad_rootMessageId'
  | 'bad_prompt'
  | 'bad_timeoutMs'
  | 'bad_options'
  | 'bad_option_shape'
  | 'bad_option_key'
  | 'bad_option_label'
  | 'duplicate_option_key'
  | 'bad_questions'
  | 'bad_question_shape'
  | 'bad_multiSelect'
  | 'bad_requestId'
  | 'bad_notBeforeMs'
  | 'bad_expiresAtMs'
  | 'bad_time_window'
  | 'bad_phase'
  | 'bad_origin_context'
  | 'bad_originKind'
  | 'unexpected_field';

function parseAbsoluteAskTimeMs(
  value: unknown,
  kind: 'bad_notBeforeMs' | 'bad_expiresAtMs',
): number | AskApiBodyError {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return kind;
  return value as number;
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every(key => allowedSet.has(key));
}

/** 校验单个 option 对象，返回解析后的 AskOption 或错误码。 */
function parseOption(
  o: unknown,
  options: { exact?: boolean } = {},
): AskOption | AskApiBodyError {
  if (!o || typeof o !== 'object') return 'bad_option_shape';
  const oo = o as Record<string, unknown>;
  if (options.exact && !hasOnlyKeys(oo, ['key', 'label'])) return 'unexpected_field';
  if (typeof oo.key !== 'string' || !oo.key.trim()) return 'bad_option_key';
  if (typeof oo.label !== 'string') return 'bad_option_label';
  return { key: oo.key, label: oo.label };
}

/** 校验 questions[] 数组，返回解析后的 AskQuestion[] 或错误码。 */
function parseQuestions(
  arr: unknown[],
  options: { exact?: boolean } = {},
): AskQuestion[] | AskApiBodyError {
  const result: AskQuestion[] = [];
  for (const q of arr) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return 'bad_question_shape';
    const qq = q as Record<string, unknown>;
    if (options.exact && !hasOnlyKeys(qq, ['prompt', 'multiSelect', 'options'])) {
      return 'unexpected_field';
    }
    if (typeof qq.prompt !== 'string' || !qq.prompt.trim()) return 'bad_question_shape';
    if (typeof qq.multiSelect !== 'boolean') return 'bad_multiSelect';
    if (!Array.isArray(qq.options) || qq.options.length < 2) return 'bad_options';
    const opts: AskOption[] = [];
    const seen = new Set<string>();
    for (const o of qq.options) {
      const parsed = parseOption(o, options);
      if (typeof parsed === 'string') return parsed;
      if (seen.has(parsed.key)) return 'duplicate_option_key';
      seen.add(parsed.key);
      opts.push(parsed);
    }
    result.push({ prompt: qq.prompt, multiSelect: qq.multiSelect, options: opts });
  }
  return result;
}

/** Validate the request body. Returns either the parsed body or an error code
 *  ready to be sent back as `{ ok: false, error }` with HTTP 400.
 *
 *  v0.1.8：
 *  - 优先识别 `questions[]` 新格式（多问多选）。
 *  - 兼容旧的 `options[]` + `prompt` 格式，归一化为单问单选的 questions[]。
 *  - 两者都没有则返回 `bad_options`。 */
export function parseAskBody(raw: unknown): AskApiBody | { error: AskApiBodyError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'bad_body' };
  const r = raw as Record<string, unknown>;
  // Closed schema at the public IPC boundary: route-owned identity/classification
  // fields must never be caller-controlled. The daemon derives ask origin from
  // the authenticated endpoint path and binds session/chat/root from the trusted
  // session capability where applicable.
  if (Object.hasOwn(r, 'askId')) return { error: 'unexpected_field' };

  if (typeof r.larkAppId !== 'string' || !r.larkAppId.trim()) return { error: 'bad_larkAppId' };
  if (!isSupportedAskTimeoutMs(r.timeoutMs)) {
    return { error: 'bad_timeoutMs' };
  }
  // Optional invocation identity. When present, must be a sane short string
  // (used verbatim as a persistence filename segment after sanitization).
  let requestId: string | undefined;
  if (r.requestId !== undefined) {
    if (typeof r.requestId !== 'string' || !r.requestId.trim() || r.requestId.length > 128) {
      return { error: 'bad_requestId' };
    }
    requestId = r.requestId;
  }
  let notBeforeMs: number | undefined;
  let expiresAtMs: number | undefined;
  if (r.notBeforeMs !== undefined || r.expiresAtMs !== undefined) {
    const parsedNotBefore = parseAbsoluteAskTimeMs(r.notBeforeMs, 'bad_notBeforeMs');
    if (typeof parsedNotBefore === 'string') return { error: parsedNotBefore };
    const parsedExpiresAt = parseAbsoluteAskTimeMs(r.expiresAtMs, 'bad_expiresAtMs');
    if (typeof parsedExpiresAt === 'string') return { error: parsedExpiresAt };
    if (parsedNotBefore >= parsedExpiresAt || parsedExpiresAt - parsedNotBefore > 86_400_000) {
      return { error: 'bad_time_window' };
    }
    notBeforeMs = parsedNotBefore;
    expiresAtMs = parsedExpiresAt;
  }
  const hasS1Timing = notBeforeMs !== undefined || expiresAtMs !== undefined;
  if (Object.hasOwn(r, 'originKind')) {
    if (hasS1Timing) return { error: 'unexpected_field' };
    if (r.originKind !== 'explicit' && r.originKind !== 'hook') {
      return { error: 'bad_originKind' };
    }
  }
  let questions: AskQuestion[];

  if (hasS1Timing) {
    if (Object.hasOwn(r, 'prompt') || Object.hasOwn(r, 'options')) {
      return { error: 'unexpected_field' };
    }
    if (!Array.isArray(r.questions)) return { error: 'bad_questions' };
    if (r.questions.length === 0) return { error: 'bad_questions' };
    const parsed = parseQuestions(r.questions, { exact: true });
    if (typeof parsed === 'string') return { error: parsed };
    questions = parsed;
  } else if (Array.isArray(r.questions)) {
    // 新格式：questions[] 多问多选
    if (r.questions.length === 0) return { error: 'bad_questions' };
    const parsed = parseQuestions(r.questions);
    if (typeof parsed === 'string') return { error: parsed };
    questions = parsed;
  } else if (Array.isArray(r.options) && typeof r.prompt === 'string' && r.prompt.trim()) {
    // 旧格式兼容：options[] + prompt → 归一化为单问单选
    if (r.options.length < 2) return { error: 'bad_options' };
    const opts: AskOption[] = [];
    const seen = new Set<string>();
    for (const o of r.options) {
      const parsed = parseOption(o);
      if (typeof parsed === 'string') return { error: parsed };
      if (seen.has(parsed.key)) return { error: 'duplicate_option_key' };
      seen.add(parsed.key);
      opts.push(parsed);
    }
    questions = [{ prompt: r.prompt, multiSelect: false, options: opts }];
  } else {
    // 旧格式：仅有 prompt 校验（无 options 或 options 不合法）
    if (typeof r.prompt !== 'string' || !r.prompt.trim()) return { error: 'bad_prompt' };
    if (!Array.isArray(r.options) || r.options.length < 2) return { error: 'bad_options' };
    // 走到这里说明 options 是数组但长度不足，上面已处理，此处不可达
    return { error: 'bad_options' };
  }

  if (hasS1Timing) {
    if (r.phase !== 'binding' && r.phase !== 'execution') return { error: 'bad_phase' };
    if (typeof r.chatId !== 'string' || !r.chatId.trim()) return { error: 'bad_chatId' };
    const hasSession = Object.hasOwn(r, 'sessionId');
    const hasRoot = Object.hasOwn(r, 'rootMessageId');
    const hasOriginCapability = Object.hasOwn(r, 'originCapability');
    const hasOriginTurnId = Object.hasOwn(r, 'originTurnId');
    const hasOriginDispatchAttempt = Object.hasOwn(r, 'originDispatchAttempt');
    if (r.phase === 'binding' && (hasSession || hasRoot
        || hasOriginCapability
        || hasOriginTurnId
        || hasOriginDispatchAttempt)) {
      return { error: 'bad_origin_context' };
    }
    if (r.phase === 'execution' && (hasSession !== hasRoot
        || !hasSession || !hasRoot
        || typeof r.sessionId !== 'string' || !r.sessionId.trim()
        || typeof r.rootMessageId !== 'string' || !r.rootMessageId.trim())) {
      return { error: 'bad_origin_context' };
    }
    if (hasOriginTurnId
        && (r.phase !== 'execution' || typeof r.originTurnId !== 'string' || !r.originTurnId.trim())) {
      return { error: 'bad_origin_context' };
    }
    if (hasOriginDispatchAttempt
        && (r.phase !== 'execution' || !Number.isSafeInteger(r.originDispatchAttempt)
          || (r.originDispatchAttempt as number) < 1)) {
      return { error: 'bad_origin_context' };
    }
    if (hasOriginCapability
        && (r.phase !== 'execution'
          || typeof r.originCapability !== 'string'
          || !r.originCapability.trim())) {
      return { error: 'bad_origin_context' };
    }
    const allowedKeys = r.phase === 'execution'
      ? [
          'phase',
          'larkAppId',
          'chatId',
          'sessionId',
          'rootMessageId',
          'originCapability',
          'originTurnId',
          'originDispatchAttempt',
          'questions',
          'timeoutMs',
          'requestId',
          'notBeforeMs',
          'expiresAtMs',
        ] as const
      : [
          'phase',
          'larkAppId',
          'chatId',
          'questions',
          'timeoutMs',
          'requestId',
          'notBeforeMs',
          'expiresAtMs',
        ] as const;
    if (!hasOnlyKeys(r, allowedKeys)) return { error: 'unexpected_field' };
    if (!requestId) return { error: 'bad_requestId' };
    return {
      phase: r.phase,
      larkAppId: r.larkAppId,
      chatId: r.chatId,
      ...(r.phase === 'execution'
        ? {
            sessionId: r.sessionId as string,
            rootMessageId: r.rootMessageId as string,
            ...(hasOriginCapability ? { originCapability: r.originCapability as string } : {}),
            ...(hasOriginTurnId ? { originTurnId: r.originTurnId as string } : {}),
            ...(hasOriginDispatchAttempt
              ? { originDispatchAttempt: r.originDispatchAttempt as number }
              : {}),
          }
        : {}),
      questions,
      timeoutMs: r.timeoutMs,
      requestId,
      notBeforeMs: notBeforeMs!,
      expiresAtMs: expiresAtMs!,
    };
  }

  if (typeof r.sessionId !== 'string' || !r.sessionId.trim()) return { error: 'bad_sessionId' };
  if (typeof r.chatId !== 'string' || !r.chatId.trim()) return { error: 'bad_chatId' };
  if (r.rootMessageId !== null && typeof r.rootMessageId !== 'string') {
    return { error: 'bad_rootMessageId' };
  }
  return {
    sessionId: r.sessionId,
    chatId: r.chatId,
    larkAppId: r.larkAppId,
    rootMessageId: r.rootMessageId as string | null,
    questions,
    timeoutMs: r.timeoutMs,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(Object.hasOwn(r, 'originKind')
      ? { deprecatedOriginKindHint: r.originKind as 'explicit' | 'hook' }
      : {}),
  };
}
