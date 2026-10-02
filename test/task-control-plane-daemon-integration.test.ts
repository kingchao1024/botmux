import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonTaskControlAuthority } from '../src/services/task-control-plane-authority.js';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';
import { DaemonTaskControlIntegration } from '../src/services/task-control-plane-daemon-integration.js';
import { TaskControlPlaneStore } from '../src/services/task-control-plane-store.js';
import { startTaskControlPlaneRuntime } from '../src/services/task-control-plane-runtime.js';
import {
  createDaemonReviewerVerdictVerifier,
  DaemonReviewerVerdictProvider,
  reviewerDesignationRef,
} from '../src/services/task-control-plane-reviewer-verdict.js';
import { TaskControlMappingTrust } from '../src/services/task-control-plane-mapping-trust.js';
import {
  ProjectWorkerEvidenceRelay,
  ProjectWorkerEvidenceTrust,
} from '../src/services/task-control-plane-project-worker-evidence.js';
import { evaluateProjectCompletionGate } from '../src/services/project-group-completion-gate.js';
import { projectCompletionGateFingerprint, type ProjectGroupState } from '../src/services/project-group-store.js';


function gate() {
  return {
    runId: 'run-1', nodeId: 'gate-node', instanceId: 'gate-node#001', waitId: 'gate-node#001-gate',
    operatorId: 'acceptor-1', approverPolicy: ['acceptor-1'],
  };
}

function mapping() {
  return {
    projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: ['task-1'],
    taskGuid: 'task-1', topicRootId: 'om_root', ownerId: 'worker-1', reviewerId: 'reviewer-1',
    acceptorId: 'acceptor-1', registrationRef: 'task-comment:123', docToken: 'doc-token-12345678', approvalGate: gate(),
  };
}

function secondPhaseMapping() {
  return {
    ...mapping(), phaseTaskGuids: ['task-1', 'task-2'], taskGuid: 'task-2', topicRootId: 'om_root_2',
    registrationRef: 'task-comment:124',
  };
}

