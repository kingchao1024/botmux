import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  TaskControlPlaneStore,
  type AppendTaskControlEventInput,
  type AuthenticatedTaskControlPrincipal,
  type TaskControlActorRole,
  type TaskControlAuthority,
  type VerifiedTaskControlApproval,
} from '../src/services/task-control-plane-store.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const dirs: string[] = [];
const storeModuleUrl = new URL('../src/services/task-control-plane-store.ts', import.meta.url).href;
const principals = new WeakMap<object, AuthenticatedTaskControlPrincipal>();
const approvals = new WeakMap<object, VerifiedTaskControlApproval>();
const authority: TaskControlAuthority = {
  authenticate(authentication) {
    return typeof authentication === 'object' && authentication !== null ? principals.get(authentication) : undefined;
  },
  verifyApproval({ approval }) {
    return typeof approval === 'object' && approval !== null ? approvals.get(approval) : undefined;
  },
};

function auth(actorId = 'actor-1', actorRole: TaskControlActorRole = 'controller'): object {
  const token = Object.freeze({});
  principals.set(token, { actorId, actorRole });
  return token;
}

function approval(
  approvalRef = 'approval:freeze-1',
  overrides: Partial<VerifiedTaskControlApproval> = {},
): object {
  const token = Object.freeze({});
  approvals.set(token, {
    approvalRef, projectId: 'project-1', phaseId: 'phase-1', acceptorId: 'acceptor-1',
    taskSetSnapshot: ['task-1'],
    approvedAt: '2026-09-04T00:00:12.500Z',
    expiresAt: '2099-09-04T01:00:00.000Z',
    ...overrides,
  });
  return token;
}

