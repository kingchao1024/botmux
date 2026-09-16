import { describe, expect, it } from 'vitest';
import { DaemonTaskControlAuthority } from '../src/services/task-control-plane-authority.js';

function source(overrides: Record<string, unknown> = {}) {
  return {
    approvalRef: 'approval:gate-1', projectId: 'project-1', phaseId: 'phase-1',
    taskSetSnapshot: ['task-2', 'task-1'], acceptorId: 'acceptor-1',
    approvedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
    runId: 'run-1', nodeId: 'gate-node', instanceId: 'gate-node#001', waitId: 'gate-node#001-gate',
    operatorId: 'acceptor-1', ...overrides,
  };
}

function verifier(
  live = new Map([['session-1:generation-7', { actorId: 'ou_verified', actorRole: 'reviewer' as const }]]),
) {
  return new DaemonTaskControlAuthority({ resolvePrincipal: id => live.get(id) });
}

describe('DaemonTaskControlAuthority', () => {
  it('does not accept caller supplied actor or role and revokes stale session generations', () => {
    const live = new Map([['session-1:generation-7', { actorId: 'ou_verified', actorRole: 'reviewer' as const }]]);
    const authority = verifier(live);
    const authentication = authority.issueAuthentication('session-1:generation-7');
    expect(authority.authenticate(authentication)).toEqual({ actorId: 'ou_verified', actorRole: 'reviewer' });
    expect(authority.authenticate({ actorId: 'forged', actorRole: 'acceptor' })).toBeUndefined();
    expect(authority.issueAuthentication('session-1:generation-6')).toBeUndefined();
    live.clear();
    expect(authority.authenticate(authentication)).toBeUndefined();
  });

  it('binds a daemon-minted gate handle to domain, normalized task snapshot, acceptor and lifetime', () => {
    const authority = verifier();
    const proof = authority.issueVerifiedGateApproval(source());
    const base = {
      approval: proof, projectId: 'project-1', phaseId: 'phase-1',
      taskSetSnapshot: ['task-1', 'task-2'], acceptorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z',
    };
    expect(authority.verifyApproval(base)).toMatchObject({ approvalRef: 'approval:gate-1', taskSetSnapshot: ['task-1', 'task-2'] });
    expect(authority.verifyApproval(base)).toMatchObject({ approvalRef: 'approval:gate-1' });
  });

  it('fails closed for caller JSON, wrong domain, expired, future and mismatched gate sources', () => {
    const authority = verifier();
    expect(authority.verifyApproval({
      approval: source(), projectId: 'project-1', phaseId: 'phase-1', taskSetSnapshot: ['task-1', 'task-2'],
      acceptorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z',
    })).toBeUndefined();
    for (const override of [
      { projectId: 'other-project' }, { phaseId: 'other-phase' }, { taskSetSnapshot: ['task-1'] },
      { acceptorId: 'other-acceptor' }, { expiresAt: '2026-09-05T00:01:00.000Z' },
      { approvedAt: '2026-09-05T00:45:00.000Z' },
    ]) {
      const proof = authority.issueVerifiedGateApproval(source(override));
      expect(authority.verifyApproval({
        approval: proof, projectId: 'project-1', phaseId: 'phase-1', taskSetSnapshot: ['task-1', 'task-2'],
        acceptorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z',
      })).toBeUndefined();
    }
  });

  it('binds an opaque write grant to every execution fact and expiry', () => {
    const authority = verifier();
    const grant = authority.issueVerifiedWriteExecutionGrant({
      grantRef: 'grant:write-1', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', candidate: '3928820',
      action: 'git.commit', attempt: 2, operatorId: 'acceptor-1', issuedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
    });
    const exact = { grant, projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', candidate: '3928820', action: 'git.commit', attempt: 2, operatorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z' };
    expect(authority.verifyWriteExecutionGrant(exact)).toMatchObject({ grantRef: 'grant:write-1' });
    for (const changed of [
      { projectId: 'other-project' }, { phaseId: 'other-phase' }, { taskGuid: 'other-task' }, { candidate: 'other-candidate' },
      { action: 'deploy' }, { attempt: 3 }, { operatorId: 'other-operator' }, { now: '2026-09-05T01:00:00.000Z' },
    ]) expect(authority.verifyWriteExecutionGrant({ ...exact, ...changed })).toBeUndefined();
    expect(authority.verifyWriteExecutionGrant({ ...exact, grant: { ...exact } })).toBeUndefined();
  });
});
