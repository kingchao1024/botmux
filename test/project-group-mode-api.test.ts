import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectGroupMode, putProjectGroupMode } from '../src/dashboard/project-group-mode-api.js';
import {
  addProjectWorkerIfNeeded,
  evaluateProjectDispatchPolicy,
  evaluateProjectTaskControlEvidencePolicy,
  readGroupCollaborationMode,
  writeGroupCollaborationMode,
  writeProjectOnboardingCard,
} from '../src/services/group-collaboration-mode-store.js';
import { renderProjectGroupModeBlock } from '../src/core/session-manager.js';
import { parseProjectCoordinatorAction } from '../src/services/project-coordinator.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-project-mode-'));
  roots.push(dataDir);
  const groups = vi.fn(async () => ({
    chats: [{
      chatId: 'oc_project',
      chatMode: 'group',
      memberBots: [
        { larkAppId: 'cli_coordinator', botName: 'nodex', inChat: true },
        { larkAppId: 'cli_worker', botName: 'Seed Bot', inChat: true },
        { larkAppId: 'cli_reviewer', botName: 'Reviewer Bot', inChat: true },
        { larkAppId: 'cli_acceptor', botName: 'Acceptor Bot', inChat: true },
        { larkAppId: 'cli_elsewhere', inChat: false },
      ],
    }],
  }));
  return { dataDir, groups };
}

