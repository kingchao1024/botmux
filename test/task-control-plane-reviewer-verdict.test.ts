import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDaemonReviewerVerdictVerifier,
  deriveDaemonDesignatedReviewerProvider,
  deriveDaemonReviewerVerdictProvider,
  reviewerDesignationRef,
  reviewerVerdictKeyId,
  reviewerMessageSourceFromLarkDetail,
  DaemonReviewerVerdictProvider,
} from '../src/services/task-control-plane-reviewer-verdict.js';
import { TaskControlPlaneStore } from '../src/services/task-control-plane-store.js';

const key = Buffer.from('reviewer-verdict-test-key');
const now = Date.parse('2026-09-05T00:30:00.000Z');

function provider() { return new DaemonReviewerVerdictProvider({ key, keyId: 'reviewer-key-1', now: () => now }); }
function authority() {
  const token = {};
  return { token, authority: {
    authenticate: (value: unknown) => value === token ? { actorId: 'controller-1', actorRole: 'controller' as const } : undefined,
    verifyApproval: () => undefined,
  } };
}
function reviewerAuthority() {
  const token = {};
  return { token, authority: {
    authenticate: (value: unknown) => value === token ? { actorId: 'reviewer-1', actorRole: 'reviewer' as const } : undefined,
    verifyApproval: () => undefined,
  } };
}
function dualAuthority(controllerToken: object, reviewerToken: object) {
  return {
    authenticate: (value: unknown) => value === controllerToken
      ? { actorId: 'controller-1', actorRole: 'controller' as const }
      : value === reviewerToken ? { actorId: 'reviewer-1', actorRole: 'reviewer' as const } : undefined,
    verifyApproval: () => undefined,
  };
}
function mapping(p: DaemonReviewerVerdictProvider) {
  return p.issueDesignatedReviewer({
    projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
    reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'controller-app',
    effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
  });
}
function appTwoMapping(p: DaemonReviewerVerdictProvider) {
  return p.issueDesignatedReviewer({
    designatedReviewerRef: 'designation-shared',
    projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
    reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'controller-app-2',
    effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
  });
}
function verdict(p: DaemonReviewerVerdictProvider, designatedReviewerRef: string, extra: Record<string, unknown> = {}) {
  return p.issueVerdict({
    projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
    designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'session-1', workerGeneration: 7, capability: 'cap-1',
    sourceCommentId: 'comment-1', kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
    sourceVersionHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    docToken: 'doc-1', docRevision: 3, expiresAt: '2026-09-05T01:00:00.000Z', ...extra,
  } as any);
}

