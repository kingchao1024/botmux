import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { dashboardEventBus } from '../core/dashboard-events.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { fsyncDirectorySyncPortable } from '../utils/fs-durability.js';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import type { RunRecord, ScheduledTask, ParsedSchedule, ScheduleExecutionPosition } from '../types.js';

/** Reasoning levels a task may pin. Mirrors CODEX_REASONING_EFFORTS; spelled out
 *  here because this module is the storage layer and must not depend on the CLI
 *  adapter services. */
export type ScheduleReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

const SCHEDULE_REASONING_EFFORTS: readonly ScheduleReasoningEffort[] = [
  'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
];

export function isScheduleReasoningEffort(value: unknown): value is ScheduleReasoningEffort {
  return typeof value === 'string'
    && SCHEDULE_REASONING_EFFORTS.includes(value as ScheduleReasoningEffort);
}

/**
 * Line-separator regex matching LF, CR, CRLF, U+2028 (line separator),
 * and U+2029 (paragraph separator).  Applied FIRST so credential patterns
 * that span lines are already split before we scan for secrets.
 */
const LINE_SEPARATOR_RE = /\r\n|\n|\r|\u2028|\u2029/;

/**
 * Bounded scanner that redacts credential values from a terminal error line.
 *
 * For each credential keyword encountered in the string:
 *  - If the value starts with a quote (\" or '), the scanner advances past
 *    backslash-escaped characters until the matching close quote, then
 *    replaces everything between (and including) the quotes.
 *  - If the value is unquoted, it matches the next contiguous non-whitespace
 *    token (\\S+) and replaces it.
 *
 * URL credentials (https://user:pass@host) are handled separately.
 */
function isPlainFieldStartAfter(line: string, pos: number): boolean {
  const tail = line.slice(pos);
  return /^\s+[A-Za-z][A-Za-z0-9_-]*\s*(?:=(?!=)|:)/.test(tail);
}

function consumeCredentialValue(input: string, start: number, slashRun?: number, expectedQuote = '"'): number {
  // Callers which already consumed a JSON wrapper (Authorization/Basic/Bearer
  // schemes) still carry its slash run.  Scan to that same-layer close rather
  // than treating the first word of a multi-word credential as unquoted.
  if (slashRun !== undefined) {
    for (let pos = start; pos < input.length; pos++) {
      if (input[pos] !== expectedQuote) continue;
      let preceding = 0;
      for (let i = pos - 1; i >= start && input[i] === '\\'; i--) preceding++;
      const tail = input.slice(pos + 1).trimStart();
      if (preceding === slashRun && (!tail || ',;|&)}]'.includes(tail[0]) || isPlainFieldStartAfter(input, pos + 1))) return pos + 1;
    }
  }
  const wrapper = input.slice(start).match(/^(\\*)["']/);
  if (wrapper) {
    const expectedRun = slashRun ?? wrapper[1].length;
    const quote = wrapper[0].at(-1)!;
    for (let pos = start + wrapper[0].length; pos < input.length; pos++) {
      if (input[pos] !== quote) continue;
      let preceding = 0;
      for (let i = pos - 1; i >= start && input[i] === '\\'; i--) preceding++;
      if (preceding === expectedRun) return pos + 1;
    }
  }
  // A truncated wrapper is bounded at the next structural delimiter.  This
  // remains fail-closed for the value without consuming adjacent context.
  for (let pos = start; pos < input.length; pos++) {
    if (/\s|[,;}\]]/.test(input[pos])) return pos;
  }
  return input.length;
}

/** A named secret must start in a field key, not inside an already-assigned value. */
function isCredentialKeyPosition(input: string, start: number): boolean {
  let fieldStart = 0;
  let quote: { char: string; slashRun: number } | undefined;
  let slashRun = 0;
  for (let pos = 0; pos < start; pos++) {
    const char = input[pos];
    if (char === '\\') {
      slashRun++;
      continue;
    }
    if (char === '"' || char === "'") {
      if (quote?.char === char && quote.slashRun === slashRun) quote = undefined;
      else if (!quote) quote = { char, slashRun };
    } else if (!quote && ',;|&([{'.includes(char)) {
      fieldStart = pos + 1;
    }
    slashRun = 0;
  }
  const prefix = input.slice(fieldStart, start);
  const assignment = Math.max(prefix.lastIndexOf('='), prefix.lastIndexOf(':'));
  if (assignment < 0) return true;

  if (prefix[assignment] === '=') return false;
  const beforeAssignment = prefix.slice(0, assignment).trimEnd();
  const afterAssignment = prefix.slice(assignment + 1);
  // JSON (including escaped JSON) wraps a field value in quotes.  Plain
  // message/status/detail assignments are also value positions even if the
  // value happens to look like a sensitive key name.
  if (afterAssignment.includes('"') || beforeAssignment.endsWith('\\"')) return false;
  const fieldName = beforeAssignment.match(/([A-Za-z][A-Za-z0-9_-]*)$/)?.[1]?.toLowerCase();
  return !['message', 'status', 'detail'].includes(fieldName ?? '');
}

function hasCredentialKeyPrefix(input: string, start: number): boolean {
  return start > 0 && /[A-Za-z0-9_-]/.test(input[start - 1]);
}

interface CredentialRedaction {
  start: number;
  end: number;
  replacement: string;
}

