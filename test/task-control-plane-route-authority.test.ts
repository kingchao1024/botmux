import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ipcRoute,
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { TaskControlPlaneFlagError } from '../src/services/task-control-plane-runtime.js';
import { startTaskControlPlaneRuntime, type TaskControlPlaneLifecycle } from '../src/services/task-control-plane-runtime.js';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';
import { DaemonTaskControlIntegration } from '../src/services/task-control-plane-daemon-integration.js';
import {
  authorizeTaskControlMappingRoute,
  createTaskControlRouteHandlers,
  TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE,
  TASK_CONTROL_DESIGNATED_REVIEWER_RESOLVE_ROUTE,
  TASK_CONTROL_FREEZE_ROUTE,
  TASK_CONTROL_WRITE_EXECUTION_ROUTE,
  TASK_CONTROL_MAPPING_REGISTER_ROUTE,
  TASK_CONTROL_REVIEWER_INGRESS_ROUTE,
  TASK_CONTROL_REVIEWER_SOURCE_ROUTE,
  TASK_CONTROL_REVIEWER_VERDICT_ROUTE,
} from '../src/services/task-control-plane-route-authority.js';
import {
  createDaemonReviewerVerdictVerifier,
  deriveDaemonDesignatedReviewerProvider,
  deriveDaemonReviewerVerdictProvider,
  reviewerDesignationRef,
} from '../src/services/task-control-plane-reviewer-verdict.js';

const HOST_SECRET = 'task-control-route-test-host-secret';
let ipc: IpcServerHandle | undefined;
let dataDir: string | undefined;

type TestContext = {
  registrationCalls: number;
  registrationResolveCalls: number;
  freezeCalls: number;
  frozenWrites: number;
  registrationAllowed: boolean;
  approval: unknown;
  freezeMode: 'disabled' | 'frozen';
  designationCalls: number;
  reviewedCalls: number;
  unknowns: string[];
  sourceSender: string;
  sourceRoot: string;
  sourceMessageId: string;
  documentRevision: number;
  selfAppId: string;
  integrationEnabled: boolean;
  sourceReads: number;
  designationRequests: number;
  documentReads: number;
  receiverDocumentReads: number;
  seenVerdicts: Map<string, string>;
  lastForwarded?: Record<string, unknown>;
  designation?: any;
  reviewerGeneration: number;
  reviewerWorker: object;
  reviewerCapability: string;
  reviewerTurnId: string;
  reviewerRoot: string;
  controllerGeneration: number;
  controllerRoot: string;
  messageGate?: { promise: Promise<void>; release: () => void };
  designationGate?: { promise: Promise<void>; release: () => void };
  documentGate?: { promise: Promise<void>; release: () => void };
  receiverDocumentGate?: { promise: Promise<void>; release: () => void };
  sourceVersion?: string;
  realIntegrations?: Map<string, DaemonTaskControlIntegration>;
  realLifecycles?: TaskControlPlaneLifecycle[];
  controllerSessions?: Map<string, { larkAppId: string; rootMessageId: string; workerGeneration: number }>;
};