describe('project group mode dashboard API', () => {
  it('fails closed when the public API attempts an audit-only enable without the internal CAS', async () => {
    const f = fixture();
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator',
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_acceptor'],
      taskControlPlane: { mode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1 },
    }, f)).toMatchObject({
      status: 409,
      body: { ok: false, error: 'project_task_control_config_cas_required' },
    });
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')).toBeUndefined();
  });

  it('creates the waiting-to-start guide for a configured group without project content', async () => {
    const f = fixture();
    const ensureOnboardingCard = vi.fn(async (chatId: string, coordinatorAppId: string) => {
      await writeProjectOnboardingCard(f.dataDir, chatId, {
        messageId: 'om_guide', larkAppId: coordinatorAppId, pinned: true,
        createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
      });
    });
    const result = await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'], autoEnrollWorkers: true,
    }, { ...f, ensureOnboardingCard });
    expect(result.status).toBe(200);
    expect(result.body.cardRefresh).toBe('updated');
    expect(ensureOnboardingCard).toHaveBeenCalledWith('oc_project', 'cli_coordinator', {
      coordinatorName: 'nodex', workerNames: ['Seed Bot'],
    });
    expect(result.body.config).not.toHaveProperty('onboardingCard');
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')?.onboardingCard?.messageId).toBe('om_guide');
  });

  it('stores only group nature and bot policy, never project content', async () => {
    const f = fixture();
    const result = await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'], autoEnrollWorkers: true,
      progressCard: {
        schemaVersion: 1, templateId: 'compact-list', sections: ['goal', 'workstreams'], milestonesExpanded: false,
      },
    }, f);
    expect(result.status).toBe(200);
    expect(result.body.config).toMatchObject({
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
      autoEnrollWorkers: true,
      progressCard: { templateId: 'compact-list', sections: ['goal', 'workstreams'] },
    });
    const raw = readFileSync(join(f.dataDir, 'group-collaboration-modes.json'), 'utf8');
    const stored = JSON.parse(raw).configs.oc_project;
    expect(stored).not.toHaveProperty('goal');
    expect(stored).not.toHaveProperty('progress');
    expect(stored.progressCard).toEqual({
      schemaVersion: 1, templateId: 'compact-list', sections: ['goal', 'workstreams'], milestonesExpanded: false,
    });
    expect(statSync(join(f.dataDir, 'group-collaboration-modes.json')).mode & 0o777).toBe(0o600);
  });

  it('validates an exact audit-only policy but requires the internal fenced CAS to persist it', async () => {
    const f = fixture();
    const result = await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator',
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_acceptor'],
      taskControlPlane: { mode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1 },
    }, f);
    expect(result).toMatchObject({
      status: 409, body: { ok: false, error: 'project_task_control_config_cas_required' },
    });
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')).toBeUndefined();

    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker', 'cli_reviewer'],
      taskControlPlane: { mode: 'audit_only', acceptorAppId: 'cli_missing', maxActiveMappings: 1 },
    }, f)).toMatchObject({ status: 409, body: { error: 'task_control_acceptor_not_in_workers' } });
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker', 'cli_reviewer'],
      taskControlPlane: { mode: 'audit_only', acceptorAppId: 'cli_worker', maxActiveMappings: 2 },
    }, f)).toMatchObject({ status: 400, body: { error: 'invalid_task_control_plane_config' } });
  });

  it('fails closed when a directly edited TaskControl policy contains unknown fields', () => {
    const f = fixture();
    writeFileSync(join(f.dataDir, 'group-collaboration-modes.json'), JSON.stringify({
      schemaVersion: 1,
      configs: {
        oc_project: {
          schemaVersion: 1, chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator',
          workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_acceptor'],
          taskControlPlane: {
            mode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1, writeback: true,
          },
          createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
        },
      },
    }));
    expect(() => readGroupCollaborationMode(f.dataDir, 'oc_project'))
      .toThrow('group-collaboration-modes.json has invalid taskControlPlane config');

    writeFileSync(join(f.dataDir, 'group-collaboration-modes.json'), JSON.stringify({
      schemaVersion: 1,
      configs: {
        oc_project: {
          schemaVersion: 1, chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator',
          workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_acceptor'],
          taskControlPlane: { mode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1 },
          createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
          unexpectedTopLevel: true,
        },
      },
    }));
    expect(() => readGroupCollaborationMode(f.dataDir, 'oc_project'))
      .toThrow('group-collaboration-modes.json has invalid taskControlPlane config');
  });

  it.each([
    { coordinatorAppId: 'cli_coordinator', acceptorAppId: 'cli_ghost' },
    { coordinatorAppId: 'cli_acceptor', acceptorAppId: 'cli_acceptor' },
  ])('fails closed for an invalid directly edited acceptor relation: %o', relation => {
    const f = fixture();
    const config = {
      schemaVersion: 1 as const, chatId: 'oc_project', mode: 'project' as const,
      coordinatorAppId: relation.coordinatorAppId,
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_acceptor'],
      taskControlPlane: { mode: 'audit_only' as const, acceptorAppId: relation.acceptorAppId, maxActiveMappings: 1 as const },
      createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
    };
    writeFileSync(join(f.dataDir, 'group-collaboration-modes.json'), JSON.stringify({
      schemaVersion: 1, configs: { oc_project: config },
    }));
    expect(() => readGroupCollaborationMode(f.dataDir, 'oc_project'))
      .toThrow('group-collaboration-modes.json has invalid taskControlPlane config');
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: relation.coordinatorAppId, sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker', 'cli_reviewer'], hasLegacyBots: false, title: '任务',
      writeScopes: ['/repo/src'], taskControlMode: 'audit_only',
    })).toEqual({ ok: false, error: 'project_task_control_not_configured' });
  });

  it('rejects project content fields and bots outside the group', async () => {
    const f = fixture();
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'], goal: 'not config',
    }, f)).toMatchObject({ status: 400, body: { error: 'unsupported_field' } });
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_elsewhere'],
    }, f)).toMatchObject({ status: 409, body: { error: 'worker_not_in_chat' } });
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
      progressCard: { schemaVersion: 1, templateId: 'raw-json', sections: [], milestonesExpanded: false },
    }, f)).toMatchObject({ status: 400, body: { error: 'invalid_progress_card_config' } });
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'], autoEnrollWorkers: 'yes',
    }, f)).toMatchObject({ status: 400, body: { error: 'invalid_auto_enroll_workers' } });
  });

  it('refreshes an existing pinned card immediately after display configuration changes', async () => {
    const f = fixture();
    const project = {
      schemaVersion: 1, revision: 2, chatId: 'oc_project', larkAppId: 'cli_coordinator',
      coordinatorSessionId: 'session_main', title: '项目', goal: '完成交付', phase: '联调', focus: '刷新卡片',
      status: 'active' as const, blockers: [], workstreams: [], milestones: [],
      card: { messageId: 'om_card', pinned: true, updatedAt: '2026-09-07T00:00:00.000Z' },
      createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
    };
    const refreshProjectCard = vi.fn(async () => project);
    const result = await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
      progressCard: {
        schemaVersion: 1, templateId: 'status-dashboard', sections: ['goal', 'milestones'], milestonesExpanded: true,
      },
    }, {
      ...f,
      readProject: () => project,
      refreshProjectCard,
    });
    expect(result.status).toBe(200);
    expect(result.body.cardRefresh).toBe('updated');
    expect(refreshProjectCard).toHaveBeenCalledWith('oc_project', 'cli_coordinator');
  });

  it('persists an explicit standard mode so disabling cannot look unconfigured', async () => {
    const f = fixture();
    await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
      progressCard: {
        schemaVersion: 1, templateId: 'compact-list', sections: ['workstreams'], milestonesExpanded: false,
      },
    }, f);
    const result = await putProjectGroupMode('oc_project', { mode: 'standard' }, f);
    expect(result.body.config).toMatchObject({ mode: 'standard' });
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')).toMatchObject({
      mode: 'standard', progressCard: { templateId: 'compact-list', sections: ['workstreams'] },
    });
    expect((await getProjectGroupMode('oc_project', f)).body.config).toMatchObject({ mode: 'standard' });
    const restored = await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
    }, f);
    expect(restored.body.config).toMatchObject({
      mode: 'project', progressCard: { templateId: 'compact-list', sections: ['workstreams'] },
    });
  });

  it('unpins the waiting guide before switching back to standard mode', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
    });
    await writeProjectOnboardingCard(f.dataDir, 'oc_project', {
      messageId: 'om_guide', larkAppId: 'cli_coordinator', pinned: true,
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
    });
    const clearOnboardingCard = vi.fn(async (chatId: string) => {
      await writeProjectOnboardingCard(f.dataDir, chatId, undefined);
    });
    const result = await putProjectGroupMode('oc_project', { mode: 'standard' }, {
      ...f, clearOnboardingCard,
    });
    expect(result.status).toBe(200);
    expect(clearOnboardingCard).toHaveBeenCalledWith('oc_project', 'cli_coordinator');
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')).not.toHaveProperty('onboardingCard');
  });
});