interface QuotedSpan {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

interface StructuredQuotedField {
  key: string;
  keySpan: QuotedSpan;
  valueSpan: QuotedSpan;
}

interface PlainField {
  key: string;
  keyStart: number;
  valueStart: number;
}

interface ParsedField {
  key: string;
  keyStart: number;
  valueStart: number;
  nextFieldStart: number;
}

function isPrimarySeparatorAt(line: string, pos: number): boolean {
  let keyStart = pos;
  while (keyStart > 0 && /[A-Za-z0-9_-]/.test(line[keyStart - 1])) keyStart--;
  return keyStart === 0 || ',;|&({'.includes(line[keyStart - 1]);
}

function keyBeforePrimarySeparator(line: string, pos: number): string | undefined {
  if (!isPrimarySeparatorAt(line, pos)) return undefined;
  let keyStart = pos;
  while (keyStart > 0 && /[A-Za-z0-9_-]/.test(line[keyStart - 1])) keyStart--;
  return line.slice(keyStart, pos).toLowerCase();
}

/** Scan the original line once, keeping quote style and escape layer together. */
function collectQuotedSpans(line: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  let active: { start: number; quoteAt: number; char: string; slashRun: number } | undefined;
  let slashRun = 0;
  for (let pos = 0; pos < line.length; pos++) {
    const char = line[pos];
    if (char === '\\') {
      slashRun++;
      continue;
    }
    if (char === '"' || char === "'") {
      const tail = line.slice(pos + 1).trimStart();
      const structuralClose = !tail || ':,;|&)}]'.includes(tail[0]);
      const schemeBoundary = /^\s+(?:basic|bearer)\s+/i.test(line.slice(pos + 1));
      if (active?.char === char && active.slashRun === slashRun
        && (structuralClose || schemeBoundary || isPlainFieldStartAfter(line, pos + 1))) {
        spans.push({ start: active.start, end: pos + 1, contentStart: active.quoteAt + 1, contentEnd: pos - slashRun });
        active = undefined;
      } else if (!active) {
        active = { start: pos - slashRun, quoteAt: pos, char, slashRun };
      }
    }
    slashRun = 0;
  }
  return spans;
}

function collectPlainFields(line: string, spans: readonly QuotedSpan[]): PlainField[] {
  const starts = new Set<number>([0]);
  const insideQuotedSpan = (index: number): boolean => spans.some(span => index >= span.start && index < span.end);
  for (let pos = 0; pos < line.length; pos++) {
    if (',;|&({'.includes(line[pos])) starts.add(pos + 1);
    if (!/\s/.test(line[pos]) || insideQuotedSpan(pos)) continue;
    let previous = pos - 1;
    while (previous >= 0 && /\s/.test(line[previous])) previous--;
    // Whitespace immediately after a field's assignment belongs to its value;
    // it is not evidence of a second field start.
    const parentKey = line[previous] === '=' || line[previous] === ':'
      ? keyBeforePrimarySeparator(line, previous)
      : undefined;
    if (parentKey && ['message', 'status', 'detail'].includes(parentKey)) continue;
    let next = pos;
    while (/\s/.test(line[next] ?? '')) next++;
    if (!insideQuotedSpan(next) && /^[A-Za-z][A-Za-z0-9_-]*\s*(?:=(?!=)|:)/.test(line.slice(next))) {
      starts.add(next);
    }
  }
  for (const span of spans) {
    starts.add(span.contentStart);
    let pos = span.end;
    while (/\s/.test(line[pos] ?? '')) pos++;
    if (pos > span.end) starts.add(pos);
  }
  const fields: PlainField[] = [];
  for (const start of starts) {
    let pos = start;
    while (/\s/.test(line[pos] ?? '')) pos++;
    const match = line.slice(pos).match(/^([A-Za-z][A-Za-z0-9_-]*)\s*(?:=(?!=)|:)\s*/);
    if (match) fields.push({ key: match[1].toLowerCase(), keyStart: pos, valueStart: pos + match[0].length });
  }
  return fields;
}

function collectStructuredQuotedFields(line: string, spans: readonly QuotedSpan[]): StructuredQuotedField[] {
  const byStart = new Map(spans.map(span => [span.start, span]));
  const fields: StructuredQuotedField[] = [];
  for (const keySpan of spans) {
    let pos = keySpan.end;
    while (/\s/.test(line[pos] ?? '')) pos++;
    if (line[pos] !== ':') continue;
    pos++;
    while (/\s/.test(line[pos] ?? '')) pos++;
    const valueSpan = byStart.get(pos);
    if (!valueSpan) continue;
    fields.push({ key: line.slice(keySpan.contentStart, keySpan.contentEnd).toLowerCase(), keySpan, valueSpan });
  }
  return fields;
}

function tokenizeFields(
  structured: readonly StructuredQuotedField[],
  plain: readonly PlainField[],
): ParsedField[] {
  const tokens = [
    ...structured.map(field => ({ key: field.key, keyStart: field.keySpan.contentStart, valueStart: field.valueSpan.start })),
    ...plain,
  ].sort((a, b) => a.keyStart - b.keyStart);
  return tokens.map((token, index) => ({ ...token, nextFieldStart: tokens[index + 1]?.keyStart ?? Number.POSITIVE_INFINITY }));
}

function collectProtectedValueRanges(
  line: string,
  fields: readonly StructuredQuotedField[],
  plainFields: readonly PlainField[],
  spans: readonly QuotedSpan[],
): Array<[number, number]> {
  const protectedRanges = fields
    .filter(field => ['message', 'status', 'detail'].includes(field.key))
    .map(field => [field.valueSpan.start, field.valueSpan.end] as [number, number]);
  const byStart = new Map(spans.map(span => [span.start, span]));
  for (const field of plainFields) {
    if (!['message', 'status', 'detail'].includes(field.key)) continue;
    const quoted = byStart.get(field.valueStart);
    if (quoted) {
      protectedRanges.push([quoted.start, quoted.end]);
      continue;
    }
    const nextField = plainFields
      .filter(next => next.keyStart > field.valueStart)
      .map(next => next.keyStart)
      .sort((a, b) => a - b)[0];
    let end = nextField ?? line.length;
    for (let pos = field.valueStart; pos < end; pos++) {
      if (',;|&)}]'.includes(line[pos])) { end = pos; break; }
    }
    protectedRanges.push([field.valueStart, end]);
  }
  return protectedRanges;
}

function isInsideRanges(index: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function applyCredentialRedactions(line: string, redactions: CredentialRedaction[]): string {
  const ordered = redactions.sort((a, b) => a.start - b.start || b.end - a.end);
  let offset = 0;
  let result = '';
  for (const redaction of ordered) {
    if (redaction.start < offset) continue;
    result += line.slice(offset, redaction.start) + redaction.replacement;
    offset = redaction.end;
  }
  return result + line.slice(offset);
}

function collectAuthorizationRedactions(
  line: string,
  fields: readonly ParsedField[],
  redactions: CredentialRedaction[],
): void {
  for (const [index, field] of fields.entries()) {
    const rawValue = line.slice(field.valueStart);
    const wrapper = rawValue.match(/^(\\*)["']/);
    const schemeStart = field.valueStart + (wrapper?.[0].length ?? 0);
    const schemeMatch = line.slice(schemeStart).match(/^(basic|bearer)\s+/i);
    const scheme = schemeMatch?.[1];
    if (!scheme) continue;
    let end: number;
    if (wrapper) {
      end = consumeCredentialValue(line, field.valueStart, wrapper[1].length, wrapper[0].at(-1)!);
    } else {
      // Basic/Bearer plain credentials are one opaque token. The token's
      // trailing `=`/`==` is padding, not a field separator; only the next
      // whitespace-delimited field can begin a new token.
      end = schemeStart + schemeMatch![0].length;
      while (end < line.length && !/\s/.test(line[end])) end++;
    }
    while (end > schemeStart && /\s/.test(line[end - 1])) end--;
    const normalized = `${scheme[0].toUpperCase()}${scheme.slice(1).toLowerCase()}`;
    redactions.push({
      start: field.key === 'authorization' ? field.keyStart : field.valueStart,
      end,
      replacement: field.key === 'authorization' ? `Authorization: ${normalized} [redacted]` : `${normalized} [redacted]`,
    });
  }
}

function redactCredentialsLine(line: string): string {
  interface CredentialScanner {
    /** Keyword pattern to locate.  Matched case-insensitively. */
    keyword: RegExp;
    /** Replacement text for the keyword + value portion. */
    replacement: string;
    /** Whether the keyword expects a value after [=:\\s]* (set to false for URL). */
    hasValue: boolean;
    /** Bare schemes use whitespace; named credential keys require = or :. */
    allowWhitespace?: boolean;
  }

  const scanners: CredentialScanner[] = [
    { keyword: /\baws_secret_access_key\b/gi, replacement: 'AWS_SECRET_ACCESS_KEY=[redacted]', hasValue: true },
    { keyword: /password\b/gi, replacement: 'password=[redacted]', hasValue: true },
    { keyword: /\bbearer\b(?!\s*\[redacted\])/gi, replacement: 'Bearer [redacted]', hasValue: true, allowWhitespace: true },
    { keyword: /\baccess_token\b/gi, replacement: 'access_token=[redacted]', hasValue: true },
    { keyword: /\brefresh_token\b/gi, replacement: 'refresh_token=[redacted]', hasValue: true },
    { keyword: /\bclient_secret\b/gi, replacement: 'client_secret=[redacted]', hasValue: true },
    { keyword: /\baccessToken\b/g, replacement: 'accessToken=[redacted]', hasValue: true },
    { keyword: /\brefreshToken\b/g, replacement: 'refreshToken=[redacted]', hasValue: true },
    { keyword: /\bclientSecret\b/g, replacement: 'clientSecret=[redacted]', hasValue: true },
    { keyword: /api[_-]?key\b/gi, replacement: 'api_key=[redacted]', hasValue: true },
    { keyword: /token\b/gi, replacement: 'token=[redacted]', hasValue: true },
    { keyword: /secret[_-]?(?:key)?\b/gi, replacement: 'secret=[redacted]', hasValue: true },
    // URL credentials: https://user:pass@host
    { keyword: /\/\/[^/\s@:]+:[^/\s@]+@/g, replacement: '//[redacted]@', hasValue: false },
  ];

  const redactions: CredentialRedaction[] = [];
  const spans = collectQuotedSpans(line);
  const fields = collectStructuredQuotedFields(line, spans);
  const plainFields = collectPlainFields(line, spans);
  const fieldTokens = tokenizeFields(fields, plainFields);
  const protectedRanges = collectProtectedValueRanges(line, fields, plainFields, spans);
  const fieldByKeyStart = new Map(fieldTokens.map(field => [field.keyStart, field]));
  collectAuthorizationRedactions(line, fieldTokens, redactions);

  for (const { keyword, replacement, hasValue, allowWhitespace } of scanners) {
    if (!hasValue) {
      let match: RegExpExecArray | null;
      keyword.lastIndex = 0;
      while ((match = keyword.exec(line)) !== null) {
        redactions.push({ start: match.index, end: keyword.lastIndex, replacement });
      }
      continue;
    }

    // Each family scans the immutable source. Applying one family's replacement
    // first can otherwise move or remove wrapper quotes before the next family
    // decides where its value ends.
    keyword.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = keyword.exec(line)) !== null) {
      const afterKw = line.slice(match.index + match[0].length);

      let tokenStart = match.index;
      while (tokenStart > 0 && /[A-Za-z0-9_-]/.test(line[tokenStart - 1])) tokenStart--;
      const parsedField = fieldByKeyStart.get(tokenStart);
      if (!allowWhitespace && (isInsideRanges(match.index, protectedRanges)
        || (!parsedField && hasCredentialKeyPrefix(line, match.index)
          && !isCredentialKeyPosition(line, match.index)))) {
        continue;
      }

      if (parsedField) {
        const end = Math.min(parsedField.nextFieldStart, line.length);
        redactions.push({ start: tokenStart, end, replacement });
        keyword.lastIndex = end;
        continue;
      }

      const whitespace = afterKw.match(/^\s+/)?.[0];
      if (!allowWhitespace || !whitespace) continue;
      const value = afterKw.slice(whitespace.length);
      const end = match.index + match[0].length + whitespace.length + consumeCredentialValue(value, 0);
      redactions.push({ start: match.index, end, replacement });
      keyword.lastIndex = end;
    }
  }

  return applyCredentialRedactions(line, redactions);
}

/**
 * Sanitise a terminal error for persistent storage.
 *
 * Processing order:
 * 1. Split on all line separators (LF, CR, CRLF, U+2028, U+2029) and take the
 *    first non-empty line.
 * 2. Redact credential values via bounded scanner (password, token, Bearer,
 *    api_key, secret, URL credentials).
 * 3. Cap at 500 characters.
 *
 * Returns undefined when the input is empty or produces an empty result after
 * trimming.
 */
function sanitiseTerminalError(error?: string): string | undefined {
  if (!error) return undefined;
  // Take the first non-empty line (not just the first split result which may
  // be empty if the input starts with a line separator).
  const firstLine = error.split(LINE_SEPARATOR_RE).find(line => line.trim())?.trim();
  if (!firstLine) return undefined;
  const sanitised = redactCredentialsLine(firstLine);
  return sanitised.length > 500 ? sanitised.slice(0, 497) + '...' : sanitised;
}

/**
 * Validate and sanitise a lastRunSettledErrors record during deserialization.
 * Each value is passed through sanitiseTerminalError.
 */
function sanitiseErrorRecord(raw: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let hasEntry = false;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k) continue;
    const sanitised = sanitiseTerminalError(typeof v === 'string' ? v : undefined);
    if (sanitised) {
      out[k] = sanitised;
      hasEntry = true;
    }
  }
  return hasEntry ? out : undefined;
}

