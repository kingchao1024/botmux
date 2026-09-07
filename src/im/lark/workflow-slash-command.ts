/** Natural-language `/workflow` entry for the v3 grill. */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLockSync } from '../../utils/file-lock.js';
import {
  birthRun,
  defaultBaseDir,
  GRILL_STATE_SCHEMA_VERSION,
  GRILL_STATUS_FILE,
  readGrillState,
  writeGrillState,
  type GrillState,
  type RunChatBinding,
} from '../../workflows/v3/grill-state.js';

export const WORKFLOW_USAGE =
  '用法：/workflow <目标>（即兴） | /workflow run <名称> | /workflow save last [名称] | /workflow cancel <runId> | /workflow list。';

export type WorkflowGrillTrigger =
  | { kind: 'goal'; goal: string }
  | { kind: 'usage' };

/**
 * Parse only the v3 grill entry. Reserved v3 verbs are handled by the saved
 * workflow/daemon command paths before this parser is called.
 */
export function parseWorkflowGrillTrigger(content: string): WorkflowGrillTrigger | null {
  const trimmed = content.trim();
  const match = /^\/workflow(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const tail = (match[1] ?? '').trim();
  if (!tail) return { kind: 'usage' };
  const firstToken = tail.split(/\s+/)[0]!;
  if (['run', 'save', 'list', 'show', 'cancel', 'resume'].includes(firstToken)) return null;
  const goal = firstToken === 'new' ? tail.slice(firstToken.length).trim() : tail;
  return goal ? { kind: 'goal', goal } : { kind: 'usage' };
}

export function buildWorkflowGrillPrompt(
  goal: string,
  run?: { runId: string; specPath: string },
): string {
  return [
    '[/workflow new] 用户通过 `/workflow new` 显式发起了一个即兴 workflow。',
    ...(run ? [
      `daemon 已创建并绑定本话题的 run：${run.runId}`,
      `specPath：${run.specPath}`,
      '不要再次执行 `botmux workflow new`；直接使用上述 runId 继续 grill、spec-finalize 和后续流程。',
    ] : []),
    '请使用 `botmux-workflow` skill 处理下面这个目标：直接进入 grill（用户已显式发起，"确认意图"那步可省略），',
    '在当前飞书话题里一问一答澄清需求，然后自动编排成 DAG 流程并跑完。',
    '',
    `目标：${goal}`,
  ].join('\n');
}

function workflowIngressRunId(input: { larkAppId: string; chatId: string; messageId: string }): string {
  const digest = createHash('sha256')
    .update(`${input.larkAppId}\0${input.chatId}\0${input.messageId}`)
    .digest('hex')
    .slice(0, 24);
  return `lark-${digest}`;
}

function sameChatBinding(left: RunChatBinding | undefined, right: RunChatBinding): boolean {
  return !!left
    && left.larkAppId === right.larkAppId
    && left.chatId === right.chatId
    && left.chatType === right.chatType
    && left.rootMessageId === right.rootMessageId
    && left.sessionId === right.sessionId
    && left.ownerOpenId === right.ownerOpenId;
}

function sameChatBindingExceptSession(left: RunChatBinding | undefined, right: RunChatBinding): boolean {
  return !!left
    && left.larkAppId === right.larkAppId
    && left.chatId === right.chatId
    && left.chatType === right.chatType
    && left.rootMessageId === right.rootMessageId
    && left.ownerOpenId === right.ownerOpenId;
}

function isValidIngressGrillState(state: unknown, runId: string, runDir: string): state is GrillState {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const candidate = state as Partial<GrillState>;
  const binding = candidate.chatBinding;
  return candidate.schemaVersion === GRILL_STATE_SCHEMA_VERSION
    && candidate.runId === runId
    && typeof candidate.goal === 'string'
    && ['grilling', 'spec_ready', 'spec_approved', 'architect_running', 'dag_ready', 'dag_approved']
      .includes(candidate.status ?? '')
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && candidate.specPath === join(runDir, 'spec.md')
    && candidate.specJsonPath === join(runDir, 'spec.json')
    && !!binding
    && typeof binding === 'object'
    && typeof binding.larkAppId === 'string'
    && typeof binding.chatId === 'string'
    && (binding.chatType === 'group' || binding.chatType === 'p2p')
    && (binding.rootMessageId === undefined || typeof binding.rootMessageId === 'string')
    && typeof binding.sessionId === 'string'
    && typeof binding.ownerOpenId === 'string'
    && (candidate.ingressRebindings === undefined || (
      Array.isArray(candidate.ingressRebindings)
      && candidate.ingressRebindings.every(entry =>
        !!entry
        && typeof entry === 'object'
        && typeof entry.previousSessionId === 'string'
        && typeof entry.newSessionId === 'string'
        && typeof entry.reboundAt === 'string'
        && entry.reason === 'previous_session_closed_before_execution')
    ));
}

/**
 * Birth an ad-hoc run while still inside the daemon's authenticated ingress.
 * The deterministic message-derived id makes Feishu redelivery idempotent; an
 * existing run is reusable only when every daemon-derived binding field and
 * the original goal still match exactly.
 */
export function birthWorkflowGrillRun(input: {
  goal: string;
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  rootMessageId?: string;
  sessionId: string;
  ownerOpenId: string;
  messageId: string;
  baseDir?: string;
  isSessionClosed?: (sessionId: string) => boolean;
}): { runId: string; specPath: string; sessionId: string } {
  const runId = workflowIngressRunId(input);
  const baseDir = input.baseDir ?? defaultBaseDir();
  mkdirSync(baseDir, { recursive: true });
  const runDir = join(baseDir, runId);
  const chatBinding: RunChatBinding = {
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    chatType: input.chatType,
    ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
    sessionId: input.sessionId,
    ownerOpenId: input.ownerOpenId,
  };
  return withFileLockSync(join(baseDir, `.ingress-${runId}`), () => {
    const stateExists = existsSync(join(runDir, GRILL_STATUS_FILE));
    const runDirEntries = existsSync(runDir) ? readdirSync(runDir) : [];
    if (!stateExists && runDirEntries.length > 0) {
      throw new Error(`workflow_ingress_run_corrupt:${runId}`);
    }
    const existing = readGrillState(runDir);
    if (stateExists && !isValidIngressGrillState(existing, runId, runDir)) {
      throw new Error(`workflow_ingress_run_corrupt:${runId}`);
    }
    if (existing) {
      if (existing.goal === input.goal && sameChatBinding(existing.chatBinding, chatBinding)) {
        return { runId, specPath: existing.specPath, sessionId: input.sessionId };
      }
      const previousSessionId = existing.chatBinding?.sessionId;
      const untouched = existing.status === 'grilling'
        && runDirEntries.every(name => name === GRILL_STATUS_FILE);
      if (existing.goal === input.goal
        && sameChatBindingExceptSession(existing.chatBinding, chatBinding)
        && previousSessionId
        && previousSessionId !== input.sessionId
        && untouched
        && input.isSessionClosed?.(previousSessionId) === true) {
        const reboundAt = new Date().toISOString();
        writeGrillState(runDir, {
          ...existing,
          chatBinding,
          updatedAt: reboundAt,
          ingressRebindings: [
            ...(existing.ingressRebindings ?? []),
            {
              previousSessionId,
              newSessionId: input.sessionId,
              reboundAt,
              reason: 'previous_session_closed_before_execution',
            },
          ],
        });
      } else {
        throw new Error(`workflow_ingress_run_conflict:${runId}`);
      }
      return { runId, specPath: existing.specPath, sessionId: input.sessionId };
    }
    const born = birthRun({ goal: input.goal, baseDir, runId, chatBinding });
    return { runId: born.runId, specPath: born.state.specPath, sessionId: input.sessionId };
  });
}

/** `/template` is a stable tombstone after the v2 runtime retirement. */
export function isLegacyTemplateCommand(content: string): boolean {
  return /^\/template(?:\s|$)/.test(content.trim());
}

export const LEGACY_TEMPLATE_RETIRED_MESSAGE =
  'v2 workflow 已下线，`/template` 不再执行。请先运行 `botmux template migrate-v3` 迁移定义，' +
  '然后使用 `/workflow run <名称>`；历史运行仅可通过离线归档审计。';

/** Shown when a user tries to start / author a workflow while the machine-wide
 *  workflow feature is turned off (global config `workflow.enabled=false` or
 *  `BOTMUX_WORKFLOW_ENABLED` set falsy). In-flight run management (cancel /
 *  retry / grant) is intentionally NOT gated, so a run started before the flip
 *  can still be wound down. */
export const WORKFLOW_DISABLED_MESSAGE =
  '⛔ 本机已关闭「工作流(Workflow)」功能，`/workflow` 即兴编排与 Saved Workflow 的运行/保存均不可用。' +
  '如需开启，请在 Dashboard 设置页打开「工作流功能」开关，或联系管理员。';
