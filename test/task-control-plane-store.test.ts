import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DaemonReviewerVerdictProvider, type ReviewerConditionEvidence } from '../src/services/task-control-plane-reviewer-verdict.js';
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

function trustedMappingInput(): Parameters<TaskControlPlaneStore['registerTrustedMapping']>[0] {
  return {
    dispatchRoot: 'om_root_1', projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: ['task-1'],
    taskGuid: 'task-1', topicRootId: 'om_root_1', ownerId: 'worker-1', reviewerId: 'reviewer-1', acceptorId: 'acceptor-1',
    registrationRef: 'task-comment:101', controllerId: 'controller-1',
    approvalGate: {
      approvalRef: 'approval:gate-1', runId: 'run-1', nodeId: 'node-1', instanceId: 'node-1#1', waitId: 'wait-1',
      operatorId: 'acceptor-1', approverPolicy: ['acceptor-1'],
    },
    docToken: 'doc-token-12345678', authentication: auth('controller-1', 'controller'),
    occurredAt: '2026-09-05T00:00:00.000Z',
  };
}

function createV8LogicalIdSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE control_events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,lark_app_id TEXT NOT NULL,event_id TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,schema_version INTEGER NOT NULL,
      project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_guid TEXT,topic_root_id TEXT,actor_id TEXT NOT NULL,actor_role TEXT NOT NULL,
      occurred_at TEXT NOT NULL,state_before TEXT NOT NULL,state_after TEXT NOT NULL,source_ref TEXT,payload_ref TEXT,evidence_ref TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,causation_id TEXT,correlation_id TEXT,attempt INTEGER NOT NULL,error_class TEXT,ack_deadline TEXT,terminal INTEGER NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL
    );
    CREATE TABLE control_observations(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,lark_app_id TEXT NOT NULL,event_id TEXT NOT NULL UNIQUE,attempted_event_type TEXT NOT NULL,source_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,occurred_at TEXT NOT NULL,outcome TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL
    );
    CREATE TABLE control_approval_consumptions(
      approval_ref TEXT PRIMARY KEY,lark_app_id TEXT NOT NULL,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_set_hash TEXT NOT NULL,acceptor_id TEXT NOT NULL,
      freeze_idempotency_key TEXT NOT NULL UNIQUE,frozen_event_id TEXT NOT NULL UNIQUE REFERENCES control_events(event_id),approved_at TEXT NOT NULL,consumed_at TEXT NOT NULL
    );
    CREATE TABLE control_trusted_mappings(
      dispatch_root TEXT PRIMARY KEY,lark_app_id TEXT NOT NULL,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,phase_task_guids_json TEXT NOT NULL,task_guid TEXT NOT NULL,
      topic_root_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,reviewer_id TEXT NOT NULL,acceptor_id TEXT NOT NULL,registration_ref TEXT NOT NULL UNIQUE,controller_id TEXT NOT NULL,
      approval_gate_json TEXT NOT NULL,doc_token TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE control_outbox(
      outbox_id TEXT PRIMARY KEY,lark_app_id TEXT NOT NULL,event_id TEXT NOT NULL,destination_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,
      claim_token TEXT,claimed_at INTEGER,last_error TEXT,fallback_event_id TEXT REFERENCES control_events(event_id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(event_id,destination_id),
      FOREIGN KEY(event_id) REFERENCES control_events(event_id)
    );
    CREATE TABLE control_delivery_receipts(
      receipt_id TEXT PRIMARY KEY,lark_app_id TEXT NOT NULL,outbox_id TEXT NOT NULL,event_id TEXT NOT NULL,destination_id TEXT NOT NULL,attempt INTEGER NOT NULL,state TEXT NOT NULL,
      receipt_ref TEXT,error TEXT,fallback_event_id TEXT REFERENCES control_events(event_id),created_at TEXT NOT NULL,
      FOREIGN KEY(outbox_id) REFERENCES control_outbox(outbox_id),FOREIGN KEY(event_id) REFERENCES control_events(event_id)
    );
    CREATE TRIGGER control_events_no_update BEFORE UPDATE ON control_events BEGIN SELECT RAISE(ABORT,'control_event_immutable'); END;
    CREATE TRIGGER control_events_no_delete BEFORE DELETE ON control_events BEGIN SELECT RAISE(ABORT,'control_event_immutable'); END;
    CREATE TRIGGER control_observations_no_update BEFORE UPDATE ON control_observations BEGIN SELECT RAISE(ABORT,'control_observation_immutable'); END;
    CREATE TRIGGER control_observations_no_delete BEFORE DELETE ON control_observations BEGIN SELECT RAISE(ABORT,'control_observation_immutable'); END;
    CREATE TRIGGER control_approval_consumptions_no_update BEFORE UPDATE ON control_approval_consumptions BEGIN SELECT RAISE(ABORT,'control_approval_consumption_immutable'); END;
    CREATE TRIGGER control_approval_consumptions_no_delete BEFORE DELETE ON control_approval_consumptions BEGIN SELECT RAISE(ABORT,'control_approval_consumption_immutable'); END;
    CREATE TRIGGER control_trusted_mappings_no_update BEFORE UPDATE ON control_trusted_mappings BEGIN SELECT RAISE(ABORT,'control_mapping_immutable'); END;
    CREATE TRIGGER control_trusted_mappings_no_delete BEFORE DELETE ON control_trusted_mappings BEGIN SELECT RAISE(ABORT,'control_mapping_immutable'); END;
    CREATE TRIGGER control_receipts_no_update BEFORE UPDATE ON control_delivery_receipts BEGIN SELECT RAISE(ABORT,'control_receipt_immutable'); END;
    CREATE TRIGGER control_receipts_no_delete BEFORE DELETE ON control_delivery_receipts BEGIN SELECT RAISE(ABORT,'control_receipt_immutable'); END;
  `);
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
    expect(store.settleOutboxDelivered(row.outboxId, `claim-${eventId}`, {
      receiptRef: TaskControlPlaneStore.providerReceiptRef(eventId, row.destinationId, `topic-message:om_receipt_${eventId}`),
      deliveredAt: new Date(now).toISOString(),
    })).toBe(true);
  }
}

function reviewerProvider() {
  return new DaemonReviewerVerdictProvider({
    key: Buffer.from('store-reviewer-verdict-test-key'), keyId: 'store-reviewer-key',
    now: () => Date.parse('2026-09-04T00:30:00.000Z'),
  });
}

function appendTrustedReview(
  store: TaskControlPlaneStore,
  suffix: string,
  input: {
    reviewRound: number; reviewCommentId: string; verdict: 'pass' | 'conditional' | 'fail';
    conditionIds?: string[]; resolvedConditionEvidence?: Record<string, ReviewerConditionEvidence>;
    docToken: string; docRevision: number; reviewerId?: string; occurredAt?: string; designationExpiresAt?: string;
  },
): string {
  const provider = reviewerProvider();
  const reviewerId = input.reviewerId ?? 'reviewer-1';
  const occurredAt = input.occurredAt ?? '2026-09-04T00:30:00.000Z';
  store.setReviewerVerdictVerifier(provider);
  const designation = provider.issueDesignatedReviewer({
    designatedReviewerRef: `designated-${suffix}`,
    projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root_1', taskSetSnapshot: ['task-1'],
    reviewRound: input.reviewRound, reviewerId, reviewerBotAppId: 'reviewer-app',
    controllerId: 'actor-1', controllerBotAppId: 'test:unscoped',
    effectiveAt: '2026-09-04T00:00:00.000Z', expiresAt: input.designationExpiresAt ?? '2099-01-01T00:00:00.000Z',
  });
  store.appendDesignatedReviewer(designation, auth('actor-1', 'controller'), value => provider.verifyDesignatedReviewer(value));
  const verdict = provider.issueVerdict({
    verdictId: `reviewer-verdict-${suffix}`,
    projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root_1', taskSetSnapshot: ['task-1'],
    reviewRound: input.reviewRound, designatedReviewerRef: designation.designatedReviewerRef, reviewerId, reviewerBotAppId: 'reviewer-app',
    sessionId: `reviewer-session-${suffix}`, workerGeneration: input.reviewRound, capability: `reviewer-capability-${suffix}`,
    sourceCommentId: input.reviewCommentId, sourceVersionHash: `sha256:${'a'.repeat(64)}`,
    kind: 'verdict', verdict: input.verdict, conditionIds: input.conditionIds ?? [],
    resolvedConditionEvidence: input.resolvedConditionEvidence ?? {}, docToken: input.docToken, docRevision: input.docRevision,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  expect(store.appendReviewerVerdict({
    verdict, authentication: auth(reviewerId, 'reviewer'),
    attestation: { reviewerId, reviewerBotAppId: 'reviewer-app', sessionId: `reviewer-session-${suffix}`, workerGeneration: input.reviewRound, capability: `reviewer-capability-${suffix}` },
    verifyVerdict: value => provider.verifyVerdict(value), now: occurredAt,
  })).toMatchObject({ status: 'active', verdict: { verdictId: verdict.verdictId } });
  store.appendEvent(taskEvent(suffix, 'task.reviewed', {
    actorId: reviewerId, actorRole: 'reviewer', occurredAt,
    payload: {
      reviewRound: input.reviewRound, reviewCommentId: input.reviewCommentId, independent: true, verdict: input.verdict,
      conditionIds: input.conditionIds ?? [], resolvedConditionEvidence: input.resolvedConditionEvidence ?? {},
      reviewerVerdictId: verdict.verdictId, docToken: input.docToken, docRevision: input.docRevision,
    },
  }));
  return verdict.verdictId;
}

function seedFreezableTask(store: TaskControlPlaneStore, opts: {
  declareUnknown?: boolean; terminalReviewMismatch?: boolean; degradedFallback?: 'verified' | 'unverified'; designationExpiresAt?: string;
} = {}): void {
  openPhase(store);
  store.appendEvent(taskEvent('03', 'task.accepted', { actorId: 'worker-1', actorRole: 'worker' }));
  store.appendEvent(taskEvent('04', 'task.execution_started'));
  store.appendEvent(taskEvent('05', 'task.first_submitted', { payload: { docToken: 'doc-final', docRevision: 7 } }));
  if (opts.declareUnknown) {
    store.appendEvent(taskEvent('06', 'unknown.required', { payload: { unknownKey: 'attachment-recount' } }));
    store.appendEvent(taskEvent('07', 'unknown.declared', { payload: { unknownKey: 'attachment-recount', boundary: 'not independently readable' } }));
  }
  appendTrustedReview(store, '08', {
    reviewRound: 1, reviewCommentId: 'comment-1', verdict: 'pass',
    docToken: 'doc-final', docRevision: opts.terminalReviewMismatch ? 6 : 7, designationExpiresAt: opts.designationExpiresAt,
  });
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

describe('TaskControlPlaneStore v4 to v5 migration', () => {
  it('upgrades v4 in one transaction, preserves old rows, and leaves them unclaimable by a v5 owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-v4-migrate-'));
    dirs.push(dir);
    const path = join(dir, 'botmux-task-control-plane.sqlite');
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        CREATE TABLE control_events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,schema_version INTEGER NOT NULL,
          project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_guid TEXT,topic_root_id TEXT,actor_id TEXT NOT NULL,actor_role TEXT NOT NULL,
          occurred_at TEXT NOT NULL,state_before TEXT NOT NULL,state_after TEXT NOT NULL,source_ref TEXT,payload_ref TEXT,evidence_ref TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,causation_id TEXT,correlation_id TEXT,attempt INTEGER NOT NULL, error_class TEXT,ack_deadline TEXT,terminal INTEGER NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL
        );
        CREATE TABLE control_observations(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,attempted_event_type TEXT NOT NULL,source_ref TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,occurred_at TEXT NOT NULL,outcome TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL);
        CREATE TABLE control_approval_consumptions(approval_ref TEXT PRIMARY KEY,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_set_hash TEXT NOT NULL,acceptor_id TEXT NOT NULL,freeze_idempotency_key TEXT NOT NULL UNIQUE,frozen_event_id TEXT NOT NULL UNIQUE,approved_at TEXT NOT NULL,consumed_at TEXT NOT NULL);
        CREATE TABLE control_trusted_mappings(dispatch_root TEXT PRIMARY KEY,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,phase_task_guids_json TEXT NOT NULL,task_guid TEXT NOT NULL,topic_root_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,reviewer_id TEXT NOT NULL,acceptor_id TEXT NOT NULL,registration_ref TEXT NOT NULL UNIQUE,controller_id TEXT NOT NULL,doc_token TEXT,created_at TEXT NOT NULL);
        CREATE TABLE control_outbox(outbox_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,destination_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,claim_token TEXT,claimed_at INTEGER,last_error TEXT,fallback_event_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE control_delivery_receipts(receipt_id TEXT PRIMARY KEY,outbox_id TEXT NOT NULL,event_id TEXT NOT NULL,destination_id TEXT NOT NULL,attempt INTEGER NOT NULL,state TEXT NOT NULL,error TEXT,fallback_event_id TEXT,created_at TEXT NOT NULL);
        PRAGMA user_version=4;
      `);
      db.prepare(`INSERT INTO control_events(event_id,event_type,schema_version,project_id,phase_id,actor_id,actor_role,occurred_at,state_before,state_after,idempotency_key,attempt,terminal,payload_hash,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run('legacy-event', 'phase.opened', 1, 'project-legacy', 'phase-legacy', 'controller', 'controller', '2026-09-05T00:00:00.000Z', 'planned', 'active', 'legacy-key', 1, 0, 'sha256:legacy', '{}');
    } finally { db.close(); }

    const upgraded = await TaskControlPlaneStore.open(dir, authority, 'app-v5');
    expect(upgraded.listEvents()).toEqual([]);
    upgraded.close();
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      expect(Number((verify.prepare('PRAGMA user_version').get() as any).user_version)).toBe(10);
      expect(verify.prepare('SELECT lark_app_id FROM control_events WHERE event_id=?').get('legacy-event')).toEqual({ lark_app_id: 'legacy:v4' });
      expect(verify.prepare('SELECT COUNT(*) AS n FROM control_events').get()).toEqual({ n: 1 });
    } finally { verify.close(); }
    const readOnly = await TaskControlPlaneStore.openReadOnly(dir, 'app-v5');
    expect(readOnly.listEvents()).toEqual([]);
    readOnly.close();
  });

  it('rolls back an invalid v4 migration and retains the v4 version and rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-v4-rollback-'));
    dirs.push(dir);
    const path = join(dir, 'botmux-task-control-plane.sqlite');
    const db = new DatabaseSync(path);
    try {
      db.exec('CREATE TABLE control_events(event_id TEXT PRIMARY KEY); PRAGMA user_version=4;');
      db.prepare('INSERT INTO control_events(event_id) VALUES(?)').run('legacy-event');
    } finally { db.close(); }
    await expect(TaskControlPlaneStore.open(dir, authority, 'app-v5')).rejects.toThrow();
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      expect(Number((verify.prepare('PRAGMA user_version').get() as any).user_version)).toBe(4);
      expect(verify.prepare('SELECT event_id FROM control_events').get()).toEqual({ event_id: 'legacy-event' });
    } finally { verify.close(); }
    await expect(TaskControlPlaneStore.openReadOnly(dir, 'app-v5')).rejects.toThrow('task_control_schema_unsupported:4');
  });

  it('upgrades v6 reviewer tables to v8 app-scoped composite-key storage without erasing old evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-v6-migrate-'));
    dirs.push(dir);
    const path = join(dir, 'botmux-task-control-plane.sqlite');
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TABLE control_designated_reviewers(
        designated_reviewer_ref TEXT PRIMARY KEY,lark_app_id TEXT NOT NULL,project_id TEXT NOT NULL,phase_id TEXT NOT NULL,task_guid TEXT NOT NULL,task_set_json TEXT NOT NULL,review_round INTEGER NOT NULL,
        reviewer_id TEXT NOT NULL,reviewer_bot_app_id TEXT NOT NULL,controller_id TEXT NOT NULL,controller_bot_app_id TEXT NOT NULL,effective_at TEXT NOT NULL,expires_at TEXT NOT NULL,issued_at TEXT NOT NULL,key_id TEXT NOT NULL,signature TEXT NOT NULL,supersedes_ref TEXT
      ); PRAGMA user_version=6;`);
      db.prepare('INSERT INTO control_designated_reviewers VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        'legacy-reviewer', 'app-v6', 'project', 'phase', 'task', '[]', 1, 'reviewer', 'reviewer-app', 'controller', 'app-v6',
        '2026-09-05T00:00:00.000Z', '2026-09-05T01:00:00.000Z', '2026-09-05T00:00:00.000Z', 'key', 'signature', null,
      );
    } finally { db.close(); }
    const upgraded = await TaskControlPlaneStore.open(dir, authority, 'app-v7');
    upgraded.close();
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      expect(Number((verify.prepare('PRAGMA user_version').get() as any).user_version)).toBe(10);
      expect(verify.prepare('SELECT topic_root_id FROM control_designated_reviewers WHERE designated_reviewer_ref=?').get('legacy-reviewer')).toEqual({ topic_root_id: '' });
      expect(verify.prepare('PRAGMA table_info(control_designated_reviewers)').all().filter((row: any) => row.pk > 0).sort((a: any, b: any) => a.pk - b.pk).map((row: any) => row.name)).toEqual(['lark_app_id', 'designated_reviewer_ref']);
      expect(verify.prepare('PRAGMA table_info(control_reviewer_verdicts)').all().filter((row: any) => row.pk > 0).sort((a: any, b: any) => a.pk - b.pk).map((row: any) => row.name)).toEqual(['lark_app_id', 'verdict_id']);
    } finally { verify.close(); }
  });

  it('rebuilds every v8 logical-id relation under its app domain without losing immutable evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-v8-migrate-'));
    dirs.push(dir);
    const path = join(dir, 'botmux-task-control-plane.sqlite');
    const db = new DatabaseSync(path);
    try {
      createV8LogicalIdSchema(db);
      const event = ['legacy-app', 'legacy-event', 'phase.opened', 1, 'project-legacy', 'phase-legacy', null, null, 'controller', 'controller',
        '2026-09-05T00:00:00.000Z', 'planned', 'active', null, null, null, 'legacy-key', null, null, 1, null, null, 0, 'sha256:event', '{}'];
      db.prepare(`INSERT INTO control_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(1, ...event);
      db.prepare(`INSERT INTO control_observations VALUES(?,?,?,?,?,?,?,?,?,?)`).run(1, 'legacy-app', 'legacy-observation', 'task.reviewed', 'topic-message:om_legacy', 'legacy-observation-key', '2026-09-05T00:00:01.000Z', 'unknown', 'sha256:observation', '{}');
      db.prepare(`INSERT INTO control_trusted_mappings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        'legacy-root', 'legacy-app', 'project-legacy', 'phase-legacy', '["legacy-task"]', 'legacy-task', 'legacy-root', 'worker', 'reviewer', 'acceptor',
        'task-comment:101', 'controller', JSON.stringify({ approvalRef: 'approval:legacy', runId: 'run', nodeId: 'node', instanceId: 'node#1', waitId: 'wait', operatorId: 'acceptor', approverPolicy: ['acceptor'] }), null, '2026-09-05T00:00:00.000Z',
      );
      db.prepare(`INSERT INTO control_approval_consumptions VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        'approval:legacy', 'legacy-app', 'project-legacy', 'phase-legacy', 'sha256:tasks', 'acceptor', 'legacy-freeze-key', 'legacy-event',
        '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:01.000Z',
      );
      db.prepare(`INSERT INTO control_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        'legacy-outbox', 'legacy-app', 'legacy-event', 'topic-message:om_legacy', 'delivered', 1, 1, null, null, null, null,
        '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:01.000Z',
      );
      db.prepare(`INSERT INTO control_delivery_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        'legacy-receipt', 'legacy-app', 'legacy-outbox', 'legacy-event', 'topic-message:om_legacy', 1, 'delivered',
        TaskControlPlaneStore.providerReceiptRef('legacy-event', 'topic-message:om_legacy', 'topic-message:om_provider'), null, null, '2026-09-05T00:00:01.000Z',
      );
      db.exec('PRAGMA user_version=8;');
    } finally { db.close(); }

    const migrated = await TaskControlPlaneStore.open(dir, authority, 'other-app');
    expect(migrated.listEvents()).toEqual([]);
    expect(migrated.listObservations()).toEqual([]);
    expect(migrated.appendEvent({
      ...event('after-migration', 'phase.opened', {
        eventId: 'legacy-event', idempotencyKey: 'legacy-key',
        payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' },
      }),
    })).toMatchObject({ kind: 'appended', event: { eventId: 'legacy-event' } });
    expect(migrated.appendUnknownObservation({
      eventId: 'legacy-observation', attemptedEventType: 'task.reviewed', sourceRef: 'topic-message:om_legacy', idempotencyKey: 'legacy-observation-key',
    })).toMatchObject({ kind: 'appended' });
    migrated.close();
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      expect(Number((verify.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(10);
      for (const table of ['control_events', 'control_observations', 'control_approval_consumptions', 'control_trusted_mappings', 'control_outbox', 'control_delivery_receipts']) {
        const expected = table === 'control_events' || table === 'control_observations' ? 2 : 1;
        expect(verify.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: expected });
      }
      expect(verify.prepare('SELECT lark_app_id,event_id,idempotency_key FROM control_events').get()).toEqual({ lark_app_id: 'legacy-app', event_id: 'legacy-event', idempotency_key: 'legacy-key' });
      expect(verify.prepare('SELECT * FROM pragma_foreign_key_check').all()).toEqual([]);
      expect(verify.prepare('PRAGMA table_info(control_outbox)').all().filter((row: any) => row.pk > 0).sort((a: any, b: any) => a.pk - b.pk).map((row: any) => row.name)).toEqual(['lark_app_id', 'outbox_id']);
      expect(verify.prepare('PRAGMA table_info(control_delivery_receipts)').all().filter((row: any) => row.pk > 0).sort((a: any, b: any) => a.pk - b.pk).map((row: any) => row.name)).toEqual(['lark_app_id', 'receipt_id']);
      expect(verify.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='control_events_no_update'`).get()).toEqual(expect.objectContaining({ sql: expect.stringContaining('control_event_immutable') }));
    } finally { verify.close(); }
  });

  it('rolls back v8-to-v9 migration when legacy rows violate the new same-app logical-id constraints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-v8-rollback-'));
    dirs.push(dir);
    const path = join(dir, 'botmux-task-control-plane.sqlite');
    const db = new DatabaseSync(path);
    try {
      createV8LogicalIdSchema(db);
      db.prepare(`INSERT INTO control_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        1, 'app-a', 'event-a', 'phase.opened', 1, 'project-1', 'phase-1', null, null, 'controller', 'controller',
        '2026-09-05T00:00:00.000Z', 'planned', 'active', null, null, null, 'key-a', null, null, 1, null, null, 0, 'sha256:event', '{}',
      );
      db.prepare(`INSERT INTO control_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        'outbox-b', 'app-b', 'event-a', 'topic-message:om_b', 'pending', 0, 0, null, null, null, null,
        '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z',
      );
      db.exec('PRAGMA user_version=8;');
    } finally { db.close(); }
    await expect(TaskControlPlaneStore.open(dir, authority, 'app-1')).rejects.toThrow();
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      expect(Number((verify.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(8);
      expect(verify.prepare('SELECT COUNT(*) AS n FROM control_events').get()).toEqual({ n: 1 });
      expect(verify.prepare('SELECT COUNT(*) AS n FROM control_outbox').get()).toEqual({ n: 1 });
      expect(verify.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='control_events_v8'`).get()).toBeUndefined();
    } finally { verify.close(); }
  });
});

describe('TaskControlPlaneStore app-scoped logical ids', () => {
  it('lets controller apps independently reuse durable logical IDs while preserving same-app replay/conflict rules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-app-scope-'));
    dirs.push(dir);
    const appA = await TaskControlPlaneStore.open(dir, authority, 'controller-a');
    const appB = await TaskControlPlaneStore.open(dir, authority, 'controller-b');
    const sharedPhase = event('shared', 'phase.opened', {
      eventId: 'shared-event', idempotencyKey: 'shared-key', payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' },
    });
    expect(appA.appendEvent(sharedPhase)).toMatchObject({ kind: 'appended', event: { eventId: 'shared-event' } });
    expect(appB.appendEvent(sharedPhase)).toMatchObject({ kind: 'appended', event: { eventId: 'shared-event' } });
    expect(appA.appendEvent({ ...sharedPhase, eventId: 'lost-response-retry' })).toMatchObject({ kind: 'duplicate', event: { eventId: 'shared-event' } });
    expect(appA.appendEvent({ ...sharedPhase, eventId: 'same-app-conflict', payload: { taskGuids: ['task-2'], designatedAcceptorId: 'acceptor-1' } })).toMatchObject({ kind: 'conflict' });
    expect(appA.appendUnknownObservation({ eventId: 'shared-observation', attemptedEventType: 'task.reviewed', sourceRef: 'topic-message:om_shared', idempotencyKey: 'shared-observation-key' })).toMatchObject({ kind: 'appended' });
    expect(appB.appendUnknownObservation({ eventId: 'shared-observation', attemptedEventType: 'task.reviewed', sourceRef: 'topic-message:om_shared', idempotencyKey: 'shared-observation-key' })).toMatchObject({ kind: 'appended' });
    expect(appA.registerTrustedMapping(trustedMappingInput())).toMatchObject({ kind: 'registered' });
    expect(appB.registerTrustedMapping(trustedMappingInput())).toMatchObject({ kind: 'registered' });
    appA.close();
    appB.close();
    const verify = new DatabaseSync(join(dir, 'botmux-task-control-plane.sqlite'), { readOnly: true });
    try {
      expect(verify.prepare(`SELECT COUNT(*) AS n FROM control_events WHERE event_id='shared-event'`).get()).toEqual({ n: 2 });
      expect(verify.prepare(`SELECT COUNT(*) AS n FROM control_observations WHERE event_id='shared-observation'`).get()).toEqual({ n: 2 });
      expect(verify.prepare(`SELECT COUNT(*) AS n FROM control_trusted_mappings WHERE dispatch_root='om_root_1'`).get()).toEqual({ n: 2 });
    } finally { verify.close(); }
  });

  it('isolates outbox, receipts, and approval consumption when both apps use the same logical identifiers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task-control-app-durable-scope-'));
    dirs.push(dir);
    const appA = await TaskControlPlaneStore.open(dir, authority, 'controller-a');
    const appB = await TaskControlPlaneStore.open(dir, authority, 'controller-b');
    const appendDelivery = (store: TaskControlPlaneStore): string => {
      store.appendEvent(event('phase', 'phase.opened', {
        eventId: 'shared-phase', idempotencyKey: 'shared-phase-key', payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' },
      }));
      store.appendEvent(taskEvent('mapping', 'mapping.registered', {
        eventId: 'shared-mapping', idempotencyKey: 'shared-mapping-key', payload: { ownerId: 'worker-1' },
      }));
      store.appendEvent(taskEvent('delivery', 'task.delivered', {
        eventId: 'shared-delivery', idempotencyKey: 'shared-delivery-key', terminal: true,
        occurredAt: '2026-09-05T00:00:00.000Z',
        payload: { docToken: 'doc-shared', docRevision: 1 }, deliverTo: ['topic-message:om_shared'],
      }));
      const claimed = store.claimOutbox({ now: Date.parse('2026-09-06T00:01:00.000Z'), limit: 1, claimToken: 'shared-claim' });
      expect(claimed).toEqual([expect.objectContaining({ eventId: 'shared-delivery', outboxId: expect.any(String) })]);
      expect(store.settleOutboxDelivered(claimed[0]!.outboxId, 'shared-claim', {
        receiptRef: TaskControlPlaneStore.providerReceiptRef('shared-delivery', 'topic-message:om_shared', 'topic-message:om_provider'),
      })).toBe(true);
      return claimed[0]!.outboxId;
    };
    const outboxA = appendDelivery(appA);
    const outboxB = appendDelivery(appB);
    expect(appA.listOutbox({ eventId: 'shared-delivery' })).toEqual([expect.objectContaining({ status: 'delivered' })]);
    expect(appB.listOutbox({ eventId: 'shared-delivery' })).toEqual([expect.objectContaining({ status: 'delivered' })]);
    expect(appA.listReceipts('shared-delivery')).toEqual([expect.objectContaining({ state: 'delivered' })]);
    expect(appB.listReceipts('shared-delivery')).toEqual([expect.objectContaining({ state: 'delivered' })]);
    appA.close();
    appB.close();
    const path = join(dir, 'botmux-task-control-plane.sqlite');
    const write = new DatabaseSync(path);
    try {
      write.exec('PRAGMA foreign_keys=ON;');
      for (const [appId, outboxId] of [['controller-a', outboxA], ['controller-b', outboxB]] as const) {
        write.prepare(`INSERT INTO control_approval_consumptions(
          lark_app_id,approval_ref,project_id,phase_id,task_set_hash,acceptor_id,freeze_idempotency_key,frozen_event_id,approved_at,consumed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          appId, 'approval:shared', 'project-1', 'phase-1', 'sha256:shared', 'acceptor-1', 'shared-freeze-key', 'shared-delivery',
          '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:01.000Z',
        );
        write.prepare(`INSERT INTO control_delivery_receipts(
          lark_app_id,receipt_id,outbox_id,event_id,destination_id,attempt,state,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`).run(
          appId, 'shared-receipt-id', outboxId, 'shared-delivery', 'topic-message:om_shared', 1, 'retry_scheduled', '2026-09-05T00:00:02.000Z',
        );
      }
    } finally { write.close(); }
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      expect(verify.prepare(`SELECT COUNT(*) AS n FROM control_events WHERE event_id='shared-delivery' AND idempotency_key='shared-delivery-key'`).get()).toEqual({ n: 2 });
      expect(verify.prepare(`SELECT COUNT(*) AS n FROM control_outbox WHERE event_id='shared-delivery'`).get()).toEqual({ n: 2 });
      expect(verify.prepare(`SELECT COUNT(*) AS n FROM control_delivery_receipts WHERE receipt_id='shared-receipt-id'`).get()).toEqual({ n: 2 });
      expect(verify.prepare(`SELECT COUNT(*) AS n FROM control_approval_consumptions WHERE approval_ref='approval:shared' AND freeze_idempotency_key='shared-freeze-key'`).get()).toEqual({ n: 2 });
      expect(verify.prepare('SELECT * FROM pragma_foreign_key_check').all()).toEqual([]);
    } finally { verify.close(); }
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
  it('settles delivered only with an exact receipt for the same terminal event and destination', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.delivered', {
      terminal: true, payload: { docToken: 'doc', docRevision: 1 }, deliverTo: ['topic-message:om_exact'],
    }));
    const [row] = store.claimOutbox({ now: Date.parse('2026-09-04T00:00:04.000Z'), limit: 1, claimToken: 'claim' });
    expect(store.settleOutboxDelivered(row.outboxId, 'claim', {
      receiptRef: TaskControlPlaneStore.providerReceiptRef('evt_03', 'topic-message:om_exact', 'topic-message:om_provider_one'),
    })).toBe(true);
    expect(store.listOutbox()[0]).toMatchObject({ status: 'delivered' });
    store.appendEvent(taskEvent('04', 'task.delivered', {
      terminal: true, payload: { docToken: 'doc', docRevision: 2 }, deliverTo: ['topic-message:om_second'],
    }));
    expect(store.settleOutboxDeliveredByReceipt({
      eventId: 'evt_03', destinationId: 'topic-message:om_other', receiptRef: 'topic-message:om_other',
    })).toBe(false);
    expect(store.settleOutboxDeliveredByReceipt({
      eventId: 'evt_04', destinationId: 'topic-message:om_second', receiptRef: 'untrusted:receipt',
    })).toBe(false);
    const boundSecondReceipt = TaskControlPlaneStore.providerReceiptRef(
      'evt_04', 'topic-message:om_second', 'topic-message:om_provider_one',
    );
    expect(store.settleOutboxDeliveredByReceipt({
      eventId: 'evt_04', destinationId: 'topic-message:om_second', receiptRef: 'topic-message:om_provider_one',
    })).toBe(false);
    expect(store.settleOutboxDeliveredByReceipt({
      eventId: 'evt_04', destinationId: 'topic-message:om_second', receiptRef: boundSecondReceipt,
    })).toBe(true);
    expect(store.settleOutboxDeliveredByReceipt({
      eventId: 'evt_03', destinationId: 'topic-message:om_exact', receiptRef: boundSecondReceipt,
    })).toBe(false);
    expect(store.settleOutboxDeliveredByReceipt({
      eventId: 'evt_04', destinationId: 'topic-message:om_second', receiptRef: 'topic-message:om_provider_two',
    })).toBe(false);
    expect(store.listOutbox().map(row => row.status)).toEqual(['delivered', 'delivered']);
    expect(store.listReceipts('evt_03')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: 'delivered', destinationId: 'topic-message:om_exact',
        receiptRef: TaskControlPlaneStore.providerReceiptRef('evt_03', 'topic-message:om_exact', 'topic-message:om_provider_one'),
      }),
    ]));
    store.close();
  });

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

  it('claims only its exact event and destination without touching other pending rows, even after ten earlier rows', async () => {
    const { store } = await fixture();
    openPhase(store);
    for (let index = 0; index < 11; index++) {
      store.appendEvent(taskEvent(`pending-${index}`, 'task.delivered', {
        terminal: true, payload: { docToken: `doc-${index}`, docRevision: index + 1 },
        deliverTo: [`topic-message:om_pending_${index}`],
      }));
    }
    const targetEventId = 'evt_pending-10';
    const targetDestination = 'topic-message:om_pending_10';
    const claimed = store.claimOutboxForEventDestination({
      eventId: targetEventId, destinationId: targetDestination, now: Date.parse('2026-09-04T00:00:10.000Z'), claimToken: 'target-only',
    });
    expect(claimed).toMatchObject({ eventId: targetEventId, destinationId: targetDestination, status: 'inflight', claimToken: 'target-only', attempts: 1 });
    const rows = store.listOutbox();
    expect(rows.filter(row => row.status === 'inflight')).toEqual([expect.objectContaining({ outboxId: claimed!.outboxId })]);
    expect(rows.filter(row => row.status === 'pending')).toHaveLength(10);
    expect(store.settleOutboxDelivered(claimed!.outboxId, 'target-only', {
      receiptRef: TaskControlPlaneStore.providerReceiptRef(targetEventId, targetDestination, 'topic-message:om_provider_target'),
    })).toBe(true);
    expect(store.listOutbox().filter(row => row.status === 'pending')).toHaveLength(10);
    expect(store.listOutbox().filter(row => row.status === 'inflight')).toHaveLength(0);
    store.close();
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
      db.prepare('INSERT INTO control_approval_consumptions(approval_ref,lark_app_id,project_id,phase_id,task_set_hash,acceptor_id,freeze_idempotency_key,frozen_event_id,approved_at,consumed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        'approval:other', 'test:unscoped', 'project-1', 'phase-1', 'sha256:other', 'acceptor-1', 'freeze-write-collision',
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

  it('returns the immutable prior freeze for a lost-response retry after reopening', async () => {
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
    expect(reopened.freezePhase({
      eventId: 'evt_freeze_replay', projectId: 'project-1', phaseId: 'phase-1',
      authentication: 'acceptor', approval: 'proof', idempotencyKey: 'freeze-durable',
    })).toMatchObject({ kind: 'frozen', event: { eventId: 'evt_freeze_durable' } });
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
      const verifier = new (await import(${JSON.stringify(new URL('../src/services/task-control-plane-reviewer-verdict.ts', import.meta.url).href)})).DaemonReviewerVerdictProvider({
        key: Buffer.from('store-reviewer-verdict-test-key'), keyId: 'store-reviewer-key', now: () => Date.parse('2026-09-04T00:30:00.000Z'),
      });
      store.setReviewerVerdictVerifier(verifier);
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
    appendTrustedReview(store, 'conditional-review', {
      reviewRound: 2, reviewCommentId: 'review-condition', verdict: 'conditional', conditionIds: ['condition-1'],
      docToken: 'doc-final', docRevision: 7, reviewerId: 'reviewer-2',
    });
    const validation = store.validatePhaseFreeze('project-1', 'phase-1');
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'review_conditions_unresolved', eventId: 'evt_conditional-review' }),
    ]));
    appendTrustedReview(store, 'conditional-resolved', {
      reviewRound: 3, reviewCommentId: 'review-condition-resolved', verdict: 'conditional', conditionIds: ['condition-1'],
      resolvedConditionEvidence: { 'condition-1': { evidenceRef: 'task-comment:99', observedAt: '2026-09-04T00:30:00.000Z' } },
      docToken: 'doc-final', docRevision: 7, reviewerId: 'reviewer-2',
    });
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues.map(issue => issue.code))
      .not.toContain('review_conditions_unresolved');
    store.close();
  });

  it('rejects malformed and mismatched structured condition evidence before it can become a review fact', async () => {
    const { store } = await fixture();
    openPhase(store);
    const base = {
      actorId: 'reviewer-1', actorRole: 'reviewer' as const,
      payload: {
        reviewRound: 1, reviewCommentId: 'condition-negative', independent: true, verdict: 'conditional',
        conditionIds: ['condition-1'], reviewerVerdictId: 'unverified-verdict', docToken: 'doc-final', docRevision: 7,
      },
    };
    expect(() => store.appendEvent(taskEvent('condition-bare', 'task.reviewed', {
      ...base, payload: { ...base.payload, resolvedConditionEvidence: { 'condition-1': 'task-comment:101' } },
    }))).toThrow('task_control_invalid:payload.resolvedConditionEvidence.condition-1');
    expect(() => store.appendEvent(taskEvent('condition-no-time', 'task.reviewed', {
      ...base, payload: { ...base.payload, resolvedConditionEvidence: { 'condition-1': { evidenceRef: 'task-comment:101' } } },
    }))).toThrow('task_control_invalid:payload.resolvedConditionEvidence.condition-1.observedAt');
    expect(() => store.appendEvent(taskEvent('condition-wrong-id', 'task.reviewed', {
      ...base, payload: {
        ...base.payload,
        resolvedConditionEvidence: { 'condition-other': { evidenceRef: 'task-comment:101', observedAt: '2026-09-04T00:30:00.000Z' } },
      },
    }))).toThrow('task_control_invalid:payload.resolvedConditionEvidence_unknown_condition');
    expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType)).not.toContain('task.reviewed');
    store.close();
  });

  it('rejects a direct rework event unless its current FAIL verdict and a fresh execution binding both verify', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.accepted', { actorId: 'worker-1', actorRole: 'worker' }));
    store.appendEvent(taskEvent('04', 'task.execution_started', { actorId: 'worker-1', actorRole: 'worker' }));
    store.appendEvent(taskEvent('05', 'task.first_submitted', {
      actorId: 'worker-1', actorRole: 'worker', payload: { docToken: 'doc-final', docRevision: 7 },
    }));
    const verdictId = appendTrustedReview(store, '06', {
      reviewRound: 1, reviewCommentId: 'failed-review', verdict: 'fail', docToken: 'doc-final', docRevision: 7,
    });
    expect(() => store.appendEvent(taskEvent('rework-old-execution', 'task.rework_started', {
      actorId: 'worker-1', actorRole: 'worker',
      payload: { sourceReviewerVerdictId: verdictId, newExecutionEventId: 'evt_04' },
    }))).toThrow('task_control_rework_source_unproven');
    expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType)).not.toContain('task.rework_started');
    store.close();
  });

  it('records a fresh execution after FAIL while reviewing, then enters rework without a transition violation', async () => {
    const { store } = await fixture();
    openPhase(store);
    store.appendEvent(taskEvent('03', 'task.accepted', { actorId: 'worker-1', actorRole: 'worker' }));
    store.appendEvent(taskEvent('04', 'task.execution_started', { actorId: 'worker-1', actorRole: 'worker' }));
    store.appendEvent(taskEvent('05', 'task.first_submitted', {
      actorId: 'worker-1', actorRole: 'worker', payload: { docToken: 'doc-final', docRevision: 7 },
    }));
    const verdictId = appendTrustedReview(store, '06', {
      reviewRound: 1, reviewCommentId: 'failed-review', verdict: 'fail', docToken: 'doc-final', docRevision: 7,
    });
    store.appendEvent(taskEvent('07', 'task.execution_started', { actorId: 'worker-1', actorRole: 'worker' }));
    expect(store.getTaskProjection('task-1', '2026-09-04T00:30:00.000Z')).toMatchObject({ state: 'reviewing', transitionViolations: [] });
    store.appendEvent(taskEvent('08', 'task.rework_started', {
      actorId: 'worker-1', actorRole: 'worker',
      payload: { sourceReviewerVerdictId: verdictId, newExecutionEventId: 'evt_07' },
    }));
    expect(store.getTaskProjection('task-1', '2026-09-04T00:30:00.000Z')).toMatchObject({ state: 'rework', transitionViolations: [] });
    store.close();
  });

  it('blocks public freeze and preserves immutable conflict evidence when a verdict id is replayed with different canonical content', async () => {
    const { store } = await fixture();
    seedFreezableTask(store, { declareUnknown: true, degradedFallback: 'verified' });
    const review = store.getTaskProjection('task-1', '2026-09-04T00:30:00.000Z').independentReview!;
    const provider = reviewerProvider();
    const conflicting = provider.issueVerdict({
      verdictId: review.reviewerVerdictId!,
      projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root_1', taskSetSnapshot: ['task-1'], reviewRound: 1,
      designatedReviewerRef: 'designated-08', reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
      sessionId: 'reviewer-session-08', workerGeneration: 1, capability: 'reviewer-capability-08',
      sourceCommentId: 'conflicting-comment', sourceVersionHash: `sha256:${'b'.repeat(64)}`,
      kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 7,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(store.appendReviewerVerdict({
      verdict: conflicting, authentication: auth('reviewer-1', 'reviewer'),
      attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'reviewer-session-08', workerGeneration: 1, capability: 'reviewer-capability-08' },
      verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-04T00:30:00.000Z',
    })).toMatchObject({ status: 'unknown', reason: 'reviewer_verdict_id_conflict' });
    expect(store.listObservations()).toEqual(expect.arrayContaining([expect.objectContaining({
      outcome: 'conflict', payload: expect.objectContaining({
        conflictKind: 'reviewer_verdict_id_canonical_hash', verdictId: review.reviewerVerdictId,
      }),
    })]));
    const rejected = store.freezePhase({
      eventId: 'freeze-conflict', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: approval('approval:conflict'), idempotencyKey: 'freeze-conflict',
      occurredAt: '2026-09-04T00:00:13.000Z',
    });
    expect(rejected).toMatchObject({ kind: 'rejected' });
    expect(rejected.validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reviewer_verdict_unverified' })]));
    expect(store.listEvents().some(event => event.eventType === 'phase.frozen')).toBe(false);
    store.close();
  });

  it('dynamically invalidates an old PASS when its designated reviewer mapping is superseded or forked', async () => {
    const { store } = await fixture();
    seedFreezableTask(store, { declareUnknown: true, degradedFallback: 'verified' });
    expect(store.validatePhaseFreeze('project-1', 'phase-1', '2026-09-04T00:30:00.000Z').ok).toBe(true);
    const p = reviewerProvider();
    const replacement = (ref: string, reviewerId: string) => p.issueDesignatedReviewer({
      designatedReviewerRef: ref, supersedesDesignatedReviewerRef: 'designated-08',
      projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root_1', taskSetSnapshot: ['task-1'], reviewRound: 1,
      reviewerId, reviewerBotAppId: 'reviewer-app', controllerId: 'actor-1', controllerBotAppId: 'test:unscoped',
      effectiveAt: '2026-09-04T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    });
    store.appendDesignatedReviewer(replacement('designation-replacement-a', 'reviewer-2'), auth('actor-1', 'controller'), value => p.verifyDesignatedReviewer(value));
    const superseded = store.validatePhaseFreeze('project-1', 'phase-1', '2026-09-04T00:30:00.000Z');
    expect(superseded.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reviewer_verdict_unverified' })]));
    store.appendDesignatedReviewer(replacement('designation-replacement-b', 'reviewer-3'), auth('actor-1', 'controller'), value => p.verifyDesignatedReviewer(value));
    const forked = store.freezePhase({
      eventId: 'freeze-designation-fork', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: approval('approval:designation-fork'), idempotencyKey: 'freeze-designation-fork',
      occurredAt: '2026-09-04T00:00:13.000Z',
    });
    expect(forked).toMatchObject({ kind: 'rejected' });
    expect(forked.validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reviewer_verdict_unverified' })]));
    expect(store.listEvents().some(event => event.eventType === 'phase.frozen')).toBe(false);
    store.close();
  });

  it('dynamically invalidates an old PASS when its designated reviewer mapping expires before freeze', async () => {
    const { store } = await fixture();
    seedFreezableTask(store, {
      declareUnknown: true, degradedFallback: 'verified', designationExpiresAt: '2026-09-04T00:31:00.000Z',
    });
    // The designation is valid when the verdict is appended at :00:30; it
    // expires before the later freeze validation.
    expect(store.getTaskProjection('task-1', '2026-09-04T00:30:00.000Z').independentReview).toBeDefined();
    const rejected = store.freezePhase({
      eventId: 'freeze-designation-expired', projectId: 'project-1', phaseId: 'phase-1',
      authentication: auth('acceptor-1', 'acceptor'), approval: approval('approval:designation-expired'), idempotencyKey: 'freeze-designation-expired',
      occurredAt: '2026-09-04T00:32:00.000Z',
    });
    expect(rejected).toMatchObject({ kind: 'rejected' });
    expect(rejected.validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reviewer_verdict_unverified' })]));
    expect(store.listEvents().some(event => event.eventType === 'phase.frozen')).toBe(false);
    store.close();
  });

  it('rejects a supersede reference from a different topic root without contaminating root A review state', async () => {
    const { store } = await fixture();
    seedFreezableTask(store, { declareUnknown: true, degradedFallback: 'verified' });
    const before = store.validatePhaseFreeze('project-1', 'phase-1', '2026-09-04T00:30:00.000Z');
    expect(before.ok).toBe(true);
    const p = reviewerProvider();
    const rootB = p.issueDesignatedReviewer({
      designatedReviewerRef: 'designation-root-b', supersedesDesignatedReviewerRef: 'designated-08',
      projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root_b', taskSetSnapshot: ['task-1'], reviewRound: 1,
      reviewerId: 'reviewer-2', reviewerBotAppId: 'reviewer-app', controllerId: 'actor-1', controllerBotAppId: 'test:unscoped',
      effectiveAt: '2026-09-04T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(() => store.appendDesignatedReviewer(rootB, auth('actor-1', 'controller'), value => p.verifyDesignatedReviewer(value)))
      .toThrow('task_control_designated_reviewer_supersedes_invalid');
    expect(store.getTaskProjection('task-1', '2026-09-04T00:30:00.000Z')).toMatchObject({
      mapping: { topicRootId: 'om_root_1' }, independentReview: { reviewerVerdictId: 'reviewer-verdict-08' },
    });
    expect(store.validatePhaseFreeze('project-1', 'phase-1', '2026-09-04T00:30:00.000Z')).toMatchObject({ ok: true });
    store.close();
  });

  it('keeps a prior conditional review condition open until later reviewer evidence resolves it', async () => {
    const { store } = await fixture();
    seedFreezableTask(store);
    appendTrustedReview(store, 'condition-open', {
      reviewRound: 2, reviewCommentId: 'condition-open', verdict: 'conditional', conditionIds: ['condition-1'],
      docToken: 'doc-final', docRevision: 7, reviewerId: 'reviewer-2',
    });
    appendTrustedReview(store, 'later-pass', {
      reviewRound: 3, reviewCommentId: 'later-pass', verdict: 'pass',
      docToken: 'doc-final', docRevision: 7, reviewerId: 'reviewer-2',
    });
    expect(store.validatePhaseFreeze('project-1', 'phase-1').issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'review_conditions_unresolved' })]));
    appendTrustedReview(store, 'condition-resolved', {
      reviewRound: 4, reviewCommentId: 'condition-resolved', verdict: 'conditional', conditionIds: ['condition-1'],
      resolvedConditionEvidence: { 'condition-1': { evidenceRef: 'task-comment:100', observedAt: '2026-09-04T00:30:00.000Z' } },
      docToken: 'doc-final', docRevision: 7, reviewerId: 'reviewer-2',
    });
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
    appendTrustedReview(store, '05', {
      reviewRound: 1, reviewCommentId: 'comment-1', verdict: 'pass', docToken: 'doc-final', docRevision: 7,
    });
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
    appendTrustedReview(store, '04', {
      reviewRound: 1, reviewCommentId: 'self-review', verdict: 'pass', docToken: 'doc-final', docRevision: 7, reviewerId: 'worker-1',
    });
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
    const late = store.appendEvent(taskEvent('14', 'task.execution_started'));
    expect(late).toMatchObject({ kind: 'conflict', conflictEvent: { eventType: 'event.conflict_detected', errorClass: 'late_after_frozen' } });
    expect(store.getPhaseProjection('project-1', 'phase-1').state).toBe('frozen');
    expect(store.appendEvent({
      ...taskEvent('15', 'task.execution_started'), idempotencyKey: 'key-03', payload: { source: 'contradiction' },
    })).toMatchObject({ kind: 'conflict', conflictEvent: { errorClass: 'idempotency_payload_conflict_after_frozen' } });
    expect(store.getPhaseProjection('project-1', 'phase-1').state).toBe('frozen');
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