/**
 * Validate a record of string→string during deserialization.
 */
function stringRecord(raw: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let hasEntry = false;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k) continue;
    if (typeof v === 'string' && v.trim()) {
      out[k] = v.trim();
      hasEntry = true;
    }
  }
  return hasEntry ? out : undefined;
}

/** Bound historic run state without dropping a source that can still recover. */
function pruneSettledRunRecords(task: ScheduledTask): void {
  if (!task.runRecords) return;
  for (const [runId, record] of Object.entries(task.runRecords)) {
    if (runId === task.lastRunId) continue;
    const bindings = Object.keys(record.turnBindings ?? {});
    const errors = Object.keys(record.perTargetErrors ?? {});
    // A dispatch-failed target never gained a worker turn and can never own
    // ordinary recovery. Its synthetic source must not pin history forever.
    if (bindings.length > 0 && errors.length > 0
      && bindings.every(id => id.startsWith('dispatch-failed:'))
      && errors.every(id => id.startsWith('dispatch-failed:'))) {
      delete task.runRecords[runId];
      continue;
    }
    if (bindings.length > 0) continue;
    if (errors.length > 0) continue;
    delete task.runRecords[runId];
  }
  if (Object.keys(task.runRecords).length === 0) delete task.runRecords;
}

// ─── Per-run record deserialization ────────────────────────────────────

/**
 * Deserialize runRecords from raw JSON or migrate legacy per-run fields.
 * New format: raw.runRecords is a Record<string, RunRecord>.
 * Legacy migration: if raw.lastRunTargetCount / lastRunSettledCount /
 * lastRunSettledErrors / lastRunTurnBindings exist and lastRunId is set,
 * construct a single RunRecord from them.
 */
