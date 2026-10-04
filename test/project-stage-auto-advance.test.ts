import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProjectStageAdvanceTriggerRequest,
  deriveProjectStageAdvanceEvent,
  normalizeProjectStageAdvanceEvents,
  projectStageAdvanceFingerprint,
  type ProjectStageAdvanceEvent,
} from '../src/services/project-stage-auto-advance.js';
import { mutateProjectGroup, readProjectGroup } from '../src/services/project-group-store.js';
import { ProjectCoordinator, type ProjectCoordinatorContext, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project() {
  const now = '2026-10-03T00:00:00.000Z';
  return {
    schemaVersion: 3 as const, revision: 8, chatId: 'oc_project', larkAppId: 'cli_coordinator',
    coordinatorSessionId: 'session_main', title: '阶段推进', goal: '验证', phase: '执行', focus: '测试',
    status: 'active' as const, blockers: [], blockerRecords: [], stageAdvanceEvents: [],
    workstreams: [], milestones: [], createdAt: now, updatedAt: now,
  };
}

function transport(): ProjectCoordinatorTransport {
  return {
    sendCard: vi.fn(async () => 'om_card'), updateCard: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => true), unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async () => null),
    isMessageWithdrawn: () => false, brand: () => 'feishu',
  };
}

function event(overrides: Partial<ProjectStageAdvanceEvent> = {}): ProjectStageAdvanceEvent {
  const identity = {
    chatId: 'oc_project', dispatchRoot: 'om_work', kind: 'delivery_ready' as const,
    deliveryRound: 1,
  };
  return {
    ...identity, schemaVersion: 'ProjectStageAdvanceEvent.v1',
    fingerprint: projectStageAdvanceFingerprint(identity), projectRevision: 9,
    status: 'pending', createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
    attemptCount: 0, ...overrides,
  };
}