function collectChild(child: ReturnType<typeof spawnTsEvalWithRepoImports>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(): Promise<{ dir: string; store: TaskControlPlaneStore }> {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-'));
  dirs.push(dir);
  return { dir, store: await TaskControlPlaneStore.open(dir, authority) };
}

type TestEventOverrides = Partial<AppendTaskControlEventInput> & {
  actorId?: string;
  actorRole?: TaskControlActorRole;
};

function event(
  suffix: string,
  eventType: AppendTaskControlEventInput['eventType'],
  overrides: TestEventOverrides = {},
): AppendTaskControlEventInput {
  const { actorId = 'actor-1', actorRole = 'controller', ...eventOverrides } = overrides;
  return {
    eventId: `evt_${suffix}`, eventType, projectId: 'project-1', phaseId: 'phase-1',
    authentication: auth(actorId, actorRole), occurredAt: `2026-09-04T00:00:${suffix.padStart(2, '0')}.000Z`,
    idempotencyKey: `key-${suffix}`, payload: {}, ...eventOverrides,
  };
}

function taskEvent(
  suffix: string,
  eventType: AppendTaskControlEventInput['eventType'],
  overrides: TestEventOverrides = {},
): AppendTaskControlEventInput {
  return event(suffix, eventType, { taskGuid: 'task-1', topicRootId: 'om_root_1', ...overrides });
}

function openPhase(store: TaskControlPlaneStore): void {
  store.appendEvent(event('01', 'phase.opened', { payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' } }));
  store.appendEvent(taskEvent('02', 'mapping.registered', { payload: { ownerId: 'worker-1' } }));
}

function claimAndDeliver(store: TaskControlPlaneStore, eventId: string, now: number, fallbackRef?: string | null): void {
  const [row] = store.claimOutbox({ now, limit: 10, claimToken: `claim-${eventId}` });
  expect(row.eventId).toBe(eventId);
  if (fallbackRef !== undefined) {
    expect(store.settleOutboxDegraded(row.outboxId, `claim-${eventId}`, { error: 'report offline', createdAt: new Date(now).toISOString() })).toBe(true);
    if (fallbackRef) {
      const eventSuffix = eventId.replace('evt_', '');
      store.appendEvent(taskEvent(`${eventSuffix}-fallback`, 'task.delivery_fallback_verified', {
        actorId: 'controller-1', actorRole: 'controller',
        sourceRef: fallbackRef,
        payload: { deliveryEventId: eventId, destinationId: row.destinationId, method: 'task_comment', receiptRef: fallbackRef },
      }));
    }
  } else {
    expect(store.settleOutboxDelivered(row.outboxId, `claim-${eventId}`, new Date(now).toISOString())).toBe(true);
  }
}

function seedFreezableTask(store: TaskControlPlaneStore, opts: {
  declareUnknown?: boolean; terminalReviewMismatch?: boolean; degradedFallback?: 'verified' | 'unverified';
} = {}): void {
  openPhase(store);
  store.appendEvent(taskEvent('03', 'task.accepted', { actorId: 'worker-1', actorRole: 'worker' }));
  store.appendEvent(taskEvent('04', 'task.execution_started'));
  store.appendEvent(taskEvent('05', 'task.first_submitted', { payload: { docToken: 'doc-final', docRevision: 7 } }));
  if (opts.declareUnknown) {
    store.appendEvent(taskEvent('06', 'unknown.required', { payload: { unknownKey: 'attachment-recount' } }));
    store.appendEvent(taskEvent('07', 'unknown.declared', { payload: { unknownKey: 'attachment-recount', boundary: 'not independently readable' } }));
  }
  store.appendEvent(taskEvent('08', 'task.reviewed', {
    actorId: 'reviewer-1', actorRole: 'reviewer',
    payload: {
      reviewRound: 1, reviewCommentId: 'comment-1', independent: true, verdict: 'pass',
      docToken: 'doc-final', docRevision: opts.terminalReviewMismatch ? 6 : 7,
    },
  }));
  store.appendEvent(taskEvent('09', 'task.delivered', {
    terminal: true, payload: { docToken: 'doc-final', docRevision: 7 }, deliverTo: ['orchestrator'],
  }));
  const fallbackRef = opts.degradedFallback === 'verified'
    ? 'task-comment:7681682608429731896'
    : opts.degradedFallback === 'unverified' ? null : undefined;
  claimAndDeliver(store, 'evt_09', Date.parse('2026-09-04T00:00:10.000Z'), fallbackRef);
  store.appendEvent(taskEvent('11', 'task.done_marked'));
  store.appendEvent(event('12', 'phase.freeze_requested', {
    sourceRef: 'task-comment:7681682608429731896',
    payload: { taskGuids: ['task-1'], openIssueCodes: [], requestRef: 'task-comment:7681682608429731896' },
  }));
}

describe('TaskControlPlaneStore event ledger', () => {
  it('fails closed when no trusted authority is supplied or authentication is unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-auth-'));
    dirs.push(dir);
    await expect(TaskControlPlaneStore.open(dir, undefined as any)).rejects.toThrow('task_control_authority_required');
    const store = await TaskControlPlaneStore.open(dir, authority);
    expect(() => store.appendEvent({
      eventId: 'evt_forged', eventType: 'phase.opened', projectId: 'project-1', phaseId: 'phase-1',
      authentication: { actorId: 'forged', actorRole: 'controller' }, idempotencyKey: 'forged',
      payload: { taskGuids: ['task-1'], designatedAcceptorId: 'forged' },
    })).toThrow('task_control_authentication_failed');
    expect(store.listEvents()).toEqual([]);
    store.close();
  });

  it('persists unmapped daemon signals as immutable UNKNOWN observations without task state', async () => {
    const { store } = await fixture();
    const input = {
      eventId: 'obs-dispatch-1', attemptedEventType: 'task.dispatch_requested' as const,
      sourceRef: 'dispatch:om_seed', idempotencyKey: 'dispatch:om_seed',
      payload: { dispatchRoot: 'om_seed', sourceSessionId: 'session-1' },
    };
    expect(store.appendUnknownObservation(input)).toMatchObject({ kind: 'appended' });
    expect(store.appendUnknownObservation(input)).toMatchObject({ kind: 'duplicate' });
    expect(store.getTaskProjection('task-not-mapped').state).toBe('planned');
    expect(store.listObservations()).toEqual([expect.objectContaining({
      eventId: 'obs-dispatch-1', outcome: 'unknown', sourceRef: 'dispatch:om_seed',
    })]);
    const conflict = store.appendUnknownObservation({
      ...input, eventId: 'obs-dispatch-2', payload: { dispatchRoot: 'om_seed', sourceSessionId: 'different-session' },
    });
    expect(conflict).toMatchObject({ kind: 'conflict', conflictObservation: { outcome: 'conflict' } });
    expect(store.listObservations()).toHaveLength(2);
    store.close();
  });

  it('opens the same new SQLite store concurrently from separate processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-concurrent-open-'));
    dirs.push(dir);
    const source = `
      import { TaskControlPlaneStore } from ${JSON.stringify(storeModuleUrl)};
      const token = {};
      const authority = {
        authenticate(value) { return value === token ? { actorId: 'controller-1', actorRole: 'controller' } : undefined; },
        verifyApproval() { return undefined; },
      };
      const store = await TaskControlPlaneStore.open(process.env.CONTROL_DIR, authority);
      store.close();
      process.stdout.write('ok');
    `;
    const children = [0, 1].map(() => spawnTsEvalWithRepoImports(source, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, CONTROL_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const results = await Promise.all(children.map(collectChild));
    expect(results, results.map(result => result.stderr).join('\n')).toEqual([
      expect.objectContaining({ code: 0, stdout: 'ok' }),
      expect.objectContaining({ code: 0, stdout: 'ok' }),
    ]);
    const store = await TaskControlPlaneStore.open(dir, authority);
    expect(store.listEvents()).toEqual([]);
    store.close();
  });

  it('appends immutable events and rebuilds task/phase state through a read-only projection', async () => {
    const { dir, store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.accepted', { actorId: 'worker-1', actorRole: 'worker' }));
    store.appendEvent(taskEvent('04', 'task.execution_started'));
    store.appendEvent(taskEvent('05', 'task.done_marked'));

    expect(store.getTaskProjection('task-1')).toMatchObject({
      state: 'blocked', explicitlyAccepted: true,
      mapping: { taskGuid: 'task-1', topicRootId: 'om_root_1', ownerId: 'worker-1' },
      transitionViolations: [{ eventId: 'evt_05', eventType: 'task.done_marked', stateBefore: 'executing' }],
    });
    expect(store.getPhaseProjection('project-1', 'phase-1')).toMatchObject({
      state: 'active', expectedTaskGuids: ['task-1'],
      tasks: [{ state: 'blocked' }],
    });
    store.close();

    const readOnly = await TaskControlPlaneStore.openReadOnly(dir);
    expect(readOnly.listEvents()).toHaveLength(5);
    expect(() => readOnly.appendEvent(event('99', 'phase.blocked'))).toThrow('task_control_read_only');
    readOnly.close();
  });

  it('makes event and receipt rows immutable at the SQLite boundary', async () => {
    const { dir, store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.delivered', {
      terminal: true, payload: { docToken: 'doc', docRevision: 1 }, deliverTo: ['orchestrator'],
    }));
    claimAndDeliver(store, 'evt_03', Date.parse('2026-09-04T00:00:04.000Z'));
    store.close();

    const db = new DatabaseSync(join(dir, 'botmux-task-control-plane.sqlite'));
    expect(() => db.prepare('UPDATE control_events SET actor_id=? WHERE event_id=?').run('mutated', 'evt_01')).toThrow('control_event_immutable');
    expect(() => db.prepare('DELETE FROM control_delivery_receipts').run()).toThrow('control_receipt_immutable');
    db.close();
  });

  it('rejects task events that do not match the canonical task/topic mapping', async () => {
    const { store } = await fixture();
    openPhase(store);
    expect(() => store.appendEvent(taskEvent('03', 'task.accepted', { topicRootId: 'om_other' })))
      .toThrow('task_control_mapping_mismatch:task-1');
    store.close();
  });
});