function source() {
  return {
    validateBinding: () => true,
    get: ({ gate: binding }: any) => ({
      runId: binding.runId, nodeId: binding.nodeId, instanceId: binding.instanceId, waitId: binding.waitId,
      operatorId: binding.operatorId, approvedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T00:00:00.000Z',
    }),
    getWriteExecution: ({ grantRef, candidate, action, attempt, operatorId }: any) =>
      (grantRef === 'grant:write-1' || grantRef === 'grant:write-2') && candidate === 'candidate-c8' && action === 'git.commit' && attempt === 2 && operatorId === 'acceptor-1'
        ? { issuedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z' } : undefined,
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { interval: 5, timeout: 500 });
}

function reviewerProvider() {
  return new DaemonReviewerVerdictProvider({ key: Buffer.from('integration-reviewer-key'), keyId: 'integration-reviewer-key', now: () => Date.parse('2026-09-05T00:30:00.000Z') });
}

describe('DaemonTaskControlIntegration', () => {
  it('turns a trusted synced failed report into a terminal task failure', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-failed-report-'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
      });
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: 'cli_review_1234567890123456', acceptorId: 'cli_accept_1234567890123456',
        registrationRef: 'topic-message:om_projectroot', mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId: 'cli_accept_1234567890123456', mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: workerAppId });
      const lifecycleFacts = {
        schemaVersion: 'ProjectWorkerEvidence.v1' as const, sourceAppId: workerAppId, controllerAppId,
        sourceSessionId: 'session-worker', sourceTurnId: 'turn-1', workerGeneration: 2, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:00:00.000Z',
      };
      for (const eventKind of ['accepted', 'execution_started'] as const) {
        const evidence = trust.issue({ ...lifecycleFacts, eventKind });
        expect(integration.ingestProjectWorkerEvidence(evidence, value => trust.verify(value))).toMatchObject({ ok: true });
      }
      const submitted = trust.issue({
        ...lifecycleFacts, eventKind: 'submitted', occurredAt: '2026-09-29T00:01:00.000Z',
        reportRequestId: 'report:submitted', triggerId: 'trg-submitted', targetSessionId: 'session-controller',
        contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 5,
      });
      expect(integration.ingestProjectWorkerEvidence(submitted, value => trust.verify(value))).toMatchObject({ ok: true });

      const terminalBeforeReport = trust.issue({
        ...lifecycleFacts, eventKind: 'terminal', sourceTurnId: 'turn-2', workerGeneration: 3,
        occurredAt: '2026-09-29T00:01:59.000Z', terminalStatus: 'completed', finalOutputPresent: true,
      });
      expect(integration.ingestProjectWorkerEvidence(terminalBeforeReport, value => trust.verify(value)))
        .toMatchObject({ ok: true });
      expect(store.getTaskProjection('task-project').unknowns).toEqual([
        expect.objectContaining({ key: 'terminal-report:session-worker:3:turn-2:1', required: true, resolved: false }),
      ]);
      const failed = trust.issue({
        ...lifecycleFacts, eventKind: 'failed_report', sourceTurnId: 'turn-2', workerGeneration: 3,
        occurredAt: '2026-09-29T00:02:00.000Z', reportRequestId: 'report:failed', triggerId: 'trg-failed',
        targetSessionId: 'session-controller', contentHash: `sha256:${'b'.repeat(64)}`, projectRevision: 6,
      });
      expect(integration.ingestProjectWorkerEvidence(failed, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual([
          'mapping.registered', 'task.accepted', 'task.execution_started', 'task.first_submitted',
          'unknown.required', 'task.failed', 'unknown.resolved',
        ]);
      expect(store.getTaskProjection('task-project').state).toBe('failed');
      expect(store.getTaskProjection('task-project').unknowns.every(item => item.resolved)).toBe(true);
      expect(integration.isProjectGroupTaskTerminal('om_projectroot', 'task-project')).toBe(true);
      expect(integration.isProjectGroupTaskTerminal('om_other', 'task-project')).toBe(false);
      expect(integration.isProjectGroupTaskTerminal('om_projectroot', 'task-other')).toBe(false);
      const failedTerminal = trust.issue({
        ...lifecycleFacts, eventKind: 'terminal', sourceTurnId: 'turn-2', workerGeneration: 3,
        occurredAt: '2026-09-29T00:02:00.500Z', terminalStatus: 'failed', finalOutputPresent: true,
      });
      expect(integration.ingestProjectWorkerEvidence(failedTerminal, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.listEvents({ taskGuid: 'task-project' }).filter(event => event.eventType === 'task.failed')).toHaveLength(1);
      const terminal = trust.issue({
        ...lifecycleFacts, eventKind: 'terminal', sourceTurnId: 'turn-2', workerGeneration: 3,
        occurredAt: '2026-09-29T00:02:01.000Z', terminalStatus: 'completed', finalOutputPresent: true,
      });
      expect(integration.ingestProjectWorkerEvidence(terminal, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.getTaskProjection('task-project').unknowns.every(item => item.resolved)).toBe(true);
      const retried = trust.issue({
        ...failed, evidenceId: undefined, keyId: undefined, signature: undefined,
        occurredAt: '2026-09-29T00:03:00.000Z', reportRequestId: 'report:failed-retry', triggerId: 'trg-failed-retry',
      } as any);
      expect(integration.ingestProjectWorkerEvidence(retried, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.listEvents({ taskGuid: 'task-project' }).filter(event => event.eventType === 'task.failed')).toHaveLength(1);
      expect(store.getTaskProjection('task-project')).toMatchObject({ state: 'failed', transitionViolations: [] });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('reports narrow capacity terminal from a valid mapped task.failed even when a prior transition violation forces the audit projection to remain blocked', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-narrow-terminal-'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const reviewerAppId = 'cli_review_1234567890123456';
      const acceptorAppId = 'cli_accept_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
      });
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: reviewerAppId, acceptorId: acceptorAppId,
        registrationRef: 'topic-message:om_projectroot', mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId, mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const workerAuth = integration.issueAuthentication('om_projectroot', 'worker')!;
      // Historical invalid non-terminal transition: task.execution_started when the mapped task
      // is still 'planned'. It is preserved append-only and forces the public
      // audit projection state to stay 'blocked' (transitionViolations grows).
      const violation = store.appendEvent({
        eventId: 'evt_hist_violation', eventType: 'task.execution_started',
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot',
        idempotencyKey: 'idem:evt_hist_violation', occurredAt: '2026-09-29T00:00:30.000Z',
        sourceRef: 'audit:historical-violation:1', authentication: workerAuth, payload: {},
      });
      expect(violation.kind).toBe('appended');
      // Valid mapped-worker terminal failure carrying the exact project_report
      // artifact and errorClass=project_report_failed the design demands.
      const failed = store.appendEvent({
        eventId: 'evt_valid_failed', eventType: 'task.failed',
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot',
        idempotencyKey: 'idem:evt_valid_failed', occurredAt: '2026-09-29T00:01:00.000Z',
        sourceRef: 'project-worker-evidence:evd_valid_failed', authentication: workerAuth,
        errorClass: 'project_report_failed', payload: {
          sourceSessionId: 'session-worker', sourceTurnId: 'turn-1', workerGeneration: 2, dispatchAttempt: 1,
          artifactEvidence: {
            kind: 'project_report', reportRequestId: 'report:valid-failed', triggerId: 'trg-valid-failed',
            dispatchRoot: 'om_projectroot', sourceSessionId: 'session-worker', sourceTurnId: 'turn-1',
            reporterAppId: workerAppId, targetSessionId: 'session-controller', projectRevision: 6,
            contentHash: `sha256:${'b'.repeat(64)}`,
          },
        },
      });
      expect(failed.kind).toBe('appended');
      const projection = store.getTaskProjection('task-project');
      // Audit projection stays 'blocked' with the violation retained; the
      // valid mapped-worker task.failed is present in the immutable ledger.
      expect(projection.state).toBe('blocked');
      expect(projection.transitionViolations.length).toBeGreaterThan(0);
      expect(store.listEvents({ taskGuid: 'task-project' }).some(event =>
        event.eventType === 'task.failed' && event.errorClass === 'project_report_failed')).toBe(true);
      // Narrow capacity predicate must accept the valid mapped-worker terminal
      // even while the audit projection remains blocked. The current
      // isProjectGroupTaskTerminal reads projection.state directly and will
      // therefore fail this assertion until the narrow predicate is added.
      expect(integration.isProjectGroupTaskTerminal('om_projectroot', 'task-project')).toBe(true);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('narrow capacity predicate rejects forged, wrong-role, or non-mapped terminals and keeps monotonicity while admission still denies later audit defects', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-narrow-terminal-neg-'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const foreignWorkerAppId = 'cli_worker_forge_00000000000000';
      const reviewerAppId = 'cli_review_1234567890123456';
      const acceptorAppId = 'cli_accept_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const warnings: string[] = [];
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge,
        logger: { warn: (message: string) => { warnings.push(message); } },
      });
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: reviewerAppId, acceptorId: acceptorAppId,
        registrationRef: 'topic-message:om_projectroot', mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId, mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      expect(integration.isProjectGroupTaskTerminal('om_projectroot', 'task-project')).toBe(false);
      expect(store.getTaskTrustedTerminalDecision('om_projectroot', 'task-project').released).toBe(false);
      // Unknown dispatchRoot cannot release capacity.
      expect(integration.isProjectGroupTaskTerminal('om_unknown', 'task-project')).toBe(false);
      expect(store.getTaskTrustedTerminalDecision('om_unknown', 'task-project').released).toBe(false);

      const workerAuth = integration.issueAuthentication('om_projectroot', 'worker')!;
      const reviewerAuth = integration.issueAuthentication('om_projectroot', 'reviewer')!;
      const controllerAuth = integration.issueAuthentication('om_projectroot', 'controller')!;

      // A only-UNKNOWN prefix does not release.
      expect(store.appendEvent({
        eventId: 'evt_unknown_required', eventType: 'unknown.required',
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot',
        idempotencyKey: 'idem:unknown_required', occurredAt: '2026-09-29T00:00:15.000Z',
        sourceRef: 'audit:unknown:1', authentication: workerAuth,
        payload: { unknownKey: 'project-sync:report:only-unknown', source: 'project_report' },
      }).kind).toBe('appended');
      expect(store.getTaskTrustedTerminalDecision('om_projectroot', 'task-project').released).toBe(false);

      const validArtifact = {
        kind: 'project_report' as const, reportRequestId: 'report:valid', triggerId: 'trg-valid',
        dispatchRoot: 'om_projectroot', sourceSessionId: 'session-worker', sourceTurnId: 'turn-1',
        reporterAppId: workerAppId, targetSessionId: 'session-controller', projectRevision: 6,
        contentHash: `sha256:${'b'.repeat(64)}`,
      };

      // Wrong-role: reviewer-sourced task.failed carrying project_report_failed must not release.
      const wrongRoleFailed = store.appendEvent({
        eventId: 'evt_wrong_role_failed', eventType: 'task.failed',
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot',
        idempotencyKey: 'idem:wrong_role_failed', occurredAt: '2026-09-29T00:00:16.000Z',
        sourceRef: 'audit:wrong-role:1', authentication: reviewerAuth,
        errorClass: 'project_report_failed', payload: { artifactEvidence: validArtifact },
      });
      expect(wrongRoleFailed.kind).toBe('appended');
      expect(store.getTaskTrustedTerminalDecision('om_projectroot', 'task-project').released).toBe(false);

      // Missing errorClass on a worker task.failed must not release.
      const missingErrorClass = store.appendEvent({
        eventId: 'evt_missing_error_class', eventType: 'task.failed',
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot',
        idempotencyKey: 'idem:missing_error_class', occurredAt: '2026-09-29T00:00:17.000Z',
        sourceRef: 'audit:missing-error:1', authentication: workerAuth,
        payload: { artifactEvidence: validArtifact },
      });
      expect(missingErrorClass.kind).toBe('appended');
      expect(store.getTaskTrustedTerminalDecision('om_projectroot', 'task-project').released).toBe(false);

      // Wrong errorClass must not release.
      const wrongErrorClass = store.appendEvent({
        eventId: 'evt_wrong_error_class', eventType: 'task.failed',
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot',
        idempotencyKey: 'idem:wrong_error_class', occurredAt: '2026-09-29T00:00:18.000Z',
        sourceRef: 'audit:wrong-error:1', authentication: workerAuth,
        errorClass: 'execution_timeout', payload: { artifactEvidence: validArtifact },
      });
      expect(wrongErrorClass.kind).toBe('appended');
      expect(store.getTaskTrustedTerminalDecision('om_projectroot', 'task-project').released).toBe(false);

      // Document-kind artifact instead of project_report must not release.
      const wrongArtifact = store.appendEvent({
        eventId: 'evt_wrong_artifact', eventType: 'task.failed',
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot',
        idempotencyKey: 'idem:wrong_artifact', occurredAt: '2026-09-29T00:00:19.000Z',
        sourceRef: 'audit:wrong-artifact:1', authentication: workerAuth,
        errorClass: 'project_report_failed',
        payload: { artifactEvidence: { kind: 'document', docToken: 'doc-token-1', docRevision: 1 } },
      });
      expect(wrongArtifact.kind).toBe('appended');
      expect(store.getTaskTrustedTerminalDecision('om_projectroot', 'task-project').released).toBe(false);

      // Foreign (unmapped) worker authentication cannot even reach the store: the authority
      // never issued it, so appendEvent fails closed. That is the strongest guarantee — a
      // forged terminal cannot enter the immutable ledger at all.
      const foreignAuth = { actorId: foreignWorkerAppId, actorRole: 'worker' as const };
      expect(() => store.appendEvent({
        eventId: 'evt_foreign_failed', eventType: 'task.failed',
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot',
        idempotencyKey: 'idem:foreign_failed', occurredAt: '2026-09-29T00:00:20.000Z',
        sourceRef: 'audit:foreign:1', authentication: foreignAuth as any,
        errorClass: 'project_report_failed', payload: { artifactEvidence: validArtifact },
      })).toThrow('task_control_authentication_failed');
      expect(store.getTaskTrustedTerminalDecision('om_projectroot', 'task-project').released).toBe(false);

      // Positive path on a clean mapping: historical invalid transition creates a
      // transitionViolation (audit stays blocked) but is NOT a terminal-shape event,
      // so a later valid mapped-worker task.failed on the still-valid transition prefix
      // (planned → failed) releases capacity. Pre-terminal non-terminal audit defects
      // remain visible but do not independently deny a new reservation.
      const workerAppIdC = 'cli_worker_c_1234567890123456';
      const reviewerAppIdC = 'cli_review_c_1234567890123456';
      const acceptorAppIdC = 'cli_accept_c_1234567890123456';
      const registerC = integration.registerMapping('om_projectrootc', {
        projectId: 'project-group:oc_projectc', phaseId: 'workstream:task-projectc', phaseTaskGuids: ['task-projectc'],
        taskGuid: 'task-projectc', topicRootId: 'om_projectrootc', ownerId: workerAppIdC,
        reviewerId: reviewerAppIdC, acceptorId: acceptorAppIdC,
        registrationRef: 'topic-message:om_projectrootc', mappingAuthority: {
          kind: 'project_group', chatId: 'oc_projectc', reservationId: 'reservation-3', projectRevision: 4,
          acceptorAppId: acceptorAppIdC, mode: 'audit_only',
        },
      }, controllerAppId);
      expect(registerC, warnings.join('\n')).toBe(true);
      const workerAuthC = integration.issueAuthentication('om_projectrootc', 'worker')!;
      const controllerAuthC = integration.issueAuthentication('om_projectrootc', 'controller')!;
      expect(store.appendEvent({
        eventId: 'evt_hist_violation_c', eventType: 'task.execution_started',
        projectId: 'project-group:oc_projectc', phaseId: 'workstream:task-projectc',
        taskGuid: 'task-projectc', topicRootId: 'om_projectrootc',
        idempotencyKey: 'idem:hist_violation_c', occurredAt: '2026-09-29T00:00:25.000Z',
        sourceRef: 'audit:historical-violation:c', authentication: workerAuthC, payload: {},
      }).kind).toBe('appended');
      expect(store.appendEvent({
        eventId: 'evt_unknown_required_c', eventType: 'unknown.required',
        projectId: 'project-group:oc_projectc', phaseId: 'workstream:task-projectc',
        taskGuid: 'task-projectc', topicRootId: 'om_projectrootc',
        idempotencyKey: 'idem:unknown_required_c', occurredAt: '2026-09-29T00:00:26.000Z',
        sourceRef: 'audit:unknown:c', authentication: workerAuthC,
        payload: { unknownKey: 'audit:c-unknown', source: 'project_report' },
      }).kind).toBe('appended');
      const validFailedC = store.appendEvent({
        eventId: 'evt_valid_failed_c', eventType: 'task.failed',
        projectId: 'project-group:oc_projectc', phaseId: 'workstream:task-projectc',
        taskGuid: 'task-projectc', topicRootId: 'om_projectrootc',
        idempotencyKey: 'idem:valid_failed_c', occurredAt: '2026-09-29T00:01:00.000Z',
        sourceRef: 'project-worker-evidence:evd_valid_failed_c', authentication: workerAuthC,
        errorClass: 'project_report_failed', payload: {
          sourceSessionId: 'session-worker', sourceTurnId: 'turn-1', workerGeneration: 2, dispatchAttempt: 1,
          artifactEvidence: {
            ...validArtifact, dispatchRoot: 'om_projectrootc', reporterAppId: workerAppIdC,
          },
        },
      });
      expect(validFailedC.kind).toBe('appended');
      const releasedC = store.getTaskTrustedTerminalDecision('om_projectrootc', 'task-projectc');
      expect(releasedC.released).toBe(true);
      expect(releasedC.releaseKind).toBe('valid_failed');
      expect(releasedC.releaseEventId).toBe(validFailedC.event.eventId);
      expect(integration.isProjectGroupTaskTerminal('om_projectrootc', 'task-projectc')).toBe(true);
      const admissionBeforeLateDefect = store.getTaskAdmissionDecision('om_projectrootc', 'task-projectc');
      expect(admissionBeforeLateDefect).toEqual({ safe: true, blockers: [] });

      // Monotonicity: later audit UNKNOWN / conflict-detected on the released mapping cannot
      // reverse capacity release, but still block admission for a new reservation.
      expect(store.appendEvent({
        eventId: 'evt_post_unknown_c', eventType: 'unknown.required',
        projectId: 'project-group:oc_projectc', phaseId: 'workstream:task-projectc',
        taskGuid: 'task-projectc', topicRootId: 'om_projectrootc',
        idempotencyKey: 'idem:post_unknown_c', occurredAt: '2026-09-29T00:02:00.000Z',
        sourceRef: 'audit:post-unknown:c', authentication: workerAuthC,
        payload: { unknownKey: 'audit:c-late-unknown', source: 'project_report' },
      }).kind).toBe('appended');
      expect(store.appendEvent({
        eventId: 'evt_post_conflict_c', eventType: 'event.conflict_detected',
        projectId: 'project-group:oc_projectc', phaseId: 'workstream:task-projectc',
        taskGuid: 'task-projectc', topicRootId: 'om_projectrootc',
        idempotencyKey: 'idem:post_conflict_c', occurredAt: '2026-09-29T00:02:05.000Z',
        sourceRef: 'audit:post-conflict:c', authentication: controllerAuthC,
        payload: { conflictReason: 'late-audit' },
      }).kind).toBe('appended');
      const afterLate = store.getTaskTrustedTerminalDecision('om_projectrootc', 'task-projectc');
      expect(afterLate.released).toBe(true);
      expect(afterLate.releaseEventId).toBe(validFailedC.event.eventId);
      const admissionAfterLate = store.getTaskAdmissionDecision('om_projectrootc', 'task-projectc');
      expect(admissionAfterLate.safe).toBe(false);
      expect(admissionAfterLate.blockers.some(item => item.kind === 'unresolved_conflict')).toBe(true);
      expect(admissionAfterLate.blockers.some(item => item.kind === 'unresolved_unknown' && item.key === 'audit:c-late-unknown')).toBe(true);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('keeps a failed report non-terminal when the project update is not durable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-failed-report-sync-error-'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
      });
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: 'cli_review_1234567890123456', acceptorId: 'cli_accept_1234567890123456',
        registrationRef: 'topic-message:om_projectroot', mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId: 'cli_accept_1234567890123456', mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: workerAppId });
      const failed = trust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'failed_report',
        sourceAppId: workerAppId, controllerAppId, sourceSessionId: 'session-worker', sourceTurnId: 'turn-1',
        workerGeneration: 2, dispatchAttempt: 1, dispatchRoot: 'om_projectroot',
        occurredAt: '2026-09-29T00:02:00.000Z', reportRequestId: 'report:failed', triggerId: 'trg-failed',
        targetSessionId: 'session-controller', contentHash: `sha256:${'b'.repeat(64)}`,
        projectSyncError: 'project_revision_conflict',
      });
      expect(integration.ingestProjectWorkerEvidence(failed, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual(['mapping.registered', 'unknown.required']);
      expect(store.getTaskProjection('task-project')).toMatchObject({
        state: 'planned', unknowns: [expect.objectContaining({ key: 'project-sync:report:failed', required: true, resolved: false })],
      });
      expect(integration.isProjectGroupTaskTerminal('om_projectroot', 'task-project')).toBe(false);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('records project reconciliation timeouts once without manufacturing task failure', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-project-reconcile-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} },
      });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      integration.dispatchRequested('om_root', 'session-controller', '2026-09-29T00:00:00.000Z');
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType))
        .toContain('task.dispatch_requested'));

      const timeout = {
        kind: 'acceptance_timed_out' as const, dispatchRoot: 'om_root', taskGuid: 'task-1',
        sourceEventId: 'tcp-dispatch:om_root', sourceRef: 'reconcile:acceptance-timeout:tcp-dispatch:om_root',
        occurredAt: '2026-09-29T00:30:00.000Z',
      };
      expect(integration.applyProjectReconcileAction(timeout)).toBe(true);
      expect(integration.applyProjectReconcileAction(timeout)).toBe(true);
      expect(store.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.acceptance_timed_out'))
        .toHaveLength(1);

      integration.workerAccepted('om_root', 'accepted', '2026-09-29T00:31:00.000Z');
      integration.workerExecutionStarted('om_root', 'execution', '2026-09-29T00:32:00.000Z');
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('executing'));
      const unknown = {
        kind: 'execution_timeout_unknown' as const, dispatchRoot: 'om_root', taskGuid: 'task-1',
        sourceEventId: 'tcp-task.execution_started:execution',
        sourceRef: 'reconcile:execution-timeout:tcp-task.execution_started:execution',
        unknownKey: 'execution-timeout:tcp-task.execution_started:execution',
        occurredAt: '2026-09-29T01:02:00.000Z',
      };
      expect(integration.applyProjectReconcileAction(unknown)).toBe(true);
      expect(integration.applyProjectReconcileAction(unknown)).toBe(true);
      const events = store.listEvents({ taskGuid: 'task-1' });
      expect(events.filter(event => event.eventType === 'unknown.required')).toHaveLength(1);
      expect(events.some(event => event.eventType === 'task.failed')).toBe(false);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('writes project worker evidence only into the controller mapping partition', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-project-evidence-ingress-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T00:20:00.000Z'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
        hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
      });
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
        projectReviewerTrust,
      });
      integration.setReviewerVerdictVerifier(projectReviewerTrust);
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: 'cli_worker_1234567890123456',
        reviewerId: 'cli_review_1234567890123456', acceptorId: 'cli_accept_1234567890123456',
        registrationRef: 'topic-message:om_projectroot',
        mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId: 'cli_accept_1234567890123456', mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: 'cli_worker_1234567890123456' });
      const accepted = trust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'accepted',
        sourceAppId: 'cli_worker_1234567890123456', controllerAppId,
        sourceSessionId: 'session-worker', sourceTurnId: 'turn-1', workerGeneration: 2, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:00:00.000Z',
      });
      const execution = trust.issue({
        ...accepted, eventKind: 'execution_started', evidenceId: undefined, keyId: undefined, signature: undefined,
      } as any);
      expect(integration.ingestProjectWorkerEvidence(execution, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual(['mapping.registered', 'task.accepted', 'task.execution_started']);
      const terminal = trust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'terminal',
        sourceAppId: accepted.sourceAppId, controllerAppId, sourceSessionId: accepted.sourceSessionId,
        sourceTurnId: accepted.sourceTurnId, workerGeneration: accepted.workerGeneration, dispatchAttempt: 1,
        dispatchRoot: accepted.dispatchRoot, occurredAt: '2026-09-29T00:09:00.000Z',
        terminalStatus: 'completed', finalOutputPresent: false,
      });
      expect(integration.ingestProjectWorkerEvidence(terminal, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.getTaskProjection('task-project').unknowns).toEqual([
        expect.objectContaining({ required: true, resolved: false }),
      ]);
      const submitted = trust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'submitted',
        sourceAppId: accepted.sourceAppId, controllerAppId, sourceSessionId: accepted.sourceSessionId,
        sourceTurnId: accepted.sourceTurnId, workerGeneration: accepted.workerGeneration, dispatchAttempt: 1,
        dispatchRoot: accepted.dispatchRoot, occurredAt: '2026-09-29T00:10:00.000Z',
        reportRequestId: 'report:worker', triggerId: 'trg-worker', targetSessionId: 'session-controller',
        contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 5,
      });
      expect(integration.ingestProjectWorkerEvidence(submitted, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.getTaskProjection('task-project').unknowns).toEqual([
        expect.objectContaining({ required: true, resolved: true }),
      ]);
      const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: 'cli_review_1234567890123456' });
      const reviewArtifact = {
        kind: 'project_report' as const, reportRequestId: 'report:review', triggerId: 'trg-review',
        dispatchRoot: accepted.dispatchRoot, sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review',
        reporterAppId: 'cli_review_1234567890123456', targetSessionId: 'session-controller',
        projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
      };
      const reviewerVerdict = projectReviewerTrust.providerForApp('cli_review_1234567890123456')!.issueVerdict({
        verdictId: 'rv_project_review', projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: accepted.dispatchRoot, taskSetSnapshot: ['task-project'], reviewRound: 1,
        designatedReviewerRef: reviewerDesignationRef(accepted.dispatchRoot, 'cli_review_1234567890123456', 1, 4),
        reviewerId: 'cli_review_1234567890123456', reviewerBotAppId: 'cli_review_1234567890123456',
        sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
        sourceMessageId: 'trg-review', sourceVersionHash: reviewArtifact.contentHash,
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
        artifactEvidence: reviewArtifact, issuedAt: '2026-09-29T00:20:00.000Z', expiresAt: '2099-09-29T00:20:00.000Z',
      });
      const reviewed = reviewerTrust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'reviewed',
        sourceAppId: 'cli_review_1234567890123456', controllerAppId,
        sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review', workerGeneration: 4, dispatchAttempt: 1,
        dispatchRoot: accepted.dispatchRoot, occurredAt: '2026-09-29T00:20:00.000Z',
        reportRequestId: 'report:review', triggerId: 'trg-review', targetSessionId: 'session-controller',
        contentHash: `sha256:${'b'.repeat(64)}`, projectRevision: 6, reviewVerdict: 'pass', reviewRound: 1,
        reviewerVerdict,
      });
      const forgedReviewed = reviewerTrust.issue({
        ...reviewed,
        evidenceId: undefined, keyId: undefined, signature: undefined,
        reviewerVerdict: { ...reviewerVerdict, signature: '0'.repeat(64) },
      } as any);
      expect(integration.ingestProjectWorkerEvidence(forgedReviewed, value => reviewerTrust.verify(value)))
        .toEqual({ ok: false, reason: 'reviewer_verdict_unverified' });
      expect(store.listEvents({ taskGuid: 'task-project' }).some(event => event.eventType === 'task.reviewed')).toBe(false);
      const failedReviewed = reviewerTrust.issue({
        ...reviewed,
        eventKind: 'project_sync_failed',
        evidenceId: undefined, keyId: undefined, signature: undefined,
        reportRequestId: 'report:review-failed', triggerId: 'trg-review-failed',
        projectRevision: undefined, projectSyncError: 'project_write_review_requires_delivery',
        reviewerVerdict: undefined,
      } as any);
      expect(integration.ingestProjectWorkerEvidence(failedReviewed, value => reviewerTrust.verify(value)))
        .toMatchObject({ ok: true });
      expect(store.getTaskProjection('task-project').unknowns).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'project-sync:report:review-failed', required: true, resolved: false }),
      ]));
      expect(integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value))).toMatchObject({ ok: true });
      expect(integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value))).toMatchObject({ ok: true });
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual([
          'mapping.registered', 'task.accepted', 'task.execution_started', 'unknown.required',
          'task.first_submitted', 'unknown.resolved', 'unknown.required', 'task.reviewed', 'task.delivered',
          'task.done_marked', 'unknown.resolved',
        ]);
      expect(store.getTaskProjection('task-project').unknowns.every(item => item.resolved)).toBe(true);
      expect(store.getTaskProjection('task-project').state).toBe('task_done_pending_freeze');
      expect(store.getReviewerVerdictHead(
        'project-group:oc_project', 'workstream:task-project', 'task-project', 'om_projectroot', ['task-project'], 1,
        '2026-09-29T00:20:00.000Z',
      )).toMatchObject({ status: 'active', verdict: { verdictId: 'rv_project_review' } });
      expect(store.listOutbox()).toEqual([expect.objectContaining({ status: 'delivered' })]);
      const gateDefinition = {
        gateId: 'project-clean', sourceChatId: 'oc_project', dispatchRoot: 'om_projectroot', taskGuid: 'task-project',
      };
      const sourceProject: ProjectGroupState = {
        schemaVersion: 3, revision: 6, chatId: 'oc_project', larkAppId: controllerAppId,
        coordinatorSessionId: 'session-controller', title: '子项目', goal: '完成 clean canary', phase: '验收', focus: '完成',
        status: 'active', blockers: [], blockerRecords: [], completionGates: [], dispatchReservations: [], milestones: [],
        workstreams: [{
          dispatchRoot: 'om_projectroot', title: 'clean canary', purpose: '验证', owners: [], status: 'completed', progress: 100,
          workerAppIds: [accepted.sourceAppId], reviewerAppIds: [reviewed.sourceAppId],
          access: { mode: 'write', scopes: ['/repo/canary'] },
          delivery: { reportedByAppId: accepted.sourceAppId, content: '完成', reportedAt: submitted.occurredAt, round: 1 },
          review: { reviewerAppId: reviewed.sourceAppId, verdict: 'pass', content: 'PASS', reviewedAt: reviewed.occurredAt, round: 1 },
          taskControl: {
            taskGuid: 'task-project', phaseId: 'workstream:task-project', mappingRef: 'topic-message:om_projectroot',
            mappingStatus: 'registered', sourceKind: 'project_group', controllerAppId,
            workerAppId: accepted.sourceAppId, reviewerAppId: reviewed.sourceAppId,
            acceptorAppId: 'cli_accept_1234567890123456', projectRevision: 4,
            reservationId: 'reservation-1', coordinatorSessionId: 'session-controller', originTurnId: 'turn-1',
            reservationCreatedAt: '2026-09-29T00:00:00.000Z', reservationExpiresAt: '2026-09-29T01:00:00.000Z',
            rootCreateTime: '2026-09-29T00:00:00.000Z',
            reservationProof: {
              schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: controllerAppId,
              issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:key', signature: 'a'.repeat(64),
            },
          },
          createdAt: '2026-09-29T00:00:00.000Z', updatedAt: reviewed.occurredAt,
        }],
        createdAt: '2026-09-29T00:00:00.000Z', updatedAt: reviewed.occurredAt,
      };
      expect(evaluateProjectCompletionGate({
        parentLarkAppId: controllerAppId,
        gate: {
          ...gateDefinition, label: 'project clean', definitionFingerprint: projectCompletionGateFingerprint(gateDefinition),
          status: 'pending', reason: 'not_evaluated', createdAt: reviewed.occurredAt, updatedAt: reviewed.occurredAt,
        },
        sourceProject, reader: store, checkedAt: '2026-09-29T00:20:00.000Z', staleExecutionMs: 30 * 60_000,
      })).toMatchObject({
        status: 'satisfied', reason: 'verified',
        evidence: { reviewerVerdictId: 'rv_project_review' },
      });
      expect(integration.ingestProjectWorkerEvidence({ ...accepted, dispatchAttempt: 2 }, () => true))
        .toEqual({ ok: false, reason: 'project_worker_evidence_identity_invalid' });
      await lifecycle.close();
    } finally {
      vi.useRealTimers();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('preserves submission and records UNKNOWN when the trigger lands but project CAS fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-project-sync-failed-'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
      });
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: 'cli_review_1234567890123456', acceptorId: 'cli_accept_1234567890123456',
        registrationRef: 'topic-message:om_projectroot',
        mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId: 'cli_accept_1234567890123456', mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: workerAppId });
      const evidence = trust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'project_sync_failed',
        sourceAppId: workerAppId, controllerAppId, sourceSessionId: 'session-worker', sourceTurnId: 'turn-1',
        workerGeneration: 2, dispatchAttempt: 1, dispatchRoot: 'om_projectroot',
        occurredAt: '2026-09-29T00:10:00.000Z', reportRequestId: 'report:worker', triggerId: 'trg-worker',
        targetSessionId: 'session-controller', contentHash: `sha256:${'a'.repeat(64)}`,
        projectSyncError: 'project_revision_conflict',
      });
      expect(integration.ingestProjectWorkerEvidence(evidence, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(integration.ingestProjectWorkerEvidence(evidence, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual(['mapping.registered', 'task.first_submitted', 'unknown.required']);
      expect(store.getTaskProjection('task-project').unknowns).toEqual([
        expect.objectContaining({ key: 'project-sync:report:worker', required: true, resolved: false }),
      ]);
      const retried = trust.issue({
        ...evidence,
        eventKind: 'submitted', evidenceId: undefined, keyId: undefined, signature: undefined,
        sourceTurnId: 'turn-2', workerGeneration: 3,
        reportRequestId: 'report:worker-retry', triggerId: 'trg-worker-retry',
        projectRevision: 5, projectSyncError: undefined,
      } as any);
      expect(integration.ingestProjectWorkerEvidence(retried, value => trust.verify(value))).toMatchObject({ ok: true });
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual(['mapping.registered', 'task.first_submitted', 'unknown.required', 'task.first_submitted', 'unknown.resolved']);
      expect(store.getTaskProjection('task-project').unknowns).toEqual([
        expect.objectContaining({ key: 'project-sync:report:worker', required: true, resolved: true }),
      ]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('rejects a stale write grant after FAIL then PASS and consumes one exact new grant once', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-write-grant-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const worker = bridge.issueAuthentication('om_root', 'worker')!;
      store.appendEvent({ eventId: 'd1-fail', eventType: 'task.failed', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'd1-fail', occurredAt: '2026-09-05T00:10:00.000Z' });
      // A later technical PASS is evidence only; it cannot revive a consumed or invalidated grant.
      store.appendEvent({ eventId: 'c8-pass', eventType: 'unknown.declared', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'c8-pass', occurredAt: '2026-09-05T00:20:00.000Z', payload: { unknownKey: 'technical-pass:c8' } });
      const input = { dispatchRoot: 'om_root', grantRef: 'grant:write-1', candidate: 'candidate-c8', action: 'git.commit', attempt: 2, operatorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z' };
      expect(integration.consumeWriteExecutionGrant(input)).toEqual({ ok: false, reason: 'task_control_write_execution_grant_invalidated' });
      expect(integration.consumeWriteExecutionGrant({ ...input, grantRef: 'grant:write-2' })).toEqual({ ok: false, reason: 'task_control_write_execution_grant_invalidated' });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('allows one exact fresh grant once and rejects replay or mismatched execution facts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-write-grant-once-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const input = { dispatchRoot: 'om_root', grantRef: 'grant:write-1', candidate: 'candidate-c8', action: 'git.commit', attempt: 2, operatorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z' };
      expect(integration.consumeWriteExecutionGrant(input)).toEqual({ ok: true });
      expect(integration.consumeWriteExecutionGrant(input)).toEqual({ ok: false, reason: 'task_control_write_execution_grant_unavailable' });
      expect(integration.consumeWriteExecutionGrant({ ...input, grantRef: 'grant:write-2', candidate: 'other-candidate' })).toEqual({ ok: false, reason: 'write_execution_grant_unproven' });
      expect(integration.consumeWriteExecutionGrant({ ...input, grantRef: 'grant:write-2', attempt: 3 })).toEqual({ ok: false, reason: 'write_execution_grant_unproven' });
      expect(integration.consumeWriteExecutionGrant({ ...input, dispatchRoot: 'om_other_topic' })).toEqual({ ok: false, reason: 'write_execution_mapping_unproven' });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('keeps a consumed grant consumed after daemon restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-write-grant-restart-'));
    try {
      const input = { dispatchRoot: 'om_root', grantRef: 'grant:write-1', candidate: 'candidate-c8', action: 'git.commit', attempt: 2, operatorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z' };
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      expect(integration.consumeWriteExecutionGrant(input)).toEqual({ ok: true });
      await lifecycle.close();

      const restartedBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const restarted = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: restartedBridge.authority, logger: { warn: () => {} } });
      const restartedIntegration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restarted, store: restarted.getStore()!, bridge: restartedBridge, logger: { warn: () => {} } });
      expect(restartedIntegration.consumeWriteExecutionGrant(input)).toEqual({ ok: false, reason: 'task_control_write_execution_grant_unavailable' });
      await restarted.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('serializes concurrent consumers so exactly one identical grant succeeds', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-write-grant-concurrent-'));
    try {
      const input = { dispatchRoot: 'om_root', grantRef: 'grant:write-1', candidate: 'candidate-c8', action: 'git.commit', attempt: 2, operatorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z' };
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const results = await Promise.all([
        Promise.resolve().then(() => integration.consumeWriteExecutionGrant(input)),
        Promise.resolve().then(() => integration.consumeWriteExecutionGrant(input)),
      ]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'task_control_write_execution_grant_unavailable' }]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  it('persists controller mapping in SQLite and restores it without a JSON sidecar', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      expect(lifecycle.getStore()!.listTrustedMappings()).toEqual([expect.objectContaining({
        dispatchRoot: 'om_root', phaseTaskGuids: ['task-1'], docToken: 'doc-token-12345678',
        approvalGate: expect.objectContaining({ runId: 'run-1', approvalRef: expect.stringMatching(/^approval:gate-/) }),
      })]);
      await lifecycle.close();

      const restoredBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const restoredLifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: restoredBridge.authority, logger: { warn: () => {} } });
      new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restoredLifecycle, store: restoredLifecycle.getStore()!, bridge: restoredBridge, logger: { warn: () => {} } });
      expect(restoredBridge.mapping('om_root')).toMatchObject({ projectId: 'project-1', taskGuid: 'task-1' });
      await restoredLifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('rejects a same-root mapping retry when any critical recovery fact changes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-mapping-conflict-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      expect(integration.registerMapping('om_root', { ...mapping(), docRevision: 9 } as any, 'controller-1')).toBe(false);
      expect(integration.registerMapping('om_root', { ...mapping(), phaseRegistrationRefs: { 'task-1': 'task-comment:123' }, approvalGate: { ...gate(), nodeId: 'other-node' } } as any, 'controller-1')).toBe(false);
      expect(integration.registerMapping('om_root', { ...mapping(), registrationVersion: 'comment-version-2' } as any, 'controller-1')).toBe(false);
      expect(integration.registerMapping('om_root', { ...mapping(), phaseRegistrationRefs: { 'task-1': 'task-comment:124' } } as any, 'controller-1')).toBe(false);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('persists the generated mapping proof and restores the signed production mapping after restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-proof-restart-'));
    try {
      const trust = new TaskControlMappingTrust({ hostSecret: 'test-host-secret', larkAppId: 'app-1' });
      const verifier = { minimumTaskCount: 2, verifyMapping: (proof: any, facts: Record<string, unknown>) => trust.verifyMapping(proof, facts) };
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1', productionMapping: verifier });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} }, mappingTrust: trust });
      const first = { ...mapping(), phaseTaskGuids: ['task-1', 'task-2'] };
      expect(integration.registerMapping('om_root', first, 'controller-1')).toBe(true);
      expect(integration.registerMapping('om_root_2', secondPhaseMapping(), 'controller-1')).toBe(true);
      const persisted = lifecycle.getStore()!.listTrustedMappings();
      expect(persisted.find(item => item.dispatchRoot === 'om_root')).toMatchObject({
        taskGuid: 'task-1', phaseTaskGuids: ['task-1', 'task-2'], mappingProof: { keyId: trust.mappingKeyId },
      });
      expect(persisted.find(item => item.dispatchRoot === 'om_root_2')).toMatchObject({
        taskGuid: 'task-2', phaseTaskGuids: ['task-1', 'task-2'], mappingProof: { keyId: trust.mappingKeyId },
      });
      await lifecycle.close();
      const restoredBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1', productionMapping: verifier });
      const restored = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: restoredBridge.authority, logger: { warn: () => {} } });
      new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restored, store: restored.getStore()!, bridge: restoredBridge, logger: { warn: () => {} }, mappingTrust: trust });
      expect(restoredBridge.mapping('om_root')).toMatchObject({ taskGuid: 'task-1', phaseTaskGuids: ['task-1', 'task-2'], mappingProof: { keyId: trust.mappingKeyId } });
      expect(restoredBridge.mapping('om_root_2')).toMatchObject({ taskGuid: 'task-2', phaseTaskGuids: ['task-1', 'task-2'], mappingProof: { keyId: trust.mappingKeyId } });
      await restored.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('allows a repaired phase to replace a prior issue-bearing freeze request with one idempotent clean snapshot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-prospective-freeze-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true, freezeEnforcement: true },
        authority: bridge.authority, logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      expect(integration.requestFreeze('om_root', 'request-1')).toBe(true);
      const firstRequest = store.listEvents().find(event => event.eventType === 'phase.freeze_requested')!;
      expect(firstRequest.payload.openIssueCodes).not.toEqual(expect.arrayContaining(['phase_freeze_not_requested', 'phase_state_not_ready']));
      expect(firstRequest.payload.openIssueCodes).toEqual(expect.arrayContaining(['task_acceptance_missing', 'terminal_body_missing']));
      expect(store.getPhaseProjection('project-1', 'phase-1').state).toBe('freeze_pending');

      integration.workerAccepted('om_root', 'accepted');
      integration.workerExecutionStarted('om_root', 'executing');
      integration.firstSubmitted('om_root', 'submitted', { docToken: 'doc-final', docRevision: 1, evidenceRef: 'topic-message:om_submit' });
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType))
        .toEqual(expect.arrayContaining(['task.accepted', 'task.execution_started', 'task.first_submitted'])));

      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const designation = provider.issueDesignatedReviewer({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'],
        reviewRound: 1, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1',
        effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T01:00:00.000Z',
      });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      const verdict = provider.issueVerdict({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap', sourceMessageId: 'om_review',
        sourceVersionHash: `sha256:${'a'.repeat(64)}`, kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
        docToken: 'doc-final', docRevision: 1, expiresAt: '2099-09-05T01:00:00.000Z',
      });
      expect(integration.submitReviewerVerdict({
        dispatchRoot: 'om_root', verdict, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'active' });
      integration.delivered('om_root', 'delivered', {
        docToken: 'doc-final', docRevision: 1, destinationId: 'topic-message:om_delivery', receiptRef: 'topic-message:om_receipt', evidenceRef: 'topic-message:om_delivery',
      });
      integration.doneMarked('om_root', 'done', 'task-comment:done');
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('task_done_pending_freeze'));

      expect(integration.requestFreeze('om_root', 'request-2')).toBe(true);
      const requests = store.listEvents().filter(event => event.eventType === 'phase.freeze_requested');
      expect(store.listEvents().filter(event => event.eventType === 'phase.freeze_requested')).toHaveLength(2);
      expect(requests[1]?.payload).toMatchObject({ openIssueCodes: [], requestRef: 'approval:request-2' });
      expect(store.validatePhaseFreeze('project-1', 'phase-1').ok).toBe(true);
      expect(integration.requestFreeze('om_root', 'request-2')).toBe(true);
      expect(store.listEvents().filter(event => event.eventType === 'phase.freeze_requested')).toHaveLength(2);
      const mapped = integration.mapping('om_root')!;
      expect(lifecycle.freeze({
        eventId: 'freeze-request-2', projectId: mapped.projectId, phaseId: mapped.phaseId,
        authentication: bridge.issueAuthentication('om_root', 'acceptor')!,
        approval: integration.approval('om_root', mapped.approvalGate.approvalRef), idempotencyKey: 'freeze-request-2',
      })).toMatchObject({ kind: 'frozen' });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('replaces a signed PASS verdict without a review transition violation and can still freeze', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-review-correction-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true, freezeEnforcement: true }, authority: bridge.authority, logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const designation = provider.issueDesignatedReviewer({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1',
        effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T01:00:00.000Z',
      });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      integration.workerAccepted('om_root', 'accept');
      integration.workerExecutionStarted('om_root', 'execute');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 1, evidenceRef: 'topic-message:om_submit' });
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('submitted'));
      const issue = (verdictId: string, sourceMessageId: string, supersedesVerdictId?: string, verdict: 'pass' | 'conditional' = 'pass', conditionIds: string[] = []) => provider.issueVerdict({
        verdictId, projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap', sourceMessageId, sourceVersionHash: `sha256:${sourceMessageId.slice(-1).repeat(64)}`,
        kind: 'verdict', verdict, conditionIds, resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 1,
        ...(supersedesVerdictId ? { supersedesVerdictId } : {}), expiresAt: '2099-09-05T01:00:00.000Z',
      });
      const first = issue('verdict-v1', 'om_review_a', undefined, 'conditional', ['c1']);
      expect(integration.submitReviewerVerdict({
        dispatchRoot: 'om_root', verdict: first, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'active' });
      const correction = issue('verdict-v2', 'om_review_b', first.verdictId);
      expect(integration.submitReviewerVerdict({
        dispatchRoot: 'om_root', verdict: correction, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:31:00.000Z',
      })).toMatchObject({ status: 'active', verdict: { verdictId: correction.verdictId } });
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).some(event => event.eventType === 'task.review_corrected')).toBe(true));
      expect(store.getTaskProjection('task-1').transitionViolations).toEqual([]);
      expect(store.getTaskProjection('task-1').unresolvedReviewConditionIds).toEqual([]);
      integration.delivered('om_root', 'deliver', { docToken: 'doc-final', docRevision: 1, destinationId: 'topic-message:om_delivery', receiptRef: 'topic-message:om_receipt', evidenceRef: 'topic-message:om_delivery' });
      integration.doneMarked('om_root', 'done', 'task-comment:done');
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('task_done_pending_freeze'));
      expect(integration.requestFreeze('om_root', 'correction-freeze')).toBe(true);
      expect(store.validatePhaseFreeze('project-1', 'phase-1').ok).toBe(true);
      const mapped = integration.mapping('om_root')!;
      expect(lifecycle.freeze({ eventId: 'freeze-correction', projectId: mapped.projectId, phaseId: mapped.phaseId, authentication: bridge.issueAuthentication('om_root', 'acceptor')!, approval: integration.approval('om_root', mapped.approvalGate.approvalRef), idempotencyKey: 'freeze-correction' })).toMatchObject({ kind: 'frozen' });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('reconciles a post-write/pre-settle task comment across restart without a duplicate create', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-comment-crash-'));
    try {
      const trust = new TaskControlMappingTrust({ hostSecret: 'comment-host-secret', larkAppId: 'app-1' });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const comments: Array<{ id: string; content: string }> = [];
      let creates = 0;
      const deliveryClient = {
        listTaskComments: async () => ({ code: 0, data: { items: comments, has_more: false } }),
        createTaskComment: async ({ content }: { taskGuid: string; content: string }) => { creates++; comments.push({ id: '2001', content }); return { code: 0, commentId: '2001' }; },
        replyTopic: async () => 'om_unused',
        readTopicMessage: async () => ({ items: [] }),
        listTopicMessages: async () => ({ items: [], hasMore: false }),
      };
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const worker = bridge.issueAuthentication('om_root', 'worker')!;
      store.appendEvent({ eventId: 'delivered', eventType: 'task.delivered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'delivered', terminal: true, deliverTo: ['task-comment:task-1'], payload: { docToken: 'doc-final', docRevision: 1 } });
      const first = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'first' })[0]!;
      // First write reaches the provider but the process crashes before settlement.
      expect(await integration.deliver(first)).toEqual({ kind: 'delivered', receiptRef: 'task-comment:2001' });
      expect(creates).toBe(1);
      await lifecycle.close();
      const restartedBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const restarted = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: restartedBridge.authority, logger: { warn: () => {} } });
      const restartedStore = restarted.getStore()!;
      const restartedIntegration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restarted, store: restartedStore, bridge: restartedBridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      restartedStore.resetExpiredOutboxClaims(Date.now() + 61_000, 60_000);
      const retry = restartedStore.claimOutbox({ now: Date.now() + 61_000, limit: 1, claimToken: 'retry' })[0]!;
      expect(await restartedIntegration.deliver(retry)).toEqual({ kind: 'delivered', receiptRef: 'task-comment:2001' });
      expect(creates).toBe(1);
      await restarted.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('atomically degrades a permanently rejected task comment into one topic fallback receipt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-comment-fallback-'));
    try {
      const trust = new TaskControlMappingTrust({ hostSecret: 'fallback-host-secret', larkAppId: 'app-1' });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      let topicReplies = 0;
      let topicContent = '';
      const deliveryClient = {
        listTaskComments: async () => ({ code: 0, data: { items: [], has_more: false } }),
        createTaskComment: async () => ({ code: 1470403 }),
        replyTopic: async ({ content }: { topicRootId: string; content: string; uuid: string }) => { topicReplies++; topicContent = content; return 'om_abc123'; },
        readTopicMessage: async () => ({ items: [{ message_id: 'om_abc123', body: { content: topicContent } }] }),
        listTopicMessages: async () => ({ items: [], hasMore: false }),
      };
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const worker = bridge.issueAuthentication('om_root', 'worker')!;
      store.appendEvent({ eventId: 'delivered', eventType: 'task.delivered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'delivered', terminal: true, deliverTo: ['task-comment:task-1'], payload: { docToken: 'doc-final', docRevision: 1 } });
      const primary = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'primary' })[0]!;
      const rejected = await integration.deliver(primary);
      expect(rejected).toMatchObject({ kind: 'degraded', fallbackDestinationId: 'topic-message:om_root' });
      store.degradeOutboxWithFallback({ eventId: primary.eventId, sourceDestinationId: primary.destinationId, fallbackDestinationId: rejected.fallbackDestinationId!, claimToken: 'primary', error: rejected.error!, now: Date.now() });
      expect(store.listOutbox()).toEqual(expect.arrayContaining([expect.objectContaining({ destinationId: 'task-comment:task-1', status: 'degraded' }), expect.objectContaining({ destinationId: 'topic-message:om_root', status: 'pending' })]));
      const fallback = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'fallback' })[0]!;
      const fallbackResult = await integration.deliver(fallback);
      expect(fallbackResult).toEqual({ kind: 'delivered', receiptRef: 'topic-message:om_abc123' });
      store.settleOutboxDelivered(fallback.outboxId, 'fallback', { receiptRef: TaskControlPlaneStore.providerReceiptRef(fallback.eventId, fallback.destinationId, fallbackResult.receiptRef!) });
      expect(topicReplies).toBe(1);
      expect(store.listEvents().some(event => event.eventType === 'task.delivery_fallback_verified')).toBe(true);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('reconciles a post-write topic crash past UUID TTL by searching the signed marker before any retry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-topic-crash-'));
    try {
      const trust = new TaskControlMappingTrust({ hostSecret: 'topic-crash-host-secret', larkAppId: 'app-1' });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      let replies = 0;
      let topicContent = '';
      const topicMessages: Array<{ message_id: string; body: { content: string } }> = [];
      const deliveryClient = {
        listTaskComments: async () => ({ code: 0, data: { items: [], has_more: false } }),
        createTaskComment: async () => ({ code: 1470403 }),
        replyTopic: async ({ content }: { topicRootId: string; content: string; uuid: string }) => {
          topicContent = content;
          replies++;
          const messageId = 'om_topiccrash';
          topicMessages.push({ message_id: messageId, body: { content } });
          return messageId;
        },
        readTopicMessage: async () => ({ items: [{ message_id: 'om_topiccrash', body: { content: topicContent } }] }),
        listTopicMessages: async () => ({ items: topicMessages, hasMore: false }),
      };
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const worker = bridge.issueAuthentication('om_root', 'worker')!;
      store.appendEvent({ eventId: 'delivered', eventType: 'task.delivered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'delivered', terminal: true, deliverTo: ['task-comment:task-1'], payload: { docToken: 'doc-final', docRevision: 1 } });
      const primary = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'primary' })[0]!;
      const rejected = await integration.deliver(primary);
      expect(rejected).toMatchObject({ kind: 'degraded', fallbackDestinationId: 'topic-message:om_root' });
      store.degradeOutboxWithFallback({ eventId: primary.eventId, sourceDestinationId: primary.destinationId, fallbackDestinationId: rejected.fallbackDestinationId!, claimToken: 'primary', error: rejected.error!, now: Date.now() });
      const fallback = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'fallback' })[0]!;
      expect(await integration.deliver(fallback)).toEqual({ kind: 'delivered', receiptRef: 'topic-message:om_topiccrash' });
      expect(replies).toBe(1);
      // Simulate a crash after provider acknowledgement and source reread but before settle.
      // The provider's one-hour UUID map is intentionally absent after restart.
      await lifecycle.close();
      const restartedBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const restarted = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: restartedBridge.authority, logger: { warn: () => {} } });
      const restartedStore = restarted.getStore()!;
      const restartedIntegration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restarted, store: restartedStore, bridge: restartedBridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      restartedStore.resetExpiredOutboxClaims(Date.now() + 61_000, 60_000);
      const retry = restartedStore.claimOutbox({ now: Date.now() + 61_000, limit: 1, claimToken: 'retry' })[0]!;
      expect(await restartedIntegration.deliver(retry)).toEqual({ kind: 'delivered', receiptRef: 'topic-message:om_topiccrash' });
      expect(replies).toBe(1);
      await restarted.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('never re-sends a topic fallback when a prior effect cannot be reread after UUID expiry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-topic-uncertain-'));
    try {
      const trust = new TaskControlMappingTrust({ hostSecret: 'topic-uncertain-host-secret', larkAppId: 'app-1' });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      let providerWrites = 0;
      let topicContent = '';
      const deliveryClient = {
        listTaskComments: async () => ({ code: 0, data: { items: [], has_more: false } }),
        createTaskComment: async () => ({ code: 1470403 }),
        replyTopic: async ({ content }: { topicRootId: string; content: string; uuid: string }) => { providerWrites++; topicContent = content; return 'om_topicfirst'; },
        readTopicMessage: async () => ({ items: [{ message_id: 'om_topicfirst', body: { content: topicContent } }] }),
        listTopicMessages: async () => ({ items: [], hasMore: false }),
      };
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const worker = bridge.issueAuthentication('om_root', 'worker')!;
      store.appendEvent({ eventId: 'delivered', eventType: 'task.delivered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'delivered', terminal: true, deliverTo: ['task-comment:task-1'], payload: { docToken: 'doc-final', docRevision: 1 } });
      const primary = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'primary' })[0]!;
      const rejected = await integration.deliver(primary);
      store.degradeOutboxWithFallback({ eventId: primary.eventId, sourceDestinationId: primary.destinationId, fallbackDestinationId: rejected.fallbackDestinationId!, claimToken: 'primary', error: rejected.error!, now: Date.now() });
      const fallback = store.claimOutbox({ now: Date.now(), limit: 1, claimToken: 'fallback' })[0]!;
      expect(await integration.deliver(fallback)).toEqual({ kind: 'delivered', receiptRef: 'topic-message:om_topicfirst' });
      expect(providerWrites).toBe(1);
      await lifecycle.close();

      const restartedBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const restarted = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: restartedBridge.authority, logger: { warn: () => {} } });
      const restartedStore = restarted.getStore()!;
      const restartedIntegration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle: restarted, store: restartedStore, bridge: restartedBridge, logger: { warn: () => {} }, mappingTrust: trust, controlledWriteback: true, deliveryClient });
      restartedStore.resetExpiredOutboxClaims(Date.now() + 3_700_000, 60_000);
      const retry = restartedStore.claimOutbox({ now: Date.now() + 3_700_000, limit: 1, claimToken: 'retry' })[0]!;
      expect(await restartedIntegration.deliver(retry)).toEqual({ kind: 'degraded', error: 'topic_effect_uncertain' });
      expect(providerWrites).toBe(1);
      expect(restartedStore.listEvents({ taskGuid: 'task-1' })).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: 'unknown.required', payload: expect.objectContaining({ unknownKey: expect.stringContaining('topic-effect:') }) }),
        expect.objectContaining({ eventType: 'unknown.required', payload: expect.objectContaining({ unknownKey: expect.stringContaining(':unreadable') }) }),
      ]));
      await restarted.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('emits only UNKNOWN when worker activity lacks a registered mapping', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority, logger: { warn: () => {} } });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      integration.workerAccepted('om_missing', 'input-commit:session-1:turn-1');
      await waitFor(() => expect(lifecycle.getStore()!.listObservations()).toHaveLength(1));
      expect(lifecycle.getStore()!.listEvents()).toEqual([]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('records report fallback only as a reference-only UNKNOWN', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority, logger: { warn: () => {} } });
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      integration.reportFallbackUnknown('report:session-1:offline', 'orchestrator_daemon_offline');
      await waitFor(() => expect(lifecycle.getStore()!.listObservations()).toHaveLength(1));
      expect(lifecycle.getStore()!.listEvents()).toEqual([]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('keeps a receipt from a replaced worker generation as reference-only UNKNOWN', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-stale-receipt-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} },
        isLiveReceiptOwner: ({ sessionId, workerGeneration }) => sessionId === 'session-b' && workerGeneration === 2,
      });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      await integration.finalDeliveryReceived('om_root', 'delivery:session-a:1:turn-1:receipt-a', {
        sessionId: 'session-a', workerGeneration: 1, destinationId: 'topic-message:om_root', receiptRef: 'topic-message:om_receipt_a', docToken: 'doc-token-12345678',
      });
      await waitFor(() => expect(store.listObservations()).toEqual(expect.arrayContaining([expect.objectContaining({
        attemptedEventType: 'task.delivered', outcome: 'unknown', payload: expect.objectContaining({ reason: 'receipt_worker_generation_unproven' }),
      })])));
      expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType)).not.toContain('task.delivered');
      expect(store.listOutbox()).toEqual([]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('records mapped worker hooks without trusting hook payload identities and derives approval only from its gate source', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const approvalRef = integration.mapping('om_root')!.approvalGate.approvalRef;
      const proof = integration.approval('om_root', approvalRef);
      expect(bridge.authority.verifyApproval({
        approval: proof, projectId: 'project-1', phaseId: 'phase-1', taskSetSnapshot: ['task-1'], acceptorId: 'acceptor-1', now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ approvalRef });
      integration.workerAccepted('om_root', 'input-commit:session-1:turn-1');
      integration.workerExecutionStarted('om_root', 'execution:session-1:turn-1');
      await waitFor(() => expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' })).toHaveLength(3));
      expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' })).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: 'task.accepted', actorId: 'worker-1', actorRole: 'worker' }),
        expect.objectContaining({ eventType: 'task.execution_started', actorId: 'worker-1', actorRole: 'worker' }),
      ]));
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('keeps generic review and rework hints reference-only while preserving verified worker lifecycle facts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-integration-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store: lifecycle.getStore()!, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      integration.workerAccepted('om_root', 'accept');
      integration.workerExecutionStarted('om_root', 'execute');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 7, evidenceRef: 'task-comment:101' });
      integration.reviewed('om_root', 'review', {
        reviewRound: 1, reviewCommentId: 'comment-1', verdict: 'conditional', conditionIds: ['c-1'],
        resolvedConditionEvidence: { 'c-1': { evidenceRef: 'task-comment:102', observedAt: '2026-09-05T00:30:00.000Z' } },
        reviewerVerdictId: 'unverified-verdict', docToken: 'doc-final', docRevision: 7, evidenceRef: 'task-comment:102',
      });
      integration.reworkStarted('om_root', 'rework', 'task-comment:103');
      integration.firstSubmitted('om_root', 'resubmit', { docToken: 'doc-final', docRevision: 8, evidenceRef: 'task-comment:104' });
      integration.reviewed('om_root', 'review-final', {
        reviewRound: 2, reviewCommentId: 'comment-2', verdict: 'pass', reviewerVerdictId: 'unverified-verdict-final',
        docToken: 'doc-final', docRevision: 8, evidenceRef: 'task-comment:105',
      });
      integration.delivered('om_root', 'deliver', {
        docToken: 'doc-final', docRevision: 8, destinationId: 'topic-message:om_delivery', receiptRef: 'topic-message:om_delivery_receipt', evidenceRef: 'topic-message:om_delivery_receipt',
      });
      integration.doneMarked('om_root', 'done', 'task-comment:106');
      await waitFor(() => expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType)).toEqual(expect.arrayContaining([
        'task.first_submitted', 'task.delivered', 'task.done_marked',
      ])));
      expect(lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType))
        .not.toEqual(expect.arrayContaining(['task.reviewed', 'task.rework_started']));
      await waitFor(() => expect(lifecycle.getStore()!.listObservations()).toEqual(expect.arrayContaining([
        expect.objectContaining({ attemptedEventType: 'task.reviewed', outcome: 'unknown' }),
        expect.objectContaining({ attemptedEventType: 'task.rework_started', outcome: 'unknown' }),
      ])));
      const terminal = lifecycle.getStore()!.listEvents({ taskGuid: 'task-1' }).filter(event => event.eventType === 'task.delivered').at(-1)!;
      expect(lifecycle.getStore()!.listOutbox({ eventId: terminal.eventId })[0]).toMatchObject({ status: 'delivered', destinationId: 'topic-message:om_delivery' });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('starts rework only from the active conditional verdict and a later daemon-owned execution fact', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-rework-producer-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const designation = provider.issueDesignatedReviewer({ projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1', effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T01:00:00.000Z' });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      integration.workerAccepted('om_root', 'accept'); integration.workerExecutionStarted('om_root', 'execution-before-review');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 1, evidenceRef: 'task-comment:101' });
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('submitted'));
      const verdict = provider.issueVerdict({ projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review', sourceMessageId: 'om_review', sourceVersionHash: `sha256:${'a'.repeat(64)}`, kind: 'verdict', verdict: 'conditional', conditionIds: ['c1'], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 1, expiresAt: '2099-09-05T01:00:00.000Z' });
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const submittedVerdict = integration.submitReviewerVerdict({ dispatchRoot: 'om_root', verdict, authentication: reviewer, attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review' }, verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z' });
      expect(submittedVerdict).toEqual(expect.objectContaining({ status: 'active' }));
      integration.workerExecutionStarted('om_root', 'execution-after-review');
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).some(event => event.sourceRef === 'execution-after-review')).toBe(true));
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('rework'));
      const execution = store.listEvents({ taskGuid: 'task-1' }).find(event => event.sourceRef === 'execution-after-review')!;
      expect(store.listEvents({ taskGuid: 'task-1' }).find(event => event.eventType === 'task.rework_started')).toMatchObject({
        payload: { sourceReviewerVerdictId: verdict.verdictId, newExecutionEventId: execution.eventId },
      });
      expect(integration.beginRework({ dispatchRoot: 'om_root', sourceRef: 'rework:bad', sourceReviewerVerdictId: verdict.verdictId, newExecutionEventId: 'missing', evidenceRef: 'task-comment:103' })).toMatchObject({ ok: false });
      expect(store.getTaskProjection('task-1').state).toBe('rework');
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('starts rework from a superseding FAIL only after a fresh execution fact', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-corrected-rework-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const designation = provider.issueDesignatedReviewer({ projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1', effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T01:00:00.000Z' });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      integration.workerAccepted('om_root', 'accept'); integration.workerExecutionStarted('om_root', 'execution-initial');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 1, evidenceRef: 'topic-message:om_submit' });
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('submitted'));
      const make = (verdictId: string, kind: 'pass' | 'fail', supersedesVerdictId?: string) => provider.issueVerdict({ verdictId, projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap', sourceMessageId: `om_${verdictId}`, sourceVersionHash: `sha256:${verdictId.slice(-1).repeat(64)}`, kind: 'verdict', verdict: kind, conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 1, ...(supersedesVerdictId ? { supersedesVerdictId } : {}), expiresAt: '2099-09-05T01:00:00.000Z' });
      const first = make('review-v1', 'pass');
      expect(integration.submitReviewerVerdict({ dispatchRoot: 'om_root', verdict: first, authentication: reviewer, attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap' }, verifyVerdict: value => provider.verifyVerdict(value) })).toMatchObject({ status: 'active' });
      const corrected = make('review-v2', 'fail', first.verdictId);
      expect(integration.submitReviewerVerdict({ dispatchRoot: 'om_root', verdict: corrected, authentication: reviewer, attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap' }, verifyVerdict: value => provider.verifyVerdict(value) })).toMatchObject({ status: 'active', verdict: { verdictId: corrected.verdictId } });
      expect(store.getTaskProjection('task-1').state).toBe('reviewing');
      integration.workerExecutionStarted('om_root', 'execution-after-correction');
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('rework'));
      expect(store.listEvents({ taskGuid: 'task-1' }).find(event => event.eventType === 'task.rework_started')).toMatchObject({ payload: { sourceReviewerVerdictId: corrected.verdictId } });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('reopens an auto-delivered PASS correction safely when superseded by FAIL', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-delivered-correction-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} }, controlledWriteback: true });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider(); store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const designation = provider.issueDesignatedReviewer({ projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1', effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2099-09-05T01:00:00.000Z' });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      integration.workerAccepted('om_root', 'accept'); integration.workerExecutionStarted('om_root', 'execute');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 1, evidenceRef: 'topic-message:om_submit' });
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('submitted'));
      const issue = (verdictId: string, verdict: 'pass' | 'fail', supersedesVerdictId?: string) => provider.issueVerdict({ verdictId, projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1, designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap', sourceMessageId: `om_${verdictId}`, sourceVersionHash: `sha256:${verdictId.slice(-1).repeat(64)}`, kind: 'verdict', verdict, conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 1, ...(supersedesVerdictId ? { supersedesVerdictId } : {}), expiresAt: '2099-09-05T01:00:00.000Z' });
      const first = issue('auto-v1', 'pass');
      expect(integration.submitReviewerVerdict({ dispatchRoot: 'om_root', verdict: first, authentication: reviewer, attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap' }, verifyVerdict: value => provider.verifyVerdict(value) })).toMatchObject({ status: 'active' });
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('delivered'));
      integration.doneMarked('om_root', 'done', 'task-comment:done');
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('task_done_pending_freeze'));
      const correction = issue('auto-v2', 'fail', first.verdictId);
      expect(integration.submitReviewerVerdict({ dispatchRoot: 'om_root', verdict: correction, authentication: reviewer, attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 1, capability: 'review-cap' }, verifyVerdict: value => provider.verifyVerdict(value) })).toMatchObject({ status: 'active', verdict: { verdictId: correction.verdictId } });
      expect(store.getTaskProjection('task-1').state).toBe('reviewing');
      expect(store.getTaskProjection('task-1').transitionViolations).toEqual([]);
      integration.workerExecutionStarted('om_root', 'execution-after-delivery-correction');
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('rework'));
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('binds a verified verdict id to review and rejects that same review after verifier/head changes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-reviewer-integration-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const designation = provider.issueDesignatedReviewer({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1',
        effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
      });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const verdict = provider.issueVerdict({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_review',
        sourceVersionHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(integration.submitReviewerVerdict({
        dispatchRoot: 'om_root', verdict, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'active', verdict: { verdictId: verdict.verdictId } });
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).some(event => event.payload.reviewerVerdictId === verdict.verdictId)).toBe(true));
      const review = store.getTaskProjection('task-1', '2026-09-05T00:30:00.000Z').independentReview!;
      expect(review.reviewerVerdictId).toBe(verdict.verdictId);
      expect(store.validatePhaseFreeze('project-1', 'phase-1', '2026-09-05T00:30:00.000Z').issues.map(issue => issue.code))
        .not.toContain('reviewer_verdict_unverified');
      store.setReviewerVerdictVerifier(undefined);
      expect(store.getTaskProjection('task-1', '2026-09-05T00:30:00.000Z')).toMatchObject({ reviewerVerdictIssue: expect.any(String) });
      store.setReviewerVerdictVerifier(provider);
      expect(store.getTaskProjection('task-1', '2026-09-05T01:00:00.000Z')).toMatchObject({ reviewerVerdictIssue: expect.any(String) });
      const revocation = provider.issueVerdict({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_revoke',
        sourceVersionHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        kind: 'revocation', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        revokesVerdictId: verdict.verdictId, expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(store.appendReviewerVerdict({
        verdict: revocation, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'revoked' });
      expect(store.getTaskProjection('task-1', '2026-09-05T00:30:00.000Z')).toMatchObject({ reviewerVerdictIssue: expect.any(String) });
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('does not report a verified verdict active when its synchronous task.reviewed append conflicts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-reviewer-append-conflict-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const designation = provider.issueDesignatedReviewer({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1',
        effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
      });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      integration.workerAccepted('om_root', 'accept', '2026-09-05T00:10:00.000Z');
      integration.workerExecutionStarted('om_root', 'execute', '2026-09-05T00:11:00.000Z');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 8, evidenceRef: 'topic-message:om_submit' });
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType))
        .toEqual(expect.arrayContaining(['task.accepted', 'task.execution_started', 'task.first_submitted'])));
      const verdict = provider.issueVerdict({
        verdictId: 'append-failure', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_review',
        sourceVersionHash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(store.appendReviewerVerdict({
        verdict, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'active' });
      const sourceRef = 'reviewer-verdict:append-failure';
      store.appendEvent({
        eventId: 'prior-reviewed', eventType: 'task.reviewed', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root',
        authentication: reviewer, sourceRef, occurredAt: '2026-09-05T00:30:00.000Z', idempotencyKey: 'task-control:task.reviewed:reviewer-verdict:append-failure',
        payload: { reviewRound: 1, reviewCommentId: 'om_prior', independent: true, verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, reviewerVerdictId: verdict.verdictId, docToken: 'doc-final', docRevision: 8 },
      });
      expect(integration.submitReviewerVerdict({
        dispatchRoot: 'om_root', verdict, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'unknown', reason: 'reviewer_verdict_reviewed_append_conflict' });
      expect(store.listEvents({ taskGuid: 'task-1' }).filter(event => event.payload.reviewerVerdictId === 'append-failure'))
        .toEqual([expect.objectContaining({ eventId: 'prior-reviewed' })]);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('rejects phase freeze after the active reviewer verdict is revoked', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-reviewer-freeze-'));
    try {
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({ dataDir, larkAppId: 'app-1', flags: { ledgerEnabled: true }, authority: bridge.authority, logger: { warn: () => {} } });
      const store = lifecycle.getStore()!;
      const integration = new DaemonTaskControlIntegration({ dataDir, larkAppId: 'app-1', lifecycle, store, bridge, logger: { warn: () => {} } });
      expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
      const provider = reviewerProvider();
      store.setReviewerVerdictVerifier(provider);
      const controller = bridge.issueAuthentication('om_root', 'controller')!;
      const reviewer = bridge.issueAuthentication('om_root', 'reviewer')!;
      const designation = provider.issueDesignatedReviewer({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', controllerId: 'controller-1', controllerBotAppId: 'app-1',
        effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
      });
      integration.registerDesignatedReviewer({ mapping: designation, authentication: controller, verify: value => provider.verifyDesignatedReviewer(value) });
      integration.workerAccepted('om_root', 'accept', '2026-09-05T00:10:00.000Z');
      integration.workerExecutionStarted('om_root', 'execute', '2026-09-05T00:11:00.000Z');
      integration.firstSubmitted('om_root', 'submit', { docToken: 'doc-final', docRevision: 8, evidenceRef: 'topic-message:om_submit' });
      await waitFor(() => expect(store.listEvents({ taskGuid: 'task-1' }).map(event => event.eventType))
        .toEqual(expect.arrayContaining(['task.accepted', 'task.execution_started', 'task.first_submitted'])));
      const verdict = provider.issueVerdict({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_review',
        sourceVersionHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(integration.submitReviewerVerdict({
        dispatchRoot: 'om_root', verdict, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'active' });
      await waitFor(() => expect(store.getTaskProjection('task-1', '2026-09-05T00:30:00.000Z').state).toBe('reviewing'));
      integration.delivered('om_root', 'deliver', {
        docToken: 'doc-final', docRevision: 8, destinationId: 'topic-message:om_delivery', receiptRef: 'topic-message:om_delivery_receipt', evidenceRef: 'topic-message:om_delivery_receipt',
      });
      integration.doneMarked('om_root', 'done', 'task-comment:101');
      await waitFor(() => expect(store.getTaskProjection('task-1').state).toBe('task_done_pending_freeze'));
      store.appendEvent({
        eventId: 'freeze-request', eventType: 'phase.freeze_requested', projectId: 'project-1', phaseId: 'phase-1', authentication: controller,
        idempotencyKey: 'freeze-request', sourceRef: 'task-comment:102',
        payload: { taskGuids: ['task-1'], openIssueCodes: [], requestRef: 'task-comment:102' },
      });
      expect(store.validatePhaseFreeze('project-1', 'phase-1', '2026-09-05T00:30:00.000Z').ok).toBe(true);
      const revocation = provider.issueVerdict({
        projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', taskSetSnapshot: ['task-1'], reviewRound: 1,
        designatedReviewerRef: designation.designatedReviewerRef, reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app',
        sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap', sourceMessageId: 'om_revoke',
        sourceVersionHash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        kind: 'revocation', conditionIds: [], resolvedConditionEvidence: {}, docToken: 'doc-final', docRevision: 8,
        revokesVerdictId: verdict.verdictId, expiresAt: '2026-09-05T01:00:00.000Z',
      });
      expect(store.appendReviewerVerdict({
        verdict: revocation, authentication: reviewer,
        attestation: { reviewerId: 'reviewer-1', reviewerBotAppId: 'reviewer-app', sessionId: 'review-session', workerGeneration: 2, capability: 'review-cap' },
        verifyVerdict: value => provider.verifyVerdict(value), now: '2026-09-05T00:30:00.000Z',
      })).toMatchObject({ status: 'revoked' });
      const rejected = store.freezePhase({
        eventId: 'freeze-after-revoke', projectId: 'project-1', phaseId: 'phase-1',
        authentication: bridge.issueAuthentication('om_root', 'acceptor')!, approval: integration.approval('om_root', integration.mapping('om_root')!.approvalGate.approvalRef),
        idempotencyKey: 'freeze-after-revoke', occurredAt: '2026-09-05T00:30:00.000Z',
      });
      expect(rejected).toMatchObject({ kind: 'rejected' });
      expect(rejected.validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reviewer_verdict_unverified' })]));
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('holds a reviewer evidence back with 425 dependency_pending until the mapped worker task.first_submitted for the same round arrives, then resumes without duplicate lifecycle', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-holdback-dep-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T00:20:00.000Z'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const reviewerAppId = 'cli_review_1234567890123456';
      const acceptorAppId = 'cli_accept_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
        hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
      });
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
        projectReviewerTrust,
      });
      integration.setReviewerVerdictVerifier(projectReviewerTrust);
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: reviewerAppId, acceptorId: acceptorAppId,
        registrationRef: 'topic-message:om_projectroot',
        mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId, mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const workerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: workerAppId });
      const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerAppId });
      const reviewArtifact = {
        kind: 'project_report' as const, reportRequestId: 'report:review', triggerId: 'trg-review',
        dispatchRoot: 'om_projectroot', sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review',
        reporterAppId: reviewerAppId, targetSessionId: 'session-controller',
        projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
      };
      const reviewerVerdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        verdictId: 'rv_project_review', projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot', taskSetSnapshot: ['task-project'], reviewRound: 1,
        designatedReviewerRef: reviewerDesignationRef('om_projectroot', reviewerAppId, 1, 4),
        reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
        sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
        sourceMessageId: 'trg-review', sourceVersionHash: reviewArtifact.contentHash,
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
        artifactEvidence: reviewArtifact, issuedAt: '2026-09-29T00:20:00.000Z', expiresAt: '2099-09-29T00:20:00.000Z',
      });
      const reviewed = reviewerTrust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'reviewed',
        sourceAppId: reviewerAppId, controllerAppId,
        sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review', workerGeneration: 4, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:20:00.000Z',
        reportRequestId: 'report:review', triggerId: 'trg-review', targetSessionId: 'session-controller',
        contentHash: `sha256:${'b'.repeat(64)}`, projectRevision: 6, reviewVerdict: 'pass', reviewRound: 1,
        reviewerVerdict,
      });
      // Reviewer arrives BEFORE any worker task.first_submitted → holdback returns 425.
      const first = integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value));
      expect(first).toEqual({ ok: false, reason: 'dependency_pending' });
      // No lifecycle side effects: no task.reviewed / task.delivered.
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual(['mapping.registered']);
      // Immutable first-ingress row is present exactly once, and its receivedAt is the reviewer occurredAt.
      const holdbackRows = store.listObservations()
        .filter(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`);
      expect(holdbackRows).toHaveLength(1);
      expect(holdbackRows[0].occurredAt).toBe('2026-09-29T00:20:00.000Z');
      // An exact reviewer retry at a later wall clock keeps 425 and does not add a new observation.
      const replay = integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value));
      expect(replay).toEqual({ ok: false, reason: 'dependency_pending' });
      expect(store.listObservations()
        .filter(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`)).toHaveLength(1);
      // Worker submits first-round evidence — dependency is satisfied.
      const workerLifecycle = {
        schemaVersion: 'ProjectWorkerEvidence.v1' as const, sourceAppId: workerAppId, controllerAppId,
        sourceSessionId: 'session-worker', sourceTurnId: 'turn-1', workerGeneration: 2, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot',
      };
      for (const eventKind of ['accepted', 'execution_started'] as const) {
        expect(integration.ingestProjectWorkerEvidence(
          workerTrust.issue({ ...workerLifecycle, eventKind, occurredAt: '2026-09-29T00:00:00.000Z' }),
          value => workerTrust.verify(value),
        )).toMatchObject({ ok: true });
      }
      const submitted = workerTrust.issue({
        ...workerLifecycle, eventKind: 'submitted', occurredAt: '2026-09-29T00:10:00.000Z',
        reportRequestId: 'report:worker', triggerId: 'trg-worker', targetSessionId: 'session-controller',
        contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 5,
      });
      expect(integration.ingestProjectWorkerEvidence(submitted, value => workerTrust.verify(value)))
        .toMatchObject({ ok: true });
      // Now the reviewer resumes — the immutable receivedAt is preserved, so no fresh time is minted.
      const resumed = integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value));
      expect(resumed).toMatchObject({ ok: true });
      // Exactly one task.reviewed / task.delivered / task.done_marked chain.
      const chain = store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType);
      expect(chain.filter(item => item === 'task.reviewed')).toHaveLength(1);
      expect(chain.filter(item => item === 'task.delivered')).toHaveLength(1);
      expect(chain.filter(item => item === 'task.done_marked')).toHaveLength(1);
      // Idempotent replay of the reviewer evidence after resumption does not duplicate anything.
      expect(integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value)))
        .toMatchObject({ ok: true });
      const chainAfterReplay = store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType);
      expect(chainAfterReplay.filter(item => item === 'task.reviewed')).toHaveLength(1);
      expect(chainAfterReplay.filter(item => item === 'task.delivered')).toHaveLength(1);
      expect(chainAfterReplay.filter(item => item === 'task.done_marked')).toHaveLength(1);
      expect(store.listObservations()
        .filter(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`)).toHaveLength(1);

      const supersedingVerdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        verdictId: 'rv_project_review_superseding', projectId: reviewerVerdict.projectId,
        phaseId: reviewerVerdict.phaseId, taskGuid: reviewerVerdict.taskGuid,
        topicRootId: reviewerVerdict.topicRootId, taskSetSnapshot: reviewerVerdict.taskSetSnapshot,
        reviewRound: reviewerVerdict.reviewRound, designatedReviewerRef: reviewerVerdict.designatedReviewerRef,
        reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId, sessionId: reviewerVerdict.sessionId,
        workerGeneration: reviewerVerdict.workerGeneration, capability: 'review-capability',
        sourceMessageId: reviewerVerdict.sourceMessageId, sourceVersionHash: reviewerVerdict.sourceVersionHash,
        kind: 'verdict', verdict: 'fail', conditionIds: [], resolvedConditionEvidence: {},
        artifactEvidence: reviewArtifact, supersedesVerdictId: reviewerVerdict.verdictId,
        issuedAt: '2026-09-29T00:21:00.000Z', expiresAt: reviewerVerdict.expiresAt,
      });
      expect(store.appendReviewerVerdict({
        verdict: supersedingVerdict,
        attestation: {
          reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId, sessionId: reviewerVerdict.sessionId,
          workerGeneration: reviewerVerdict.workerGeneration, capability: 'review-capability',
        },
        authentication: bridge.issueAuthentication('om_projectroot', 'reviewer')!,
        verifyVerdict: value => projectReviewerTrust.verifyVerdict(value),
        now: store.listObservations()
          .find(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`)!.occurredAt,
      })).toMatchObject({ status: 'active', verdict: { verdictId: supersedingVerdict.verdictId } });
      const eventsBeforeSupersededReplay = store.listEvents({ taskGuid: 'task-project' });
      expect(integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value)))
        .toEqual({ ok: false, reason: 'reviewer_verdict_superseded' });
      expect(store.listEvents({ taskGuid: 'task-project' })).toEqual(eventsBeforeSupersededReplay);

      const revocation = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        verdictId: 'rv_project_review_revocation', projectId: reviewerVerdict.projectId,
        phaseId: reviewerVerdict.phaseId, taskGuid: reviewerVerdict.taskGuid,
        topicRootId: reviewerVerdict.topicRootId, taskSetSnapshot: reviewerVerdict.taskSetSnapshot,
        reviewRound: reviewerVerdict.reviewRound, designatedReviewerRef: reviewerVerdict.designatedReviewerRef,
        reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId, sessionId: reviewerVerdict.sessionId,
        workerGeneration: reviewerVerdict.workerGeneration, capability: 'review-capability',
        sourceMessageId: reviewerVerdict.sourceMessageId, sourceVersionHash: reviewerVerdict.sourceVersionHash,
        kind: 'revocation', conditionIds: [], resolvedConditionEvidence: {}, artifactEvidence: reviewArtifact,
        revokesVerdictId: supersedingVerdict.verdictId,
        issuedAt: '2026-09-29T00:22:00.000Z', expiresAt: reviewerVerdict.expiresAt,
      });
      expect(store.appendReviewerVerdict({
        verdict: revocation,
        attestation: {
          reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId, sessionId: reviewerVerdict.sessionId,
          workerGeneration: reviewerVerdict.workerGeneration, capability: 'review-capability',
        },
        authentication: bridge.issueAuthentication('om_projectroot', 'reviewer')!,
        verifyVerdict: value => projectReviewerTrust.verifyVerdict(value),
        now: store.listObservations()
          .find(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`)!.occurredAt,
      })).toMatchObject({ status: 'revoked', verdict: { verdictId: revocation.verdictId } });
      expect(integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value)))
        .toEqual({ ok: false, reason: 'reviewer_verdict_revoked' });
      expect(store.listEvents({ taskGuid: 'task-project' })).toEqual(eventsBeforeSupersededReplay);
      await lifecycle.close();
    } finally {
      vi.useRealTimers();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('permanently rejects a reviewer evidence whose verdict identity/signature is tampered without ever creating a first-ingress row', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-holdback-forge-'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const reviewerAppId = 'cli_review_1234567890123456';
      const acceptorAppId = 'cli_accept_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
        hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
      });
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
        projectReviewerTrust,
      });
      integration.setReviewerVerdictVerifier(projectReviewerTrust);
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: reviewerAppId, acceptorId: acceptorAppId,
        registrationRef: 'topic-message:om_projectroot',
        mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId, mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerAppId });
      const reviewArtifact = {
        kind: 'project_report' as const, reportRequestId: 'report:review', triggerId: 'trg-review',
        dispatchRoot: 'om_projectroot', sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review',
        reporterAppId: reviewerAppId, targetSessionId: 'session-controller',
        projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
      };
      const reviewerVerdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        verdictId: 'rv_project_review_forge', projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot', taskSetSnapshot: ['task-project'], reviewRound: 1,
        designatedReviewerRef: reviewerDesignationRef('om_projectroot', reviewerAppId, 1, 4),
        reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
        sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
        sourceMessageId: 'trg-review', sourceVersionHash: reviewArtifact.contentHash,
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
        artifactEvidence: reviewArtifact, issuedAt: '2026-09-29T00:20:00.000Z', expiresAt: '2099-09-29T00:20:00.000Z',
      });
      const forged = reviewerTrust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'reviewed',
        sourceAppId: reviewerAppId, controllerAppId,
        sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review', workerGeneration: 4, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:20:00.000Z',
        reportRequestId: 'report:review', triggerId: 'trg-review', targetSessionId: 'session-controller',
        contentHash: `sha256:${'b'.repeat(64)}`, projectRevision: 6, reviewVerdict: 'pass', reviewRound: 1,
        reviewerVerdict: { ...reviewerVerdict, signature: '0'.repeat(64) },
      });
      const result = integration.ingestProjectWorkerEvidence(forged, value => reviewerTrust.verify(value));
      expect(result).toMatchObject({ ok: false });
      expect(result.ok).toBe(false);
      // A forged reviewer never becomes a controller first-ingress fact.
      expect(store.listObservations()
        .filter(item => item.idempotencyKey.startsWith('evidence-holdback:'))).toEqual([]);
      // No lifecycle events besides the mapping.
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual(['mapping.registered']);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('resumes a reviewer holdback across controller restart with the same first-ingress receivedAt and does not reopen the exact evidence chain', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-holdback-restart-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T00:30:00.000Z'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const reviewerAppId = 'cli_review_1234567890123456';
      const acceptorAppId = 'cli_accept_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
        hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
      });
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
        projectReviewerTrust,
      });
      integration.setReviewerVerdictVerifier(projectReviewerTrust);
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: reviewerAppId, acceptorId: acceptorAppId,
        registrationRef: 'topic-message:om_projectroot',
        mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId, mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerAppId });
      const reviewArtifact = {
        kind: 'project_report' as const, reportRequestId: 'report:review', triggerId: 'trg-review',
        dispatchRoot: 'om_projectroot', sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review',
        reporterAppId: reviewerAppId, targetSessionId: 'session-controller',
        projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
      };
      const reviewerVerdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        verdictId: 'rv_project_review_restart', projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot', taskSetSnapshot: ['task-project'], reviewRound: 1,
        designatedReviewerRef: reviewerDesignationRef('om_projectroot', reviewerAppId, 1, 4),
        reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
        sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
        sourceMessageId: 'trg-review', sourceVersionHash: reviewArtifact.contentHash,
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
        artifactEvidence: reviewArtifact, issuedAt: '2026-09-29T00:20:00.000Z', expiresAt: '2026-09-29T00:40:00.000Z',
      });
      const reviewed = reviewerTrust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'reviewed',
        sourceAppId: reviewerAppId, controllerAppId,
        sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review', workerGeneration: 4, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:20:00.000Z',
        reportRequestId: 'report:review', triggerId: 'trg-review', targetSessionId: 'session-controller',
        contentHash: `sha256:${'b'.repeat(64)}`, projectRevision: 6, reviewVerdict: 'pass', reviewRound: 1,
        reviewerVerdict,
      });
      expect(integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value)))
        .toEqual({ ok: false, reason: 'dependency_pending' });
      expect(store.listObservations()
        .filter(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`)).toHaveLength(1);
      await lifecycle.close();
      vi.setSystemTime(new Date('2026-09-29T00:50:00.000Z'));

      // Restart the controller — the immutable observations row survives and the receivedAt
      // preserved from the first ingress is the sole controller time on resumption.
      const restartedBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const restartedLifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: restartedBridge.authority,
        logger: { warn: () => {} },
      });
      const restartedStore = restartedLifecycle.getStore()!;
      const restartedProjectReviewerTrust = createDaemonReviewerVerdictVerifier({
        hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
      });
      const restarted = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle: restartedLifecycle, store: restartedStore, bridge: restartedBridge,
        logger: { warn: () => {} }, projectReviewerTrust: restartedProjectReviewerTrust,
      });
      restarted.setReviewerVerdictVerifier(restartedProjectReviewerTrust);
      // Holdback row survived.
      expect(restartedStore.listObservations()
        .filter(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`)).toHaveLength(1);
      // Worker submits after restart — the reviewer resumes on the very next retry.
      const workerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: workerAppId });
      const workerLifecycle = {
        schemaVersion: 'ProjectWorkerEvidence.v1' as const, sourceAppId: workerAppId, controllerAppId,
        sourceSessionId: 'session-worker', sourceTurnId: 'turn-1', workerGeneration: 2, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot',
      };
      for (const eventKind of ['accepted', 'execution_started'] as const) {
        expect(restarted.ingestProjectWorkerEvidence(
          workerTrust.issue({ ...workerLifecycle, eventKind, occurredAt: '2026-09-29T01:00:00.000Z' }),
          value => workerTrust.verify(value),
        )).toMatchObject({ ok: true });
      }
      expect(restarted.ingestProjectWorkerEvidence(
        workerTrust.issue({
          ...workerLifecycle, eventKind: 'submitted', occurredAt: '2026-09-29T01:10:00.000Z',
          reportRequestId: 'report:worker', triggerId: 'trg-worker', targetSessionId: 'session-controller',
          contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 5,
        }),
        value => workerTrust.verify(value),
      )).toMatchObject({ ok: true });
      expect(restarted.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value)))
        .toMatchObject({ ok: true });
      const chain = restartedStore.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType);
      expect(chain.filter(item => item === 'task.reviewed')).toHaveLength(1);
      expect(chain.filter(item => item === 'task.delivered')).toHaveLength(1);
      expect(chain.filter(item => item === 'task.done_marked')).toHaveLength(1);
      // The immutable first-ingress row still carries the original controller receivedAt.
      expect(restartedStore.listObservations()
        .filter(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`)[0].occurredAt)
        .toBe('2026-09-29T00:30:00.000Z');
      expect(restarted.currentDesignatedReviewer(
        'om_projectroot', 1, '2026-09-29T00:30:00.000Z',
      )).toMatchObject({ effectiveAt: '2026-09-29T00:30:00.000Z' });
      await restartedLifecycle.close();
    } finally {
      vi.useRealTimers();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('resumes an exact reviewer evidence past task.reviewed without adding a second task.reviewed row', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-holdback-partial-'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const reviewerAppId = 'cli_review_1234567890123456';
      const acceptorAppId = 'cli_accept_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
        hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
      });
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
        projectReviewerTrust,
      });
      integration.setReviewerVerdictVerifier(projectReviewerTrust);
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: reviewerAppId, acceptorId: acceptorAppId,
        registrationRef: 'topic-message:om_projectroot',
        mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId, mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const workerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: workerAppId });
      const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerAppId });
      const workerLifecycle = {
        schemaVersion: 'ProjectWorkerEvidence.v1' as const, sourceAppId: workerAppId, controllerAppId,
        sourceSessionId: 'session-worker', sourceTurnId: 'turn-1', workerGeneration: 2, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot',
      };
      for (const eventKind of ['accepted', 'execution_started'] as const) {
        expect(integration.ingestProjectWorkerEvidence(
          workerTrust.issue({ ...workerLifecycle, eventKind, occurredAt: '2026-09-29T00:00:00.000Z' }),
          value => workerTrust.verify(value),
        )).toMatchObject({ ok: true });
      }
      expect(integration.ingestProjectWorkerEvidence(
        workerTrust.issue({
          ...workerLifecycle, eventKind: 'submitted', occurredAt: '2026-09-29T00:10:00.000Z',
          reportRequestId: 'report:worker', triggerId: 'trg-worker', targetSessionId: 'session-controller',
          contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 5,
        }),
        value => workerTrust.verify(value),
      )).toMatchObject({ ok: true });
      const reviewArtifact = {
        kind: 'project_report' as const, reportRequestId: 'report:review', triggerId: 'trg-review',
        dispatchRoot: 'om_projectroot', sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review',
        reporterAppId: reviewerAppId, targetSessionId: 'session-controller',
        projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
      };
      const reviewerVerdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        verdictId: 'rv_project_review', projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot', taskSetSnapshot: ['task-project'], reviewRound: 1,
        designatedReviewerRef: reviewerDesignationRef('om_projectroot', reviewerAppId, 1, 4),
        reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
        sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
        sourceMessageId: 'trg-review', sourceVersionHash: reviewArtifact.contentHash,
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
        artifactEvidence: reviewArtifact, issuedAt: '2026-09-29T00:20:00.000Z', expiresAt: '2099-09-29T00:20:00.000Z',
      });
      const reviewed = reviewerTrust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'reviewed',
        sourceAppId: reviewerAppId, controllerAppId,
        sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review', workerGeneration: 4, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:20:00.000Z',
        reportRequestId: 'report:review', triggerId: 'trg-review', targetSessionId: 'session-controller',
        contentHash: `sha256:${'b'.repeat(64)}`, projectRevision: 6, reviewVerdict: 'pass', reviewRound: 1,
        reviewerVerdict,
      });
      // Successful full ingest.
      expect(integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value)))
        .toMatchObject({ ok: true });
      // Retry after full success: idempotent — chain length stays fixed, first-ingress row unique.
      expect(integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value)))
        .toMatchObject({ ok: true });
      const chain = store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType);
      expect(chain.filter(item => item === 'task.reviewed')).toHaveLength(1);
      expect(chain.filter(item => item === 'task.delivered')).toHaveLength(1);
      expect(chain.filter(item => item === 'task.done_marked')).toHaveLength(1);
      expect(store.listObservations()
        .filter(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`)).toHaveLength(1);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('resumes the exact reviewer evidence after crashes at every ordered journal boundary', async () => {
    const crashPoints = ['designation', 'verdict', 'reviewed', 'delivered', 'receipt', 'done'] as const;
    for (const crashPoint of crashPoints) {
      const dataDir = mkdtempSync(join(tmpdir(), `botmux-task-control-review-crash-${crashPoint}-`));
      try {
        const controllerAppId = 'cli_controller_1234567890123456';
        const workerAppId = 'cli_worker_1234567890123456';
        const reviewerAppId = 'cli_review_1234567890123456';
        const acceptorAppId = 'cli_accept_1234567890123456';
        const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
        const lifecycle = await startTaskControlPlaneRuntime({
          dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
          logger: { warn: () => {} },
        });
        const store = lifecycle.getStore()!;
        const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
          hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
        });
        const baseline = new DaemonTaskControlIntegration({
          dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
          projectReviewerTrust,
        });
        baseline.setReviewerVerdictVerifier(projectReviewerTrust);
        expect(baseline.registerMapping('om_projectroot', {
          projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
          taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
          reviewerId: reviewerAppId, acceptorId: acceptorAppId,
          registrationRef: 'topic-message:om_projectroot',
          mappingAuthority: {
            kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
            acceptorAppId, mode: 'audit_only',
          },
        }, controllerAppId)).toBe(true);
        const workerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: workerAppId });
        const workerBase = {
          schemaVersion: 'ProjectWorkerEvidence.v1' as const, sourceAppId: workerAppId, controllerAppId,
          sourceSessionId: 'session-worker', sourceTurnId: 'turn-1', workerGeneration: 2, dispatchAttempt: 1,
          dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:00:00.000Z',
        };
        for (const eventKind of ['accepted', 'execution_started'] as const) {
          expect(baseline.ingestProjectWorkerEvidence(
            workerTrust.issue({ ...workerBase, eventKind }), value => workerTrust.verify(value),
          )).toMatchObject({ ok: true });
        }
        expect(baseline.ingestProjectWorkerEvidence(workerTrust.issue({
          ...workerBase, eventKind: 'submitted', occurredAt: '2026-09-29T00:10:00.000Z',
          reportRequestId: 'report:worker', triggerId: 'trg-worker', targetSessionId: 'session-controller',
          contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 5,
        }), value => workerTrust.verify(value))).toMatchObject({ ok: true });

        const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerAppId });
        const artifact = {
          kind: 'project_report' as const, reportRequestId: 'report:review', triggerId: 'trg-review',
          dispatchRoot: 'om_projectroot', sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review',
          reporterAppId: reviewerAppId, targetSessionId: 'session-controller',
          projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
        };
        const verdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
          verdictId: 'rv_project_review_crash', projectId: 'project-group:oc_project',
          phaseId: 'workstream:task-project', taskGuid: 'task-project', topicRootId: 'om_projectroot',
          taskSetSnapshot: ['task-project'], reviewRound: 1,
          designatedReviewerRef: reviewerDesignationRef('om_projectroot', reviewerAppId, 1, 4),
          reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
          sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
          sourceMessageId: artifact.triggerId, sourceVersionHash: artifact.contentHash,
          kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
          artifactEvidence: artifact, issuedAt: '2026-09-29T00:20:00.000Z', expiresAt: '2099-09-29T00:20:00.000Z',
        });
        const evidence = reviewerTrust.issue({
          schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'reviewed',
          sourceAppId: reviewerAppId, controllerAppId, sourceSessionId: 'session-reviewer',
          sourceTurnId: 'turn-review', workerGeneration: 4, dispatchAttempt: 1,
          dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:20:00.000Z',
          reportRequestId: artifact.reportRequestId, triggerId: artifact.triggerId,
          targetSessionId: artifact.targetSessionId, contentHash: artifact.contentHash,
          projectRevision: artifact.projectRevision, reviewVerdict: 'pass', reviewRound: 1,
          reviewerVerdict: verdict,
        });

        const crashingStore: any = Object.create(store);
        const crash = (): never => { throw new Error(`simulated_crash:${crashPoint}`); };
        if (crashPoint === 'verdict') {
          const appendReviewerVerdict = store.appendReviewerVerdict.bind(store);
          crashingStore.appendReviewerVerdict = (...args: any[]) => {
            appendReviewerVerdict(args[0]);
            return crash();
          };
        } else if (crashPoint === 'reviewed' || crashPoint === 'delivered' || crashPoint === 'done') {
          const appendEvent = store.appendEvent.bind(store);
          const target = crashPoint === 'reviewed' ? 'task.reviewed'
            : crashPoint === 'delivered' ? 'task.delivered' : 'task.done_marked';
          crashingStore.appendEvent = (input: any) => {
            const result = appendEvent(input);
            if (input.eventType === target) crash();
            return result;
          };
        } else if (crashPoint === 'receipt') {
          const settle = store.settleOutboxDelivered.bind(store);
          crashingStore.settleOutboxDelivered = (...args: any[]) => {
            settle(args[0], args[1], args[2]);
            return crash();
          };
        }
        const crashing = new DaemonTaskControlIntegration({
          dataDir, larkAppId: controllerAppId, lifecycle, store: crashingStore, bridge,
          logger: { warn: () => {} }, projectReviewerTrust,
        });
        crashing.setReviewerVerdictVerifier(projectReviewerTrust);
        if (crashPoint === 'designation') {
          const register = crashing.registerVerifiedDesignatedReviewer.bind(crashing);
          (crashing as any).registerVerifiedDesignatedReviewer = (...args: any[]) => {
            register(args[0]);
            return crash();
          };
        }
        let interrupted = false;
        try {
          const result = crashing.ingestProjectWorkerEvidence(evidence, value => reviewerTrust.verify(value));
          interrupted = !result.ok;
        } catch (error) {
          expect(String(error)).toContain(`simulated_crash:${crashPoint}`);
          interrupted = true;
        }
        expect(interrupted).toBe(true);
        await lifecycle.close();

        const restartedBridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
        const restartedLifecycle = await startTaskControlPlaneRuntime({
          dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: restartedBridge.authority,
          logger: { warn: () => {} },
        });
        const restartedStore = restartedLifecycle.getStore()!;
        const restartedReviewerTrust = createDaemonReviewerVerdictVerifier({
          hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
        });
        const restarted = new DaemonTaskControlIntegration({
          dataDir, larkAppId: controllerAppId, lifecycle: restartedLifecycle, store: restartedStore,
          bridge: restartedBridge, logger: { warn: () => {} }, projectReviewerTrust: restartedReviewerTrust,
        });
        restarted.setReviewerVerdictVerifier(restartedReviewerTrust);
        expect(restarted.ingestProjectWorkerEvidence(evidence, value => reviewerTrust.verify(value)))
          .toMatchObject({ ok: true });
        const chain = restartedStore.listEvents({ taskGuid: 'task-project' });
        expect(chain.filter(item => item.eventType === 'task.reviewed')).toHaveLength(1);
        expect(chain.filter(item => item.eventType === 'task.delivered')).toHaveLength(1);
        expect(chain.filter(item => item.eventType === 'task.done_marked')).toHaveLength(1);
        expect(restartedStore.listReceipts().filter(item => item.state === 'delivered')).toHaveLength(1);
        expect(restartedStore.getTaskProjection('task-project').transitionViolations).toEqual([]);
        await restartedLifecycle.close();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  });

  it('uses controller first-ingress time so source clock rollback cannot revive an expired reviewer verdict', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-holdback-expired-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T00:20:00.000Z'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const reviewerAppId = 'cli_review_1234567890123456';
      const acceptorAppId = 'cli_accept_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
        hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
      });
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
        projectReviewerTrust,
      });
      integration.setReviewerVerdictVerifier(projectReviewerTrust);
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: reviewerAppId, acceptorId: acceptorAppId,
        registrationRef: 'topic-message:om_projectroot',
        mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId, mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerAppId });
      const reviewArtifact = {
        kind: 'project_report' as const, reportRequestId: 'report:review', triggerId: 'trg-review',
        dispatchRoot: 'om_projectroot', sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review',
        reporterAppId: reviewerAppId, targetSessionId: 'session-controller',
        projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
      };
      // The source clock is rolled back before expiry, but controller ingress is after expiry.
      const reviewerVerdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        verdictId: 'rv_project_review_expired', projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot', taskSetSnapshot: ['task-project'], reviewRound: 1,
        designatedReviewerRef: reviewerDesignationRef('om_projectroot', reviewerAppId, 1, 4),
        reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
        sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
        sourceMessageId: 'trg-review', sourceVersionHash: reviewArtifact.contentHash,
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
        artifactEvidence: reviewArtifact,
        issuedAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-09-29T00:10:00.000Z',
      });
      const reviewed = reviewerTrust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'reviewed',
        sourceAppId: reviewerAppId, controllerAppId,
        sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review', workerGeneration: 4, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:05:00.000Z',
        reportRequestId: 'report:review', triggerId: 'trg-review', targetSessionId: 'session-controller',
        contentHash: `sha256:${'b'.repeat(64)}`, projectRevision: 6, reviewVerdict: 'pass', reviewRound: 1,
        reviewerVerdict,
      });
      const result = integration.ingestProjectWorkerEvidence(reviewed, value => reviewerTrust.verify(value));
      expect(result).toMatchObject({ ok: false, reason: 'reviewer_verdict_expired' });
      expect(store.listObservations()
        .filter(item => item.idempotencyKey === `evidence-holdback:${reviewed.evidenceId}`))
        .toEqual([expect.objectContaining({ occurredAt: '2026-09-29T00:20:00.000Z' })]);

      const futureArtifact = {
        ...reviewArtifact,
        reportRequestId: 'report:review-future', triggerId: 'trg-review-future',
        sourceTurnId: 'turn-review-future', contentHash: `sha256:${'c'.repeat(64)}`,
      };
      const futureVerdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        ...reviewerVerdict,
        verdictId: 'rv_project_review_future', sourceMessageId: futureArtifact.triggerId,
        sourceVersionHash: futureArtifact.contentHash, artifactEvidence: futureArtifact,
        capability: 'review-capability', expiresAt: '2026-09-29T01:00:00.000Z', signature: undefined,
      } as any);
      const atFutureSkewBoundary = reviewerTrust.issue({
        ...reviewed,
        evidenceId: undefined, keyId: undefined, signature: undefined,
        sourceTurnId: futureArtifact.sourceTurnId,
        occurredAt: '2026-09-29T00:25:00.000Z',
        reportRequestId: futureArtifact.reportRequestId, triggerId: futureArtifact.triggerId,
        contentHash: futureArtifact.contentHash, reviewerVerdict: futureVerdict,
      } as any);
      expect(integration.ingestProjectWorkerEvidence(atFutureSkewBoundary, value => reviewerTrust.verify(value)))
        .toEqual({ ok: false, reason: 'dependency_pending' });
      const beyondFutureSkew = reviewerTrust.issue({
        ...reviewed,
        evidenceId: undefined, keyId: undefined, signature: undefined,
        sourceTurnId: futureArtifact.sourceTurnId,
        occurredAt: '2026-09-29T00:25:00.001Z',
        reportRequestId: futureArtifact.reportRequestId, triggerId: futureArtifact.triggerId,
        contentHash: futureArtifact.contentHash, reviewerVerdict: futureVerdict,
      } as any);
      expect(integration.ingestProjectWorkerEvidence(beyondFutureSkew, value => reviewerTrust.verify(value)))
        .toEqual({ ok: false, reason: 'project_worker_evidence_future_skew' });
      expect(store.listObservations()
        .filter(item => item.idempotencyKey === `evidence-holdback:${beyondFutureSkew.evidenceId}`))
        .toEqual([expect.objectContaining({ occurredAt: '2026-09-29T00:20:00.000Z' })]);
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual(['mapping.registered']);
      await lifecycle.close();
    } finally {
      vi.useRealTimers();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('retries dependency-held reviewer evidence across independent source stores after controller-time expiry', async () => {
    const controllerDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-controller-relay-holdback-'));
    const workerSourceDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-worker-source-holdback-'));
    const reviewerSourceDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-reviewer-source-holdback-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T00:20:00.000Z'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const reviewerAppId = 'cli_review_1234567890123456';
      const acceptorAppId = 'cli_accept_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir: controllerDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true },
        authority: bridge.authority, logger: { warn: () => {} },
      });
      const controllerStore = lifecycle.getStore()!;
      const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
        hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
      });
      const integration = new DaemonTaskControlIntegration({
        dataDir: controllerDir, larkAppId: controllerAppId, lifecycle, store: controllerStore,
        bridge, logger: { warn: () => {} }, projectReviewerTrust,
      });
      integration.setReviewerVerdictVerifier(projectReviewerTrust);
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: reviewerAppId, acceptorId: acceptorAppId,
        registrationRef: 'topic-message:om_projectroot',
        mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId, mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);

      const sourceAuthority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
      const workerSourceStore = await TaskControlPlaneStore.open(workerSourceDir, sourceAuthority, workerAppId);
      const reviewerSourceStore = await TaskControlPlaneStore.open(reviewerSourceDir, sourceAuthority, reviewerAppId);
      const workerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: workerAppId });
      const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerAppId });
      const deliver = async (evidence: Parameters<DaemonTaskControlIntegration['ingestProjectWorkerEvidence']>[0]) => {
        const trust = evidence.sourceAppId === workerAppId ? workerTrust : reviewerTrust;
        const result = integration.ingestProjectWorkerEvidence(evidence, value => trust.verify(value));
        if (!result.ok) throw new Error(result.reason);
        return result.receiptRef;
      };
      const workerRelay = new ProjectWorkerEvidenceRelay({ store: workerSourceStore, trust: workerTrust, deliver });
      const reviewerRelay = new ProjectWorkerEvidenceRelay({ store: reviewerSourceStore, trust: reviewerTrust, deliver });

      const reviewArtifact = {
        kind: 'project_report' as const, reportRequestId: 'report:review-relay', triggerId: 'trg-review-relay',
        dispatchRoot: 'om_projectroot', sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review-relay',
        reporterAppId: reviewerAppId, targetSessionId: 'session-controller',
        projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
      };
      const reviewerVerdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        verdictId: 'rv_project_review_relay', projectId: 'project-group:oc_project',
        phaseId: 'workstream:task-project', taskGuid: 'task-project', topicRootId: 'om_projectroot',
        taskSetSnapshot: ['task-project'], reviewRound: 1,
        designatedReviewerRef: reviewerDesignationRef('om_projectroot', reviewerAppId, 1, 4),
        reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
        sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
        sourceMessageId: reviewArtifact.triggerId, sourceVersionHash: reviewArtifact.contentHash,
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
        artifactEvidence: reviewArtifact, issuedAt: '2026-09-29T00:20:00.000Z',
        expiresAt: '2026-09-29T00:25:00.000Z',
      });
      reviewerRelay.capture({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'reviewed',
        sourceAppId: reviewerAppId, controllerAppId, sourceSessionId: 'session-reviewer',
        sourceTurnId: reviewArtifact.sourceTurnId, workerGeneration: 4, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:20:00.000Z',
        reportRequestId: reviewArtifact.reportRequestId, triggerId: reviewArtifact.triggerId,
        targetSessionId: reviewArtifact.targetSessionId, contentHash: reviewArtifact.contentHash,
        projectRevision: reviewArtifact.projectRevision, reviewVerdict: 'pass', reviewRound: 1,
        reviewerVerdict,
      });
      await reviewerRelay.flushOnce(Date.parse('2026-09-29T00:20:00.000Z'));
      expect(reviewerSourceStore.listProjectWorkerEvidenceOutbox()).toEqual([
        expect.objectContaining({
          status: 'pending', lastError: 'dependency_pending',
          nextAttemptAt: Date.parse('2026-09-29T00:20:01.000Z'),
        }),
      ]);
      expect(controllerStore.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual(['mapping.registered']);

      const workerBase = {
        schemaVersion: 'ProjectWorkerEvidence.v1' as const, sourceAppId: workerAppId, controllerAppId,
        sourceSessionId: 'session-worker', sourceTurnId: 'turn-worker-relay', workerGeneration: 2,
        dispatchAttempt: 1, dispatchRoot: 'om_projectroot',
      };
      workerRelay.capture({ ...workerBase, eventKind: 'accepted', occurredAt: '2026-09-29T00:00:00.000Z' });
      workerRelay.capture({ ...workerBase, eventKind: 'execution_started', occurredAt: '2026-09-29T00:01:00.000Z' });
      workerRelay.capture({
        ...workerBase, eventKind: 'submitted', occurredAt: '2026-09-29T00:10:00.000Z',
        reportRequestId: 'report:worker-relay', triggerId: 'trg-worker-relay',
        targetSessionId: 'session-controller', contentHash: `sha256:${'a'.repeat(64)}`, projectRevision: 5,
      });
      vi.setSystemTime(new Date('2026-09-29T00:30:00.000Z'));
      for (let i = 0; i < 3; i += 1) {
        await workerRelay.flushOnce(Date.parse('2026-09-29T00:30:00.000Z'));
      }
      await reviewerRelay.flushOnce(Date.parse('2026-09-29T00:30:00.000Z'));

      reviewerRelay.capture({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'terminal',
        sourceAppId: reviewerAppId, controllerAppId, sourceSessionId: 'session-reviewer',
        sourceTurnId: reviewArtifact.sourceTurnId, workerGeneration: 4, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:30:01.000Z',
        terminalStatus: 'completed', finalOutputPresent: false,
      });
      await reviewerRelay.flushOnce(Date.parse('2026-09-29T00:30:01.000Z'));

      expect(workerSourceStore.listProjectWorkerEvidenceOutbox().every(row => row.status === 'delivered')).toBe(true);
      expect(reviewerSourceStore.listProjectWorkerEvidenceOutbox()).toEqual([
        expect.objectContaining({ status: 'delivered', attempts: 2 }),
        expect.objectContaining({ status: 'delivered', attempts: 1 }),
      ]);
      expect(controllerStore.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType)).toEqual([
        'mapping.registered', 'task.accepted', 'task.execution_started', 'task.first_submitted',
        'task.reviewed', 'task.delivered', 'task.done_marked',
      ]);
      expect(controllerStore.listReceipts().filter(item => item.state === 'delivered')).toHaveLength(1);
      expect(controllerStore.getTaskProjection('task-project').transitionViolations).toEqual([]);
      workerSourceStore.close();
      reviewerSourceStore.close();
      await lifecycle.close();
    } finally {
      vi.useRealTimers();
      rmSync(controllerDir, { recursive: true, force: true });
      rmSync(workerSourceDir, { recursive: true, force: true });
      rmSync(reviewerSourceDir, { recursive: true, force: true });
    }
  });

  it('permanently rejects a reviewer evidence whose round/artifact does not match the mapped contract and never creates a first-ingress row', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-holdback-wrong-round-'));
    try {
      const controllerAppId = 'cli_controller_1234567890123456';
      const workerAppId = 'cli_worker_1234567890123456';
      const reviewerAppId = 'cli_review_1234567890123456';
      const acceptorAppId = 'cli_accept_1234567890123456';
      const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true }, authority: bridge.authority,
        logger: { warn: () => {} },
      });
      const store = lifecycle.getStore()!;
      const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
        hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
      });
      const integration = new DaemonTaskControlIntegration({
        dataDir, larkAppId: controllerAppId, lifecycle, store, bridge, logger: { warn: () => {} },
        projectReviewerTrust,
      });
      integration.setReviewerVerdictVerifier(projectReviewerTrust);
      expect(integration.registerMapping('om_projectroot', {
        projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
        taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
        reviewerId: reviewerAppId, acceptorId: acceptorAppId,
        registrationRef: 'topic-message:om_projectroot',
        mappingAuthority: {
          kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
          acceptorAppId, mode: 'audit_only',
        },
      }, controllerAppId)).toBe(true);
      const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerAppId });
      const reviewArtifact = {
        kind: 'project_report' as const, reportRequestId: 'report:review', triggerId: 'trg-review',
        dispatchRoot: 'om_projectroot', sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review',
        reporterAppId: reviewerAppId, targetSessionId: 'session-controller',
        projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
      };
      // Verdict is issued for reviewRound=2 while the evidence claims reviewRound=1. The verdict
      // contract requires exact round agreement. This is a permanent reject — not a holdback.
      const mismatchedRoundVerdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
        verdictId: 'rv_project_wrong_round', projectId: 'project-group:oc_project', phaseId: 'workstream:task-project',
        taskGuid: 'task-project', topicRootId: 'om_projectroot', taskSetSnapshot: ['task-project'], reviewRound: 2,
        designatedReviewerRef: reviewerDesignationRef('om_projectroot', reviewerAppId, 2, 4),
        reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
        sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
        sourceMessageId: 'trg-review', sourceVersionHash: reviewArtifact.contentHash,
        kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
        artifactEvidence: reviewArtifact,
        issuedAt: '2026-09-29T00:20:00.000Z', expiresAt: '2099-09-29T00:20:00.000Z',
      });
      const wrongRound = reviewerTrust.issue({
        schemaVersion: 'ProjectWorkerEvidence.v1', eventKind: 'reviewed',
        sourceAppId: reviewerAppId, controllerAppId,
        sourceSessionId: 'session-reviewer', sourceTurnId: 'turn-review', workerGeneration: 4, dispatchAttempt: 1,
        dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:20:00.000Z',
        reportRequestId: 'report:review', triggerId: 'trg-review', targetSessionId: 'session-controller',
        contentHash: `sha256:${'b'.repeat(64)}`, projectRevision: 6, reviewVerdict: 'pass', reviewRound: 1,
        reviewerVerdict: mismatchedRoundVerdict,
      });
      const result = integration.ingestProjectWorkerEvidence(wrongRound, value => reviewerTrust.verify(value));
      expect(result).toMatchObject({ ok: false, reason: 'reviewer_verdict_unverified' });
      // No first-ingress row for a wrong-round/artifact evidence.
      expect(store.listObservations()
        .filter(item => item.idempotencyKey.startsWith('evidence-holdback:'))).toEqual([]);
      // The mismatch must NOT be treated as holdback (never returns dependency_pending).
      const forgedContent = reviewerTrust.issue({
        ...wrongRound,
        evidenceId: undefined, keyId: undefined, signature: undefined,
        contentHash: `sha256:${'c'.repeat(64)}`,
      } as any);
      const artifactMismatchResult = integration.ingestProjectWorkerEvidence(forgedContent, value => reviewerTrust.verify(value));
      expect(artifactMismatchResult).toMatchObject({ ok: false, reason: 'reviewer_verdict_unverified' });
      expect(store.listObservations()
        .filter(item => item.idempotencyKey.startsWith('evidence-holdback:'))).toEqual([]);
      expect(store.listEvents({ taskGuid: 'task-project' }).map(event => event.eventType))
        .toEqual(['mapping.registered']);
      await lifecycle.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('durably quarantines wrong-round and artifact-mismatch reviewer evidence through the source relay', async () => {
    for (const mismatch of ['round', 'artifact'] as const) {
      const controllerDir = mkdtempSync(join(tmpdir(), `botmux-task-control-controller-${mismatch}-`));
      const sourceDir = mkdtempSync(join(tmpdir(), `botmux-task-control-reviewer-source-${mismatch}-`));
      try {
        const controllerAppId = 'cli_controller_1234567890123456';
        const workerAppId = 'cli_worker_1234567890123456';
        const reviewerAppId = 'cli_review_1234567890123456';
        const acceptorAppId = 'cli_accept_1234567890123456';
        const bridge = new DaemonTaskControlBridge({ approvals: source(), larkAppId: controllerAppId });
        const lifecycle = await startTaskControlPlaneRuntime({
          dataDir: controllerDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true },
          authority: bridge.authority, logger: { warn: () => {} },
        });
        const controllerStore = lifecycle.getStore()!;
        const projectReviewerTrust = createDaemonReviewerVerdictVerifier({
          hostSecret: 'host-secret', controllerBotAppId: controllerAppId,
        });
        const integration = new DaemonTaskControlIntegration({
          dataDir: controllerDir, larkAppId: controllerAppId, lifecycle, store: controllerStore,
          bridge, logger: { warn: () => {} }, projectReviewerTrust,
        });
        integration.setReviewerVerdictVerifier(projectReviewerTrust);
        expect(integration.registerMapping('om_projectroot', {
          projectId: 'project-group:oc_project', phaseId: 'workstream:task-project', phaseTaskGuids: ['task-project'],
          taskGuid: 'task-project', topicRootId: 'om_projectroot', ownerId: workerAppId,
          reviewerId: reviewerAppId, acceptorId: acceptorAppId,
          registrationRef: 'topic-message:om_projectroot',
          mappingAuthority: {
            kind: 'project_group', chatId: 'oc_project', reservationId: 'reservation-1', projectRevision: 4,
            acceptorAppId, mode: 'audit_only',
          },
        }, controllerAppId)).toBe(true);

        const sourceAuthority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
        const sourceStore = await TaskControlPlaneStore.open(sourceDir, sourceAuthority, reviewerAppId);
        const reviewerTrust = new ProjectWorkerEvidenceTrust({ hostSecret: 'host-secret', sourceAppId: reviewerAppId });
        const artifact = {
          kind: 'project_report' as const, reportRequestId: `report:${mismatch}`, triggerId: `trg-${mismatch}`,
          dispatchRoot: 'om_projectroot', sourceSessionId: 'session-reviewer', sourceTurnId: `turn-${mismatch}`,
          reporterAppId: reviewerAppId, targetSessionId: 'session-controller',
          projectRevision: 6, contentHash: `sha256:${'b'.repeat(64)}`,
        };
        const verdictRound = mismatch === 'round' ? 2 : 1;
        const verdict = projectReviewerTrust.providerForApp(reviewerAppId)!.issueVerdict({
          verdictId: `rv_project_review_${mismatch}`, projectId: 'project-group:oc_project',
          phaseId: 'workstream:task-project', taskGuid: 'task-project', topicRootId: 'om_projectroot',
          taskSetSnapshot: ['task-project'], reviewRound: verdictRound,
          designatedReviewerRef: reviewerDesignationRef('om_projectroot', reviewerAppId, verdictRound, 4),
          reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
          sessionId: 'session-reviewer', workerGeneration: 4, capability: 'review-capability',
          sourceMessageId: artifact.triggerId, sourceVersionHash: artifact.contentHash,
          kind: 'verdict', verdict: 'pass', conditionIds: [], resolvedConditionEvidence: {},
          artifactEvidence: artifact, issuedAt: '2026-09-29T00:20:00.000Z', expiresAt: '2099-09-29T00:20:00.000Z',
        });
        const facts = {
          schemaVersion: 'ProjectWorkerEvidence.v1' as const, eventKind: 'reviewed' as const,
          sourceAppId: reviewerAppId, controllerAppId, sourceSessionId: 'session-reviewer',
          sourceTurnId: artifact.sourceTurnId, workerGeneration: 4, dispatchAttempt: 1,
          dispatchRoot: 'om_projectroot', occurredAt: '2026-09-29T00:20:00.000Z',
          reportRequestId: artifact.reportRequestId, triggerId: artifact.triggerId,
          targetSessionId: artifact.targetSessionId,
          contentHash: mismatch === 'artifact' ? `sha256:${'c'.repeat(64)}` : artifact.contentHash,
          projectRevision: artifact.projectRevision, reviewVerdict: 'pass' as const, reviewRound: 1,
          reviewerVerdict: verdict,
        };
        let deliveries = 0;
        const deliver = async (evidence: Parameters<DaemonTaskControlIntegration['ingestProjectWorkerEvidence']>[0]) => {
          deliveries += 1;
          const result = integration.ingestProjectWorkerEvidence(evidence, value => reviewerTrust.verify(value));
          if (!result.ok) throw new Error(result.reason);
          return result.receiptRef;
        };
        const relay = new ProjectWorkerEvidenceRelay({ store: sourceStore, trust: reviewerTrust, deliver });
        relay.capture(facts);
        await relay.flushOnce(Date.parse('2026-09-29T00:20:00.000Z'));
        expect(sourceStore.listProjectWorkerEvidenceOutbox()).toEqual([
          expect.objectContaining({
            status: 'pending', nextAttemptAt: Number.MAX_SAFE_INTEGER,
            lastError: expect.stringMatching(/^permanent:reviewer_verdict_unverified:/),
          }),
        ]);
        sourceStore.close();

        const reopened = await TaskControlPlaneStore.open(sourceDir, sourceAuthority, reviewerAppId);
        const restartedRelay = new ProjectWorkerEvidenceRelay({ store: reopened, trust: reviewerTrust, deliver });
        restartedRelay.capture({
          ...facts, eventKind: 'accepted', sourceTurnId: `${facts.sourceTurnId}-tail`,
          reviewerVerdict: undefined, reviewVerdict: undefined, reviewRound: undefined,
          reportRequestId: undefined, triggerId: undefined, targetSessionId: undefined,
          contentHash: undefined, projectRevision: undefined,
        } as any);
        await restartedRelay.flushOnce(Date.parse('2026-09-29T00:30:00.000Z'));
        expect(deliveries).toBe(1);
        expect(reopened.listProjectWorkerEvidenceOutbox()).toHaveLength(2);
        expect(reopened.listProjectWorkerEvidenceOutbox().every(row => row.status === 'pending')).toBe(true);
        reopened.close();
        await lifecycle.close();
      } finally {
        rmSync(controllerDir, { recursive: true, force: true });
        rmSync(sourceDir, { recursive: true, force: true });
      }
    }
  });
});
