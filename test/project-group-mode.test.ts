import { buildProjectGroupCard, buildProjectGroupStartedNoticeCard } from '../src/im/lark/project-group-card.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProjectCoordinatorAction,
  projectWorkstreamReviewerAuthorizationPrompt,
  ProjectCoordinator,
  type ProjectCoordinatorTransport,
} from '../src/services/project-coordinator.js';
import * as projectCoordinatorModule from '../src/services/project-coordinator.js';
import {
  activateTaskControlTurnAdmissionSync,
  claimTaskControlTurnAdmissionPendingSync,
} from '../src/core/dispatch-registry.js';
import {
  mutateProjectGroup,
  projectCompletionGateFingerprint,
  projectOverallProgress,
  projectRemainingSummary,
  projectTaskControlCanaryFenceFingerprint,
  readProjectGroup,
  refreshProjectBlockerProjection,
} from '../src/services/project-group-store.js';
import type { ProjectDispatchReservationProofV1 } from '../src/services/task-control-plane-project-group-mapping-source.js';
import {
  readGroupCollaborationMode,
  writeGroupCollaborationMode,
} from '../src/services/group-collaboration-mode-store.js';
import { parseProjectArgs } from '../src/cli/project-args.js';
import { planProjectGroupTaskControlReconciliation } from '../src/services/task-control-plane-project-group-audit.js';
import { evaluateProjectCompletionGate } from '../src/services/project-group-completion-gate.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-project-group-'));
  roots.push(dataDir);
  const cards: string[] = [];
  let sentCards = 0;
  const transport: ProjectCoordinatorTransport = {
    sendCard: vi.fn(async (_appId, _chatId, cardJson) => {
      cards.push(cardJson);
      sentCards += 1;
      return `om_card_${sentCards}`;
    }),
    updateCard: vi.fn(async (_appId, _messageId, cardJson) => { cards.push(cardJson); }),
    pinMessage: vi.fn(async () => true),
    unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async (_appId, root) => root === 'om_subtask' ? 'omt_topic' : null),
    isMessageWithdrawn: error => error instanceof Error && error.message === 'withdrawn',
    isMessageUpdateExpired: error => error instanceof Error && error.name === 'MessageUpdateExpiredError',
    brand: () => 'feishu',
  };
  return {
    dataDir, cards, transport,
    coordinator: new ProjectCoordinator(transport),
    context: { dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_main' },
  };
}