describe('ReviewerVerdict provider journal', () => {
  it('uses domain-separated app-scoped roots and rejects cross-app or cross-domain signatures', () => {
    const hostSecret = 'host-only-root';
    const reviewerA = deriveDaemonReviewerVerdictProvider({ hostSecret, reviewerBotAppId: 'reviewer-app-a', now: () => now });
    const reviewerB = deriveDaemonReviewerVerdictProvider({ hostSecret, reviewerBotAppId: 'reviewer-app-b', now: () => now });
    const controller = deriveDaemonDesignatedReviewerProvider({ hostSecret, controllerBotAppId: 'controller-app', now: () => now });
    const designation = controller.issueDesignatedReviewer({
      designatedReviewerRef: reviewerDesignationRef('om_root', 'reviewer-app-a', 1),
      projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
      reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app-a', controllerId: 'daemon:controller-app', controllerBotAppId: 'controller-app',
      effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
    });
    const verdictA = reviewerA.issueVerdict({
      verdictId: 'app-scoped-verdict', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
      designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app-a', sessionId: 'session-1', workerGeneration: 1, capability: 'cap',
      sourceMessageId: 'om_review', sourceVersionHash: `sha256:${'a'.repeat(64)}`, kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
      docToken: 'doc-1', docRevision: 1, expiresAt: '2099-09-05T00:00:00.000Z',
    });
    const verifier = createDaemonReviewerVerdictVerifier({ hostSecret, controllerBotAppId: 'controller-app' });
    expect(verdictA.keyId).toBe(reviewerVerdictKeyId('reviewer-app-a', hostSecret));
    expect(verdictA.keyId).toMatch(/^rv1:[a-f0-9]{64}$/);
    expect(verifier.verifyDesignatedReviewer(designation)).toBe(true);
    expect(verifier.verifyVerdict(verdictA)).toBe(true);
    expect(reviewerB.verifyVerdict(verdictA)).toBe(false);
    expect(reviewerA.verifyDesignatedReviewer(designation)).toBe(false);
    expect(verifier.verifyVerdict({ ...verdictA, keyId: reviewerVerdictKeyId('reviewer-app-b', hostSecret) })).toBe(false);
    expect(verifier.verifyVerdict({ ...verdictA, keyId: '' })).toBe(false);
  });

  it('verifies only current or explicit previous reviewer roots and honors revoke', () => {
    const old = deriveDaemonReviewerVerdictProvider({ hostSecret: 'old-reviewer-root', reviewerBotAppId: 'reviewer-app', now: () => now });
    const controller = deriveDaemonDesignatedReviewerProvider({ hostSecret: 'old-reviewer-root', controllerBotAppId: 'controller-app', now: () => now });
    const designation = controller.issueDesignatedReviewer({
      designatedReviewerRef: reviewerDesignationRef('om_root', 'reviewer-app', 1), projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-app', controllerBotAppId: 'controller-app', effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
    });
    const verdict = old.issueVerdict({
      verdictId: 'old-root-verdict', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'session-1', workerGeneration: 1, capability: 'cap', sourceMessageId: 'om_review', sourceVersionHash: `sha256:${'a'.repeat(64)}`, kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-1', docRevision: 1, expiresAt: '2099-09-05T00:00:00.000Z',
    });
    const overlap = createDaemonReviewerVerdictVerifier({ hostSecret: 'new-reviewer-root', previousHostSecret: 'old-reviewer-root', controllerBotAppId: 'controller-app' });
    expect(overlap.verifyVerdict(verdict)).toBe(true);
    expect(overlap.verifyDesignatedReviewer(designation)).toBe(true);
    const revoked = createDaemonReviewerVerdictVerifier({ hostSecret: 'new-reviewer-root', previousHostSecret: 'old-reviewer-root', controllerBotAppId: 'controller-app', revokedKeyIds: [verdict.keyId, designation.keyId] });
    expect(revoked.verifyVerdict(verdict)).toBe(false);
    expect(revoked.verifyDesignatedReviewer(designation)).toBe(false);
  });

  it('requires a current exact message id, topic root, sender and created time; body is irrelevant', () => {
    const detail = { items: [{
      message_id: 'om_review', root_id: 'om_root', create_time: '2026-09-05T18:00:00.000Z',
      sender: { id: 'reviewer-1' }, body: { content: 'untrusted body' },
    }] };
    expect(reviewerMessageSourceFromLarkDetail({
      detail, expectedMessageId: 'om_review', expectedTopicRootId: 'om_root', expectedReviewerId: 'reviewer-1',
    })).toMatchObject({ sourceMessageId: 'om_review' });
    expect(reviewerMessageSourceFromLarkDetail({
      detail: { ...detail, items: [{ ...detail.items[0], root_id: 'om_other' }] },
      expectedMessageId: 'om_review', expectedTopicRootId: 'om_root', expectedReviewerId: 'reviewer-1',
    })).toBeUndefined();
    expect(reviewerMessageSourceFromLarkDetail({
      detail: { ...detail, items: [{ ...detail.items[0], sender: { id: 'forged' } }] },
      expectedMessageId: 'om_review', expectedTopicRootId: 'om_root', expectedReviewerId: 'reviewer-1',
    })).toBeUndefined();
  });

  it('accepts only the designated, attested reviewer and replays same canonical verdict idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reviewer-verdict-'));
    try {
      const p = provider(); const { token, authority: auth } = authority();
      const store = await TaskControlPlaneStore.open(dir, auth, 'controller-app');
      store.setReviewerVerdictVerifier(p);
      const designation = mapping(p);
      store.appendDesignatedReviewer(designation, token, value => p.verifyDesignatedReviewer(value));
      const record = verdict(p, designation.designatedReviewerRef);
      const attestation = { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'session-1', workerGeneration: 7, capability: 'cap-1' };
      const { token: reviewerToken, authority: reviewerAuth } = reviewerAuthority();
      const reviewerStore = await TaskControlPlaneStore.open(dir, reviewerAuth, 'controller-app');
      reviewerStore.setReviewerVerdictVerifier(p);
      expect(reviewerStore.appendReviewerVerdict({ verdict: record, attestation, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() })).toMatchObject({ status: 'active', verdict: { verdictId: record.verdictId } });
      expect(reviewerStore.appendReviewerVerdict({ verdict: record, attestation, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() })).toMatchObject({ status: 'active' });
      expect(reviewerStore.appendReviewerVerdict({ verdict: record, attestation: { ...attestation, reviewerId: 'other' }, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() })).toMatchObject({ status: 'unknown' });
      reviewerStore.close();
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails closed on same id different payload, fork, missing target and revoked head', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reviewer-verdict-'));
    try {
      const p = provider(); const { token, authority: auth } = authority();
      const store = await TaskControlPlaneStore.open(dir, auth, 'controller-app');
      store.setReviewerVerdictVerifier(p);
      const designation = mapping(p); store.appendDesignatedReviewer(designation, token, value => p.verifyDesignatedReviewer(value));
      const attestation = { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'session-1', workerGeneration: 7, capability: 'cap-1' };
      const { token: reviewerToken, authority: reviewerAuth } = reviewerAuthority();
      const reviewerStore = await TaskControlPlaneStore.open(dir, reviewerAuth, 'controller-app');
      reviewerStore.setReviewerVerdictVerifier(p);
      const first = verdict(p, designation.designatedReviewerRef, { verdictId: 'verdict-1' });
      reviewerStore.appendReviewerVerdict({ verdict: first, attestation, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() });
      const conflict = verdict(p, designation.designatedReviewerRef, { verdictId: 'verdict-1', verdict: 'fail', sourceCommentId: 'comment-2' });
      expect(reviewerStore.appendReviewerVerdict({ verdict: conflict, attestation, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() })).toMatchObject({ status: 'unknown', reason: 'reviewer_verdict_id_conflict' });
      const forkA = verdict(p, designation.designatedReviewerRef, { verdictId: 'verdict-2a', sourceCommentId: 'comment-2', supersedesVerdictId: 'verdict-1' });
      const forkB = verdict(p, designation.designatedReviewerRef, { verdictId: 'verdict-2b', sourceCommentId: 'comment-3', supersedesVerdictId: 'verdict-1' });
      reviewerStore.appendReviewerVerdict({ verdict: forkA, attestation, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() });
      expect(reviewerStore.appendReviewerVerdict({ verdict: forkB, attestation, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() })).toMatchObject({ status: 'unknown' });
      reviewerStore.close();
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists one immutable canonical-hash conflict observation across replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reviewer-verdict-conflict-'));
    try {
      const p = provider(); const controllerToken = {}; const reviewerToken = {};
      const store = await TaskControlPlaneStore.open(dir, dualAuthority(controllerToken, reviewerToken), 'controller-app');
      store.setReviewerVerdictVerifier(p);
      const designation = mapping(p); store.appendDesignatedReviewer(designation, controllerToken, value => p.verifyDesignatedReviewer(value));
      const attestation = { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'session-1', workerGeneration: 7, capability: 'cap-1' };
      const original = verdict(p, designation.designatedReviewerRef, { verdictId: 'conflict-verdict' });
      store.appendReviewerVerdict({ verdict: original, attestation, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() });
      const conflicting = verdict(p, designation.designatedReviewerRef, { verdictId: 'conflict-verdict', verdict: 'fail', sourceCommentId: 'comment-conflict' });
      expect(store.appendReviewerVerdict({ verdict: conflicting, attestation, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() }))
        .toMatchObject({ status: 'unknown', reason: 'reviewer_verdict_id_conflict' });
      expect(store.appendReviewerVerdict({ verdict: conflicting, attestation, authentication: reviewerToken, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() }))
        .toMatchObject({ status: 'unknown', reason: 'reviewer_verdict_id_conflict' });
      const conflicts = store.listObservations().filter(observation => observation.outcome === 'conflict');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        attemptedEventType: 'task.reviewed',
        payload: expect.objectContaining({
          conflictKind: 'reviewer_verdict_id_canonical_hash', verdictId: 'conflict-verdict',
          existingCanonicalHash: expect.stringMatching(/^sha256:/), incomingCanonicalHash: expect.stringMatching(/^sha256:/),
          existingSourceRef: 'task-comment:comment-1', incomingSourceRef: 'task-comment:comment-conflict',
        }),
      });
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('isolates shared designation and verdict ids by lark app id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reviewer-verdict-app-scope-'));
    try {
      const p = provider();
      const controllerOne = {}; const reviewerOne = {};
      const controllerTwo = {}; const reviewerTwo = {};
      const authOne = dualAuthority(controllerOne, reviewerOne);
      const authTwo = dualAuthority(controllerTwo, reviewerTwo);
      const appOne = await TaskControlPlaneStore.open(dir, authOne, 'controller-app');
      const appTwo = await TaskControlPlaneStore.open(dir, authTwo, 'controller-app-2');
      appOne.setReviewerVerdictVerifier(p); appTwo.setReviewerVerdictVerifier(p);
      const oneDesignation = mapping(p);
      const twoDesignation = appTwoMapping(p);
      appOne.appendDesignatedReviewer(oneDesignation, controllerOne, value => p.verifyDesignatedReviewer(value));
      appTwo.appendDesignatedReviewer(twoDesignation, controllerTwo, value => p.verifyDesignatedReviewer(value));
      const attestation = { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'session-1', workerGeneration: 7, capability: 'cap-1' };
      const appOneVerdict = verdict(p, oneDesignation.designatedReviewerRef, { verdictId: 'shared-verdict', sourceCommentId: 'comment-app-one' });
      const appTwoVerdict = verdict(p, twoDesignation.designatedReviewerRef, { verdictId: 'shared-verdict', sourceCommentId: 'comment-app-two', verdict: 'fail' });
      expect(appOne.appendReviewerVerdict({ verdict: appOneVerdict, attestation, authentication: reviewerOne, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() }))
        .toMatchObject({ status: 'active', verdict: { verdictId: 'shared-verdict' } });
      expect(appTwo.appendReviewerVerdict({ verdict: appTwoVerdict, attestation, authentication: reviewerTwo, verifyVerdict: value => p.verifyVerdict(value), now: new Date(now).toISOString() }))
        .toMatchObject({ status: 'active', verdict: { verdictId: 'shared-verdict' } });
      expect(appOne.listObservations()).toEqual([]);
      expect(appTwo.listObservations()).toEqual([]);
      appOne.close(); appTwo.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