let context: TestContext;
const handlers = createTaskControlRouteHandlers({
  dataDir: () => dataDir!,
  selfLarkAppId: () => context.selfAppId,
  integration: () => context.integrationEnabled ? context.realIntegrations?.get(context.selfAppId) ?? ({
    registerMapping: () => { context.registrationCalls++; return context.registrationAllowed; },
    mapping: () => ({
      projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: ['task-1'], taskGuid: 'task-1', topicRootId: 'om_orch_root',
      ownerId: 'worker-1', reviewerId: 'controller-view-reviewer', acceptorId: 'acceptor-1', registrationRef: 'task-comment:101',
      controllerId: 'daemon:app-1', approvalGate: { approvalRef: 'approval:gate-1' }, docToken: 'doc-token-12345678',
    }),
    issueAuthentication: () => ({ kind: 'acceptor-proof' }),
    approval: () => context.approval,
    requestFreeze: () => !!context.approval,
    consumeWriteExecutionGrant: ({ candidate, action, attempt, operatorId }: any) =>
      candidate === 'candidate-c8' && action === 'git.commit' && attempt === 2 && operatorId === 'acceptor-1'
        ? { ok: true } : { ok: false, reason: 'write_execution_grant_unproven' },
    setReviewerVerdictVerifier: () => {},
    currentDesignatedReviewer: () => context.designation,
    registerVerifiedDesignatedReviewer: ({ mapping }: any) => { context.designationCalls++; context.designation = mapping; return true; },
    submitVerifiedReviewerVerdict: ({ verdict, verifier, expectedReviewerBotAppId, expectedReviewerId }: any) => {
      if (verdict.reviewerBotAppId !== expectedReviewerBotAppId || verdict.reviewerId !== expectedReviewerId) {
        return { status: 'unknown', reason: 'reviewer_verdict_designation_unproven' };
      }
      if (!verifier.verifyVerdict(verdict)) return { status: 'unknown', reason: 'reviewer_verdict_unverified' };
      if (verdict.kind === 'revocation') return { status: 'revoked', verdict };
      const canonical = JSON.stringify(verdict);
      const prior = context.seenVerdicts.get(verdict.verdictId);
      if (prior && prior !== canonical) return { status: 'unknown', reason: 'reviewer_verdict_id_conflict' };
      if (!prior) {
        context.seenVerdicts.set(verdict.verdictId, canonical);
        context.reviewedCalls++;
      }
      return { status: 'active', verdict };
    },
    reviewerVerdictUnknown: (_root: string, _id: string, reason: string) => { context.unknowns.push(reason); },
  }) : undefined,
  lifecycle: () => context.realLifecycles?.find(() => !!context.realIntegrations?.get(context.selfAppId)) ?? ({
    freeze: () => {
      context.freezeCalls++;
      if (context.freezeMode === 'disabled') throw new TaskControlPlaneFlagError('freeze_enforcement_disabled');
      context.frozenWrites++;
      return { kind: 'frozen' as const, validation: { ok: true }, event: { eventId: 'freeze-event' } } as any;
    },
  }),
  findActiveBySessionId: sessionId => context.controllerSessions?.has(sessionId) ? {
    session: { sessionId, rootMessageId: context.controllerSessions.get(sessionId)!.rootMessageId },
    larkAppId: context.controllerSessions.get(sessionId)!.larkAppId, workerGeneration: context.controllerSessions.get(sessionId)!.workerGeneration,
    managedTurnOrigin: { capability: `cap:${sessionId}`, turnId: `turn:${sessionId}` },
  } : sessionId === 'session-1' ? {
    session: { sessionId: 'session-1', rootMessageId: context.controllerRoot },
    larkAppId: 'app-1', workerGeneration: context.controllerGeneration, managedTurnOrigin: { capability: 'cap-1', turnId: 'turn-1' },
  } : undefined,
  findReviewerSession: sessionId => sessionId === 'review-session' ? {
    session: { sessionId: 'review-session', rootMessageId: context.reviewerRoot }, worker: context.reviewerWorker,
    larkAppId: 'reviewer-app', workerGeneration: context.reviewerGeneration, managedTurnOrigin: { capability: context.reviewerCapability, turnId: context.reviewerTurnId },
  } : undefined,
  listReviewerSessions: () => context.selfAppId === 'reviewer-app' ? [{
      session: { sessionId: 'review-session', rootMessageId: context.reviewerRoot }, worker: context.reviewerWorker,
      larkAppId: 'reviewer-app', workerGeneration: context.reviewerGeneration, managedTurnOrigin: { capability: context.reviewerCapability, turnId: context.reviewerTurnId },
    }] : [],
  hostSecret: () => HOST_SECRET,
  readMessageDetail: async (_app, _messageId) => {
    context.sourceReads++;
    await context.messageGate?.promise;
    return { items: [{
    message_id: context.sourceMessageId, root_id: context.sourceRoot, create_time: '2026-09-05T18:00:00.000Z',
    ...(context.sourceVersion ? { update_time: context.sourceVersion } : {}),
    sender: { id: context.sourceSender },
    }] };
  },
  readDocumentRevision: async () => {
    context.documentReads++;
    if (context.selfAppId === 'app-1') {
      context.receiverDocumentReads++;
      await context.receiverDocumentGate?.promise;
      return context.documentRevision;
    }
    await context.documentGate?.promise;
    return context.documentRevision;
  },
  resolveMappingRegistration: async (_app, input) => {
    context.registrationResolveCalls++;
    const taskGuid = input.registrationRef === 'task-comment:101' ? 'task-1' : input.registrationRef === 'task-comment:102' ? 'task-2' : undefined;
    if (!taskGuid) return undefined;
    return {
      projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: ['task-1', 'task-2'], taskGuid, topicRootId: input.dispatchRoot,
      ownerId: `worker-${taskGuid}`, reviewerId: `reviewer-${taskGuid}`, acceptorId: `acceptor-${taskGuid}`, registrationRef: input.registrationRef, registrationVersion: 'v1', docToken: 'doc-token-12345678',
      approvalGate: { runId: 'run-1', nodeId: 'gate-1', instanceId: 'gate-1#1', waitId: 'wait-1', operatorId: `acceptor-${taskGuid}`, approverPolicy: [`acceptor-${taskGuid}`] },
    };
  },
  resolveReviewerDesignation: async (controllerApp, payload) => {
    context.designationRequests++;
    await context.designationGate?.promise;
    if ((!context.realIntegrations && controllerApp !== 'app-1')
      || (!context.realIntegrations && (!context.designation || Date.parse(context.designation.expiresAt) <= Date.now()))) return { status: 409 };
    const prior = context.selfAppId;
    context.selfAppId = controllerApp;
    try {
      const response = await post(TASK_CONTROL_DESIGNATED_REVIEWER_RESOLVE_ROUTE, payload, true);
      const parsed = await response.json() as { resolved?: unknown };
      return parsed.resolved && typeof parsed.resolved === 'object'
        ? { status: response.status, resolved: parsed.resolved as any }
        : { status: response.status };
    } finally { context.selfAppId = prior; }
  },
  resolveReviewerSource: async (_app, payload) => {
    const prior = context.selfAppId;
    context.selfAppId = 'reviewer-app';
    try {
      const response = await post(TASK_CONTROL_REVIEWER_SOURCE_ROUTE, payload, true);
      const parsed = await response.json() as { source?: unknown };
      return parsed.source && typeof parsed.source === 'object'
        ? { status: response.status, source: parsed.source as any }
        : { status: response.status };
    } finally { context.selfAppId = prior; }
  },
  forwardReviewerVerdict: async (controllerApp, body) => {
    context.lastForwarded = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    const prior = context.selfAppId;
    context.selfAppId = controllerApp;
    try {
      const response = await post(TASK_CONTROL_REVIEWER_VERDICT_ROUTE, body as any, true);
      return { status: response.status };
    } finally { context.selfAppId = prior; }
  },
});

// These are the production handler factories used by daemon.ts. Registering
// them here gives the same signed HTTP boundary, rather than only calling the
// pure authority function directly.
ipcRoute('POST', TASK_CONTROL_MAPPING_REGISTER_ROUTE, handlers.mapping);
ipcRoute('POST', TASK_CONTROL_FREEZE_ROUTE, handlers.freeze);
ipcRoute('POST', TASK_CONTROL_WRITE_EXECUTION_ROUTE, handlers.writeExecution);
ipcRoute('POST', TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, handlers.designatedReviewer);
ipcRoute('POST', TASK_CONTROL_DESIGNATED_REVIEWER_RESOLVE_ROUTE, handlers.designatedReviewerResolve);
ipcRoute('POST', TASK_CONTROL_REVIEWER_SOURCE_ROUTE, handlers.reviewerSource);
ipcRoute('POST', TASK_CONTROL_REVIEWER_INGRESS_ROUTE, handlers.reviewerIngress);
ipcRoute('POST', TASK_CONTROL_REVIEWER_VERDICT_ROUTE, handlers.reviewerVerdict);