describe('project dispatch policy', () => {
  const config = {
    schemaVersion: 1 as const,
    chatId: 'oc_project',
    mode: 'project' as const,
    coordinatorAppId: 'cli_coordinator',
    workerAppIds: ['cli_worker'],
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
  };

  it('requires an explicit configured audit-only intent without widening legacy dispatch', () => {
    const auditConfig = {
      ...config,
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_acceptor'],
      taskControlPlane: { mode: 'audit_only' as const, acceptorAppId: 'cli_acceptor', maxActiveMappings: 1 as const },
    };
    const base = {
      config: auditConfig, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker', 'cli_reviewer'], hasLegacyBots: false, title: '任务', writeScopes: ['/repo/src'],
      assignedAppIds: ['cli_worker', 'cli_reviewer'],
    };
    expect(evaluateProjectDispatchPolicy({ ...base, taskControlMode: 'audit_only' })).toEqual({
      ok: true, projectMode: true, taskControlMode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1,
    });
    expect(evaluateProjectDispatchPolicy({
      ...base, config: { ...config, workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_acceptor'] },
      taskControlMode: 'audit_only',
    })).toEqual({
      ok: false, error: 'project_task_control_not_configured',
    });
    expect(evaluateProjectDispatchPolicy({ ...base, taskControlMode: undefined })).toEqual({ ok: true, projectMode: true });
  });

  it('accepts project evidence only for the exact chat and configured role partition', () => {
    const configWithTaskControl = {
      ...config,
      workerAppIds: ['cli_worker', 'cli_reviewer', 'cli_acceptor'],
      taskControlPlane: { mode: 'audit_only' as const, acceptorAppId: 'cli_acceptor', maxActiveMappings: 1 as const },
    };
    const taskControl = {
      mode: 'audit_only' as const, controllerAppId: 'cli_coordinator', workerAppId: 'cli_worker',
      reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor',
    };
    expect(evaluateProjectTaskControlEvidencePolicy({
      config: configWithTaskControl, chatId: 'oc_project', sourceAppId: 'cli_worker',
      eventKind: 'accepted', taskControl,
    })).toEqual({ ok: true, controllerAppId: 'cli_coordinator' });
    expect(evaluateProjectTaskControlEvidencePolicy({
      config: configWithTaskControl, chatId: 'oc_project', sourceAppId: 'cli_worker',
      eventKind: 'failed_report', taskControl,
    })).toEqual({ ok: true, controllerAppId: 'cli_coordinator' });
    expect(evaluateProjectTaskControlEvidencePolicy({
      config: configWithTaskControl, chatId: 'oc_project', sourceAppId: 'cli_reviewer',
      eventKind: 'failed_report', taskControl,
    })).toMatchObject({ ok: false, error: 'project_task_control_evidence_identity_mismatch' });
    expect(evaluateProjectTaskControlEvidencePolicy({
      config: configWithTaskControl, chatId: 'oc_other', sourceAppId: 'cli_worker',
      eventKind: 'accepted', taskControl,
    })).toMatchObject({ ok: false });
    expect(evaluateProjectTaskControlEvidencePolicy({
      config: configWithTaskControl, chatId: 'oc_project', sourceAppId: 'cli_worker',
      eventKind: 'reviewed', taskControl,
    })).toMatchObject({ ok: false });
    expect(evaluateProjectTaskControlEvidencePolicy({
      config: { ...configWithTaskControl, taskControlPlane: undefined }, chatId: 'oc_project',
      sourceAppId: 'cli_worker', eventKind: 'accepted', taskControl,
    })).toMatchObject({ ok: false });
    expect(evaluateProjectTaskControlEvidencePolicy({
      config: configWithTaskControl, chatId: 'oc_project', sourceAppId: 'cli_worker',
      eventKind: 'accepted', taskControl: { ...taskControl, acceptorAppId: 'cli_other' },
    })).toMatchObject({ ok: false });
  });

  it('allows only the configured coordinator and worker set', () => {
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '移动端验收', existingDispatch: false, readOnly: true,
    })).toEqual({ ok: true, projectMode: true });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_other', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '移动端验收', existingDispatch: false, readOnly: true,
    })).toEqual({ ok: false, error: 'project_coordinator_required' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_other'], hasLegacyBots: false, title: '移动端验收', existingDispatch: false, readOnly: true,
    })).toEqual({ ok: false, error: 'project_worker_not_allowed', disallowedAppIds: ['cli_other'] });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_elsewhere',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '移动端验收', existingDispatch: false, readOnly: true,
    })).toEqual({ ok: false, error: 'project_cross_chat_dispatch_forbidden' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: [], hasLegacyBots: true, title: '移动端验收', existingDispatch: false, readOnly: true,
    })).toEqual({ ok: false, error: 'project_dispatch_requires_app_ids' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '子任务', existingDispatch: false, readOnly: true,
    })).toEqual({ ok: false, error: 'project_dispatch_title_required' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '这是一个明显超过二十四个字符并且不适合展示在项目卡片里的标题', existingDispatch: false, readOnly: true,
    })).toEqual({ ok: false, error: 'project_dispatch_title_too_long' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '', existingDispatch: true,
    })).toEqual({ ok: true, projectMode: true });
  });

  it('keeps legacy dispatch unrestricted until a group mode is explicitly configured', () => {
    expect(evaluateProjectDispatchPolicy({
      config: undefined, sourceAppId: 'cli_any', sourceChatId: 'oc_project', targetChatId: 'oc_elsewhere',
      targetAppIds: [], hasLegacyBots: true,
    })).toEqual({ ok: true, projectMode: false });
    expect(evaluateProjectDispatchPolicy({
      config: undefined, sourceAppId: 'cli_any', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_any'], hasLegacyBots: false, title: '错误审计', existingDispatch: false,
      writeScopes: ['/repo/src'], taskControlMode: 'audit_only',
    })).toEqual({ ok: false, error: 'project_task_control_not_configured' });
  });

  it('requires exactly one access mode for new project workstreams and forbids access on --into', () => {
    const base = {
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '移动端验收', existingDispatch: false,
    };
    expect(evaluateProjectDispatchPolicy(base)).toEqual({
      ok: false, error: 'project_dispatch_access_required',
    });
    expect(evaluateProjectDispatchPolicy({ ...base, readOnly: true })).toEqual({ ok: true, projectMode: true });
    expect(evaluateProjectDispatchPolicy({ ...base, writeScopes: ['/repo/src'] })).toEqual({ ok: true, projectMode: true });
    expect(evaluateProjectDispatchPolicy({ ...base, readOnly: true, writeScopes: ['/repo/src'] })).toEqual({
      ok: false, error: 'project_dispatch_access_ambiguous',
    });
    expect(evaluateProjectDispatchPolicy({
      ...base, existingDispatch: true, title: '', readOnly: true,
    })).toEqual({ ok: false, error: 'project_existing_dispatch_access_forbidden' });
    expect(evaluateProjectDispatchPolicy({ ...base, existingDispatch: true, title: '' })).toEqual({
      ok: true, projectMode: true,
    });
    expect(evaluateProjectDispatchPolicy({
      ...base, existingDispatch: true, title: '', targetAppIds: ['cli_other'],
      assignedAppIds: ['cli_worker', 'cli_reviewer'],
    })).toEqual({
      ok: false, error: 'project_workstream_bot_not_allowed', disallowedAppIds: ['cli_other'],
    });
  });

  it('wires access fields through the dashboard project policy route', () => {
    const source = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
    const start = source.indexOf("ipcRoute('POST', '/api/sessions/:sessionId/project-dispatch-policy'");
    const end = source.indexOf('\n});', start) + 4;
    const route = source.slice(start, end);

    expect(route).toContain('body?.readOnly === true');
    expect(route).toContain('body?.writeScopes');
    expect(route).toContain('readOnly,');
    expect(route).toContain('writeScopes,');
    expect(route).toContain('dispatchRoot');
  });

  it('uses the durable report path and returns projection warnings without failing the request', () => {
    const source = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
    const start = source.indexOf("ipcRoute('POST', '/api/sessions/:sessionId/project'");
    const end = source.indexOf('\n});', start) + 4;
    const route = source.slice(start, end);
    expect(route).toContain('projectCoordinator.runReport');
    expect(route).toContain('projectionWarning');
    expect(route).toContain('logger.warn');
  });

  it('rejects malformed trusted review fields instead of downgrading them to a worker report', () => {
    expect(parseProjectCoordinatorAction({
      action: 'report', dispatchRoot: 'om_work', content: '伪造验收',
      reporterAppId: 'cli_worker', reviewVerdict: 'approve', reviewRound: 1,
    })).toBeUndefined();
    expect(parseProjectCoordinatorAction({
      action: 'report', dispatchRoot: 'om_work', content: '孤立轮次', reporterAppId: 'cli_worker', reviewRound: 1,
    })).toBeUndefined();
  });

  it('keeps completion-gate evaluation internal to the daemon', () => {
    const base = {
      action: 'sync_completion_gate', gateId: 'child', definitionFingerprint: 'pcg1:fingerprint',
      reason: 'verified', checkedAt: '2026-09-29T12:00:00.000Z',
    };
    expect(parseProjectCoordinatorAction({ ...base, status: 'satisfied' })).toBeUndefined();
    expect(parseProjectCoordinatorAction({
      ...base, status: 'pending', evidence: {
        sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    })).toBeUndefined();
    expect(parseProjectCoordinatorAction({
      ...base, status: 'satisfied', evidence: {
        sourceProjectRevision: 7, reviewerVerdictId: 'rv_1',
        terminalEventId: 'evt-delivered', deliveryReceiptId: 'rcpt-1',
      },
    })).toBeUndefined();
  });

  it('accepts public completion-gate lifecycle actions with explicit compare-and-swap identity', () => {
    expect(parseProjectCoordinatorAction({
      action: 'retire_completion_gate', gateId: 'child',
      expectedDefinitionFingerprint: 'pcg1:old', authorizationRef: 'om_authorization',
      authorizedByOpenId: 'ou_forged', reason: '失败终态已归档',
    })).toEqual({
      action: 'retire_completion_gate', gateId: 'child',
      expectedDefinitionFingerprint: 'pcg1:old', authorizationRef: 'om_authorization', reason: '失败终态已归档',
    });
    expect(parseProjectCoordinatorAction({
      action: 'replace_completion_gate', gateId: 'child', expectedDefinitionFingerprint: 'pcg1:old',
      newGateId: 'child-v2', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
      taskGuid: '22222222-2222-4222-8222-222222222222', label: '子群验收 v2',
      authorizationRef: 'om_authorization', reason: '改用新一轮验收',
    })).toEqual({
      action: 'replace_completion_gate', gateId: 'child', expectedDefinitionFingerprint: 'pcg1:old',
      newGateId: 'child-v2', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
      taskGuid: '22222222-2222-4222-8222-222222222222', label: '子群验收 v2',
      authorizationRef: 'om_authorization', reason: '改用新一轮验收',
    });
    expect(parseProjectCoordinatorAction({
      action: 'retire_completion_gate', gateId: 'child', reason: '缺 fingerprint',
    })).toBeUndefined();
    expect(parseProjectCoordinatorAction({
      action: 'replace_completion_gate', gateId: 'child', expectedDefinitionFingerprint: 'pcg1:old',
      newGateId: 'child-v2', sourceChatId: 'oc_child', dispatchRoot: 'om_child_v2',
      taskGuid: '22222222-2222-4222-8222-222222222222', label: '子群验收 v2',
    })).toBeUndefined();
  });
});