describe('TaskControlPlaneStore idempotency', () => {
  it('serializes concurrent claims for the same idempotency key across processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-concurrent-claim-'));
    dirs.push(dir);
    const initial = await TaskControlPlaneStore.open(dir, authority);
    initial.close();
    const source = `
      import { TaskControlPlaneStore } from ${JSON.stringify(storeModuleUrl)};
      const token = {};
      const authority = {
        authenticate(value) { return value === token ? { actorId: 'actor-1', actorRole: 'controller' } : undefined; },
        verifyApproval() { return undefined; },
      };
      const store = await TaskControlPlaneStore.open(process.env.CONTROL_DIR, authority);
      const result = store.appendEvent({
        eventId: 'evt_' + process.env.WORKER_ID, eventType: 'phase.opened',
        projectId: 'project-1', phaseId: 'phase-1', authentication: token,
        occurredAt: '2026-09-04T00:00:01.000Z', idempotencyKey: 'same-key',
        payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' },
      });
      store.close();
      process.stdout.write(result.kind);
    `;
    const children = ['a', 'b'].map(workerId => spawnTsEvalWithRepoImports(source, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, CONTROL_DIR: dir, WORKER_ID: workerId },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const results = await Promise.all(children.map(collectChild));
    expect(results.map(result => result.code)).toEqual([0, 0]);
    expect(results.map(result => result.stdout).sort()).toEqual(['appended', 'duplicate']);
    const store = await TaskControlPlaneStore.open(dir, authority);
    expect(store.listEvents()).toHaveLength(1);
    store.close();
  });

  it('deduplicates the same key and semantic payload even when the retry timestamp changes', async () => {
    const { store } = await fixture();
    const first = store.appendEvent(event('01', 'phase.opened', { payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' } }));
    const duplicate = store.appendEvent(event('retry', 'phase.opened', {
      occurredAt: '2026-09-04T01:00:00.000Z', idempotencyKey: 'key-01', payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' },
    }));
    expect(first.kind).toBe('appended');
    expect(duplicate).toMatchObject({ kind: 'duplicate', event: { eventId: 'evt_01' } });
    expect(store.listEvents()).toHaveLength(1);
    store.close();
  });

  it('records rather than overwrites an idempotency payload conflict and blocks the projection', async () => {
    const { store } = await fixture();
    store.appendEvent(event('01', 'phase.opened', { payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' } }));
    const conflict = store.appendEvent(event('02', 'phase.opened', {
      idempotencyKey: 'key-01', payload: { taskGuids: ['task-2'], designatedAcceptorId: 'acceptor-1' },
    }));
    expect(conflict).toMatchObject({
      kind: 'conflict', existingEvent: { eventId: 'evt_01' },
      conflictEvent: { eventType: 'event.conflict_detected', errorClass: 'idempotency_payload_conflict' },
    });
    expect(store.getPhaseProjection('project-1', 'phase-1')).toMatchObject({ state: 'blocked' });
    store.close();
  });

  it('keeps an explicit acceptance timeout distinct from acceptance', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.acceptance_requested'));
    store.appendEvent(taskEvent('04', 'task.acceptance_timed_out', { errorClass: 'acceptance_timeout' }));
    expect(store.getTaskProjection('task-1')).toMatchObject({ state: 'blocked', explicitlyAccepted: false });
    store.close();
  });
});

describe('TaskControlPlaneStore durable delivery', () => {
  it('allows only one process to claim a pending outbox row', async () => {
    const { dir, store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.delivered', {
      terminal: true, payload: { docToken: 'doc', docRevision: 1 }, deliverTo: ['orchestrator'],
    }));
    store.close();
    const source = `
      import { TaskControlPlaneStore } from ${JSON.stringify(storeModuleUrl)};
      const token = {};
      const authority = {
        authenticate(value) { return value === token ? { actorId: 'worker-1', actorRole: 'worker' } : undefined; },
        verifyApproval() { return undefined; },
      };
      const store = await TaskControlPlaneStore.open(process.env.CONTROL_DIR, authority);
      const rows = store.claimOutbox({
        now: Date.parse('2026-09-04T00:00:04.000Z'), limit: 1, claimToken: process.env.WORKER_ID,
      });
      store.close();
      process.stdout.write(String(rows.length));
    `;
    const children = ['a', 'b'].map(workerId => spawnTsEvalWithRepoImports(source, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, CONTROL_DIR: dir, WORKER_ID: workerId },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const results = await Promise.all(children.map(collectChild));
    expect(results.map(result => result.code)).toEqual([0, 0]);
    expect(results.map(result => result.stdout).sort()).toEqual(['0', '1']);
  });

  it('persists retry/degraded receipts and accepts an explicit fallback receipt', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.delivered', {
      terminal: true, payload: { docToken: 'doc', docRevision: 1 }, deliverTo: ['orchestrator'],
    }));
    const firstAttemptAt = Date.parse('2026-09-04T00:00:04.000Z');
    const secondAttemptAt = firstAttemptAt + 1000;
    const [first] = store.claimOutbox({ now: firstAttemptAt, limit: 1, claimToken: 'first' });
    expect(store.rescheduleOutbox(first.outboxId, 'first', { error: 'orchestrator_daemon_offline', nextAttemptAt: secondAttemptAt, createdAt: '2026-09-04T00:00:04.000Z' })).toBe(true);
    expect(store.claimOutbox({ now: secondAttemptAt - 1, limit: 1, claimToken: 'early' })).toEqual([]);
    const [second] = store.claimOutbox({ now: secondAttemptAt, limit: 1, claimToken: 'second' });
    expect(store.settleOutboxDegraded(second.outboxId, 'second', {
      error: 'orchestrator_daemon_offline', createdAt: '2026-09-04T00:00:05.000Z',
    })).toBe(true);
    store.appendEvent(taskEvent('06', 'task.delivery_fallback_verified', {
      actorId: 'controller-1', actorRole: 'controller',
      sourceRef: 'task-comment:123',
      payload: { deliveryEventId: 'evt_03', destinationId: 'orchestrator', method: 'task_comment', receiptRef: 'task-comment:123' },
    }));
    expect(store.listOutbox()).toEqual([expect.objectContaining({ status: 'degraded', attempts: 2, fallbackEventId: 'evt_06' })]);
    expect(store.listReceipts('evt_03')).toEqual([
      expect.objectContaining({ state: 'retry_scheduled', attempt: 1, error: 'orchestrator_daemon_offline' }),
      expect.objectContaining({ state: 'degraded', attempt: 2 }),
      expect.objectContaining({ state: 'fallback_verified', attempt: 2, fallbackEventId: 'evt_06' }),
    ]);
    store.close();
  });

  it('rejects arbitrary degraded markers until a typed fallback evidence event verifies them', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.delivered', {
      terminal: true, payload: { docToken: 'doc', docRevision: 1 }, deliverTo: ['orchestrator'],
    }));
    const now = Date.parse('2026-09-04T00:00:04.000Z');
    const [row] = store.claimOutbox({ now, limit: 1, claimToken: 'degrade' });
    expect(store.settleOutboxDegraded(row.outboxId, 'degrade', { error: 'relay offline' })).toBe(true);
    expect(() => store.appendEvent(taskEvent('05', 'task.delivery_fallback_verified', {
      sourceRef: 'arbitrary',
      payload: { deliveryEventId: 'evt_03', destinationId: 'orchestrator', method: 'task_comment', receiptRef: 'arbitrary' },
    }))).toThrow('task_control_invalid:payload.receiptRef');
    expect(store.listOutbox()).toEqual([expect.objectContaining({ status: 'degraded' })]);
    expect(store.listOutbox()[0]).not.toHaveProperty('fallbackEventId');
    store.close();
  });

  it('recovers an inflight delivery claim left by a crashed worker', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.delivered', {
      terminal: true, payload: { docToken: 'doc', docRevision: 1 }, deliverTo: ['orchestrator'],
    }));
    const claimedAt = Date.parse('2026-09-04T00:00:04.000Z');
    expect(store.claimOutbox({ now: claimedAt, limit: 1, claimToken: 'crashed' })).toHaveLength(1);
    expect(store.resetExpiredOutboxClaims(claimedAt + 1000, 999)).toBe(1);
    expect(store.listReceipts('evt_03')).toContainEqual(expect.objectContaining({
      state: 'claim_recovered', attempt: 1, error: 'delivery_claim_expired',
    }));
    expect(store.claimOutbox({ now: claimedAt + 1000, limit: 1, claimToken: 'recovered' })).toEqual([
      expect.objectContaining({ status: 'inflight', attempts: 2, claimToken: 'recovered' }),
    ]);
    store.close();
  });
});

