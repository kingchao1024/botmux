import { describe, expect, it } from 'vitest';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';

function gate() {
  return {
    runId: 'run-1', nodeId: 'gate-node', instanceId: 'gate-node#001', waitId: 'gate-node#001-gate',
    operatorId: 'acceptor-1', approverPolicy: ['acceptor-1'],
  };
}

function mapping() {
  return {
    controllerId: 'controller-1', projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: ['task-1'], taskGuid: 'task-1', topicRootId: 'om_root',
    ownerId: 'worker-1', reviewerId: 'reviewer-1', acceptorId: 'acceptor-1', registrationRef: 'task-comment:123',
    approvalGate: { ...gate(), approvalRef: 'approval:gate-1' },
  };
}

function source() {
  return {
    validateBinding: () => true,
    get: ({ gate: binding }: any) => ({
      runId: binding.runId, nodeId: binding.nodeId, instanceId: binding.instanceId, waitId: binding.waitId,
      operatorId: binding.operatorId, approvedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
    }),
    getWriteExecution: ({ candidate, action, attempt, operatorId }: any) => candidate === '3928820' && action === 'git.commit' && attempt === 2 && operatorId === 'acceptor-1'
      ? { issuedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T01:00:00.000Z' } : undefined,
  };
}

describe('DaemonTaskControlBridge', () => {
  it('requires a complete registered mapping and mints principals by fixed role', () => {
    const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
    expect(bridge.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
    expect(bridge.event({
      dispatchRoot: 'om_root', principal: 'worker', eventId: 'event-1', idempotencyKey: 'key-1', sourceRef: 'dispatch:om_root',
      payload: { actorId: 'forged', actorRole: 'acceptor', title: 'PASS', reportBody: 'approved', exitCode: 0 },
    })).toMatchObject({ projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root' });
    const worker = bridge.issueAuthentication('om_root', 'worker');
    expect(bridge.authority.authenticate(worker)).toEqual({ actorId: 'worker-1', actorRole: 'worker' });
    expect(bridge.event({ dispatchRoot: 'om_unregistered', principal: 'worker', eventId: 'x', idempotencyKey: 'x', sourceRef: 'x' })).toBeUndefined();
  });

  it('rejects mapping conflicts, role overlap and unverified gate binding', () => {
    const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
    expect(bridge.registerMapping('om_root', { ...mapping(), reviewerId: 'worker-1' }, 'controller-1')).toBe(false);
    expect(bridge.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
    expect(bridge.registerMapping('om_root', { ...mapping(), phaseId: 'other' }, 'controller-1')).toBe(false);
    const rejected = new DaemonTaskControlBridge({ approvals: { validateBinding: () => false, get: () => undefined }, larkAppId: 'app-1' });
    expect(rejected.registerMapping('om_root', mapping(), 'controller-1')).toBe(false);
  });

  it('requires exact durable source run/node/instance/operator and approval reference', () => {
    const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
    expect(bridge.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
    const proof = bridge.approval('om_root', 'approval:gate-1');
    expect(bridge.authority.verifyApproval({
      approval: proof, projectId: 'project-1', phaseId: 'phase-1', taskSetSnapshot: ['task-1'],
      acceptorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z',
    })).toMatchObject({ approvalRef: 'approval:gate-1' });
    expect(bridge.approval('om_root', 'approval:other')).toBeUndefined();
    const wrongSource = new DaemonTaskControlBridge({
      approvals: { validateBinding: () => true, get: ({ gate: binding }) => ({ ...source().get({ gate: binding }), instanceId: 'other#001' }) },
      larkAppId: 'app-1',
    });
    expect(wrongSource.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
    expect(wrongSource.approval('om_root', 'approval:gate-1')).toBeUndefined();
  });

  it('mints write authority only from an exact durable structured source', () => {
    const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
    expect(bridge.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
    const exact = { dispatchRoot: 'om_root', grantRef: 'grant:write-1', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', candidate: '3928820', action: 'git.commit', attempt: 2, operatorId: 'acceptor-1' };
    expect(bridge.issueWriteExecutionGrant(exact)).toBeTruthy();
    expect(bridge.issueWriteExecutionGrant({ ...exact, candidate: 'other' })).toBeUndefined();
    expect(bridge.issueWriteExecutionGrant({ ...exact, operatorId: 'worker-1' })).toBeUndefined();
  });
});