describe('project worker membership sync', () => {
  it('preserves an explicitly curated worker subset when automatic enrollment is disabled', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator',
      workerAppIds: ['cli_worker'],
    });

    expect(await addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new')).toBeUndefined();
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')?.workerAppIds).toEqual(['cli_worker']);
  });

  it('atomically adds newly joined local bots when automatic enrollment is enabled', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator',
      workerAppIds: ['cli_worker'],
      autoEnrollWorkers: true,
      progressCard: {
        schemaVersion: 1, templateId: 'compact-list', sections: ['workstreams'], milestonesExpanded: false,
      },
    });

    await Promise.all([
      addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new_a'),
      addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new_b'),
    ]);

    const config = readGroupCollaborationMode(f.dataDir, 'oc_project');
    expect(config).toMatchObject({
      coordinatorAppId: 'cli_coordinator',
      progressCard: { templateId: 'compact-list', sections: ['workstreams'] },
    });
    expect(config?.workerAppIds).toHaveLength(3);
    expect(new Set(config?.workerAppIds)).toEqual(new Set(['cli_worker', 'cli_new_a', 'cli_new_b']));
    expect(await addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new_a')).toBeUndefined();
    expect(await addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_coordinator')).toBeUndefined();
  });

  it('does not enroll a bot when the group is not in project mode', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, { chatId: 'oc_project', mode: 'standard' });

    expect(await addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new')).toBeUndefined();
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')?.workerAppIds).toBeUndefined();
  });
});

