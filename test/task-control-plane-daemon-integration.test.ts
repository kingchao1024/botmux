import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonTaskControlAuthority } from '../src/services/task-control-plane-authority.js';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';
import { DaemonTaskControlIntegration } from '../src/services/task-control-plane-daemon-integration.js';
import { scopedTaskControlPlaneConfig, startTaskControlPlaneRuntime } from '../src/services/task-control-plane-runtime.js';
import { DaemonReviewerVerdictProvider } from '../src/services/task-control-plane-reviewer-verdict.js';

function gate() {
  return {
    runId: 'run-1', nodeId: 'gate-node', instanceId: 'gate-node#001', waitId: 'gate-node#001-gate',
    operatorId: 'acceptor-1', approverPolicy: ['acceptor-1'],
  };
}

function mapping() {
  return {
    projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: ['task-1'],
    taskGuid: 'task-1', topicRootId: 'om_root', ownerId: 'worker-1', reviewerId: 'reviewer-1',
    acceptorId: 'acceptor-1', registrationRef: 'task-comment:123', docToken: 'doc-token-12345678', approvalGate: gate(),
  };
}

function source() {
  return {
    validateBinding: () => true,
    get: ({ gate: binding }: any) => ({
      runId: binding.runId, nodeId: binding.nodeId, instanceId: binding.instanceId, waitId: binding.waitId,
      operatorId: binding.operatorId, approvedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
    }),
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { interval: 5, timeout: 500 });
}

function reviewerProvider() {
  return new DaemonReviewerVerdictProvider({ key: Buffer.from('integration-reviewer-key'), keyId: 'integration-reviewer-key', now: () => Date.parse('2026-09-05T00:30:00.000Z') });
}

const P2_7_ENV = {
  TASK_CONTROL_PLANE_LEDGER_ENABLED: 'true',
  TASK_CONTROL_PLANE_SHADOW_ENABLED: 'true',
  TASK_CONTROL_PLANE_PUMP_ENABLED: 'false',
  TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT: 'false',
  TASK_CONTROL_PLANE_PROJECT_ID: 'p2-7-canary',
  TASK_CONTROL_PLANE_PHASE_ID: 'phase-1',
  TASK_CONTROL_PLANE_TASK_GUIDS: 'dddcc370-e210-4dd1-b7b9-9dabddc38ddf,7637c5bc-729e-4e58-978d-20ab9f9679a8,a151cdaa-fb8f-4800-be3c-cdf273e56d23',
  TASK_CONTROL_PLANE_CONTROLLER_LARK_APP_ID: 'cli_aac926f0eb795bc1',
  TASK_CONTROL_PLANE_WORKER_LARK_APP_ID: 'cli_aa1e53f7aaf81bc6',
  TASK_CONTROL_PLANE_REVIEWER_LARK_APP_ID: 'cli_aa1e4c5508f8dbd3',
  TASK_CONTROL_PLANE_DOC_TOKEN: 'Rk2VdXPb8oRcBFxdZp9morIlyZc',
};

const collectorMocks = vi.hoisted(() => ({
  getBotClient: vi.fn(() => ({})),
  larkGet: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({ getBotClient: collectorMocks.getBotClient }));
vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: vi.fn(),
  larkGet: collectorMocks.larkGet,
}));

function canaryMapping(taskGuid = 'dddcc370-e210-4dd1-b7b9-9dabddc38ddf', overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'p2-7-canary', phaseId: 'phase-1',
    phaseTaskGuids: [
      'dddcc370-e210-4dd1-b7b9-9dabddc38ddf',
      '7637c5bc-729e-4e58-978d-20ab9f9679a8',
      'a151cdaa-fb8f-4800-be3c-cdf273e56d23',
    ],
    taskGuid, topicRootId: 'om_p2_7_root', ownerId: 'worker-1', reviewerId: 'reviewer-1',
    acceptorId: 'acceptor-1', registrationRef: 'task-comment:123', docToken: 'Rk2VdXPb8oRcBFxdZp9morIlyZc', approvalGate: gate(),
    ...overrides,
  };
}