describe('project stage auto advance', () => {
  it('canonicalizes identity independently of timestamps, revisions and claim metadata', () => {
    const identity = { chatId: 'oc_project', dispatchRoot: 'om_work', kind: 'review_passed' as const, deliveryRound: 2, reviewRound: 2 };
    const fingerprint = projectStageAdvanceFingerprint(identity);
    expect(fingerprint).toMatch(/^psa1:[a-f0-9]{64}$/);
    expect(projectStageAdvanceFingerprint({ ...identity })).toBe(fingerprint);
    expect(projectStageAdvanceFingerprint({ ...identity, reviewRound: 3 })).not.toBe(fingerprint);
    expect(projectStageAdvanceFingerprint({ ...identity, kind: 'review_failed' })).not.toBe(fingerprint);
  });

  it('migrates absent events and strictly rejects an identity mismatch', () => {
    expect(normalizeProjectStageAdvanceEvents(undefined)).toEqual([]);
    expect(normalizeProjectStageAdvanceEvents([event()])).toHaveLength(1);
    expect(() => normalizeProjectStageAdvanceEvents([{ ...event(), fingerprint: 'psa1:bad' }])).toThrow();
  });

  it('reads a schema-v3 project without an event field as an empty outbox', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-stage-migrate-'));
    roots.push(dataDir);
    const value = project();
    delete (value as any).stageAdvanceEvents;
    writeFileSync(join(dataDir, 'project-groups.json'), JSON.stringify({ schemaVersion: 3, projects: { [value.chatId]: value } }));
    expect(readProjectGroup(dataDir, value.chatId)?.stageAdvanceEvents).toEqual([]);
  });

  it.each([
    ['delivery_ready', 'pending', 'in_review', { delivery: { reportedByAppId: 'cli_worker', content: '完成', reportedAt: '2026-10-03T00:00:00.000Z', round: 1 } }],
    ['review_passed', 'in_review', 'completed', { delivery: { reportedByAppId: 'cli_worker', content: '完成', reportedAt: '2026-10-03T00:00:00.000Z', round: 1 }, review: { reviewerAppId: 'cli_reviewer', verdict: 'pass', content: '通过', reviewedAt: '2026-10-03T00:00:00.000Z', round: 1 } }],
    ['review_failed', 'in_review', 'blocked', { delivery: { reportedByAppId: 'cli_worker', content: '完成', reportedAt: '2026-10-03T00:00:00.000Z', round: 1 }, review: { reviewerAppId: 'cli_reviewer', verdict: 'fail', content: '失败', reviewedAt: '2026-10-03T00:00:00.000Z', round: 1 } }],
    ['workstream_failed', 'in_progress', 'failed', {}],
    ['workstream_completed', 'pending', 'completed', {}],
  ] as const)('derives %s only at a status boundary', (kind, beforeStatus, afterStatus, fields) => {
    const p = project();
    const before = { dispatchRoot: 'om_work', title: '任务', purpose: '验证', owners: [],
      ...(kind === 'workstream_completed' ? {} : { access: { mode: 'write', scopes: [] } }),
      status: beforeStatus, progress: 0, createdAt: p.createdAt, updatedAt: p.updatedAt } as any;
    const after = { ...before, ...fields, status: afterStatus, progress: afterStatus === 'completed' ? 100 : 0 } as any;
    const derived = deriveProjectStageAdvanceEvent({ project: p, before, after, nextProjectRevision: 9, now: p.updatedAt });
    expect(derived).toMatchObject({ kind, dispatchRoot: 'om_work', status: 'pending', projectRevision: 9 });
    expect(deriveProjectStageAdvanceEvent({ project: p, before: after, after, nextProjectRevision: 9, now: p.updatedAt })).toBeUndefined();
  });

  it('builds a trusted request bound to the stored coordinator session and event key', () => {
    const request = buildProjectStageAdvanceTriggerRequest(project(), event());
    expect(request.target).toEqual({ kind: 'turn', sessionId: 'session_main' });
    expect(request.options).toMatchObject({ asyncReturnSessionId: true, suppressFinalOutput: true, turnIdempotencyKey: event().fingerprint });
    expect(request.source).toMatchObject({ type: 'ui', connectorId: 'project-stage-auto-advance' });
    expect(request.instruction).toContain(event().fingerprint);
    expect(request.instruction).toContain('human-action ledger');
    expect(request.instruction).toContain('禁止');
    expect(request.envelope.trusted).toBe(false);
    expect(JSON.stringify(request.envelope)).not.toMatch(/authorization|secret|token|open_id/i);
  });

  it('states the complete coordinator contract for human actions and durable project convergence', () => {
    const request = buildProjectStageAdvanceTriggerRequest(project(), event());
    expect(request.instruction).toContain('human-action fingerprint 必须由当前 psa1 event fingerprint 与稳定动作摘要派生');
    expect(request.instruction).toContain('waiting_human');
    expect(request.instruction).toContain('in_progress');
    expect(request.instruction).toContain('closed');
    expect(request.instruction).toContain('不得重复询问或重复投递');
    expect(request.instruction).toContain('收敛 durable project 的 phase、focus、remaining、blocker');
    expect(request.instruction).toContain('没有用户可见信息时保持静默');
    expect(request.instruction).toContain('commit');
    expect(request.instruction).toContain('迁移');
    expect(request.instruction).toContain('外部协调');
    expect(request.instruction).toContain('旧快照或旧授权');
    expect(request.instruction).toContain('只有确实需要新 human action 时');
  });

  it('freezes the target session at claim time and preserves it through reclaim and settle CAS', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-stage-target-'));
    roots.push(dataDir);
    const oldContext: ProjectCoordinatorContext = {
      dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_old',
    };
    const coordinator = new ProjectCoordinator(transport());
    await coordinator.run(oldContext, { action: 'init', title: '阶段推进', goal: '冻结 target' });
    await mutateProjectGroup(dataDir, oldContext.chatId, current => {
      current!.stageAdvanceEvents = [event()];
      return current;
    });

    const first = await coordinator.claimStageAdvance(oldContext, { now: '2026-10-03T00:03:00.000Z', leaseMs: 1_000 });
    expect(first?.event.targetSessionId).toBe('session_old');
    await mutateProjectGroup(dataDir, oldContext.chatId, current => {
      current!.coordinatorSessionId = 'session_new';
      current!.revision += 1;
      current!.stageAdvanceEvents![0]!.claimExpiresAt = '2026-10-03T00:03:01.000Z';
      return current;
    });

    const reclaimed = await coordinator.claimStageAdvance({ ...oldContext, coordinatorSessionId: 'session_new' }, {
      now: '2026-10-03T00:03:02.000Z', leaseMs: 1_000,
    });
    expect(reclaimed?.event.targetSessionId).toBe('session_old');
    await expect(coordinator.settleStageAdvance({ ...oldContext, coordinatorSessionId: 'session_new' }, {
      fingerprint: event().fingerprint, claimId: reclaimed!.claimId, targetSessionId: 'session_new',
      outcome: 'dispatched', triggerId: 'trigger_wrong', now: '2026-10-03T00:03:03.000Z',
    })).rejects.toThrow('claim_conflict');
    expect(readProjectGroup(dataDir, oldContext.chatId)?.stageAdvanceEvents?.[0]?.status).toBe('dispatching');
    await coordinator.settleStageAdvance({ ...oldContext, coordinatorSessionId: 'session_new' }, {
      fingerprint: event().fingerprint, claimId: reclaimed!.claimId, targetSessionId: 'session_old',
      outcome: 'dispatched', triggerId: 'trigger_old', now: '2026-10-03T00:03:04.000Z',
    });
    expect(readProjectGroup(dataDir, oldContext.chatId)?.stageAdvanceEvents?.[0]).toMatchObject({
      status: 'dispatched', targetSessionId: 'session_old', triggerId: 'trigger_old', attemptCount: 2,
    });
  });

  it('allows one cross-instance claim, then settles a dispatch and preserves idempotent identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-stage-'));
    roots.push(dataDir);
    const context: ProjectCoordinatorContext = { dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_main' };
    const first = new ProjectCoordinator(transport());
    const second = new ProjectCoordinator(transport());
    await first.run(context, { action: 'init', title: '阶段推进', goal: '验证' });
    await mutateProjectGroup(dataDir, context.chatId, current => {
      current!.stageAdvanceEvents = [event()];
      return current;
    });
    const claimed = await first.claimStageAdvance(context, { now: '2026-10-03T00:01:00.000Z' });
    expect(claimed?.claimId).toMatch(/^psac:/);
    await expect(second.claimStageAdvance(context, { now: '2026-10-03T00:01:01.000Z' })).resolves.toBeUndefined();
    const settled = await first.settleStageAdvance(context, {
      fingerprint: event().fingerprint, claimId: claimed!.claimId, outcome: 'dispatched',
      targetSessionId: 'session_main', triggerId: 'trigger_1', now: '2026-10-03T00:01:02.000Z',
    });
    expect(readProjectGroup(dataDir, context.chatId)?.stageAdvanceEvents).toEqual([
      expect.objectContaining({ status: 'dispatched', targetSessionId: 'session_main', triggerId: 'trigger_1' }),
    ]);
    expect(settled.revision).toBeGreaterThan(1);
  });

  it('appends one durable event inside each real report boundary and deduplicates replay', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-stage-report-'));
    roots.push(dataDir);
    const context: ProjectCoordinatorContext = { dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_main' };
    const coordinator = new ProjectCoordinator(transport());
    await coordinator.run(context, { action: 'init', title: '阶段推进', goal: '验证 report' });
    await mutateProjectGroup(dataDir, context.chatId, current => {
      current!.workstreams.push({
        dispatchRoot: 'om_write', title: '写任务', purpose: '验证', owners: ['cli_worker'],
        workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'],
        access: { mode: 'write', scopes: [dataDir] }, status: 'pending', progress: 0,
        createdAt: current!.createdAt, updatedAt: current!.updatedAt,
      });
      return current;
    });
    const delivery = await coordinator.runReport(context, {
      action: 'report', dispatchRoot: 'om_write', reporterAppId: 'cli_worker', content: '完成', status: 'completed',
    });
    expect(delivery.project.stageAdvanceEvents).toEqual([expect.objectContaining({ kind: 'delivery_ready', deliveryRound: 1 })]);
    const replay = await coordinator.runReport(context, {
      action: 'report', dispatchRoot: 'om_write', reporterAppId: 'cli_worker', content: '完成', status: 'completed',
    });
    expect(replay.project.revision).toBe(delivery.project.revision);
    const review = await coordinator.runReport(context, {
      action: 'report', dispatchRoot: 'om_write', reporterAppId: 'cli_reviewer', content: '通过', reviewVerdict: 'pass', reviewRound: 1,
    });
    expect(review.project.stageAdvanceEvents).toHaveLength(2);
    expect(review.project.stageAdvanceEvents?.map(item => item.kind)).toEqual(['delivery_ready', 'review_passed']);
  });

  it('returns explicit pre-dispatch failures to pending, then blocks on the third attempt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-stage-retry-'));
    roots.push(dataDir);
    const context: ProjectCoordinatorContext = { dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_main' };
    const coordinator = new ProjectCoordinator(transport());
    await coordinator.run(context, { action: 'init', title: '阶段推进', goal: '重试' });
    await mutateProjectGroup(dataDir, context.chatId, current => { current!.stageAdvanceEvents = [event()]; return current; });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = await coordinator.claimStageAdvance(context, { now: `2026-10-03T00:0${attempt}:00.000Z` });
      await coordinator.settleStageAdvance(context, {
        fingerprint: event().fingerprint, claimId: claim!.claimId, outcome: 'retryable_failure',
        targetSessionId: claim!.event.targetSessionId!, errorCode: 'pre_dispatch_failed',
        now: `2026-10-03T00:0${attempt}:01.000Z`,
      });
    }
    expect(readProjectGroup(dataDir, context.chatId)).toMatchObject({
      stageAdvanceEvents: [expect.objectContaining({ status: 'blocked', attemptCount: 3, lastErrorCode: 'pre_dispatch_failed' })],
      blockerRecords: [expect.objectContaining({ source: 'task_control', code: 'pre_dispatch_failed' })],
    });
  });

  it('reclaims an expired ambiguous third claim without persisting a fourth attempt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-stage-limit-'));
    roots.push(dataDir);
    const context: ProjectCoordinatorContext = { dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_main' };
    const coordinator = new ProjectCoordinator(transport());
    await coordinator.run(context, { action: 'init', title: '阶段推进', goal: '上限' });
    await mutateProjectGroup(dataDir, context.chatId, current => {
      current!.stageAdvanceEvents = [{
        ...event(), status: 'dispatching', attemptCount: 3, claimId: 'psac:third',
        claimExpiresAt: '2026-10-03T00:00:03.000Z', updatedAt: '2026-10-03T00:00:02.000Z',
      }];
      return current;
    });

    const reclaimed = await coordinator.claimStageAdvance(context, { now: '2026-10-03T00:00:04.000Z' });
    expect(reclaimed).toMatchObject({
      event: { status: 'dispatching', attemptCount: 3, targetSessionId: 'session_main' },
    });
    await coordinator.settleStageAdvance(context, {
      fingerprint: event().fingerprint, claimId: reclaimed!.claimId, targetSessionId: 'session_main',
      outcome: 'dispatched', triggerId: 'trigger_recovered', now: '2026-10-03T00:00:05.000Z',
    });
    expect(readProjectGroup(dataDir, context.chatId)).toMatchObject({
      stageAdvanceEvents: [expect.objectContaining({
        status: 'dispatched', attemptCount: 3, triggerId: 'trigger_recovered',
      })],
    });
  });

  it('blocks a schema-valid pending event already at the attempt limit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-stage-pending-limit-'));
    roots.push(dataDir);
    const context: ProjectCoordinatorContext = { dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_main' };
    const coordinator = new ProjectCoordinator(transport());
    await coordinator.run(context, { action: 'init', title: '阶段推进', goal: 'pending 上限' });
    await mutateProjectGroup(dataDir, context.chatId, current => {
      current!.stageAdvanceEvents = [{ ...event(), attemptCount: 3 }];
      return current;
    });

    await expect(coordinator.claimStageAdvance(context, { now: '2026-10-03T00:02:00.000Z' })).resolves.toBeUndefined();
    const persisted = readProjectGroup(dataDir, context.chatId)!;
    expect(persisted.stageAdvanceEvents).toEqual([
      expect.objectContaining({ status: 'blocked', attemptCount: 3, lastErrorCode: 'stage_auto_advance_attempt_limit' }),
    ]);
    expect(persisted.blockerRecords).toEqual([
      expect.objectContaining({ code: 'stage_auto_advance_attempt_limit' }),
    ]);
  });
});
