import { describe, expect, it } from 'vitest';
import {
  DaemonTaskControlAuthority,
  signTaskControlApproval,
} from '../src/services/task-control-plane-authority.js';

const key = Buffer.from('task-control-approval-test-key');
const keyId = 'daemon-test-key';

function approval(overrides: Record<string, unknown> = {}) {
  return signTaskControlApproval(key, {
    keyId, approvalRef: 'approval:one', projectId: 'project-1', phaseId: 'phase-1',
    taskSetSnapshot: ['task-2', 'task-1'], acceptorId: 'acceptor-1',
    approvedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
    ...overrides,
  } as any);
}

function verifier(
  live = new Map([['session-1:generation-7', { actorId: 'ou_verified', actorRole: 'reviewer' as const }]]),
) {
  return new DaemonTaskControlAuthority({
    resolvePrincipal: id => live.get(id),
    approvalKeys: new Map([[keyId, key]]),
  });
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

  it('binds signed approval to domain, normalized task snapshot, acceptor and lifetime without consuming it', () => {
    const authority = verifier();
    const proof = approval();
    const base = {
      approval: proof, projectId: 'project-1', phaseId: 'phase-1',
      taskSetSnapshot: ['task-1', 'task-2'], acceptorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z',
    };
    expect(authority.verifyApproval(base)).toMatchObject({ approvalRef: 'approval:one', taskSetSnapshot: ['task-1', 'task-2'] });
    expect(authority.verifyApproval(base)).toMatchObject({ approvalRef: 'approval:one' });
  });

  it('fails closed for forged, wrong-domain, expired, future and mismatched proofs', () => {
    const attempts = [
      { proof: { ...approval(), signature: '0'.repeat(64) }, patch: {} },
      { proof: approval({ approvalRef: 'approval:project', projectId: 'other-project' }), patch: {} },
      { proof: approval({ approvalRef: 'approval:phase', phaseId: 'other-phase' }), patch: {} },
      { proof: approval({ approvalRef: 'approval:tasks', taskSetSnapshot: ['task-1'] }), patch: {} },
      { proof: approval({ approvalRef: 'approval:acceptor', acceptorId: 'other-acceptor' }), patch: {} },
      { proof: approval({ approvalRef: 'approval:expired', expiresAt: '2026-09-05T00:01:00.000Z' }), patch: {} },
      { proof: approval({ approvalRef: 'approval:future', approvedAt: '2026-09-05T00:45:00.000Z' }), patch: {} },
    ];
    for (const attempt of attempts) {
      const authority = verifier();
      expect(authority.verifyApproval({
        approval: attempt.proof, projectId: 'project-1', phaseId: 'phase-1',
        taskSetSnapshot: ['task-1', 'task-2'], acceptorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z',
        ...attempt.patch,
      })).toBeUndefined();
    }
  });
});
