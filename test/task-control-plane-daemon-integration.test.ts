import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonTaskControlAuthority } from '../src/services/task-control-plane-authority.js';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';
import { DaemonTaskControlIntegration } from '../src/services/task-control-plane-daemon-integration.js';
import { startTaskControlPlaneRuntime } from '../src/services/task-control-plane-runtime.js';
import { signTaskControlApproval } from '../src/services/task-control-plane-authority.js';

function mapping() {
  return {
    controllerId: 'controller-1', projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: ['task-1'],
    taskGuid: 'task-1', topicRootId: 'om_root', ownerId: 'worker-1', reviewerId: 'reviewer-1',
    acceptorId: 'acceptor-1', registrationRef: 'task-comment:123', docToken: 'doc-token-12345678',
  };
}

describe('DaemonTaskControlIntegration', () => {
  it('persists controller mapping in SQLite and restores it without a JSON sidecar', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: { get: () => undefined }, approvalKeys: new Map() });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      expect(lifecycle.getStore()!.listTrustedMappings()).toEqual([expect.objectContaining({
        dispatchRoot: 'om_root', phaseTaskGuids: ['task-1'], docToken: 'doc-token-12345678',
      })]);
      await lifecycle.close();

      const restoredBridge = new DaemonTaskControlBridge({ approvals: { get: () => undefined }, approvalKeys: new Map() });
      const restoredLifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: restoredBridge.authority, logger: { warn: () => {} } });
      new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restoredLifecycle, store: restoredLifecycle.getStore()!, bridge: restoredBridge, logger: { warn: () => {} } });
      expect(restoredBridge.mapping('om_root')).toMatchObject({ projectId: 'project-1', taskGuid: 'task-1' });
      await restoredLifecycle.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('emits only UNKNOWN when worker activity lacks a registered mapping', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined, approvalKeys: new Map() });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority, logger: { warn: () => {} } });
      const bridge = new DaemonTaskControlBridge({ approvals: { get: () => undefined }, approvalKeys: new Map() });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      integration.workerAccepted('om_missing', 'input-commit:session-1:turn-1');
      await new Promise(resolve => setImmediate(resolve));
      expect(lifecycle.getStore()!.listEvents()).toEqual([]);
      expect(lifecycle.getStore()!.listObservations()).toEqual([expect.objectContaining({
        attemptedEventType: 'task.accepted', sourceRef: 'input-commit:session-1:turn-1',
      })]);
      await lifecycle.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('records report fallback only as a reference-only UNKNOWN', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined, approvalKeys: new Map() });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority, logger: { warn: () => {} } });
      const bridge = new DaemonTaskControlBridge({ approvals: { get: () => undefined }, approvalKeys: new Map() });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      integration.reportFallbackUnknown('report:session-1:offline', 'orchestrator_daemon_offline');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(lifecycle.getStore()!.listEvents()).toEqual([]);
      expect(lifecycle.getStore()!.listObservations()).toEqual([expect.objectContaining({
        attemptedEventType: 'task.delivery_fallback_verified',
        payload: { source: 'report-fallback', errorClass: 'orchestrator_daemon_offline', referenceOnly: true },
      })]);
      await lifecycle.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('records mapped worker hooks and durable approval proof without trusting hook payload identities', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const key = Buffer.from('integration-approval-key');
      const bridge = new DaemonTaskControlBridge({ approvals: { get: () => undefined }, approvalKeys: new Map([['key-1', key]]) });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const proof = signTaskControlApproval(key, {
        keyId: 'key-1', approvalRef: 'approval:integration', projectId: 'project-1', phaseId: 'phase-1',
        taskSetSnapshot: ['task-1'], acceptorId: 'acceptor-1',
        approvedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
      });
      expect(lifecycle.getStore()!.registerApprovalProof({ approvalRef: proof.approvalRef, proof })).toBe(true);
      const durableBridge = new DaemonTaskControlBridge({
        approvals: { get: ref => lifecycle.getStore()!.getApprovalProof(ref)?.proof as any },
        approvalKeys: new Map([['key-1', key]]),
      });
      expect(durableBridge.approval(proof.approvalRef)).toEqual(proof);
      integration.workerAccepted('om_root', 'input-commit:session-1:turn-1');
      integration.workerExecutionStarted('om_root', 'execution:session-1:turn-1');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' })).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: 'task.accepted', actorId: 'worker-1', actorRole: 'worker' }),
        expect.objectContaining({ eventType: 'task.execution_started', actorId: 'worker-1', actorRole: 'worker' }),
      ]));
      await lifecycle.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
