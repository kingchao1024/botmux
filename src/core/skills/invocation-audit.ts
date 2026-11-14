import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';

export type SkillInvocationAction = 'show' | 'read' | 'resources';
export type SkillInvocationOutcome = 'ok' | 'error';

export interface SkillInvocationAuditRecord {
  timestamp: string;
  sessionId: string;
  larkAppId?: string;
  action: SkillInvocationAction;
  skill: string;
  resource?: string;
  outcome: SkillInvocationOutcome;
}

function safeValue(value: string | undefined, maxLength = 512): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) return undefined;
  return normalized;
}

function dataDir(env: Record<string, string | undefined>): string {
  return env.SESSION_DATA_DIR?.trim() || config.session.dataDir;
}

function auditPath(env: Record<string, string | undefined>): string {
  return env.BOTMUX_SKILL_INVOCATION_AUDIT_PATH?.trim()
    || join(dataDir(env), 'audit', 'skill-invocations.ndjson');
}

function preflightPath(env: Record<string, string | undefined>, sessionId: string): string | undefined {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(sessionId)) return undefined;
  return join(dataDir(env), 'skill-preflight', `${sessionId}.json`);
}

/** Best-effort metadata-only audit. Skill content and user prompts never enter this file. */
export function appendSkillInvocationAudit(
  env: Record<string, string | undefined>,
  action: SkillInvocationAction,
  skill: string,
  outcome: SkillInvocationOutcome,
  resource?: string,
): void {
  const sessionId = safeValue(env.BOTMUX_SESSION_ID, 200);
  const safeSkill = safeValue(skill, 200);
  if (!sessionId || !safeSkill) return;
  const larkAppId = safeValue(env.BOTMUX_LARK_APP_ID, 200);
  const record: SkillInvocationAuditRecord = {
    timestamp: new Date().toISOString(),
    sessionId,
    ...(larkAppId ? { larkAppId } : {}),
    action,
    skill: safeSkill,
    ...(safeValue(resource) ? { resource: safeValue(resource) } : {}),
    outcome,
  };
  try {
    const path = auditPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  } catch { /* observability must not make skill reads unavailable */ }
}

/** Release the per-session first-tool gate only after a successful entrypoint read. */
export function satisfySkillPreflight(
  env: Record<string, string | undefined>,
  skill: string,
): void {
  const sessionId = safeValue(env.BOTMUX_SESSION_ID, 200);
  const safeSkill = safeValue(skill, 200);
  if (!sessionId || !safeSkill) return;
  const path = preflightPath(env, sessionId);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, `${JSON.stringify({
      version: 1,
      sessionId,
      status: 'satisfied',
      skill: safeSkill,
      satisfiedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
  } catch { /* preflight remains pending; the next tool call will explain recovery */ }
}