function collectChild(child: ReturnType<typeof spawnTsEvalWithRepoImports>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function phaseABinding(label: string) {
  const failedReportContent = `Phase A failed report: ${label}`;
  const instructionTemplate = `Submit only the frozen Phase A failed report: ${label}`;
  return {
    historicalDispatchRoot: 'om_historical',
    historicalTaskGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    mappedWorkerAppId: 'cli_historical_worker',
    failedReportContent,
    failedReportSha256: createHash('sha256').update(failedReportContent).digest('hex'),
    instructionTemplateVersion: 'TaskControlPhaseAInstruction.v1' as const,
    instructionTemplate,
    instructionTemplateSha256: createHash('sha256').update(instructionTemplate).digest('hex'),
  };
}

describe('project group mode', () => {
  it('builds one stable canonical reviewer replacement authorization prompt', () => {
    expect(projectWorkstreamReviewerAuthorizationPrompt({
      action: 'replace_workstream_reviewer',
      dispatchRoot: ' om_reviewed ', oldReviewerAppId: ' cli_reviewer ',
      newReviewerAppId: ' cli_reviewer_next ', expectedRevision: 17,
      authorizationRef: 'om_authorization', reason: ' 主 reviewer 不可用 ',
    })).toBe('授权执行 BotMux reviewer 变更：{"action":"replace_workstream_reviewer","dispatchRoot":"om_reviewed","oldReviewerAppId":"cli_reviewer","newReviewerAppId":"cli_reviewer_next","expectedRevision":17,"reason":"主 reviewer 不可用"}');
  });

  it('parses workstream archive input while stripping caller-supplied trusted fields', () => {
    expect(parseProjectCoordinatorAction({
      action: 'archive_workstream',
      dispatchRoot: 'om_failed_archive',
      expectedRevision: 1219,
      authorizationRef: 'om_archive_authorization',
      reason: '历史失败已由后续成功批次替代',
      archivedByOpenId: 'ou_forged',
      now: '1900-01-01T00:00:00.000Z',
    })).toEqual({
      action: 'archive_workstream',
      dispatchRoot: 'om_failed_archive',
      expectedRevision: 1219,
      authorizationRef: 'om_archive_authorization',
      reason: '历史失败已由后续成功批次替代',
    });
  });

  it('builds the exact canonical failed-workstream archive authorization prompt', () => {
    const prompt = (projectCoordinatorModule as Record<string, unknown>)
      .projectWorkstreamArchiveAuthorizationPrompt;
    expect(typeof prompt).toBe('function');
    expect((prompt as (action: Record<string, unknown>) => string)({
      action: 'archive_workstream',
      dispatchRoot: ' om_failed_archive ',
      expectedRevision: 1219,
      authorizationRef: 'om_archive_authorization',
      reason: ' 历史失败已由后续成功批次替代 ',
    })).toBe('授权归档 BotMux 历史 failed workstream：{"dispatchRoot":"om_failed_archive","expectedRevision":1219,"reason":"历史失败已由后续成功批次替代"}');
  });

  it('keeps 160 Unicode code points in the canonical archive reason', () => {
    const reason = '😀'.repeat(160);
    const prefix = '授权归档 BotMux 历史 failed workstream：';
    const prompt = projectCoordinatorModule.projectWorkstreamArchiveAuthorizationPrompt({
      action: 'archive_workstream', dispatchRoot: 'om_failed_archive', expectedRevision: 1219,
      authorizationRef: 'om_archive_authorization', reason,
    });
    const payload = JSON.parse(prompt.slice(prefix.length));
    expect(payload.reason).toBe(reason);
    expect(Array.from(payload.reason)).toHaveLength(160);
  });

  it('preserves the exact Phase A report proof through project action parsing', () => {
    const phaseAReport = {
      operationId: 'f'.repeat(50), fenceFingerprint: `tccq1:${'a'.repeat(64)}`,
      sourceSessionId: 'session-source', sourceTurnId: 'om_phase_a_instruction',
      workerGeneration: 7, reportRequestId: `report:${'b'.repeat(64)}`,
    };
    expect(parseProjectCoordinatorAction({
      action: 'report', dispatchRoot: 'om_historical', content: 'Phase A failed',
      status: 'failed', reporterAppId: 'cli_worker', phaseAReport,
    })).toMatchObject({ action: 'report', phaseAReport });
  });

  it('migrates legacy blocker strings to schema v3 records without changing the compatibility view', async () => {
    const f = fixture();
    const now = '2026-09-29T00:00:00.000Z';
    writeFileSync(join(f.dataDir, 'project-groups.json'), JSON.stringify({
      schemaVersion: 2,
      projects: {
        [f.context.chatId]: {
          schemaVersion: 2, revision: 4, chatId: f.context.chatId, larkAppId: f.context.larkAppId,
          coordinatorSessionId: f.context.coordinatorSessionId, title: '旧项目', goal: '兼容读取', phase: '执行', focus: '迁移',
          status: 'active', blockers: ['旧阻塞 A', '旧阻塞 B'], workstreams: [], milestones: [], createdAt: now, updatedAt: now,
        },
      },
    }));

    const migrated = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      blockers: ['旧阻塞 A', '旧阻塞 B'],
      blockerRecords: [
        { source: 'manual', summary: '旧阻塞 A' },
        { source: 'manual', summary: '旧阻塞 B' },
      ],
    });

    await f.coordinator.run(f.context, { action: 'update', focus: '写回 v3' });
    expect(JSON.parse(readFileSync(join(f.dataDir, 'project-groups.json'), 'utf8'))).toMatchObject({
      schemaVersion: 3,
      projects: { [f.context.chatId]: { schemaVersion: 3 } },
    });
  });

  it('migrates a schema-v3 project without stage events to an empty event outbox', async () => {
    const f = fixture();
    const now = '2026-10-03T00:00:00.000Z';
    writeFileSync(join(f.dataDir, 'project-groups.json'), JSON.stringify({
      schemaVersion: 3,
      projects: {
        [f.context.chatId]: {
          schemaVersion: 3, revision: 1, chatId: f.context.chatId, larkAppId: f.context.larkAppId,
          coordinatorSessionId: f.context.coordinatorSessionId, title: '阶段推进', goal: '兼容读取',
          phase: '执行', focus: '迁移', status: 'active', blockers: [], blockerRecords: [],
          workstreams: [], milestones: [], createdAt: now, updatedAt: now,
        },
      },
    }));

    expect(readProjectGroup(f.dataDir, f.context.chatId)?.stageAdvanceEvents).toEqual([]);
  });

  it('clears only manual blockers and refuses to close with derived blockers open', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '验证阻塞来源' });
    await f.coordinator.run(f.context, { action: 'update', blocker: '手工阻塞' });
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.blockerRecords.push(
        { blockerId: 'task:1', source: 'task_control', summary: '任务证据不足', openedAt: '2026-09-29T00:00:00.000Z', taskGuid: 'task-1' },
        { blockerId: 'human:1', source: 'human_action', summary: '等待授权', openedAt: '2026-09-29T00:00:01.000Z' },
      );
      refreshProjectBlockerProjection(current!);
      return current;
    });

    const cleared = await f.coordinator.run(f.context, { action: 'update', clearBlockers: true });
    expect(cleared.blockerRecords).toEqual([
      expect.objectContaining({ blockerId: 'human:1', source: 'human_action' }),
      expect.objectContaining({ blockerId: 'task:1', source: 'task_control' }),
    ]);
    expect(cleared.blockers).toEqual(['等待授权', '任务证据不足']);
    await expect(f.coordinator.run(f.context, { action: 'close' }))
      .rejects.toThrow('project_derived_blockers_open');
  });

  it('keeps an unresolved parent completion gate and blocks 100 percent or close', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待两个群完成可信验收' });

    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate',
      gateId: 'botmux-clean-canary',
      sourceChatId: 'oc_child',
      dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111',
      label: 'BotMux clean canary',
      now: '2026-09-29T12:00:00.000Z',
    });

    expect(readProjectGroup(f.dataDir, f.context.chatId)?.completionGates).toEqual([
      expect.objectContaining({
        gateId: 'botmux-clean-canary',
        sourceChatId: 'oc_child',
        dispatchRoot: 'om_child',
        taskGuid: '11111111-1111-4111-8111-111111111111',
        status: 'pending',
      }),
    ]);
    const repeated = await f.coordinator.run(f.context, {
      action: 'add_completion_gate',
      gateId: 'botmux-clean-canary',
      sourceChatId: 'oc_child',
      dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111',
      label: 'BotMux clean canary',
      now: '2026-09-29T12:00:01.000Z',
    });
    expect(repeated.revision).toBe(added.revision);
    await expect(f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'botmux-clean-canary', sourceChatId: 'oc_child',
      dispatchRoot: 'om_child', taskGuid: '11111111-1111-4111-8111-111111111111',
      label: '漂移名称', now: '2026-09-29T12:00:02.000Z',
    })).rejects.toThrow('project_completion_gate_conflict');
    await expect(f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'self', sourceChatId: f.context.chatId,
      dispatchRoot: 'om_self', taskGuid: '11111111-1111-4111-8111-111111111111',
      label: '当前群', now: '2026-09-29T12:00:02.000Z',
    })).rejects.toThrow('project_completion_gate_source_chat_invalid');

    await expect(f.coordinator.run(f.context, { action: 'update', progress: 100 }))
      .rejects.toThrow('project_completion_gates_open');
    await f.coordinator.run(f.context, { action: 'update', blocker: '临时手工阻塞' });
    await f.coordinator.run(f.context, { action: 'update', clearBlockers: true });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.completionGates).toHaveLength(1);
    await expect(f.coordinator.run(f.context, { action: 'close' }))
      .rejects.toThrow('project_completion_gates_open');
  });

  it('retires one exact completion gate with an auditable idempotent transition', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:00:00.000Z',
    });
    const definitionFingerprint = added.completionGates![0]!.definitionFingerprint;

    await expect(f.coordinator.run(f.context, {
      action: 'retire_completion_gate', gateId: 'child', expectedDefinitionFingerprint: definitionFingerprint,
      reason: '由新一轮验收替代', now: '2026-09-29T12:00:30.000Z',
    } as any)).rejects.toThrow('project_completion_gate_authorization_required');
    await expect(f.coordinator.run(f.context, {
      action: 'retire_completion_gate', gateId: 'child', expectedDefinitionFingerprint: definitionFingerprint,
      authorizationRef: 'om_authorization', reason: '由新一轮验收替代', now: '2026-09-29T12:00:30.000Z',
    } as any)).rejects.toThrow('project_completion_gate_authorization_required');
    await expect(f.coordinator.run(f.context, {
      action: 'retire_completion_gate', gateId: 'child', expectedDefinitionFingerprint: definitionFingerprint,
      authorizationRef: 'om_authorization', authorizedByOpenId: 'not-an-open-id',
      reason: '由新一轮验收替代', now: '2026-09-29T12:00:30.000Z',
    } as any)).rejects.toThrow('project_completion_gate_authorization_required');
    await expect(f.coordinator.run(f.context, {
      action: 'retire_completion_gate', gateId: 'child', expectedDefinitionFingerprint: definitionFingerprint,
      authorizationRef: 'not-a-message', authorizedByOpenId: 'ou_authorizer',
      reason: '由新一轮验收替代', now: '2026-09-29T12:00:30.000Z',
    } as any)).rejects.toThrow('project_completion_gate_authorization_required');
    const retired = await f.coordinator.run(f.context, {
      action: 'retire_completion_gate', gateId: 'child', expectedDefinitionFingerprint: definitionFingerprint,
      authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
      reason: '由新一轮验收替代', now: '2026-09-29T12:01:00.000Z',
    } as any);
    expect(retired.completionGates).toEqual([
      expect.objectContaining({
        gateId: 'child', status: 'pending', reason: 'not_evaluated', updatedAt: '2026-09-29T12:01:00.000Z',
        retirement: {
          retiredAt: '2026-09-29T12:01:00.000Z',
          retiredBySessionId: f.context.coordinatorSessionId,
          authorizationRef: 'om_authorization',
          authorizedByOpenId: 'ou_authorizer',
          reason: '由新一轮验收替代',
        },
      }),
    ]);

    const store = join(f.dataDir, 'project-groups.json');
    const beforeRetry = { revision: retired.revision, inode: statSync(store).ino };
    const retry = await f.coordinator.run({ ...f.context, coordinatorSessionId: 'session-new' }, {
      action: 'retire_completion_gate', gateId: 'child', expectedDefinitionFingerprint: definitionFingerprint,
      authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
      reason: '由新一轮验收替代', now: '2026-09-29T12:02:00.000Z',
    } as any);
    expect(retry.revision).toBe(beforeRetry.revision);
    expect(retry.coordinatorSessionId).toBe(f.context.coordinatorSessionId);
    expect(statSync(store).ino).toBe(beforeRetry.inode);
    await expect(f.coordinator.run(f.context, {
      action: 'retire_completion_gate', gateId: 'child', expectedDefinitionFingerprint: definitionFingerprint,
      authorizationRef: 'om_other_authorization', authorizedByOpenId: 'ou_authorizer',
      reason: '由新一轮验收替代', now: '2026-09-29T12:02:00.000Z',
    } as any)).rejects.toThrow('project_completion_gate_retired');

    const afterLateSync = await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint,
      status: 'blocked', reason: 'source_workstream_failed', checkedAt: '2026-09-29T12:03:00.000Z',
    } as any);
    expect(afterLateSync.revision).toBe(beforeRetry.revision);
    expect(afterLateSync.completionGates?.[0]?.retirement).toEqual(retired.completionGates?.[0]?.retirement);

    await expect(f.coordinator.run(f.context, { action: 'update', progress: 100 }))
      .resolves.toMatchObject({ manualProgress: 100 });
    await expect(f.coordinator.run(f.context, { action: 'close' }))
      .resolves.toMatchObject({ status: 'completed' });
  });

  it('atomically replaces one exact completion gate and keeps retry audit stable', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child-v1', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v1',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收 v1', now: '2026-09-29T12:00:00.000Z',
    });
    const definitionFingerprint = added.completionGates![0]!.definitionFingerprint;
    const replacementAction = {
      action: 'replace_completion_gate', gateId: 'child-v1', expectedDefinitionFingerprint: definitionFingerprint,
      newGateId: 'child-v2', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
      taskGuid: '22222222-2222-4222-8222-222222222222', label: '子群验收 v2',
      authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
      reason: '旧任务已失败，改用新一轮验收', now: '2026-09-29T12:01:00.000Z',
    } as const;

    const { authorizationRef: _authorizationRef, ...unauthorizedReplacement } = replacementAction;
    await expect(f.coordinator.run(f.context, unauthorizedReplacement as any))
      .rejects.toThrow('project_completion_gate_authorization_required');
    const replaced = await f.coordinator.run(f.context, replacementAction as any);
    expect(replaced.completionGates).toEqual([
      expect.objectContaining({
        gateId: 'child-v1', updatedAt: '2026-09-29T12:01:00.000Z',
        retirement: expect.objectContaining({
          retiredAt: '2026-09-29T12:01:00.000Z',
          retiredBySessionId: f.context.coordinatorSessionId,
          authorizationRef: 'om_authorization',
          authorizedByOpenId: 'ou_authorizer',
          reason: '旧任务已失败，改用新一轮验收',
          replacementGateId: 'child-v2',
        }),
      }),
      expect.objectContaining({
        gateId: 'child-v2', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
        taskGuid: '22222222-2222-4222-8222-222222222222', label: '子群验收 v2',
        status: 'pending', reason: 'not_evaluated', replacesGateId: 'child-v1',
      }),
    ]);
    await expect(f.coordinator.run(f.context, { action: 'update', progress: 100 }))
      .rejects.toThrow('project_completion_gates_open');

    const store = join(f.dataDir, 'project-groups.json');
    const beforeRetry = { revision: replaced.revision, inode: statSync(store).ino };
    const retry = await f.coordinator.run({ ...f.context, coordinatorSessionId: 'session-new' }, replacementAction as any);
    expect(retry.revision).toBe(beforeRetry.revision);
    expect(retry.coordinatorSessionId).toBe(f.context.coordinatorSessionId);
    expect(statSync(store).ino).toBe(beforeRetry.inode);

    await expect(f.coordinator.run(f.context, {
      ...replacementAction, expectedDefinitionFingerprint: 'pcg1:stale',
    } as any)).rejects.toThrow('project_completion_gate_definition_changed');
    await expect(f.coordinator.run(f.context, {
      ...replacementAction, label: '漂移名称',
    } as any)).rejects.toThrow('project_completion_gate_replacement_conflict');
    await expect(f.coordinator.run(f.context, {
      ...replacementAction, authorizationRef: 'om_other_authorization',
    } as any)).rejects.toThrow('project_completion_gate_replacement_conflict');
    await expect(f.coordinator.run(f.context, {
      ...replacementAction, authorizedByOpenId: 'ou_other_authorizer',
    } as any)).rejects.toThrow('project_completion_gate_replacement_conflict');
  });

  it('does not reactivate a retired gate through add', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:00:00.000Z',
    });
    await f.coordinator.run(f.context, {
      action: 'retire_completion_gate', gateId: 'child',
      expectedDefinitionFingerprint: added.completionGates![0]!.definitionFingerprint,
      authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
      reason: '依赖已取消', now: '2026-09-29T12:01:00.000Z',
    });

    await expect(f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:02:00.000Z',
    })).rejects.toThrow('project_completion_gate_retired');
  });

  it('serializes concurrent retire and replace across independent coordinators', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child-v1', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v1',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收 v1', now: '2026-09-29T12:00:00.000Z',
    });
    const expectedDefinitionFingerprint = added.completionGates![0]!.definitionFingerprint;
    const source = (action: Record<string, unknown>) => `
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      try {
        await coordinator.run({
          dataDir: ${JSON.stringify(f.dataDir)}, chatId: ${JSON.stringify(f.context.chatId)},
          larkAppId: ${JSON.stringify(f.context.larkAppId)}, coordinatorSessionId: 'session-racer',
        }, ${JSON.stringify(action)});
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const children = [
      spawnTsEvalWithRepoImports(source({
        action: 'retire_completion_gate', gateId: 'child-v1', expectedDefinitionFingerprint,
        authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
        reason: '不再需要', now: '2026-09-29T12:01:00.000Z',
      }), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }),
      spawnTsEvalWithRepoImports(source({
        action: 'replace_completion_gate', gateId: 'child-v1', expectedDefinitionFingerprint,
        newGateId: 'child-v2', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
        taskGuid: '22222222-2222-4222-8222-222222222222', label: '子群验收 v2',
        authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
        reason: '改用新一轮验收', now: '2026-09-29T12:01:00.001Z',
      }), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }),
    ];
    const results = await Promise.all(children.map(collectChild));
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    const outcomes = results.map(result => JSON.parse(result.stdout.trim()));
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);
    expect(outcomes.filter(result => !result.ok)).toEqual([
      expect.objectContaining({ error: 'project_completion_gate_retired' }),
    ]);
    const current = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(current.completionGates?.[0]?.retirement).toBeDefined();
    const replacement = current.completionGates?.find(gate => gate.gateId === 'child-v2');
    if (replacement) {
      expect(current.completionGates?.[0]?.retirement?.replacementGateId).toBe('child-v2');
      expect(replacement.replacesGateId).toBe('child-v1');
    } else {
      expect(current.completionGates).toHaveLength(1);
      expect(current.completionGates?.[0]?.retirement?.replacementGateId).toBeUndefined();
    }
  });

  it('demotes a stale 100 percent projection when a gate is added or regresses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    await f.coordinator.run(f.context, { action: 'update', progress: 100 });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:00:00.000Z',
    });
    expect(added.manualProgress).toBe(99);
    const definitionFingerprint = added.completionGates![0]!.definitionFingerprint;
    await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint,
      status: 'satisfied', reason: 'verified', checkedAt: '2026-09-29T12:00:10.000Z',
      validUntil: '2026-09-29T12:05:10.000Z',
      evidence: {
        sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    } as any);
    f.coordinator.setCompletionGateEvaluator(({ gate: currentGate, checkedAt }) => ({
      gateId: currentGate.gateId, definitionFingerprint: currentGate.definitionFingerprint,
      status: 'satisfied', reason: 'verified', checkedAt,
      validUntil: new Date(Date.parse(checkedAt) + 5 * 60_000).toISOString(), evidence: currentGate.evidence,
    }));
    vi.setSystemTime(new Date('2026-09-29T12:00:10.000Z'));
    await f.coordinator.run(f.context, { action: 'update', progress: 100 });
    const regressed = await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint,
      status: 'blocked', reason: 'source_workstream_failed', checkedAt: '2026-09-29T12:00:20.000Z',
    } as any);
    expect(regressed.manualProgress).toBe(99);
  });

  it('accepts only a fresh matching completion-gate evaluation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:00:00.000Z',
    });
    const fingerprint = added.completionGates![0]!.definitionFingerprint;

    await expect(f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint: 'pcg1:stale',
      status: 'satisfied', reason: 'verified', checkedAt: '2026-09-29T12:00:00.000Z',
      validUntil: '2026-09-29T12:05:00.000Z',
      evidence: {
        sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    } as any)).rejects.toThrow('project_completion_gate_definition_changed');

    await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint: fingerprint,
      status: 'satisfied', reason: 'verified', checkedAt: '2026-09-29T12:00:00.000Z',
      validUntil: '2026-09-29T12:05:00.000Z',
      evidence: {
        sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    } as any);
    f.coordinator.setCompletionGateEvaluator(({ gate: currentGate, checkedAt }) => ({
      gateId: currentGate.gateId, definitionFingerprint: currentGate.definitionFingerprint,
      status: 'satisfied', reason: 'verified', checkedAt,
      validUntil: new Date(Date.parse(checkedAt) + 5 * 60_000).toISOString(), evidence: currentGate.evidence,
    }));
    const projectStore = join(f.dataDir, 'project-groups.json');
    const beforeDuplicate = {
      revision: readProjectGroup(f.dataDir, f.context.chatId)!.revision,
      inode: statSync(projectStore).ino,
    };
    const duplicate = await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint: fingerprint,
      status: 'satisfied', reason: 'verified', checkedAt: '2026-09-29T12:00:00.000Z',
      validUntil: '2026-09-29T12:05:00.000Z',
      evidence: {
        sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    } as any);
    expect(duplicate.revision).toBe(beforeDuplicate.revision);
    expect(statSync(projectStore).ino).toBe(beforeDuplicate.inode);
    await expect(f.coordinator.run(f.context, { action: 'update', progress: 100 }))
      .resolves.toMatchObject({ manualProgress: 100 });

    vi.setSystemTime(new Date('2026-09-29T12:05:01.000Z'));
    expect(projectOverallProgress(readProjectGroup(f.dataDir, f.context.chatId)!)).toBe(99);
    f.coordinator.setCompletionGateEvaluator(undefined);
    await expect(f.coordinator.run(f.context, { action: 'close' }))
      .rejects.toThrow('project_completion_gates_open');
  });

  it('rejects an older completion-gate evaluation after a newer result is durable', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:00:00.000Z',
    });
    const definitionFingerprint = added.completionGates![0]!.definitionFingerprint;
    await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint,
      status: 'satisfied', reason: 'verified', checkedAt: '2026-09-29T12:00:10.000Z',
      validUntil: '2026-09-29T12:05:10.000Z',
      evidence: {
        sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    } as any);

    await expect(f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint,
      status: 'pending', reason: 'source_workstream_incomplete', checkedAt: '2026-09-29T12:00:05.000Z',
    } as any)).rejects.toThrow('project_completion_gate_evaluation_stale');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.completionGates?.[0])
      .toMatchObject({ status: 'satisfied', checkedAt: '2026-09-29T12:00:10.000Z' });
  });

  it('does not roll coordinator ownership back from a stale gate-sync context', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:00:00.000Z',
    });
    const definitionFingerprint = added.completionGates![0]!.definitionFingerprint;
    const currentContext = { ...f.context, coordinatorSessionId: 'session-new' };
    await f.coordinator.run(currentContext, { action: 'update', focus: '新会话接管' });
    const synced = await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint,
      status: 'blocked', reason: 'source_workstream_failed', checkedAt: '2026-09-29T12:00:10.000Z',
    } as any);
    expect(synced.coordinatorSessionId).toBe('session-new');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.coordinatorSessionId).toBe('session-new');
  });

  it('does not mutate a parent gate after the project has closed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:00:00.000Z',
    });
    const definitionFingerprint = added.completionGates![0]!.definitionFingerprint;
    await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint,
      status: 'satisfied', reason: 'verified', checkedAt: '2026-09-29T12:00:00.000Z',
      validUntil: '2026-09-29T12:05:00.000Z',
      evidence: {
        sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    } as any);
    f.coordinator.setCompletionGateEvaluator(({ gate: currentGate, checkedAt }) => ({
      gateId: currentGate.gateId, definitionFingerprint: currentGate.definitionFingerprint,
      status: 'satisfied', reason: 'verified', checkedAt,
      validUntil: new Date(Date.parse(checkedAt) + 5 * 60_000).toISOString(), evidence: currentGate.evidence,
    }));
    const closed = await f.coordinator.run(f.context, { action: 'close', now: '2026-09-29T12:00:10.000Z' });
    const afterLateSync = await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint,
      status: 'blocked', reason: 'source_workstream_failed', checkedAt: '2026-09-29T12:00:20.000Z',
    } as any);
    expect(afterLateSync.revision).toBe(closed.revision);
    expect(afterLateSync).toMatchObject({
      status: 'completed', completionGates: [expect.objectContaining({ status: 'satisfied', reason: 'verified' })],
    });
  });

  it('rechecks the source project under the durable parent close boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:00:00.000Z',
    });
    const definitionFingerprint = added.completionGates![0]!.definitionFingerprint;
    await mutateProjectGroup(f.dataDir, 'oc_child', () => ({
      schemaVersion: 3, revision: 1, chatId: 'oc_child', larkAppId: f.context.larkAppId,
      coordinatorSessionId: 'session-child', title: '子项目', goal: '交付', phase: '验收', focus: '完成',
      status: 'active', blockers: [], blockerRecords: [], workstreams: [{
        dispatchRoot: 'om_child', title: '子任务', purpose: '验证', owners: [], status: 'completed', progress: 100,
        createdAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-29T12:00:00.000Z',
      }], completionGates: [], dispatchReservations: [], milestones: [],
      createdAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-29T12:00:00.000Z',
    }));
    f.coordinator.setCompletionGateEvaluator(({ gate: currentGate, sourceProject, checkedAt }) => ({
      gateId: currentGate.gateId,
      definitionFingerprint: currentGate.definitionFingerprint,
      status: sourceProject?.workstreams[0]?.status === 'completed' ? 'satisfied' : 'blocked',
      reason: sourceProject?.workstreams[0]?.status === 'completed' ? 'verified' : 'source_workstream_failed',
      checkedAt,
      ...(sourceProject?.workstreams[0]?.status === 'completed' ? { evidence: {
        sourceProjectRevision: sourceProject.revision, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      }, validUntil: new Date(Date.parse(checkedAt) + 5 * 60_000).toISOString() } : {}),
    }));
    await f.coordinator.run(f.context, {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint,
      status: 'satisfied', reason: 'verified', checkedAt: '2026-09-29T12:00:00.000Z',
      validUntil: '2026-09-29T12:05:00.000Z',
      evidence: {
        sourceProjectRevision: 1, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    } as any);
    await f.coordinator.run(f.context, { action: 'update', progress: 100 });
    await mutateProjectGroup(f.dataDir, 'oc_child', current => {
      current!.workstreams[0]!.status = 'failed';
      current!.workstreams[0]!.progress = 0;
      current!.revision += 1;
      return current;
    });

    await expect(f.coordinator.run(f.context, { action: 'close', now: '2026-09-29T12:00:10.000Z' }))
      .rejects.toThrow('project_completion_gates_open');
  });

  it('requires every declared completion gate before accepting 100 percent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待所有子群可信验收' });
    await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child-a', sourceChatId: 'oc_child_a', dispatchRoot: 'om_child_a',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群 A', now: '2026-09-29T12:00:00.000Z',
    });
    await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child-b', sourceChatId: 'oc_child_b', dispatchRoot: 'om_child_b',
      taskGuid: '22222222-2222-4222-8222-222222222222', label: '子群 B', now: '2026-09-29T12:00:00.000Z',
    });
    const evaluation = (satisfiedGateIds: ReadonlySet<string>) => {
      f.coordinator.setCompletionGateEvaluator(({ gate: currentGate, checkedAt }) => {
        const satisfied = satisfiedGateIds.has(currentGate.gateId);
        return {
          gateId: currentGate.gateId, definitionFingerprint: currentGate.definitionFingerprint,
          status: satisfied ? 'satisfied' as const : 'pending' as const,
          reason: satisfied ? 'verified' : 'source_workstream_incomplete', checkedAt,
          ...(satisfied ? { evidence: {
            sourceProjectRevision: 1, reviewerVerdictId: `rv_${currentGate.gateId}`,
            terminalEventId: `evt_${currentGate.gateId}`, deliveryReceiptId: `rcpt_${currentGate.gateId}`,
          }, validUntil: new Date(Date.parse(checkedAt) + 5 * 60_000).toISOString() } : {}),
        };
      });
    };
    evaluation(new Set(['child-a']));
    await expect(f.coordinator.run(f.context, { action: 'update', progress: 100 }))
      .rejects.toThrow('project_completion_gates_open');
    evaluation(new Set(['child-a', 'child-b']));
    await expect(f.coordinator.run(f.context, { action: 'update', progress: 100 }))
      .resolves.toMatchObject({
        manualProgress: 100,
        completionGates: [expect.objectContaining({ status: 'satisfied' }), expect.objectContaining({ status: 'satisfied' })],
      });
  });

  it('keeps the newest completion-gate evaluation across independent processes', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级项目', goal: '等待子群可信验收' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群验收', now: '2026-09-29T12:00:00.000Z',
    });
    const definitionFingerprint = added.completionGates![0]!.definitionFingerprint;
    const source = (status: 'satisfied' | 'blocked', checkedAt: string) => `
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      try {
        await coordinator.run({
          dataDir: ${JSON.stringify(f.dataDir)}, chatId: ${JSON.stringify(f.context.chatId)},
          larkAppId: ${JSON.stringify(f.context.larkAppId)}, coordinatorSessionId: 'session-child',
        }, {
          action: 'sync_completion_gate', gateId: 'child',
          definitionFingerprint: ${JSON.stringify(definitionFingerprint)},
          status: ${JSON.stringify(status)}, reason: ${JSON.stringify(status === 'satisfied' ? 'verified' : 'source_workstream_failed')},
          checkedAt: ${JSON.stringify(checkedAt)},
          ${status === 'satisfied' ? `validUntil: new Date(Date.parse(${JSON.stringify(checkedAt)}) + 5 * 60_000).toISOString(),` : ''}
          ${status === 'satisfied' ? `evidence: {
            sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
            terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
          },` : ''}
        });
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const children = [
      spawnTsEvalWithRepoImports(source('satisfied', '2026-09-29T12:00:10.000Z'), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }),
      spawnTsEvalWithRepoImports(source('blocked', '2026-09-29T12:00:11.000Z'), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }),
    ];
    const results = await Promise.all(children.map(collectChild));
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.completionGates?.[0])
      .toMatchObject({ status: 'blocked', checkedAt: '2026-09-29T12:00:11.000Z', reason: 'source_workstream_failed' });
  });

  it('persists an exact audit-only reservation and rejects identity drift on retry', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '验证可信预留' });
    const proof: ProjectDispatchReservationProofV1 = {
      schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
      issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:test', signature: 'a'.repeat(64),
    };
    const taskControl = {
      mode: 'audit_only' as const,
      taskGuid: '11111111-1111-4111-8111-111111111111',
      phaseId: 'workstream:11111111-1111-4111-8111-111111111111',
      workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor',
      originTurnId: 'turn-1', proof,
    };
    const reserved = await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'audit', targetAppIds: ['cli_worker', 'cli_reviewer'],
      access: { mode: 'write', scopes: [f.dataDir] }, now: '2026-09-29T00:00:00.000Z', taskControl,
      maxActiveTaskControlMappings: 1,
    });
    expect(reserved.dispatchReservations).toEqual([
      expect.objectContaining({
        reservationId: 'audit', stage: 'reserved',
        taskControl: expect.objectContaining(taskControl),
      }),
    ]);

    const repeated = await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'audit', targetAppIds: ['cli_worker', 'cli_reviewer'],
      access: { mode: 'write', scopes: [f.dataDir] }, now: '2026-09-29T00:00:01.000Z', taskControl,
      maxActiveTaskControlMappings: 1,
    });
    expect(repeated.revision).toBe(reserved.revision);
    await expect(f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'audit', targetAppIds: ['cli_worker', 'cli_reviewer'],
      access: { mode: 'write', scopes: [f.dataDir] }, now: '2026-09-29T00:00:01.000Z',
      maxActiveTaskControlMappings: 1,
      taskControl: { ...taskControl, acceptorAppId: 'cli_other' },
    })).rejects.toThrow('project_dispatch_reservation_conflict');
  });

  it('installs one deterministic pre-bound canary fence only when the reservation array is exactly empty', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '预绑定单 root fence' });
    mkdirSync(join(f.dataDir, 'src'));
    mkdirSync(join(f.dataDir, 'test'));
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.dispatchReservations!.push({
        reservationId: 'foreign-expired-root', targetAppIds: ['cli_foreign'], access: { mode: 'read_only' },
        createdAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-09-29T00:01:00.000Z',
        stage: 'root_created', dispatchRoot: 'om_foreign', rootCreateTime: '2026-09-29T00:00:01.000Z',
      });
      return current;
    });
    const fence = {
      dispatchOperationId: '1'.repeat(50),
      taskGuid: '11111111-1111-4111-8111-111111111111',
      coordinatorSessionId: f.context.coordinatorSessionId,
      originTurnId: 'om_authorized_turn',
      authorizationRef: 'om_authorized_turn',
      authorizedByOpenId: 'ou_authorized',
      planSha256: 'a'.repeat(64),
      controllerAppId: f.context.larkAppId,
      workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor',
      targetChatId: f.context.chatId,
      targetAppIds: ['cli_reviewer', 'cli_worker'],
      writeScopes: [join(f.dataDir, 'src'), join(f.dataDir, 'test')],
      title: '无文件 canary', purpose: '验证 one-root fence', owners: ['Reviewer', 'Worker'],
      botOpenIds: ['ou_reviewer', 'ou_worker'], acceptanceRequested: true,
      seedText: '冻结的 canary seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('one-root fence'),
    };
    await expect(f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-29T00:10:00.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_requires_zero_reservations');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations)
      .toEqual([expect.objectContaining({ reservationId: 'foreign-expired-root', stage: 'root_created' })]);

    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.dispatchReservations = [];
      return current;
    });
    const canonical = {
      schemaVersion: 'TaskControlCanaryFence.v1',
      dispatchOperationId: fence.dispatchOperationId, taskGuid: fence.taskGuid,
      coordinatorSessionId: fence.coordinatorSessionId, originTurnId: fence.originTurnId,
      authorizationRef: fence.authorizationRef, authorizedByOpenId: fence.authorizedByOpenId,
      planSha256: fence.planSha256, controllerAppId: fence.controllerAppId,
      workerAppId: fence.workerAppId, reviewerAppId: fence.reviewerAppId, acceptorAppId: fence.acceptorAppId,
      targetChatId: fence.targetChatId, targetAppIds: ['cli_reviewer', 'cli_worker'],
      writeScopes: [join(f.dataDir, 'src'), join(f.dataDir, 'test')], title: fence.title,
      purpose: fence.purpose, owners: ['Reviewer', 'Worker'], botOpenIds: ['ou_reviewer', 'ou_worker'],
      acceptanceRequested: true, seedText: fence.seedText, taskControlMode: 'audit_only',
      phaseA: fence.phaseA,
    };
    const fingerprint = `tccq1:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
    const installed = await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-29T00:10:00.000Z',
    } as any);
    expect(installed.blockerRecords).toContainEqual(expect.objectContaining({
      source: 'task_control', code: 'task_control_canary_quarantine', taskGuid: fence.taskGuid,
      eventId: fence.dispatchOperationId,
      summary: JSON.stringify({ ...canonical, fingerprint }),
    }));
    const repeated = await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence',
      fence: {
        ...fence,
        targetAppIds: [...fence.targetAppIds].reverse(), writeScopes: [...fence.writeScopes].reverse(),
        owners: [...fence.owners].reverse(), botOpenIds: [...fence.botOpenIds].reverse(),
      },
      now: '2026-09-29T00:11:00.000Z',
    } as any);
    expect(repeated.revision).toBe(installed.revision);
    expect(repeated.blockerRecords.filter(record => record.code === 'task_control_canary_quarantine')).toHaveLength(1);
  });

  it('checks the canary fence before an existing reservation idempotency fast path', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '拒绝 fence 后的旧 reservation replay' });
    mkdirSync(join(f.dataDir, 'scope'));
    const fence = {
      dispatchOperationId: '8'.repeat(50), taskGuid: '88888888-8888-4888-8888-888888888888',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_fence_reservation',
      authorizationRef: 'om_fence_reservation', authorizedByOpenId: 'ou_authorized', planSha256: '8'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [join(f.dataDir, 'scope')], title: '无文件 canary', purpose: '验证 reservation fence',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 reservation seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('reservation fence'),
    };
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    } as any);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.dispatchReservations!.push({
        reservationId: 'foreign-existing', targetAppIds: ['cli_foreign'], access: { mode: 'read_only' },
        createdAt: '2026-09-30T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z',
      });
      return current;
    });

    await expect(f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'foreign-existing', targetAppIds: ['cli_foreign'],
      access: { mode: 'read_only' }, now: '2026-09-30T00:01:00.000Z',
    })).rejects.toThrow('project_task_control_canary_fence_rejects_reservation');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations)
      .toEqual([expect.objectContaining({ reservationId: 'foreign-existing' })]);
  });

  it('keeps the exact fenced reservation idempotent after expiry without pruning or reissue', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '保留过期的 fenced reservation' });
    const scope = join(f.dataDir, 'scope');
    mkdirSync(scope);
    const fence = {
      dispatchOperationId: '9'.repeat(50), taskGuid: '99999999-9999-4999-8999-999999999999',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_fence_exact',
      authorizationRef: 'om_fence_exact', authorizedByOpenId: 'ou_authorized', planSha256: '9'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [scope], title: '无文件 canary', purpose: '验证 expired reservation',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 exact seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('expired reservation'),
    };
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    } as any);
    const taskControl = {
      mode: 'audit_only' as const, taskGuid: fence.taskGuid, phaseId: `workstream:${fence.taskGuid}`,
      workerAppId: fence.workerAppId, reviewerAppId: fence.reviewerAppId, acceptorAppId: fence.acceptorAppId,
      coordinatorSessionId: fence.coordinatorSessionId, originTurnId: fence.originTurnId,
      proof: {
        schemaVersion: 'ProjectDispatchReservationProof.v1' as const, larkAppId: f.context.larkAppId,
        issuedAt: '2026-09-30T00:00:00.000Z', keyId: 'tcpr1:fenced', signature: '9'.repeat(64),
      },
      recovery: {
        title: fence.title, purpose: fence.purpose, owners: fence.owners,
        botOpenIds: fence.botOpenIds, acceptanceRequested: fence.acceptanceRequested, seedText: fence.seedText,
      },
    };
    const reserve = (now: string) => f.coordinator.run(f.context, {
      action: 'reserve_dispatch' as const, reservationId: fence.dispatchOperationId,
      targetAppIds: fence.targetAppIds, access: { mode: 'write' as const, scopes: fence.writeScopes },
      now, ttlMs: 60_000, taskControl, maxActiveTaskControlMappings: 1,
      getTaskControlMappingDecision: () => ({ capacityReleased: false, admissionSafe: false }),
    });

    const first = await reserve('2026-09-30T00:00:01.000Z');
    const repeated = await reserve('2026-09-30T00:02:01.000Z');
    expect(repeated.revision).toBe(first.revision);
    expect(repeated.dispatchReservations).toEqual(first.dispatchReservations);
    expect(repeated.dispatchReservations).toEqual([
      expect.objectContaining({
        reservationId: fence.dispatchOperationId,
        createdAt: '2026-09-30T00:00:01.000Z', expiresAt: '2026-09-30T00:01:01.000Z',
      }),
    ]);
  });

  it('rejects a matching reservation id when the persisted fence fingerprint is not canonical', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '校验 fence fingerprint' });
    const scope = join(f.dataDir, 'scope');
    mkdirSync(scope);
    const fence = {
      dispatchOperationId: 'a'.repeat(50), taskGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_fence_fingerprint',
      authorizationRef: 'om_fence_fingerprint', authorizedByOpenId: 'ou_authorized', planSha256: 'a'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [scope], title: '无文件 canary', purpose: '验证 fingerprint',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 fingerprint seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('fingerprint'),
    };
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    } as any);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      const record = current!.blockerRecords.find(item => item.code === 'task_control_canary_quarantine')!;
      const summary = JSON.parse(record.summary);
      record.summary = JSON.stringify({ ...summary, fingerprint: `tccq1:${'0'.repeat(64)}` });
      return current;
    });

    await expect(f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: fence.dispatchOperationId,
      targetAppIds: fence.targetAppIds, access: { mode: 'write', scopes: fence.writeScopes },
      now: '2026-09-30T00:01:00.000Z',
      taskControl: {
        mode: 'audit_only', taskGuid: fence.taskGuid, phaseId: `workstream:${fence.taskGuid}`,
        workerAppId: fence.workerAppId, reviewerAppId: fence.reviewerAppId, acceptorAppId: fence.acceptorAppId,
        coordinatorSessionId: fence.coordinatorSessionId, originTurnId: fence.originTurnId,
        proof: {
          schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
          issuedAt: '2026-09-30T00:00:00.000Z', keyId: 'tcpr1:fenced', signature: 'a'.repeat(64),
        },
        recovery: {
          title: fence.title, purpose: fence.purpose, owners: fence.owners,
          botOpenIds: fence.botOpenIds, acceptanceRequested: fence.acceptanceRequested, seedText: fence.seedText,
        },
      },
      maxActiveTaskControlMappings: 1,
      getTaskControlMappingDecision: () => ({ capacityReleased: false, admissionSafe: false }),
    } as any)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations).toEqual([]);
  });

  it.each([
    'ordinary access', 'task guid', 'coordinator session', 'origin turn',
    'role assignment', 'write scope', 'dispatch recovery',
  ] as const)('rejects a matching reservation id when %s drifts from the fence', async drift => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '校验 exact fenced reservation' });
    const scope = join(f.dataDir, 'scope');
    const otherScope = join(f.dataDir, 'other-scope');
    mkdirSync(scope);
    mkdirSync(otherScope);
    const fence = {
      dispatchOperationId: 'c'.repeat(50), taskGuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_fence_exact_facts',
      authorizationRef: 'om_fence_exact_facts', authorizedByOpenId: 'ou_authorized', planSha256: 'c'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [scope], title: '无文件 canary', purpose: '验证 exact facts',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 exact facts seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('exact facts'),
    };
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    } as any);
    const action: any = {
      action: 'reserve_dispatch', reservationId: fence.dispatchOperationId,
      targetAppIds: fence.targetAppIds, access: { mode: 'write', scopes: fence.writeScopes },
      now: '2026-09-30T00:01:00.000Z', maxActiveTaskControlMappings: 1,
      getTaskControlMappingDecision: () => ({ capacityReleased: false, admissionSafe: false }),
      taskControl: {
        mode: 'audit_only', taskGuid: fence.taskGuid, phaseId: `workstream:${fence.taskGuid}`,
        workerAppId: fence.workerAppId, reviewerAppId: fence.reviewerAppId, acceptorAppId: fence.acceptorAppId,
        coordinatorSessionId: fence.coordinatorSessionId, originTurnId: fence.originTurnId,
        proof: {
          schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
          issuedAt: '2026-09-30T00:00:00.000Z', keyId: 'tcpr1:fenced', signature: 'c'.repeat(64),
        },
        recovery: {
          title: fence.title, purpose: fence.purpose, owners: fence.owners,
          botOpenIds: fence.botOpenIds, acceptanceRequested: fence.acceptanceRequested, seedText: fence.seedText,
        },
      },
    };
    let context = f.context;
    if (drift === 'ordinary access') {
      action.access = { mode: 'read_only' };
      delete action.taskControl;
    } else if (drift === 'task guid') {
      action.taskControl.taskGuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      action.taskControl.phaseId = 'workstream:dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    } else if (drift === 'coordinator session') {
      context = { ...f.context, coordinatorSessionId: 'session_foreign' };
    } else if (drift === 'origin turn') {
      action.taskControl.originTurnId = 'om_foreign_origin';
    } else if (drift === 'role assignment') {
      action.targetAppIds = ['cli_foreign_worker', fence.reviewerAppId];
      action.taskControl.workerAppId = 'cli_foreign_worker';
    } else if (drift === 'write scope') {
      action.access = { mode: 'write', scopes: [otherScope] };
    } else {
      action.taskControl.recovery.title = 'drifted title';
    }

    await expect(f.coordinator.run(context, action))
      .rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations).toEqual([]);
  });

  it.each(['bind_dispatch_root', 'commit_dispatch'] as const)(
    'rejects a foreign pre-existing reservation during %s while fenced',
    async actionName => {
      const f = fixture();
      await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '阻止 foreign reservation 前进' });
      const scope = join(f.dataDir, 'scope');
      mkdirSync(scope);
      const fence = {
        dispatchOperationId: 'b'.repeat(50), taskGuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_fence_foreign',
        authorizationRef: 'om_fence_foreign', authorizedByOpenId: 'ou_authorized', planSha256: 'b'.repeat(64),
        controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
        reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
        targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
        writeScopes: [scope], title: '无文件 canary', purpose: '验证 foreign reservation',
        owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
        acceptanceRequested: true, seedText: '冻结 foreign seed', taskControlMode: 'audit_only' as const,
        phaseA: phaseABinding('foreign reservation'),
      };
      await f.coordinator.run(f.context, {
        action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
      } as any);
      await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
        current!.dispatchReservations!.push({
          reservationId: 'foreign-existing', targetAppIds: ['cli_foreign'], access: { mode: 'read_only' },
          createdAt: '2026-09-30T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z',
          stage: 'root_created', dispatchRoot: 'om_foreign', rootCreateTime: '2026-09-30T00:00:01.000Z',
        });
        return current;
      });

      const action = actionName === 'bind_dispatch_root'
        ? {
            action: actionName, reservationId: 'foreign-existing', targetAppIds: ['cli_foreign'],
            dispatchRoot: 'om_foreign', rootCreateTime: '2026-09-30T00:00:01.000Z',
          }
        : {
            action: actionName, reservationId: 'foreign-existing', targetAppIds: ['cli_foreign'],
            dispatchRoot: 'om_foreign', title: 'foreign task',
          };
      await expect(f.coordinator.run(f.context, action as any))
        .rejects.toThrow('project_task_control_canary_fence_rejects_reservation');
      expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations)
        .toEqual([expect.objectContaining({ reservationId: 'foreign-existing', dispatchRoot: 'om_foreign' })]);
      expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams).toEqual([]);
    },
  );

  it.each(['bind_dispatch_root', 'commit_dispatch'] as const)(
    'revalidates exact persisted reservation facts during %s while fenced',
    async actionName => {
      const f = fixture();
      await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '重查 persisted reservation facts' });
      const scope = join(f.dataDir, 'scope');
      mkdirSync(scope);
      const fence = {
        dispatchOperationId: 'd'.repeat(50), taskGuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_fence_persisted',
        authorizationRef: 'om_fence_persisted', authorizedByOpenId: 'ou_authorized', planSha256: 'd'.repeat(64),
        controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
        reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
        targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
        writeScopes: [scope], title: '无文件 canary', purpose: '验证 persisted facts',
        owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
        acceptanceRequested: true, seedText: '冻结 persisted seed', taskControlMode: 'audit_only' as const,
        phaseA: phaseABinding('persisted facts'),
      };
      await f.coordinator.run(f.context, {
        action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
      } as any);
      await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
        current!.dispatchReservations!.push({
          reservationId: fence.dispatchOperationId, targetAppIds: [...fence.targetAppIds].sort(),
          access: { mode: 'write', scopes: fence.writeScopes },
          createdAt: '2026-09-30T00:00:01.000Z', expiresAt: '2026-10-01T00:00:00.000Z',
          stage: 'root_created', dispatchRoot: 'om_exact_root', rootCreateTime: '2026-09-30T00:00:02.000Z',
          taskControl: {
            mode: 'audit_only', taskGuid: fence.taskGuid, phaseId: `workstream:${fence.taskGuid}`,
            workerAppId: fence.workerAppId, reviewerAppId: fence.reviewerAppId, acceptorAppId: fence.acceptorAppId,
            coordinatorSessionId: fence.coordinatorSessionId, originTurnId: 'om_drifted_origin',
            proof: {
              schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
              issuedAt: '2026-09-30T00:00:00.000Z', keyId: 'tcpr1:fenced', signature: 'd'.repeat(64),
            },
            recovery: {
              title: fence.title, purpose: fence.purpose, owners: fence.owners,
              botOpenIds: fence.botOpenIds, acceptanceRequested: fence.acceptanceRequested, seedText: fence.seedText,
            },
          },
        });
        return current;
      });

      const action = actionName === 'bind_dispatch_root'
        ? {
            action: actionName, reservationId: fence.dispatchOperationId, targetAppIds: fence.targetAppIds,
            dispatchRoot: 'om_exact_root', rootCreateTime: '2026-09-30T00:00:02.000Z',
          }
        : {
            action: actionName, reservationId: fence.dispatchOperationId, targetAppIds: fence.targetAppIds,
            dispatchRoot: 'om_exact_root', title: fence.title, purpose: fence.purpose,
            owners: fence.owners, workerAppIds: [fence.workerAppId], reviewerAppIds: [fence.reviewerAppId],
          };
      await expect(f.coordinator.run(f.context, action as any))
        .rejects.toThrow('project_task_control_canary_fence_conflict');
      expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations)
        .toEqual([expect.objectContaining({ reservationId: fence.dispatchOperationId, dispatchRoot: 'om_exact_root' })]);
      expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams).toEqual([]);
    },
  );

  it('allows the exact fenced reservation to bind idempotently and commit once', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '推进 exact fenced reservation' });
    const scope = join(f.dataDir, 'scope');
    mkdirSync(scope);
    const fence = {
      dispatchOperationId: 'e'.repeat(50), taskGuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_fence_lifecycle',
      authorizationRef: 'om_fence_lifecycle', authorizedByOpenId: 'ou_authorized', planSha256: 'e'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [scope], title: '无文件 canary', purpose: '验证 exact lifecycle',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 lifecycle seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('exact lifecycle'),
    };
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    } as any);
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: fence.dispatchOperationId,
      targetAppIds: fence.targetAppIds, access: { mode: 'write', scopes: fence.writeScopes },
      now: '2026-09-30T00:00:01.000Z', maxActiveTaskControlMappings: 1,
      getTaskControlMappingDecision: () => ({ capacityReleased: false, admissionSafe: false }),
      taskControl: {
        mode: 'audit_only', taskGuid: fence.taskGuid, phaseId: `workstream:${fence.taskGuid}`,
        workerAppId: fence.workerAppId, reviewerAppId: fence.reviewerAppId, acceptorAppId: fence.acceptorAppId,
        coordinatorSessionId: fence.coordinatorSessionId, originTurnId: fence.originTurnId,
        proof: {
          schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
          issuedAt: '2026-09-30T00:00:00.000Z', keyId: 'tcpr1:fenced', signature: 'e'.repeat(64),
        },
        recovery: {
          title: fence.title, purpose: fence.purpose, owners: fence.owners,
          botOpenIds: fence.botOpenIds, acceptanceRequested: fence.acceptanceRequested, seedText: fence.seedText,
        },
      },
    } as any);
    const bound = await f.coordinator.run(f.context, {
      action: 'bind_dispatch_root', reservationId: fence.dispatchOperationId, targetAppIds: fence.targetAppIds,
      dispatchRoot: 'om_exact_fenced_root', rootCreateTime: '2026-09-30T00:00:02.000Z',
    } as any);
    const rebound = await f.coordinator.run(f.context, {
      action: 'bind_dispatch_root', reservationId: fence.dispatchOperationId, targetAppIds: fence.targetAppIds,
      dispatchRoot: 'om_exact_fenced_root', rootCreateTime: '2026-09-30T00:00:02.000Z',
    } as any);
    expect(rebound.revision).toBe(bound.revision);

    const recovery = planProjectGroupTaskControlReconciliation({
      project: rebound, now: Date.parse('2026-09-30T00:00:03.000Z'),
      acceptanceTimeoutMs: 30 * 60_000, staleExecutionMs: 30 * 60_000,
      reader: {
        listTrustedMappings: () => [], getTaskProjection: () => ({} as any),
        listEvents: () => [], listOutbox: () => [],
      },
      findDispatchOperation: () => undefined,
    }).actions[0];
    expect(recovery).toMatchObject({
      kind: 'recover_dispatch', reservationId: fence.dispatchOperationId,
      dispatchRoot: 'om_exact_fenced_root', bindRoot: false, registryMissing: true,
    });
    if (!recovery || recovery.kind !== 'recover_dispatch') throw new Error('expected recover_dispatch');

    await expect(f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: recovery.reservationId, targetAppIds: recovery.targetAppIds,
      dispatchRoot: recovery.dispatchRoot, title: 'drifted recovery title',
      purpose: recovery.purpose, owners: recovery.owners,
      workerAppIds: recovery.workerAppIds, reviewerAppIds: recovery.reviewerAppIds,
    } as any)).rejects.toThrow('project_task_control_canary_fence_conflict');

    const committed = await f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: recovery.reservationId, targetAppIds: recovery.targetAppIds,
      dispatchRoot: recovery.dispatchRoot, title: recovery.title, purpose: recovery.purpose, owners: recovery.owners,
      workerAppIds: recovery.workerAppIds, reviewerAppIds: recovery.reviewerAppIds,
    } as any);
    expect(committed.dispatchReservations).toEqual([]);
    expect(committed.workstreams).toEqual([
      expect.objectContaining({
        dispatchRoot: 'om_exact_fenced_root', title: fence.title,
        taskControl: expect.objectContaining({
          taskGuid: fence.taskGuid, originTurnId: fence.originTurnId,
          reservationId: fence.dispatchOperationId,
        }),
      }),
    ]);
    expect(committed.blockerRecords).toContainEqual(expect.objectContaining({
      code: 'task_control_canary_quarantine', eventId: fence.dispatchOperationId,
    }));
  });

  it('serializes a foreign reservation against fence installation across independent processes', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '串行 reserve 与 fence install' });
    const scope = join(f.dataDir, 'scope');
    mkdirSync(scope);
    const fence = {
      dispatchOperationId: 'f'.repeat(50), taskGuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_fence_reserve_race',
      authorizationRef: 'om_fence_reserve_race', authorizedByOpenId: 'ou_authorized', planSha256: 'f'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [scope], title: '无文件 canary', purpose: '验证 reserve/install 竞争',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 reserve race seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('reserve race'),
    };
    const source = (action: Record<string, unknown>) => `
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      try {
        await coordinator.run(${JSON.stringify(f.context)}, ${JSON.stringify(action)});
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const results = await Promise.all([
      collectChild(spawnTsEvalWithRepoImports(source({
        action: 'reserve_dispatch', reservationId: 'foreign-race', targetAppIds: ['cli_foreign'],
        access: { mode: 'read_only' }, now: '2026-09-30T00:01:00.000Z',
      }), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })),
      collectChild(spawnTsEvalWithRepoImports(source({
        action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:01:00.000Z',
      }), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })),
    ]);
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    const outcomes = results.map(result => JSON.parse(result.stdout.trim()));
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);
    expect(outcomes.filter(result => !result.ok)).toEqual([
      expect.objectContaining({
        error: expect.stringMatching(
          /project_task_control_canary_fence_(?:requires_zero_reservations|rejects_reservation)/,
        ),
      }),
    ]);
    const project = readProjectGroup(f.dataDir, f.context.chatId)!;
    const hasFence = project.blockerRecords.some(record => record.code === 'task_control_canary_quarantine');
    const hasReservation = project.dispatchReservations?.some(record => record.reservationId === 'foreign-race');
    expect(Number(hasFence) + Number(hasReservation)).toBe(1);
  }, 10_000);

  it('serializes a final pre-fork admission claim against canary fence installation', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '防止 pre-fork 穿过 fence' });
    mkdirSync(join(f.dataDir, 'src'));
    const historicalTaskGuid = '22222222-2222-4222-8222-222222222222';
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams.push({
        dispatchRoot: 'om_historical', title: '历史 TaskControl', purpose: '等待精确轮次', owners: [],
        targetAppIds: ['cli_worker', 'cli_reviewer'], workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'],
        access: { mode: 'write', scopes: [join(f.dataDir, 'src')] }, status: 'pending', progress: 0,
        taskControl: {
          taskGuid: historicalTaskGuid, phaseId: `workstream:${historicalTaskGuid}`,
          mappingRef: 'topic-message:om_historical', mappingStatus: 'registered', sourceKind: 'project_group',
          controllerAppId: f.context.larkAppId, workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer',
          acceptorAppId: 'cli_acceptor', projectRevision: current!.revision,
          reservationId: '2'.repeat(50), coordinatorSessionId: f.context.coordinatorSessionId,
          originTurnId: 'om_historical_authorization', reservationCreatedAt: '2026-09-29T00:00:00.000Z',
          reservationExpiresAt: '2026-09-29T00:02:00.000Z', rootCreateTime: '2026-09-29T00:00:01.000Z',
          reservationProof: {
            schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
            issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:historical', signature: 'b'.repeat(64),
          },
        },
        createdAt: '2026-09-29T00:00:01.000Z', updatedAt: '2026-09-29T00:00:01.000Z',
      });
      return current;
    });
    writeFileSync(join(f.dataDir, 'orchestrate-dispatch.json'), JSON.stringify({
      om_historical: { dispatchOperationId: '2'.repeat(50), taskControl: { mode: 'audit_only' } },
    }));
    const fence = {
      dispatchOperationId: '3'.repeat(50), taskGuid: '33333333-3333-4333-8333-333333333333',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_authorized_turn',
      authorizationRef: 'om_authorized_turn', authorizedByOpenId: 'ou_authorized', planSha256: 'c'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [join(f.dataDir, 'src')], title: '无文件 canary', purpose: '验证串行门禁',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('turn admission'),
    };
    const claimAction = {
      action: 'claim_task_control_turn_admission',
      claim: {
        messageId: 'om_historical_turn', dispatchRoot: 'om_historical', targetAppId: 'cli_worker',
        sessionId: 'session_worker', workerGeneration: 7,
      },
      now: '2026-09-29T00:10:00.000Z',
    } as const;
    const results = await Promise.allSettled([
      f.coordinator.run(f.context, claimAction as any),
      f.coordinator.run(f.context, {
        action: 'install_task_control_canary_fence', fence, now: '2026-09-29T00:10:00.000Z',
      } as any),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as Error).message).toMatch(
      /project_task_control_canary_fence_(?:turn_claim_open|rejects_turn)/,
    );
    const project = readProjectGroup(f.dataDir, f.context.chatId)!;
    const registry = JSON.parse(readFileSync(join(f.dataDir, 'orchestrate-dispatch.json'), 'utf8')) as any;
    const hasFence = project.blockerRecords.some(record => record.code === 'task_control_canary_quarantine');
    const activeClaims = Object.values(registry.__taskControlTurnAdmissionsV1?.claims ?? {})
      .filter((claim: any) => claim.state === 'pending' || claim.state === 'active');
    expect(Number(hasFence) + activeClaims.length).toBe(1);
  });

  it('serializes claim versus fence across independent processes through the chat outer lock', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    await attachProjectTaskControl(f);
    const fence = {
      dispatchOperationId: '7'.repeat(50), taskGuid: '77777777-7777-4777-8777-777777777777',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_cross_process_authorization',
      authorizationRef: 'om_cross_process_authorization', authorizedByOpenId: 'ou_authorized',
      planSha256: '7'.repeat(64), controllerAppId: f.context.larkAppId,
      workerAppId: 'cli_canary_worker', reviewerAppId: 'cli_canary_reviewer',
      acceptorAppId: 'cli_canary_acceptor', targetChatId: f.context.chatId,
      targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'], writeScopes: [f.dataDir],
      title: '无文件 canary', purpose: '验证跨进程串行', owners: ['Worker', 'Reviewer'],
      botOpenIds: ['ou_worker', 'ou_reviewer'], acceptanceRequested: true,
      seedText: '冻结 cross-process seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('cross-process'),
    };
    const source = (action: Record<string, unknown>) => `
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      try {
        await coordinator.run(${JSON.stringify(f.context)}, ${JSON.stringify(action)});
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const results = await Promise.all([
      collectChild(spawnTsEvalWithRepoImports(source({
        action: 'claim_task_control_turn_admission',
        claim: {
          messageId: 'om_cross_process_turn', dispatchRoot: 'om_reviewed', targetAppId: 'cli_worker',
          sessionId: 'session_worker', workerGeneration: 7,
        },
        now: '2026-09-30T00:01:00.000Z',
      }), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })),
      collectChild(spawnTsEvalWithRepoImports(source({
        action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:01:00.000Z',
      }), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })),
    ]);
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    const outcomes = results.map(result => JSON.parse(result.stdout.trim()));
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);
    expect(outcomes.filter(result => !result.ok)).toEqual([
      expect.objectContaining({
        error: expect.stringMatching(
          /project_task_control_canary_fence_(?:turn_claim_open|rejects_turn)/,
        ),
      }),
    ]);
    const project = readProjectGroup(f.dataDir, f.context.chatId)!;
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    const registry = existsSync(registryPath)
      ? JSON.parse(readFileSync(registryPath, 'utf8')) as any
      : {};
    const hasFence = project.blockerRecords.some(record => record.code === 'task_control_canary_quarantine');
    const openClaims = Object.values(registry.__taskControlTurnAdmissionsV1?.claims ?? {})
      .filter((claim: any) => claim.state === 'pending' || claim.state === 'active');
    expect(Number(hasFence) + openClaims.length).toBe(1);
  }, 10_000);

  it('rejects a late foreign turn before creating a claim when the fence wins first', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    await attachProjectTaskControl(f);
    const fence = {
      dispatchOperationId: '6'.repeat(50), taskGuid: '66666666-6666-4666-8666-666666666666',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_authorized_fence_first',
      authorizationRef: 'om_authorized_fence_first', authorizedByOpenId: 'ou_authorized',
      planSha256: 'f'.repeat(64), controllerAppId: f.context.larkAppId,
      workerAppId: 'cli_canary_worker', reviewerAppId: 'cli_canary_reviewer',
      acceptorAppId: 'cli_canary_acceptor', targetChatId: f.context.chatId,
      targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'], writeScopes: [f.dataDir],
      title: '无文件 canary', purpose: '验证 fence-first', owners: ['Worker', 'Reviewer'],
      botOpenIds: ['ou_worker', 'ou_reviewer'], acceptanceRequested: true,
      seedText: '冻结 fence-first seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('fence-first'),
    };
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    } as any);

    await expect(f.coordinator.run(f.context, {
      action: 'claim_task_control_turn_admission',
      claim: {
        messageId: 'om_late_foreign_turn', dispatchRoot: 'om_reviewed', targetAppId: 'cli_worker',
        sessionId: 'session_worker', workerGeneration: 7,
      },
      now: '2026-09-30T00:01:00.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_rejects_turn');
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    expect(existsSync(registryPath)
      ? JSON.parse(readFileSync(registryPath, 'utf8')).__taskControlTurnAdmissionsV1?.claims ?? {}
      : {}).toEqual({});
  });

  it('keeps an exact canary fence while any foreign admission claim is pending or active', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '验证 fence cleanup 门禁' });
    mkdirSync(join(f.dataDir, 'src'));
    const fence = {
      dispatchOperationId: '5'.repeat(50), taskGuid: '55555555-5555-4555-8555-555555555555',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_authorized_cleanup',
      authorizationRef: 'om_authorized_cleanup', authorizedByOpenId: 'ou_authorized', planSha256: 'e'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [join(f.dataDir, 'src')], title: '无文件 canary', purpose: '验证 cleanup 门禁',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 cleanup seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('cleanup'),
    };
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    } as any);
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence,
      auditOnlyConfirmedAbsent: false, cleanupState: 'pre_dispatch_abort',
      now: '2026-09-30T00:00:01.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_cleanup_requires_absence');
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: { ...fence, planSha256: 'd'.repeat(64) },
      auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
      now: '2026-09-30T00:00:02.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_conflict');
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    const foreignClaim = {
      messageId: 'om_foreign_turn', chatId: f.context.chatId, dispatchRoot: 'om_historical',
      targetAppId: 'cli_worker', sessionId: 'session_foreign', state: 'pending',
      createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
    };
    writeFileSync(registryPath, JSON.stringify({
      __taskControlTurnAdmissionsV1: { claims: { [foreignClaim.messageId]: foreignClaim } },
    }));

    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
      now: '2026-10-30T00:00:00.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_turn_claim_open');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));

    writeFileSync(registryPath, JSON.stringify({
      __taskControlTurnAdmissionsV1: {
        claims: {
          [foreignClaim.messageId]: { ...foreignClaim, state: 'active', workerGeneration: 7 },
        },
      },
    }));
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
      now: '2026-11-30T00:00:00.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_turn_claim_open');

    writeFileSync(registryPath, JSON.stringify({
      __taskControlTurnAdmissionsV1: {
        claims: {
          [foreignClaim.messageId]: {
            ...foreignClaim, state: 'terminal', workerGeneration: 7,
            terminalAt: '2026-09-29T00:01:00.000Z', updatedAt: '2026-09-29T00:01:00.000Z',
          },
        },
      },
    }));
    claimTaskControlTurnAdmissionPendingSync(registryPath, {
      messageId: 'om_other_chat_turn', chatId: 'oc_other', dispatchRoot: 'om_other_root',
      targetAppId: 'cli_other', sessionId: 'session_other',
    }, '2026-11-30T00:00:00.000Z');
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))
      .__taskControlTurnAdmissionsV1.terminalSummaries.om_historical).toMatchObject({ count: 1 });
    const cleared = await f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
      now: '2026-10-30T00:00:00.000Z',
    } as any);
    expect(cleared.blockerRecords).not.toContainEqual(
      expect.objectContaining({ code: 'task_control_canary_quarantine' }),
    );
  });

  it('admits the exact Phase A failed report once and rejects changed reports without mutation', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '锁定 Phase A 报告' });
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams.push({
        dispatchRoot: 'om_historical', title: '历史任务', purpose: '完成失败收敛', owners: ['Worker'],
        targetAppIds: ['cli_historical_worker', 'cli_historical_reviewer'],
        workerAppIds: ['cli_historical_worker'], reviewerAppIds: ['cli_historical_reviewer'],
        access: { mode: 'write', scopes: [f.dataDir] }, status: 'in_progress', progress: 40,
        taskControl: {
          taskGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', phaseId: 'workstream:historical',
          mappingRef: 'mapping:historical', mappingStatus: 'registered', sourceKind: 'project_group',
          controllerAppId: f.context.larkAppId, workerAppId: 'cli_historical_worker',
          reviewerAppId: 'cli_historical_reviewer', acceptorAppId: 'cli_historical_acceptor',
          projectRevision: current!.revision, reservationId: 'h'.repeat(50),
          coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_historical_origin',
          reservationCreatedAt: '2026-09-29T00:00:00.000Z',
          reservationExpiresAt: '2026-09-29T01:00:00.000Z', rootCreateTime: '2026-09-29T00:00:01.000Z',
          reservationProof: {
            schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
            issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:historical', signature: 'a'.repeat(64),
          },
        },
        createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
      });
      return current;
    });
    const fence = {
      dispatchOperationId: 'f'.repeat(50), taskGuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_phase_a_authorization',
      authorizationRef: 'om_phase_a_authorization', authorizedByOpenId: 'ou_authorized', planSha256: 'f'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [f.dataDir], title: '无文件 canary', purpose: '锁定 Phase A 报告',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('report guard'),
    };
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    });
    const fenceFingerprint = projectTaskControlCanaryFenceFingerprint(fence);
    await f.coordinator.run(f.context, {
      action: 'begin_task_control_phase_a_instruction', fenceFingerprint,
      instructionTemplateSha256: fence.phaseA.instructionTemplateSha256,
      attempt: {
        wallTime: '2026-09-30T00:01:00.000Z', bootId: 'boot-1',
        processStartedAt: '2026-09-30T00:00:00.000Z', monotonicMs: 1_234,
      },
    } as any);
    await f.coordinator.run(f.context, {
      action: 'complete_task_control_phase_a_instruction', fenceFingerprint,
      messageId: 'om_phase_a_instruction',
    } as any);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    const claim = {
      messageId: 'om_phase_a_instruction', chatId: f.context.chatId,
      dispatchRoot: fence.phaseA.historicalDispatchRoot,
      targetAppId: fence.phaseA.mappedWorkerAppId, sessionId: 'session_phase_a_worker',
    };
    claimTaskControlTurnAdmissionPendingSync(registryPath, claim, '2026-09-30T00:01:01.000Z');
    activateTaskControlTurnAdmissionSync(
      registryPath, { ...claim, workerGeneration: 7 }, '2026-09-30T00:01:02.000Z',
    );
    const reportRequestId = `report:${createHash('sha256').update(JSON.stringify({
      sourceSessionId: claim.sessionId, sourceTurnId: claim.messageId,
      dispatchRoot: fence.phaseA.historicalDispatchRoot,
      reporterAppId: fence.phaseA.mappedWorkerAppId,
      content: fence.phaseA.failedReportContent,
      projectUpdate: { status: 'failed' },
    })).digest('hex')}`;
    const phaseAReport = {
      operationId: fence.dispatchOperationId,
      fenceFingerprint,
      sourceSessionId: claim.sessionId,
      sourceTurnId: claim.messageId,
      workerGeneration: 7,
      reportRequestId,
    };

    const failed = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: fence.phaseA.historicalDispatchRoot,
      reporterAppId: fence.phaseA.mappedWorkerAppId,
      status: 'failed', content: fence.phaseA.failedReportContent,
      phaseAReport,
    } as any);
    expect(failed.workstreams.find(item => item.dispatchRoot === fence.phaseA.historicalDispatchRoot))
      .toMatchObject({ status: 'failed', blocker: fence.phaseA.failedReportContent });
    const replayed = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: fence.phaseA.historicalDispatchRoot,
      reporterAppId: fence.phaseA.mappedWorkerAppId,
      status: 'failed', content: fence.phaseA.failedReportContent,
      phaseAReport,
    } as any);
    expect(replayed.revision).toBe(failed.revision);
    const beforeChanged = readProjectGroup(f.dataDir, f.context.chatId)!;

    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: fence.phaseA.historicalDispatchRoot,
      reporterAppId: fence.phaseA.mappedWorkerAppId,
      status: 'failed', content: `${fence.phaseA.failedReportContent} changed`,
      phaseAReport: { ...phaseAReport, reportRequestId: `${reportRequestId}-changed` },
    })).rejects.toThrow('project_task_control_phase_a_report_rejected');

    expect(readProjectGroup(f.dataDir, f.context.chatId)).toEqual(beforeChanged);
  });

  it('persists one exact Phase A instruction attempt before the provider side effect', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '锁定 Phase A 指令发送' });
    const fence = {
      dispatchOperationId: 'f'.repeat(50), taskGuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_phase_a_authorization',
      authorizationRef: 'om_phase_a_authorization', authorizedByOpenId: 'ou_authorized', planSha256: 'f'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [f.dataDir], title: '无文件 canary', purpose: '锁定 Phase A 指令发送',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('instruction journal'),
    };
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    });
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    writeFileSync(registryPath, '{}');
    const before = readProjectGroup(f.dataDir, f.context.chatId)!;
    const begin = {
      action: 'begin_task_control_phase_a_instruction',
      fenceFingerprint: projectTaskControlCanaryFenceFingerprint(fence),
      instructionTemplateSha256: fence.phaseA.instructionTemplateSha256,
      attempt: {
        wallTime: '2026-09-30T00:01:00.000Z', bootId: 'boot-1',
        processStartedAt: '2026-09-30T00:00:00.000Z', monotonicMs: 1_234,
      },
    } as const;

    await f.coordinator.run(f.context, begin as any);
    const first = JSON.parse(readFileSync(registryPath, 'utf8'));
    await f.coordinator.run(f.context, begin as any);
    const replayed = JSON.parse(readFileSync(registryPath, 'utf8'));

    expect(first).toMatchObject({
      __taskControlPhaseAOperationsV1: {
        operations: {
          [fence.dispatchOperationId]: {
            schemaVersion: 'TaskControlPhaseAOperation.v1',
            operationId: fence.dispatchOperationId,
            chatId: f.context.chatId,
            fenceFingerprint: begin.fenceFingerprint,
            historicalDispatchRoot: fence.phaseA.historicalDispatchRoot,
            historicalTaskGuid: fence.phaseA.historicalTaskGuid,
            targetAppId: fence.phaseA.mappedWorkerAppId,
            payloadHash: fence.phaseA.instructionTemplateSha256,
            providerUuid: expect.stringMatching(/^[a-f0-9]{50}$/),
            attempt: begin.attempt,
            state: 'pending',
          },
        },
      },
    });
    expect(replayed).toEqual(first);
    expect(readProjectGroup(f.dataDir, f.context.chatId)).toEqual(before);
  });

  it('records only the exact Phase A provider response as delivered', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '记录 Phase A 指令回执' });
    const fence = {
      dispatchOperationId: 'e'.repeat(50), taskGuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_phase_a_authorization',
      authorizationRef: 'om_phase_a_authorization', authorizedByOpenId: 'ou_authorized', planSha256: 'e'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [f.dataDir], title: '无文件 canary', purpose: '记录 Phase A 指令回执',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('instruction receipt'),
    };
    const fenceFingerprint = projectTaskControlCanaryFenceFingerprint(fence);
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    });
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    writeFileSync(registryPath, '{}');
    await f.coordinator.run(f.context, {
      action: 'begin_task_control_phase_a_instruction', fenceFingerprint,
      instructionTemplateSha256: fence.phaseA.instructionTemplateSha256,
      attempt: {
        wallTime: '2026-09-30T00:01:00.000Z', bootId: 'boot-1',
        processStartedAt: '2026-09-30T00:00:00.000Z', monotonicMs: 1_234,
      },
    } as any);
    const before = readProjectGroup(f.dataDir, f.context.chatId)!;
    const delivered = {
      action: 'complete_task_control_phase_a_instruction', fenceFingerprint,
      messageId: 'om_phase_a_instruction',
    } as const;

    await f.coordinator.run(f.context, delivered as any);
    const first = JSON.parse(readFileSync(registryPath, 'utf8'));
    await f.coordinator.run(f.context, delivered as any);

    expect(first.__taskControlPhaseAOperationsV1.operations[fence.dispatchOperationId])
      .toMatchObject({ state: 'delivered', messageId: delivered.messageId });
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toEqual(first);
    expect(readProjectGroup(f.dataDir, f.context.chatId)).toEqual(before);
  });

  it('reuses a pending Phase A attempt only inside the same-process provider window', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '隔离未知 Phase A 发送结果' });
    const fence = {
      dispatchOperationId: 'd'.repeat(50), taskGuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_phase_a_authorization',
      authorizationRef: 'om_phase_a_authorization', authorizedByOpenId: 'ou_authorized', planSha256: 'd'.repeat(64),
      controllerAppId: f.context.larkAppId, workerAppId: 'cli_canary_worker',
      reviewerAppId: 'cli_canary_reviewer', acceptorAppId: 'cli_canary_acceptor',
      targetChatId: f.context.chatId, targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'],
      writeScopes: [f.dataDir], title: '无文件 canary', purpose: '隔离未知 Phase A 发送结果',
      owners: ['Worker', 'Reviewer'], botOpenIds: ['ou_worker', 'ou_reviewer'],
      acceptanceRequested: true, seedText: '冻结 seed', taskControlMode: 'audit_only' as const,
      phaseA: phaseABinding('instruction ambiguity'),
    };
    const fenceFingerprint = projectTaskControlCanaryFenceFingerprint(fence);
    await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence, now: '2026-09-30T00:00:00.000Z',
    });
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    writeFileSync(registryPath, '{}');
    const base = {
      action: 'begin_task_control_phase_a_instruction', fenceFingerprint,
      instructionTemplateSha256: fence.phaseA.instructionTemplateSha256,
    } as const;
    await f.coordinator.run(f.context, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:01:00.000Z', bootId: 'boot-1',
        processStartedAt: '2026-09-30T00:00:00.000Z', monotonicMs: 10_000,
      },
    } as any);

    await f.coordinator.run(f.context, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:54:59.000Z', bootId: 'boot-1',
        processStartedAt: '2026-09-30T00:00:00.000Z', monotonicMs: 3_249_999,
      },
    } as any);
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))
      .__taskControlPhaseAOperationsV1.operations[fence.dispatchOperationId])
      .toMatchObject({ state: 'pending', attempt: { monotonicMs: 10_000 } });

    await f.coordinator.run(f.context, {
      ...base,
      attempt: {
        wallTime: '2026-09-30T00:55:00.000Z', bootId: 'boot-1',
        processStartedAt: '2026-09-30T00:54:59.500Z', monotonicMs: 500,
      },
    } as any);
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))
      .__taskControlPhaseAOperationsV1.operations[fence.dispatchOperationId])
      .toMatchObject({ state: 'ambiguous', attempt: { monotonicMs: 10_000 } });
  });

  it('enforces the audit-only mapping capacity inside the project lock', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '验证单 canary 原子门禁' });
    mkdirSync(join(f.dataDir, 'a'));
    mkdirSync(join(f.dataDir, 'b'));
    const taskControl = (suffix: string) => ({
      mode: 'audit_only' as const,
      taskGuid: `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`,
      phaseId: `workstream:${suffix}`,
      workerAppId: `cli_worker_${suffix}`, reviewerAppId: `cli_reviewer_${suffix}`, acceptorAppId: `cli_acceptor_${suffix}`,
      originTurnId: `turn-${suffix}`,
      proof: {
        schemaVersion: 'ProjectDispatchReservationProof.v1' as const, larkAppId: f.context.larkAppId,
        issuedAt: '2026-09-29T00:00:00.000Z', keyId: `tcpr1:${suffix}`, signature: suffix.repeat(64),
      },
    });
    const results = await Promise.allSettled([
      f.coordinator.run(f.context, {
        action: 'reserve_dispatch', reservationId: 'audit-a', targetAppIds: ['cli_worker_a', 'cli_reviewer_a'],
        access: { mode: 'write', scopes: [join(f.dataDir, 'a')] }, now: '2026-09-29T00:00:00.000Z',
        taskControl: taskControl('a'), maxActiveTaskControlMappings: 1,
      }),
      f.coordinator.run(f.context, {
        action: 'reserve_dispatch', reservationId: 'audit-b', targetAppIds: ['cli_worker_b', 'cli_reviewer_b'],
        access: { mode: 'write', scopes: [join(f.dataDir, 'b')] }, now: '2026-09-29T00:00:00.000Z',
        taskControl: taskControl('b'), maxActiveTaskControlMappings: 1,
      }),
    ]);
    expect(results.map(result => result.status === 'fulfilled'
      ? { status: result.status }
      : { status: result.status, reason: (result.reason as Error).message })).toEqual(expect.arrayContaining([
      { status: 'fulfilled' },
      { status: 'rejected', reason: 'project_task_control_canary_capacity_reached' },
    ]));
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations).toHaveLength(1);
  });

  it('keeps a project-failed mapping active until TaskControl proves a terminal state', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '容量只认可信终态' });
    const oldTaskGuid = '11111111-1111-4111-8111-111111111111';
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams.push({
        dispatchRoot: 'om_old_failed', title: '旧失败任务', purpose: '保留审计', owners: [],
        status: 'failed', progress: 99, access: { mode: 'write', scopes: [join(f.dataDir, 'old')] },
        taskControl: {
          taskGuid: oldTaskGuid, phaseId: `workstream:${oldTaskGuid}`,
          mappingRef: 'topic-message:om_old_failed', mappingStatus: 'registered', sourceKind: 'project_group',
          controllerAppId: f.context.larkAppId, workerAppId: 'cli_worker_old', reviewerAppId: 'cli_reviewer_old',
          acceptorAppId: 'cli_acceptor_old', projectRevision: 2, reservationId: 'old-reservation',
          coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'turn-old',
          reservationCreatedAt: '2026-09-29T00:00:00.000Z', reservationExpiresAt: '2026-09-29T00:02:00.000Z',
          rootCreateTime: '2026-09-29T00:00:01.000Z',
          reservationProof: {
            schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
            issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:old', signature: 'a'.repeat(64),
          },
        },
        createdAt: '2026-09-29T00:00:01.000Z', updatedAt: '2026-09-29T00:01:00.000Z',
      });
      return current;
    });
    mkdirSync(join(f.dataDir, 'new'));
    const newTaskGuid = '22222222-2222-4222-8222-222222222222';
    const nonTerminal = vi.fn(() => ({ capacityReleased: false, admissionSafe: false }));
    const reservation = {
      action: 'reserve_dispatch', reservationId: 'new-reservation',
      targetAppIds: ['cli_worker_new', 'cli_reviewer_new'],
      access: { mode: 'write', scopes: [join(f.dataDir, 'new')] },
      taskControl: {
        mode: 'audit_only', taskGuid: newTaskGuid, phaseId: `workstream:${newTaskGuid}`,
        workerAppId: 'cli_worker_new', reviewerAppId: 'cli_reviewer_new', acceptorAppId: 'cli_acceptor_new',
        originTurnId: 'turn-new', proof: {
          schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
          issuedAt: '2026-09-29T00:03:00.000Z', keyId: 'tcpr1:new', signature: 'b'.repeat(64),
        },
      },
      maxActiveTaskControlMappings: 1,
      getTaskControlMappingDecision: nonTerminal,
    } as const;
    await expect(f.coordinator.run(f.context, reservation as any))
      .rejects.toThrow('project_task_control_canary_capacity_reached');
    expect(nonTerminal).toHaveBeenCalledWith({ dispatchRoot: 'om_old_failed', taskGuid: oldTaskGuid });
    await expect(f.coordinator.run(f.context, {
      ...reservation, reservationId: 'unreadable-reservation',
      getTaskControlMappingDecision: () => { throw new Error('task_control_projection_unavailable'); },
    } as any)).rejects.toThrow('task_control_projection_unavailable');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations).toEqual([]);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams[0]!.taskControl!.mappingStatus = 'retired';
      return current;
    });
    const retiredButNonTerminal = vi.fn(() => ({ capacityReleased: false, admissionSafe: false }));
    await expect(f.coordinator.run(f.context, {
      ...reservation, reservationId: 'retired-non-terminal-reservation',
      getTaskControlMappingDecision: retiredButNonTerminal,
    } as any)).rejects.toThrow('project_task_control_canary_capacity_reached');
    expect(retiredButNonTerminal).toHaveBeenCalledWith({ dispatchRoot: 'om_old_failed', taskGuid: oldTaskGuid });

    const admissionUnsafe = vi.fn(() => ({ capacityReleased: true, admissionSafe: false }));
    await expect(f.coordinator.run(f.context, {
      ...reservation, reservationId: 'unsafe-reservation', getTaskControlMappingDecision: admissionUnsafe,
    } as any)).rejects.toThrow('project_task_control_admission_unsafe');
    expect(admissionUnsafe).toHaveBeenCalledWith({ dispatchRoot: 'om_old_failed', taskGuid: oldTaskGuid });

    const terminal = vi.fn(() => ({ capacityReleased: true, admissionSafe: true }));
    const released = await f.coordinator.run(f.context, {
      ...reservation, reservationId: 'released-reservation', getTaskControlMappingDecision: terminal,
    } as any);
    expect(released.dispatchReservations).toEqual([
      expect.objectContaining({ reservationId: 'released-reservation' }),
    ]);
    expect(terminal).toHaveBeenCalledWith({ dispatchRoot: 'om_old_failed', taskGuid: oldTaskGuid });
  });

  it('persists root creation before commit and marks one exact mapping idempotently', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '验证 mapping 生命周期' });
    const proof: ProjectDispatchReservationProofV1 = {
      schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
      issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:test', signature: 'b'.repeat(64),
    };
    const taskControl = {
      mode: 'audit_only' as const, taskGuid: '22222222-2222-4222-8222-222222222222',
      phaseId: 'workstream:22222222-2222-4222-8222-222222222222', workerAppId: 'cli_worker',
      reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor', originTurnId: 'turn-2', proof,
    };
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'audit-root', targetAppIds: ['cli_worker', 'cli_reviewer'],
      access: { mode: 'write', scopes: [f.dataDir] }, now: '2026-09-29T00:00:00.000Z', taskControl,
      maxActiveTaskControlMappings: 1,
    });
    const rooted = await f.coordinator.run(f.context, {
      action: 'bind_dispatch_root', reservationId: 'audit-root', targetAppIds: ['cli_worker', 'cli_reviewer'],
      dispatchRoot: 'om_auditroot', rootCreateTime: '2026-09-29T00:00:02.000Z',
    } as any);
    expect(rooted.dispatchReservations).toEqual([
      expect.objectContaining({ stage: 'root_created', dispatchRoot: 'om_auditroot' }),
    ]);
    const rootedAgain = await f.coordinator.run(f.context, {
      action: 'bind_dispatch_root', reservationId: 'audit-root', targetAppIds: ['cli_worker', 'cli_reviewer'],
      dispatchRoot: 'om_auditroot', rootCreateTime: '2026-09-29T00:00:02.000Z',
    } as any);
    expect(rootedAgain.revision).toBe(rooted.revision);
    await expect(f.coordinator.run(f.context, {
      action: 'bind_dispatch_root', reservationId: 'audit-root', targetAppIds: ['cli_worker', 'cli_reviewer'],
      dispatchRoot: 'om_otherroot', rootCreateTime: '2026-09-29T00:00:02.000Z',
    } as any)).rejects.toThrow('project_dispatch_root_conflict');

    const committed = await f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: 'audit-root', targetAppIds: ['cli_worker', 'cli_reviewer'],
      workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'], dispatchRoot: 'om_auditroot',
      title: '审计任务', purpose: '验证 mapping 生命周期', owners: ['Worker', 'Reviewer'],
    });
    expect(committed.workstreams[0]?.taskControl).toMatchObject({
      taskGuid: taskControl.taskGuid, phaseId: taskControl.phaseId, mappingStatus: 'pending',
      mappingRef: 'topic-message:om_auditroot', controllerAppId: f.context.larkAppId,
      workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor',
      reservationProof: proof,
    });

    const registered = await f.coordinator.run(f.context, {
      action: 'mark_task_control_mapping', dispatchRoot: 'om_auditroot', taskGuid: taskControl.taskGuid,
      mappingRef: 'topic-message:om_auditroot', status: 'registered', registeredAt: '2026-09-29T00:00:03.000Z',
    } as any);
    expect(registered.workstreams[0]?.taskControl).toMatchObject({ mappingStatus: 'registered', registeredAt: '2026-09-29T00:00:03.000Z' });
    const repeated = await f.coordinator.run(f.context, {
      action: 'mark_task_control_mapping', dispatchRoot: 'om_auditroot', taskGuid: taskControl.taskGuid,
      mappingRef: 'topic-message:om_auditroot', status: 'registered', registeredAt: '2026-09-29T00:00:03.000Z',
    } as any);
    expect(repeated.revision).toBe(registered.revision);
  });

  async function committedWriteWorkstream(f: ReturnType<typeof fixture>) {
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_reviewer_next', 'cli_reviewer_other'],
    });
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'write-review',
      targetAppIds: ['cli_worker', 'cli_reviewer'], access: { mode: 'write', scopes: [f.dataDir] },
    });
    return f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: 'write-review',
      targetAppIds: ['cli_worker', 'cli_reviewer'], workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'],
      dispatchRoot: 'om_reviewed', title: '写入任务', purpose: '完成并验收', owners: ['Worker', 'Reviewer'],
    });
  }

  async function deliveredWriteWorkstream(f: ReturnType<typeof fixture>) {
    await committedWriteWorkstream(f);
    return f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '冻结候选', status: 'completed',
    });
  }

  async function failedWriteWorkstream(f: ReturnType<typeof fixture>) {
    await committedWriteWorkstream(f);
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer'],
      progressCard: {
        schemaVersion: 1, templateId: 'status-dashboard', sections: ['goal'],
        milestonesExpanded: false,
      },
    });
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      const item = current!.workstreams[0]!;
      item.status = 'failed';
      item.progress = 99;
      item.remaining = '保留失败现场';
      item.lastReport = '历史交付失败';
      item.blocker = '验收未通过';
      item.delivery = {
        reportedByAppId: 'cli_worker', content: '历史候选',
        reportedAt: '2026-10-14T09:00:00.000Z', round: 1,
      };
      item.review = {
        reviewerAppId: 'cli_reviewer', verdict: 'fail', content: '验收未通过',
        reviewedAt: '2026-10-14T09:30:00.000Z', round: 1,
      };
      return current;
    });
    return readProjectGroup(f.dataDir, f.context.chatId)!;
  }

  function archiveWorkstream(expectedRevision: number, overrides: Record<string, unknown> = {}) {
    return {
      action: 'archive_workstream' as const,
      dispatchRoot: 'om_reviewed', expectedRevision,
      authorizationRef: 'om_archive', archivedByOpenId: 'ou_authorizer',
      reason: '历史失败已由后续成功批次替代',
      now: '2026-10-15T10:00:00.000Z',
      ...overrides,
    };
  }

  it('archives one failed workstream without rewriting its failure evidence', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const before = structuredClone(failed.workstreams[0]!);

    const archived = await f.coordinator.run(
      f.context,
      archiveWorkstream(failed.revision) as any,
    );

    expect(archived.workstreams[0]).toEqual({
      ...before,
      status: 'cancelled',
      archivedFromStatus: 'failed',
      archivedAt: '2026-10-15T10:00:00.000Z',
      archiveReason: '历史失败已由后续成功批次替代',
      archiveAuthorizationRef: 'om_archive',
      archivedByOpenId: 'ou_authorizer',
      updatedAt: '2026-10-15T10:00:00.000Z',
    });
    expect(projectRemainingSummary(archived)).toBe('无');
  });

  it.each([
    [160, '😀'.repeat(160)],
    [161, '😀'.repeat(160)],
  ])('persists an archive reason at the %i-code-point boundary', async (inputLength, expectedReason) => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const inputReason = '😀'.repeat(inputLength);
    const action = archiveWorkstream(failed.revision, { reason: inputReason });
    const prefix = '授权归档 BotMux 历史 failed workstream：';
    const promptReason = JSON.parse(
      projectCoordinatorModule.projectWorkstreamArchiveAuthorizationPrompt(action).slice(prefix.length),
    ).reason;

    const archived = await f.coordinator.runWorkstreamArchive(f.context, action);

    expect(promptReason).toBe(expectedReason);
    expect(archived.project.workstreams[0]?.archiveReason).toBe(expectedReason);
    expect(Array.from(archived.project.workstreams[0]!.archiveReason!)).toHaveLength(160);
  });

  it('does not replay an archive when code-point-truncated reasons differ', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const firstReason = `${'😀'.repeat(159)}A-tail`;
    const differentReason = `${'😀'.repeat(159)}B-tail`;
    const firstAction = archiveWorkstream(failed.revision, { reason: firstReason });
    const first = await f.coordinator.runWorkstreamArchive(f.context, firstAction);
    const store = join(f.dataDir, 'project-groups.json');
    const beforeReplay = { revision: first.project.revision, inode: statSync(store).ino };

    await expect(f.coordinator.runWorkstreamArchive(
      f.context,
      archiveWorkstream(failed.revision, { reason: differentReason }),
    )).rejects.toThrow('project_revision_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.revision).toBe(beforeReplay.revision);
    expect(statSync(store).ino).toBe(beforeReplay.inode);
  });

  it('rejects a stale workstream archive revision without mutation', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const before = structuredClone(failed);

    await expect(f.coordinator.run(
      f.context,
      archiveWorkstream(failed.revision - 1) as any,
    )).rejects.toThrow('project_revision_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)).toEqual(before);
  });

  it('rejects archiving a completed workstream', async () => {
    const f = fixture();
    await deliveredWriteWorkstream(f);
    const completed = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer',
      content: '验收通过', reviewVerdict: 'pass', reviewRound: 1,
    });
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer'],
      progressCard: {
        schemaVersion: 1, templateId: 'status-dashboard', sections: ['goal'],
        milestonesExpanded: false,
      },
    });

    await expect(f.coordinator.run(
      f.context,
      archiveWorkstream(completed.revision) as any,
    )).rejects.toThrow('project_workstream_archive_state_invalid');
  });

  it('keeps only the exact workstream archive replay idempotent', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const action = archiveWorkstream(failed.revision);
    const first = await f.coordinator.run(f.context, action as any);
    expect(first.revision).toBe(failed.revision + 1);
    const store = join(f.dataDir, 'project-groups.json');
    const beforeReplay = { revision: first.revision, inode: statSync(store).ino };
    expect(readProjectGroup(f.dataDir, f.context.chatId)).toMatchObject({
      revision: action.expectedRevision + 1,
      workstreams: [{
        status: 'cancelled', archivedFromStatus: 'failed',
        archiveAuthorizationRef: action.authorizationRef,
        archivedByOpenId: action.archivedByOpenId,
        archiveReason: action.reason,
      }],
    });

    const replay = await f.coordinator.run(f.context, action as any);
    expect(replay.revision).toBe(beforeReplay.revision);
    expect(statSync(store).ino).toBe(beforeReplay.inode);

    for (const drift of [
      { reason: '不同理由' },
      { authorizationRef: 'om_archive_other' },
      { archivedByOpenId: 'ou_other' },
    ]) {
      await expect(f.coordinator.run(
        f.context,
        archiveWorkstream(failed.revision, drift) as any,
      )).rejects.toThrow();
    }
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.revision).toBe(beforeReplay.revision);
  });

  it('replays archive without durably resolving a missing thread id', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const action = archiveWorkstream(failed.revision);
    f.transport.resolveThreadId = vi.fn(async () => 'omt_probe');
    f.transport.updateCard.mockClear();

    const first = await f.coordinator.run(f.context, action as any);
    const store = join(f.dataDir, 'project-groups.json');
    const beforeReplay = { revision: first.revision, inode: statSync(store).ino };
    const replay = await f.coordinator.run(f.context, action as any);

    expect(replay.revision).toBe(beforeReplay.revision);
    expect(statSync(store).ino).toBe(beforeReplay.inode);
    expect(replay.workstreams[0]).toMatchObject({
      status: 'cancelled', archivedFromStatus: 'failed',
      archiveAuthorizationRef: 'om_archive', archivedByOpenId: 'ou_authorizer',
    });
    expect(replay.workstreams[0]?.threadId).toBeUndefined();
    expect((readFileSync(store, 'utf8').match(/"archivedAt"/g) ?? [])).toHaveLength(1);
    expect(f.transport.resolveThreadId).not.toHaveBeenCalled();
    expect(f.transport.updateCard).toHaveBeenCalledTimes(2);
  });

  it('replays archive after a withdrawn card is replaced', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const action = archiveWorkstream(failed.revision);
    const previousCardId = failed.card?.messageId;
    f.transport.sendCard.mockClear();
    f.transport.pinMessage.mockClear();
    f.transport.updateCard = vi.fn()
      .mockRejectedValueOnce(new Error('withdrawn'))
      .mockResolvedValueOnce(undefined);

    const first = await f.coordinator.runWorkstreamArchive(f.context, action);
    expect(first).not.toHaveProperty('projectionWarning');
    expect(first.project.revision).toBe(failed.revision + 1);
    expect(first.project.card?.messageId).not.toBe(previousCardId);
    const store = join(f.dataDir, 'project-groups.json');
    const beforeReplay = {
      revision: first.project.revision,
      workstreams: structuredClone(first.project.workstreams),
      inode: statSync(store).ino,
    };

    const replay = await f.coordinator.runWorkstreamArchive(f.context, action);

    expect(replay).not.toHaveProperty('projectionWarning');
    expect(replay.project.revision).toBe(beforeReplay.revision);
    expect(replay.project.workstreams).toEqual(beforeReplay.workstreams);
    expect(statSync(store).ino).toBe(beforeReplay.inode);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.pinMessage).toHaveBeenCalledTimes(1);
    expect(f.transport.updateCard).toHaveBeenCalledTimes(2);
  });

  it('replays archive after creating a card for a valid cardless legacy project', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      delete current!.card;
      return current;
    });
    const cardless = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(cardless.card).toBeUndefined();
    const action = archiveWorkstream(cardless.revision);
    f.transport.sendCard.mockClear();
    f.transport.pinMessage.mockClear();
    f.transport.updateCard.mockClear();

    const first = await f.coordinator.runWorkstreamArchive(f.context, action);
    expect(first).not.toHaveProperty('projectionWarning');
    expect(first.project.revision).toBe(cardless.revision + 1);
    expect(first.project.card?.messageId).toBeTruthy();
    const store = join(f.dataDir, 'project-groups.json');
    const beforeReplay = {
      revision: first.project.revision,
      workstreams: structuredClone(first.project.workstreams),
      inode: statSync(store).ino,
    };

    const replay = await f.coordinator.runWorkstreamArchive(f.context, action);

    expect(replay).not.toHaveProperty('projectionWarning');
    expect(replay.project.revision).toBe(beforeReplay.revision);
    expect(replay.project.workstreams).toEqual(beforeReplay.workstreams);
    expect(statSync(store).ino).toBe(beforeReplay.inode);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.pinMessage).toHaveBeenCalledTimes(1);
    expect(f.transport.updateCard).toHaveBeenCalledTimes(1);
  });

  it('replays archive after the card is later withdrawn and then removed, keeping business revision at +1', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const action = archiveWorkstream(failed.revision);
    const first = await f.coordinator.runWorkstreamArchive(f.context, action);
    expect(first).not.toHaveProperty('projectionWarning');
    expect(first.project.revision).toBe(failed.revision + 1);
    const businessRevision = first.project.revision;
    const business = structuredClone(first.project.workstreams);

    f.transport.updateCard.mockRejectedValueOnce(new Error('withdrawn'));
    f.transport.sendCard.mockClear();
    const withdrawnReplay = await f.coordinator.runWorkstreamArchive(f.context, action);
    expect(withdrawnReplay.project.revision).toBe(businessRevision);
    expect(withdrawnReplay.project.workstreams).toEqual(business);
    expect(withdrawnReplay).not.toHaveProperty('projectionWarning');
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);

    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      delete current!.card;
      return current;
    });
    const cardlessBefore = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(cardlessBefore.revision).toBe(businessRevision);
    f.transport.sendCard.mockClear();
    const cardlessReplay = await f.coordinator.runWorkstreamArchive(f.context, action);
    expect(cardlessReplay.project.revision).toBe(businessRevision);
    expect(cardlessReplay.project.card?.messageId).toBeTruthy();
    expect(cardlessReplay.project.workstreams).toEqual(business);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.revision).toBe(businessRevision);
  });

  it('retries archive projection after durable cancelled state succeeds', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const action = archiveWorkstream(failed.revision);
    f.transport.resolveThreadId = vi.fn(async () => 'omt_probe');
    f.transport.updateCard = vi.fn()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValueOnce(undefined);

    const first = await f.coordinator.runWorkstreamArchive(f.context, action);
    expect(first).toMatchObject({
      projectionWarning: 'projection unavailable',
      project: { workstreams: [{ status: 'cancelled', archivedFromStatus: 'failed' }] },
    });
    const store = join(f.dataDir, 'project-groups.json');
    const beforeRetry = readProjectGroup(f.dataDir, f.context.chatId)!;
    const beforeRetryInode = statSync(store).ino;

    const retry = await f.coordinator.runWorkstreamArchive(f.context, action);

    expect(retry).not.toHaveProperty('projectionWarning');
    expect(retry.project.revision).toBe(beforeRetry.revision);
    expect(retry.project.workstreams).toEqual(beforeRetry.workstreams);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams).toEqual(beforeRetry.workstreams);
    expect(statSync(store).ino).not.toBe(beforeRetryInode);
    expect(retry.project.card?.updatedAt).toBe(retry.project.updatedAt);
    expect(f.transport.resolveThreadId).not.toHaveBeenCalled();
    expect(f.transport.updateCard).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing field', (item: Record<string, unknown>) => { delete item.archiveReason; }],
    ['tampered actor', (item: Record<string, unknown>) => { item.archivedByOpenId = 'forged'; }],
    ['tampered source status', (item: Record<string, unknown>) => { item.archivedFromStatus = 'completed'; }],
    ['extra archive field', (item: Record<string, unknown>) => { item.archiveUnexpected = 'forged'; }],
    ['metadata on wrong lifecycle state', (item: Record<string, unknown>) => { item.status = 'failed'; }],
  ])('rejects %s in workstream archive metadata on reload', async (_scenario, tamper) => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    await f.coordinator.run(f.context, archiveWorkstream(failed.revision) as any);
    const store = join(f.dataDir, 'project-groups.json');
    const raw = JSON.parse(readFileSync(store, 'utf8'));
    tamper(raw.projects[f.context.chatId].workstreams[0]);
    writeFileSync(store, JSON.stringify(raw));

    expect(() => readProjectGroup(f.dataDir, f.context.chatId))
      .toThrow('project-groups.json has invalid workstream archive metadata');
  });

  it('continues to load legacy workstreams without archive metadata', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams[0]).toEqual(
      failed.workstreams[0],
    );
  });

  it('excludes a cancelled workstream from remaining write claims', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    await f.coordinator.run(f.context, archiveWorkstream(failed.revision) as any);

    await expect(f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'after-archive',
      targetAppIds: ['cli_worker'], access: { mode: 'write', scopes: [f.dataDir] },
    })).resolves.toMatchObject({
      dispatchReservations: [expect.objectContaining({ reservationId: 'after-archive' })],
    });
  });

  it('does not satisfy a completion gate from a cancelled source workstream', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const archived = await f.coordinator.run(f.context, archiveWorkstream(failed.revision) as any);
    const taskGuid = '44444444-4444-4444-8444-444444444444';
    archived.workstreams[0]!.taskControl = { taskGuid } as any;
    const gate = {
      gateId: 'archived-source', sourceChatId: archived.chatId,
      dispatchRoot: archived.workstreams[0]!.dispatchRoot, taskGuid,
      label: '已归档来源', definitionFingerprint: 'pcg1:archive',
      status: 'pending' as const, reason: 'waiting',
      createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z',
    };

    expect(evaluateProjectCompletionGate({
      parentLarkAppId: archived.larkAppId,
      gate,
      sourceProject: archived,
      reader: {} as any,
      checkedAt: '2026-10-15T10:01:00.000Z',
      staleExecutionMs: 60_000,
    })).toMatchObject({ status: 'pending', reason: 'source_workstream_incomplete' });
  });

  it('keeps a cancelled workstream terminal when a late report arrives', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const archived = await f.coordinator.run(f.context, archiveWorkstream(failed.revision) as any);

    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '迟到报告', status: 'in_progress', progress: 50,
    })).rejects.toThrow('project_workstream_cancelled');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.revision).toBe(archived.revision);
  });

  it('renders cancelled archive metadata without changing failed styling', async () => {
    const f = fixture();
    const failed = await failedWriteWorkstream(f);
    const failedCard = JSON.stringify(buildProjectGroupCard(failed));
    expect(failedCard).toContain("<text_tag color='red'>失败</text_tag>");

    const archived = await f.coordinator.run(f.context, archiveWorkstream(failed.revision) as any);
    const built = buildProjectGroupCard(archived) as any;
    const card = JSON.stringify(built);
    const archiveRow = built.body.elements.find((element: { tag?: string }) => element.tag === 'table').rows[0].wf;
    expect(card).toContain("<text_tag color='neutral'>已归档</text_tag>");
    expect(card).toContain('归档记录 · 1');
    expect(card).not.toContain('完成记录 · 1');
    expect(archiveRow).toContain('原状态 · 失败');
    expect(archiveRow).toContain('归档原因 · 历史失败已由后续成功批次替代');
    expect(archiveRow).toContain('授权消息 · om\\_archive');
    expect(archiveRow).toContain('归档人 · ou\\_authorizer');
    expect(archiveRow).toContain('归档时间 · 2026\\-10\\-15T10:00:00\\.000Z');
    expect(archiveRow).toContain('Review · 验收未通过');
  });

  function reviewerReplacement(expectedRevision: number, overrides: Record<string, unknown> = {}) {
    return {
      action: 'replace_workstream_reviewer' as const,
      dispatchRoot: 'om_reviewed', oldReviewerAppId: 'cli_reviewer',
      newReviewerAppId: 'cli_reviewer_next', expectedRevision,
      authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
      allowedReviewerAppIds: ['cli_worker', 'cli_reviewer', 'cli_reviewer_next', 'cli_reviewer_other'],
      reason: '主 reviewer 不可用', now: '2026-10-13T10:00:00.000Z',
      ...overrides,
    };
  }

  it('atomically replaces only reviewer bindings and persists a bounded audit record', async () => {
    const f = fixture();
    await deliveredWriteWorkstream(f);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams[0]!.reviewerAppIds!.push('cli_reviewer_backup');
      current!.workstreams[0]!.targetAppIds!.push('cli_reviewer_backup');
      return current;
    });
    const delivered = readProjectGroup(f.dataDir, f.context.chatId)!;
    const before = structuredClone(delivered.workstreams[0]!);

    const result = await f.coordinator.runReviewerReplacement(
      f.context,
      reviewerReplacement(delivered.revision),
    );
    const item = result.project.workstreams[0]!;
    expect(result).not.toHaveProperty('projectionWarning');
    expect(result.project.revision).toBe(delivered.revision + 1);
    expect(item).toEqual({
      ...before,
      targetAppIds: ['cli_reviewer_next', 'cli_worker', 'cli_reviewer_backup'],
      reviewerAppIds: ['cli_reviewer_next', 'cli_reviewer_backup'],
      reviewerReplacements: [{
        oldReviewerAppId: 'cli_reviewer', newReviewerAppId: 'cli_reviewer_next',
        authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
        reason: '主 reviewer 不可用', coordinatorSessionId: f.context.coordinatorSessionId,
        replacedAt: '2026-10-13T10:00:00.000Z',
        fromRevision: delivered.revision, toRevision: delivered.revision + 1,
      }],
      reviewerReplacementReceipts: [{
        operationFingerprint: expect.stringMatching(/^prr1:[a-f0-9]{64}$/),
        fromRevision: delivered.revision,
        toRevision: delivered.revision + 1,
      }],
      updatedAt: '2026-10-13T10:00:00.000Z',
    });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams[0]).toEqual(item);
    expect(f.transport.updateCard).toHaveBeenCalled();

    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer',
      content: '旧 reviewer 越权', reviewVerdict: 'pass', reviewRound: 1,
    })).rejects.toThrow('project_reviewer_not_allowed');
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer_next',
      content: '新 reviewer 通过', reviewVerdict: 'pass', reviewRound: 1,
    })).resolves.toMatchObject({
      workstreams: [{ status: 'completed', review: { reviewerAppId: 'cli_reviewer_next' } }],
    });
  });

  it('keeps an exact reviewer replacement retry idempotent', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    const action = reviewerReplacement(delivered.revision);
    const first = await f.coordinator.runReviewerReplacement(f.context, action);
    const store = join(f.dataDir, 'project-groups.json');
    const beforeRetry = { revision: first.project.revision, inode: statSync(store).ino };
    f.transport.updateCard.mockClear();

    const retry = await f.coordinator.runReviewerReplacement(f.context, action);
    expect(retry.project.revision).toBe(beforeRetry.revision);
    expect(retry.project.workstreams[0]?.reviewerReplacements).toHaveLength(1);
    expect(retry.project.workstreams[0]?.reviewerReplacementReceipts).toHaveLength(1);
    expect(statSync(store).ino).toBe(beforeRetry.inode);
    expect(f.transport.updateCard).toHaveBeenCalledTimes(1);
  });

  it('retries projection after durable reviewer replacement success', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    const action = reviewerReplacement(delivered.revision);
    f.transport.updateCard = vi.fn()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValueOnce(undefined);
    const first = await f.coordinator.runReviewerReplacement(f.context, action);
    expect(first.projectionWarning).toBe('projection unavailable');
    const durableRevision = first.project.revision;
    const retry = await f.coordinator.runReviewerReplacement(f.context, action);
    expect(retry.project.revision).toBe(durableRevision);
    expect(retry).not.toHaveProperty('projectionWarning');
    expect(f.transport.updateCard).toHaveBeenCalledTimes(2);
  });

  it('does not bump revision or enrich threadId on exact replay projection', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    const action = reviewerReplacement(delivered.revision);
    f.transport.resolveThreadId = vi.fn()
      .mockResolvedValueOnce(null)         // first publish: unresolved at that moment
      .mockResolvedValueOnce('omt_topic'); // exact replay: now resolvable
    f.transport.updateCard = vi.fn()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValueOnce(undefined);
    const first = await f.coordinator.runReviewerReplacement(f.context, action);
    expect(first.projectionWarning).toBe('projection unavailable');
    const durableRevision = first.project.revision;
    const retry = await f.coordinator.runReviewerReplacement(f.context, action);
    expect(retry.project.revision).toBe(durableRevision);
    expect(retry).not.toHaveProperty('projectionWarning');
    expect(f.transport.updateCard).toHaveBeenCalledTimes(2);
    // Replay projection must refresh the card without durably resolving threadIds.
    const durable = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(durable.workstreams[0]?.threadId).toBeUndefined();
    expect(durable.revision).toBe(durableRevision);
    expect(f.transport.resolveThreadId).toHaveBeenCalledTimes(1);
  });

  async function reviewerChangedAfterKey(f: ReturnType<typeof fixture>) {
    await deliveredWriteWorkstream(f);
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_reviewer_next', 'cli_reviewer_final'],
    });
    let project = readProjectGroup(f.dataDir, f.context.chatId)!;
    const firstAction = reviewerReplacement(project.revision);
    project = (await f.coordinator.runReviewerReplacement(f.context, firstAction)).project;
    project = (await f.coordinator.runReviewerReplacement(f.context, reviewerReplacement(project.revision, {
      oldReviewerAppId: 'cli_reviewer_next', newReviewerAppId: 'cli_reviewer_final',
      authorizationRef: 'om_authorization_final', reason: '再次变更当前 reviewer',
    }))).project;
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_reviewer_final'],
    });
    return { project, firstAction };
  }

  it('keeps an old reviewer operation business-noop when replay rebuilds a withdrawn card', async () => {
    const f = fixture();
    const { project, firstAction } = await reviewerChangedAfterKey(f);
    const beforeReplay = structuredClone(project);
    f.transport.updateCard = vi.fn(async () => { throw new Error('withdrawn'); });
    f.transport.sendCard.mockClear();
    f.transport.pinMessage.mockClear();

    const replay = await f.coordinator.runReviewerReplacement(f.context, firstAction);

    expect(replay.project.revision).toBe(beforeReplay.revision);
    expect(replay.project.workstreams[0]!.reviewerAppIds).toEqual(['cli_reviewer_final']);
    expect(replay.project.workstreams[0]!.reviewerReplacements)
      .toEqual(beforeReplay.workstreams[0]!.reviewerReplacements);
    expect(replay.project.workstreams[0]!.reviewerReplacementReceipts)
      .toEqual(beforeReplay.workstreams[0]!.reviewerReplacementReceipts);
    // A withdrawn card is rebuilt: a fresh card is sent, but business state is untouched.
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(replay.project.card?.messageId).toBeTruthy();
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.revision).toBe(beforeReplay.revision);
  });

  it('keeps an old reviewer operation business-noop when replay creates a card for a cardless project', async () => {
    const f = fixture();
    const { project, firstAction } = await reviewerChangedAfterKey(f);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      delete current!.card;
      return current;
    });
    const cardlessBefore = readProjectGroup(f.dataDir, f.context.chatId)!;
    f.transport.sendCard.mockClear();
    f.transport.pinMessage.mockClear();

    const replay = await f.coordinator.runReviewerReplacement(f.context, firstAction);

    expect(replay.project.revision).toBe(cardlessBefore.revision);
    expect(replay.project.card?.messageId).toBeTruthy();
    expect(replay.project.workstreams[0]!.reviewerAppIds).toEqual(['cli_reviewer_final']);
    expect(replay.project.workstreams[0]!.reviewerReplacements)
      .toEqual(cardlessBefore.workstreams[0]!.reviewerReplacements);
    expect(replay.project.workstreams[0]!.reviewerReplacementReceipts)
      .toEqual(cardlessBefore.workstreams[0]!.reviewerReplacementReceipts);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.revision).toBe(cardlessBefore.revision);
  });

  it('normal reviewer replacement still creates a card and bumps business revision', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    f.transport.sendCard.mockClear();
    const result = await f.coordinator.runReviewerReplacement(f.context, reviewerReplacement(delivered.revision));
    expect(result.project.revision).toBe(delivered.revision + 1);
    expect(result).not.toHaveProperty('projectionWarning');
    expect(result.project.card?.messageId).toBeTruthy();
  });

  it.each([
    ['stale revision', 'project_revision_conflict'],
    ['old reviewer mismatch', 'project_old_reviewer_mismatch'],
    ['new reviewer is worker', 'project_review_roles_overlap'],
    ['new reviewer is outside allowlist', 'project_reviewer_not_allowed'],
    ['workstream is not in review', 'project_reviewer_replace_state_invalid'],
    ['workstream already has review', 'project_reviewer_replace_state_invalid'],
    ['workstream has no delivery', 'project_reviewer_replace_state_invalid'],
    ['workstream has task control', 'project_reviewer_replace_task_control_unsupported'],
    ['new reviewer already assigned', 'project_reviewer_already_assigned'],
    ['invalid app id', 'project_reviewer_app_id_invalid'],
  ])('rejects reviewer replacement when %s', async (scenario, expectedError) => {
    const f = fixture();
    const project = scenario === 'workstream has no delivery'
      ? await committedWriteWorkstream(f)
      : await deliveredWriteWorkstream(f);
    const overrides: Record<string, unknown> = {};
    if (scenario === 'stale revision') overrides.expectedRevision = project.revision - 1;
    if (scenario === 'old reviewer mismatch') overrides.oldReviewerAppId = 'cli_other';
    if (scenario === 'new reviewer is worker') overrides.newReviewerAppId = 'cli_worker';
    if (scenario === 'new reviewer is outside allowlist') {
      overrides.newReviewerAppId = 'cli_outside';
      overrides.allowedReviewerAppIds = ['cli_worker', 'cli_reviewer'];
    }
    if (scenario === 'invalid app id') overrides.newReviewerAppId = 'reviewer-next';
    if (scenario === 'workstream is not in review') {
      await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
        current!.workstreams[0]!.status = 'blocked';
        return current;
      });
    }
    if (scenario === 'workstream already has review') {
      await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
        current!.workstreams[0]!.review = {
          reviewerAppId: 'cli_reviewer', verdict: 'fail', content: '已有结论',
          reviewedAt: '2026-10-13T09:00:00.000Z', round: 1,
        };
        return current;
      });
    }
    if (scenario === 'workstream has task control') await attachProjectTaskControl(f);
    if (scenario === 'new reviewer already assigned') {
      await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
        current!.workstreams[0]!.reviewerAppIds!.push('cli_reviewer_next');
        current!.workstreams[0]!.targetAppIds!.push('cli_reviewer_next');
        return current;
      });
    }
    const before = readProjectGroup(f.dataDir, f.context.chatId)!;
    await expect(f.coordinator.runReviewerReplacement(
      f.context,
      reviewerReplacement(before.revision, overrides),
    )).rejects.toThrow(expectedError);
    expect(readProjectGroup(f.dataDir, f.context.chatId)).toEqual(before);
  });

  it('allows only one of two cross-process reviewer replacements to commit', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    const source = (action: Record<string, unknown>) => `
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      try {
        await coordinator.runReviewerReplacement({
          dataDir: ${JSON.stringify(f.dataDir)}, chatId: ${JSON.stringify(f.context.chatId)},
          larkAppId: ${JSON.stringify(f.context.larkAppId)},
          coordinatorSessionId: ${JSON.stringify(f.context.coordinatorSessionId)},
        }, ${JSON.stringify(action)});
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const children = [
      spawnTsEvalWithRepoImports(source(reviewerReplacement(delivered.revision)), {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      }),
      spawnTsEvalWithRepoImports(source(reviewerReplacement(delivered.revision, {
        newReviewerAppId: 'cli_reviewer_other', authorizationRef: 'om_authorization_other',
      })), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }),
    ];
    const results = await Promise.all(children.map(collectChild));
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    const outcomes = results.map(result => JSON.parse(result.stdout.trim()));
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);
    expect(outcomes.filter(result => !result.ok)).toEqual([
      expect.objectContaining({ error: 'project_revision_conflict' }),
    ]);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams[0]?.reviewerReplacements).toHaveLength(1);
  });

  it('returns a projection warning without rolling back reviewer replacement', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    f.transport.updateCard = vi.fn(async () => { throw new Error('projection unavailable'); });
    const result = await f.coordinator.runReviewerReplacement(
      f.context,
      reviewerReplacement(delivered.revision),
    );
    expect(result).toMatchObject({
      projectionWarning: 'projection unavailable',
      project: { revision: delivered.revision + 1, workstreams: [{ reviewerAppIds: ['cli_reviewer_next'] }] },
    });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams[0]?.reviewerAppIds)
      .toEqual(['cli_reviewer_next']);
  });

  it('bounds reviewer replacement audit history and validates it on reload', async () => {
    const f = fixture();
    let project = await deliveredWriteWorkstream(f);
    // Populate the collaboration mode with the cycling reviewer ids so the
    // coordinator derives the allowlist from current policy, not from
    // action.allowedReviewerAppIds.
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', ...Array.from({ length: 34 }, (_, i) => `cli_reviewer_${i}`)],
    });
    let oldReviewerAppId = 'cli_reviewer';
    for (let index = 0; index < 34; index += 1) {
      const newReviewerAppId = `cli_reviewer_${index}`;
      const result = await f.coordinator.runReviewerReplacement(f.context, {
        ...reviewerReplacement(project.revision),
        oldReviewerAppId,
        newReviewerAppId,
        authorizationRef: `om_authorization_${index}`,
        allowedReviewerAppIds: ['cli_worker', newReviewerAppId],
      });
      project = result.project;
      oldReviewerAppId = newReviewerAppId;
    }
    const records = readProjectGroup(f.dataDir, f.context.chatId)!
      .workstreams[0]!.reviewerReplacements!;
    const receipts = readProjectGroup(f.dataDir, f.context.chatId)!
      .workstreams[0]!.reviewerReplacementReceipts!;
    expect(records).toHaveLength(32);
    expect(receipts).toHaveLength(34);
    expect(records[0]).toMatchObject({
      oldReviewerAppId: 'cli_reviewer_1', newReviewerAppId: 'cli_reviewer_2',
      fromRevision: project.revision - 32,
    });
    expect(records.at(-1)).toMatchObject({
      oldReviewerAppId: 'cli_reviewer_32', newReviewerAppId: 'cli_reviewer_33',
      toRevision: project.revision,
    });

    const store = join(f.dataDir, 'project-groups.json');
    const raw = JSON.parse(readFileSync(store, 'utf8'));
    raw.projects[f.context.chatId].workstreams[0].reviewerReplacements[0].authorizedByOpenId = 'forged';
    writeFileSync(store, JSON.stringify(raw));
    expect(() => readProjectGroup(f.dataDir, f.context.chatId))
      .toThrow('project-groups.json has invalid reviewer replacement');
  });

  it('keeps an evicted reviewer replacement operation idempotent', async () => {
    const f = fixture();
    let project = await deliveredWriteWorkstream(f);
    // Populate the collaboration mode with the cycling reviewer ids so the
    // coordinator derives the allowlist from current policy.
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer_next', ...Array.from({ length: 33 }, (_, i) => `cli_after_${i}`)],
    });
    const firstAction = reviewerReplacement(project.revision);
    project = (await f.coordinator.runReviewerReplacement(f.context, firstAction)).project;
    let oldReviewerAppId = 'cli_reviewer_next';
    for (let index = 0; index < 33; index += 1) {
      const newReviewerAppId = `cli_after_${index}`;
      project = (await f.coordinator.runReviewerReplacement(f.context, {
        ...reviewerReplacement(project.revision),
        oldReviewerAppId,
        newReviewerAppId,
        authorizationRef: `om_after_${index}`,
        allowedReviewerAppIds: ['cli_worker', newReviewerAppId],
      })).project;
      oldReviewerAppId = newReviewerAppId;
    }
    expect(project.workstreams[0]!.reviewerReplacements).toHaveLength(32);
    expect(project.workstreams[0]!.reviewerReplacements)
      .not.toContainEqual(expect.objectContaining({ authorizationRef: 'om_authorization' }));
    expect(project.workstreams[0]!.reviewerReplacementReceipts).toHaveLength(34);
    const store = join(f.dataDir, 'project-groups.json');
    const beforeReplay = structuredClone(project);
    const beforeReplayInode = statSync(store).ino;

    const replay = await f.coordinator.runReviewerReplacement(f.context, firstAction);

    expect(replay.project.revision).toBe(beforeReplay.revision);
    expect(statSync(store).ino).toBe(beforeReplayInode);
    expect(replay.project.workstreams[0]!.reviewerAppIds).toEqual([oldReviewerAppId]);
    expect(replay.project.workstreams[0]!.reviewerReplacements)
      .toEqual(beforeReplay.workstreams[0]!.reviewerReplacements);
    expect(replay.project.workstreams[0]!.reviewerReplacementReceipts)
      .toEqual(beforeReplay.workstreams[0]!.reviewerReplacementReceipts);
  });

  type StoredReviewerReplacementReceipt = {
    operationFingerprint: string;
    fromRevision: number;
    toRevision: number;
  };
  const reviewerReplacementReceiptTamperCases: Array<[
    string,
    (receipts: StoredReviewerReplacementReceipt[]) => void,
  ]> = [
    ['malformed fingerprint', receipts => {
      receipts[0].operationFingerprint = 'prr1:forged';
    }],
    ['duplicate fingerprint', receipts => {
      receipts.push(structuredClone(receipts[0]));
    }],
    ['non-positive revision', receipts => {
      receipts[0].fromRevision = 0;
    }],
    ['unsafe revision', receipts => {
      receipts[0].fromRevision = Number.MAX_SAFE_INTEGER + 1;
      receipts[0].toRevision = Number.MAX_SAFE_INTEGER + 2;
    }],
    ['non-consecutive revision', receipts => {
      receipts[0].toRevision += 1;
    }],
  ];

  it.each(reviewerReplacementReceiptTamperCases)(
    'rejects tampered reviewer replacement receipts on reload: %s', async (_scenario, tamper) => {
      const f = fixture();
      const delivered = await deliveredWriteWorkstream(f);
      await f.coordinator.runReviewerReplacement(f.context, reviewerReplacement(delivered.revision));
      const store = join(f.dataDir, 'project-groups.json');
      const raw = JSON.parse(readFileSync(store, 'utf8'));
      tamper(raw.projects[f.context.chatId].workstreams[0].reviewerReplacementReceipts);
      writeFileSync(store, JSON.stringify(raw));

      expect(() => readProjectGroup(f.dataDir, f.context.chatId))
        .toThrow('project-groups.json has invalid reviewer replacement receipt');
    },
  );

  it('loads legacy reviewer replacement audit without durable receipts', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    await f.coordinator.runReviewerReplacement(f.context, reviewerReplacement(delivered.revision));
    const store = join(f.dataDir, 'project-groups.json');
    const raw = JSON.parse(readFileSync(store, 'utf8'));
    delete raw.projects[f.context.chatId].workstreams[0].reviewerReplacementReceipts;
    writeFileSync(store, JSON.stringify(raw));

    const loaded = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(loaded.workstreams[0]!.reviewerReplacements).toHaveLength(1);
    expect(loaded.workstreams[0]!.reviewerReplacementReceipts).toBeUndefined();
  });

  async function attachProjectTaskControl(f: ReturnType<typeof fixture>, dispatchRoot = 'om_reviewed') {
    const taskGuid = '33333333-3333-4333-8333-333333333333';
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      const item = current!.workstreams.find(workstream => workstream.dispatchRoot === dispatchRoot)!;
      item.taskControl = {
        taskGuid, phaseId: `workstream:${taskGuid}`, mappingRef: `topic-message:${dispatchRoot}`,
        mappingStatus: 'registered', sourceKind: 'project_group', controllerAppId: f.context.larkAppId,
        workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor',
        projectRevision: current!.revision, reservationId: 'task-control-review',
        coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'turn-task-control',
        reservationCreatedAt: '2026-09-29T00:00:00.000Z', reservationExpiresAt: '2026-09-29T00:02:00.000Z',
        rootCreateTime: '2026-09-29T00:00:01.000Z',
        reservationProof: {
          schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
          issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:review', signature: 'c'.repeat(64),
        },
      };
      return current;
    });
  }

  it('moves a write delivery to in_review and requires the assigned reviewer for the exact round', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);

    const delivered = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '实现完成', status: 'completed',
    });
    expect(delivered.workstreams[0]).toMatchObject({
      status: 'in_review', progress: 99,
      delivery: { reportedByAppId: 'cli_worker', content: '实现完成', round: 1 },
    });
    expect(delivered.workstreams[0]).not.toHaveProperty('review');

    const resumed = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '继续补充', status: 'in_progress',
    });
    expect(resumed.workstreams[0]).not.toHaveProperty('delivery');
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer', content: '通过旧交付',
      reviewVerdict: 'pass', reviewRound: 1,
    })).rejects.toThrow('project_delivery_required');

    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '实现完成', status: 'completed',
    });

    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker', content: '自审通过',
      reviewVerdict: 'pass', reviewRound: 1,
    })).rejects.toThrow('project_reviewer_not_allowed');
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_other', content: '通过',
      reviewVerdict: 'pass', reviewRound: 1,
    })).rejects.toThrow('project_reviewer_not_allowed');
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer', content: '通过',
      reviewVerdict: 'pass', reviewRound: 2,
    })).rejects.toThrow('project_review_round_mismatch');

    const passed = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer', content: '验收通过',
      reviewVerdict: 'pass', reviewRound: 1,
    });
    expect(passed.workstreams[0]).toMatchObject({
      status: 'completed', progress: 100,
      review: { reviewerAppId: 'cli_reviewer', verdict: 'pass', content: '验收通过', round: 1 },
    });
    const repeated = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer', content: '验收通过',
      reviewVerdict: 'pass', reviewRound: 1,
    });
    expect(repeated.revision).toBe(passed.revision);
    const replayedDelivery = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '实现完成', status: 'completed',
    });
    expect(replayedDelivery).toMatchObject({
      revision: passed.revision,
      workstreams: [{ status: 'completed', delivery: { round: 1 }, review: { verdict: 'pass', round: 1 } }],
    });
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer', content: '改判失败',
      reviewVerdict: 'fail', reviewRound: 1,
    })).rejects.toThrow('project_review_conflict');
  });

  it('rejects reviewer replacement when the current collaboration-mode policy excludes the reviewer (RED: stale allowlist currently trusted)', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    // Set up collaboration mode deliberately excluding the new reviewer
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer'],
    });
    // Simulate a Dashboard that read stale policy and injected the old allowlist
    const action = reviewerReplacement(delivered.revision, {
      allowedReviewerAppIds: ['cli_worker', 'cli_reviewer', 'cli_reviewer_next'],
    });
    // RED: current code trusts action.allowedReviewerAppIds and succeeds.
    // After fix: the coordinator reads current collaboration mode under the
    // chat lock, derives workerAppIds, and rejects the replacement because
    // cli_reviewer_next is no longer in the group.
    await expect(f.coordinator.runReviewerReplacement(f.context, action))
      .rejects.toThrow('project_reviewer_not_allowed');
  });

  it('preserves exact receipt replay idempotency after a subsequent collaboration-mode policy revokes the reviewer', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    // Set up collaboration mode with cli_reviewer_next allowed
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_reviewer_next'],
    });
    // First replacement succeeds (reviewer is allowed)
    const action = reviewerReplacement(delivered.revision);
    const first = await f.coordinator.runReviewerReplacement(f.context, action);
    expect(first.project.workstreams[0]?.reviewerReplacements).toHaveLength(1);

    // Now revoke the reviewer from the collaboration mode
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer'],
    });

    // Exact replay must remain idempotent — produces no new revision or mutation
    // even though the current collaboration-mode policy excludes the reviewer.
    const replay = await f.coordinator.runReviewerReplacement(f.context, action);
    expect(replay.project.revision).toBe(first.project.revision);
    expect(replay.project.workstreams[0]?.reviewerReplacements).toHaveLength(1);
    expect(replay.project.workstreams[0]?.reviewerReplacementReceipts).toHaveLength(1);
  });

  it('prevents cross-process stale-policy reviewer commit with deterministic revoke-first lock barrier', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);
    // Set up collaboration mode with the new reviewer initially allowed
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_reviewer_next'],
    });

    const holdReadyFile = join(f.dataDir, '.revoke-barrier-ready');
    const holdReleaseFile = join(f.dataDir, '.revoke-barrier-release');

    // Child 1: holds the inner lock (group-collaboration-modes.json.lock),
    // signals readiness, then waits for release.
    const holderSource = `
      import { withGroupCollaborationModeLockSync } from './src/services/group-collaboration-mode-store.js';
      import { writeFileSync, existsSync } from 'node:fs';
      try {
        withGroupCollaborationModeLockSync(${JSON.stringify(f.dataDir)}, ${JSON.stringify(f.context.chatId)}, () => {
          writeFileSync(${JSON.stringify(holdReadyFile)}, 'ready');
          const deadline = Date.now() + 4500;
          while (!existsSync(${JSON.stringify(holdReleaseFile)})) {
            if (Date.now() > deadline) throw new Error('holder deadline exceeded waiting for release');
          }
        });
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;

    // Child 2: writes the group collaboration mode to revoke cli_reviewer_next
    // from the worker set.  It will acquire the outer chat lock first, then
    // block on the inner group-mode lock held by the holder child.
    const revokeSource = `
      import { writeGroupCollaborationMode } from './src/services/group-collaboration-mode-store.js';
      try {
        await writeGroupCollaborationMode(${JSON.stringify(f.dataDir)}, {
          chatId: ${JSON.stringify(f.context.chatId)}, mode: 'project',
          coordinatorAppId: ${JSON.stringify(f.context.larkAppId)},
          workerAppIds: ['cli_worker', 'cli_reviewer'],
        });
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;

    // Child 3: runs the reviewer replacement.  It will block on the outer
    // chat lock, which is held by the revoke child while it waits for the
    // inner group-mode lock.
    const replacementSource = (action: Record<string, unknown>) => `
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      try {
        await coordinator.runReviewerReplacement({
          dataDir: ${JSON.stringify(f.dataDir)}, chatId: ${JSON.stringify(f.context.chatId)},
          larkAppId: ${JSON.stringify(f.context.larkAppId)},
          coordinatorSessionId: ${JSON.stringify(f.context.coordinatorSessionId)},
        }, ${JSON.stringify(action)});
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;

    // Compute the outer lock file path — the exact file that
    // withProjectTaskControlChatLockSync acquires.
    const chatLockFile = join(
      f.dataDir,
      `.task-control-chat-${createHash('sha256').update(f.context.chatId).digest('hex').slice(0, 24)}.lock`,
    );

    // 1. Start the holder child (acquires inner lock, signals ready)
    // Immediately create the completion promise per child so the finally
    // block can drain every started process without double-listening.
    const completionPromises: ReturnType<typeof collectChild>[] = [];
    let holderChild: ReturnType<typeof spawnTsEvalWithRepoImports> | undefined;
    let revokeChild: ReturnType<typeof spawnTsEvalWithRepoImports> | undefined;
    let replacementChild: ReturnType<typeof spawnTsEvalWithRepoImports> | undefined;
    try {
      holderChild = spawnTsEvalWithRepoImports(holderSource, {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      });
      completionPromises.push(collectChild(holderChild));

      // 2. Wait for the holder to signal "ready" (barrier)
      const readyStart = Date.now();
      while (!existsSync(holdReadyFile)) {
        if (Date.now() - readyStart > 5_000) throw new Error('barrier timeout: holder did not signal ready');
      }

      // 3. Start the revoke child — it acquires the outer lock, then blocks
      //    on the inner group-mode lock held by the holder.
      revokeChild = spawnTsEvalWithRepoImports(revokeSource, {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      });
      completionPromises.push(collectChild(revokeChild));

      // 4. Poll for the outer lock file: the revoke process must have
      //    acquired it before entering the inner-lock wait.  If the lock
      //    file exists, its holder is the revoke child.
      const outerLockStart = Date.now();
      while (!existsSync(chatLockFile)) {
        if (Date.now() - outerLockStart > 5_000) throw new Error('barrier timeout: revoke did not acquire outer lock');
      }

      // 5. Start the replacement child — it will block on the outer lock.
      replacementChild = spawnTsEvalWithRepoImports(
        replacementSource(reviewerReplacement(delivered.revision)),
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      completionPromises.push(collectChild(replacementChild));

      // 6. Release the inner lock → the revoke commits → releases the outer
      //    lock → the replacement observes the updated collaboration mode.
      writeFileSync(holdReleaseFile, 'release');

      // 7. Collect all children — reuse the saved completion promises to
      //    avoid attaching duplicate listeners.
      const [holderOut, revokeOut, replacementOut] = await Promise.all(completionPromises);
      expect(holderOut.code).toBe(0);
      expect(revokeOut.code).toBe(0);
      expect(replacementOut.code).toBe(0);

      const revokeResult = JSON.parse(revokeOut.stdout.trim());
      const replacementResult = JSON.parse(replacementOut.stdout.trim());
      expect(revokeResult.ok).toBe(true);

      // After the deterministic revoke-first barrier, the replacement MUST
      // observe the updated collaboration mode and reject the stale allowlist.
      expect(replacementResult.ok).toBe(false);
      expect(replacementResult.error).toBe('project_reviewer_not_allowed');

      // Verify no stale-policy commit: revision unchanged, reviewer binding
      // and target set exactly the same as before the rejected replacement.
      const state = readProjectGroup(f.dataDir, f.context.chatId)!;
      expect(state.revision).toBe(delivered.revision);
      expect(state.workstreams[0]?.reviewerAppIds).toEqual(['cli_reviewer']);
      expect(state.workstreams[0]?.targetAppIds).toEqual(['cli_reviewer', 'cli_worker']);
      expect(state.workstreams[0]?.reviewerReplacements?.length ?? 0).toBe(0);
    } finally {
      // Unblock the holder so it can exit cleanly under its own deadline.
      try { writeFileSync(holdReleaseFile, 'release'); } catch { /* best-effort */ }
      for (const child of [holderChild, revokeChild, replacementChild]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGTERM'); } catch { /* best-effort */ }
        }
      }
      // Drain every started child so no zombie processes outlive the test.
      await Promise.allSettled(completionPromises);
    }
  });

  it('grandfathers an existing reviewer binding when the collaboration-mode policy is later revoked (replacement-first order)', async () => {
    // Replacement-first semantics: when a reviewer replacement commits before
    // the collaboration-mode policy revokes the reviewer, the existing binding
    // is grandfathered.  A subsequent policy revoke succeeds (it does not
    // roll back committed bindings), only affecting future replacements.  An
    // exact receipt replay of the original replacement remains idempotent.
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);

    // 1. Replacement first — succeeds (reviewer is still in the policy)
    const action = reviewerReplacement(delivered.revision);
    const first = await f.coordinator.runReviewerReplacement(f.context, action);
    expect(first.project.workstreams[0]?.reviewerReplacements).toHaveLength(1);
    expect(first.project.workstreams[0]?.reviewerAppIds).toContain('cli_reviewer_next');

    // 2. Revoke the reviewer from the collaboration-mode policy — succeeds
    //    (does not roll back the committed binding)
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer'],
    });

    // 3. Existing reviewer binding is grandfathered — still present
    const stateAfter = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(stateAfter.workstreams[0]?.reviewerAppIds).toContain('cli_reviewer_next');
    expect(stateAfter.workstreams[0]?.reviewerReplacements).toHaveLength(1);

    // 4. Policy now excludes the reviewer
    const mode = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
    expect(mode.workerAppIds).not.toContain('cli_reviewer_next');

    // 5. Exact receipt replay of the original replacement remains
    //    idempotent (no new revision)
    const replay = await f.coordinator.runReviewerReplacement(f.context, action);
    expect(replay.project.revision).toBe(first.project.revision);
    expect(replay.project.workstreams[0]?.reviewerReplacements).toHaveLength(1);
  });

  it('retires the stale onboarding card without re-entering the chat lock during reviewer replacement', async () => {
    const f = fixture();
    const delivered = await deliveredWriteWorkstream(f);

    // Inject a stale onboardingCard to verify that publish (now outside the
    // chat lock) can retire it without re-entering the same non-reentrant
    // .task-control-chat-<hash>.lock.
    const registryPath = join(f.dataDir, 'group-collaboration-modes.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.configs[f.context.chatId].onboardingCard = {
      messageId: 'om_guide_stale',
      pinned: true,
      larkAppId: f.context.larkAppId,
      createdAt: '2026-10-13T10:00:00.000Z',
      updatedAt: '2026-10-13T10:00:00.000Z',
    };
    writeFileSync(registryPath, JSON.stringify(registry));

    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard?.messageId)
      .toBe('om_guide_stale');

    const start = Date.now();
    const result = await f.coordinator.runReviewerReplacement(
      f.context,
      reviewerReplacement(delivered.revision),
    );
    const elapsed = Date.now() - start;

    // GREEN: publish runs outside the chat lock, so the onboarding card
    // retirement completes without re-entering the lock.
    expect(result.projectionWarning).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);

    // Durable commit and projection must both succeed.
    expect(result.project.revision).toBe(delivered.revision + 1);
    expect(result.project.workstreams[0]?.reviewerAppIds).toEqual(['cli_reviewer_next']);

    // The stale onboardingCard must be cleared by the successful publish.
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
  });

  it.each([
    { workerAppIds: [], reviewerAppIds: ['cli_reviewer'], error: 'project_worker_required' },
    { workerAppIds: ['cli_worker'], reviewerAppIds: [], error: 'project_reviewer_required' },
    { workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_worker'], error: 'project_review_roles_overlap' },
    { workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'], targetAppIds: ['cli_worker', 'cli_reviewer', 'cli_extra'], error: 'project_dispatch_role_targets_mismatch' },
  ])('rejects invalid write role partition: %o', async ({ workerAppIds, reviewerAppIds, targetAppIds, error }) => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    const targets = targetAppIds ?? ['cli_worker', 'cli_reviewer'];
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'roles', targetAppIds: targets,
      access: { mode: 'write', scopes: [f.dataDir] },
    });
    await expect(f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: 'roles', targetAppIds: targets,
      workerAppIds, reviewerAppIds, dispatchRoot: 'om_roles', title: '角色校验',
    })).rejects.toThrow(error);
  });

  it('records reviewer failure, rejects natural-language pass, and invalidates old review on new delivery', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_other',
      content: '实现完成', status: 'completed',
    })).rejects.toThrow('project_worker_not_allowed');
    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '第一版', status: 'completed',
    });
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer', content: 'PASS',
      status: 'completed',
    })).rejects.toThrow('project_worker_not_allowed');
    const failed = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer', content: '缺少边界测试',
      reviewVerdict: 'fail', reviewRound: 1,
    });
    expect(failed.workstreams[0]).toMatchObject({ status: 'blocked', blocker: '缺少边界测试' });

    const redelivered = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '第一版', status: 'completed',
    });
    expect(redelivered.workstreams[0]).toMatchObject({ status: 'in_review', delivery: { round: 2 } });
    expect(redelivered.workstreams[0]).not.toHaveProperty('review');
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer', content: '旧轮通过',
      reviewVerdict: 'pass', reviewRound: 1,
    })).rejects.toThrow('project_review_round_mismatch');
  });

  it('preserves delivery and reviewer failure when a TaskControl worker reports terminal failure', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    await attachProjectTaskControl(f);
    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '交付候选', status: 'completed',
    });
    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer',
      content: '验收失败', reviewVerdict: 'fail', reviewRound: 1,
    });

    const failed = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '按验收结论终结，不再返修', status: 'failed', progress: 99,
    });
    expect(failed.workstreams[0]).toMatchObject({
      status: 'failed', progress: 99, blocker: '按验收结论终结，不再返修',
      delivery: { reportedByAppId: 'cli_worker', content: '交付候选', round: 1 },
      review: { reviewerAppId: 'cli_reviewer', verdict: 'fail', content: '验收失败', round: 1 },
    });
    expect(failed.workstreams[0]!.delivery!.reportedAt).toBeTruthy();
    expect(failed.workstreams[0]!.review!.reviewedAt).toBeTruthy();
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_other',
      content: '按验收结论终结，不再返修', status: 'failed', progress: 99,
    })).rejects.toThrow('project_worker_not_allowed');
    const repeated = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '按验收结论终结，不再返修', status: 'failed', progress: 99,
    });
    expect(repeated.revision).toBe(failed.revision);
    const repeatedReview = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer',
      content: '验收失败', reviewVerdict: 'fail', reviewRound: 1,
    });
    expect(repeatedReview.revision).toBe(failed.revision);
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '漂移后的失败理由', status: 'failed', progress: 99,
    })).rejects.toThrow('project_task_control_terminal_workstream');
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '错误恢复', status: 'in_progress', progress: 50,
    })).rejects.toThrow('project_task_control_terminal_workstream');
  });

  it('does not let a TaskControl worker replace a completed review with failure', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    await attachProjectTaskControl(f);
    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '交付候选', status: 'completed',
    });
    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer',
      content: '验收通过', reviewVerdict: 'pass', reviewRound: 1,
    });
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '迟到失败', status: 'failed',
    })).rejects.toThrow('project_task_control_terminal_workstream');
  });

  it('rejects legacy dispatch lifecycle updates for write workstreams', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_reviewed', title: '', purpose: '',
      status: 'completed', progress: 100,
    })).rejects.toThrow('project_write_lifecycle_requires_report');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams[0]).toMatchObject({
      status: 'pending', progress: 0,
    });
  });

  it('lets the coordinator explicitly fail a committed write dispatch after kickoff failure', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    const failed = await f.coordinator.run(f.context, {
      action: 'fail_dispatch', dispatchRoot: 'om_reviewed', reason: 'dispatch delivery failed',
    });
    expect(failed.workstreams[0]).toMatchObject({
      status: 'failed', progress: 0, blocker: 'dispatch delivery failed',
    });
    const repeated = await f.coordinator.run(f.context, {
      action: 'fail_dispatch', dispatchRoot: 'om_reviewed', reason: 'dispatch delivery failed',
    });
    expect(repeated.revision).toBe(failed.revision);
    await expect(f.coordinator.run(f.context, {
      action: 'fail_dispatch', dispatchRoot: 'om_reviewed', reason: 'another reason',
    })).rejects.toThrow('project_dispatch_failure_transition_invalid');
  });

  it('blocks close on active reservations, removes expired reservations, and forbids new claims after close', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'active', targetAppIds: ['cli_reader'],
      access: { mode: 'read_only' }, now: '2026-09-25T00:00:00.000Z', ttlMs: 60_000,
    });
    await expect(f.coordinator.run(f.context, {
      action: 'close', now: '2026-09-25T00:00:30.000Z',
    })).rejects.toThrow('project_dispatch_reservations_active');
    const closed = await f.coordinator.run(f.context, {
      action: 'close', now: '2026-09-25T00:02:00.000Z',
    });
    expect(closed.status).toBe('completed');
    expect(closed.dispatchReservations).toEqual([]);

    await expect(f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'late', targetAppIds: ['cli_reader'],
      access: { mode: 'read_only' },
    })).rejects.toThrow('project_not_active');
    await expect(f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: 'missing', targetAppIds: ['cli_reader'],
      dispatchRoot: 'om_late', title: '关闭后任务',
    })).rejects.toThrow('project_not_active');
    await expect(f.coordinator.run(f.context, {
      action: 'abort_dispatch', reservationId: 'cleanup', targetAppIds: ['cli_reader'],
    })).resolves.toMatchObject({ status: 'completed' });
  });

  it('rejects a reviewer verdict before any worker delivery', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_reviewer',
      content: '提前通过', reviewVerdict: 'pass', reviewRound: 1,
    })).rejects.toThrow('project_delivery_required');
  });

  it('keeps read-only completion direct and blocks close while work remains non-terminal', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'readonly', targetAppIds: ['cli_reader'], access: { mode: 'read_only' },
    });
    await f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: 'readonly', targetAppIds: ['cli_reader'],
      dispatchRoot: 'om_readonly', title: '只读审计',
    });
    await expect(f.coordinator.run(f.context, { action: 'close' })).rejects.toThrow('project_workstreams_not_terminal');
    const completed = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_readonly', reporterAppId: 'cli_reader',
      content: '审计完成', status: 'completed',
    });
    expect(completed.workstreams[0]).toMatchObject({ status: 'completed', progress: 100 });
    await expect(f.coordinator.run(f.context, { action: 'close' })).resolves.toMatchObject({ status: 'completed' });
  });

  it('atomically reserves overlapping write scopes across independent coordinators', async () => {
    const f = fixture();
    const src = join(f.dataDir, 'repo', 'src');
    const api = join(src, 'api');
    mkdirSync(api, { recursive: true });
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    const other = new ProjectCoordinator(f.transport);

    const results = await Promise.allSettled([
      f.coordinator.run(f.context, {
        action: 'reserve_dispatch', reservationId: 'reservation-a', targetAppIds: ['cli_worker_a'],
        access: { mode: 'write', scopes: [src] },
      }),
      other.run(f.context, {
        action: 'reserve_dispatch', reservationId: 'reservation-b', targetAppIds: ['cli_worker_b'],
        access: { mode: 'write', scopes: [api] },
      }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(readProjectGroup(f.dataDir, f.context.chatId)).toMatchObject({
      workstreams: [],
      dispatchReservations: [expect.objectContaining({ access: expect.objectContaining({ mode: 'write' }) })],
    });
  });

  it('reclaims an expired reservation and commits or aborts without phantom workstreams', async () => {
    const f = fixture();
    const scope = join(f.dataDir, 'repo');
    mkdirSync(scope);
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'abandoned', targetAppIds: ['cli_worker', 'cli_reviewer'],
      access: { mode: 'write', scopes: [scope] }, now: '2026-09-25T00:00:00.000Z',
    });

    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'replacement', targetAppIds: ['cli_worker', 'cli_reviewer'],
      access: { mode: 'write', scopes: [scope] }, now: '2026-09-25T00:05:00.000Z',
    });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations.map(item => item.reservationId))
      .toEqual(['replacement']);

    const committed = await f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: 'replacement', targetAppIds: ['cli_worker', 'cli_reviewer'],
      workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'],
      dispatchRoot: 'om_reserved', title: '实现接口', purpose: '完成接口实现', owners: ['展示名'],
    });
    expect(committed.dispatchReservations).toEqual([]);
    expect(committed.workstreams[0]).toMatchObject({
      dispatchRoot: 'om_reserved', targetAppIds: ['cli_reviewer', 'cli_worker'],
      access: { mode: 'write', scopes: [scope] },
    });

    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'read-only', targetAppIds: ['cli_worker'],
      access: { mode: 'read_only' },
    });
    const aborted = await f.coordinator.run(f.context, {
      action: 'abort_dispatch', reservationId: 'read-only', targetAppIds: ['cli_worker'],
    });
    const repeatedAbort = await f.coordinator.run(f.context, {
      action: 'abort_dispatch', reservationId: 'read-only', targetAppIds: ['cli_worker'],
    });
    expect(aborted.dispatchReservations).toEqual([]);
    expect(repeatedAbort.dispatchReservations).toEqual([]);
    expect(aborted.workstreams).toHaveLength(1);
    expect(repeatedAbort.revision).toBe(aborted.revision);
    expect(repeatedAbort.updatedAt).toBe(aborted.updatedAt);
  });

  it('allows non-overlapping writes and read-only reservations', async () => {
    const f = fixture();
    const left = join(f.dataDir, 'left');
    const right = join(f.dataDir, 'right');
    mkdirSync(left);
    mkdirSync(right);
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });

    for (const action of [
      { action: 'reserve_dispatch' as const, reservationId: 'left', targetAppIds: ['cli_a'], access: { mode: 'write' as const, scopes: [left] } },
      { action: 'reserve_dispatch' as const, reservationId: 'right', targetAppIds: ['cli_b'], access: { mode: 'write' as const, scopes: [right] } },
      { action: 'reserve_dispatch' as const, reservationId: 'reader', targetAppIds: ['cli_c'], access: { mode: 'read_only' as const } },
    ]) await new ProjectCoordinator({ ...f.transport }).run(f.context, action);

    expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations).toHaveLength(3);
  });

  it('makes an identical reservation idempotent and rejects conflicting reuse', async () => {
    const f = fixture();
    const scope = join(f.dataDir, 'repo');
    const child = join(scope, 'child');
    mkdirSync(child, { recursive: true });
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    const reserve = {
      action: 'reserve_dispatch' as const, reservationId: 'same', targetAppIds: ['cli_b', 'cli_a'],
      access: { mode: 'write' as const, scopes: [child, scope] }, now: '2026-09-25T00:00:00.000Z',
    };
    await f.coordinator.run(f.context, reserve);
    const beforeRepeat = readProjectGroup(f.dataDir, f.context.chatId)!;
    await f.coordinator.run(f.context, {
      ...reserve, targetAppIds: ['cli_a', 'cli_b'], access: { mode: 'write', scopes: [scope] },
    });
    const afterRepeat = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(afterRepeat.revision).toBe(beforeRepeat.revision);
    expect(afterRepeat.updatedAt).toBe(beforeRepeat.updatedAt);
    expect(afterRepeat.dispatchReservations).toEqual([
      expect.objectContaining({ access: { mode: 'write', scopes: [scope] } }),
    ]);

    await expect(f.coordinator.run(f.context, { ...reserve, targetAppIds: ['cli_other'] }))
      .rejects.toThrow('project_dispatch_reservation_conflict');
    await expect(f.coordinator.run(f.context, { ...reserve, access: { mode: 'read_only' } }))
      .rejects.toThrow('project_dispatch_reservation_conflict');
    await expect(f.coordinator.run(f.context, { ...reserve, reservationId: '' }))
      .rejects.toThrow('project_dispatch_reservation_id_required');
  });

  it('fails closed for invalid commit and abort reservation identities', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'reserved', targetAppIds: ['cli_worker'],
      access: { mode: 'read_only' },
    });

    await expect(f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: 'missing', targetAppIds: ['cli_worker'],
      dispatchRoot: 'om_missing', title: '缺失申请',
    })).rejects.toThrow('project_dispatch_reservation_not_found');
    await expect(f.coordinator.run(f.context, {
      action: 'abort_dispatch', reservationId: 'reserved', targetAppIds: ['cli_other'],
    })).rejects.toThrow('project_dispatch_reservation_identity_mismatch');
    await expect(f.coordinator.run(f.context, {
      action: 'abort_dispatch', reservationId: '', targetAppIds: ['cli_worker'],
    })).rejects.toThrow('project_dispatch_reservation_id_required');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.dispatchReservations).toHaveLength(1);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid reservation ttl %s', async ttlMs => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await expect(f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'bad-ttl', targetAppIds: ['cli_worker'],
      access: { mode: 'read_only' }, ttlMs,
    })).rejects.toThrow('project_dispatch_reservation_ttl_invalid');
  });

  it('keeps a durable commit successful when card projection is unavailable', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'durable', targetAppIds: ['cli_worker'],
      access: { mode: 'read_only' },
    });
    f.transport.updateCard = vi.fn(async () => { throw new Error('projection unavailable'); });

    await expect(f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: 'durable', targetAppIds: ['cli_worker'],
      dispatchRoot: 'om_durable', title: '持久提交',
    })).resolves.toMatchObject({
      dispatchReservations: [],
      workstreams: [expect.objectContaining({ dispatchRoot: 'om_durable', status: 'pending', progress: 0 })],
    });
    expect(f.transport.updateCard).not.toHaveBeenCalled();
  });

  it('returns an explicit warning when write report projection fails after durable update', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    f.transport.updateCard = vi.fn(async () => { throw new Error('projection unavailable'); });

    const result = await f.coordinator.runReport(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '实现完成', status: 'completed',
    });
    expect(result).toMatchObject({
      write: true, projectionWarning: 'projection unavailable',
      project: { workstreams: [expect.objectContaining({
        status: 'in_review', delivery: expect.objectContaining({ round: 1 }),
      })] },
    });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams[0]).toMatchObject({
      status: 'in_review', delivery: { round: 1 },
    });
  });

  it('keeps direct write reports durable-only for existing coordinator callers', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    f.transport.updateCard.mockClear();

    const result = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '实现完成', status: 'completed',
    });

    expect(result.workstreams[0]).toMatchObject({ status: 'in_review', delivery: { round: 1 } });
    expect(f.transport.updateCard).not.toHaveBeenCalled();
  });

  it('refreshes the card after a durable report when projection succeeds', async () => {
    const f = fixture();
    await committedWriteWorkstream(f);
    f.transport.updateCard.mockClear();

    const result = await f.coordinator.runReport(f.context, {
      action: 'report', dispatchRoot: 'om_reviewed', reporterAppId: 'cli_worker',
      content: '实现完成', status: 'completed',
    });

    expect(result).not.toHaveProperty('projectionWarning');
    expect(result.project.workstreams[0]).toMatchObject({
      status: 'in_review', delivery: { round: 1 },
    });
    expect(f.transport.updateCard).toHaveBeenCalledOnce();
  });

  it.each([
    ['pending', true],
    ['in_progress', true],
    ['blocked', true],
    ['completed', false],
    ['failed', false],
  ] as const)('%s workstream claim conflict=%s', async (status, conflicts) => {
    const f = fixture();
    const scope = join(f.dataDir, 'repo');
    mkdirSync(scope);
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'first', targetAppIds: ['cli_a', 'cli_reviewer'],
      access: { mode: 'write', scopes: [scope] },
    });
    await f.coordinator.run(f.context, {
      action: 'commit_dispatch', reservationId: 'first', targetAppIds: ['cli_a', 'cli_reviewer'],
      workerAppIds: ['cli_a'], reviewerAppIds: ['cli_reviewer'],
      dispatchRoot: 'om_first', title: '首个任务',
    });
    if (status === 'completed') {
      await f.coordinator.run(f.context, {
        action: 'report', dispatchRoot: 'om_first', reporterAppId: 'cli_a', content: '完成交付', status: 'completed',
      });
      await f.coordinator.run(f.context, {
        action: 'report', dispatchRoot: 'om_first', reporterAppId: 'cli_reviewer',
        content: '验收通过', reviewVerdict: 'pass', reviewRound: 1,
      });
    } else if (status !== 'pending') {
      await f.coordinator.run(f.context, {
        action: 'report', dispatchRoot: 'om_first', reporterAppId: 'cli_a', content: '状态更新', status,
      });
    }
    const second = f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'second', targetAppIds: ['cli_b'],
      access: { mode: 'write', scopes: [scope] },
    });
    if (conflicts) await expect(second).rejects.toThrow('project_write_scope_conflict');
    else await expect(second).resolves.toBeDefined();
  });

  it('reads and migrates legacy project state without reservation or workstream access fields', async () => {
    const f = fixture();
    const now = '2026-09-25T00:00:00.000Z';
    writeFileSync(join(f.dataDir, 'project-groups.json'), JSON.stringify({
      schemaVersion: 1,
      projects: {
        [f.context.chatId]: {
          schemaVersion: 1, revision: 1, chatId: f.context.chatId, larkAppId: f.context.larkAppId,
          coordinatorSessionId: f.context.coordinatorSessionId, title: '旧项目', goal: '兼容读取',
          phase: '执行', focus: '保持兼容', status: 'active', blockers: [],
          workstreams: [{
            dispatchRoot: 'om_legacy', title: '旧任务', purpose: '旧数据', owners: [],
            status: 'pending', progress: 0, createdAt: now, updatedAt: now,
          }],
          milestones: [], createdAt: now, updatedAt: now,
        },
      },
    }));

    expect(readProjectGroup(f.dataDir, f.context.chatId)).toMatchObject({
      schemaVersion: 3, title: '旧项目',
      workstreams: [{ dispatchRoot: 'om_legacy' }],
    });
    await f.coordinator.run(f.context, { action: 'update', focus: '迁移后继续' });
    expect(JSON.parse(readFileSync(join(f.dataDir, 'project-groups.json'), 'utf8'))).toMatchObject({
      schemaVersion: 3, projects: { [f.context.chatId]: { schemaVersion: 3 } },
    });
  });

  it('rejects a directly edited satisfied completion gate without exact durable evidence', () => {
    const f = fixture();
    const now = '2026-09-29T12:00:00.000Z';
    writeFileSync(join(f.dataDir, 'project-groups.json'), JSON.stringify({
      schemaVersion: 3,
      projects: {
        [f.context.chatId]: {
          schemaVersion: 3, revision: 1, chatId: f.context.chatId, larkAppId: f.context.larkAppId,
          coordinatorSessionId: f.context.coordinatorSessionId, title: '父级', goal: '等待子群', phase: '执行', focus: '验证',
          status: 'active', blockers: [], blockerRecords: [], workstreams: [], milestones: [], createdAt: now, updatedAt: now,
          completionGates: [{
            gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
            taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群',
            definitionFingerprint: 'pcg1:forged', status: 'satisfied', reason: 'verified', checkedAt: now,
            createdAt: now, updatedAt: now,
          }],
        },
      },
    }));

    expect(() => readProjectGroup(f.dataDir, f.context.chatId))
      .toThrow('project-groups.json has invalid completion gate');
  });

  it('rejects a directly edited completion-gate replacement with a broken audit link', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级', goal: '等待子群' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child-v1', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v1',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群 v1', now: '2026-09-29T12:00:00.000Z',
    });
    await f.coordinator.run(f.context, {
      action: 'replace_completion_gate', gateId: 'child-v1',
      expectedDefinitionFingerprint: added.completionGates![0]!.definitionFingerprint,
      newGateId: 'child-v2', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
      taskGuid: '22222222-2222-4222-8222-222222222222', label: '子群 v2',
      authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
      reason: '改用新一轮验收', now: '2026-09-29T12:01:00.000Z',
    });
    const path = join(f.dataDir, 'project-groups.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.projects[f.context.chatId].completionGates[1].definitionFingerprint).toBe(
      projectCompletionGateFingerprint({
        gateId: 'child-v2', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
        taskGuid: '22222222-2222-4222-8222-222222222222',
      }),
    );
    raw.projects[f.context.chatId].completionGates[1].replacesGateId = 'different-gate';
    writeFileSync(path, JSON.stringify(raw));

    expect(() => readProjectGroup(f.dataDir, f.context.chatId))
      .toThrow('project-groups.json has invalid completion gate replacement chain');
  });

  it('rejects a directly edited retirement without a verified human actor', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级', goal: '等待子群' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child', sourceChatId: 'oc_child', dispatchRoot: 'om_child',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群', now: '2026-09-29T12:00:00.000Z',
    });
    await f.coordinator.run(f.context, {
      action: 'retire_completion_gate', gateId: 'child',
      expectedDefinitionFingerprint: added.completionGates![0]!.definitionFingerprint,
      authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
      reason: '依赖已取消', now: '2026-09-29T12:01:00.000Z',
    });
    const path = join(f.dataDir, 'project-groups.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    delete raw.projects[f.context.chatId].completionGates[0].retirement.authorizedByOpenId;
    writeFileSync(path, JSON.stringify(raw));

    expect(() => readProjectGroup(f.dataDir, f.context.chatId))
      .toThrow('project-groups.json has invalid completion gate retirement');
  });

  it('rejects a directly edited cyclic completion-gate replacement chain', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '父级', goal: '等待子群' });
    const added = await f.coordinator.run(f.context, {
      action: 'add_completion_gate', gateId: 'child-v1', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v1',
      taskGuid: '11111111-1111-4111-8111-111111111111', label: '子群 v1', now: '2026-09-29T12:00:00.000Z',
    });
    await f.coordinator.run(f.context, {
      action: 'replace_completion_gate', gateId: 'child-v1',
      expectedDefinitionFingerprint: added.completionGates![0]!.definitionFingerprint,
      newGateId: 'child-v2', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
      taskGuid: '22222222-2222-4222-8222-222222222222', label: '子群 v2',
      authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
      reason: '改用新一轮验收', now: '2026-09-29T12:01:00.000Z',
    });
    const path = join(f.dataDir, 'project-groups.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.projects[f.context.chatId].completionGates[0].replacesGateId = 'child-v2';
    raw.projects[f.context.chatId].completionGates[1].retirement = {
      retiredAt: '2026-09-29T12:02:00.000Z', retiredBySessionId: 'session_main',
      authorizationRef: 'om_authorization', authorizedByOpenId: 'ou_authorizer',
      reason: '伪造循环', replacementGateId: 'child-v1',
    };
    writeFileSync(path, JSON.stringify(raw));

    expect(() => readProjectGroup(f.dataDir, f.context.chatId))
      .toThrow('project-groups.json has invalid completion gate replacement chain');
  });

  it('replaces the onboarding guide with a fresh pinned project card when the project starts', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
    });
    const first = await f.coordinator.ensureOnboardingCard(f.context, {
      coordinatorName: 'nodex', workerNames: ['Seed Bot'],
    });
    expect(first).toMatchObject({ messageId: 'om_card_1', pinned: true, larkAppId: 'cli_coordinator' });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.pinMessage).toHaveBeenCalledTimes(1);
    expect(f.cards[0]).toContain('项目群已就绪');
    expect(f.cards[0]).toContain('先讨论');
    expect(f.cards[0]).toContain('直接执行');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard?.messageId).toBe('om_card_1');

    await f.coordinator.ensureOnboardingCard(f.context, {
      coordinatorName: 'nodex', workerNames: ['Seed Bot', 'GLM Bot'],
    });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.updateCard).toHaveBeenCalledWith('cli_coordinator', 'om_card_1', expect.stringContaining('GLM Bot'));

    const project = await f.coordinator.run(f.context, {
      action: 'init', title: '引导卡切换验收', goal: '用新卡明确展示项目已经启动',
    });
    expect(project.card).toMatchObject({ messageId: 'om_card_2', pinned: true });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(f.transport.pinMessage).toHaveBeenLastCalledWith('cli_coordinator', 'om_card_2');
    expect(f.transport.unpinMessage).toHaveBeenCalledWith('cli_coordinator', 'om_card_1');
    expect(f.transport.updateCard).not.toHaveBeenCalledWith(
      'cli_coordinator',
      'om_card_1',
      expect.stringContaining('引导卡切换验收'),
    );
    expect(f.transport.updateCard).toHaveBeenCalledWith(
      'cli_coordinator', 'om_card_1', expect.stringContaining('项目已启动'),
    );
    const retiredGuide = vi.mocked(f.transport.updateCard).mock.calls
      .filter(call => call[1] === 'om_card_1').at(-1)![2];
    expect(JSON.parse(retiredGuide).header.title.content).toBe('项目已启动');
    expect(JSON.parse(retiredGuide).config.summary.content).toBe('项目已启动，请查看项目进度卡');
    expect(retiredGuide).not.toContain('待启动');
    expect(retiredGuide).not.toContain('直接执行');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
  });

  it('retries retiring the old onboarding pin after a best-effort unpin failure', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
    });
    await f.coordinator.ensureOnboardingCard(f.context, {
      coordinatorName: 'nodex', workerNames: ['Seed Bot'],
    });
    f.transport.unpinMessage = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const started = await f.coordinator.run(f.context, {
      action: 'init', title: '项目已启动', goal: '验证旧引导卡清理可重试',
    });
    expect(started.card).toMatchObject({ messageId: 'om_card_2', pinned: true });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.card).toMatchObject({
      messageId: 'om_card_2', pinned: true,
    });
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard?.messageId).toBe('om_card_1');

    const refreshed = await f.coordinator.run(f.context, { action: 'refresh' });
    expect(refreshed.card?.messageId).toBe('om_card_2');
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(f.transport.updateCard).toHaveBeenCalledWith(
      'cli_coordinator', 'om_card_2', expect.stringContaining('项目已启动'),
    );
    expect(f.transport.unpinMessage).toHaveBeenCalledTimes(2);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
  });

  it('keeps the guide reference when updating its obsolete text fails and retries on refresh', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
    });
    await f.coordinator.ensureOnboardingCard(f.context, { coordinatorName: 'Bot', workerNames: [] });
    vi.mocked(f.transport.updateCard).mockRejectedValueOnce(new Error('temporary_update_failure'));
    await expect(f.coordinator.run(f.context, {
      action: 'init', title: '启动测试', goal: '保留重试入口',
    })).resolves.toMatchObject({ card: { messageId: 'om_card_2' } });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.card?.messageId).toBe('om_card_2');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard?.messageId).toBe('om_card_1');
    await f.coordinator.run(f.context, { action: 'refresh' });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
  });

  it.each(['withdrawn', 'temporary_unpin_failure'])('keeps project startup successful when guide retirement hits %s', async reason => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId, workerAppIds: [],
    });
    await f.coordinator.ensureOnboardingCard(f.context, { coordinatorName: 'Bot', workerNames: [] });
    if (reason === 'withdrawn') vi.mocked(f.transport.updateCard).mockRejectedValueOnce(new Error(reason));
    else vi.mocked(f.transport.unpinMessage).mockResolvedValueOnce(false);
    await expect(f.coordinator.run(f.context, { action: 'init', title: 'Project', goal: 'Start' }))
      .resolves.toMatchObject({ card: { messageId: 'om_card_2' } });
    await f.coordinator.run(f.context, { action: 'refresh' });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
  });

  it.each([true, false])('retires an expired guide and retries a failed unpin (first unpin=%s)', async unpinned => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId, workerAppIds: [],
    });
    await f.coordinator.ensureOnboardingCard(f.context, { coordinatorName: 'Bot', workerNames: [] });
    vi.mocked(f.transport.updateCard).mockImplementation(async (_app, id) => {
      if (id === 'om_card_1') throw Object.assign(new Error('expired'), { name: 'MessageUpdateExpiredError' });
    });
    vi.mocked(f.transport.unpinMessage).mockResolvedValueOnce(unpinned);
    await f.coordinator.run(f.context, { action: 'init', title: 'Project', goal: 'Start' });
    expect(f.transport.unpinMessage).toHaveBeenCalledWith('cli_coordinator', 'om_card_1');
    expect(!!readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBe(!unpinned);
    await f.coordinator.run(f.context, { action: 'refresh' });
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
    const retiredAttempts = vi.mocked(f.transport.updateCard).mock.calls.filter(call => call[1] === 'om_card_1').length;
    await f.coordinator.run(f.context, { action: 'refresh' });
    expect(vi.mocked(f.transport.updateCard).mock.calls.filter(call => call[1] === 'om_card_1')).toHaveLength(retiredAttempts);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
  });

  it('renders the started notice in the requested locale without assuming pin success', () => {
    const english = JSON.stringify(buildProjectGroupStartedNoticeCard('en'));
    expect(JSON.parse(english).header.title.content).toBe('Project started');
    expect(JSON.parse(english).config.summary.content).toBe('Project started. See the project progress card.');
    expect(english).toContain('do not need to send the start command again');
    expect(english).not.toContain('pinned');
    expect(JSON.stringify(buildProjectGroupStartedNoticeCard('zh'))).toContain('无需再次发送启动指令');
  });

  it('unpins and clears an unused onboarding guide when project mode is disabled', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
    });
    await f.coordinator.ensureOnboardingCard(f.context, {
      coordinatorName: 'nodex', workerNames: ['Seed Bot'],
    });
    expect(await f.coordinator.clearOnboardingCard(f.context)).toBe(true);
    expect(f.transport.unpinMessage).toHaveBeenCalledWith('cli_coordinator', 'om_card_1');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
  });

  it('creates one pinned plan-list projection backed by a private durable store', async () => {
    const f = fixture();
    const project = await f.coordinator.run(f.context, {
      action: 'init', title: '结算链路治理', goal: '在 09-12 前完成联调与灰度', phase: '方案确认', focus: '拆分首批子任务',
    });
    expect(project.card).toMatchObject({ messageId: 'om_card_1', pinned: true });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.pinMessage).toHaveBeenCalledWith('cli_coordinator', 'om_card_1');
    const rendered = JSON.parse(f.cards[0]!);
    expect(rendered.schema).toBe('2.0');
    expect(rendered.header.title.content).toBe('结算链路治理');
    expect(f.cards[0]).not.toContain('总体进度');
    expect(f.cards[0]).not.toContain('%');
    expect(f.cards[0]).toContain('推进概况');
    expect(f.cards[0]).toContain('项目按当前阶段推进');
    expect(f.cards[0]).toContain('当前推进');
    expect(f.cards[0]).not.toContain('待办计划');
    expect(f.cards[0]).not.toContain('完成记录');
    expect(f.cards[0]).not.toContain('等待拆解首批任务');
    expect(f.cards[0]).not.toContain('子任务状态（0）');
    expect(f.cards[0]).not.toContain('最近里程碑（0 项）');
    const heroText = rendered.body.elements
      .filter((element: { tag?: string }) => element.tag === 'interactive_container')
      .flatMap((element: { elements?: Array<{ text_size?: string }> }) => element.elements ?? []);
    expect(heroText.filter((element: { text_size?: string }) => element.text_size === 'heading-3')).toHaveLength(2);
    expect(f.cards[0]).not.toContain('示例数据');
    expect(rendered.config.summary.content.length).toBeLessThanOrEqual(60);
    expect(readFileSync(join(f.dataDir, 'project-groups.json'), 'utf8')).not.toContain('larkAppSecret');
  });

  it.each(['status-dashboard', 'compact-list'] as const)('renders and clears a next-only milestone in %s', async (templateId) => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
      progressCard: { schemaVersion: 1, templateId, sections: ['milestones'], milestonesExpanded: false },
    });
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '完成目标' });
    await f.coordinator.run(f.context, { action: 'update', nextMilestone: '发布' });
    expect(f.cards.at(-1)).toContain('最近里程碑（0 项 · 下一节点 发布）');
    const parsed = parseProjectArgs('update', ['--clear-next-milestone']);
    if (!parsed.ok || parsed.help) throw new Error('expected update action');
    await f.coordinator.run(f.context, parsed.action);
    expect(readProjectGroup(f.dataDir, f.context.chatId)).not.toHaveProperty('nextMilestone');
    expect(f.cards.at(-1)).not.toContain('最近里程碑');
    await f.coordinator.run(f.context, { action: 'update', milestone: '设计完成' });
    expect(f.cards.at(-1)).toContain('最近里程碑（1 项）');
    expect(f.cards.at(-1)).toContain('设计完成');
  });

  it('clears the next milestone on close while retaining completion evidence', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '完成目标' });
    await f.coordinator.run(f.context, { action: 'update', nextMilestone: '发布' });
    await f.coordinator.run(f.context, { action: 'close', milestone: '用户验收通过' });
    const stored = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(stored).not.toHaveProperty('nextMilestone');
    expect(stored.milestones.at(-1)?.content).toBe('用户验收通过');
    expect(f.cards.at(-1)).not.toContain('下一节点');
  });

  it('summarizes blockers without inventing subtask counts', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '完成目标' });
    await f.coordinator.run(f.context, { action: 'update', blocker: '等待依赖', focus: '等待依赖' });
    const card = JSON.parse(f.cards.at(-1)!);
    expect(card.config.summary.content).toContain('1 项阻塞');
    expect(card.config.summary.content).not.toContain('子任务');
    await f.coordinator.run(f.context, { action: 'update', clearBlockers: true });
    expect(JSON.parse(f.cards.at(-1)!).config.summary.content).toContain('项目按当前阶段推进');
  });

  it('does not point remaining-plan overflow at a missing subtask table', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '完成目标' });
    await f.coordinator.run(f.context, { action: 'update', remaining: '一·二·三·四·五' });
    expect(f.cards.at(-1)).toContain('另有 1 项');
    expect(f.cards.at(-1)).not.toContain('见下方子任务表');
    expect(JSON.parse(f.cards.at(-1)!).body.elements.some((e: { tag: string }) => e.tag === 'table')).toBe(false);
  });

  it('registers dispatch topics, resolves real topic links, and applies report progress', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    const dispatched = await f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_subtask', title: '联调验证', purpose: '验证价格和库存链路',
      owners: ['worker-a'], status: 'in_progress', progress: 35,
    });
    expect(dispatched.workstreams[0]).toMatchObject({
      dispatchRoot: 'om_subtask', threadId: 'omt_topic', title: '联调验证', progress: 35,
    });
    const rendered = JSON.parse(f.cards.at(-1)!);
    const table = rendered.body.elements.find((element: { tag?: string }) => element.tag === 'table');
    expect(table.rows[0].status).toContain('[进入话题](https://applink.feishu.cn/client/thread/open?');
    expect(table.rows[0].status).toContain('open_thread_id=omt_topic');
    expect(table.rows[0].wf).toContain("color='indigo'");
    expect(table.rows[0].wf).toContain("color='purple'");
    expect(table.columns.map((column: { name: string }) => column.name)).toEqual(['wf', 'status']);
    expect(table.rows[0].status).not.toContain('%');
    expect(f.cards.at(-1)).not.toContain('"tag":"button"');

    const coordinated = await f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_subtask', title: '', purpose: '',
      owners: ['worker-a'], status: 'in_progress', progress: 40,
    });
    expect(coordinated.workstreams[0]).toMatchObject({
      title: '联调验证', purpose: '验证价格和库存链路', progress: 40,
    });
    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_subtask', title: '子任务', purpose: '',
      owners: ['worker-a'], status: 'in_progress', progress: 50,
    })).rejects.toThrow('project_workstream_title_required');

    const reported = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_subtask', content: '全部用例通过',
      status: 'completed', remaining: '无', milestone: '联调通过',
    });
    expect(reported.workstreams[0]).toMatchObject({ status: 'completed', progress: 100, lastReport: '全部用例通过' });
    expect(reported.milestones.at(-1)?.content).toBe('联调通过');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams[0]?.status).toBe('completed');

    const coordinatedWithoutLifecycle = await f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_subtask', title: '', purpose: '',
    });
    expect(coordinatedWithoutLifecycle.workstreams[0]).toMatchObject({
      title: '联调验证', purpose: '验证价格和库存链路', owners: ['worker-a'],
      status: 'completed', progress: 100,
    });
  });

  it('rejects missing, generic, and overlong titles for new workstreams', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_missing_title', title: '', purpose: '验证标题门禁', status: 'pending',
    })).rejects.toThrow('project_workstream_title_required');
    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_generic_title', title: '子任务', purpose: '验证标题门禁', status: 'pending',
    })).rejects.toThrow('project_workstream_title_required');
    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_long_title', title: '这是一个明显超过二十四个字符并且不适合展示在项目卡片里的标题', purpose: '验证标题门禁', status: 'pending',
    })).rejects.toThrow('project_workstream_title_too_long');
  });

  it('rejects legacy workstream creation after project mode is explicitly configured', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
    });

    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_unreserved', title: '绕过申请', purpose: '验证门禁',
    })).rejects.toThrow('project_dispatch_reservation_required');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams).toEqual([]);
  });

  it('keeps shared blocker text until every blocked workstream clears it', async () => {
    const f = fixture();
    f.transport.resolveThreadId = vi.fn(async (_appId, root) => root === 'om_alpha' ? 'omt_alpha' : 'omt_beta');
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    for (const root of ['om_alpha', 'om_beta']) {
      await f.coordinator.run(f.context, {
        action: 'dispatch', dispatchRoot: root, title: root, purpose: '验证阻塞语义', status: 'in_progress', progress: 20,
      });
      await f.coordinator.run(f.context, {
        action: 'report', dispatchRoot: root, content: '等待同一外部依赖', status: 'blocked', progress: 20,
      });
    }
    let project = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(project.blockerRecords).toHaveLength(2);
    expect(project.blockers).toEqual(['等待同一外部依赖', '等待同一外部依赖']);

    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_alpha', content: 'alpha 已恢复', status: 'in_progress', progress: 60,
    });
    project = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(project.blockers).toEqual(['等待同一外部依赖']);
    const cardWhileBlocked = JSON.parse(f.cards.at(-1)!);
    const table = cardWhileBlocked.body.elements.find((element: { tag?: string }) => element.tag === 'table');
    expect(table.rows[0].status).toContain('等待同一外部依赖');

    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_beta', content: 'beta 已恢复', status: 'in_progress', progress: 60,
    });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockers).toEqual([]);
  });

  it('recreates and re-pins a withdrawn projection without losing project state', async () => {
    const f = fixture();
    let sends = 0;
    f.transport.sendCard = vi.fn(async (_appId, _chatId, cardJson) => {
      f.cards.push(cardJson);
      sends += 1;
      return `om_card_${sends}`;
    });
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '完成目标' });
    f.transport.updateCard = vi.fn(async () => { throw new Error('withdrawn'); });
    const updated = await f.coordinator.run(f.context, { action: 'update', focus: '恢复卡片' });
    expect(updated.card).toMatchObject({ messageId: 'om_card_2', pinned: true });
    expect(updated.focus).toBe('恢复卡片');
  });

  it('refreshes the same card through a group-level template and section configuration', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '完成目标' });
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId,
      mode: 'project',
      coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
      progressCard: {
        schemaVersion: 1,
        templateId: 'compact-list',
        sections: ['workstreams'],
        milestonesExpanded: false,
      },
    });
    await f.coordinator.run(f.context, { action: 'refresh' });
    expect(f.transport.updateCard).toHaveBeenCalledTimes(1);
    expect(f.cards.at(-1)).toContain('compact-list');
    expect(f.cards.at(-1)).toContain('项目按当前阶段推进');
    expect(f.cards.at(-1)).not.toContain('等待拆解首批任务');
    expect(f.cards.at(-1)).not.toContain('尚未派发子任务');
    expect(f.cards.at(-1)).not.toContain('子任务（0）');
    expect(f.cards.at(-1)).not.toContain('%');
    expect(f.cards.at(-1)).not.toContain('目标：完成目标');
    expect(f.cards.at(-1)).not.toContain('最近里程碑');
  });
});

describe('project CLI parser', () => {
  it('parses an auditable failed-workstream archive command', () => {
    expect(parseProjectArgs('workstream', [
      'archive', '--root', 'om_failed_archive', '--expected-revision', '1219',
      '--authorization-ref', 'om_archive_authorization',
      '--reason', '历史失败已由后续成功批次替代',
    ])).toEqual({
      ok: true, help: false, sessionId: undefined, json: false,
      action: {
        action: 'archive_workstream', dispatchRoot: 'om_failed_archive', expectedRevision: 1219,
        authorizationRef: 'om_archive_authorization', reason: '历史失败已由后续成功批次替代',
      },
    });
    expect(parseProjectArgs('workstream', ['archive', '--root', 'om_failed_archive']))
      .toEqual({
        ok: false,
        error: 'project workstream archive 需要 --root、--expected-revision、--authorization-ref 和 --reason',
      });
  });

  it('parses an auditable workstream reviewer replacement', () => {
    expect(parseProjectArgs('workstream', [
      'reviewer', 'replace', '--root', 'om_reviewed', '--old-app', 'cli_reviewer',
      '--new-app', 'cli_reviewer_next', '--expected-revision', '17',
      '--authorization-ref', 'om_authorization', '--reason', '主 reviewer 不可用',
    ])).toEqual({
      ok: true,
      help: false,
      sessionId: undefined,
      json: false,
      action: {
        action: 'replace_workstream_reviewer',
        dispatchRoot: 'om_reviewed',
        oldReviewerAppId: 'cli_reviewer',
        newReviewerAppId: 'cli_reviewer_next',
        expectedRevision: 17,
        authorizationRef: 'om_authorization',
        reason: '主 reviewer 不可用',
      },
    });
    expect(parseProjectArgs('workstream', [
      'reviewer', 'replace', '--root', 'om_reviewed', '--old-app', 'cli_reviewer',
      '--new-app', 'cli_reviewer_next', '--expected-revision', '17.5',
      '--authorization-ref', 'om_authorization', '--reason', '主 reviewer 不可用',
    ])).toEqual({ ok: false, error: '--expected-revision 必须是正整数' });
    expect(parseProjectArgs('workstream', ['reviewer', 'replace', '--root', 'om_reviewed']))
      .toEqual({
        ok: false,
        error: 'project workstream reviewer replace 需要 --root、--old-app、--new-app、--expected-revision、--authorization-ref 和 --reason',
      });
  });

  it('requires title+goal and validates percentage', () => {
    expect(parseProjectArgs('init', ['--title', 'A'])).toEqual({ ok: false, error: 'project init 需要 --title 和 --goal' });
    expect(parseProjectArgs('update', ['--progress', '101'])).toEqual({ ok: false, error: '--progress 必须是 0-100 的整数' });
    expect(parseProjectArgs('init', ['--title', 'A', '--goal', 'G'])).toMatchObject({
      ok: true, help: false, action: { action: 'init', title: 'A', goal: 'G' },
    });
  });

  it('rejects unknown options instead of silently changing project state', () => {
    expect(parseProjectArgs('update', ['--foucs', 'typo'])).toEqual({ ok: false, error: '未知选项: --foucs' });
    expect(parseProjectArgs('update', ['--clear-next-milestone'])).toMatchObject({
      ok: true,
      action: { action: 'update', nextMilestone: '' },
    });
  });

  it('parses parent completion gate lifecycle commands', () => {
    expect(parseProjectArgs('gate', [
      'add', '--id', 'botmux-clean', '--source-chat-id', 'oc_child',
      '--dispatch-root', 'om_child', '--task-guid', '11111111-1111-4111-8111-111111111111',
      '--label', 'BotMux clean canary',
    ])).toMatchObject({
      ok: true, help: false,
      action: {
        action: 'add_completion_gate', gateId: 'botmux-clean', sourceChatId: 'oc_child',
        dispatchRoot: 'om_child', taskGuid: '11111111-1111-4111-8111-111111111111',
        label: 'BotMux clean canary',
      },
    });
    expect(parseProjectArgs('gate', ['status'])).toMatchObject({
      ok: true, help: false, json: true, action: { action: 'status' },
    });
    expect(parseProjectArgs('gate', [
      'retire', '--id', 'botmux-clean', '--expected-fingerprint', 'pcg1:old',
      '--authorization-ref', 'om_authorization', '--reason', '失败终态已归档',
    ])).toMatchObject({
      ok: true, help: false,
      action: {
        action: 'retire_completion_gate', gateId: 'botmux-clean',
        expectedDefinitionFingerprint: 'pcg1:old', authorizationRef: 'om_authorization', reason: '失败终态已归档',
      },
    });
    expect(parseProjectArgs('gate', [
      'replace', '--id', 'botmux-clean', '--expected-fingerprint', 'pcg1:old',
      '--new-id', 'botmux-clean-v2', '--source-chat-id', 'oc_child', '--dispatch-root', 'om_child_v2',
      '--task-guid', '22222222-2222-4222-8222-222222222222', '--label', 'BotMux clean canary v2',
      '--authorization-ref', 'om_authorization', '--reason', '改用新一轮验收',
    ])).toMatchObject({
      ok: true, help: false,
      action: {
        action: 'replace_completion_gate', gateId: 'botmux-clean',
        expectedDefinitionFingerprint: 'pcg1:old', newGateId: 'botmux-clean-v2',
        sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
        taskGuid: '22222222-2222-4222-8222-222222222222', label: 'BotMux clean canary v2',
        authorizationRef: 'om_authorization', reason: '改用新一轮验收',
      },
    });
    expect(parseProjectArgs('gate', ['add', '--id', 'missing-fields']))
      .toEqual({ ok: false, error: 'project gate add 需要 --id、--source-chat-id、--dispatch-root、--task-guid 和 --label' });
    expect(parseProjectArgs('gate', ['retire', '--id', 'missing-fields']))
      .toEqual({ ok: false, error: 'project gate retire 需要 --id、--expected-fingerprint、--authorization-ref 和 --reason' });
    expect(parseProjectArgs('gate', ['replace', '--id', 'missing-fields']))
      .toEqual({
        ok: false,
        error: 'project gate replace 需要 --id、--expected-fingerprint、--new-id、--source-chat-id、--dispatch-root、--task-guid、--label、--authorization-ref 和 --reason',
      });
    expect(parseProjectArgs('gate', ['remove', '--id', 'botmux-clean']))
      .toEqual({ ok: false, error: 'project gate 只支持 add、status、retire 或 replace' });
    expect(parseProjectArgs('gate', ['status', '--unknown']))
      .toEqual({ ok: false, error: '未知选项: --unknown' });
  });
});
