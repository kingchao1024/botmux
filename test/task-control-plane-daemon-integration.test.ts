import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonTaskControlAuthority } from '../src/services/task-control-plane-authority.js';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';
import { DaemonTaskControlIntegration } from '../src/services/task-control-plane-daemon-integration.js';
import { TaskControlPlaneStore } from '../src/services/task-control-plane-store.js';
import { startTaskControlPlaneRuntime } from '../src/services/task-control-plane-runtime.js';
import { DaemonReviewerVerdictProvider } from '../src/services/task-control-plane-reviewer-verdict.js';
import { TaskControlMappingTrust } from '../src/services/task-control-plane-mapping-trust.js';


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

describe('DaemonTaskControlIntegration', () => {
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

  it('persists the generated mapping proof and restores the signed production mapping after restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-proof-restart-'));
    try {
      const trust = new TaskControlMappingTrust({ hostSecret: 'test-host-secret', larkAppId: 'app-1' });
      const verifier = { minimumTaskCount: 1, verifyMapping: (proof: any, facts: Record<string, unknown>) => trust.verifyMapping(proof, facts) };
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1', productionMapping: verifier });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} }, mappingTrust: trust });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      expect(lifecycle.getStore()!.listTrustedMappings()[0]?.mappingProof).toMatchObject({ keyId: trust.mappingKeyId });
      await lifecycle.close();
      const restoredBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1', productionMapping: verifier });
      const restored = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: restoredBridge.authority, logger: { warn: () => {} } });
      new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restored, store: restored.getStore()!, bridge: restoredBridge, logger: { warn: () => {} }, mappingTrust: trust });
      expect(restoredBridge.mapping('om_root')).toMatchObject({ taskGuid: 'task-1', mappingProof: { keyId: trust.mappingKeyId } });
      await restored.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('reconciles a post-write/pre-settle task comment across restart without a duplicate create', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-comment-crash-'));
    try {
      const trust = new TaskControlMappingTrust({ hostSecret: 'comment-host-secret', larkAppId: 'app-1' });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const comments: Array<{ id: string; content: string }> = [];
      let creates = 0;
      const deliveryClient = {
        listTaskComments: async () => ({ code: 0, data: { items: comments, has_more: false } }),
        createTaskComment: async ({ content }: { taskGuid: string; content: string }) => { creates++; comments.push({ id: '2001', content }); return { code: 0, commentId: '2001' }; },
        replyTopic: async () => 'om_unused',
      };
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const worker = bridge.issueAuthentication('om_root', 'worker')!;
      store.appendEvent({ eventId: 'delivered', eventType: 'task.delivered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'delivered', terminal: true, deliverTo: ['task-comment:task-1'], payload: { docToken: 'doc-final', docRevision: 1 } });
      const first = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'first' })[0]!;
      // First write reaches the provider but the process crashes before settlement.
      expect(await integration.deliver(first)).toEqual({ kind: 'delivered', receiptRef: 'task-comment:2001' });
      expect(creates).toBe(1);
      await lifecycle.close();
      const restartedBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const restarted = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: restartedBridge.authority, logger: { warn: () => {} } });
      const restartedStore = restarted.getStore()!;
      const restartedIntegration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restarted, store: restartedStore, bridge: restartedBridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      restartedStore.resetExpiredOutboxClaims(Date.now() + 61_000, 60_000);
      const retry = restartedStore.claimOutbox({ now: Date.now() + 61_000, limit: 1, claimToken: 'retry' })[0]!;
      expect(await restartedIntegration.deliver(retry)).toEqual({ kind: 'delivered', receiptRef: 'task-comment:2001' });
      expect(creates).toBe(1);
      await restarted.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('atomically degrades a permanently rejected task comment into one topic fallback receipt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-comment-fallback-'));
    try {
      const trust = new TaskControlMappingTrust({ hostSecret: 'fallback-host-secret', larkAppId: 'app-1' });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      let topicReplies = 0;
      const deliveryClient = {
        listTaskComments: async () => ({ code: 0, data: { items: [], has_more: false } }),
        createTaskComment: async () => ({ code: 1470403 }),
        replyTopic: async () => { topicReplies++; return 'om_abc123'; },
      };
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const worker = bridge.issueAuthentication('om_root', 'worker')!;
      store.appendEvent({ eventId: 'delivered', eventType: 'task.delivered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'delivered', terminal: true, deliverTo: ['task-comment:task-1'], payload: { docToken: 'doc-final', docRevision: 1 } });
      const primary = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'primary' })[0]!;
      const rejected = await integration.deliver(primary);
      expect(rejected).toMatchObject({ kind: 'degraded', fallbackDestinationId: 'topic-message:om_root' });
      store.degradeOutboxWithFallback({ eventId: primary.eventId, sourceDestinationId: primary.destinationId, fallbackDestinationId: rejected.fallbackDestinationId!, claimToken: 'primary', error: rejected.error!, now: Date.now() });
      expect(store.listOutbox()).toEqual(expect.arrayContaining([expect.objectContaining({ destinationId: 'task-comment:task-1', status: 'degraded' }), expect.objectContaining({ destinationId: 'topic-message:om_root', status: 'pending' })]));
      const fallback = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'fallback' })[0]!;
      const fallbackResult = await integration.deliver(fallback);
      expect(fallbackResult).toEqual({ kind: 'delivered', receiptRef: 'topic-message:om_abc123' });
      store.settleOutboxDelivered(fallback.outboxId, 'fallback', { receiptRef: TaskControlPlaneStore.providerReceiptRef(fallback.eventId, fallback.destinationId, fallbackResult.receiptRef!) });
      expect(topicReplies).toBe(1);
      expect(store.listEvents().some(event => event.eventType === 'task.delivery_fallback_verified')).toBe(true);
      await lifecycle.close();
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

  it('starts rework only from the active conditional verdict and a later daemon-owned execution fact', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-rework-producer-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const designation = provider.issueDesignatedReviewer({ projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1', effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T01:00:00.000Z' });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      integration.workerAccepted('om_root', 'accept'); integration.workerExecutionStarted('om_root', 'execution-before-review');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 1, evidenceRef: 'task-comment:101' });
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('submitted'));
      const verdict = provider.issueVerdict({ projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review', sourceMessageId: 'om_review', sourceVersionHash: `sha256:${'a'.repeat(64)}`, kind: 'verdict', verdict: 'conditional', conditionIds: ['c1'], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 1, expiresAt: '2099-09-05T01:00:00.000Z' });
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const submittedVerdict = integration.submitReviewerVerdict({ dispatchRoot: 'om_root', verdict, authentication: reviewer, attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review' }, verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z' });
      expect(submittedVerdict).toEqual(expect.objectContaining({ status: 'active' }));
      integration.workerExecutionStarted('om_root', 'execution-after-review');
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).some(event => event.sourceRef === 'execution-after-review')).toBe(true));
      const execution = store.listEvents({ taskGuid: 'task-1' }).find(event => event.sourceRef === 'execution-after-review')!;
      expect(integration.beginRework({ dispatchRoot: 'om_root', sourceRef: 'rework:one', sourceReviewerVerdictId: verdict.verdictId, newExecutionEventId: execution.eventId, evidenceRef: 'task-comment:102' })).toEqual({ ok: true });
      expect(integration.beginRework({ dispatchRoot: 'om_root', sourceRef: 'rework:bad', sourceReviewerVerdictId: verdict.verdictId, newExecutionEventId: 'missing', evidenceRef: 'task-comment:103' })).toMatchObject({ ok: false });
      expect(store.getTaskProjection('task-1').state).toBe('rework');
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