describe('DaemonTaskControlIntegration', () => {
  it('accepts only the fixed P2-7 three-task mapping and keeps controller callbacks non-advancing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-canary-'));
    try {
      const config = scopedTaskControlPlaneConfig('cli_aac926f0eb795bc1', P2_7_ENV);
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'cli_aac926f0eb795bc1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'cli_aac926f0eb795bc1', flags: config.flags, authority: bridge.authority, logger: { warn: () => {} }, collect: async () => {} });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: 'cli_aac926f0eb795bc1', lifecycle, store, bridge, logger: { warn: () => {} }, canary: config.canary,
      });
      expect(integration.registerMapping('om_p2_7_root', canaryMapping(), 'controller-1')).toBe(true);
      expect(integration.registerMapping('om_other', canaryMapping('dddcc370-e210-4dd1-b7b9-9dabddc38ddf', { projectId: 'other' }), 'controller-1')).toBe(false);
      expect(integration.registerMapping('om_extra', canaryMapping('dddcc370-e210-4dd1-b7b9-9dabddc38ddf', {
        phaseTaskGuids: ['dddcc370-e210-4dd1-b7b9-9dabddc38ddf', '7637c5bc-729e-4e58-978d-20ab9f9679a8', 'a151cdaa-fb8f-4800-be3c-cdf273e56d23', '11111111-1111-1111-1111-111111111111'],
      }), 'controller-1')).toBe(false);
      expect(integration.registerMapping('om_wrong_task', canaryMapping('11111111-1111-1111-1111-111111111111'), 'controller-1')).toBe(false);
      integration.workerAccepted('om_other', 'other-input');
      integration.terminalWithoutRevision('om_other', 'other-terminal', { reason: 'other' });
      integration.workerAccepted('om_p2_7_root', 'target-input');
      expect(store.listEvents({ taskGuid: 'dddcc370-e210-4dd1-b7b9-9dabddc38ddf' }).map(event => event.eventType))
        .toEqual(['mapping.registered']);
      expect(store.listObservations()).toEqual([]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('permits the canary reviewer only to read the fixed scope, never to register a mapping', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-canary-reviewer-'));
    try {
      const config = scopedTaskControlPlaneConfig('cli_aa1e4c5508f8dbd3', P2_7_ENV);
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'cli_aa1e4c5508f8dbd3' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'cli_aa1e4c5508f8dbd3', flags: config.flags, authority: bridge.authority, logger: { warn: () => {} }, collect: async () => {} });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'cli_aa1e4c5508f8dbd3', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} }, canary: config.canary });
      expect(integration.canaryRole()).toBe('reviewer');
      expect(integration.registerMapping('om_p2_7_root', canaryMapping(), 'controller-1')).toBe(false);
      expect(integration.mapping('om_p2_7_root')).toBeUndefined();
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('keeps reviewer-restored mappings from advancing worker lifecycle or delivery state', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-canary-reviewer-restored-'));
    try {
      const controllerConfig = scopedTaskControlPlaneConfig('cli_aac926f0eb795bc1', P2_7_ENV);
      const controllerBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerConfig.canary!.controllerAppId });
      const controllerLifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerConfig.canary!.controllerAppId, flags: controllerConfig.flags, authority: controllerBridge.authority, logger: { warn: () => {} }, collect: async () => {},
      });
      const controller = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerConfig.canary!.controllerAppId, lifecycle: controllerLifecycle, store: controllerLifecycle.getStore()!, bridge: controllerBridge, logger: { warn: () => {} }, canary: controllerConfig.canary,
      });
      expect(controller.registerMapping('om_p2_7_root', canaryMapping(), 'controller-1')).toBe(true);
      await controllerLifecycle.close();

      const reviewerConfig = scopedTaskControlPlaneConfig('cli_aa1e4c5508f8dbd3', P2_7_ENV);
      const reviewerBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: reviewerConfig.canary!.controllerAppId });
      const reviewerLifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: reviewerConfig.canary!.controllerAppId, flags: reviewerConfig.flags, authority: reviewerBridge.authority, logger: { warn: () => {} }, collect: async () => {},
      });
      const reviewer = new DaemonTaskControlIntegration({
        dataDir, larkAppId: reviewerConfig.canary!.reviewerAppId, lifecycle: reviewerLifecycle, store: reviewerLifecycle.getStore()!, bridge: reviewerBridge, logger: { warn: () => {} }, canary: reviewerConfig.canary,
        isLiveReceiptOwner: () => true,
      });
      expect(reviewer.mapping('om_p2_7_root')).toMatchObject({ taskGuid: 'dddcc370-e210-4dd1-b7b9-9dabddc38ddf' });
      reviewer.workerAccepted('om_p2_7_root', 'reviewer-input');
      reviewer.workerExecutionStarted('om_p2_7_root', 'reviewer-execution');
      reviewer.firstSubmitted('om_p2_7_root', 'reviewer-submitted', { docToken: 'Rk2VdXPb8oRcBFxdZp9morIlyZc', docRevision: 1, evidenceRef: 'topic-message:om_reviewer_submit' });
      reviewer.delivered('om_p2_7_root', 'reviewer-delivery', {
        docToken: 'Rk2VdXPb8oRcBFxdZp9morIlyZc', docRevision: 1, destinationId: 'topic-message:om_p2_7_root', receiptRef: 'topic-message:om_reviewer_receipt', evidenceRef: 'topic-message:om_reviewer_receipt',
      });
      await reviewer.finalDeliveryReceived('om_p2_7_root', 'reviewer-final-delivery', {
        sessionId: 'reviewer-session', workerGeneration: 1, destinationId: 'topic-message:om_p2_7_root', receiptRef: 'topic-message:om_reviewer_final', docToken: 'Rk2VdXPb8oRcBFxdZp9morIlyZc',
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(reviewerLifecycle.getStore()!.listEvents({ taskGuid: 'dddcc370-e210-4dd1-b7b9-9dabddc38ddf' }).map(event => event.eventType))
        .toEqual(['mapping.registered']);
      expect(reviewerLifecycle.getStore()!.listOutbox()).toEqual([]);
      expect(reviewerLifecycle.getStore()!.listObservations()).toEqual([]);
      await reviewerLifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('restores the controller-owned mapping partition for the fixed worker role only', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-canary-worker-'));
    try {
      const controllerConfig = scopedTaskControlPlaneConfig('cli_aac926f0eb795bc1', P2_7_ENV);
      const controllerBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'cli_aac926f0eb795bc1' });
      const controllerLifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerConfig.canary!.controllerAppId, flags: controllerConfig.flags, authority: controllerBridge.authority, logger: { warn: () => {} }, collect: async () => {},
      });
      const controller = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerConfig.canary!.controllerAppId, lifecycle: controllerLifecycle, store: controllerLifecycle.getStore()!, bridge: controllerBridge, logger: { warn: () => {} }, canary: controllerConfig.canary,
      });
      for (const [index, taskGuid] of controllerConfig.canary!.taskGuids.entries()) {
        expect(controller.registerMapping(`om_p2_7_root_${index}`, canaryMapping(taskGuid, {
          topicRootId: `om_p2_7_root_${index}`, registrationRef: `task-comment:${123 + index}`,
        }), 'controller-1')).toBe(true);
      }
      await controllerLifecycle.close();

      const workerConfig = scopedTaskControlPlaneConfig('cli_aa1e53f7aaf81bc6', P2_7_ENV);
      const workerBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: workerConfig.canary!.controllerAppId });
      const workerLifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: workerConfig.canary!.controllerAppId, flags: workerConfig.flags, authority: workerBridge.authority, logger: { warn: () => {} }, collect: async () => {},
      });
      const worker = new DaemonTaskControlIntegration({
        dataDir, larkAppId: workerConfig.canary!.workerAppId, lifecycle: workerLifecycle, store: workerLifecycle.getStore()!, bridge: workerBridge, logger: { warn: () => {} }, canary: workerConfig.canary,
      });
      expect(worker.mapping('om_p2_7_root_0')).toMatchObject({ taskGuid: 'dddcc370-e210-4dd1-b7b9-9dabddc38ddf' });
      expect(worker.mapping('om_p2_7_root_1')).toMatchObject({ taskGuid: '7637c5bc-729e-4e58-978d-20ab9f9679a8' });
      expect(worker.mapping('om_p2_7_root_2')).toMatchObject({ taskGuid: 'a151cdaa-fb8f-4800-be3c-cdf273e56d23' });
      worker.workerAccepted('om_p2_7_root_0', 'worker-input');
      worker.workerExecutionStarted('om_p2_7_root_0', 'worker-execution');
      worker.firstSubmitted('om_p2_7_root_0', 'worker-submitted', {
        docToken: 'Rk2VdXPb8oRcBFxdZp9morIlyZc', docRevision: 1, evidenceRef: 'topic-message:om_worker_submit',
      });
      worker.delivered('om_p2_7_root_0', 'worker-delivery', {
        docToken: 'Rk2VdXPb8oRcBFxdZp9morIlyZc', docRevision: 1, destinationId: 'topic-message:om_p2_7_root_0',
        receiptRef: 'topic-message:om_worker_receipt', evidenceRef: 'topic-message:om_worker_receipt',
      });
      await waitFor(() => expect(workerLifecycle.getStore()!.listEvents({ taskGuid: 'dddcc370-e210-4dd1-b7b9-9dabddc38ddf' }).map(event => event.eventType))
        .toEqual(expect.arrayContaining(['task.accepted', 'task.execution_started', 'task.first_submitted', 'task.delivered'])));
      const delivered = workerLifecycle.getStore()!.listEvents({ taskGuid: 'dddcc370-e210-4dd1-b7b9-9dabddc38ddf' })
        .find(event => event.eventType === 'task.delivered')!;
      expect(workerLifecycle.getStore()!.listOutbox({ eventId: delivered.eventId }))
        .toEqual([expect.objectContaining({ status: 'delivered', destinationId: 'topic-message:om_p2_7_root_0' })]);
      expect(workerLifecycle.getStore()!.getPhaseProjection('p2-7-canary', 'phase-1').expectedTaskGuids)
        .toEqual([...controllerConfig.canary!.taskGuids].sort());
      await workerLifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('collects only the fixed three task references and probes an unreadable comment source once per process', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-canary-collector-'));
    try {
      const config = scopedTaskControlPlaneConfig('cli_aac926f0eb795bc1', P2_7_ENV);
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'cli_aac926f0eb795bc1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'cli_aac926f0eb795bc1', flags: config.flags, authority: bridge.authority, logger: { warn: () => {} }, collect: async () => {} });
      const store = lifecycle.getStore()!;
      collectorMocks.larkGet.mockImplementation(async (_client, path, query) => {
        if (path.startsWith('/open-apis/task/v2/tasks/')) return { code: 0, data: { task: { status: 'todo' } } };
        if (path === '/open-apis/task/v2/comments') {
          expect(config.canary!.taskGuids).toContain(query.resource_id);
          throw new Error('permission_denied');
        }
        throw new Error(`unexpected:${path}`);
      });
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: 'cli_aac926f0eb795bc1', lifecycle, store, bridge, logger: { warn: () => {} }, canary: config.canary, shadowTaskGuids: config.canary!.taskGuids,
      });
      await integration.collectAll();
      await integration.collectAll();
      await waitFor(() => expect(store.listObservations()).toHaveLength(4));
      const taskReads = collectorMocks.larkGet.mock.calls.filter(([, path]) => String(path).startsWith('/open-apis/task/v2/tasks/'));
      const commentReads = collectorMocks.larkGet.mock.calls.filter(([, path]) => path === '/open-apis/task/v2/comments');
      expect(taskReads).toHaveLength(6);
      expect(new Set(taskReads.map(([, path]) => String(path).split('/').at(-1)))).toEqual(new Set(config.canary!.taskGuids));
      expect(commentReads).toHaveLength(1);
      expect(store.listEvents()).toEqual([]);
      await lifecycle.close();
    } finally {
      collectorMocks.larkGet.mockReset();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('persists controller mapping in SQLite and restores it without a JSON sidecar', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      expect(lifecycle.getStore()!.listTrustedMappings()).toEqual([expect.objectContaining({
        dispatchRoot: 'om_root', phaseTaskGuids: ['task-1'], docToken: 'doc-token-12345678',
        approvalGate: expect.objectContaining({ runId: 'run-1', approvalRef: expect.stringMatching(/^approval:gate-/) }),
      })]);
      await lifecycle.close();

      const restoredBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const restoredLifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: restoredBridge.authority, logger: { warn: () => {} } });
      new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restoredLifecycle, store: restoredLifecycle.getStore()!, bridge: restoredBridge, logger: { warn: () => {} } });
      expect(restoredBridge.mapping('om_root')).toMatchObject({ projectId: 'project-1', taskGuid: 'task-1' });
      await restoredLifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('emits only UNKNOWN when worker activity lacks a registered mapping', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority, logger: { warn: () => {} } });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      integration.workerAccepted('om_missing', 'input-commit:session-1:turn-1');
      await waitFor(() => expect(lifecycle.getStore()!.listObservations()).toHaveLength(1));
      expect(lifecycle.getStore()!.listEvents()).toEqual([]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('records report fallback only as a reference-only UNKNOWN', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority, logger: { warn: () => {} } });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      integration.reportFallbackUnknown('report:session-1:offline', 'orchestrator_daemon_offline');
      await waitFor(() => expect(lifecycle.getStore()!.listObservations()).toHaveLength(1));
      expect(lifecycle.getStore()!.listEvents()).toEqual([]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('keeps a receipt from a replaced worker generation as reference-only UNKNOWN', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-stale-receipt-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} },
        isLiveReceiptOwner: ({ sessionId, workerGeneration }) => sessionId === 'session-b' && workerGeneration === 2,
      });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      await integration.finalDeliveryReceived('om_root', 'delivery:session-a:1:turn-1:receipt-a', {
        sessionId: 'session-a', workerGeneration: 1, destinationId: 'topic-message:om_root', receiptRef: 'topic-message:om_receipt_a', docToken: 'doc-token-12345678',
      });
      await waitFor(() => expect(store.listObservations()).toEqual(expect.arrayContaining([expect.objectContaining({
        attemptedEventType: 'task.delivered', outcome: 'unknown', payload: expect.objectContaining({ reason: 'receipt_worker_generation_unproven' }),
      })])));
      expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType)).not.toContain('task.delivered');
      expect(store.listOutbox()).toEqual([]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('records mapped worker hooks without trusting hook payload identities and derives approval only from its gate source', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const approvalRef = integration.mapping('om_root')!.approvalGate.approvalRef;
      const proof = integration.approval('om_root', approvalRef);
      expect(bridge.authority.verifyApproval({
        approval: proof, projectId: 'project-1', phaseId: 'phase-1', taskSetSnapshot: ['task-1'], acceptorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ approvalRef });
      integration.workerAccepted('om_root', 'input-commit:session-1:turn-1');
      integration.workerExecutionStarted('om_root', 'execution:session-1:turn-1');
      await waitFor(() => expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' })).toHaveLength(3));
      expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' })).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: 'task.accepted', actorId: 'worker-1', actorRole: 'worker' }),
        expect.objectContaining({ eventType: 'task.execution_started', actorId: 'worker-1', actorRole: 'worker' }),
      ]));
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('keeps generic review and rework hints reference-only while preserving verified worker lifecycle facts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      integration.workerAccepted('om_root', 'accept');
      integration.workerExecutionStarted('om_root', 'execute');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 7, evidenceRef: 'task-comment:101' });
      integration.reviewed('om_root', 'review', {
        reviewRound: 1, reviewCommentId: 'comment-1', verdict: 'conditional', conditionIds: ['c-1'],
        resolvedConditionEvidence: { 'c-1': { evidenceRef: 'task-comment:102', observedAt: '2026-09-05T00:30:00.000Z' } },
        reviewerVerdictId: 'unverified-verdict', docToken: 'doc-final', docRevision: 7, evidenceRef: 'task-comment:102',
      });
      integration.reworkStarted('om_root', 'rework', 'task-comment:103');
      integration.firstSubmitted('om_root', 'resubmit', { docToken: 'doc-final', docRevision: 8, evidenceRef: 'task-comment:104' });
      integration.reviewed('om_root', 'review-final', {
        reviewRound: 2, reviewCommentId: 'comment-2', verdict: 'pass', reviewerVerdictId: 'unverified-verdict-final',
        docToken: 'doc-final', docRevision: 8, evidenceRef: 'task-comment:105',
      });
      integration.delivered('om_root', 'deliver', {
        docToken: 'doc-final', docRevision: 8, destinationId: 'topic-message:om_delivery', receiptRef: 'topic-message:om_delivery_receipt', evidenceRef: 'topic-message:om_delivery_receipt',
      });
      integration.doneMarked('om_root', 'done', 'task-comment:106');
      await waitFor(() => expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType)).toEqual(expect.arrayContaining([
        'task.first_submitted', 'task.delivered', 'task.done_marked',
      ])));
      expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType))
        .not.toEqual(expect.arrayContaining(['task.reviewed', 'task.rework_started']));
      await waitFor(() => expect(lifecycle.getStore()!.listObservations()).toEqual(expect.arrayContaining([
        expect.objectContaining({ attemptedEventType: 'task.reviewed', outcome: 'unknown' }),
        expect.objectContaining({ attemptedEventType: 'task.rework_started', outcome: 'unknown' }),
      ])));
      const terminal = lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.delivered').at(-1)!;
      expect(lifecycle.getStore()!.listOutbox({ eventId: terminal.eventId })[0]).toMatchObject({ status: 'delivered', destinationId: 'topic-message:om_delivery' });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('binds a verified verdict id to review and rejects that same review after verifier/head changes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-reviewer-integration-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const designation = provider.issueDesignatedReviewer({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1',
        effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
      });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const verdict = provider.issueVerdict({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_review',
        sourceVersionHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(integration.submitReviewerVerdict({
        dispatchRoot: 'om_root', verdict, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'active', verdict: { verdictId: verdict.verdictId } });
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).some(event => event.payload.reviewerVerdictId === verdict.verdictId)).toBe(true));
      const review = store.getTaskProjection('task-1', '2026-09-05T00:30:00.000Z').independentReview!;
      expect(review.reviewerVerdictId).toBe(verdict.verdictId);
      expect(store.validatePhaseFreeze('project-1', 'phase-1', '2026-09-05T00:30:00.000Z').issues.map(issue => issue.code))
        .not.toContain('reviewer_verdict_unverified');
      store.setReviewerVerdictVerifier(undefined);
      expect(store.getTaskProjection('task-1', '2026-09-05T00:30:00.000Z')).toMatchObject({ reviewerVerdictIssue: expect.any(String) });
      store.setReviewerVerdictVerifier(provider);
      expect(store.getTaskProjection('task-1', '2026-09-05T01:00:00.000Z')).toMatchObject({ reviewerVerdictIssue: expect.any(String) });
      const revocation = provider.issueVerdict({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_revoke',
        sourceVersionHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        kind: 'revocation', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        revokesVerdictId: verdict.verdictId, expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(store.appendReviewerVerdict({
        verdict: revocation, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'revoked' });
      expect(store.getTaskProjection('task-1', '2026-09-05T00:30:00.000Z')).toMatchObject({ reviewerVerdictIssue: expect.any(String) });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('does not report a verified verdict active when its synchronous task.reviewed append conflicts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-reviewer-append-conflict-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const designation = provider.issueDesignatedReviewer({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1',
        effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
      });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      integration.workerAccepted('om_root', 'accept', '2026-09-05T00:10:00.000Z');
      integration.workerExecutionStarted('om_root', 'execute', '2026-09-05T00:11:00.000Z');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 8, evidenceRef: 'topic-message:om_submit' });
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType))
        .toEqual(expect.arrayContaining(['task.accepted', 'task.execution_started', 'task.first_submitted'])));
      const verdict = provider.issueVerdict({
        verdictId: 'append-failure', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_review',
        sourceVersionHash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(store.appendReviewerVerdict({
        verdict, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'active' });
      const sourceRef = 'reviewer-verdict:append-failure';
      store.appendEvent({
        eventId: 'prior-reviewed', eventType: 'task.reviewed', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root',
        authentication: reviewer, sourceRef, occurredAt: '2026-09-05T00:30:00.000Z', idempotencyKey: 'task-control:task.reviewed:reviewer-verdict:append-failure',
        payload: { reviewRound: 1, reviewCommentId: 'om_prior', independent: true, verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, reviewerVerdictId: verdict.verdictId, docToken: 'doc-final', docRevision: 8 },
      });
      expect(integration.submitReviewerVerdict({
        dispatchRoot: 'om_root', verdict, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'unknown', reason: 'reviewer_verdict_reviewed_append_conflict' });
      expect(store.listEvents({ taskGuid: 'task-1' }).filter(event => event.payload.reviewerVerdictId === 'append-failure'))
        .toEqual([expect.objectContaining({ eventId: 'prior-reviewed' })]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('rejects phase freeze after the active reviewer verdict is revoked', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-reviewer-freeze-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const designation = provider.issueDesignatedReviewer({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1',
        effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
      });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      integration.workerAccepted('om_root', 'accept', '2026-09-05T00:10:00.000Z');
      integration.workerExecutionStarted('om_root', 'execute', '2026-09-05T00:11:00.000Z');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 8, evidenceRef: 'topic-message:om_submit' });
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType))
        .toEqual(expect.arrayContaining(['task.accepted', 'task.execution_started', 'task.first_submitted'])));
      const verdict = provider.issueVerdict({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_review',
        sourceVersionHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(integration.submitReviewerVerdict({
        dispatchRoot: 'om_root', verdict, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'active' });
      await waitFor(() => expect(store.getTaskProjection('task-1', '2026-09-05T00:30:00.000Z').state).toBe('reviewing'));
      integration.delivered('om_root', 'deliver', {
        docToken: 'doc-final', docRevision: 8, destinationId: 'topic-message:om_delivery', receiptRef: 'topic-message:om_delivery_receipt', evidenceRef: 'topic-message:om_delivery_receipt',
      });
      integration.doneMarked('om_root', 'done', 'task-comment:101');
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('task_done_pending_freeze'));
      store.appendEvent({
        eventId: 'freeze-request', eventType: 'phase.freeze_requested', projectId: 'project-1', phaseId: 'phase-1', authentication: controller,
        idempotencyKey: 'freeze-request', sourceRef: 'task-comment:102',
        payload: { taskGuids: ['task-1'], openIssueCodes: [], requestRef: 'task-comment:102' },
      });
      expect(store.validatePhaseFreeze('project-1', 'phase-1', '2026-09-05T00:30:00.000Z').ok).toBe(true);
      const revocation = provider.issueVerdict({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_revoke',
        sourceVersionHash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        kind: 'revocation', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        revokesVerdictId: verdict.verdictId, expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(store.appendReviewerVerdict({
        verdict: revocation, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'revoked' });
      const rejected = store.freezePhase({
        eventId: 'freeze-after-revoke', projectId: 'project-1', phaseId: 'phase-1',
        authentication: bridge.issueAuthentication('om_root', 'acceptor')!, approval: integration.approval('om_root', integration.mapping('om_root')!.approvalGate.approvalRef),
        idempotencyKey: 'freeze-after-revoke', occurredAt: '2026-09-05T00:30:00.000Z',
      });
      expect(rejected).toMatchObject({ kind: 'rejected' });
      expect(rejected.validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reviewer_verdict_unverified' })]));
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});
