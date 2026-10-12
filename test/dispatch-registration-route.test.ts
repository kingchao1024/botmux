import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const route = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'DISPATCH_REPORT_REGISTER_ROUTE') as ts.ExpressionStatement;
const handler = (route.expression as ts.CallExpression).arguments[2];
const code = ts.transpileModule('const handler = ' + handler.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const deliveryRoute = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'DISPATCH_USER_DELIVERY_ROUTE') as ts.ExpressionStatement;
const deliveryHandler = (deliveryRoute.expression as ts.CallExpression).arguments[2];
const deliveryCode = ts.transpileModule('const handler = ' + deliveryHandler.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const evidenceRoute = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'PROJECT_WORKER_EVIDENCE_ROUTE') as ts.ExpressionStatement;
const evidenceHandler = (evidenceRoute.expression as ts.CallExpression).arguments[2];
const evidenceCode = ts.transpileModule('const handler = ' + evidenceHandler.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

type Failure = 'reserve' | 'seed' | 'seed_journal_complete' | 'registry' | 'commit' | 'refresh';

function harness(failure?: Failure, projectMode = true) {
  const steps: string[] = [];
  const body: any = {
    sessionId: 'session_source', seedText: '子项目：实现接口', targetChatId: 'oc_project',
    targetAppIds: ['cli_worker', 'cli_reviewer'], acceptanceRequested: true, hasLegacyBots: false,
    title: '实现接口', purpose: '完成接口实现', owners: ['展示名'],
    access: { mode: 'write', scopes: ['/repo/src'] },
    workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'],
  };
  if (!projectMode) body.access = null as never;
  const ds: any = {
    larkAppId: 'cli_coordinator', chatId: 'oc_project', chatType: 'group', scope: 'chat',
    session: { sessionId: 'session_source', chatId: 'oc_project', scope: 'chat' },
    workerGeneration: 3,
    managedTurnOrigin: { capability: 'capability-1', turnId: 'turn_1', dispatchAttempt: 1 },
  };
  const projectCoordinator = {
    run: vi.fn(async (_context: unknown, action: { action: string }) => {
      steps.push(action.action);
      if (action.action === failure + '_dispatch' || action.action === failure) {
        throw new Error(failure === 'reserve' ? 'project_write_scope_conflict' : `${failure}_failed`);
      }
      return {};
    }),
  };
  const sendMessage = vi.fn(async () => {
    steps.push('seed');
    if (failure === 'seed') throw new Error('seed_failed');
    return 'om_seed';
  });
  const beginTaskControlSeedOperationSync = vi.fn(() => {
    steps.push('seed_journal_begin');
    return { state: 'pending', providerUuid: 'seed-provider-uuid' };
  });
  const completeTaskControlSeedOperationSync = vi.fn(() => {
    steps.push('seed_journal_complete');
    if (failure === 'seed_journal_complete') throw new Error('seed_journal_complete_failed');
    return { state: 'delivered', dispatchRoot: 'om_seed' };
  });
  const providerAbortController = new AbortController();
  const runWithAbortDeadline = vi.fn(async (
    _label: string,
    _timeoutMs: number,
    task: (signal: AbortSignal, deadlineAt: number) => Promise<unknown>,
  ) => task(providerAbortController.signal, Date.now() + 5_000));
  const recordDispatchRegistryEntry = vi.fn(async () => {
    steps.push('registry');
    if (failure === 'registry') throw new Error('registry_failed');
  });
  const scope: any = {
    readJsonBody: async () => body, DISPATCH_REPORT_REGISTER_MAX_BYTES: 1_000_000,
    JsonBodyTooLargeError: class extends Error {},
    findActiveBySessionId: () => ds, authorizeSessionScopedIpc: () => ({ ok: true }),
    isTrustedHostIpcRequest: () => true, selfDaemonLarkAppId: 'cli_coordinator',
    jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
    readGroupCollaborationMode: () => ({ mode: projectMode ? 'project' : 'standard' }),
    evaluateProjectDispatchPolicy: () => ({ ok: true, projectMode }),
    normalizeDispatchWriteScopes: (scopes: string[]) => scopes,
    partitionProjectDispatchRoles: (bots: Array<{ appId: string; role: string }>) => ({
      workerAppIds: bots.filter(bot => bot.role === 'worker').map(bot => bot.appId),
      reviewerAppIds: bots.filter(bot => bot.role === 'reviewer').map(bot => bot.appId),
    }),
    randomUUID: () => 'reservation-id', projectCoordinator, sendMessage,
    beginTaskControlSeedOperationSync, completeTaskControlSeedOperationSync,
    runWithAbortDeadline,
    taskControlProviderAttemptCoordinates: () => ({
      wallTime: '2026-09-30T00:00:00.000Z', bootId: 'boot-1',
      processStartIdentity: 'process-start-1', monotonicMs: 60_000,
    }),
    loadOrCreateDashboardSecret: () => 'secret', dispatchReportBindingSecretPath: () => '/secret',
    createDispatchReportBinding: () => ({ payload: {}, signature: 'sig' }),
    findDispatchOperation: vi.fn(() => undefined), readProjectGroup: vi.fn(() => undefined),
    getMessageDetail: vi.fn(async () => ({ items: [] })),
    projectGroupRootSnapshotFromLarkDetail: () => undefined,
    daemonProjectTaskControlCanaryFence: vi.fn(() => ({
      fence: { dispatchOperationId: 'operation-id' }, fingerprint: `tccq1:${'a'.repeat(64)}`,
    })),
    withProjectTaskControlChatLockSync: (_dataDir: string, _chatId: string, action: () => unknown) => action(),
    recordDispatchRegistryEntry, join: (...parts: string[]) => parts.join('/'), createHash: () => ({
      update() { return this; }, digest: () => 'a'.repeat(64),
    }),
    createDispatchOperationId: () => 'operation-id',
    initialDispatchLifecycle: () => ({ status: 'dispatched', transportState: 'dispatched', acceptanceState: 'requested', errorCode: null }),
    isMultiTopicOrchestrationEnabled: () => true,
    sessionTopicWriteOptions: () => undefined,
    taskControlIntegration: undefined, logger: { warn: vi.fn() }, config: { session: { dataDir: '/data' } },
    PROJECT_DISPATCH_RESERVATION_TTL_MS: 120_000,
    activeTaskControlPlaneFlags: { ledgerEnabled: false, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false },
    activeTaskControlAllowedKeyIds: undefined,
    activeTaskControlRevokedKeyIds: undefined,
  };
  const run = new Function('scope', 'with (scope) { ' + code + '; return handler; }')(scope);
  return {
    body, steps, scope, projectCoordinator, sendMessage,
    beginTaskControlSeedOperationSync, completeTaskControlSeedOperationSync,
    providerAbortController, runWithAbortDeadline,
    recordDispatchRegistryEntry, run: () => run({}, {}),
  };
}

describe('dispatch registration project reservation', () => {
  it.each([
    { mode: 'read_only', scopes: ['/repo/src'] },
    { mode: 'write', scopes: [] },
    { mode: 'write', scopes: ['/repo/src'], extra: true },
    { mode: 'unknown' },
  ])('rejects malformed access before reserving or sending: %o', async access => {
    const h = harness();
    h.body.access = access as never;
    expect(await h.run()).toMatchObject({ status: 400, value: { error: 'invalid_project_dispatch_access' } });
    expect(h.steps).toEqual([]);
  });

  it.each([
    { workerAppIds: ['cli_worker'], reviewerAppIds: undefined },
    { workerAppIds: ['cli_worker', 'cli_worker'], reviewerAppIds: ['cli_reviewer'] },
    { workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_other'] },
  ])('rejects invalid write role arrays before reserving: %o', async roles => {
    const h = harness();
    Object.assign(h.body, roles);
    expect((await h.run()).status).toBe(400);
    expect(h.steps).toEqual([]);
  });

  it('rejects a reservation conflict before sending the seed', async () => {
    const h = harness('reserve');
    expect(await h.run()).toMatchObject({ status: 409, value: { error: 'project_write_scope_conflict' } });
    expect(h.steps).toEqual(['reserve_dispatch']);
  });

  it.each(['seed', 'registry'] as const)('aborts the reservation after %s failure', async failure => {
    const h = harness(failure);
    expect((await h.run()).status).toBe(failure === 'seed' ? 502 : 500);
    expect(h.steps).toEqual(failure === 'seed'
      ? ['reserve_dispatch', 'seed', 'abort_dispatch']
      : ['reserve_dispatch', 'seed', 'registry', 'abort_dispatch']);
  });

  it('reports an explicit residual when commit fails after the seed and registry exist', async () => {
    const h = harness('commit');
    expect(await h.run()).toMatchObject({
      status: 500,
      value: { ok: false, error: 'project_dispatch_commit_failed', seedCreated: true, dispatchRoot: 'om_seed' },
    });
    expect(h.steps).toEqual(['reserve_dispatch', 'seed', 'registry', 'commit_dispatch']);
  });

  it('reuses the exact registry record when retrying a post-registry commit failure', async () => {
    const h = harness();
    let failCommit = true;
    h.scope.projectCoordinator.run = vi.fn(async (_context: unknown, action: any) => {
      h.steps.push(action.action);
      if (action.action === 'commit_dispatch' && failCommit) throw new Error('commit_failed');
      return {};
    });
    expect(await h.run()).toMatchObject({
      status: 500, value: { error: 'project_dispatch_commit_failed', seedCreated: true, dispatchRoot: 'om_seed' },
    });
    failCommit = false;
    h.scope.findDispatchOperation.mockReturnValue({
      dispatchRoot: 'om_seed', entry: { dispatchOperationId: 'operation-id', status: 'dispatched' },
    });
    expect(await h.run()).toMatchObject({
      status: 201, value: { ok: true, dispatchRoot: 'om_seed', projectSynced: true },
    });
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.recordDispatchRegistryEntry).toHaveBeenCalledTimes(1);
  });

  it('commits before returning success and skips reservations outside project mode', async () => {
    const project = harness();
    expect(await project.run()).toMatchObject({
      status: 201, value: { ok: true, dispatchRoot: 'om_seed', projectSynced: true, access: project.body.access },
    });
    expect(project.steps).toEqual(['reserve_dispatch', 'seed', 'registry', 'commit_dispatch', 'refresh']);

    const standard = harness(undefined, false);
    expect(await standard.run()).toMatchObject({
      status: 201, value: { ok: true, dispatchRoot: 'om_seed', projectSynced: false, access: null },
    });
    expect(standard.steps).toEqual(['seed', 'registry']);
  });

  it('returns the existing committed dispatch when the same trusted turn retries', async () => {
    const h = harness();
    h.scope.findDispatchOperation.mockReturnValue({
      dispatchRoot: 'om_prior', entry: { dispatchOperationId: 'operation-id', status: 'dispatched' },
    });
    h.scope.readProjectGroup.mockReturnValue({ workstreams: [{ dispatchRoot: 'om_prior' }] });
    expect(await h.run()).toMatchObject({
      status: 200, value: { ok: true, dispatchRoot: 'om_prior', projectSynced: true, replayed: true },
    });
    expect(h.steps).toEqual([]);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the durable commit successful when card refresh fails', async () => {
    const h = harness('refresh');
    expect(await h.run()).toMatchObject({
      status: 201, value: { ok: true, dispatchRoot: 'om_seed', projectSynced: true },
    });
    expect(h.steps).toEqual(['reserve_dispatch', 'seed', 'registry', 'commit_dispatch', 'refresh']);
    expect(h.scope.logger.warn).toHaveBeenCalledWith(expect.stringContaining('dispatch card refresh failed'));
  });

  it('fails an explicit audit request before the seed when the runtime flags are not audit-only', async () => {
    const h = harness();
    h.body.taskControlMode = 'audit_only';
    h.scope.evaluateProjectDispatchPolicy = () => ({
      ok: true, projectMode: true, taskControlMode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1,
    });
    h.scope.activeTaskControlPlaneFlags = {
      ledgerEnabled: true, shadowEnabled: false, pumpEnabled: true, freezeEnforcement: false,
    };
    expect(await h.run()).toEqual({
      status: 503, value: { ok: false, error: 'project_task_control_audit_runtime_not_ready' },
    });
    expect(h.steps).toEqual([]);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('passes the canary capacity into the locked project reservation', async () => {
    const h = harness();
    h.body.taskControlMode = 'audit_only';
    h.scope.evaluateProjectDispatchPolicy = () => ({
      ok: true, projectMode: true, taskControlMode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1,
    });
    h.scope.activeTaskControlPlaneFlags = {
      ledgerEnabled: true, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false,
    };
    h.scope.projectGroupTaskGuid = () => '11111111-1111-4111-8111-111111111111';
    h.scope.taskControlIntegration = {
      getProjectGroupTaskControlDecision: vi.fn(() => ({
        capacityReleased: false, admissionSafe: false, admissionBlockers: [],
      })),
    };
    h.scope.loadDaemonIpcSecret = () => 'host-secret';
    h.scope.TaskControlMappingTrust = class {
      issueProjectDispatchReservation() {
        return { schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_coordinator', issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64) };
      }
      verifyProjectDispatchReservation() { return true; }
    };
    h.scope.projectCoordinator.run = vi.fn(async (_context: unknown, action: any) => {
      h.steps.push(action.action);
      expect(typeof action.getTaskControlMappingDecision).toBe('function');
      expect(action.getTaskControlMappingDecision({ dispatchRoot: 'om_old', taskGuid: 'task-old' }))
        .toMatchObject({ capacityReleased: false, admissionSafe: false });
      expect(action).toMatchObject({ action: 'reserve_dispatch', maxActiveTaskControlMappings: 1 });
      throw new Error('project_task_control_canary_capacity_reached');
    });
    expect(await h.run()).toEqual({
      status: 409, value: { ok: false, error: 'project_task_control_canary_capacity_reached' },
    });
    expect(h.steps).toEqual(['reserve_dispatch']);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('reports the created seed when audit root verification fails before binding', async () => {
    const h = harness();
    h.body.taskControlMode = 'audit_only';
    h.scope.evaluateProjectDispatchPolicy = () => ({
      ok: true, projectMode: true, taskControlMode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1,
    });
    h.scope.activeTaskControlPlaneFlags = {
      ledgerEnabled: true, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false,
    };
    h.scope.readProjectGroup = vi.fn(() => ({ workstreams: [], dispatchReservations: [] }));
    h.scope.projectGroupTaskGuid = () => '11111111-1111-4111-8111-111111111111';
    h.scope.loadDaemonIpcSecret = () => 'host-secret';
    h.scope.TaskControlMappingTrust = class {
      issueProjectDispatchReservation() {
        return { schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_coordinator', issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64) };
      }
      verifyProjectDispatchReservation() { return true; }
    };
    h.scope.getMessageDetail = vi.fn(async () => ({ items: [] }));
    h.scope.projectGroupRootSnapshotFromLarkDetail = () => undefined;
    h.scope.projectCoordinator.run = vi.fn(async (_context: unknown, action: any) => {
      h.steps.push(action.action);
      if (action.action === 'reserve_dispatch') {
        return {
          dispatchReservations: [{
            reservationId: action.reservationId, targetAppIds: [...action.targetAppIds].sort(), access: action.access,
            createdAt: action.now, expiresAt: new Date(Date.parse(action.now) + 120_000).toISOString(),
            stage: 'reserved', taskControl: action.taskControl,
          }],
        };
      }
      return {};
    });

    expect(await h.run()).toMatchObject({
      status: 502,
      value: {
        error: 'dispatch_seed_send_failed', seedCreated: true, dispatchRoot: 'om_seed',
        stage: 'reserved', retryableWithSameReservation: true,
      },
    });
    expect(h.steps).toEqual([
      'reserve_dispatch', 'seed_journal_begin', 'seed', 'seed_journal_complete',
    ]);
    expect(h.beginTaskControlSeedOperationSync).toHaveBeenCalledWith(
      '/data/orchestrate-dispatch.json',
      expect.objectContaining({
        operationId: 'operation-id', targetChatId: 'oc_project',
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(h.completeTaskControlSeedOperationSync).toHaveBeenCalledWith(
      '/data/orchestrate-dispatch.json',
      { operationId: 'operation-id', dispatchRoot: 'om_seed' },
    );
    expect(h.sendMessage).toHaveBeenCalledWith(
      'cli_coordinator', 'oc_project', h.body.seedText, 'text', 'seed-provider-uuid',
      undefined, { timeoutMs: 5_000, signal: h.providerAbortController.signal },
    );
    expect(h.runWithAbortDeadline).toHaveBeenCalledWith(
      'project_task_control_seed_delivery', 5_000, expect.any(Function),
    );
  });

  it('keeps the seed reservation after provider success when the delivered journal write fails', async () => {
    const h = harness('seed_journal_complete');
    h.body.taskControlMode = 'audit_only';
    h.scope.evaluateProjectDispatchPolicy = () => ({
      ok: true, projectMode: true, taskControlMode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1,
    });
    h.scope.activeTaskControlPlaneFlags = {
      ledgerEnabled: true, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false,
    };
    h.scope.readProjectGroup = vi.fn(() => ({ workstreams: [], dispatchReservations: [] }));
    h.scope.projectGroupTaskGuid = () => '11111111-1111-4111-8111-111111111111';
    h.scope.loadDaemonIpcSecret = () => 'host-secret';
    h.scope.TaskControlMappingTrust = class {
      issueProjectDispatchReservation() {
        return { schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_coordinator', issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64) };
      }
      verifyProjectDispatchReservation() { return true; }
    };
    h.scope.projectCoordinator.run = vi.fn(async (_context: unknown, action: any) => {
      h.steps.push(action.action);
      if (action.action === 'reserve_dispatch') {
        return {
          dispatchReservations: [{
            reservationId: action.reservationId, targetAppIds: [...action.targetAppIds].sort(), access: action.access,
            createdAt: action.now, expiresAt: new Date(Date.parse(action.now) + 120_000).toISOString(),
            stage: 'reserved', taskControl: action.taskControl,
          }],
        };
      }
      return {};
    });

    expect(await h.run()).toMatchObject({
      status: 502,
      value: {
        error: 'dispatch_seed_send_failed', seedCreated: true, dispatchRoot: 'om_seed',
        stage: 'reserved', retryableWithSameReservation: true,
      },
    });
    expect(h.steps).toEqual([
      'reserve_dispatch', 'seed_journal_begin', 'seed', 'seed_journal_complete',
    ]);
  });

  it('does not begin or send the seed when abandonment wins after reservation', async () => {
    const h = harness();
    h.body.taskControlMode = 'audit_only';
    h.scope.evaluateProjectDispatchPolicy = () => ({
      ok: true, projectMode: true, taskControlMode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1,
    });
    h.scope.activeTaskControlPlaneFlags = {
      ledgerEnabled: true, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false,
    };
    h.scope.readProjectGroup = vi.fn(() => ({ workstreams: [], dispatchReservations: [] }));
    h.scope.projectGroupTaskGuid = () => '11111111-1111-4111-8111-111111111111';
    h.scope.loadDaemonIpcSecret = () => 'host-secret';
    h.scope.TaskControlMappingTrust = class {
      issueProjectDispatchReservation() {
        return { schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_coordinator', issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64) };
      }
      verifyProjectDispatchReservation() { return true; }
    };
    h.scope.projectCoordinator.run = vi.fn(async (_context: unknown, action: any) => {
      h.steps.push(action.action);
      if (action.action === 'reserve_dispatch') {
        return {
          dispatchReservations: [{
            reservationId: action.reservationId, targetAppIds: [...action.targetAppIds].sort(), access: action.access,
            createdAt: action.now, expiresAt: new Date(Date.parse(action.now) + 120_000).toISOString(),
            stage: 'reserved', taskControl: action.taskControl,
          }],
        };
      }
      return {};
    });
    h.scope.daemonProjectTaskControlCanaryFence = vi.fn(() => {
      throw new Error('project_task_control_canary_abandoned');
    });

    expect(await h.run()).toMatchObject({
      status: 502,
      value: {
        error: 'dispatch_seed_send_failed',
        detail: 'project_task_control_canary_abandoned',
        seedCreated: false,
      },
    });
    expect(h.beginTaskControlSeedOperationSync).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('does not journal a delivered seed when abandonment wins during provider delivery', async () => {
    const h = harness();
    h.body.taskControlMode = 'audit_only';
    h.scope.evaluateProjectDispatchPolicy = () => ({
      ok: true, projectMode: true, taskControlMode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1,
    });
    h.scope.activeTaskControlPlaneFlags = {
      ledgerEnabled: true, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false,
    };
    h.scope.readProjectGroup = vi.fn(() => ({ workstreams: [], dispatchReservations: [] }));
    h.scope.projectGroupTaskGuid = () => '11111111-1111-4111-8111-111111111111';
    h.scope.loadDaemonIpcSecret = () => 'host-secret';
    h.scope.TaskControlMappingTrust = class {
      issueProjectDispatchReservation() {
        return { schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_coordinator', issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64) };
      }
      verifyProjectDispatchReservation() { return true; }
    };
    h.scope.projectCoordinator.run = vi.fn(async (_context: unknown, action: any) => {
      h.steps.push(action.action);
      if (action.action === 'reserve_dispatch') {
        return {
          dispatchReservations: [{
            reservationId: action.reservationId, targetAppIds: [...action.targetAppIds].sort(), access: action.access,
            createdAt: action.now, expiresAt: new Date(Date.parse(action.now) + 120_000).toISOString(),
            stage: 'reserved', taskControl: action.taskControl,
          }],
        };
      }
      return {};
    });
    h.scope.daemonProjectTaskControlCanaryFence = vi.fn()
      .mockReturnValueOnce({
        fence: { dispatchOperationId: 'operation-id' }, fingerprint: `tccq1:${'a'.repeat(64)}`,
      })
      .mockImplementationOnce(() => {
        throw new Error('project_task_control_canary_abandoned');
      });

    expect(await h.run()).toMatchObject({
      status: 502,
      value: {
        error: 'dispatch_seed_send_failed',
        detail: 'project_task_control_canary_abandoned',
        seedCreated: true,
        dispatchRoot: 'om_seed',
      },
    });
    expect(h.beginTaskControlSeedOperationSync).toHaveBeenCalledOnce();
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.completeTaskControlSeedOperationSync).not.toHaveBeenCalled();
  });

  it('persists the root, registers one trusted audit mapping, then emits dispatch_requested', async () => {
    const h = harness();
    h.body.taskControlMode = 'audit_only';
    h.scope.evaluateProjectDispatchPolicy = () => ({
      ok: true, projectMode: true, taskControlMode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1,
    });
    h.scope.activeTaskControlPlaneFlags = { ledgerEnabled: true, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false };
    h.scope.readProjectGroup = vi.fn(() => ({ workstreams: [], dispatchReservations: [] }));
    h.scope.projectGroupTaskGuid = () => '11111111-1111-4111-8111-111111111111';
    h.scope.loadDaemonIpcSecret = () => 'host-secret';
    h.scope.TaskControlMappingTrust = class {
      issueProjectDispatchReservation() {
        return { schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_coordinator', issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64) };
      }
      verifyProjectDispatchReservation() { return true; }
    };
    h.scope.getMessageDetail = vi.fn(async () => ({ items: [{
      message_id: 'om_seed', root_id: '', chat_id: 'oc_project', create_time: '1790640000000', sender: { id: 'ou_controller' },
    }] }));
    h.scope.projectGroupRootSnapshotFromLarkDetail = () => ({
      messageId: 'om_seed', chatId: 'oc_project', senderId: 'ou_controller', createTime: '2026-09-29T00:00:00.000Z',
    });
    h.scope.getBot = () => ({ botOpenId: 'ou_controller' });
    h.scope.resolveProjectGroupMappingFacts = (input: any) => ({
      ok: true,
      facts: {
        schemaVersion: 'ProjectGroupMappingRegistration.v1', sourceKind: 'project_group', larkAppId: 'cli_coordinator',
        chatId: 'oc_project', coordinatorSessionId: 'session_source', projectRevision: 4,
        reservationId: input.reservation.reservationId, reservationProofKeyId: input.reservation.proof.keyId,
        dispatchRoot: 'om_seed', taskGuid: input.reservation.taskGuid, projectId: 'project-group:oc_project',
        phaseId: input.reservation.phaseId, controllerAppId: 'cli_coordinator', workerAppId: 'cli_worker',
        reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor', access: input.reservation.access,
        rootCreateTime: input.root.createTime,
      },
    });
    const registerMapping = vi.fn(() => true);
    const dispatchRequested = vi.fn();
    h.scope.taskControlIntegration = { registerMapping, dispatchRequested };
    let reservation: any;
    h.scope.projectCoordinator.run = vi.fn(async (_context: unknown, action: any) => {
      h.steps.push(action.action);
      if (action.action === 'reserve_dispatch') {
        reservation = {
          reservationId: action.reservationId, targetAppIds: [...action.targetAppIds].sort(), access: action.access,
          createdAt: action.now, expiresAt: new Date(Date.parse(action.now) + 120_000).toISOString(),
          stage: 'reserved', taskControl: action.taskControl,
        };
        return { dispatchReservations: [reservation] };
      }
      if (action.action === 'bind_dispatch_root') {
        reservation = { ...reservation, stage: 'root_created', dispatchRoot: action.dispatchRoot, rootCreateTime: action.rootCreateTime };
        return { dispatchReservations: [reservation] };
      }
      if (action.action === 'commit_dispatch') {
        return {
          chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_source', revision: 4,
          workstreams: [{
            dispatchRoot: action.dispatchRoot,
            taskControl: {
              taskGuid: reservation.taskControl.taskGuid, phaseId: reservation.taskControl.phaseId,
              projectRevision: 4, mappingStatus: 'pending', mappingRef: `topic-message:${action.dispatchRoot}`,
              sourceKind: 'project_group', controllerAppId: 'cli_coordinator', workerAppId: 'cli_worker',
              reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor', reservationProof: reservation.taskControl.proof,
            },
          }],
        };
      }
      if (action.action === 'mark_task_control_mapping') return { workstreams: [] };
      return {};
    });

    expect(await h.run()).toMatchObject({
      status: 201,
      value: {
        ok: true, dispatchRoot: 'om_seed', dispatchOperationId: 'operation-id', projectSynced: true,
      },
    });
    expect(h.sendMessage).toHaveBeenCalledWith(
      'cli_coordinator', 'oc_project', h.body.seedText, 'text', 'seed-provider-uuid',
      undefined, { timeoutMs: 5_000, signal: h.providerAbortController.signal },
    );
    expect(h.steps).toEqual([
      'reserve_dispatch', 'seed_journal_begin', 'seed', 'seed_journal_complete',
      'bind_dispatch_root', 'registry', 'commit_dispatch', 'mark_task_control_mapping', 'refresh',
    ]);
    expect(registerMapping).toHaveBeenCalledOnce();
    expect(dispatchRequested).toHaveBeenCalledOnce();
  });

  it('reconciles a committed mapping_pending replay without creating another seed', async () => {
    const h = harness();
    h.body.taskControlMode = 'audit_only';
    h.scope.evaluateProjectDispatchPolicy = () => ({
      ok: true, projectMode: true, taskControlMode: 'audit_only', acceptorAppId: 'cli_acceptor', maxActiveMappings: 1,
    });
    h.scope.activeTaskControlPlaneFlags = { ledgerEnabled: true, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false };
    const taskControl = {
      taskGuid: '11111111-1111-4111-8111-111111111111',
      phaseId: 'workstream:11111111-1111-4111-8111-111111111111', mappingRef: 'topic-message:om_prior',
      mappingStatus: 'pending', sourceKind: 'project_group', controllerAppId: 'cli_coordinator',
      workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor', projectRevision: 4,
      reservationId: 'operation-id', originTurnId: 'turn_1', reservationCreatedAt: '2026-09-29T00:00:00.000Z',
      reservationExpiresAt: '2099-09-29T00:00:00.000Z', rootCreateTime: '2026-09-29T00:00:01.000Z',
      recovery: {
        seedText: h.body.seedText, title: h.body.title, purpose: h.body.purpose,
        owners: h.body.owners, botOpenIds: [], acceptanceRequested: true,
      },
      reservationProof: { schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_coordinator', issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64) },
    };
    h.scope.findDispatchOperation.mockReturnValue({
      dispatchRoot: 'om_prior', entry: { dispatchOperationId: 'operation-id', status: 'dispatched', taskControl: { mode: 'audit_only' } },
    });
    h.scope.readProjectGroup = vi.fn(() => ({
      chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_source', revision: 5,
      workstreams: [{
        dispatchRoot: 'om_prior', status: 'pending', access: h.body.access,
        targetAppIds: ['cli_worker', 'cli_reviewer'], taskControl,
      }],
      dispatchReservations: [],
    }));
    h.scope.getBot = () => ({ botOpenId: 'ou_controller' });
    h.scope.getMessageDetail = vi.fn(async () => ({ items: [{
      message_id: 'om_prior', root_id: '', chat_id: 'oc_project', create_time: '1790640001000', sender: { id: 'ou_controller' },
    }] }));
    h.scope.projectGroupRootSnapshotFromLarkDetail = () => ({
      messageId: 'om_prior', chatId: 'oc_project', senderId: 'ou_controller', createTime: taskControl.rootCreateTime,
    });
    h.scope.loadDaemonIpcSecret = () => 'host-secret';
    h.scope.TaskControlMappingTrust = class { verifyProjectDispatchReservation() { return true; } };
    h.scope.resolveProjectGroupMappingFacts = (input: any) => ({
      ok: true,
      facts: {
        chatId: 'oc_project', reservationId: taskControl.reservationId, taskGuid: taskControl.taskGuid,
        projectId: 'project-group:oc_project', phaseId: taskControl.phaseId, workerAppId: taskControl.workerAppId,
        reviewerAppId: taskControl.reviewerAppId, acceptorAppId: taskControl.acceptorAppId,
        projectRevision: taskControl.projectRevision,
      },
    });
    const registerMapping = vi.fn(() => true);
    const dispatchRequested = vi.fn();
    h.scope.taskControlIntegration = { registerMapping, dispatchRequested };
    h.scope.projectCoordinator.run = vi.fn(async (_context: unknown, action: any) => {
      h.steps.push(action.action);
      return { workstreams: [{ dispatchRoot: 'om_prior', taskControl: { ...taskControl, mappingStatus: 'registered' } }] };
    });

    expect(await h.run()).toMatchObject({
      status: 200,
      value: {
        ok: true, dispatchRoot: 'om_prior', dispatchOperationId: 'operation-id',
        projectSynced: true, replayed: true, taskControlReconciled: true,
      },
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(registerMapping).toHaveBeenCalledOnce();
    expect(dispatchRequested).toHaveBeenCalledOnce();
    expect(h.steps).toEqual(['mark_task_control_mapping', 'refresh']);
  });
});

describe('audit-only kickoff delivery route', () => {
  it('accepts only operation and root references and delegates canonical payload construction to the daemon', async () => {
    const operationId = 'a'.repeat(50);
    const deliverProjectTaskControlKickoff = vi.fn(async () => ({
      state: 'delivered', messageId: 'om_kickoff',
    }));
    const ds: any = {
      larkAppId: 'cli_coordinator', chatId: 'oc_project',
      session: { sessionId: 'session_source' },
    };
    const scope: any = {
      readJsonBody: async () => ({
        sessionId: 'session_source', rootId: 'om_seed', chatId: 'oc_project',
        dispatchOperationId: operationId,
      }),
      DISPATCH_USER_DELIVERY_MAX_BYTES: 1_000_000,
      JsonBodyTooLargeError: class extends Error {},
      findActiveBySessionId: () => ds,
      authorizeSessionScopedIpc: () => ({ ok: true }),
      isTrustedHostIpcRequest: () => true,
      selfDaemonLarkAppId: 'cli_coordinator',
      jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
      config: { session: { dataDir: '/data' } },
      taskControlProviderAttemptCoordinates: () => ({
        wallTime: '2026-09-30T00:00:00.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 60_000,
      }),
      deliverProjectTaskControlKickoff,
    };
    const run = new Function('scope', `with (scope) { ${deliveryCode}; return handler; }`)(scope);
    const result = await run({}, {});
    expect(result).toEqual({
      status: 200,
      value: { ok: true, state: 'delivered', messageId: 'om_kickoff' },
    });
    expect(deliverProjectTaskControlKickoff).toHaveBeenCalledWith({
      context: {
        dataDir: '/data', chatId: 'oc_project', larkAppId: 'cli_coordinator',
        coordinatorSessionId: 'session_source',
      },
      dispatchRoot: 'om_seed',
      operationId,
      attempt: {
        wallTime: '2026-09-30T00:00:00.000Z', bootId: 'boot-1',
        processStartIdentity: 'process-start-1', monotonicMs: 60_000,
      },
    });
  });

  it('rejects generic cross-turn --into delivery to a fenced canary root before Lark send', async () => {
    const replyMessage = vi.fn(async () => 'om_forbidden_into');
    const ds: any = {
      larkAppId: 'cli_coordinator', chatId: 'oc_project',
      session: { sessionId: 'session_source' },
    };
    const scope: any = {
      readJsonBody: async () => ({
        sessionId: 'session_source', rootId: 'om_fenced_root', chatId: 'oc_project',
        content: '{"zh_cn":{"content":[]}}', targetAppIds: ['cli_worker'], hasLegacyBots: false,
      }),
      DISPATCH_USER_DELIVERY_MAX_BYTES: 1_000_000,
      JsonBodyTooLargeError: class extends Error {},
      findActiveBySessionId: () => ds,
      authorizeSessionScopedIpc: () => ({ ok: true }),
      isTrustedHostIpcRequest: () => true,
      selfDaemonLarkAppId: 'cli_coordinator',
      jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
      lookupMessageChatId: async () => 'oc_project',
      readGroupCollaborationMode: () => ({ mode: 'project' }),
      readProjectGroup: () => ({
        workstreams: [{
          dispatchRoot: 'om_fenced_root', targetAppIds: ['cli_worker', 'cli_reviewer'],
          taskControl: { sourceKind: 'project_group', mappingStatus: 'registered', reservationId: 'a'.repeat(50) },
        }],
      }),
      daemonProjectTaskControlCanaryFence: () => ({
        fence: {
          dispatchOperationId: 'a'.repeat(50), workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer',
        },
        fingerprint: `tccq1:${'a'.repeat(64)}`,
      }),
      evaluateProjectDispatchPolicy: () => ({ ok: true }),
      getBot: () => ({ config: {} }),
      replyMessage,
      config: { session: { dataDir: '/data' } },
    };
    const run = new Function('scope', `with (scope) { ${deliveryCode}; return handler; }`)(scope);
    expect(await run({}, {})).toEqual({
      status: 409,
      value: { ok: false, error: 'project_task_control_canary_fence_rejects_turn' },
    });
    expect(replyMessage).not.toHaveBeenCalled();
  });
});

describe('audit-only evidence ingress route', () => {
  it('automatically attempts the persisted success certificate after accepted evidence ingress', async () => {
    const persistProjectTaskControlSuccessCertificateIfReady = vi.fn(async () => ({
      state: 'persisted', certificateHash: `tcsc1:${'c'.repeat(64)}`,
    }));
    const ingestProjectWorkerEvidence = vi.fn(() => ({ ok: true, receiptRef: 'receipt:accepted' }));
    const scope: any = {
      isTrustedHostIpcRequest: () => true,
      taskControlIntegration: {
        mapping: () => ({
          controllerId: 'cli_controller', ownerId: 'cli_worker', reviewerId: 'cli_reviewer',
          acceptorId: 'cli_acceptor',
          mappingAuthority: { kind: 'project_group', chatId: 'oc_project', mode: 'audit_only' },
        }),
        ingestProjectWorkerEvidence,
      },
      selfDaemonLarkAppId: 'cli_controller',
      readJsonBody: async () => ({ evidence: {
        sourceAppId: 'cli_worker', controllerAppId: 'cli_controller',
        dispatchRoot: 'om_canary', eventKind: 'terminal',
      } }),
      PROJECT_WORKER_EVIDENCE_MAX_BYTES: 32 * 1024,
      JsonBodyTooLargeError: class extends Error {},
      findOnlineDaemon: () => ({ ipcPort: 4321 }),
      readGroupCollaborationMode: () => ({ mode: 'project' }),
      evaluateProjectTaskControlEvidencePolicy: () => ({ ok: true }),
      ProjectWorkerEvidenceTrust: class { verify() { return true; } },
      loadDaemonIpcSecret: () => 'host-secret',
      activeTaskControlAllowedKeyIds: undefined,
      activeTaskControlRevokedKeyIds: undefined,
      join,
      config: { session: { dataDir: '/data' } },
      readProjectGroup: () => ({ blockerRecords: [], workstreams: [] }),
      daemonAbandonedTaskControlCanaryRejectsRoot: () => false,
      persistProjectTaskControlSuccessCertificateIfReady,
      logger: { warn: vi.fn() },
      withProjectTaskControlChatLockSync: (_dataDir: string, _chatId: string, action: () => unknown) => action(),
      jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
    };
    const run = new Function('scope', `with (scope) { ${evidenceCode}; return handler; }`)(scope);

    expect(await run({}, {})).toEqual({
      status: 201,
      value: { ok: true, receiptRef: 'receipt:accepted' },
    });
    expect(persistProjectTaskControlSuccessCertificateIfReady).toHaveBeenCalledWith({
      dataDir: '/data', chatId: 'oc_project', dispatchRoot: 'om_canary',
    });
  });

  it('rejects late evidence for an abandoned bound root before controller ingestion', async () => {
    const ingestProjectWorkerEvidence = vi.fn(() => ({ ok: true, receiptRef: 'receipt:late' }));
    const project = { blockerRecords: [], workstreams: [] };
    const daemonAbandonedTaskControlCanaryRejectsRoot = vi.fn(() => true);
    const scope: any = {
      isTrustedHostIpcRequest: () => true,
      taskControlIntegration: {
        mapping: () => ({
          controllerId: 'cli_controller', ownerId: 'cli_worker', reviewerId: 'cli_reviewer',
          acceptorId: 'cli_acceptor',
          mappingAuthority: { kind: 'project_group', chatId: 'oc_project', mode: 'audit_only' },
        }),
        ingestProjectWorkerEvidence,
      },
      selfDaemonLarkAppId: 'cli_controller',
      readJsonBody: async () => ({ evidence: {
        sourceAppId: 'cli_worker', controllerAppId: 'cli_controller',
        dispatchRoot: 'om_abandoned', eventKind: 'accepted',
      } }),
      PROJECT_WORKER_EVIDENCE_MAX_BYTES: 32 * 1024,
      JsonBodyTooLargeError: class extends Error {},
      findOnlineDaemon: () => ({ ipcPort: 4321 }),
      readGroupCollaborationMode: () => ({ mode: 'project' }),
      evaluateProjectTaskControlEvidencePolicy: () => ({ ok: true }),
      ProjectWorkerEvidenceTrust: class { verify() { return true; } },
      loadDaemonIpcSecret: () => 'host-secret',
      activeTaskControlAllowedKeyIds: undefined,
      activeTaskControlRevokedKeyIds: undefined,
      join,
      config: { session: { dataDir: '/data' } },
      readProjectGroup: () => project,
      daemonAbandonedTaskControlCanaryRejectsRoot,
      withProjectTaskControlChatLockSync: (_dataDir: string, _chatId: string, action: () => unknown) => action(),
      jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
    };
    const run = new Function('scope', `with (scope) { ${evidenceCode}; return handler; }`)(scope);

    expect(await run({}, {})).toEqual({
      status: 409,
      value: { ok: false, error: 'project_task_control_canary_abandoned' },
    });
    expect(daemonAbandonedTaskControlCanaryRejectsRoot).toHaveBeenCalledWith(
      project,
      '/data/orchestrate-dispatch.json',
      'om_abandoned',
    );
    expect(ingestProjectWorkerEvidence).not.toHaveBeenCalled();
  });
});