describe('project coordinator prompt context', () => {
  it('injects the fixed project protocol only for the configured coordinator', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
    });
    const coordinator = renderProjectGroupModeBlock('cli_coordinator', 'oc_project', f.dataDir);
    expect(coordinator).toContain('<project_group_mode');
    expect(coordinator).toContain('botmux project init/update/status/close/resume');
    expect(coordinator).toContain('independent of custom &lt;role&gt; content');
    expect(coordinator).toContain('At the start of every substantive project turn');
    expect(coordinator).toContain('immediately persist it with `botmux project update`');
    expect(coordinator).toContain('discussion is a valid project phase');
    expect(coordinator).toContain('worker_app_ids="cli_worker"');
    expect(coordinator).toContain('specific title of at most 24 characters');
    expect(coordinator).toContain('Project state is chat-scoped');
    expect(coordinator).toContain('completion gate');
    expect(coordinator).toContain('gate add/status/retire/replace');
    expect(coordinator).toContain('exact current human turn');
    expect(coordinator).toContain('canonical action summary');
    expect(coordinator).toContain('session owner or pass `canOperate`');
    expect(coordinator).toContain('Ending the current turn does not complete the project');
    expect(renderProjectGroupModeBlock('cli_worker', 'oc_project', f.dataDir)).toBe('');
  });
});
