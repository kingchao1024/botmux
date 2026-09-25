import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCoordinator, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';
import { readProjectGroup } from '../src/services/project-group-store.js';
import {
  readGroupCollaborationMode,
  writeGroupCollaborationMode,
} from '../src/services/group-collaboration-mode-store.js';
import { parseProjectArgs } from '../src/cli/project-args.js';

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
    brand: () => 'feishu',
  };
  return {
    dataDir, cards, transport,
    coordinator: new ProjectCoordinator(transport),
    context: { dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_main' },
  };
}

describe('project group mode', () => {
  async function committedWriteWorkstream(f: ReturnType<typeof fixture>) {
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
      schemaVersion: 2, title: '旧项目',
      workstreams: [{ dispatchRoot: 'om_legacy' }],
    });
    await f.coordinator.run(f.context, { action: 'update', focus: '迁移后继续' });
    expect(JSON.parse(readFileSync(join(f.dataDir, 'project-groups.json'), 'utf8'))).toMatchObject({
      schemaVersion: 2, projects: { [f.context.chatId]: { schemaVersion: 2 } },
    });
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
    expect(f.cards.at(-1)).toContain('引导卡切换验收');
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
    expect(project.blockers).toEqual(['等待同一外部依赖']);

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
});