afterEach(async () => {
  await ipc?.close();
  ipc = undefined;
  setIpcAuthSecret(null);
  await Promise.all(context?.realLifecycles?.map(lifecycle => lifecycle.close()) ?? []);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function server(): Promise<IpcServerHandle> {
  if (!ipc) {
    setIpcAuthSecret(HOST_SECRET);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  }
  return ipc;
}

function reset(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'task-control-route-'));
  context = {
    registrationCalls: 0, registrationResolveCalls: 0, freezeCalls: 0, frozenWrites: 0, registrationAllowed: true, approval: undefined, freezeMode: 'disabled',
    designationCalls: 0, reviewedCalls: 0, unknowns: [], sourceSender: 'reviewer-open-id', sourceRoot: 'om_orch_root', sourceMessageId: 'om_review',
    documentRevision: 9, selfAppId: 'app-1', integrationEnabled: true, sourceReads: 0, designationRequests: 0, documentReads: 0, receiverDocumentReads: 0, seenVerdicts: new Map(),
    reviewerGeneration: 3, reviewerWorker: {}, reviewerCapability: 'review-cap', reviewerTurnId: 'review-turn', reviewerRoot: 'om_orch_root',
    controllerGeneration: 7, controllerRoot: 'om_orch_root',
  };
}

function mappingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dispatchRoot: 'om_orch_root', originCapability: 'cap-1', originTurnId: 'turn-1', workerGeneration: 7,
    registrationRef: 'task-comment:101',
    ...overrides,
  };
}

function designationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dispatchRoot: 'om_orch_root', controllerSessionId: 'session-1',
    originCapability: 'cap-1', originTurnId: 'turn-1', workerGeneration: 7,
    reviewerBotAppId: 'reviewer-app', sourceMessageId: 'om_review', reviewRound: 1,
    taskSetSnapshot: ['task-1'], effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
    ...overrides,
  };
}

function writeRegistry(entries: Record<string, { orchAppId: string; orchSessionId: string; orchRoot: string }> = {
  om_orch_root: { orchAppId: 'app-1', orchSessionId: 'session-1', orchRoot: 'om_orch_root' },
}): void {
  mkdirSync(dataDir!, { recursive: true });
  writeFileSync(join(dataDir!, 'orchestrate-dispatch.json'), JSON.stringify(entries), 'utf8');
}

async function post(path: string, payload: Record<string, unknown>, signed = true): Promise<Response> {
  const handle = await server();
  const headers = signed
    ? daemonIpcAuthHeaders({ secret: HOST_SECRET, port: handle.port, method: 'POST', path, headers: { 'content-type': 'application/json' } })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${handle.port}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
}

function reviewerIngressPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { sessionId: _sessionId, workerGeneration: _workerGeneration, ...rest } = overrides;
  return {
    originCapability: 'review-cap', originTurnId: 'review-turn', sourceMessageId: 'om_review',
    verdictId: 'reviewer-verdict', verdict: 'pass', docToken: 'doc-token-12345678', docRevision: 9, reviewRound: 1,
    conditionIds: [], resolvedConditionEvidence: {}, ...rest,
  };
}

function approvalSource() {
  return {
    validateBinding: () => true,
    get: ({ gate }: any) => ({
      runId: gate.runId, nodeId: gate.nodeId, instanceId: gate.instanceId, waitId: gate.waitId, operatorId: gate.operatorId,
      approvedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
    }),
  };
}

function realMapping(appId: string, dispatchRoot: string) {
  return {
    projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: ['task-1', 'task-2'], taskGuid: 'task-1', topicRootId: dispatchRoot,
    ownerId: `worker:${appId}`, reviewerId: `reviewer:${appId}`, acceptorId: `acceptor:${appId}`,
    registrationRef: `task-comment:${appId === 'app-a' ? '101' : '102'}`, registrationVersion: 'v1', docToken: 'doc-token-12345678',
    approvalGate: { runId: `run:${appId}`, nodeId: `node:${appId}`, instanceId: `node:${appId}#1`, waitId: `wait:${appId}`, operatorId: `acceptor:${appId}`, approverPolicy: [`acceptor:${appId}`] },
  };
}

async function createRealController(appId: string, dispatchRoot: string): Promise<{ integration: DaemonTaskControlIntegration; lifecycle: TaskControlPlaneLifecycle }> {
  const bridge = new DaemonTaskControlBridge({ approvals: approvalSource(), larkAppId: appId });
  const lifecycle = await startTaskControlPlaneRuntime({
    dataDir: dataDir!, larkAppId: appId, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} },
  });
  const integration = new DaemonTaskControlIntegration({
    dataDir: dataDir!, larkAppId: appId, lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} },
  });
  expect(integration.registerMapping(dispatchRoot, realMapping(appId, dispatchRoot), appId)).toBe(true);
  integration.workerAccepted(dispatchRoot, `accept:${appId}`);
  integration.workerExecutionStarted(dispatchRoot, `execute:${appId}`);
  integration.firstSubmitted(dispatchRoot, `submit:${appId}`, { docToken: 'doc-token-12345678', docRevision: 9, evidenceRef: `topic-message:om_submit_${appId}` });
  await vi.waitFor(() => expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType))
    .toEqual(expect.arrayContaining(['task.accepted', 'task.execution_started', 'task.first_submitted'])));
  return { integration, lifecycle };
}

async function createRealReviewer(): Promise<{ integration: DaemonTaskControlIntegration; lifecycle: TaskControlPlaneLifecycle }> {
  const bridge = new DaemonTaskControlBridge({ approvals: approvalSource(), larkAppId: 'reviewer-app' });
  const lifecycle = await startTaskControlPlaneRuntime({
    dataDir: dataDir!, larkAppId: 'reviewer-app', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} },
  });
  return {
    lifecycle,
    integration: new DaemonTaskControlIntegration({
      dataDir: dataDir!, larkAppId: 'reviewer-app', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} },
    }),
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release };
}

function input() {
  return {
    transportTrusted: true, selfLarkAppId: 'app-1',
    registry: { orchAppId: 'app-1', orchSessionId: 'session-1', orchRoot: 'om_orch_root' },
    liveSession: {
      sessionId: 'session-1', larkAppId: 'app-1', rootMessageId: 'om_orch_root', workerGeneration: 7,
      managedTurnOrigin: { capability: 'cap-1', turnId: 'turn-1' },
    },
    originCapability: 'cap-1', originTurnId: 'turn-1', workerGeneration: 7,
  };
}

