import { describe, expect, it } from 'vitest';
import { buildProjectGroupCard } from '../src/im/lark/project-group-card.js';
import type { ProjectGroupState } from '../src/services/project-group-store.js';

function makeProject(overrides: Partial<ProjectGroupState> = {}): ProjectGroupState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    chatId: 'oc_test',
    larkAppId: 'cli_test',
    coordinatorSessionId: 'sess-1',
    title: '测试项目',
    goal: '目标',
    phase: '进行中',
    focus: '当前焦点',
    status: 'in_progress',
    blockers: [],
    workstreams: [{
      dispatchRoot: 'om_root',
      title: '子任务一',
      purpose: '需要换行的较长子任务说明'.repeat(10),
      owners: [],
      status: 'in_progress',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    }],
    milestones: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('buildProjectGroupCard workstream table', () => {
  it('auto-sizes rows with the shared cap while keeping its own blue header style', () => {
    const card = buildProjectGroupCard(makeProject()) as any;
    const table = card.body.elements.find((e: any) => e.tag === 'table');
    expect(table).toBeTruthy();

    // 行高封顶复用共享片段（回归：该表原本只有 row_height:'auto'，
    // 仍吃组件默认 124px 上限，长 purpose 会被裁）。
    expect(table.row_height).toBe('auto');
    expect(table.row_max_height).toBe('300px');

    // 蓝底表头是该卡自有样式，不能被共享灰底表头片段（含 lines:2）覆盖。
    expect(table.header_style).toMatchObject({
      text_align: 'left',
      background_style: 'blue-50',
      text_color: 'blue',
      bold: true,
    });
    expect(table.header_style).not.toHaveProperty('lines');
  });

  it('omits the table when there are no workstreams', () => {
    const card = buildProjectGroupCard(makeProject({ workstreams: [] })) as any;
    expect(card.body.elements.some((e: any) => e.tag === 'table')).toBe(false);
  });

  it('shows in-review workstreams as pending acceptance with reviewer and latest review', () => {
    const base = makeProject();
    const workstream = {
      ...base.workstreams[0]!,
      status: 'in_review' as const,
      reviewerAppIds: ['cli_reviewer'],
      delivery: {
        reportedByAppId: 'cli_worker', content: '第二轮交付', reportedAt: base.updatedAt, round: 2,
      },
      review: {
        reviewerAppId: 'cli_reviewer', verdict: 'fail' as const, content: '补充边界测试',
        reviewedAt: base.updatedAt, round: 1,
      },
    };
    const card = buildProjectGroupCard(makeProject({ workstreams: [workstream] })) as any;
    const serialized = JSON.stringify(card);
    const table = card.body.elements.find((element: { tag?: string }) => element.tag === 'table');
    expect(serialized).toContain('待验收');
    expect(table.rows[0].wf).toContain('Reviewer');
    expect(table.rows[0].wf).toContain('cli\\_reviewer');
    expect(serialized).toContain('交付轮次 · 2');
    expect(serialized).toContain('补充边界测试');
    expect(serialized).toContain('进行中');
  });
});
