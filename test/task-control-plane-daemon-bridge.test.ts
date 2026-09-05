import { describe, expect, it } from 'vitest';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';
import { signTaskControlApproval } from '../src/services/task-control-plane-authority.js';

const key = Buffer.from('daemon-bridge-test-key');

function mapping() {
  return {
    controllerId: 'controller-1', projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: ['task-1'], taskGuid: 'task-1', topicRootId: 'om_root',
    ownerId: 'worker-1', reviewerId: 'reviewer-1', acceptorId: 'acceptor-1', registrationRef: 'task-comment:123',
  };
}

describe('DaemonTaskControlBridge', () => {
  it('requires a complete independently registered mapping and mints principals by fixed role', () => {
    const bridge = new DaemonTaskControlBridge({ approvals: { get: () => undefined }, approvalKeys: new Map([['key-1', key]]) });
    expect(bridge.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
    expect(bridge.event({
      dispatchRoot: 'om_root', principal: 'worker', eventId: 'event-1', idempotencyKey: 'key-1', sourceRef: 'dispatch:om_root',
      payload: { actorId: 'forged', actorRole: 'acceptor', title: 'PASS', reportBody: 'approved', exitCode: 0 },
    })).toMatchObject({ projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root' });
    const worker = bridge.issueAuthentication('om_root', 'worker');
    expect(bridge.authority.authenticate(worker)).toEqual({ actorId: 'worker-1', actorRole: 'worker' });
    expect(bridge.event({ dispatchRoot: 'om_unregistered', principal: 'worker', eventId: 'x', idempotencyKey: 'x', sourceRef: 'x' })).toBeUndefined();
  });

  it('rejects mapping conflicts and incomplete role separation', () => {
    const bridge = new DaemonTaskControlBridge({ approvals: { get: () => undefined }, approvalKeys: new Map() });
    expect(bridge.registerMapping('om_root', { ...mapping(), reviewerId: 'worker-1' }, 'controller-1')).toBe(false);
    expect(bridge.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
    expect(bridge.registerMapping('om_root', { ...mapping(), phaseId: 'other' }, 'controller-1')).toBe(false);
  });

  it('takes approval material from the daemon source and retains exact signed binding', () => {
    const proof = signTaskControlApproval(key, {
      keyId: 'key-1', approvalRef: 'approval:gate-1', projectId: 'project-1', phaseId: 'phase-1',
      taskSetSnapshot: ['task-1'], acceptorId: 'acceptor-1',
      approvedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
    });
    const bridge = new DaemonTaskControlBridge({
      approvals: { get: ref => ref === proof.approvalRef ? proof : undefined },
      approvalKeys: new Map([['key-1', key]]),
    });
    expect(bridge.approval('approval:gate-1')).toEqual(proof);
    expect(bridge.approval('approval:other')).toBeUndefined();
  });
});
