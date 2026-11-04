import { readFileSync as readLocalFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = ts.createSourceFile(
  'daemon.ts', readLocalFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true,
);
const route = source.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'REPORT_SESSION_RELAY_ROUTE') as ts.ExpressionStatement;
const handler = (route.expression as ts.CallExpression).arguments[2];
const code = ts.transpileModule(`const handler = ${handler.getText(source)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

const oldLease = {
  repoKey: 'a'.repeat(64), leaseId: 'lease-old', fencingToken: 4, workingDir: '/repo',
};
const newLease = { ...oldLease, leaseId: 'lease-new', fencingToken: 5 };

function harness(input: {
  status?: 'in_progress' | 'completed' | 'failed';
  reviewVerdict?: 'pass' | 'fail';
  projectMutationOk?: boolean;
  projectMutationError?: string;
  currentStatus?: 'in_progress' | 'blocked';
  acquireError?: string;
  attachError?: string;
  releaseError?: string;
} = {}) {
  const steps: string[] = [];
  const projectMutationOk = input.projectMutationOk !== false;
  const decision: any = {
    ok: true,
    source: { sessionId: 'session-worker', larkAppId: 'cli_worker', turnId: 'turn-report' },
    target: { sessionId: 'session-controller', larkAppId: 'cli_controller' },
    dispatchRoot: 'om_write', sourceName: 'write', content: 'report', reporterAppId: 'cli_worker',
    projectRequired: true,
    projectUpdate: input.reviewVerdict
      ? { reviewVerdict: input.reviewVerdict, reviewRound: 1 }
      : { status: input.status ?? 'completed' },
  };
  if (input.reviewVerdict) decision.reporterAppId = 'cli_reviewer';
  const currentProject: any = {
    chatId: 'oc_project',
    workstreams: [{
      dispatchRoot: 'om_write', status: input.currentStatus ?? 'in_progress',
      access: { mode: 'write', scopes: ['/repo'] }, repositoryLeaseRef: oldLease,
      workerAppIds: ['cli_worker'], reviewerAppIds: ['cli_reviewer'],
      ...(input.currentStatus === 'blocked'
        ? { review: { verdict: 'fail', reviewerAppId: 'cli_reviewer', round: 1 } }
        : {}),
      updatedAt: '2026-10-12T00:00:00.000Z',
    }],
  };
  const acquireRepositoryWriter = vi.fn(() => {
    steps.push('acquire_repository_lease');
    if (input.acquireError) throw new Error(input.acquireError);
    return { leaseRef: newLease, lease: { ...newLease } };
  });
  const releaseRepositoryWriter = vi.fn(() => {
    steps.push('release_repository_lease');
    if (input.releaseError) throw new Error(input.releaseError);
    return { revision: 3, releasedLeaseId: oldLease.leaseId };
  });
  const recordRepositoryLeaseReconcileRequired = vi.fn(() => {
    steps.push('record_repository_lease_reconcile');
    return { revision: 4, status: 'unknown' };
  });
  const generationHandle = { stop: vi.fn(() => steps.push('stop_generation_lease')) };
  const bindActiveRepositoryLeaseGeneration = vi.fn(() => {
    steps.push('attach_repository_lease');
    if (input.attachError) throw new Error(input.attachError);
    return generationHandle;
  });
  const fetchDaemonIpc = vi.fn(async (_port: number, _path: string, init: any) => {
    steps.push('project_mutation');
    if (input.projectMutationError) throw new Error(input.projectMutationError);
    const action = JSON.parse(init.body);
    const resultingLease = action.repositoryLeaseRef ?? oldLease;
    const resultingStatus = input.reviewVerdict
      ? input.reviewVerdict === 'fail' ? 'blocked' : 'completed'
      : input.status === 'completed' ? 'in_review' : input.status ?? 'in_review';
    return {
      ok: projectMutationOk,
      status: projectMutationOk ? 200 : 409,
      json: async () => projectMutationOk
        ? {
            ok: true,
            project: {
              revision: 8,
              workstreams: [{
                dispatchRoot: 'om_write', status: resultingStatus,
                repositoryLeaseRef: resultingLease,
                updatedAt: '2026-10-12T00:01:00.000Z',
                delivery: input.status === 'completed' ? { round: 1 } : undefined,
              }],
            },
          }
        : { ok: false, error: 'project_mutation_failed' },
    };
  });
  const deliverReportSessionRelay = vi.fn(async ({ postProjectUpdate }: any) => {
    const sync = await postProjectUpdate(decision.target);
    const failed = !sync.projectSynced;
    return {
      status: failed ? 409 : 200,
      body: { ok: !failed, triggerAccepted: true, triggerId: 'om_trigger', ...sync },
    };
  });
  const registry = {
    om_write: {
      orchChatId: 'oc_project',
      access: { mode: 'write', scopes: ['/repo'] },
      repositoryLeaseRef: oldLease,
    },
  };
  const ds: any = {
    chatId: 'oc_child', larkAppId: decision.reporterAppId, scope: 'thread', workerGeneration: 7,
    session: { sessionId: 'session-worker', rootMessageId: 'om_write', workerGeneration: 7 },
    managedTurnOrigin: { turnId: 'turn-report', dispatchAttempt: 1, capability: 'capability' },
  };
  const scope: any = {
    readJsonBody: async () => ({ sessionId: 'session-worker' }), REPORT_SESSION_RELAY_MAX_BYTES: 1024,
    JsonBodyTooLargeError: class extends Error {},
    findActiveBySessionId: () => ds,
    readFileSync: () => JSON.stringify(registry), join: (...parts: string[]) => parts.join('/'),
    readProjectGroup: (_dataDir: string, chatId: string) => chatId === 'oc_project' ? currentProject : undefined,
    TASK_CONTROL_CANARY_QUARANTINE_CODE: 'task_control_canary_quarantine',
    authorizeReportSessionRelayRequest: () => decision,
    isTrustedHostIpcRequest: () => true, selfDaemonLarkAppId: decision.reporterAppId,
    loadOrCreateDashboardSecret: () => 'secret', dispatchReportBindingSecretPath: () => '/secret',
    findOnlineDaemon: () => ({ ipcPort: 1234 }),
    fetchDaemonIpc, deliverReportSessionRelay,
    resolveDispatchRepositoryLeaseRequirement: vi.fn(async () => ({
      identity: { repoKey: oldLease.repoKey, canonicalCommonDir: '/repo/.git' },
      workingDir: '/repo', scopes: ['/repo'],
    })),
    resolveRepositoryIdentity: vi.fn(async () => ({ repoKey: oldLease.repoKey, canonicalCommonDir: '/repo/.git' })),
    acquireRepositoryWriter, releaseRepositoryWriter, recordRepositoryLeaseReconcileRequired,
    bindActiveRepositoryLeaseGeneration,
    readRepositoryControl: vi.fn(() => ({ writerLease: oldLease })),
    createHash: () => ({ update() { return this; }, digest: () => 'b'.repeat(64) }),
    jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
    taskControlIntegration: undefined, projectWorkerEvidenceRelay: undefined,
    config: { session: { dataDir: '/data' } }, logger: { warn: vi.fn() },
  };
  const run = new Function('scope', `with (scope) { ${code}; return handler; }`)(scope);
  return {
    steps, scope, fetchDaemonIpc, acquireRepositoryWriter, releaseRepositoryWriter,
    recordRepositoryLeaseReconcileRequired,
    bindActiveRepositoryLeaseGeneration, generationHandle,
    run: () => run({}, {}),
  };
}

describe('project report repository lease route', () => {
  it('releases the writer lease only after a write delivery durably enters in_review', async () => {
    const h = harness({ status: 'completed' });
    expect(await h.run()).toMatchObject({ status: 200, value: { projectSynced: true } });
    expect(h.steps).toEqual(['project_mutation', 'release_repository_lease']);
    expect(h.releaseRepositoryWriter).toHaveBeenCalledWith('/data', expect.objectContaining({
      leaseId: oldLease.leaseId, fencingToken: oldLease.fencingToken,
    }));
  });

  it('does not release the lease when the project report mutation fails', async () => {
    const h = harness({ status: 'completed', projectMutationOk: false });
    expect(await h.run()).toMatchObject({
      status: 409, value: { projectSynced: false, projectSyncError: 'project_mutation_failed' },
    });
    expect(h.steps).toEqual(['project_mutation']);
    expect(h.releaseRepositoryWriter).not.toHaveBeenCalled();
  });

  it('keeps review-only activity lease-free', async () => {
    const h = harness({ reviewVerdict: 'pass' });
    expect(await h.run()).toMatchObject({ status: 200, value: { projectSynced: true } });
    expect(h.steps).toEqual(['project_mutation']);
    expect(h.acquireRepositoryWriter).not.toHaveBeenCalled();
    expect(h.releaseRepositoryWriter).not.toHaveBeenCalled();
  });

  it('reacquires the original workstream with a new fencing token before repair starts', async () => {
    const h = harness({ status: 'in_progress', currentStatus: 'blocked' });
    expect(await h.run()).toMatchObject({ status: 200, value: { projectSynced: true } });
    expect(h.steps).toEqual([
      'acquire_repository_lease', 'attach_repository_lease', 'project_mutation',
    ]);
    expect(h.bindActiveRepositoryLeaseGeneration).toHaveBeenCalledWith(expect.objectContaining({
      leaseRef: newLease,
      sessionId: 'session-worker',
      workerGeneration: 7,
      replaceExisting: true,
    }));
    expect(JSON.parse(h.fetchDaemonIpc.mock.calls[0]![2].body)).toMatchObject({
      action: 'report', repositoryLeaseRef: newLease,
    });
  });

  it('rejects repair continuation when reacquire fails under a frozen barrier', async () => {
    const h = harness({
      status: 'in_progress', currentStatus: 'blocked', acquireError: 'repository_barrier_blocks_writer',
    });
    expect(await h.run()).toMatchObject({
      status: 409,
      value: { projectSynced: false, projectSyncError: 'repository_barrier_blocks_writer' },
    });
    expect(h.steps).toEqual(['acquire_repository_lease']);
    expect(h.fetchDaemonIpc).not.toHaveBeenCalled();
  });

  it('releases a repair lease when attaching the current worker generation fails', async () => {
    const h = harness({
      status: 'in_progress', currentStatus: 'blocked', attachError: 'generation_attach_failed',
    });

    expect(await h.run()).toMatchObject({
      status: 409,
      value: { projectSynced: false, projectSyncError: 'generation_attach_failed' },
    });
    expect(h.steps).toEqual([
      'acquire_repository_lease', 'attach_repository_lease', 'release_repository_lease',
    ]);
    expect(h.releaseRepositoryWriter).toHaveBeenCalledWith('/data', expect.objectContaining({
      leaseId: newLease.leaseId,
      fencingToken: newLease.fencingToken,
    }));
    expect(h.fetchDaemonIpc).not.toHaveBeenCalled();
  });

  it('stops the generation handle and releases the exact repair lease when project IPC throws', async () => {
    const h = harness({
      status: 'in_progress', currentStatus: 'blocked', projectMutationError: 'ipc_connection_reset',
    });

    expect(await h.run()).toMatchObject({
      status: 409,
      value: { projectSynced: false, projectSyncError: 'ipc_connection_reset' },
    });
    expect(h.steps).toEqual([
      'acquire_repository_lease', 'attach_repository_lease', 'project_mutation',
      'stop_generation_lease', 'release_repository_lease',
    ]);
    expect(h.releaseRepositoryWriter).toHaveBeenCalledWith('/data', expect.objectContaining({
      leaseId: newLease.leaseId,
      fencingToken: newLease.fencingToken,
    }));
  });

  it('durably records UNKNOWN reconciliation when thrown IPC compensation cannot release the lease', async () => {
    const h = harness({
      status: 'in_progress', currentStatus: 'blocked', projectMutationError: 'ipc_connection_reset',
      releaseError: 'repository_lease_stale_token',
    });

    expect(await h.run()).toMatchObject({
      status: 409,
      value: { projectSynced: false, projectSyncError: expect.stringContaining('repository_lease_reconcile_required') },
    });
    expect(h.steps).toEqual([
      'acquire_repository_lease', 'attach_repository_lease', 'project_mutation',
      'stop_generation_lease', 'release_repository_lease', 'record_repository_lease_reconcile',
    ]);
    expect(h.recordRepositoryLeaseReconcileRequired).toHaveBeenCalledWith('/data', expect.objectContaining({
      leaseId: newLease.leaseId,
      fencingToken: newLease.fencingToken,
      reason: 'repository_lease_stale_token',
    }));
  });

  it('releases an active writer after a failed workstream is durably recorded', async () => {
    const h = harness({ status: 'failed' });
    expect(await h.run()).toMatchObject({ status: 200, value: { projectSynced: true } });
    expect(h.steps).toEqual(['project_mutation', 'release_repository_lease']);
  });
});
