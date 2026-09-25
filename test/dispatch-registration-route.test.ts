import { readFileSync } from 'node:fs';
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

type Failure = 'reserve' | 'seed' | 'registry' | 'commit' | 'refresh';

function harness(failure?: Failure, projectMode = true) {
  const steps: string[] = [];
  const body = {
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
    managedTurnOrigin: { turnId: 'turn_1', dispatchAttempt: 1 },
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
    loadOrCreateDashboardSecret: () => 'secret', dispatchReportBindingSecretPath: () => '/secret',
    createDispatchReportBinding: () => ({ payload: {}, signature: 'sig' }),
    findDispatchOperation: vi.fn(() => undefined), readProjectGroup: vi.fn(() => undefined),
    recordDispatchRegistryEntry, join: (...parts: string[]) => parts.join('/'), createHash: () => ({
      update() { return this; }, digest: () => 'operation-id',
    }),
    initialDispatchLifecycle: () => ({ status: 'dispatched', transportState: 'dispatched', acceptanceState: 'requested', errorCode: null }),
    taskControlIntegration: undefined, logger: { warn: vi.fn() }, config: { session: { dataDir: '/data' } },
  };
  const run = new Function('scope', 'with (scope) { ' + code + '; return handler; }')(scope);
  return { body, steps, scope, projectCoordinator, sendMessage, recordDispatchRegistryEntry, run: () => run({}, {}) };
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
});
