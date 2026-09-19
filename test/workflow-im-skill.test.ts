import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildWorkflowGrillPrompt,
  birthWorkflowGrillRun,
  isLegacyTemplateCommand,
  LEGACY_TEMPLATE_RETIRED_MESSAGE,
  parseWorkflowGrillTrigger,
} from '../src/im/lark/workflow-slash-command.js';

describe('v3 /workflow grill entry', () => {
  it('accepts explicit and natural-language goals', () => {
    expect(parseWorkflowGrillTrigger('/workflow new 调研三家竞品')).toEqual({
      kind: 'goal',
      goal: '调研三家竞品',
    });
    expect(parseWorkflowGrillTrigger('/workflow 把日志分析后出图')).toEqual({
      kind: 'goal',
      goal: '把日志分析后出图',
    });
  });

  it('returns usage for an empty goal', () => {
    expect(parseWorkflowGrillTrigger('/workflow')).toEqual({ kind: 'usage' });
    expect(parseWorkflowGrillTrigger('/workflow new')).toEqual({ kind: 'usage' });
  });

  it('does not swallow reserved v3 verbs or lookalike commands', () => {
    for (const verb of ['run', 'save', 'list', 'show', 'cancel', 'resume']) {
      expect(parseWorkflowGrillTrigger(`/workflow ${verb} value`)).toBeNull();
    }
    expect(parseWorkflowGrillTrigger('/workflowfoo goal')).toBeNull();
    expect(parseWorkflowGrillTrigger('/template run old')).toBeNull();
  });

  it('builds the skill-directed prompt', () => {
    const prompt = buildWorkflowGrillPrompt('调研三家竞品');
    expect(prompt).toContain('botmux-workflow');
    expect(prompt).toContain('调研三家竞品');
  });

  it('births one exact chat-bound run for a retried Lark message', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'workflow-ingress-birth-'));
    const input = {
      goal: '收口', larkAppId: 'cli_test', chatId: 'oc_chat', chatType: 'group' as const,
      rootMessageId: 'om_root', sessionId: 'session-1', ownerOpenId: 'ou_owner',
      messageId: 'om_message', baseDir,
    };
    try {
      const first = birthWorkflowGrillRun(input);
      const replay = birthWorkflowGrillRun(input);
      expect(replay).toEqual(first);
      const prompt = buildWorkflowGrillPrompt(input.goal, first);
      expect(prompt).toContain(first.runId);
      expect(prompt).toContain(first.specPath);
      expect(prompt).toContain('不要再次执行 `botmux workflow new`');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a deterministic ingress run id is rebound', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'workflow-ingress-conflict-'));
    const input = {
      goal: '收口', larkAppId: 'cli_test', chatId: 'oc_chat', chatType: 'group' as const,
      rootMessageId: 'om_root', sessionId: 'session-1', ownerOpenId: 'ou_owner',
      messageId: 'om_message', baseDir,
    };
    try {
      birthWorkflowGrillRun(input);
      expect(() => birthWorkflowGrillRun({ ...input, sessionId: 'session-2' }))
        .toThrow(/workflow_ingress_run_conflict/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['malformed JSON', '{'],
    ['empty JSON', ''],
    ['non-object JSON', '[]'],
    ['invalid object JSON', '{"schemaVersion":999}'],
  ])('fails closed without rewriting %s ingress state', (_label, corruptState) => {
    const baseDir = mkdtempSync(join(tmpdir(), 'workflow-ingress-corrupt-'));
    const input = {
      goal: '收口', larkAppId: 'cli_test', chatId: 'oc_chat', chatType: 'group' as const,
      rootMessageId: 'om_root', sessionId: 'session-1', ownerOpenId: 'ou_owner',
      messageId: 'om_message', baseDir,
    };
    try {
      const first = birthWorkflowGrillRun(input);
      const statePath = join(baseDir, first.runId, 'grill.state.json');
      writeFileSync(statePath, corruptState);
      expect(() => birthWorkflowGrillRun({
        ...input, goal: 'changed', sessionId: 'session-2', ownerOpenId: 'ou_other',
      })).toThrow(`workflow_ingress_run_corrupt:${first.runId}`);
      expect(readFileSync(statePath, 'utf8')).toBe(corruptState);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it.each(['spec.md', 'dag.json', 'journal.ndjson', 'run.json'])(
    'fails closed when %s remains but grill.state.json is missing',
    artifact => {
      const baseDir = mkdtempSync(join(tmpdir(), 'workflow-ingress-orphan-'));
      const input = {
        goal: '收口', larkAppId: 'cli_test', chatId: 'oc_chat', chatType: 'group' as const,
        rootMessageId: 'om_root', sessionId: 'session-1', ownerOpenId: 'ou_owner',
        messageId: 'om_message', baseDir,
      };
      try {
        const first = birthWorkflowGrillRun(input);
        const runDir = join(baseDir, first.runId);
        rmSync(join(runDir, 'grill.state.json'));
        writeFileSync(join(runDir, artifact), 'preserve');
        expect(() => birthWorkflowGrillRun({
          ...input, goal: 'changed', sessionId: 'session-2', ownerOpenId: 'ou_other',
        })).toThrow(`workflow_ingress_run_corrupt:${first.runId}`);
        expect(readFileSync(join(runDir, artifact), 'utf8')).toBe('preserve');
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
  );

  it('audits a closed-session rebind only while the run is untouched', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'workflow-ingress-rebind-'));
    const input = {
      goal: '收口', larkAppId: 'cli_test', chatId: 'oc_chat', chatType: 'group' as const,
      rootMessageId: 'om_root', sessionId: 'session-1', ownerOpenId: 'ou_owner',
      messageId: 'om_message', baseDir,
    };
    try {
      const first = birthWorkflowGrillRun(input);
      const rebound = birthWorkflowGrillRun({
        ...input, sessionId: 'session-2', isSessionClosed: id => id === 'session-1',
      });
      const state = JSON.parse(readFileSync(join(baseDir, first.runId, 'grill.state.json'), 'utf8'));
      expect(rebound.runId).toBe(first.runId);
      expect(state.chatBinding.sessionId).toBe('session-2');
      expect(state.ingressRebindings).toEqual([expect.objectContaining({
        previousSessionId: 'session-1',
        newSessionId: 'session-2',
        reason: 'previous_session_closed_before_execution',
      })]);

      writeFileSync(join(baseDir, first.runId, 'spec.md'), 'started');
      expect(() => birthWorkflowGrillRun({
        ...input, sessionId: 'session-3', isSessionClosed: () => true,
      })).toThrow(`workflow_ingress_run_conflict:${first.runId}`);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('does not rebind without durable proof that the previous session is closed', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'workflow-ingress-open-session-'));
    const input = {
      goal: '收口', larkAppId: 'cli_test', chatId: 'oc_chat', chatType: 'group' as const,
      rootMessageId: 'om_root', sessionId: 'session-1', ownerOpenId: 'ou_owner',
      messageId: 'om_message', baseDir,
    };
    try {
      const first = birthWorkflowGrillRun(input);
      expect(() => birthWorkflowGrillRun({
        ...input, sessionId: 'session-2', isSessionClosed: () => false,
      })).toThrow(`workflow_ingress_run_conflict:${first.runId}`);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe('/template retirement tombstone', () => {
  it('recognizes the namespace without matching lookalikes', () => {
    expect(isLegacyTemplateCommand('/template')).toBe(true);
    expect(isLegacyTemplateCommand('/template run old')).toBe(true);
    expect(isLegacyTemplateCommand('/templatefoo run old')).toBe(false);
  });

  it('provides an actionable stable retirement message', () => {
    expect(LEGACY_TEMPLATE_RETIRED_MESSAGE).toContain('v2 workflow 已下线');
    expect(LEGACY_TEMPLATE_RETIRED_MESSAGE).toContain('botmux template migrate-v3');
    expect(LEGACY_TEMPLATE_RETIRED_MESSAGE).toContain('/workflow run');
  });
});
