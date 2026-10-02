import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonTaskControlAuthority } from '../src/services/task-control-plane-authority.js';
import { TaskControlPlaneStore } from '../src/services/task-control-plane-store.js';
import {
  ProjectWorkerEvidenceRelay,
  ProjectWorkerEvidenceTrust,
  isProjectWorkerEvidenceLiveTurn,
  projectWorkerEvidenceAttemptedEventType,
  projectWorkerEvidenceKindForReport,
  projectWorkerEvidenceId,
  type ProjectWorkerEvidenceFactsV1,
} from '../src/services/task-control-plane-project-worker-evidence.js';
import { DaemonReviewerVerdictProvider, reviewerDesignationRef } from '../src/services/task-control-plane-reviewer-verdict.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const dirs: string[] = [];
const storeModuleUrl = new URL('../src/services/task-control-plane-store.ts', import.meta.url).href;
const authorityModuleUrl = new URL('../src/services/task-control-plane-authority.ts', import.meta.url).href;
const evidenceModuleUrl = new URL('../src/services/task-control-plane-project-worker-evidence.ts', import.meta.url).href;
const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

function collectChild(child: ReturnType<typeof spawnTsEvalWithRepoImports>): Promise<{ code: number | null; stderr: string }> {
  return new Promise(resolve => {
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('close', code => resolve({ code, stderr }));
  });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function facts(overrides: Partial<ProjectWorkerEvidenceFactsV1> = {}): ProjectWorkerEvidenceFactsV1 {
  return {
    schemaVersion: 'ProjectWorkerEvidence.v1',
    eventKind: 'execution_started',
    sourceAppId: 'cli_worker_1234567890123456',
    controllerAppId: 'cli_controller_1234567890123456',
    sourceSessionId: 'session-worker',
    sourceTurnId: 'turn-1',
    workerGeneration: 3,
    dispatchAttempt: 1,
    dispatchRoot: 'om_projectroot',
    occurredAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('project worker evidence', () => {
  it('passes the relay AbortSignal into the production daemon IPC request', () => {
    const start = daemonSource.indexOf('projectWorkerEvidenceRelay = new ProjectWorkerEvidenceRelay({');
    const end = daemonSource.indexOf('projectWorkerEvidenceRelay.start();', start);
    const wiring = daemonSource.slice(start, end);
    expect(wiring).toMatch(/deliver:\s*async \(evidence, signal\) =>/);
    expect(wiring).toMatch(/fetchDaemonIpc\([\s\S]*?PROJECT_WORKER_EVIDENCE_ROUTE[\s\S]*?\{[\s\S]*?signal,/);
  });

  it('passes the shared remaining shutdown budget into the production evidence relay close', () => {
    expect(daemonSource).toContain('await projectWorkerEvidenceRelay?.close(remainingBudget())');
  });

  it('selects failed-report evidence for a structured worker failure regardless of project CAS result', () => {
    expect(projectWorkerEvidenceKindForReport({ projectSynced: true })).toBe('submitted');
    expect(projectWorkerEvidenceKindForReport({ projectSynced: true, reviewVerdict: 'pass' })).toBe('reviewed');
    expect(projectWorkerEvidenceKindForReport({ projectSynced: false })).toBe('project_sync_failed');
    expect(projectWorkerEvidenceKindForReport({ projectSynced: true, projectStatus: 'failed' })).toBe('failed_report');
    expect(projectWorkerEvidenceKindForReport({ projectSynced: false, projectStatus: 'failed' })).toBe('failed_report');
  });

  it('classifies reviewer project-sync overflow as a review attempt', () => {
    expect(projectWorkerEvidenceAttemptedEventType({
      eventKind: 'project_sync_failed', reviewVerdict: 'pass',
    })).toBe('task.reviewed');
    expect(projectWorkerEvidenceAttemptedEventType({ eventKind: 'project_sync_failed' }))
      .toBe('task.first_submitted');
  });

  it('requires the exact live turn, attempt, and worker generation before signing evidence', () => {
    const live = {
      liveTurnId: 'turn-1', liveDispatchAttempt: 2, liveWorkerGeneration: 7,
      persistedWorkerGeneration: 7, sourceTurnId: 'turn-1', dispatchAttempt: 2, workerGeneration: 7,
    };
    expect(isProjectWorkerEvidenceLiveTurn(live)).toBe(true);
    expect(isProjectWorkerEvidenceLiveTurn({ ...live, sourceTurnId: 'turn-old' })).toBe(false);
    expect(isProjectWorkerEvidenceLiveTurn({ ...live, dispatchAttempt: 1 })).toBe(false);
    expect(isProjectWorkerEvidenceLiveTurn({ ...live, workerGeneration: 6 })).toBe(false);
    expect(isProjectWorkerEvidenceLiveTurn({ ...live, persistedWorkerGeneration: 6 })).toBe(false);
  });

  it('normalizes an ordinary dispatched IM turn to its first evidence attempt', () => {
    const ordinary = {
      liveTurnId: 'om_dispatch_message', liveDispatchAttempt: undefined, liveWorkerGeneration: 3,
      persistedWorkerGeneration: 3, sourceTurnId: 'om_dispatch_message', dispatchAttempt: 1, workerGeneration: 3,
    };

    expect(isProjectWorkerEvidenceLiveTurn(ordinary)).toBe(true);
    expect(isProjectWorkerEvidenceLiveTurn({ ...ordinary, dispatchAttempt: 2 })).toBe(false);
  });

  it('signs one exact app-scoped lifecycle fact and rejects tampering or cross-app replay', () => {
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const evidence = trust.issue(facts());

    expect(trust.verify(evidence)).toBe(true);
    expect(evidence).toMatchObject({
      evidenceId: projectWorkerEvidenceId(facts()),
      keyId: expect.stringMatching(/^tcpe1:/),
      signature: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(trust.verify({ ...evidence, dispatchAttempt: 2 })).toBe(false);
    expect(new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: 'cli_other_1234567890123456' })
      .verify(evidence)).toBe(false);
  });

  it('honors explicit allow and revoke sets across current and previous evidence keys', () => {
    const overlap = new ProjectWorkerEvidenceTrust({
      hostSecret: 'current-secret', previousHostSecret: 'previous-secret', sourceAppId: facts().sourceAppId,
    });
    const previous = new ProjectWorkerEvidenceTrust({
      hostSecret: 'previous-secret', sourceAppId: facts().sourceAppId,
    });
    const evidence = previous.issue(facts());
    expect(overlap.verify(evidence, { allowedKeyIds: [overlap.keyId, overlap.previousKeyId!] })).toBe(true);
    expect(overlap.verify(evidence, {
      allowedKeyIds: [overlap.keyId, overlap.previousKeyId!], revokedKeyIds: [overlap.previousKeyId!],
    })).toBe(false);
    expect(overlap.verify(evidence, { allowedKeyIds: [overlap.keyId] })).toBe(false);
  });

  it('requires a complete report receipt for submitted and reviewed evidence', () => {
    const artifactEvidence = {
      kind: 'project_report' as const, reportRequestId: 'report:abc', triggerId: 'trg_abc',
      dispatchRoot: 'om_projectroot', sourceSessionId: 'session-worker', sourceTurnId: 'turn-1',
      reporterAppId: 'cli_review_1234567890123456', targetSessionId: 'session-controller',
      projectRevision: 8, contentHash: `sha256:${'a'.repeat(64)}`,
    };
    const reviewerProvider = new DaemonReviewerVerdictProvider({ key: 'review-key', keyId: 'rv1:review' });
    const reviewerVerdict = reviewerProvider.issueVerdict({
      verdictId: 'rv_project', projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
      taskGuid: 'task-project', topicRootId: 'om_projectroot', taskSetSnapshot: ['task-project'], reviewRound: 1,
      designatedReviewerRef: reviewerDesignationRef('om_projectroot', 'cli_review_1234567890123456', 1, 3),
      reviewerId: 'cli_review_1234567890123456', reviewerBotAppId: 'cli_review_1234567890123456',
      sessionId: 'session-worker', workerGeneration: 3, capability: 'review-capability',
      sourceMessageId: 'trg_abc', sourceVersionHash: artifactEvidence.contentHash,
      kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, artifactEvidence,
      issuedAt: '2026-09-29T00:00:00.000Z', expiresAt: '2099-09-29T00:00:00.000Z',
    });
    const reviewerFacts = facts({
      eventKind: 'reviewed',
      sourceAppId: 'cli_review_1234567890123456',
      reportRequestId: 'report:abc', triggerId: 'trg_abc', targetSessionId: 'session-controller',
      contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 8, reviewVerdict: 'pass', reviewRound: 1,
      reviewerVerdict,
    });
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerFacts.sourceAppId });
    const evidence = trust.issue(reviewerFacts);
    expect(trust.verify(evidence)).toBe(true);
    expect(evidence.keyId).toMatch(/^tcper1:/);
    expect(evidence.keyId).not.toBe(trust.keyId);
    expect(trust.verify(evidence, { allowedKeyIds: [trust.reviewerKeyId] })).toBe(true);
    expect(trust.verify(evidence, { revokedKeyIds: [trust.reviewerKeyId] })).toBe(false);
    expect(trust.verify({ ...evidence, eventKind: 'submitted', reviewVerdict: undefined, reviewRound: undefined })).toBe(false);
    expect(() => trust.issue({ ...reviewerFacts, reviewRound: undefined }))
      .toThrow('task_control_project_worker_evidence_invalid');
  });

  it('signs a trigger-accepted project sync failure without inventing a project revision', () => {
    const failed = facts({
      eventKind: 'project_sync_failed', reportRequestId: 'report:abc', triggerId: 'trg_abc',
      targetSessionId: 'session-controller', contentHash: `sha256:${'b'.repeat(64)}`,
      projectSyncError: 'project_revision_conflict',
    });
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: failed.sourceAppId });
    expect(trust.verify(trust.issue(failed))).toBe(true);
    expect(() => trust.issue({ ...failed, projectSyncError: undefined }))
      .toThrow('task_control_project_worker_evidence_invalid');
  });

  it('signs a failed report as a task failure only after project sync succeeds', () => {
    const synced = facts({
      eventKind: 'failed_report', reportRequestId: 'report:failed', triggerId: 'trg_failed',
      targetSessionId: 'session-controller', contentHash: `sha256:${'c'.repeat(64)}`, projectRevision: 9,
    });
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: synced.sourceAppId });
    const evidence = trust.issue(synced);
    expect(trust.verify(evidence)).toBe(true);
    expect(trust.verify({ ...evidence, projectRevision: 10 })).toBe(false);
    expect(trust.verify({ ...evidence, extra: true } as any)).toBe(false);
    expect(projectWorkerEvidenceAttemptedEventType(synced)).toBe('task.failed');

    const unsynced = {
      ...synced, projectRevision: undefined, projectSyncError: 'project_revision_conflict',
    };
    expect(trust.verify(trust.issue(unsynced))).toBe(true);
    expect(() => trust.issue({ ...unsynced, projectRevision: 9 }))
      .toThrow('task_control_project_worker_evidence_invalid');
    expect(() => trust.issue({ ...synced, projectRevision: undefined }))
      .toThrow('task_control_project_worker_evidence_invalid');
    expect(() => trust.issue({ ...synced, reviewVerdict: 'fail', reviewRound: 1 }))
      .toThrow('task_control_project_worker_evidence_invalid');
    expect(() => trust.issue({ ...synced, reviewerVerdict: {} as any }))
      .toThrow('task_control_project_worker_evidence_invalid');
  });

  it('persists one immutable evidence row with a recoverable delivery claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const evidence = trust.issue(facts());

    expect(store.enqueueProjectWorkerEvidence(evidence, value => trust.verify(value))).toMatchObject({ kind: 'appended' });
    expect(store.enqueueProjectWorkerEvidence(structuredClone(evidence), value => trust.verify(value))).toMatchObject({ kind: 'duplicate' });
    expect(() => store.enqueueProjectWorkerEvidence({ ...evidence, occurredAt: '2026-09-29T00:00:01.000Z' }, () => true))
      .toThrow('task_control_project_evidence_conflict');

    const claimAt = Date.parse(evidence.occurredAt);
    const claim = store.claimProjectWorkerEvidence({ now: claimAt, claimToken: 'claim-1', staleClaimMs: 1_000 });
    expect(claim).toMatchObject({ evidenceId: evidence.evidenceId, status: 'inflight', claimToken: 'claim-1' });
    expect(store.claimProjectWorkerEvidence({ now: claimAt, claimToken: 'claim-2', staleClaimMs: 1_000 })).toBeUndefined();
    store.settleProjectWorkerEvidenceDelivered(claim!.outboxId, 'claim-1', 'controller-receipt-1', claimAt + 1);
    expect(store.listProjectWorkerEvidenceOutbox()).toEqual([
      expect.objectContaining({ evidenceId: evidence.evidenceId, status: 'delivered', receiptRef: 'controller-receipt-1' }),
    ]);
    store.close();

    const restored = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    expect(restored.listProjectWorkerEvidence()).toEqual([evidence]);
    expect(restored.claimProjectWorkerEvidence({ now: claimAt + 10, claimToken: 'claim-3', staleClaimMs: 1_000 })).toBeUndefined();
    restored.close();
  });

  it('retries a failed controller handoff without minting a second evidence record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-relay-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    let attempts = 0;
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, now: () => Date.parse('2026-09-29T00:00:00.000Z'),
      deliver: async evidence => {
        attempts += 1;
        if (attempts === 1) throw new Error('controller offline');
        return `receipt:${evidence.evidenceId}`;
      },
    });

    const evidence = relay.capture(facts());
    await relay.flushOnce();
    expect(store.listProjectWorkerEvidence()).toEqual([evidence]);
    expect(store.listProjectWorkerEvidenceOutbox()).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 1, lastError: 'controller offline' }),
    ]);
    await relay.flushOnce(Date.parse('2026-09-29T00:00:01.000Z'));
    expect(store.listProjectWorkerEvidence()).toHaveLength(1);
    expect(store.listProjectWorkerEvidenceOutbox()).toEqual([
      expect.objectContaining({ status: 'delivered', attempts: 2, receiptRef: `receipt:${evidence.evidenceId}` }),
    ]);
    store.close();
  });

  it('clears settled flush state so the real timer retries a pending delivery at nextAttemptAt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-timer-retry-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const retryAt = Date.parse('2026-09-29T00:00:01.000Z');
    let now = retryAt - 1_000;
    let attempts = 0;
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, now: () => now,
      deliver: async evidence => {
        attempts += 1;
        if (attempts === 1) throw new Error('controller offline');
        return `receipt:${evidence.evidenceId}`;
      },
    });
    relay.capture(facts());
    try {
      await relay.flushOnce();
      expect(attempts).toBe(1);
      expect(store.listProjectWorkerEvidenceOutbox()).toMatchObject([
        { status: 'pending', attempts: 1, nextAttemptAt: retryAt },
      ]);

      now = retryAt;
      relay.start(5);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(attempts).toBe(2);
      expect(store.listProjectWorkerEvidenceOutbox()).toMatchObject([
        { status: 'delivered', attempts: 2 },
      ]);
    } finally {
      await relay.close(50);
      store.close();
    }
  });

  it('clears a settled empty flush so close() without a budget returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-empty-close-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust,
      deliver: async evidence => `receipt:${evidence.evidenceId}`,
    });

    await relay.flushOnce();
    const runningAfterSettledFlush = (relay as unknown as { running?: Promise<void> }).running !== undefined;
    const closeResult = runningAfterSettledFlush
      ? undefined
      : await relay.close();
    store.close();

    expect(runningAfterSettledFlush).toBe(false);
    expect(closeResult).toEqual({ quiesced: 0, pending: 0, inflight: 0 });
  });

  it('bounds the pending backlog and reports overflow without abandoning retained retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-overflow-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    let overflows = 0;
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, maxPending: 1, now: () => Date.parse('2026-09-29T00:00:00.000Z'),
      deliver: async () => { throw new Error('controller offline'); },
      onOverflow: () => { overflows += 1; },
    });
    relay.capture(facts());
    expect(() => relay.capture(facts({ sourceTurnId: 'turn-2' })))
      .toThrow('task_control_project_evidence_backlog_full');
    expect(overflows).toBe(1);
    await relay.flushOnce();
    expect(store.listProjectWorkerEvidenceOutbox()).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 1, lastError: 'controller offline' }),
    ]);
    store.close();
  });

  it('captures the same logical evidence key idempotently and blocks changed semantics under the same key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-logical-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    let now = Date.parse('2026-09-29T00:00:00.000Z');
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, now: () => now,
      deliver: async () => { throw new Error('controller offline'); },
    });
    const original = relay.capture(facts({
      eventKind: 'submitted', reportRequestId: 'report:log-key-1', triggerId: 'trg-log-1',
      targetSessionId: 'session-controller', contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 5,
    }));
    now += 1_500;
    const retried = relay.capture(facts({
      eventKind: 'submitted', reportRequestId: 'report:log-key-1', triggerId: 'trg-log-1',
      targetSessionId: 'session-controller', contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 5,
      occurredAt: '2026-09-29T00:00:01.500Z',
    }));
    expect(retried.evidenceId).toBe(original.evidenceId);
    expect(retried.occurredAt).toBe(original.occurredAt);
    expect(retried.signature).toBe(original.signature);
    expect(store.listProjectWorkerEvidence()).toHaveLength(1);
    expect(() => relay.capture(facts({
      eventKind: 'submitted', reportRequestId: 'report:log-key-1', triggerId: 'trg-log-1',
      targetSessionId: 'session-controller', contentHash: `sha256:${'b'.repeat(64)}`, projectRevision: 5,
      occurredAt: '2026-09-29T00:00:02.000Z',
    }))).toThrow('task_control_project_evidence_logical_conflict');
    expect(store.listProjectWorkerEvidence()).toHaveLength(1);
    store.close();
  });

  it('atomically keeps one first logical evidence winner across two source processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-logical-race-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const initial = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    initial.close();
    const startAt = Date.now() + 2_000;
    const source = (occurredAt: string) => `
      import { TaskControlPlaneStore } from ${JSON.stringify(storeModuleUrl)};
      import { DaemonTaskControlAuthority } from ${JSON.stringify(authorityModuleUrl)};
      import { ProjectWorkerEvidenceRelay, ProjectWorkerEvidenceTrust } from ${JSON.stringify(evidenceModuleUrl)};
      const sourceAppId = 'cli_worker_1234567890123456';
      const store = await TaskControlPlaneStore.open(${JSON.stringify(dir)}, new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined }), sourceAppId);
      const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId });
      const relay = new ProjectWorkerEvidenceRelay({ store, trust, deliver: async () => 'unused' });
      while (Date.now() < ${startAt}) {}
      relay.capture({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'submitted', sourceAppId,
        controllerAppId: 'cli_controller_1234567890123456', sourceSessionId: 'session-worker',
        sourceTurnId: 'turn-1', workerGeneration: 3, dispatchAttempt: 1, dispatchRoot: 'om_projectroot',
        occurredAt: ${JSON.stringify(occurredAt)}, reportRequestId: 'report:race', triggerId: 'trg-race',
        targetSessionId: 'session-controller', contentHash: 'sha256:${'a'.repeat(64)}', projectRevision: 5,
      });
      store.close();
    `;
    const [left, right] = await Promise.all([
      collectChild(spawnTsEvalWithRepoImports(source('2026-09-29T00:00:00.000Z'))),
      collectChild(spawnTsEvalWithRepoImports(source('2026-09-29T00:00:01.000Z'))),
    ]);
    expect(left, left.stderr).toMatchObject({ code: 0 });
    expect(right, right.stderr).toMatchObject({ code: 0 });
    const verify = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const rows = verify.listProjectWorkerEvidence();
    expect(rows).toHaveLength(1);
    expect(['2026-09-29T00:00:00.000Z', '2026-09-29T00:00:01.000Z']).toContain(rows[0]!.occurredAt);
    verify.close();
  });

  it('claims evidence in per-lane FIFO order using SQLite rowid and blocks the same lane on a retry-backoff head while other lanes stay live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-fifo-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    // Two lifecycle events in one lane at the exact same occurredAt.
    const accepted = trust.issue(facts({ eventKind: 'accepted' }));
    const execution = trust.issue(facts({ eventKind: 'execution_started' }));
    expect(store.enqueueProjectWorkerEvidence(accepted, () => true).kind).toBe('appended');
    expect(store.enqueueProjectWorkerEvidence(execution, () => true).kind).toBe('appended');
    // One live lane on a different dispatch root — its claim must not be blocked by the retry
    // backoff on the first lane.
    const otherLane = trust.issue(facts({ dispatchRoot: 'om_projectrootother', sourceTurnId: 'other-turn' }));
    expect(store.enqueueProjectWorkerEvidence(otherLane, () => true).kind).toBe('appended');
    const now = Date.parse('2026-09-29T00:00:00.000Z');
    // Insertion order (accepted → execution → otherLane) is preserved even though the outbox_id
    // hash may sort differently, because claim ordering must use SQLite rowid.
    const claim1 = store.claimProjectWorkerEvidence({ now, claimToken: 'claim-1', staleClaimMs: 5_000 });
    expect(claim1?.evidenceId).toBe(accepted.evidenceId);
    // Retry backoff on the head (accepted) with a delayed next_attempt_at.
    store.settleProjectWorkerEvidenceRetry(claim1!.outboxId, 'claim-1', 'controller_offline', now + 5_000, now);
    // Same-lane head-of-line: the tail (execution_started) must NOT jump ahead within its lane.
    const claim2 = store.claimProjectWorkerEvidence({ now: now + 10, claimToken: 'claim-2', staleClaimMs: 5_000 });
    expect(claim2?.evidenceId).toBe(otherLane.evidenceId);
    // No further active lane at this point: only the retry-parked head plus the just-inflight
    // other-lane row remain.
    const claim3 = store.claimProjectWorkerEvidence({ now: now + 20, claimToken: 'claim-3', staleClaimMs: 5_000 });
    expect(claim3).toBeUndefined();
    // Once the head's retry window elapses, only then may that lane's head progress; the tail
    // still waits until the head is delivered.
    const claim4 = store.claimProjectWorkerEvidence({ now: now + 6_000, claimToken: 'claim-4', staleClaimMs: 5_000 });
    expect(claim4?.evidenceId).toBe(accepted.evidenceId);
    store.close();
  });

  it('aborts an in-flight provider call after the deadline and resets the claim for retry without a duplicate delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-abort-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const now = Date.parse('2026-09-29T00:00:00.000Z');
    const observedSignals: AbortSignal[] = [];
    let deliverResolve: ((value: string) => void) | undefined;
    let deliverReject: ((error: Error) => void) | undefined;
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, now: () => now, deliveryDeadlineMs: 25,
      deliver: async (_evidence, signal) => new Promise<string>((resolve, reject) => {
        observedSignals.push(signal);
        deliverResolve = resolve; deliverReject = reject;
        signal.addEventListener('abort', () => { reject(new Error(String(signal.reason?.message ?? 'aborted'))); });
      }),
    });
    relay.capture(facts({ eventKind: 'execution_started' }));
    await relay.flushOnce();
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0].aborted).toBe(true);
    expect(String(observedSignals[0].reason)).toContain('task_control_project_evidence_deadline');
    expect(store.listProjectWorkerEvidenceOutbox()).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 1, lastError: expect.stringMatching(/deadline/) }),
    ]);
    // A late resolve from the aborted call must not settle the released claim as delivered.
    deliverResolve?.('late-receipt');
    deliverReject?.(new Error('unused'));
    expect(store.listProjectWorkerEvidenceOutbox()).toMatchObject([
      { status: 'pending' },
    ]);
    expect(store.listProjectWorkerEvidenceOutbox()[0].receiptRef).toBeUndefined();
    store.close();
  });

  it('quarantines the exact lane on a permanent controller rejection so head + later evidence stay audit-visible without being reclaimed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-quarantine-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const now = Date.parse('2026-09-29T00:00:00.000Z');
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, now: () => now,
      deliver: async () => {
        const error = new Error('controller rejected: identity_mismatch') as Error & { permanent?: true; code?: string };
        error.permanent = true; error.code = 'identity_mismatch';
        throw error;
      },
    });
    const head = relay.capture(facts({ eventKind: 'accepted' }));
    await relay.flushOnce();
    // The head must be quarantined: pending status with a `permanent:` prefixed last_error and a
    // sentinel next_attempt_at (Number.MAX_SAFE_INTEGER) so future claims never pick it up.
    const [row] = store.listProjectWorkerEvidenceOutbox();
    expect(row).toMatchObject({
      evidenceId: head.evidenceId, status: 'pending',
      lastError: expect.stringMatching(/^permanent:identity_mismatch/),
    });
    expect(row.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
    // A later same-lane evidence is persisted but must never be claimed while the lane is
    // quarantined.
    const tail = relay.capture(facts({ eventKind: 'execution_started' }));
    expect(store.listProjectWorkerEvidence().map(item => item.evidenceId).sort())
      .toEqual([head.evidenceId, tail.evidenceId].sort());
    expect(store.claimProjectWorkerEvidence({ now: now + 1_000, claimToken: 'claim-q', staleClaimMs: 5_000 })).toBeUndefined();
    // A different lane stays live.
    const otherLane = trust.issue(facts({ dispatchRoot: 'om_projectrootother', sourceTurnId: 'other-turn' }));
    expect(store.enqueueProjectWorkerEvidence(otherLane, () => true).kind).toBe('appended');
    const claimOther = store.claimProjectWorkerEvidence({ now: now + 1_100, claimToken: 'claim-other', staleClaimMs: 5_000 });
    expect(claimOther?.evidenceId).toBe(otherLane.evidenceId);
    store.close();
  });

  it('close(remainingBudget) aborts in-flight lanes, awaits bounded reset, and reports aggregate quiesced/pending/inflight counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-close-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const now = Date.parse('2026-09-29T00:00:00.000Z');
    const observedSignals: AbortSignal[] = [];
    let deliverPending: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, now: () => now,
      deliver: async (_evidence, signal) => new Promise<string>((resolve, reject) => {
        observedSignals.push(signal);
        deliverPending = { resolve, reject };
        signal.addEventListener('abort', () => reject(new Error(String(signal.reason?.message ?? 'aborted'))));
      }),
    });
    relay.capture(facts({ eventKind: 'execution_started' }));
    const flushing = relay.flushOnce();
    // Wait until the deliver call is observed before closing.
    while (!deliverPending) await new Promise(r => setImmediate(r));
    const closed = await relay.close(50);
    await flushing;
    expect(closed).toMatchObject({ quiesced: 0, pending: 1, inflight: 0 });
    expect(observedSignals[0].aborted).toBe(true);
    expect(store.listProjectWorkerEvidenceOutbox()).toMatchObject([{ status: 'pending' }]);
    store.close();
  });

  it('close(0) returns the current durable counts immediately when delivery ignores abort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-close-zero-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    let deliveryStarted = false;
    let resolveDelivery: ((receipt: string) => void) | undefined;
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust,
      deliver: async () => new Promise<string>(resolve => {
        deliveryStarted = true;
        resolveDelivery = resolve;
      }),
    });
    relay.capture(facts({ eventKind: 'execution_started' }));
    const flushing = relay.flushOnce();
    while (!deliveryStarted) await new Promise(resolve => setImmediate(resolve));

    let closeResult: Awaited<ReturnType<typeof relay.close>> | undefined;
    const closing = relay.close(0).then(result => { closeResult = result; });
    await new Promise(resolve => setTimeout(resolve, 30));
    const returnedWithinZeroBudget = closeResult !== undefined;

    resolveDelivery?.('late-receipt');
    await Promise.all([flushing, closing]);
    store.close();

    expect(returnedWithinZeroBudget).toBe(true);
    expect(closeResult).toEqual({ quiesced: 0, pending: 0, inflight: 1 });
  });

  it('close waits for every concurrent lane tail before reporting no inflight evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-close-multi-lane-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const now = Date.parse('2026-09-29T00:00:00.000Z');
    const observedSignals: AbortSignal[] = [];
    let deliveries = 0;
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, now: () => now,
      deliver: async (_evidence, signal) => new Promise<string>((_resolve, reject) => {
        deliveries += 1;
        const laneNumber = deliveries;
        observedSignals.push(signal);
        signal.addEventListener('abort', () => {
          const rejectAborted = () => reject(new Error(String(signal.reason?.message ?? 'aborted')));
          if (laneNumber === 1) setTimeout(rejectAborted, 25);
          else rejectAborted();
        });
      }),
    });
    relay.capture(facts({ eventKind: 'accepted', dispatchRoot: 'om_close_lane_a', sourceTurnId: 'turn-close-a' }));
    relay.capture(facts({ eventKind: 'accepted', dispatchRoot: 'om_close_lane_b', sourceTurnId: 'turn-close-b' }));
    const firstLane = relay.flushOnce();
    while (deliveries < 1) await new Promise(resolve => setImmediate(resolve));
    const secondLane = relay.flushOnce();
    while (deliveries < 2) await new Promise(resolve => setImmediate(resolve));

    const closed = await relay.close(100);
    await Promise.all([firstLane, secondLane]);
    try {
      expect(observedSignals).toHaveLength(2);
      expect(observedSignals.every(signal => signal.aborted)).toBe(true);
      expect(closed).toEqual({ quiesced: 0, pending: 2, inflight: 0 });
      expect(store.listProjectWorkerEvidenceOutbox()).toMatchObject([
        { status: 'pending' }, { status: 'pending' },
      ]);
    } finally {
      store.close();
    }
  });

  it('caps a source-scoped quarantine backlog: once the cap is reached new evidence is refused but existing retries stay audit-visible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-cap-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const now = Date.parse('2026-09-29T00:00:00.000Z');
    let overflows = 0;
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, now: () => now, quarantineCap: 1,
      onOverflow: () => { overflows += 1; },
      deliver: async () => {
        const error = new Error('controller rejected') as Error & { permanent?: true; code?: string };
        error.permanent = true; error.code = 'permanent_fail';
        throw error;
      },
    });
    // Fill one lane and drive it into permanent quarantine.
    relay.capture(facts({ eventKind: 'accepted', dispatchRoot: 'om_projectrootcap1', sourceTurnId: 'turn-cap-1' }));
    await relay.flushOnce();
    expect(store.listProjectWorkerEvidenceOutbox()).toMatchObject([
      { status: 'pending', lastError: expect.stringMatching(/^permanent:/), nextAttemptAt: Number.MAX_SAFE_INTEGER },
    ]);
    // A NEW lane on the same source hits the per-source quarantine cap and must be refused with
    // an overflow signal — the existing quarantined lane must remain intact for audit.
    expect(() => relay.capture(facts({
      eventKind: 'accepted', dispatchRoot: 'om_projectrootcap2', sourceTurnId: 'turn-cap-2',
    }))).toThrow('task_control_project_evidence_quarantine_cap');
    expect(overflows).toBe(1);
    expect(store.listProjectWorkerEvidence()).toHaveLength(1);
    store.close();
  });

  it('restores durable quarantine caps after restart and excludes quarantined lanes from close backlog counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-quarantine-restart-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const permanentDeliver = async () => {
      const error = new Error('controller rejected') as Error & { permanent?: true; code?: string };
      error.permanent = true; error.code = 'identity_mismatch';
      throw error;
    };
    const relay = new ProjectWorkerEvidenceRelay({ store, trust, quarantineCap: 1, deliver: permanentDeliver });
    relay.capture(facts({ eventKind: 'accepted', dispatchRoot: 'om_quarantine_one', sourceTurnId: 'turn-q1' }));
    await relay.flushOnce(Date.parse('2026-09-29T00:00:00.000Z'));
    expect(await relay.close(10)).toEqual({ quiesced: 0, pending: 0, inflight: 0 });
    store.close();

    const reopened = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const restarted = new ProjectWorkerEvidenceRelay({ store: reopened, trust, quarantineCap: 1, deliver: permanentDeliver });
    expect(() => restarted.capture(facts({
      eventKind: 'accepted', dispatchRoot: 'om_quarantine_two', sourceTurnId: 'turn-q2',
    }))).toThrow('task_control_project_evidence_quarantine_cap');
    expect(reopened.listProjectWorkerEvidence()).toHaveLength(1);
    reopened.close();
  });

  it('bounds the overall retained-evidence cap across lanes with one overflow observation and blocks further admission without dropping existing rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-overall-cap-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    const overflowLog: Array<{ kind: 'observation' | 'admission_denied'; evidenceId?: string }> = [];
    const relay = new ProjectWorkerEvidenceRelay({
      store, trust, evidenceRowCap: 2,
      now: () => Date.parse('2026-09-29T00:00:00.000Z'),
      deliver: async () => { throw new Error('controller offline'); },
      onOverflow: evidence => { overflowLog.push({ kind: 'admission_denied', evidenceId: evidence.evidenceId }); },
      onOverallOverflow: evidence => { overflowLog.push({ kind: 'observation', evidenceId: evidence.evidenceId }); },
    });
    const laneA = relay.capture(facts({ eventKind: 'accepted', dispatchRoot: 'om_capA', sourceTurnId: 'turn-cap-A' }));
    const laneB = relay.capture(facts({ eventKind: 'accepted', dispatchRoot: 'om_capB', sourceTurnId: 'turn-cap-B' }));
    expect(() => relay.capture(facts({
      eventKind: 'accepted', dispatchRoot: 'om_capC', sourceTurnId: 'turn-cap-C',
    }))).toThrow('task_control_project_evidence_row_cap');
    expect(() => relay.capture(facts({
      eventKind: 'accepted', dispatchRoot: 'om_capD', sourceTurnId: 'turn-cap-D',
    }))).toThrow('task_control_project_evidence_row_cap');
    expect(overflowLog.filter(item => item.kind === 'observation')).toHaveLength(1);
    const remaining = store.listProjectWorkerEvidence().map(item => item.evidenceId).sort();
    expect(remaining).toEqual([laneA.evidenceId, laneB.evidenceId].sort());
    const retryA = relay.capture(facts({ eventKind: 'accepted', dispatchRoot: 'om_capA', sourceTurnId: 'turn-cap-A' }));
    expect(retryA.evidenceId).toBe(laneA.evidenceId);
    store.close();
  });

  it('close(remainingBudget) reports pending versus inflight honestly under SQLite busy, budget below busy timeout, and stale-claim recovery in a fresh process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-project-evidence-close-busy-'));
    dirs.push(dir);
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: facts().sourceAppId });
    let deliverPending: { resolve: (v: string) => void; reject: (e: Error) => void } | undefined;
    let observedSignal: AbortSignal | undefined;
    // Simulate SQLite busy on the reset path: settleProjectWorkerEvidenceRetry throws SQLITE_BUSY
    // once, so the abort cannot cleanly reset the claim back to pending. close(budget) must NOT
    // claim quiesced; the inflight claim survives with the current claim_token/attempt.
    let firstResetAttempt = true;
    const busyingSettleRetry: typeof store.settleProjectWorkerEvidenceRetry = (outboxId, claimToken, error, nextAttemptAt, now) => {
      if (firstResetAttempt) {
        firstResetAttempt = false;
        const busy = new Error('database is locked') as Error & { code?: string };
        busy.code = 'SQLITE_BUSY';
        throw busy;
      }
      return (TaskControlPlaneStore.prototype.settleProjectWorkerEvidenceRetry as any).call(
        store, outboxId, claimToken, error, nextAttemptAt, now,
      );
    };
    const wrappedStore: any = Object.create(store);
    wrappedStore.settleProjectWorkerEvidenceRetry = busyingSettleRetry;
    const relay = new ProjectWorkerEvidenceRelay({
      store: wrappedStore, trust, now: () => Date.parse('2026-09-29T00:00:00.000Z'),
      deliver: async (_evidence, signal) => new Promise<string>((resolve, reject) => {
        observedSignal = signal;
        deliverPending = { resolve, reject };
        signal.addEventListener('abort', () => reject(new Error(String(signal.reason?.message ?? 'aborted'))));
      }),
    });
    relay.capture(facts({ eventKind: 'execution_started' }));
    const flushing = relay.flushOnce();
    while (!deliverPending) await new Promise(r => setImmediate(r));
    // Budget smaller than the simulated busy timeout — close must return with honest counts.
    const closed = await relay.close(20);
    await flushing;
    expect(observedSignal?.aborted).toBe(true);
    // The reset failed under SQLite busy: the outbox remained inflight with its original claim.
    // Honest report: no quiesced, one inflight, zero pending.
    expect(closed).toMatchObject({ quiesced: 0, pending: 0, inflight: 1 });
    const [row] = store.listProjectWorkerEvidenceOutbox();
    expect(row.status).toBe('inflight');
    expect(row.claimToken).toBeDefined();
    const priorEvidenceId = store.listProjectWorkerEvidence()[0].evidenceId;
    store.close();

    // Fresh process reopens the same database. Stale-claim recovery must pick up the durable
    // inflight row once its claim_token is older than staleClaimMs.
    const reopened = await TaskControlPlaneStore.open(dir, authority, facts().sourceAppId);
    const recovered = reopened.claimProjectWorkerEvidence({
      now: Date.parse('2026-09-29T00:01:00.000Z'),
      claimToken: 'recovered', staleClaimMs: 1_000,
    });
    expect(recovered?.evidenceId).toBe(priorEvidenceId);
    expect(recovered?.claimToken).toBe('recovered');
    reopened.close();
  });
});