describe('TaskControlPlaneStore freeze validator', () => {
  it('does not consume approval until every freeze gate passes', async () => {
    const { store } = await fixture();
    seedFreezableTask(store);
    const proof = approval('approval:rejected-first');
    store.appendEvent(taskEvent('13', 'unknown.required', { payload: { unknownKey: 'still-open' } }));
    expect(store.freezePhase({
      eventId: 'evt_freeze_rejected', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: proof, idempotencyKey: 'freeze-rejected-first',
    })).toMatchObject({ kind: 'rejected' });
    expect(store.getApprovalConsumption('approval:rejected-first')).toBeUndefined();
    store.appendEvent(taskEvent('14', 'unknown.declared', { payload: { unknownKey: 'still-open' } }));
    store.appendEvent(event('15', 'phase.freeze_requested', {
      sourceRef: 'task-comment:15',
      payload: { taskGuids: ['task-1'], openIssueCodes: [], requestRef: 'task-comment:15' },
    }));
    const frozen = store.freezePhase({
      eventId: 'evt_freeze_after_reject', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: proof, idempotencyKey: 'freeze-rejected-first',
    });
    expect(frozen).toMatchObject({ kind: 'frozen', event: { eventId: 'evt_freeze_after_reject' } });
    expect(store.getApprovalConsumption('approval:rejected-first')).toMatchObject({
      frozenEventId: 'evt_freeze_after_reject', freezeIdempotencyKey: 'freeze-rejected-first',
    });
    store.close();
  });

  it('does not consume approval when the frozen event write rolls back', async () => {
    const { store } = await fixture();
    seedFreezableTask(store);
    const db = new DatabaseSync(store.path);
    try {
      db.prepare('INSERT INTO control_approval_consumptions(approval_ref,project_id,phase_id,task_set_hash,acceptor_id,freeze_idempotency_key,frozen_event_id,approved_at,consumed_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
        'approval:other', 'project-1', 'phase-1', 'sha256:other', 'acceptor-1', 'freeze-write-collision',
        'evt_09', '2026-09-04T00:00:12.000Z', '2026-09-04T00:00:12.000Z',
      );
    } finally { db.close(); }
    expect(() => store.freezePhase({
      eventId: 'evt_freeze_write_collision', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: approval('approval:rollback-proof'),
      idempotencyKey: 'freeze-write-collision',
    })).toThrow();
    expect(store.getApprovalConsumption('approval:rollback-proof')).toBeUndefined();
    expect(store.listEvents().some(event => event.eventId === 'evt_freeze_write_collision')).toBe(false);
    store.close();
  });

  it('rejects durable approval replay after reopening with a fresh authority', async () => {
    const { dir, store } = await fixture();
    seedFreezableTask(store);
    expect(store.freezePhase({
      eventId: 'evt_freeze_durable', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: approval('approval:durable-replay'),
      idempotencyKey: 'freeze-durable',
    })).toMatchObject({ kind: 'frozen' });
    store.close();
    const replayAuthority: TaskControlAuthority = {
      authenticate(value) { return value === 'acceptor' ? { actorId: 'acceptor-1', actorRole: 'acceptor' } : undefined; },
      verifyApproval() {
        return {
          approvalRef: 'approval:durable-replay', projectId: 'project-1', phaseId: 'phase-1',
          taskSetSnapshot: ['task-1'], acceptorId: 'acceptor-1',
          approvedAt: '2026-09-04T00:00:12.500Z', expiresAt: '2099-09-04T01:00:00.000Z',
        };
      },
    };
    const reopened = await TaskControlPlaneStore.open(dir, replayAuthority);
    expect(() => reopened.freezePhase({
      eventId: 'evt_freeze_replay', projectId: 'project-1', phaseId: 'phase-1',
      authentication: 'acceptor', approval: 'proof', idempotencyKey: 'freeze-durable-replay',
    })).toThrow('task_control_freeze_approval_already_consumed:approval:durable-replay');
    reopened.close();
  });

  it('returns the prior frozen event for client retry with the same idempotency key', async () => {
    const { store } = await fixture();
    seedFreezableTask(store);
    const first = store.freezePhase({
      eventId: 'evt_freeze_retryable', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: approval('approval:client-retry'),
      idempotencyKey: 'freeze-client-retry',
    });
    expect(first).toMatchObject({ kind: 'frozen', event: { eventId: 'evt_freeze_retryable' } });
    const retry = store.freezePhase({
      eventId: 'evt_freeze_lost_response', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: { forged: true },
      idempotencyKey: 'freeze-client-retry',
    });
    expect(retry).toMatchObject({ kind: 'frozen', event: { eventId: 'evt_freeze_retryable' } });
    expect(store.listEvents().filter(event => event.eventType === 'phase.frozen')).toHaveLength(1);
    store.close();
  });

  it('allows exactly one concurrent durable approval consumer', async () => {
    const { dir, store } = await fixture();
    seedFreezableTask(store);
    store.close();
    const source = `
      import { TaskControlPlaneStore } from ${JSON.stringify(storeModuleUrl)};
      const authority = {
        authenticate(value) { return value === 'acceptor' ? { actorId: 'acceptor-1', actorRole: 'acceptor' } : undefined; },
        verifyApproval() { return { approvalRef: 'approval:concurrent', projectId: 'project-1', phaseId: 'phase-1', taskSetSnapshot: ['task-1'], acceptorId: 'acceptor-1', approvedAt: '2026-09-04T00:00:12.500Z', expiresAt: '2099-09-04T01:00:00.000Z' }; },
      };
      const store = await TaskControlPlaneStore.open(process.env.CONTROL_DIR, authority);
      try {
        const result = store.freezePhase({ eventId: 'evt_freeze_' + process.env.WORKER_ID, projectId: 'project-1', phaseId: 'phase-1', authentication: 'acceptor', approval: 'proof', idempotencyKey: 'freeze-' + process.env.WORKER_ID });
        process.stdout.write(result.kind);
      } catch (error) {
        process.stdout.write(String(error.message));
      } finally { store.close(); }
    `;
    const children = ['a', 'b'].map(workerId => spawnTsEvalWithRepoImports(source, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, CONTROL_DIR: dir, WORKER_ID: workerId },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const results = await Promise.all(children.map(collectChild));
    expect(results.map(result => result.code)).toEqual([0, 0]);
    expect(results.map(result => result.stdout).sort()).toEqual([
      'frozen',
      'task_control_freeze_approval_already_consumed:approval:concurrent',
    ]);
  });

  it('requires a complete immutable freeze-request snapshot', async () => {
    const { store } = await fixture();
    openPhase(store);
    expect(() => store.appendEvent(event('03', 'phase.freeze_requested')))
      .toThrow('task_control_invalid:payload.taskGuids');
    expect(() => store.appendEvent(event('04', 'phase.freeze_requested', {
      sourceRef: 'task-comment:4',
      payload: { taskGuids: ['task-1'], openIssueCodes: ['terminal_body_missing'], requestRef: 'task-comment:4' },
    }))).not.toThrow();
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues).toContainEqual(expect.objectContaining({
      code: 'phase_freeze_request_open_issues', eventId: 'evt_04',
    }));
    store.close();
  });

  it('rejects task done as a freeze proof when terminal body, independent review, and receipt are missing', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.accepted', { actorId: 'worker-1', actorRole: 'worker' }));
    store.appendEvent(taskEvent('04', 'task.done_marked'));
    store.appendEvent(event('05', 'phase.freeze_requested', {
      sourceRef: 'task-comment:5', payload: { taskGuids: ['task-1'], openIssueCodes: [], requestRef: 'task-comment:5' },
    }));

    const validation = store.validatePhaseFreeze('project-1', 'phase-1');
    expect(validation.ok).toBe(false);
    expect(validation.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'terminal_body_missing', 'independent_review_missing', 'invalid_transition_detected',
    ]));
    expect(store.freezePhase({
      eventId: 'evt_freeze', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: approval(), idempotencyKey: 'freeze-1',
    })).toMatchObject({ kind: 'rejected' });
    expect(store.listEvents().some(item => item.eventType === 'phase.frozen')).toBe(false);
    store.close();
  });

  it('preserves required UNKNOWN boundaries and accepts an explicitly declared UNKNOWN', async () => {
    const missing = await fixture();
    seedFreezableTask(missing.store);
    missing.store.appendEvent(taskEvent('13', 'unknown.required', { payload: { unknownKey: 'attachment-recount' } }));
    expect(missing.store.validatePhaseFreeze('project-1', 'phase-1').issues).toContainEqual(expect.objectContaining({
      code: 'unknown_declaration_missing', unknownKey: 'attachment-recount',
    }));
    missing.store.close();

    const declared = await fixture();
    seedFreezableTask(declared.store, { declareUnknown: true });
    expect(declared.store.validatePhaseFreeze('project-1', 'phase-1')).toMatchObject({ ok: true, taskGuids: ['task-1'] });
    const projection = declared.store.getTaskProjection('task-1');
    expect(projection.unknowns).toEqual([expect.objectContaining({ key: 'attachment-recount', required: true, declared: true, resolved: false })]);
    declared.store.close();
  });

  it('rejects a review of a different document revision', async () => {
    const { store } = await fixture();
    seedFreezableTask(store, { terminalReviewMismatch: true });
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues).toContainEqual(expect.objectContaining({
      code: 'review_terminal_mismatch', taskGuid: 'task-1',
    }));
    store.close();
  });

  it('requires a trusted reviewer role and condition evidence before conditional review can freeze', async () => {
    const { store } = await fixture();
    seedFreezableTask(store);
    expect(() => store.appendEvent(taskEvent('conditional-role', 'task.reviewed', {
      actorId: 'worker-1', actorRole: 'worker',
      payload: { reviewRound: 2, reviewCommentId: 'review-role', independent: true, verdict: 'conditional', conditionIds: ['condition-1'] },
    }))).toThrow('task_control_invalid:reviewer_role');
    store.appendEvent(taskEvent('conditional-review', 'task.reviewed', {
      actorId: 'reviewer-2', actorRole: 'reviewer',
      payload: {
        reviewRound: 2, reviewCommentId: 'review-condition', independent: true, verdict: 'conditional',
        conditionIds: ['condition-1'], docToken: 'doc-final', docRevision: 7,
      },
    }));
    const validation = store.validatePhaseFreeze('project-1', 'phase-1');
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'review_conditions_unresolved', eventId: 'evt_conditional-review' }),
    ]));
    store.appendEvent(taskEvent('conditional-resolved', 'task.reviewed', {
      actorId: 'reviewer-2', actorRole: 'reviewer',
      payload: {
        reviewRound: 3, reviewCommentId: 'review-condition-resolved', independent: true, verdict: 'conditional',
        conditionIds: ['condition-1'],
        resolvedConditionEvidence: { 'condition-1': 'task-comment:99' },
        docToken: 'doc-final', docRevision: 7,
      },
    }));
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues.map(issue => issue.code))
      .not.toContain('review_conditions_unresolved');
    store.close();
  });

  it('keeps a prior conditional review condition open until later reviewer evidence resolves it', async () => {
    const { store } = await fixture();
    seedFreezableTask(store);
    store.appendEvent(taskEvent('condition-open', 'task.reviewed', {
      actorId: 'reviewer-2', actorRole: 'reviewer',
      payload: {
        reviewRound: 2, reviewCommentId: 'condition-open', independent: true, verdict: 'conditional',
        conditionIds: ['condition-1'], docToken: 'doc-final', docRevision: 7,
      },
    }));
    store.appendEvent(taskEvent('later-pass', 'task.reviewed', {
      actorId: 'reviewer-2', actorRole: 'reviewer',
      payload: {
        reviewRound: 3, reviewCommentId: 'later-pass', independent: true, verdict: 'pass',
        docToken: 'doc-final', docRevision: 7,
      },
    }));
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'review_conditions_unresolved' })]));
    store.appendEvent(taskEvent('condition-resolved', 'task.reviewed', {
      actorId: 'reviewer-2', actorRole: 'reviewer',
      payload: {
        reviewRound: 4, reviewCommentId: 'condition-resolved', independent: true, verdict: 'pass',
        resolvedConditionEvidence: { 'condition-1': 'task-comment:100' },
        docToken: 'doc-final', docRevision: 7,
      },
    }));
    expect(store.getTaskProjection('task-1').unresolvedReviewConditionIds).toEqual([]);
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues.map(issue => issue.code))
      .not.toContain('review_conditions_unresolved');
    store.close();
  });

  it('rejects a degraded delivery until a typed fallback event is linked', async () => {
    const { store } = await fixture();
    seedFreezableTask(store, { degradedFallback: 'unverified' });
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'delivery_receipt_missing', 'delivery_degraded_unhandled',
    ]));
    store.close();
  });

  it('rejects task done that was recorded before terminal evidence and independent review', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.accepted', { actorId: 'worker-1', actorRole: 'worker' }));
    store.appendEvent(taskEvent('04', 'task.done_marked'));
    store.appendEvent(taskEvent('05', 'task.reviewed', {
      actorId: 'reviewer-1', actorRole: 'reviewer',
      payload: { reviewRound: 1, reviewCommentId: 'comment-1', independent: true, verdict: 'pass', docToken: 'doc-final', docRevision: 7 },
    }));
    store.appendEvent(taskEvent('06', 'task.delivered', {
      terminal: true, payload: { docToken: 'doc-final', docRevision: 7 }, deliverTo: ['orchestrator'],
    }));
    claimAndDeliver(store, 'evt_06', Date.parse('2026-09-04T00:00:07.000Z'));
    store.appendEvent(event('08', 'phase.freeze_requested', {
      sourceRef: 'task-comment:8', payload: { taskGuids: ['task-1'], openIssueCodes: [], requestRef: 'task-comment:8' },
    }));
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'task_done_precedes_terminal_body', 'task_done_precedes_review', 'task_state_not_ready',
    ]));
    store.close();
  });

  it('checks acceptance ownership and reviewer independence', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.accepted', { actorId: 'controller', actorRole: 'controller' }));
    store.appendEvent(taskEvent('04', 'task.reviewed', {
      actorId: 'worker-1', actorRole: 'reviewer',
      payload: { reviewRound: 1, reviewCommentId: 'self-review', independent: true, verdict: 'pass', docToken: 'doc-final', docRevision: 7 },
    }));
    store.appendEvent(taskEvent('05', 'task.delivered', {
      terminal: true, payload: { docToken: 'doc-final', docRevision: 7 }, deliverTo: ['orchestrator'],
    }));
    claimAndDeliver(store, 'evt_05', Date.parse('2026-09-04T00:00:06.000Z'));
    store.appendEvent(taskEvent('07', 'task.done_marked'));
    store.appendEvent(event('08', 'phase.freeze_requested', {
      sourceRef: 'task-comment:8', payload: { taskGuids: ['task-1'], openIssueCodes: [], requestRef: 'task-comment:8' },
    }));
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'task_acceptance_actor_mismatch', 'reviewer_not_independent',
    ]));
    store.close();
  });

  it('records an out-of-order fact but blocks freeze instead of dropping history', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.done_marked'));
    expect(store.listEvents({ taskGuid: 'task-1' }).map(item => item.eventType)).toContain('task.done_marked');
    expect(store.getTaskProjection('task-1')).toMatchObject({
      state: 'blocked', transitionViolations: [
        { eventId: 'evt_03', eventType: 'task.done_marked', stateBefore: 'planned' },
      ],
    });
    store.close();
  });

  it('freezes only after all gates pass and stores the frozen snapshot as a terminal event', async () => {
    const { store } = await fixture();
    seedFreezableTask(store, { declareUnknown: true, degradedFallback: 'verified' });
    const result = store.freezePhase({
      eventId: 'evt_freeze', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: approval(), idempotencyKey: 'freeze-1',
      occurredAt: '2026-09-04T00:00:13.000Z', evidenceRef: 'review-comment:final',
    });
    expect(result).toMatchObject({
      kind: 'frozen', validation: { ok: true },
      event: {
        eventType: 'phase.frozen', terminal: true, stateBefore: 'freeze_pending', stateAfter: 'frozen',
        payload: { snapshot: {
          projectId: 'project-1', phaseId: 'phase-1', freezeRequestedEventId: 'evt_12',
          requestedTaskGuids: ['task-1'], requestedOpenIssueCodes: [], requestRef: 'task-comment:7681682608429731896',
          acceptorId: 'acceptor-1', approvalRef: 'approval:freeze-1', approvedAt: '2026-09-04T00:00:12.500Z',
          checkedAt: '2026-09-04T00:00:13.000Z',
          issues: [], phaseUnknowns: [],
          tasks: [{
            taskGuid: 'task-1', topicRootId: 'om_root_1', ownerId: 'worker-1', acceptanceEventId: 'evt_03',
            terminalBody: { eventId: 'evt_09', docToken: 'doc-final', docRevision: 7 },
            independentReview: { reviewCommentId: 'comment-1', verdict: 'pass' },
            deliveryReceipts: [{ destinationId: 'orchestrator', status: 'fallback_verified', fallbackEventId: 'evt_09-fallback' }],
            unknowns: [expect.objectContaining({ key: 'attachment-recount', declared: true })],
          }],
        } },
      },
    });
    const snapshot = result.kind === 'frozen' ? result.event.payload.snapshot : undefined;
    expect(() => { (snapshot as any).tasks[0].terminalBody.docRevision = 999; }).not.toThrow();
    expect(store.listEvents().find(item => item.eventId === 'evt_freeze')).toMatchObject({
      payload: { snapshot: { tasks: [{ terminalBody: { docRevision: 7 } }] } },
    });
    expect(() => {
      const db = new DatabaseSync(store.path);
      try { db.prepare('UPDATE control_events SET payload_json=? WHERE event_id=?').run('{}', 'evt_freeze'); }
      finally { db.close(); }
    }).toThrow('control_event_immutable');
    expect(store.getPhaseProjection('project-1', 'phase-1').state).toBe('frozen');
    expect(store.freezePhase({
      eventId: 'evt_freeze_retry', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: approval(),
      idempotencyKey: 'freeze-1', evidenceRef: 'review-comment:final',
    })).toMatchObject({ kind: 'frozen', event: { eventId: 'evt_freeze' } });
    expect(store.listEvents().filter(item => item.eventType === 'phase.frozen')).toHaveLength(1);
    expect(() => store.appendEvent(taskEvent('14', 'task.execution_started')))
      .toThrow('task_control_phase_already_frozen:phase-1');
    store.close();
  });

  it('rejects self-freeze or an unapproved actor even after every evidence gate passes', async () => {
    const { store } = await fixture();
    seedFreezableTask(store);
    expect(() => store.freezePhase({
      eventId: 'evt_worker_freeze', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('worker-1', 'worker'), approval: approval('approval:worker-freeze'), idempotencyKey: 'worker-freeze',
    })).toThrow('task_control_freeze_unauthorized_acceptor:worker-1');
    expect(() => store.freezePhase({
      eventId: 'evt_controller_freeze', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'controller'), approval: approval('approval:controller-freeze'), idempotencyKey: 'controller-freeze',
    })).toThrow('task_control_freeze_unauthorized_role:controller');
    expect(() => store.freezePhase({
      eventId: 'evt_forged_freeze', projectId: 'project-1', phaseId: 'phase-1',
      authentication: { actorId: 'acceptor-1', actorRole: 'acceptor' }, approval: { approvalRef: 'approval:forged' },
      idempotencyKey: 'forged-freeze',
    })).toThrow('task_control_authentication_failed');
    expect(() => store.freezePhase({
      eventId: 'evt_forged_approval', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: { approvalRef: 'approval:forged' },
      idempotencyKey: 'forged-approval',
    })).toThrow('task_control_freeze_approval_unverified');
    expect(() => store.freezePhase({
      eventId: 'evt_wrong_approval_scope', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'),
      approval: approval('approval:wrong-phase', { phaseId: 'phase-2' }), idempotencyKey: 'wrong-approval-scope',
    })).toThrow('task_control_freeze_approval_unverified');
    expect(store.listEvents().some(item => item.eventType === 'phase.frozen')).toBe(false);
    store.close();
  });
});