describe('task-control mapping route authority', () => {
  it('requires transport, registry, current session/generation/capability and exact bot identity', () => {
    expect(authorizeTaskControlMappingRoute(input())).toEqual({ ok: true, controllerId: 'app-1' });
    expect(authorizeTaskControlMappingRoute({ ...input(), transportTrusted: false })).toMatchObject({ ok: false, error: 'transport_untrusted' });
    expect(authorizeTaskControlMappingRoute({ ...input(), registry: { ...input().registry, orchAppId: 'app-other' } })).toMatchObject({ ok: false, error: 'registry_unproven' });
    expect(authorizeTaskControlMappingRoute({ ...input(), liveSession: { ...input().liveSession, sessionId: 'session-other' } })).toMatchObject({ ok: false, error: 'session_unproven' });
    expect(authorizeTaskControlMappingRoute({ ...input(), workerGeneration: 6 })).toMatchObject({ ok: false, error: 'generation_unproven' });
    expect(authorizeTaskControlMappingRoute({ ...input(), originCapability: 'stale-cap' })).toMatchObject({ ok: false, error: 'capability_unproven' });
  });
});

describe('task-control mapping/freeze controlled IPC', () => {
  it('returns 401 before handler execution for an unsigned request', async () => {
    reset();
    const response = await post(TASK_CONTROL_MAPPING_REGISTER_ROUTE, mappingPayload(), false);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(context.registrationCalls).toBe(0);
    expect(context.freezeCalls).toBe(0);
  });

  it('returns 403 for registry/capability failures without recording a mapping', async () => {
    reset();
    const absent = await post(TASK_CONTROL_MAPPING_REGISTER_ROUTE, mappingPayload());
    expect(absent.status).toBe(403);
    expect(await absent.json()).toEqual({ ok: false, error: 'task_control_mapping_registry_unproven' });
    expect(context.registrationCalls).toBe(0);

    writeRegistry();
    const stale = await post(TASK_CONTROL_MAPPING_REGISTER_ROUTE, mappingPayload({ originCapability: 'stale-capability' }));
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ ok: false, error: 'task_control_mapping_capability_unproven' });
    expect(context.registrationCalls).toBe(0);
  });

  it('returns 201 only for a host-signed exact mapping identity', async () => {
    reset();
    writeRegistry();
    const response = await post(TASK_CONTROL_MAPPING_REGISTER_ROUTE, mappingPayload());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, dispatchRoot: 'om_orch_root' });
    expect(context.registrationCalls).toBe(1);
    expect(context.registrationResolveCalls).toBe(1);
    expect(context.frozenWrites).toBe(0);
  });

  it('accepts only a registration reference and rechecks the controller turn after resolver IO', async () => {
    reset();
    writeRegistry();
    const rejectedBody = await post(TASK_CONTROL_MAPPING_REGISTER_ROUTE, { ...mappingPayload(), taskGuid: 'forged' });
    expect(rejectedBody.status).toBe(400);
    expect(context.registrationCalls).toBe(0);
    context.registrationResolveCalls = 0;
    const original = handlers;
    void original;
    context.controllerGeneration = 8;
    const stale = await post(TASK_CONTROL_MAPPING_REGISTER_ROUTE, mappingPayload());
    expect(stale.status).toBe(403);
    expect(context.registrationCalls).toBe(0);
  });

  it('keeps unproven/disabled freeze requests out of the ledger and returns 201 only after an enabled freeze', async () => {
    reset();
    const body = { dispatchRoot: 'om_orch_root', approvalRef: 'approval:gate-1', eventId: 'freeze-1', idempotencyKey: 'freeze-key-1', controllerSessionId: 'session-1', originCapability: 'cap-1', originTurnId: 'turn-1', workerGeneration: 7 };
    const unproven = await post(TASK_CONTROL_FREEZE_ROUTE, body);
    expect(unproven.status).toBe(403);
    expect(await unproven.json()).toEqual({ ok: false, error: 'task_control_freeze_session_unproven' });
    expect(context.freezeCalls).toBe(0);
    expect(context.frozenWrites).toBe(0);

    writeRegistry();
    context.approval = { kind: 'verified-v3-gate' };
    const disabled = await post(TASK_CONTROL_FREEZE_ROUTE, body);
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ ok: false, error: 'task_control_flag_invalid:freeze_enforcement_disabled' });
    expect(context.freezeCalls).toBe(1);
    expect(context.frozenWrites).toBe(0);

    context.freezeMode = 'frozen';
    const accepted = await post(TASK_CONTROL_FREEZE_ROUTE, { ...body, eventId: 'freeze-2', idempotencyKey: 'freeze-key-2' });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ ok: true, result: { kind: 'frozen' } });
    expect(context.freezeCalls).toBe(2);
    expect(context.frozenWrites).toBe(1);
  });

  it('rejects freeze from a stale controller turn before creating a freeze request', async () => {
    reset();
    writeRegistry();
    context.controllerGeneration = 8;
    const response = await post(TASK_CONTROL_FREEZE_ROUTE, {
      dispatchRoot: 'om_orch_root', approvalRef: 'approval:gate-1', eventId: 'freeze-stale', idempotencyKey: 'freeze-stale',
      controllerSessionId: 'session-1', originCapability: 'cap-1', originTurnId: 'turn-1', workerGeneration: 7,
    });
    expect(response.status).toBe(403);
    expect(context.freezeCalls).toBe(0);
  });

  it('consumes only a controller-bound exact structured write execution grant', async () => {
    reset();
    writeRegistry();
    const body = {
      dispatchRoot: 'om_orch_root', grantRef: 'grant:write-1', candidate: 'candidate-c8', action: 'git.commit', attempt: 2,
      controllerSessionId: 'session-1', originCapability: 'cap-1', originTurnId: 'turn-1', workerGeneration: 7,
    };
    const accepted = await post(TASK_CONTROL_WRITE_EXECUTION_ROUTE, body);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toEqual({ ok: true });
    const candidateDrift = await post(TASK_CONTROL_WRITE_EXECUTION_ROUTE, { ...body, candidate: 'candidate-other' });
    expect(candidateDrift.status).toBe(409);
    expect(await candidateDrift.json()).toEqual({ ok: false, reason: 'write_execution_grant_unproven' });
    const unstructured = await post(TASK_CONTROL_WRITE_EXECUTION_ROUTE, { ...body, title: 'PASS' });
    expect(unstructured.status).toBe(400);
    context.controllerGeneration = 8;
    const stale = await post(TASK_CONTROL_WRITE_EXECUTION_ROUTE, body);
    expect(stale.status).toBe(403);
  });

  it('uses app-scoped source re-read for designation and accepts only a current reviewer ingress', async () => {
    reset();
    writeRegistry();
    const designation = await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload());
    expect(designation.status).toBe(201);
    expect(context.designation).toMatchObject({ reviewerId: 'reviewer-open-id', reviewerBotAppId: 'reviewer-app' });
    context.selfAppId = 'reviewer-app';

    const ingress = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, reviewerIngressPayload({ verdictId: 'rv-production-1' }), false);
    expect(ingress.status).toBe(201);
    expect(context.reviewedCalls).toBe(1);
  });

  it('replaces a same-app designation with a new signed ref and forwards a signed revocation', async () => {
    reset();
    writeRegistry();
    context.sourceMessageId = 'om_review_1';
    const first = await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload({ sourceMessageId: 'om_review_1' }));
    expect(first.status).toBe(201);
    const firstRef = (await first.json() as { designatedReviewerRef: string }).designatedReviewerRef;
    context.sourceMessageId = 'om_review_2';
    const replacement = await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload({
      sourceMessageId: 'om_review_2', supersedesDesignatedReviewerRef: firstRef,
    }));
    expect(replacement.status).toBe(201);
    const replacementRef = (await replacement.json() as { designatedReviewerRef: string }).designatedReviewerRef;
    expect(replacementRef).not.toBe(firstRef);
    expect(context.designation).toMatchObject({ designatedReviewerRef: replacementRef, supersedesDesignatedReviewerRef: firstRef });

    context.selfAppId = 'reviewer-app';
    const revocation = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, reviewerIngressPayload({
      sourceMessageId: 'om_review_2', verdictId: 'rv-revoke-1', verdict: 'revocation',
      revokesVerdictId: 'prior-pass-verdict', conditionIds: [], resolvedConditionEvidence: {},
    }), false);
    expect(revocation.status).toBe(201);
    expect(context.lastForwarded?.verdict).toMatchObject({ kind: 'revocation', revokesVerdictId: 'prior-pass-verdict' });
  });

  it('forwards an ordinary signed superseding verdict while keeping revocation mutually exclusive', async () => {
    reset();
    writeRegistry();
    expect((await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload())).status).toBe(201);
    context.selfAppId = 'reviewer-app';
    const supersede = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, reviewerIngressPayload({
      verdictId: 'rv-supersede-1', verdict: 'pass', supersedesVerdictId: 'prior-pass-verdict', conditionIds: [], resolvedConditionEvidence: {},
    }), false);
    expect(supersede.status).toBe(201);
    expect(context.lastForwarded?.verdict).toMatchObject({ kind: 'verdict', verdict: 'pass', supersedesVerdictId: 'prior-pass-verdict' });
    const mutuallyExclusive = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, reviewerIngressPayload({
      verdictId: 'rv-invalid-chain', verdict: 'pass', supersedesVerdictId: 'prior-pass-verdict', revokesVerdictId: 'other',
    }), false);
    expect(mutuallyExclusive.status).toBe(400);
  });

  it('requires current controller turn authority before and after resolving the reviewer source', async () => {
    reset();
    writeRegistry();
    const unsigned = await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload(), false);
    expect(unsigned.status).toBe(401);
    expect(context.designationCalls).toBe(0);

    const stale = await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload({ originCapability: 'stale-cap' }));
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: 'task_control_designated_reviewer_capability_unproven' });
    expect(context.sourceReads).toBe(0);
    expect(context.designationCalls).toBe(0);
    expect((await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload({ controllerSessionId: 'stale-session' }))).status).toBe(403);
    expect(context.sourceReads).toBe(0);
    expect(context.designationCalls).toBe(0);

    const gate = deferred();
    context.messageGate = gate;
    const pending = post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload());
    await vi.waitFor(() => expect(context.sourceReads).toBe(1), { timeout: 100 });
    context.controllerGeneration = 8;
    gate.release();
    const changed = await pending;
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: 'task_control_designated_reviewer_origin_changed' });
    expect(context.designationCalls).toBe(0);
  });

  it('fails closed when reviewer generation changes during any external ingress await', async () => {
    const stages: Array<keyof Pick<TestContext, 'messageGate' | 'designationGate' | 'documentGate'>> = ['messageGate', 'designationGate', 'documentGate'];
    for (const stage of stages) {
      reset();
      writeRegistry();
      expect((await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload())).status).toBe(201);
      context.selfAppId = 'reviewer-app';
      const gate = deferred();
      context[stage] = gate;
      const before = stage === 'messageGate' ? context.sourceReads : stage === 'designationGate' ? context.designationRequests : context.documentReads;
      const pending = post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, reviewerIngressPayload({ verdictId: `replace-${stage}` }), false);
      await vi.waitFor(() => expect(
        stage === 'messageGate' ? context.sourceReads : stage === 'designationGate' ? context.designationRequests : context.documentReads,
      ).toBe(before + 1), { timeout: 100 });
      context.reviewerGeneration = 4;
      context.reviewerWorker = {};
      context.reviewerCapability = 'replacement-cap';
      context.reviewerTurnId = 'replacement-turn';
      gate.release();
      const response = await pending;
      expect(response.status, stage).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'task_control_reviewer_ingress_origin_changed' });
      expect(context.reviewedCalls, stage).toBe(0);
    }
  });

  it('re-reads the reviewer source after designation and document awaits', async () => {
    reset();
    writeRegistry();
    expect((await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload())).status).toBe(201);
    context.selfAppId = 'reviewer-app';
    const gate = deferred();
    context.documentGate = gate;
    const pending = post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, reviewerIngressPayload({ verdictId: 'source-toctou' }), false);
    await vi.waitFor(() => expect(context.documentReads).toBe(1), { timeout: 100 });
    context.sourceVersion = '2026-09-05T18:01:00.000Z';
    gate.release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'task_control_reviewer_ingress_source_changed' });
    expect(context.sourceReads).toBe(3);
    expect(context.reviewedCalls).toBe(0);
  });

  it('rejects a receiver verdict when controller mapping/live binding changes during its document read', async () => {
    reset();
    writeRegistry();
    expect((await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload())).status).toBe(201);
    context.selfAppId = 'reviewer-app';
    expect((await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, reviewerIngressPayload({ verdictId: 'controller-race' }), false)).status).toBe(201);
    const forwarded = structuredClone(context.lastForwarded!);
    context.selfAppId = 'app-1';
    const gate = deferred();
    context.receiverDocumentGate = gate;
    const pending = post(TASK_CONTROL_REVIEWER_VERDICT_ROUTE, forwarded);
    await vi.waitFor(() => expect(context.receiverDocumentReads).toBe(1), { timeout: 100 });
    writeFileSync(join(dataDir!, 'orchestrate-dispatch.json'), JSON.stringify({
      om_orch_root: { orchAppId: 'app-1', orchSessionId: 'session-1', orchRoot: 'om_controller_replaced' },
    }), 'utf8');
    gate.release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'task_control_reviewer_verdict_controller_unproven' });
    expect(context.reviewedCalls).toBe(1);
  });

  it('routes the same verdict id through two real controller stores without cross-app collision, while same-app replay/conflict stay exact', async () => {
    reset();
    const rootA = 'om_controller_a';
    const rootB = 'om_controller_b';
    const controllerA = await createRealController('app-a', rootA);
    const controllerB = await createRealController('app-b', rootB);
    context.realIntegrations = new Map([['app-a', controllerA.integration], ['app-b', controllerB.integration]]);
    context.realLifecycles = [controllerA.lifecycle, controllerB.lifecycle];
    context.controllerSessions = new Map([
      ['session-a', { larkAppId: 'app-a', rootMessageId: rootA, workerGeneration: 1 }],
      ['session-b', { larkAppId: 'app-b', rootMessageId: rootB, workerGeneration: 1 }],
    ]);
    writeRegistry({
      [rootA]: { orchAppId: 'app-a', orchSessionId: 'session-a', orchRoot: rootA },
      [rootB]: { orchAppId: 'app-b', orchSessionId: 'session-b', orchRoot: rootB },
    });

    const designations = new Map<string, { ref: string }>();
    const makeForwarded = (appId: string, root: string, input: { verdictId?: string; verdict?: 'pass' | 'fail'; sourceVersion?: string } = {}) => {
      const integration = context.realIntegrations!.get(appId)!;
      const mapping = integration.mapping(root)!;
      let designation = designations.get(appId);
      if (!designation) {
        const provider = deriveDaemonDesignatedReviewerProvider({ hostSecret: HOST_SECRET, controllerBotAppId: appId });
        const issued = provider.issueDesignatedReviewer({
          designatedReviewerRef: reviewerDesignationRef(root, 'reviewer-app', 1),
          projectId: mapping.projectId, phaseId: mapping.phaseId, taskGuid: mapping.taskGuid, topicRootId: mapping.topicRootId, taskSetSnapshot: mapping.phaseTaskGuids, reviewRound: 1,
          reviewerId: 'reviewer-open-id', reviewerBotAppId: 'reviewer-app', controllerId: appId, controllerBotAppId: appId,
          effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
        });
        const verifier = createDaemonReviewerVerdictVerifier({ hostSecret: HOST_SECRET, controllerBotAppId: appId });
        expect(integration.registerVerifiedDesignatedReviewer({ mapping: issued, verifier })).toBe(true);
        designation = { ref: issued.designatedReviewerRef };
        designations.set(appId, designation);
      }
      const signer = deriveDaemonReviewerVerdictProvider({ hostSecret: HOST_SECRET, reviewerBotAppId: 'reviewer-app' });
      const verdict = signer.issueVerdict({
        verdictId: input.verdictId ?? 'same-verdict-id', projectId: mapping.projectId, phaseId: mapping.phaseId, taskGuid: mapping.taskGuid, topicRootId: mapping.topicRootId, taskSetSnapshot: mapping.phaseTaskGuids, reviewRound: 1,
        designatedReviewerRef: designation.ref, reviewerId: 'reviewer-open-id', reviewerBotAppId: 'reviewer-app',
        sessionId: `review-session:${appId}`, workerGeneration: 1, capability: `review-cap:${appId}`, sourceMessageId: `om_review_${appId}`,
        sourceVersionHash: `sha256:${(input.sourceVersion ?? (appId === 'app-a' ? 'a' : 'b')).repeat(64)}`, kind: 'verdict', verdict: input.verdict ?? 'pass', conditionIds: [], resolvedConditionEvidence: {},
        docToken: mapping.docToken!, docRevision: 9, issuedAt: '2026-09-05T18:00:00.000Z', expiresAt: '2099-05-05T18:00:00.000Z',
      });
      return { dispatchRoot: root, verdict, attestation: { reviewerId: 'reviewer-open-id', reviewerBotAppId: 'reviewer-app', sessionId: verdict.sessionId, workerGeneration: 1, capabilityHash: verdict.capabilityHash } };
    };
    const firstA = makeForwarded('app-a', rootA);
    const firstB = makeForwarded('app-b', rootB);
    context.selfAppId = 'app-a';
    expect((await post(TASK_CONTROL_REVIEWER_VERDICT_ROUTE, firstA)).status).toBe(201);
    context.selfAppId = 'app-b';
    expect((await post(TASK_CONTROL_REVIEWER_VERDICT_ROUTE, firstB)).status).toBe(201);
    expect(controllerA.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(1);
    expect(controllerB.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(1);

    context.selfAppId = 'app-a';
    expect((await post(TASK_CONTROL_REVIEWER_VERDICT_ROUTE, firstA)).status).toBe(201);
    expect(controllerA.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(1);
    const conflict = makeForwarded('app-a', rootA, { verdict: 'fail', sourceVersion: 'c' });
    expect((await post(TASK_CONTROL_REVIEWER_VERDICT_ROUTE, conflict)).status).toBe(409);
    expect(controllerA.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(1);

    const appendFailure = makeForwarded('app-a', rootA, { verdictId: 'append-failure' });
    const injected = new DatabaseSync(controllerA.lifecycle.getStore()!.path);
    try {
      injected.exec(`CREATE TRIGGER reject_append_failure_review BEFORE INSERT ON control_events
        WHEN NEW.event_type='task.reviewed' AND NEW.event_id='tcp-task.reviewed:reviewer-verdict:append-failure'
        BEGIN SELECT RAISE(ABORT,'injected_review_append_failure'); END;`);
    } finally { injected.close(); }
    expect((await post(TASK_CONTROL_REVIEWER_VERDICT_ROUTE, appendFailure)).status).toBe(409);
    expect(controllerA.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(1);
  });

  it('drives the real reviewer action path into two controller stores without caller-selected controller or reviewer identity', async () => {
    reset();
    const reviewer = await createRealReviewer();
    const controllerA = await createRealController('app-a', 'om_controller_a');
    const controllerB = await createRealController('app-b', 'om_controller_b');
    context.realIntegrations = new Map([
      ['reviewer-app', reviewer.integration], ['app-a', controllerA.integration], ['app-b', controllerB.integration],
    ]);
    context.realLifecycles = [reviewer.lifecycle, controllerA.lifecycle, controllerB.lifecycle];
    context.selfAppId = 'reviewer-app';
    expect(reviewer.integration.registerMapping('om_controller_a', {
      ...realMapping('app-a', 'om_controller_a'), reviewerId: 'reviewer-open-id',
    }, 'reviewer-app')).toBe(true);
    context.controllerSessions = new Map([
      ['session-a', { larkAppId: 'app-a', rootMessageId: 'om_controller_a', workerGeneration: 1 }],
      ['session-b', { larkAppId: 'app-b', rootMessageId: 'om_controller_b', workerGeneration: 1 }],
    ]);
    writeRegistry({
      om_controller_a: { orchAppId: 'app-a', orchSessionId: 'session-a', orchRoot: 'om_controller_a' },
      om_controller_b: { orchAppId: 'app-b', orchSessionId: 'session-b', orchRoot: 'om_controller_b' },
    });

    const register = async (appId: string, root: string) => {
      context.selfAppId = appId;
      context.sourceRoot = root;
      const response = await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload({
        dispatchRoot: root, controllerSessionId: `session-${appId.slice(-1)}`, originCapability: `cap:session-${appId.slice(-1)}`,
        originTurnId: `turn:session-${appId.slice(-1)}`, workerGeneration: 1, taskSetSnapshot: ['task-1', 'task-2'],
      }));
      expect(response.status).toBe(201);
    };
    await register('app-a', 'om_controller_a');
    await register('app-b', 'om_controller_b');
    context.selfAppId = 'reviewer-app';
    context.reviewerRoot = 'om_controller_a';
    context.sourceRoot = 'om_controller_a';
    const first = reviewerIngressPayload({ verdictId: 'same-verdict-id', docToken: 'doc-token-12345678' });
    context.documentRevision = 10;
    expect((await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, first, false)).status).toBe(409);
    expect(controllerA.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(0);
    context.documentRevision = 9;
    const firstResponse = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, first, false);
    expect(firstResponse.status).toBe(201);
    expect((await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, first, false)).status).toBe(201);
    context.reviewerRoot = 'om_controller_b';
    context.sourceRoot = 'om_controller_b';
    expect((await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, first, false)).status).toBe(201);
    expect(controllerA.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(1);
    expect(controllerB.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(1);
    context.reviewerRoot = 'om_controller_a';
    expect((await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...first, verdict: 'fail' }, false)).status).toBe(409);
    expect(controllerA.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(1);
    const injected = new DatabaseSync(controllerA.lifecycle.getStore()!.path);
    try {
      injected.exec(`CREATE TRIGGER reject_reviewer_action_append BEFORE INSERT ON control_events
        WHEN NEW.event_type='task.reviewed' AND NEW.event_id='tcp-task.reviewed:reviewer-verdict:append-failure'
        BEGIN SELECT RAISE(ABORT,'injected_reviewer_action_append_failure'); END;`);
    } finally { injected.close(); }
    expect((await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...first, verdictId: 'append-failure' }, false)).status).toBe(409);
    expect(controllerA.lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.reviewed')).toHaveLength(1);
    expect((await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...first, controllerLarkAppId: 'forged' }, false)).status).toBe(400);
  });

  it('derives the controller solely from the exact dispatch registry and rejects redirect/forged app bodies without review', async () => {
    reset();
    writeRegistry();
    expect((await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload())).status).toBe(201);
    context.selfAppId = 'reviewer-app';
    const base = reviewerIngressPayload({ verdictId: 'registry-derived' });
    const redirected = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...base, controllerLarkAppId: 'attacker-app' }, false);
    expect(redirected.status).toBe(400);
    expect(context.reviewedCalls).toBe(0);

    writeFileSync(join(dataDir!, 'orchestrate-dispatch.json'), JSON.stringify({
      om_orch_root: { orchAppId: 'attacker-app', orchSessionId: 'attacker-session', orchRoot: 'om_attacker_root' },
    }), 'utf8');
    const forgedRegistry = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, base, false);
    expect(forgedRegistry.status).toBe(409);
    expect(await forgedRegistry.json()).toMatchObject({ error: 'task_control_reviewer_ingress_designation_unproven' });
    expect(context.reviewedCalls).toBe(0);
  });

  it('requires the exact derived keyId in every production forwarded verdict', async () => {
    reset();
    writeRegistry();
    expect((await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload())).status).toBe(201);
    context.selfAppId = 'reviewer-app';
    expect((await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, reviewerIngressPayload({ verdictId: 'keyid-happy' }), false)).status).toBe(201);
    expect(context.reviewedCalls).toBe(1);
    const forwarded = context.lastForwarded!;
    expect((forwarded.verdict as Record<string, unknown>).keyId).toMatch(/^rv1:[a-f0-9]{64}$/);

    const variants = [
      (() => { const value = structuredClone(forwarded); delete (value.verdict as Record<string, unknown>).keyId; return value; })(),
      (() => { const value = structuredClone(forwarded); (value.verdict as Record<string, unknown>).keyId = ''; return value; })(),
      (() => { const value = structuredClone(forwarded); (value.verdict as Record<string, unknown>).keyId = `rv1:${'0'.repeat(64)}`; return value; })(),
    ];
    context.selfAppId = 'app-1';
    for (const body of variants) {
      const response = await post(TASK_CONTROL_REVIEWER_VERDICT_ROUTE, body);
      expect([400, 409]).toContain(response.status);
      expect(context.reviewedCalls).toBe(1);
    }
  });

  it('fails closed for forged reviewer identity, stale generation/capability, source/root/doc mismatch, and leaves review calls at zero', async () => {
    reset();
    writeRegistry();
    const designation = await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload());
    expect(designation.status).toBe(201);
    context.selfAppId = 'reviewer-app';
    const base = reviewerIngressPayload({ verdictId: 'rv-production-negative' });
    for (const [override, expected] of [
      [{ originCapability: 'forged' }, 'task_control_reviewer_ingress_origin_unproven'],
      [{ sourceMessageId: 'om_other' }, 'task_control_reviewer_ingress_source_unproven'],
      [{ docToken: 'forged-doc' }, 'task_control_reviewer_ingress_document_unproven'],
    ] as const) {
      const response = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...base, ...override, verdictId: `${base.verdictId}-${expected}` }, false);
      expect(await response.json()).toMatchObject({ error: expected });
      expect(context.reviewedCalls).toBe(0);
    }
    context.sourceRoot = 'om_other_root';
    const wrongRoot = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...base, verdictId: 'wrong-root-verdict' }, false);
    expect(await wrongRoot.json()).toMatchObject({ error: 'task_control_reviewer_ingress_source_unproven' });
    expect(context.reviewedCalls).toBe(0);
  });

  it('rejects malformed, fractional, unsafe and non-positive numeric ingress values before source reads', async () => {
    reset();
    context.selfAppId = 'reviewer-app';
    const base = reviewerIngressPayload({ verdictId: 'numeric-invalid' });
    for (const overrides of [
      { docRevision: '9' }, { docRevision: 1.5 }, { docRevision: 0 }, { docRevision: Number.MAX_SAFE_INTEGER + 1 },
      { reviewRound: '1' }, { reviewRound: 1.5 }, { reviewRound: 0 }, { reviewRound: Number.MAX_SAFE_INTEGER + 1 },
      { workerGeneration: '3' }, { workerGeneration: 1.5 }, { workerGeneration: 0 }, { workerGeneration: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const response = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...base, ...overrides }, false);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'task_control_reviewer_ingress_invalid' });
      expect(context.sourceReads).toBe(0);
      expect(context.reviewedCalls).toBe(0);
    }
  });

  it('rejects a forwarded caller-supplied verifier/key/app or altered body before ledger review', async () => {
    reset();
    const verifier = createDaemonReviewerVerdictVerifier({ hostSecret: HOST_SECRET, controllerBotAppId: 'app-1' });
    const designationProvider = deriveDaemonReviewerVerdictProvider({ hostSecret: HOST_SECRET, reviewerBotAppId: 'reviewer-app' });
    // The route verifies the controller designation separately; this object is
    // only a current head fixture for the receiver gate.
    context.designation = designationProvider.issueDesignatedReviewer({
      designatedReviewerRef: reviewerDesignationRef('om_orch_root', 'reviewer-app', 1),
      projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_orch_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
      reviewerId: 'reviewer-open-id', reviewerBotAppId: 'reviewer-app', controllerId: 'daemon:app-1', controllerBotAppId: 'app-1',
      effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
    });
    // A mismatched controller-domain signature is not accepted as a designation.
    expect(verifier.verifyDesignatedReviewer(context.designation)).toBe(false);
    const response = await post(TASK_CONTROL_REVIEWER_VERDICT_ROUTE, {
      dispatchRoot: 'om_orch_root', verifier: 'caller-forged', keyId: 'caller-forged',
    });
    expect(response.status).toBe(400);
    expect(context.reviewedCalls).toBe(0);
  });

  it('is externally inert while the default-off integration is unavailable', async () => {
    reset();
    context.integrationEnabled = false;
    context.selfAppId = 'reviewer-app';
    const response = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, {
      dispatchRoot: 'om_orch_root', sessionId: 'review-session',
      originCapability: 'review-cap', originTurnId: 'review-turn', workerGeneration: 3, sourceMessageId: 'om_review',
      verdictId: 'disabled-verdict', verdict: 'pass', docToken: 'doc-token-12345678', docRevision: 9, reviewRound: 1,
      conditionIds: [], resolvedConditionEvidence: {},
    }, false);
    expect(response.status).toBe(503);
    expect(context.sourceReads).toBe(0);
    expect(context.reviewedCalls).toBe(0);
  });

  it('rejects expiry, conflict replay and a forged reviewer app without writing another reviewed event', async () => {
    reset();
    writeRegistry();
    const designation = await post(TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE, designationPayload());
    expect(designation.status).toBe(201);
    context.selfAppId = 'reviewer-app';
    const base = reviewerIngressPayload({ verdictId: 'replay-verdict' });
    expect((await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, base, false)).status).toBe(201);
    expect(context.reviewedCalls).toBe(1);
    const conflict = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...base, verdict: 'fail' }, false);
    expect(conflict.status).toBe(409);
    expect(context.reviewedCalls).toBe(1);

    context.designation = { ...context.designation, expiresAt: '2020-01-01T00:00:00.000Z' };
    const expired = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...base, verdictId: 'expired-verdict' }, false);
    expect(expired.status).toBe(409);
    expect(context.reviewedCalls).toBe(1);

    context.selfAppId = 'forged-reviewer-app';
    const forgedApp = await post(TASK_CONTROL_REVIEWER_INGRESS_ROUTE, { ...base, verdictId: 'forged-app-verdict' }, false);
    expect(forgedApp.status).toBe(403);
    expect(context.reviewedCalls).toBe(1);
  });
});