function deserializeRunRecords(
  raw: Record<string, unknown>,
): Record<string, RunRecord> | undefined {
  // New format first
  const rawRecords = raw.runRecords;
  if (rawRecords && typeof rawRecords === 'object' && !Array.isArray(rawRecords)) {
    const out: Record<string, RunRecord> = {};
    for (const [runId, v] of Object.entries(rawRecords as Record<string, unknown>)) {
      if (!runId || typeof v !== 'object' || v === null) continue;
      const rec = v as Record<string, unknown>;
      const targetCount = typeof rec.targetCount === 'number' && rec.targetCount > 0
        ? rec.targetCount : 0;
      const settledTurnIds = Array.isArray(rec.settledTurnIds)
        ? rec.settledTurnIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        : [];
      const perTargetErrors = rec.perTargetErrors && typeof rec.perTargetErrors === 'object'
        && !Array.isArray(rec.perTargetErrors)
        ? sanitiseErrorRecord(rec.perTargetErrors as Record<string, unknown>) ?? {}
        : {};
      const turnBindings = rec.turnBindings && typeof rec.turnBindings === 'object'
        && !Array.isArray(rec.turnBindings)
        ? stringRecord(rec.turnBindings as Record<string, unknown>) ?? {}
        : {};
      const recoveryAttempts = rec.recoveryAttempts && typeof rec.recoveryAttempts === 'object'
        && !Array.isArray(rec.recoveryAttempts)
        ? stringRecord(rec.recoveryAttempts as Record<string, unknown>)
        : undefined;
      if (targetCount > 0 || settledTurnIds.length > 0 || Object.keys(perTargetErrors).length > 0 || Object.keys(turnBindings).length > 0) {
        out[runId] = { targetCount, settledTurnIds, perTargetErrors, turnBindings, ...(recoveryAttempts ? { recoveryAttempts } : {}) };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  // Legacy migration: build from old per-run task-level fields
  const lastRunId = typeof raw.lastRunId === 'string' && raw.lastRunId.trim()
    ? raw.lastRunId.trim() : undefined;
  if (!lastRunId) return undefined;

  const targetCount = typeof raw.lastRunTargetCount === 'number' && raw.lastRunTargetCount > 0
    ? raw.lastRunTargetCount : 0;
  if (targetCount <= 0) return undefined;

  const perTargetErrors = raw.lastRunSettledErrors && typeof raw.lastRunSettledErrors === 'object'
    && !Array.isArray(raw.lastRunSettledErrors)
    ? sanitiseErrorRecord(raw.lastRunSettledErrors as Record<string, unknown>) ?? {}
    : {};
  const turnBindings = raw.lastRunTurnBindings && typeof raw.lastRunTurnBindings === 'object'
    && !Array.isArray(raw.lastRunTurnBindings)
    ? stringRecord(raw.lastRunTurnBindings as Record<string, unknown>) ?? {}
    : {};

  // Legacy didn't track individual settled turnIds; treat all targets as settled
  // if settledCount >= targetCount (conservative).
  const settledCount = typeof raw.lastRunSettledCount === 'number' && raw.lastRunSettledCount >= 0
    ? raw.lastRunSettledCount : 0;
  const allKeys = new Set<string>();
  for (const k of Object.keys(perTargetErrors)) allKeys.add(k);
  for (const k of Object.keys(turnBindings)) allKeys.add(k);
  // Fill remaining slots with synthetic ids to reach settledCount
  const settledTurnIds: string[] = [...allKeys];
  while (settledTurnIds.length < settledCount && settledTurnIds.length < targetCount) {
    settledTurnIds.push(`legacy:${lastRunId}:${settledTurnIds.length}`);
  }
  // Truncate to targetCount
  const finalSettled = settledTurnIds.slice(0, targetCount);

  return {
    [lastRunId]: { targetCount, settledTurnIds: finalSettled, perTargetErrors, turnBindings },
  };
}

// ─── Idempotency types (events doc v0.1.2 §2.2) ─────────────────────────────

/**
 * Raised by `createTask` when an `id` is supplied but a task already exists
 * with that id AND its canonical input differs from the incoming params.
 *
 * Workflow runtime uses this to detect "same attempt asked to create a
 * different schedule" — a sign the attempt is being mutated (forbidden by
 * attempt-immutability rule, events doc §4.2).
 */
export class IdempotencyConflictError extends Error {
  readonly taskId: string;
  readonly existingInputHash: string;
  readonly incomingInputHash: string;
  constructor(detail: {
    taskId: string;
    existingInputHash: string;
    incomingInputHash: string;
  }) {
    super(
      `IdempotencyConflict: schedule task ${detail.taskId} exists with different canonical input ` +
        `(existing=${detail.existingInputHash.substring(0, 18)}…, incoming=${detail.incomingInputHash.substring(0, 18)}…)`,
    );
    this.name = 'IdempotencyConflictError';
    this.taskId = detail.taskId;
    this.existingInputHash = detail.existingInputHash;
    this.incomingInputHash = detail.incomingInputHash;
  }
}

/**
 * Canonical schedule input used for create-or-return-identical comparison.
 *
 * Includes only the fields that callers control as task **input** (events
 * doc v0.1.2 §3.5 ScheduleCanonicalInput).  Excludes:
 *   - `creator*` (audit metadata, not input)
 *   - `enabled`, `nextRunAt`, `lastRunAt`, `lastStatus`, `lastRunId`, `lastError`,
 *     `lastDeliveryError` (runtime state, mutates over task lifetime)
 *   - `createdAt` (metadata)
 *   - `repeat.completed` (counter, mutates per run)
 *   - `parsed.display` (UI-facing string, redundant given `expr`/`runAt`)
 *
 * Codex round 4 finding 4: `parsed` is NOT purely derived for one-shot or
 * relative schedules.  `30m`/`2h`/`明天9:00`/`5分钟后` etc compute a
 * concrete `runAt` at parse time using "now"; if a workflow retry re-
 * parses the same raw `schedule`, it gets a different `runAt`.  So the
 * canonical input freezes the resolved schedule shape (`parsed.kind` and
 * whichever of `parsed.runAt`/`parsed.minutes`/`parsed.expr` applies).
 */
export function canonicalScheduleInput(t: {
  name: string;
  schedule: string;
  parsed?: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  chatIds?: readonly string[];
  chatType?: 'group' | 'p2p' | 'topic_group';
  rootMessageId?: string;
  scope?: 'thread' | 'chat';
  executionPosition?: ScheduleExecutionPosition;
  topicTitle?: string;
  larkAppId?: string;
  repeat?: { times: number | null; completed?: number };
  deliver?: 'origin' | 'local' | 'new-topic';
  silent?: boolean;
  followActive?: boolean;
  model?: string;
  reasoningEffort?: ScheduleReasoningEffort;
  /** Human creator whose scheduled turns authenticate workflow commands (see
   *  scheduled-turn-provenance). Part of canonical input: the same workflow
   *  attempt run as a different creator is a different schedule. */
  ownerOpenId?: string;
  ownerUnionId?: string;
}): unknown {
  const targets = normalizeScheduleChatTargets({ chatId: t.chatId, chatIds: t.chatIds });
  return {
    name: t.name,
    schedule: t.schedule,
    parsed: t.parsed
      ? {
          kind: t.parsed.kind,
          // Only one of these is present per parsed.kind, but inlining all
          // three keeps the canonical shape uniform — `undefined` slots are
          // dropped by `computeInputHash` upstream.
          runAt: t.parsed.runAt,
          minutes: t.parsed.minutes,
          expr: t.parsed.expr,
        }
      : undefined,
    prompt: t.prompt,
    workingDir: t.workingDir,
    chatId: targets.chatId,
    // Keep this absent for old and single-chat tasks. `computeInputHash`
    // drops the undefined property, preserving their historical canonical
    // JSON and hash byte-for-byte; multi-chat routing remains canonical input.
    chatIds: targets.chatIds,
    // This changes how the future worker session replies (especially P2P), so
    // it is provider input rather than advisory display metadata.
    chatType: t.chatType,
    rootMessageId: t.rootMessageId,
    scope: t.scope,
    executionPosition: t.executionPosition,
    topicTitle: t.topicTitle,
    larkAppId: t.larkAppId,
    // Strip `completed` — it mutates after the task starts running, but
    // `times` is the durable user intent.
    repeat: t.repeat ? { times: t.repeat.times } : undefined,
    deliver: t.deliver === 'local' ? 'local' : 'origin',
    // `silent: false`/absent normalizes to undefined (dropped by
    // computeInputHash) so pre-existing tasks keep their canonical hash.
    silent: t.silent === true ? true : undefined,
    followActive: t.followActive === true ? true : undefined,
    // Which model this task's runs ask for is caller input, not runtime state.
    // Absent on every pre-existing task, so `computeInputHash` drops both slots
    // and their canonical JSON stays byte-for-byte what it was.
    model: t.model?.trim() || undefined,
    reasoningEffort: t.reasoningEffort,
    // Absent/blank on every pre-existing and ownerless task, so the undefined
    // slot is dropped by computeInputHash and their canonical JSON is
    // byte-for-byte unchanged.
    ownerOpenId: t.ownerOpenId?.trim() || undefined,
    ownerUnionId: t.ownerUnionId?.trim() || undefined,
  };
}

export interface ScheduleChatTargets {
  chatId: string;
  chatIds?: string[];
}

/** Normalize caller-controlled schedule targets without changing the legacy
 * single-chat storage shape. When `chatIds` is supplied it is authoritative:
 * values are trimmed and deduplicated in order, and its first entry becomes
 * the compatibility `chatId`. `null` explicitly collapses an update to its
 * supplied/fallback `chatId`. */
export function normalizeScheduleChatTargets(input: {
  chatId: string;
  chatIds?: readonly string[] | null;
}): ScheduleChatTargets {
  if (input.chatIds === undefined || input.chatIds === null) {
    if (typeof input.chatId !== 'string' || !input.chatId.trim()) {
      throw new TypeError('chat_id_required');
    }
    return { chatId: input.chatId.trim() };
  }

  if (!Array.isArray(input.chatIds)) throw new TypeError('invalid_chat_ids');
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.chatIds) {
    if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('invalid_chat_ids');
    const chatId = raw.trim();
    if (seen.has(chatId)) continue;
    seen.add(chatId);
    unique.push(chatId);
  }
  if (unique.length === 0) throw new TypeError('chat_id_required');
  return unique.length === 1
    ? { chatId: unique[0] }
    : { chatId: unique[0], chatIds: unique };
}

/** Effective dispatch targets for both legacy/single-chat and multi-chat rows. */
export function effectiveScheduleChatIds(
  task: Pick<ScheduledTask, 'chatId' | 'chatIds'>,
): string[] {
  const targets = normalizeScheduleChatTargets({ chatId: task.chatId, chatIds: task.chatIds });
  return targets.chatIds ? [...targets.chatIds] : [targets.chatId];
}

// ─── Per-bot store scope ─────────────────────────────────────────────────────
//
// Schedules are stored PER BOT inside each bot's BOT_HOME
// (`<botmuxHome>/bots/<appId>/schedules.json`) instead of one shared
// `data/schedules.json`. Why: the bot's own BOT_HOME is already readWrite
// inside the file sandbox while sibling BOT_HOMEs are denied by construction —
// so a sandboxed `botmux schedule add` can take the RMW sibling lock
// (`schedules.json.lock`) on BOTH platforms without any policy special-case,
// and one bot's task prompts/routing are no longer readable by every other
// sandboxed bot (the leak the old shared-file grant had to accept).
//
// Callers bind the store to one bot before use: the daemon binds its own bot
// at startup, the CLI binds the session's bot (or an explicit --lark-app-id).
// Cross-bot reads/writes stay possible for UNsandboxed callers via the
// explicit-appId variants below; inside a sandbox they fail closed (EPERM).

interface FileState {
  tasks: Map<string, ScheduledTask>;
  loaded: boolean;
  version: string;
}

const fileStates = new Map<string, FileState>();
let scopeAppId: string | null = null;
let taskRemovedHook: ((taskId: string) => void) | undefined;

/** Runtime-only observer for every durable task deletion path. */
export function setScheduleStoreTaskRemovedHook(hook: ((taskId: string) => void) | undefined): void {
  taskRemovedHook = hook;
}

/** Bind the store's default file to one bot. Daemon: own bot at startup.
 *  CLI: the session's bot / explicit --lark-app-id before any store call. */
export function setScheduleScope(appId: string): void {
  scopeAppId = appId;
}

export function getScheduleScope(): string | null {
  return scopeAppId;
}

function requireScope(): string {
  if (!scopeAppId) {
    throw new Error(
      '[schedule-store] no bot scope bound — call setScheduleScope(<larkAppId>) before using the schedule store',
    );
  }
  return scopeAppId;
}

/** The per-bot schedules file: `<botmuxHome>/bots/<appId>/schedules.json`. */
export function scheduleFilePathFor(appId: string): string {
  return join(botHomePath(dirname(config.session.dataDir), appId), 'schedules.json');
}

function getFilePath(appId?: string): string {
  return scheduleFilePathFor(appId ?? requireScope());
}

function stateFor(fp: string): FileState {
  let s = fileStates.get(fp);
  if (!s) {
    s = { tasks: new Map(), loaded: false, version: 'missing' };
    fileStates.set(fp, s);
  }
  return s;
}

function getOutputDir(): string {
  return join(config.session.dataDir, 'schedules-output');
}

export function getTaskOutputDir(taskId: string): string {
  return join(getOutputDir(), taskId);
}

function ensureDir(d: string): void {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function fileVersion(fp: string): string {
  try {
    const stat = statSync(fp);
    // Atomic rename can replace a file without advancing mtime on coarse
    // filesystems. Include inode/size/ctime so a stale process notices the
    // replacement before serving another read.
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 'missing';
    throw err;
  }
}

/**
 * Migrate legacy schedule task (pre-parsed field) to current shape.
 * Legacy tasks had { type, schedule } only — promote schedule+type into parsed.
 */
function migrate(raw: any): ScheduledTask | null {
  if (!raw || typeof raw !== 'object') return null;

  let parsed: ParsedSchedule | undefined = raw.parsed;
  if (!parsed) {
    // Legacy format: always treat as cron (old parser only produced cron)
    if (raw.type === 'cron' && raw.schedule) {
      parsed = { kind: 'cron', expr: raw.schedule, display: raw.schedule };
    } else if (raw.schedule) {
      // Best-effort fallback
      parsed = { kind: 'cron', expr: raw.schedule, display: raw.schedule };
    } else {
      logger.warn(`[schedule-store] Dropping un-migratable task ${raw.id}: missing schedule`);
      return null;
    }
  }

  const executionPosition: ScheduleExecutionPosition | undefined =
    raw.executionPosition === 'top-level' || raw.executionPosition === 'topic' || raw.executionPosition === 'new-topic' || raw.executionPosition === 'task'
      ? raw.executionPosition
      : raw.deliver === 'new-topic'
        ? 'new-topic'
        : undefined;
  let targets: ScheduleChatTargets;
  try {
    targets = normalizeScheduleChatTargets({
      chatId: raw.chatId,
      chatIds: raw.chatIds,
    });
  } catch (error) {
    // `chatIds` is additive metadata. A malformed manually-written value must
    // not make one row empty the entire schedules file; retain the legacy
    // primary target when that field is still usable.
    targets = normalizeScheduleChatTargets({ chatId: raw.chatId });
    logger.warn(
      `[schedule-store] Ignoring invalid chatIds for task ${String(raw.id)}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    id: raw.id,
    preconditionRef: typeof raw.preconditionRef === 'string' && raw.preconditionRef
      ? raw.preconditionRef
      : undefined,
    name: raw.name,
    schedule: raw.schedule,
    parsed,
    prompt: raw.prompt,
    workingDir: raw.workingDir,
    chatId: targets.chatId,
    chatIds: targets.chatIds,
    rootMessageId: raw.rootMessageId,
    scope: raw.scope === 'thread' || raw.scope === 'chat' ? raw.scope : undefined,
    executionPosition,
    topicTitle: typeof raw.topicTitle === 'string' && raw.topicTitle.trim()
      ? Array.from(raw.topicTitle.trim()).slice(0, 200).join('')
      : undefined,
    chatType: raw.chatType,
    larkAppId: raw.larkAppId,
    creatorChatId: raw.creatorChatId,
    creatorRootMessageId: raw.creatorRootMessageId,
    creatorLarkAppId: raw.creatorLarkAppId,
    // Creator identity is rebuilt field-by-field like everything else here, so
    // it has to be listed explicitly: without these two lines `createTask`
    // persists them but every reload (daemon restart, external `schedule add`
    // bumping the file version) drops them, and the task silently degrades to
    // "no creator".
    ownerOpenId: raw.ownerOpenId,
    ownerUnionId: raw.ownerUnionId,
    enabled: raw.enabled !== false,
    disabledReason: raw.disabledReason === 'once_completed' || raw.disabledReason === 'manual'
      ? raw.disabledReason
      : undefined,
    createdAt: raw.createdAt,
    lastRunAt: raw.lastRunAt,
    nextRunAt: raw.nextRunAt,
    lastStatus: raw.lastStatus,
    lastRunId: raw.lastRunId,
    lastError: raw.lastError,
    lastDeliveryError: raw.lastDeliveryError,
    lastTerminalStatus: raw.lastTerminalStatus === 'ok' || raw.lastTerminalStatus === 'error'
      ? raw.lastTerminalStatus
      : undefined,
    lastTerminalAt: typeof raw.lastTerminalAt === 'string' && raw.lastTerminalAt.trim()
      ? raw.lastTerminalAt.trim()
      : undefined,
    lastTerminalError: typeof raw.lastTerminalError === 'string' && raw.lastTerminalError.trim()
      ? sanitiseTerminalError(raw.lastTerminalError)
      : undefined,
    lastTerminalRunId: typeof raw.lastTerminalRunId === 'string' && raw.lastTerminalRunId.trim()
      ? raw.lastTerminalRunId.trim()
      : undefined,
    lastTerminalTurnId: typeof raw.lastTerminalTurnId === 'string' && raw.lastTerminalTurnId.trim()
      ? raw.lastTerminalTurnId.trim()
      : undefined,
    // Per-run records: new format first, then legacy migration.
    runRecords: deserializeRunRecords(raw),
    repeat: raw.repeat,
    deliver: raw.deliver === 'local' ? 'local' : 'origin',
    silent: raw.silent === true ? true : undefined,
    followActive: raw.followActive === true ? true : undefined,
    // Rebuilt explicitly like every other field here: omitting them would let
    // `createTask` persist a per-task model and then have the next reload drop
    // it, so the task silently degrades back to the bot's model (the exact way
    // `ownerOpenId` broke once). A hand-edited junk value is dropped rather
    // than carried to fire time, where it could only produce a CLI error.
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    reasoningEffort: isScheduleReasoningEffort(raw.reasoningEffort) ? raw.reasoningEffort : undefined,
  };
}

interface DiskSnapshot {
  map: Map<string, ScheduledTask>;
  migratedCount: number;
}

function readDiskSnapshot(fp: string, strict: boolean): DiskSnapshot {
  const map = new Map<string, ScheduledTask>();
  if (!existsSync(fp)) return { map, migratedCount: 0 };

  try {
    const data = JSON.parse(readFileSync(fp, 'utf-8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('schedules.json root must be an object');
    }
    let migratedCount = 0;
    for (const [id, raw] of Object.entries(data)) {
      const migrated = migrate(raw);
      if (migrated) {
        map.set(id, migrated);
        if (!(raw as any).parsed) migratedCount++;
      }
    }
    return { map, migratedCount };
  } catch (err) {
    if (strict) throw err;
    logger.error(`Failed to load schedules: ${err}`);
    return { map: new Map(), migratedCount: 0 };
  }
}

function serializeTasks(map: ReadonlyMap<string, ScheduledTask>): string {
  const obj: Record<string, ScheduledTask> = {};
  for (const [id, task] of map) obj[id] = task;
  return JSON.stringify(obj, null, 2);
}

// Deliberately inert outside Vitest. This lets the durability regression test
// inject a failure after the temp file is fsynced but before the atomic rename,
// without weakening or monkey-patching Node's filesystem API in production.
let beforeRenameTestHook: (() => void) | undefined;
export function __setScheduleStoreBeforeRenameTestHook(hook?: () => void): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('schedule-store persistence hook is test-only');
  }
  beforeRenameTestHook = hook;
}

/**
 * Crash-durable replace. The random O_EXCL temp prevents two writers from
 * sharing a staging file; the caller's schedules.json lock serializes the
 * reload/mutate/commit transaction. The old file remains authoritative until
 * rename, and the parent fsync makes the rename durable before callers see the
 * new in-memory snapshot.
 */
function persistDiskSnapshot(fp: string, map: ReadonlyMap<string, ScheduledTask>): void {
  const parent = dirname(fp);
  ensureDir(parent);
  const tmpFp = join(
    parent,
    `.${basename(fp)}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`,
  );
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(
      tmpFp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, serializeTasks(map), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    beforeRenameTestHook?.();
    renameSync(tmpFp, fp);
    renamed = true;
    fsyncDirectorySyncPortable(parent);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (!renamed) {
      try { unlinkSync(tmpFp); } catch { /* absent or already cleaned */ }
    }
  }
}

function installSnapshot(map: Map<string, ScheduledTask>, fp: string): void {
  const s = stateFor(fp);
  s.tasks = map;
  s.version = fileVersion(fp);
  s.loaded = true;
}

interface MutationResult<T> {
  result: T;
  changed: boolean;
}

/**
 * Every schedules.json mutation goes through one cross-process transaction:
 * lock -> force reload -> mutate an isolated map -> durable replace -> publish
 * to memory. A failed write therefore cannot create an in-memory ghost, and a
 * stale daemon/CLI process cannot overwrite another process's newer update.
 */
function mutateTasks<T>(
  mutate: (working: Map<string, ScheduledTask>) => MutationResult<T>,
  appId?: string,
): T {
  const fp = getFilePath(appId);
  ensureDir(dirname(fp));
  return withFileLockSync(fp, () => {
    const working = readDiskSnapshot(fp, true).map;
    const outcome = mutate(working);
    if (outcome.changed) persistDiskSnapshot(fp, working);
    // Install only after the commit succeeds. No-op/idempotent mutations still
    // refresh a stale process from the authoritative disk snapshot.
    installSnapshot(working, fp);
    return outcome.result;
  });
}

function load(appId?: string): void {
  const fp = getFilePath(appId);
  ensureDir(dirname(fp));
  const state = stateFor(fp);
  const currentVersion = fileVersion(fp);

  // Reload if the file has been atomically replaced externally (e.g. by
  // `botmux schedule add`) or on first load.
  if (state.loaded && currentVersion === state.version) return;

  const snapshot = readDiskSnapshot(fp, false);
  let nextMap = snapshot.map;

  // Persist legacy normalization under the same mutation lock. Re-read inside
  // the lock so migration cannot overwrite a concurrent modern writer.
  if (snapshot.migratedCount > 0) {
    try {
      nextMap = withFileLockSync(fp, () => {
        const current = readDiskSnapshot(fp, true);
        if (current.migratedCount > 0) persistDiskSnapshot(fp, current.map);
        return current.map;
      });
    } catch (err) {
      // Reading remains backward compatible even if the optional normalization
      // write fails. Future mutations still fail closed on malformed storage.
      logger.error(`[schedule-store] Failed to persist legacy migration: ${err}`);
      // A different process may have committed between our optimistic read and
      // lock acquisition. Never pair that newer file version with the stale
      // pre-lock map, or this process could serve stale data indefinitely.
      nextMap = readDiskSnapshot(fp, false).map;
    }
  }

  if (!state.loaded) {
    logger.info(
      `Loaded ${nextMap.size} scheduled tasks from ${fp}` +
      `${snapshot.migratedCount ? ` (migrated ${snapshot.migratedCount} legacy)` : ''}`,
    );
  } else {
    logger.info(`[schedule-store] Reloaded ${nextMap.size} tasks (file changed)`);
  }
  installSnapshot(nextMap, fp);
}

/** Allowed task id alphabet/width. Producers are the 8-hex legacy ids and the
 *  workflow idempotency keys (`wf_`/`wf3_` + truncated sha256 hex, width 50);
 *  task ids are used as schedules.json keys and per-task output-dir segments,
 *  so anything outside [0-9a-z_] (path separators, dots, spaces) is rejected
 *  up front. */
const TASK_ID_RE = /^[0-9a-z_]{1,50}$/;

function assertValidTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) {
    throw new TypeError(`invalid schedule task id: ${JSON.stringify(id)}`);
  }
}

/**
 * Create a scheduled task — or return the existing one with the same input
 * when called with a workflow-supplied `id` that already exists.
 *
 * Behaviour matrix (events doc v0.1.2 §2.2 Option A):
 *
 *   | scenario                                   | result                       |
 *   |--------------------------------------------|------------------------------|
 *   | no `id`                                    | randomUUID(8) — legacy path  |
 *   | `id` not in store                          | create with the given id     |
 *   | `id` in store + canonical input matches    | return existing (no mutation)|
 *   | `id` in store + canonical input differs    | IdempotencyConflictError     |
 *
 * Use `wf_<hash...>` prefixed ids when called from workflow runtime to
 * avoid collisions with the 8-char randomUUID legacy namespace.
 */
export function createTask(params: {
  id?: string;
  preconditionRef?: string;
  name: string;
  schedule: string;
  parsed: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  chatIds?: readonly string[];
  rootMessageId?: string;
  scope?: 'thread' | 'chat';
  executionPosition?: ScheduleExecutionPosition;
  topicTitle?: string;
  chatType?: 'group' | 'p2p' | 'topic_group';
  larkAppId?: string;
  creatorChatId?: string;
  creatorRootMessageId?: string;
  creatorLarkAppId?: string;
  ownerOpenId?: string;
  ownerUnionId?: string;
  nextRunAt?: string;
  repeat?: { times: number | null; completed: number };
  deliver?: 'origin' | 'local' | 'new-topic';
  silent?: boolean;
  followActive?: boolean;
  model?: string;
  reasoningEffort?: ScheduleReasoningEffort;
}): ScheduledTask {
  const targets = normalizeScheduleChatTargets({ chatId: params.chatId, chatIds: params.chatIds });
  if (params.id) assertValidTaskId(params.id);
  // Route to the OWNING bot's file: a task explicitly created for another bot
  // (`--lark-app-id` / dashboard admin flows) must land in that bot's store so
  // its daemon (the only one that executes it) can see it. Sandboxed callers
  // can only reach their own BOT_HOME — a cross-bot write fails closed (EPERM).
  return mutateTasks(working => {
    if (params.id) {
      const existing = working.get(params.id);
      if (existing) {
        const existingHash = computeInputHash(canonicalScheduleInput(existing));
        const incomingHash = computeInputHash(canonicalScheduleInput(params));
        if (existingHash === incomingHash) {
          // create-or-return-identical: same id + same canonical input → no-op.
          // Do NOT mutate `enabled`, `nextRunAt`, `lastRunAt` etc — those are
          // runtime state that the caller has no business overwriting via the
          // create path.  Use `updateTask` / `enableTask` for those.
          logger.debug(
            `[schedule-store] createTask: returning existing task ${params.id} (canonical input identical)`,
          );
          return { result: existing, changed: false };
        }
        throw new IdempotencyConflictError({
          taskId: params.id,
          existingInputHash: existingHash,
          incomingInputHash: incomingHash,
        });
      }
      // id given but new task — fall through to create with that id.
    }

    let id = params.id ?? randomUUID().substring(0, 8);
    while (!params.id && working.has(id)) id = randomUUID().substring(0, 8);
    assertValidTaskId(id);
    const task: ScheduledTask = {
      id,
      preconditionRef: params.preconditionRef,
      name: params.name,
      schedule: params.schedule,
      parsed: params.parsed,
      prompt: params.prompt,
      workingDir: params.workingDir,
      chatId: targets.chatId,
      chatIds: targets.chatIds,
      rootMessageId: params.rootMessageId,
      scope: params.scope,
      executionPosition: params.executionPosition,
      topicTitle: params.topicTitle,
      chatType: params.chatType,
      larkAppId: params.larkAppId,
      creatorChatId: params.creatorChatId,
      creatorRootMessageId: params.creatorRootMessageId,
      creatorLarkAppId: params.creatorLarkAppId,
      ownerOpenId: params.ownerOpenId,
      ownerUnionId: params.ownerUnionId,
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: params.nextRunAt,
      repeat: params.repeat,
      // Legacy `deliver:new-topic` is converted by scheduler.addTask into the
      // explicit executionPosition field before reaching the store.
      deliver: params.deliver === 'local' ? 'local' : 'origin',
      silent: params.silent === true ? true : undefined,
      followActive: params.followActive === true ? true : undefined,
      model: params.model?.trim() || undefined,
      reasoningEffort: params.reasoningEffort,
    };
    working.set(task.id, task);
    return { result: task, changed: true };
  }, params.larkAppId);
}

export function getTask(id: string, appId?: string): ScheduledTask | undefined {
  load(appId);
  return stateFor(getFilePath(appId)).tasks.get(id);
}

export function removeTask(id: string, appId?: string): boolean {
  const existed = mutateTasks(working => {
    const removed = working.delete(id);
    return { result: removed, changed: removed };
  }, appId);
  if (existed) logger.info(`[schedule-store] Removed task ${id}`);
  if (existed) taskRemovedHook?.(id);
  return existed;
}

export function updateTask(
  id: string,
  updates: Partial<Pick<ScheduledTask,
    'enabled' | 'disabledReason' | 'lastRunAt' | 'nextRunAt' | 'lastStatus' | 'lastRunId' | 'lastError' | 'lastDeliveryError' | 'repeat' | 'rootMessageId' | 'scope' | 'executionPosition' | 'topicTitle' | 'chatType' | 'deliver' | 'name' | 'prompt' | 'schedule' | 'parsed' | 'silent' | 'workingDir' | 'followActive' | 'preconditionRef' | 'chatId' | 'model' | 'reasoningEffort'
  >> & { chatIds?: readonly string[] | null },
  appId?: string,
): boolean {
  return mutateTasks(working => {
    const task = working.get(id);
    if (!task) return { result: false, changed: false };
    const targetUpdate = updates.chatId !== undefined || updates.chatIds !== undefined;
    const targets = targetUpdate
      ? normalizeScheduleChatTargets({
          chatId: updates.chatId ?? task.chatId,
          // Supplying only chatId preserves the old single-target update
          // meaning and therefore collapses any previous multi-chat list.
          chatIds: updates.chatIds !== undefined ? updates.chatIds : null,
        })
      : undefined;
    const { chatIds: _chatIds, ...ordinaryUpdates } = updates;
    Object.assign(
      task,
      updates.deliver === 'new-topic'
        ? { ...ordinaryUpdates, deliver: 'origin' as const }
        : ordinaryUpdates,
    );
    // Generic enable/disable writes are operator actions. Automatic one-shot
    // completion is written directly by markRun below so the two states remain
    // distinguishable for exact in-flight scheduled-turn authorization.
    if (updates.enabled === true) delete task.disabledReason;
    else if (updates.enabled === false && updates.disabledReason === undefined) {
      task.disabledReason = 'manual';
    }
    if (targets) {
      task.chatId = targets.chatId;
      if (targets.chatIds) task.chatIds = targets.chatIds;
      else delete task.chatIds;
    }
    return { result: true, changed: true };
  }, appId);
}

export type ScheduleRunClaimResult =
  | { ok: true; task: ScheduledTask }
  | { ok: false; error: 'not_found' | 'already_running' };

/** Atomically claim a task for dispatch. The file lock makes this the single
 * admission point shared by natural ticks and Dashboard run-now requests. */
export function claimRun(
  id: string,
  claim: Pick<ScheduledTask, 'lastRunAt' | 'nextRunAt' | 'lastRunId'>,
  appId?: string,
): ScheduleRunClaimResult {
  return mutateTasks<ScheduleRunClaimResult>(working => {
    const task = working.get(id);
    if (!task) return { result: { ok: false, error: 'not_found' } as const, changed: false };
    if (task.lastStatus === 'running') {
      return { result: { ok: false, error: 'already_running' } as const, changed: false };
    }
    Object.assign(task, claim, {
      lastStatus: 'running' as const,
      lastError: undefined,
      lastDeliveryError: undefined,
    });
    if (task) pruneSettledRunRecords(task);
    // Per-run: don't clear old run records — recovery terminals for prior
    // runs need those bindings.  Old records are cleaned up when all targets
    // are settled and no pending recovery sources remain.  A new run record
    // entry is created on first setRunTargetCount or bindRunTurnId.
    return { result: { ok: true, task } as const, changed: true };
  }, appId);
}

/** Atomically make a task due without re-arming one that is already running. */
export function requestRunNow(
  id: string,
  nextRunAt = new Date().toISOString(),
  appId?: string,
): { ok: true } | { ok: false; error: 'not_found' | 'already_running' } {
  return mutateTasks<{ ok: true } | { ok: false; error: 'not_found' | 'already_running' }>(working => {
    const task = working.get(id);
    if (!task) return { result: { ok: false, error: 'not_found' } as const, changed: false };
    if (task.lastStatus === 'running') {
      return { result: { ok: false, error: 'already_running' } as const, changed: false };
    }
    task.nextRunAt = nextRunAt;
    return { result: { ok: true } as const, changed: true };
  }, appId);
}

/** Record a skipped check without consuming a run or disabling a one-shot. */
export function markSkipped(id: string, nextRunAt?: string, runId?: string): void {
  mutateTasks(working => {
    const task = working.get(id);
    if (!task) return { result: undefined, changed: false };
    if (runId !== undefined && task.lastRunId !== runId) {
      return { result: undefined, changed: false };
    }

    task.lastRunAt = new Date().toISOString();
    task.lastStatus = 'skipped';
    task.lastError = undefined;
    task.lastDeliveryError = undefined;
    if (task.parsed.kind === 'once') task.nextRunAt = nextRunAt;
    return { result: undefined, changed: true };
  });
}

/**
 * Settle the durable terminal result of a run.  Must be called from the
 * turn_terminal path (not the dispatcher).
 *
 * Per-run partitioning: all aggregation reads/writes only `runRecords[runId]`.
 * Recovery is detected purely by explicit `sourceTurnId !== turnId` mapping;
 * settledCount/targetCount heuristics are never used for recovery detection.
 *
 * Guards:
 * 1. Missing task → false
 * 2. `runId` required — fail-closed when absent (no legacy fallback)
 * 3. `sourceTurnId` duplicate → false (unless recovery redo)
 * 4. Stale: `runId !== task.lastRunId` AND `sourceTurnId` not found in any
 *    run record → false.  Old-run terminals with a known source update the
 *    old record but never project to task.lastTerminal*.
 *
 * Projection: only when `task.lastRunId === runId` AND all target sources
 * are settled.  Success writes `lastTerminalStatus='ok'`; any per-target
 * error writes `'error'`.  Partial settlement defers projection.
 *
 * Returns true when terminal state was persisted, false when rejected.
 *
 * @param id          Task identifier.
 * @param runId       Scheduler run identity (required; fail-closed).
 * @param turnId      This attempt's turn id (may be undefined for dispatch-failed targets).
 * @param success     Whether this terminal is a success.
 * @param error       Error message (only meaningful when success=false).
 * @param sourceTurnId The logical source target. Defaults to `turnId` for
 *                     normal targets; set to the original failed turnId for
 *                     recovery retries.
 */
export function settleTerminalRun(
  id: string,
  runId: string,
  success: boolean,
  error?: string,
  turnId?: string,
  sourceTurnId?: string,
  recoveryAttemptTurnId?: string,
  consumeNormalBinding = false,
): boolean {
  const source = sourceTurnId ?? turnId;
  if (!source) {
    // Dispatch-failed target with no source identity — cannot track.
    // These are handled by the daemon directly calling with a synthetic
    // sourceTurnId (e.g. "dispatch-failed:<chatId>").
    return false;
  }

  return mutateTasks(working => {
    const task = working.get(id);
    if (!task) return { result: false, changed: false };

    // The terminal path must name an already-dispatched run.  Creating a
    // record here lets a late terminal manufacture ownership after a newer
    // claim, which is exactly the cross-run contamination this guard blocks.
    const runRec = task.runRecords?.[runId];
    if (!runRec) return { result: false, changed: false };

    const isCurrentRun = runId === task.lastRunId;
    const isRecovery = turnId !== undefined && sourceTurnId !== undefined && sourceTurnId !== turnId;
    if (recoveryAttemptTurnId && (!isRecovery || runRec.recoveryAttempts?.[source] !== recoveryAttemptTurnId)) {
      return { result: false, changed: false };
    }

    // ── Stale guard ─────────────────────────────────────────────────────
    // Non-current run: only allow terminals for known sources (old-run
    // terminals or recovery) — they update the old record only.
    // Unknown sources for old runs are stale and rejected.
    if (!isCurrentRun) {
      if (!runRec.turnBindings?.[source]) {
        return { result: false, changed: false }; // stale: source unknown
      }
      // Old-run terminal: update record only, never project.
    }

    // ── Dedup / recovery redo ───────────────────────────────────────────
    const alreadySettled = runRec.settledTurnIds.includes(source);
    if (alreadySettled) {
      if (!isRecovery) {
        return { result: false, changed: false }; // duplicate normal terminal
      }
      // Recovery redo: source already settled, just update per-target error.
    } else if (isRecovery) {
      // A recovery is a correction of an existing source outcome.  It must
      // never create a new settled source when its terminal races ahead.
      return { result: false, changed: false };
    }

    // ── Settle the source ───────────────────────────────────────────────
    if (!alreadySettled) {
      runRec.settledTurnIds.push(source);
    }

    // A preceding all-success terminal may have pruned this empty container.
    // Recreate it before recording a later target failure in the same run.
    if (!runRec.perTargetErrors) runRec.perTargetErrors = {};
    if (success) {
      delete runRec.perTargetErrors[source];
    } else {
      runRec.perTargetErrors[source] = sanitiseTerminalError(error) ?? 'unknown error';
    }

    // Clean up empty perTargetErrors
    if (Object.keys(runRec.perTargetErrors).length === 0) {
      delete (runRec as any).perTargetErrors;
    }

    // Persist the record
    task.runRecords![runId] = runRec;

    // Recovery terminal + authority consumption is one schedules.json
    // mutation. A write failure rolls back both result and permissions.
    if (recoveryAttemptTurnId) {
      delete runRec.turnBindings[recoveryAttemptTurnId];
      if (runRec.recoveryAttempts) {
        delete runRec.recoveryAttempts[source];
        if (Object.keys(runRec.recoveryAttempts).length === 0) delete runRec.recoveryAttempts;
      }
      if (success) delete runRec.turnBindings[source];
      pruneSettledRunRecords(task);
    } else if (consumeNormalBinding && turnId) {
      delete runRec.turnBindings[turnId];
      pruneSettledRunRecords(task);
    }

    // ── Projection (current run only) ───────────────────────────────────
    if (!isCurrentRun) return { result: true, changed: true };
    const hasErrors = Object.keys(runRec.perTargetErrors ?? {}).length > 0;
    const allTargetsSettled = runRec.targetCount === 0
      ? true : runRec.settledTurnIds.length >= runRec.targetCount;
    if (!hasErrors && allTargetsSettled) {
      const now = new Date().toISOString();
      task.lastTerminalStatus = 'ok'; task.lastTerminalAt = now;
      task.lastTerminalError = undefined; task.lastTerminalRunId = runId;
      if (turnId) task.lastTerminalTurnId = turnId;
    } else if (hasErrors) {
      const now = new Date().toISOString();
      task.lastTerminalStatus = 'error'; task.lastTerminalAt = now;
      task.lastTerminalError = Object.values(runRec.perTargetErrors!)[0];
      task.lastTerminalRunId = runId;
      if (turnId) task.lastTerminalTurnId = turnId;
    } else if (turnId) task.lastTerminalTurnId = turnId;

    return { result: true, changed: true };
  });
}

/** Set the expected target count for the current run.  The daemon calls this
 *  after dispatch so `settleTerminalRun` can defer writing terminal ok until
 *  all targets have settled.  Resets `lastRunSettledCount` to 0; rejects when
 *  `runId` no longer matches the current claim. */
export function setRunTargetCount(
  id: string,
  count: number,
  runId: string,
): void {
  mutateTasks(working => {
    const task = working.get(id);
    if (!task) return { result: undefined, changed: false };
    if (task.lastRunId !== runId) return { result: undefined, changed: false };
    if (!task.runRecords) task.runRecords = {};
    if (!task.runRecords[runId]) {
      task.runRecords[runId] = { targetCount: 0, settledTurnIds: [], perTargetErrors: {}, turnBindings: {} };
    }
    task.runRecords[runId].targetCount = count;
    return { result: undefined, changed: true };
  });
}

/**
 * Persist a turnId → runId binding so recovery continuations can restore
 * the binding after daemon restart (the in-memory map is empty on restart).
 * A record created before a later claim remains writable: recovery after a
 * daemon restart must retain the original source → run identity.  A missing
 * non-current record is rejected, so a stale terminal cannot invent one.
 */
export function bindRunTurnId(
  id: string,
  turnId: string,
  runId: string,
): boolean {
  return mutateTasks(working => {
    const task = working.get(id);
    if (!task || task.lastRunId !== runId) return { result: false, changed: false };
    if (!task.runRecords) task.runRecords = {};
    if (!task.runRecords[runId]) {
      task.runRecords[runId] = { targetCount: 0, settledTurnIds: [], perTargetErrors: {}, turnBindings: {} };
    }
    task.runRecords[runId].turnBindings[turnId] = runId;
    return { result: true, changed: true };
  });
}

/** Atomically claim one recovery continuation for a persisted failed source. */
export function claimRecoveryAttempt(
  id: string,
  runId: string,
  sourceTurnId: string,
  attemptTurnId: string,
): boolean {
  return mutateTasks(working => {
    const task = working.get(id);
    const rec = task?.runRecords?.[runId];
    if (!rec || rec.turnBindings?.[sourceTurnId] !== runId
      || !rec.perTargetErrors?.[sourceTurnId] || rec.recoveryAttempts?.[sourceTurnId]) {
      return { result: false, changed: false };
    }
    if (!rec.recoveryAttempts) rec.recoveryAttempts = {};
    rec.recoveryAttempts[sourceTurnId] = attemptTurnId;
    rec.turnBindings[attemptTurnId] = runId;
    return { result: true, changed: true };
  });
}

/** Undo only an attempt that was never accepted by the worker. */
export function releaseRecoveryAttempt(
  id: string,
  runId: string,
  sourceTurnId: string,
  attemptTurnId: string,
): boolean {
  return mutateTasks(working => {
    const rec = working.get(id)?.runRecords?.[runId];
    if (!rec || rec.recoveryAttempts?.[sourceTurnId] !== attemptTurnId) {
      return { result: false, changed: false };
    }
    delete rec.turnBindings[attemptTurnId];
    delete rec.recoveryAttempts[sourceTurnId];
    if (Object.keys(rec.recoveryAttempts).length === 0) delete rec.recoveryAttempts;
    return { result: true, changed: true };
  });
}

/** Terminal recovery cannot continue: release attempt, source, error and old record atomically. */
export function abandonRecoveryAttempt(
  id: string, runId: string, sourceTurnId: string, attemptTurnId: string,
): boolean {
  return mutateTasks(working => {
    const task = working.get(id);
    const rec = task?.runRecords?.[runId];
    if (!task || !rec || rec.turnBindings?.[sourceTurnId] !== runId
      || (rec.recoveryAttempts?.[sourceTurnId] !== undefined
        && rec.recoveryAttempts[sourceTurnId] !== attemptTurnId)) {
      return { result: false, changed: false };
    }
    delete rec.turnBindings[attemptTurnId];
    delete rec.turnBindings[sourceTurnId];
    delete rec.perTargetErrors[sourceTurnId];
    if (rec.recoveryAttempts) {
      delete rec.recoveryAttempts[sourceTurnId];
      if (Object.keys(rec.recoveryAttempts).length === 0) delete rec.recoveryAttempts;
    }
    if (Object.keys(rec.perTargetErrors).length === 0) delete (rec as any).perTargetErrors;
    pruneSettledRunRecords(task);
    return { result: true, changed: true };
  });
}

/** Remove one durable source binding after a terminal no longer needs recovery. */
export function unbindRunTurnId(id: string, turnId: string, runId: string): void {
  unbindRunTurnIds(id, [turnId], runId);
}

/** Atomically remove one terminal attempt and, when applicable, its source. */
export function unbindRunTurnIds(id: string, turnIds: readonly string[], runId: string): void {
  mutateTasks(working => {
    const task = working.get(id);
    const runRec = task?.runRecords?.[runId];
    if (!runRec) return { result: undefined, changed: false };
    let changed = false;
    for (const turnId of turnIds) {
      if (!runRec.turnBindings?.[turnId]) continue;
      delete runRec.turnBindings[turnId];
      changed = true;
    }
    if (!changed) return { result: undefined, changed: false };
    pruneSettledRunRecords(task!);
    return { result: undefined, changed: true };
  });
}

/**
 * Record a run outcome and auto-manage repeat counter.  If the task has a
 * finite repeat count and we've hit it, the task is removed.
 */
export function markRun(
  id: string,
  success: boolean,
  error?: string,
  deliveryError?: string,
  runId?: string,
): void {
  const completedRepeat = mutateTasks(working => {
    const task = working.get(id);
    if (!task) return { result: undefined, changed: false };
    if (runId !== undefined && task.lastRunId !== runId) {
      return { result: undefined, changed: false };
    }

    const now = new Date().toISOString();
    task.lastRunAt = now;
    task.lastStatus = success ? 'ok' : 'error';
    task.lastError = success ? undefined : error;
    task.lastDeliveryError = deliveryError;

    // Advance repeat counter
    if (task.repeat) {
      task.repeat.completed = (task.repeat.completed ?? 0) + 1;
      const times = task.repeat.times;
      if (times !== null && times !== undefined && times > 0 && task.repeat.completed >= times) {
        working.delete(id);
        return { result: times, changed: true };
      }
    }

    // One-shot: disable after run. Otherwise next_run was already advanced by scheduler.
    if (task.parsed.kind === 'once') {
      task.enabled = false;
      task.disabledReason = 'once_completed';
      task.nextRunAt = undefined;
    }
    return { result: undefined, changed: true };
  });
  if (completedRepeat !== undefined) {
    logger.info(`[schedule-store] Task ${id} removed after completing ${completedRepeat} runs`);
    taskRemovedHook?.(id);
  }
}

export function listTasks(appId?: string): ScheduledTask[] {
  load(appId);
  return [...stateFor(getFilePath(appId)).tasks.values()];
}

/** Aggregate view across several bots' stores (unsandboxed admin CLI). Bots
 *  whose store cannot be read (sandbox deny / missing BOT_HOME) are skipped —
 *  callers inside a sandbox naturally collapse to their own bot. */
export function listTasksForBots(appIds: readonly string[]): Array<ScheduledTask & { _storeAppId: string }> {
  const out: Array<ScheduledTask & { _storeAppId: string }> = [];
  for (const appId of appIds) {
    try {
      for (const t of listTasks(appId)) out.push({ ...t, _storeAppId: appId });
    } catch { /* unreadable (sandboxed sibling / bad appId) → skip */ }
  }
  return out;
}

/** Bulk-insert raw task entries into one bot's store (startup split
 *  migration). Runs the same in-file legacy normalization as a disk read;
 *  an id already present in the destination wins (the per-bot store is newer
 *  by definition) and the collision is logged. */
export function importTasks(appId: string, entries: ReadonlyArray<[string, unknown]>): void {
  if (entries.length === 0) return;
  mutateTasks(working => {
    let changed = false;
    for (const [id, raw] of entries) {
      const task = migrate(raw);
      if (!task) continue;
      if (working.has(id)) {
        logger.warn(`[schedule-store] import: id ${id} already exists in ${appId}'s store — keeping existing entry`);
        continue;
      }
      working.set(id, task);
      changed = true;
    }
    return { result: undefined, changed };
  }, appId);
}

/** Locate a task id across several bots' stores. First hit wins (ids are
 *  UUID-derived; a cross-store collision is negligible and would only make an
 *  id-addressed command pick the first store). */
export function findTaskAcrossBots(
  id: string,
  appIds: readonly string[],
): { task: ScheduledTask; appId: string } | undefined {
  for (const appId of appIds) {
    try {
      const task = getTask(id, appId);
      if (task) return { task, appId };
    } catch { /* unreadable → skip */ }
  }
  return undefined;
}

/** Ensure per-task output dir exists and return path to today's run log. */
export function appendOutputLog(taskId: string, content: string): string {
  const dir = getTaskOutputDir(taskId);
  ensureDir(dir);
  const fname = new Date().toISOString().replace(/[:.]/g, '-') + '.md';
  const fp = join(dir, fname);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

/**
 * Reconcile committed schedules.json changes into dashboard events, including
 * writes made by this daemon. Idempotent — calling twice is a no-op.
 *
 * Keep the publication baseline separate from the business cache: mutations
 * and ordinary reads can refresh that cache before fs.watch runs. Comparing
 * against it would consume changes without notifying dashboard subscribers.
 * Reconcile on the watcher turn so synchronous compound writes/rollbacks have
 * finished; repeated filesystem notifications produce no additional diff.
 */
const WATCH_RETRY_MS = 30_000;
let externalWriteWatcher: FSWatcher | undefined;
let watcherRetryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleExternalWriteWatcherRetry(): void {
  if (watcherRetryTimer || externalWriteWatcher) return;
  watcherRetryTimer = setTimeout(() => {
    watcherRetryTimer = undefined;
    startExternalWriteWatcher();
  }, WATCH_RETRY_MS);
  watcherRetryTimer.unref?.();
}

export function startExternalWriteWatcher(): void {
  if (externalWriteWatcher || watcherRetryTimer) return;

  // Watch this daemon's OWN bot store (the only one it executes/serves). Make
  // sure the BOT_HOME + file exist before we try to watch — fs.watch on a
  // non-existent path throws ENOENT.
  const fp = getFilePath();
  ensureDir(dirname(fp));
  if (!existsSync(fp)) {
    try {
      mutateTasks(working => ({ result: undefined, changed: !existsSync(fp) && working.size === 0 }));
    } catch { /* best effort */ }
  }
  load();
  // Serialized public rows are immutable even if a caller retains a task
  // object, and never retain protected precondition references in events.
  const snapshot = (): Map<string, string> => new Map(
    [...stateFor(fp).tasks].map(([id, { preconditionRef, ...task }]) => [
      id, JSON.stringify({ ...task, hasPrecondition: !!preconditionRef }),
    ]),
  );
  let published = snapshot();
  const announced = new Set(published.keys());

  try {
    // Watch the directory, not the file inode: every commit atomically replaces
    // schedules.json, so a file-level watcher would remain attached to the old
    // inode after the first external write.
    const watcher = watch(dirname(fp), { persistent: false }, (_eventType, filename) => {
      try {
        if (filename && filename.toString() !== basename(fp)) return;
        if (!existsSync(fp)) return;
        load();
        const current = snapshot();
        const before = published;
        published = current;

        for (const [id, serialized] of current) {
          const previous = before.get(id);
          if (previous === serialized) continue;
          const row = JSON.parse(serialized) as Record<string, unknown>;
          if (!announced.has(id)) {
            dashboardEventBus.publish({ type: 'schedule.created', body: { schedule: row } });
          } else {
            // JSON omits undefined. Explicit nulls clear fields such as an old
            // error or thread bookmark in the dashboard's merge-based cache.
            const patch = { ...row };
            for (const key of Object.keys(JSON.parse(previous ?? '{}'))) {
              if (!(key in row)) patch[key] = null;
            }
            dashboardEventBus.publish({ type: 'schedule.updated', body: { id, patch } });
          }
        }
        for (const id of before.keys()) {
          if (!current.has(id)) {
            taskRemovedHook?.(id);
            dashboardEventBus.publish({ type: 'schedule.deleted', body: { id } });
          }
        }
      } catch (err) {
        logger.debug(`[schedule-store] watch handler error: ${err}`);
      }
    });
    externalWriteWatcher = watcher;
    watcher.once('error', (err) => {
      if (externalWriteWatcher !== watcher) return;
      externalWriteWatcher = undefined;
      try { watcher.close(); } catch { /* best effort */ }
      logger.warn(`[schedule-store] File watcher failed; retrying in ${WATCH_RETRY_MS / 1000}s: ${err.message}`);
      scheduleExternalWriteWatcherRetry();
    });
    // Dashboard mutations can announce a richer row before fs.watch runs.
    // Reconcile it with an update, not another create that would replace its
    // presentation metadata. Track lifecycle only: a partial eager update
    // must not consume other committed fields still awaiting publication.
    dashboardEventBus.subscribe(event => {
      if (event.type === 'schedule.created' && stateFor(fp).tasks.has(event.body.schedule.id)) {
        announced.add(event.body.schedule.id);
      } else if (event.type === 'schedule.deleted') {
        announced.delete(event.body.id);
      }
    });
    logger.info(`[schedule-store] Watching ${fp} for external writes`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[schedule-store] Failed to start file watcher; retrying in ${WATCH_RETRY_MS / 1000}s: ${message}`);
    scheduleExternalWriteWatcherRetry();
  }
}

/** Test-only lifecycle reset for the module-level watcher state. */
export function __resetExternalWriteWatcherForTest(): void {
  if (watcherRetryTimer) clearTimeout(watcherRetryTimer);
  watcherRetryTimer = undefined;
  if (externalWriteWatcher) {
    try { externalWriteWatcher.close(); } catch { /* best effort */ }
  }
  externalWriteWatcher = undefined;
}
