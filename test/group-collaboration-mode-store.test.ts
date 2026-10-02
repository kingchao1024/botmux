import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  addProjectWorkerIfNeeded,
  readGroupCollaborationMode,
  writeGroupCollaborationMode,
} from '../src/services/group-collaboration-mode-store.js';
import {
  activateTaskControlTurnAdmissionSync,
  beginTaskControlKickoffOperationSync,
  beginTaskControlSeedOperationSync,
  claimTaskControlTurnAdmissionPendingSync,
  completeTaskControlKickoffOperationSync,
  completeTaskControlSeedOperationSync,
  createDispatchOperationId,
  persistTaskControlSuccessCertificateSync,
  recordDispatchRegistryEntry,
  terminalizeTaskControlTurnAdmissionSync,
} from '../src/core/dispatch-registry.js';
import { buildTaskControlKickoffContent } from '../src/core/dispatch.js';
import {
  createDispatchReportBinding,
  dispatchReportBindingSecretPath,
} from '../src/core/dispatch-report-binding.js';
import { ProjectCoordinator, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';
import {
  mutateProjectGroup,
  projectTaskControlCanaryAbandonmentFromRecord,
  readProjectGroup,
} from '../src/services/project-group-store.js';
import { DaemonTaskControlAuthority } from '../src/services/task-control-plane-authority.js';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';
import { DaemonTaskControlIntegration } from '../src/services/task-control-plane-daemon-integration.js';
import { TaskControlMappingTrust } from '../src/services/task-control-plane-mapping-trust.js';
import {
  ProjectWorkerEvidenceRelay,
  ProjectWorkerEvidenceTrust,
} from '../src/services/task-control-plane-project-worker-evidence.js';
import { createDaemonReviewerVerdictVerifier, reviewerDesignationRef } from '../src/services/task-control-plane-reviewer-verdict.js';
import { startTaskControlPlaneRuntime } from '../src/services/task-control-plane-runtime.js';
import { TaskControlPlaneStore } from '../src/services/task-control-plane-store.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const atomicWriteFailure = vi.hoisted(() => ({ targetSuffix: '', remaining: 0 }));

vi.mock('../src/utils/atomic-write.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/atomic-write.js')>();
  return {
    ...actual,
    atomicWriteFileSync: (...args: Parameters<typeof actual.atomicWriteFileSync>) => {
      if (atomicWriteFailure.remaining > 0 && args[0].endsWith(atomicWriteFailure.targetSuffix)) {
        atomicWriteFailure.remaining -= 1;
        throw new Error(`injected_write_failure:${atomicWriteFailure.targetSuffix}`);
      }
      return actual.atomicWriteFileSync(...args);
    },
  };
});

const roots: string[] = [];
const TEST_TASK_CONTROL_DAEMON_IPC_SECRET = 'daemon-ipc-test-secret';
const TEST_TASK_CONTROL_REPORT_BINDING_SECRET = 'registry-binding-test-secret';

function collectChild(
  child: ReturnType<typeof spawnTsEvalWithRepoImports>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  atomicWriteFailure.targetSuffix = '';
  atomicWriteFailure.remaining = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'botmux-group-config-cas-'));
  roots.push(rootDir);
  const dataDir = join(rootDir, 'data');
  mkdirSync(dataDir);
  const transport: ProjectCoordinatorTransport = {
    sendCard: vi.fn(async () => 'om_card'),
    updateCard: vi.fn(async () => undefined),
    pinMessage: vi.fn(async () => true),
    unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async () => null),
    isMessageWithdrawn: () => false,
    brand: () => 'feishu',
  };
  const context = {
    dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_main',
  };
  const failedReportContent = 'Phase A 历史任务失败报告';
  const instructionTemplate = '仅向历史任务提交冻结的失败报告。';
  const fence = {
    dispatchOperationId: 'f'.repeat(50), taskGuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    coordinatorSessionId: context.coordinatorSessionId, originTurnId: 'om_config_cas',
    authorizationRef: 'om_config_cas', authorizedByOpenId: 'ou_authorized', planSha256: 'f'.repeat(64),
    controllerAppId: context.larkAppId, workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer',
    acceptorAppId: 'cli_acceptor', targetChatId: context.chatId,
    targetAppIds: ['cli_worker', 'cli_reviewer'], writeScopes: [join(dataDir, 'scope')],
    title: '无文件 canary', purpose: '验证 field-only config CAS', owners: ['Worker', 'Reviewer'],
    botOpenIds: ['ou_worker', 'ou_reviewer'], acceptanceRequested: true,
    seedText: '冻结 config CAS seed', taskControlMode: 'audit_only' as const,
    kickoff: {
      templateVersion: 'TaskControlKickoff.v1' as const, rootPlaceholder: '{{dispatchRoot}}' as const,
      brief: '验证 field-only config CAS',
      briefSha256: createHash('sha256').update('验证 field-only config CAS').digest('hex'),
      bots: [
        { appId: 'cli_worker', openId: 'ou_worker', displayName: 'Worker', role: 'worker' as const },
        { appId: 'cli_reviewer', openId: 'ou_reviewer', displayName: 'Reviewer', role: 'reviewer' as const },
      ],
    },
    phaseA: {
      historicalDispatchRoot: 'om_historical',
      historicalTaskGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mappedWorkerAppId: 'cli_historical_worker',
      failedReportContent,
      failedReportSha256: createHash('sha256').update(failedReportContent).digest('hex'),
      instructionTemplateVersion: 'TaskControlPhaseAInstruction.v1' as const,
      instructionTemplate,
      instructionTemplateSha256: createHash('sha256').update(instructionTemplate).digest('hex'),
    },
  };
  mkdirSync(fence.writeScopes[0]!);
  return { dataDir, context, fence, coordinator: new ProjectCoordinator(transport) };
}

async function installFence(f: ReturnType<typeof fixture>): Promise<void> {
  await writeGroupCollaborationMode(f.dataDir, {
    chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
    workerAppIds: [f.fence.workerAppId, f.fence.reviewerAppId, f.fence.acceptorAppId],
    autoEnrollWorkers: true,
  });
  await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '验证配置 CAS' });
  await f.coordinator.run(f.context, {
    action: 'install_task_control_canary_fence', fence: f.fence, now: '2026-09-30T01:00:00.000Z',
  } as any);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function configHash(value: unknown): string {
  return `pgc1:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function successCertificateHash(value: Record<string, unknown>): string {
  const { certificateHash: _certificateHash, ...facts } = value;
  return `tcsc1:${createHash('sha256').update(canonicalJson(facts)).digest('hex')}`;
}

function fenceFingerprint(f: ReturnType<typeof fixture>): string {
  const record = readProjectGroup(f.dataDir, f.context.chatId)!.blockerRecords
    .find(item => item.code === 'task_control_canary_quarantine')!;
  return JSON.parse(record.summary).fingerprint;
}

function taskControlApprovals() {
  return {
    validateBinding: () => true,
    get: ({ gate }: any) => ({
      runId: gate.runId, nodeId: gate.nodeId, instanceId: gate.instanceId, waitId: gate.waitId,
      operatorId: gate.operatorId, approvedAt: '2026-09-30T00:00:00.000Z',
      expiresAt: '2099-09-30T00:00:00.000Z',
    }),
  };
}

async function enableFenceConfig(
  f: ReturnType<typeof fixture>,
  now = '2026-09-30T01:01:00.000Z',
) {
  const before = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
  return writeGroupCollaborationMode(f.dataDir, {
    chatId: before.chatId, mode: before.mode, coordinatorAppId: before.coordinatorAppId,
    workerAppIds: before.workerAppIds, autoEnrollWorkers: before.autoEnrollWorkers,
    progressCard: before.progressCard,
    taskControlPlane: {
      mode: 'audit_only', acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1,
    },
    taskControlPlaneCas: {
      operation: 'enable', expectedConfigHash: configHash(before),
      expectedFenceFingerprint: fenceFingerprint(f), now,
    },
  });
}

async function abandonFence(f: ReturnType<typeof fixture>) {
  const current = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
  const expectedConfigHash = configHash(current.taskControlPlane
    ? current
    : {
        ...current,
        taskControlPlane: {
          mode: 'audit_only', acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1,
        },
      });
  return f.coordinator.run(f.context, {
    action: 'abandon_task_control_canary', fence: f.fence,
    expectedConfigHash,
    authorizationRef: 'om_abandon', authorizedByOpenId: 'ou_authorized',
    now: '2026-09-30T01:03:00.000Z',
  } as any);
}

function ensureTaskControlDaemonIpcSecret(f: ReturnType<typeof fixture>): string {
  writeFileSync(join(dirname(f.dataDir), '.dashboard-secret'), TEST_TASK_CONTROL_DAEMON_IPC_SECRET, { mode: 0o600 });
  return TEST_TASK_CONTROL_DAEMON_IPC_SECRET;
}

function ensureTaskControlReportBindingSecret(f: ReturnType<typeof fixture>): string {
  writeFileSync(
    dispatchReportBindingSecretPath(f.dataDir),
    TEST_TASK_CONTROL_REPORT_BINDING_SECRET,
    { mode: 0o600 },
  );
  return TEST_TASK_CONTROL_REPORT_BINDING_SECRET;
}

function canarySeedPayloadHash(f: ReturnType<typeof fixture>): string {
  return createHash('sha256').update(f.fence.seedText).digest('hex');
}

function canaryKickoffPayloadHash(f: ReturnType<typeof fixture>, dispatchRoot: string): string {
  const built = buildTaskControlKickoffContent({
    title: f.fence.title,
    brief: f.fence.kickoff.brief,
    dispatchRoot,
    bots: [...f.fence.kickoff.bots].sort((left, right) => left.role.localeCompare(right.role)),
  });
  return createHash('sha256').update(built.content).digest('hex');
}

function canaryProviderUuid(
  f: ReturnType<typeof fixture>,
  effect: 'seed_root' | 'kickoff_thread',
  dispatchRoot?: string,
): string {
  const payloadHash = effect === 'seed_root'
    ? canarySeedPayloadHash(f)
    : canaryKickoffPayloadHash(f, dispatchRoot!);
  return createDispatchOperationId({
    schemaVersion: 'TaskControlProviderUuid.v1',
    effect,
    operationId: f.fence.dispatchOperationId,
    targetChatId: f.fence.targetChatId,
    targetRoot: effect === 'seed_root' ? null : dispatchRoot,
    messageType: effect === 'seed_root' ? 'text' : 'post',
    payloadHash,
  });
}

function canaryReservationFacts(
  f: ReturnType<typeof fixture>,
  createdAt: string,
  expiresAt: string,
) {
  return {
    schemaVersion: 'ProjectDispatchReservation.v1' as const,
    larkAppId: f.fence.controllerAppId,
    chatId: f.fence.targetChatId,
    coordinatorSessionId: f.fence.coordinatorSessionId,
    originTurnId: f.fence.originTurnId,
    reservationId: f.fence.dispatchOperationId,
    taskGuid: f.fence.taskGuid,
    phaseId: `workstream:${f.fence.taskGuid}`,
    workerAppId: f.fence.workerAppId,
    reviewerAppId: f.fence.reviewerAppId,
    acceptorAppId: f.fence.acceptorAppId,
    access: { mode: 'write' as const, scopes: f.fence.writeScopes },
    createdAt,
    expiresAt,
    dispatch: {
      seedText: f.fence.seedText,
      title: f.fence.title,
      purpose: f.fence.purpose,
      owners: f.fence.owners,
      botOpenIds: f.fence.botOpenIds,
      acceptanceRequested: f.fence.acceptanceRequested,
    },
  };
}

function exactCanaryReservationProof(
  f: ReturnType<typeof fixture>,
  createdAt: string,
  expiresAt: string,
) {
  return new TaskControlMappingTrust({
    hostSecret: ensureTaskControlDaemonIpcSecret(f),
    larkAppId: f.fence.controllerAppId,
  }).issueProjectDispatchReservation(
    canaryReservationFacts(f, createdAt, expiresAt),
    createdAt,
  );
}

function exactCanarySuccessEvidence(
  f: ReturnType<typeof fixture>,
  dispatchRoot: string,
): Record<string, unknown> {
  return {
    phaseA: {
      instructionMessageId: 'om_phase_a_certificate_instruction',
      historicalDispatchRoot: f.fence.phaseA.historicalDispatchRoot,
      historicalTaskGuid: f.fence.phaseA.historicalTaskGuid,
      reportRequestId: `report:${'a'.repeat(64)}`,
      reportContent: f.fence.phaseA.failedReportContent,
      reportContentHash: f.fence.phaseA.failedReportSha256,
      evidenceIds: ['evidence_phase_a_failed', 'evidence_phase_a_terminal'],
      controllerEventIds: ['event_phase_a_failed'],
      taskFailedEventId: 'event_phase_a_failed',
    },
    phaseB: {
      seedProviderUuid: canaryProviderUuid(f, 'seed_root'),
      kickoffProviderUuid: canaryProviderUuid(f, 'kickoff_thread', dispatchRoot),
      kickoffMessageId: 'om_certificate_kickoff',
      projectRevision: readProjectGroup(f.dataDir, f.context.chatId)!.revision,
      deliveryRound: 1,
      deliveryContentHash: `sha256:${'b'.repeat(64)}`,
      reviewRound: 1,
      reviewVerdict: 'pass',
      reviewContentHash: `sha256:${'c'.repeat(64)}`,
      workerTurnTerminalAt: '2026-09-30T01:02:00.000Z',
      reviewerTurnTerminalAt: '2026-09-30T01:02:01.000Z',
      workerEvidenceIds: [
        'evidence_worker_accepted', 'evidence_worker_execution',
        'evidence_worker_submitted', 'evidence_worker_terminal',
      ],
      reviewerEvidenceIds: ['evidence_reviewer_reviewed', 'evidence_reviewer_terminal'],
      controllerEventIds: [
        'event_accepted', 'event_execution', 'event_submitted',
        'event_reviewed', 'event_delivered', 'event_done',
      ],
      workerSourceSessionId: 'session_canary_worker',
      workerGeneration: 2,
      reviewerSourceSessionId: 'session_canary_reviewer',
      reviewerGeneration: 4,
      acceptedEventId: 'event_accepted',
      executionEventId: 'event_execution',
      submittedEventId: 'event_submitted',
      reviewedEventId: 'event_reviewed',
      deliveredEventId: 'event_delivered',
      deliveryOutboxId: 'outbox_delivery',
      deliveryReceiptId: 'receipt_delivery',
      doneEventId: 'event_done',
    },
    scope: { paths: f.fence.writeScopes, empty: true },
  };
}

async function addBoundCanaryWorkstream(
  f: ReturnType<typeof fixture>,
  dispatchRoot = 'om_abandoned_canary_root',
) {
  const reservationCreatedAt = '2026-09-30T01:01:00.000Z';
  const reservationExpiresAt = '2026-09-30T02:01:00.000Z';
  const rootCreateTime = '2026-09-30T01:01:01.000Z';
  const reservationProof = exactCanaryReservationProof(
    f, reservationCreatedAt, reservationExpiresAt,
  );
  await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
    current!.workstreams.push({
      dispatchRoot, title: f.fence.title, purpose: f.fence.purpose, owners: f.fence.owners,
      targetAppIds: f.fence.targetAppIds,
      workerAppIds: [f.fence.workerAppId], reviewerAppIds: [f.fence.reviewerAppId],
      access: { mode: 'write', scopes: f.fence.writeScopes }, status: 'in_progress', progress: 40,
      taskControl: {
        taskGuid: f.fence.taskGuid, phaseId: `workstream:${f.fence.taskGuid}`,
        mappingRef: `topic-message:${dispatchRoot}`, mappingStatus: 'registered',
        sourceKind: 'project_group', controllerAppId: f.fence.controllerAppId,
        workerAppId: f.fence.workerAppId, reviewerAppId: f.fence.reviewerAppId,
        acceptorAppId: f.fence.acceptorAppId, projectRevision: current!.revision,
        reservationId: f.fence.dispatchOperationId,
        coordinatorSessionId: f.fence.coordinatorSessionId, originTurnId: f.fence.originTurnId,
        reservationCreatedAt, reservationExpiresAt, rootCreateTime, reservationProof,
        registeredAt: rootCreateTime,
        recovery: {
          title: f.fence.title,
          purpose: f.fence.purpose,
          owners: f.fence.owners,
          botOpenIds: f.fence.botOpenIds,
          acceptanceRequested: f.fence.acceptanceRequested,
          seedText: f.fence.seedText,
        },
      },
      createdAt: rootCreateTime, updatedAt: rootCreateTime,
    });
    return current;
  });
  return dispatchRoot;
}

function exactCanaryRegistryEntry(
  f: ReturnType<typeof fixture>,
  dispatchRoot: string,
): Record<string, unknown> {
  const issuedAt = '2026-09-30T01:01:01.000Z';
  const bindingSecret = ensureTaskControlReportBindingSecret(f);
  return {
    orchRoot: '',
    orchChatId: f.context.chatId,
    orchScope: 'chat',
    orchAppId: f.fence.controllerAppId,
    orchSessionId: f.fence.coordinatorSessionId,
    targetChatId: f.fence.targetChatId,
    targetAppIds: f.fence.targetAppIds,
    workerAppIds: [f.fence.workerAppId],
    reviewerAppIds: [f.fence.reviewerAppId],
    access: { mode: 'write', scopes: f.fence.writeScopes },
    taskControl: {
      mode: f.fence.taskControlMode,
      taskGuid: f.fence.taskGuid,
      phaseId: `workstream:${f.fence.taskGuid}`,
      controllerAppId: f.fence.controllerAppId,
      workerAppId: f.fence.workerAppId,
      reviewerAppId: f.fence.reviewerAppId,
      acceptorAppId: f.fence.acceptorAppId,
    },
    title: f.fence.title,
    purpose: f.fence.purpose,
    owners: f.fence.owners,
    bots: f.fence.botOpenIds,
    status: 'dispatched',
    transportState: 'dispatched',
    acceptanceState: 'requested',
    errorCode: null,
    createdAt: issuedAt,
    updatedAt: issuedAt,
    reportBinding: createDispatchReportBinding(bindingSecret, {
      dispatchRoot,
      targetLarkAppId: f.fence.controllerAppId,
      targetSessionId: f.fence.coordinatorSessionId,
      targetChatId: f.fence.targetChatId,
      targetScope: 'chat',
      sourceName: f.fence.title,
      issuedAt,
    }),
    dispatchOperationId: f.fence.dispatchOperationId,
  };
}

async function addBoundCanaryReservation(
  f: ReturnType<typeof fixture>,
  dispatchRoot: string,
  options: { reservationId?: string; stage?: 'reserved' | 'root_created' } = {},
): Promise<void> {
  const stage = options.stage ?? 'root_created';
  const createdAt = '2026-09-30T01:01:00.000Z';
  const expiresAt = '2026-09-30T02:01:00.000Z';
  const proof = exactCanaryReservationProof(f, createdAt, expiresAt);
  await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
    current!.dispatchReservations!.push({
      reservationId: options.reservationId ?? f.fence.dispatchOperationId,
      targetAppIds: [...f.fence.targetAppIds].sort(),
      access: { mode: 'write', scopes: f.fence.writeScopes },
      createdAt,
      expiresAt,
      stage,
      ...(stage === 'root_created'
        ? { dispatchRoot, rootCreateTime: '2026-09-30T01:01:01.000Z' }
        : {}),
      taskControl: {
        mode: f.fence.taskControlMode,
        taskGuid: f.fence.taskGuid,
        phaseId: `workstream:${f.fence.taskGuid}`,
        workerAppId: f.fence.workerAppId,
        reviewerAppId: f.fence.reviewerAppId,
        acceptorAppId: f.fence.acceptorAppId,
        originTurnId: f.fence.originTurnId,
        coordinatorSessionId: f.fence.coordinatorSessionId,
        proof,
        recovery: {
          title: f.fence.title,
          purpose: f.fence.purpose,
          owners: f.fence.owners,
          botOpenIds: f.fence.botOpenIds,
          acceptanceRequested: f.fence.acceptanceRequested,
          seedText: f.fence.seedText,
        },
      },
    });
    return current;
  });
}

describe('field-only TaskControl collaboration config CAS', () => {
  it('rejects audit-only enable when the persisted fence lacks the immutable Phase A report binding', async () => {
    const f = fixture();
    await installFence(f);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      const record = current!.blockerRecords.find(
        item => item.code === 'task_control_canary_quarantine',
      )!;
      const parsed = JSON.parse(record.summary) as Record<string, unknown>;
      delete parsed.phaseA;
      record.summary = JSON.stringify(parsed);
      return current;
    });

    await expect(enableFenceConfig(f))
      .rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane).toBeUndefined();
  });

  it('requires the fenced CAS path for every audit-only enable', async () => {
    const f = fixture();
    await expect(writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: [f.fence.workerAppId, f.fence.reviewerAppId, f.fence.acceptorAppId],
      taskControlPlane: {
        mode: 'audit_only', acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1,
      },
    })).rejects.toThrow('project_task_control_config_cas_required');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toBeUndefined();
  });

  it('rejects direct semantic config writes and makes auto-enrolment a visible no-op while fenced', async () => {
    const f = fixture();
    await installFence(f);
    const before = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;

    await expect(writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: [...before.workerAppIds!, 'cli_late'], autoEnrollWorkers: true,
    })).rejects.toThrow('project_task_control_canary_fence_rejects_config_mutation');

    const onFencedNoop = vi.fn();
    expect(await addProjectWorkerIfNeeded(
      f.dataDir, f.context.chatId, 'cli_auto_joined', { onFencedNoop },
    )).toBeUndefined();
    expect(onFencedNoop).toHaveBeenCalledOnce();
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(before);
  });

  it('enables only taskControlPlane from the exact preimage and returns the canonical postimage', async () => {
    const f = fixture();
    await installFence(f);
    const before = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
    const enabledAt = '2026-09-30T01:01:00.000Z';

    const enabled = await enableFenceConfig(f, enabledAt);

    expect(enabled).toEqual({
      ...before,
      taskControlPlane: { mode: 'audit_only', acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1 },
      updatedAt: enabledAt,
    });
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(enabled);
  });

  it('disables only the exact fenced taskControlPlane and makes a lost-response retry idempotent', async () => {
    const f = fixture();
    await installFence(f);
    const fingerprint = fenceFingerprint(f);
    const enabled = await enableFenceConfig(f);
    const request = {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      progressCard: enabled.progressCard, taskControlPlane: null,
      taskControlPlaneCas: {
        operation: 'disable' as const, expectedConfigHash: configHash(enabled),
        expectedFenceFingerprint: fingerprint, now: '2026-09-30T01:02:00.000Z',
      },
    };

    const disabled = await writeGroupCollaborationMode(f.dataDir, request);
    expect(disabled).toEqual((({ taskControlPlane: _taskControlPlane, ...rest }) => rest)(enabled));
    expect(await writeGroupCollaborationMode(f.dataDir, request)).toEqual(disabled);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(disabled);
  });

  it('refuses to install a fence while audit-only config is already enabled', async () => {
    const f = fixture();
    const now = '2026-09-30T00:59:00.000Z';
    writeFileSync(join(f.dataDir, 'group-collaboration-modes.json'), JSON.stringify({
      schemaVersion: 1,
      configs: {
        [f.context.chatId]: {
          schemaVersion: 1, chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
          workerAppIds: [f.fence.workerAppId, f.fence.reviewerAppId, f.fence.acceptorAppId],
          autoEnrollWorkers: false,
          taskControlPlane: {
            mode: 'audit_only', acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1,
          },
          createdAt: now, updatedAt: now,
        },
      },
    }));
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '拒绝 enabled-without-fence' });

    await expect(f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence: f.fence, now: '2026-09-30T01:00:00.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_requires_config_absent');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords).toEqual([]);
  });

  it('refuses to clear the fence until audit-only config is actually absent', async () => {
    const f = fixture();
    await installFence(f);
    await enableFenceConfig(f);

    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
      now: '2026-09-30T01:02:00.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_cleanup_requires_absence');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane)
      .toEqual({ mode: 'audit_only', acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1 });
  });

  it('allows pre_dispatch_abort only before any Phase A instruction attempt', async () => {
    const untouched = fixture();
    await installFence(untouched);

    const cleared = await untouched.coordinator.run(untouched.context, {
      action: 'clear_task_control_canary_fence', fence: untouched.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
      now: '2026-09-30T01:02:00.000Z',
    } as any);
    expect(cleared.blockerRecords).not.toContainEqual(
      expect.objectContaining({ code: 'task_control_canary_quarantine' }),
    );

    const attempted = fixture();
    await installFence(attempted);
    await attempted.coordinator.run(attempted.context, {
      action: 'begin_task_control_phase_a_instruction',
      fenceFingerprint: fenceFingerprint(attempted),
      instructionTemplateSha256: attempted.fence.phaseA.instructionTemplateSha256,
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z', bootId: 'boot-cleanup-red',
        processStartedAt: '2026-09-30T01:00:00.000Z', monotonicMs: 1_000,
      },
    } as any);

    await expect(attempted.coordinator.run(attempted.context, {
      action: 'clear_task_control_canary_fence', fence: attempted.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
      now: '2026-09-30T01:02:00.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');
    await attempted.coordinator.run(attempted.context, {
      action: 'begin_task_control_phase_a_instruction',
      fenceFingerprint: fenceFingerprint(attempted),
      instructionTemplateSha256: attempted.fence.phaseA.instructionTemplateSha256,
      attempt: {
        wallTime: '2026-09-30T01:03:00.000Z', bootId: 'boot-after-restart',
        processStartedAt: '2026-09-30T01:03:00.000Z', monotonicMs: 5,
      },
    });
    await expect(attempted.coordinator.run(attempted.context, {
      action: 'clear_task_control_canary_fence', fence: attempted.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
      now: '2026-09-30T01:04:00.000Z',
    })).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');
    expect(readProjectGroup(attempted.dataDir, attempted.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));
  });

  it('clears phase_a_terminal_no_canary only after exact report, terminal, and evidence settlement', async () => {
    const f = fixture();
    f.context.larkAppId = 'cli_controller_1234567890123456';
    f.fence.controllerAppId = f.context.larkAppId;
    f.fence.workerAppId = 'cli_canary_worker_1234567890123456';
    f.fence.reviewerAppId = 'cli_canary_reviewer_1234567890123456';
    f.fence.acceptorAppId = 'cli_canary_acceptor_1234567890123456';
    f.fence.targetAppIds = [f.fence.workerAppId, f.fence.reviewerAppId];
    f.fence.phaseA.mappedWorkerAppId = 'cli_historical_worker_1234567890123456';
    f.fence.kickoff.bots = [
      { appId: f.fence.workerAppId, openId: 'ou_worker', displayName: 'Worker', role: 'worker' },
      { appId: f.fence.reviewerAppId, openId: 'ou_reviewer', displayName: 'Reviewer', role: 'reviewer' },
    ];
    await installFence(f);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams.push({
        dispatchRoot: f.fence.phaseA.historicalDispatchRoot,
        title: '历史任务', purpose: '提交冻结失败报告', owners: ['Worker'],
        targetAppIds: [f.fence.phaseA.mappedWorkerAppId],
        workerAppIds: [f.fence.phaseA.mappedWorkerAppId], reviewerAppIds: [],
        access: { mode: 'write', scopes: [f.dataDir] },
        status: 'in_progress', progress: 40,
        taskControl: {
          taskGuid: f.fence.phaseA.historicalTaskGuid, phaseId: 'workstream:historical',
          mappingRef: 'mapping:historical', mappingStatus: 'registered', sourceKind: 'project_group',
          controllerAppId: f.context.larkAppId, workerAppId: f.fence.phaseA.mappedWorkerAppId,
          reviewerAppId: f.fence.reviewerAppId, acceptorAppId: f.fence.acceptorAppId,
          projectRevision: current!.revision, reservationId: 'h'.repeat(50),
          coordinatorSessionId: f.context.coordinatorSessionId, originTurnId: 'om_historical_origin',
          reservationCreatedAt: '2026-09-29T00:00:00.000Z',
          reservationExpiresAt: '2026-09-29T01:00:00.000Z',
          rootCreateTime: '2026-09-29T00:00:01.000Z',
          reservationProof: {
            schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
            issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:historical', signature: 'a'.repeat(64),
          },
        },
        createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
      });
      return current;
    });
    const fingerprint = fenceFingerprint(f);
    await f.coordinator.run(f.context, {
      action: 'begin_task_control_phase_a_instruction', fenceFingerprint: fingerprint,
      instructionTemplateSha256: f.fence.phaseA.instructionTemplateSha256,
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z', bootId: 'boot-terminal-cleanup',
        processStartedAt: '2026-09-30T01:00:00.000Z', monotonicMs: 1_000,
      },
    });
    await f.coordinator.run(f.context, {
      action: 'complete_task_control_phase_a_instruction', fenceFingerprint: fingerprint,
      messageId: 'om_phase_a_instruction',
    });
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    const turn = {
      messageId: 'om_phase_a_instruction', chatId: f.context.chatId,
      dispatchRoot: f.fence.phaseA.historicalDispatchRoot,
      targetAppId: f.fence.phaseA.mappedWorkerAppId, sessionId: 'session_phase_a_worker',
    };
    claimTaskControlTurnAdmissionPendingSync(registryPath, turn, '2026-09-30T01:01:01.000Z');
    activateTaskControlTurnAdmissionSync(
      registryPath, { ...turn, workerGeneration: 7 }, '2026-09-30T01:01:02.000Z',
    );
    const reportRequestId = `report:${createHash('sha256').update(JSON.stringify({
      sourceSessionId: turn.sessionId, sourceTurnId: turn.messageId,
      dispatchRoot: f.fence.phaseA.historicalDispatchRoot,
      reporterAppId: f.fence.phaseA.mappedWorkerAppId,
      content: f.fence.phaseA.failedReportContent,
      projectUpdate: { status: 'failed' },
    })).digest('hex')}`;
    const failed = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: f.fence.phaseA.historicalDispatchRoot,
      reporterAppId: f.fence.phaseA.mappedWorkerAppId,
      status: 'failed', content: f.fence.phaseA.failedReportContent,
      phaseAReport: {
        operationId: f.fence.dispatchOperationId, fenceFingerprint: fingerprint,
        sourceSessionId: turn.sessionId, sourceTurnId: turn.messageId,
        workerGeneration: 7, reportRequestId,
      },
    });
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'phase_a_terminal_no_canary',
      now: '2026-09-30T01:01:02.750Z',
    })).rejects.toThrow('project_task_control_canary_fence_turn_claim_open');
    terminalizeTaskControlTurnAdmissionSync(
      registryPath, { ...turn, workerGeneration: 7 }, '2026-09-30T01:01:03.000Z',
    );
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'phase_a_terminal_no_canary',
      now: '2026-09-30T01:01:03.250Z',
    })).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');

    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const store = await TaskControlPlaneStore.open(f.dataDir, authority, turn.targetAppId);
    const trust = new ProjectWorkerEvidenceTrust({ hostSecret: 'cleanup-secret', sourceAppId: turn.targetAppId });
    const common = {
      schemaVersion: 'ProjectWorkerEvidence.v1' as const,
      sourceAppId: turn.targetAppId, controllerAppId: f.context.larkAppId,
      sourceSessionId: turn.sessionId, sourceTurnId: turn.messageId,
      workerGeneration: 7, dispatchAttempt: 1,
      dispatchRoot: turn.dispatchRoot,
    };
    const failedReport = trust.issue({
      ...common, eventKind: 'failed_report', occurredAt: '2026-09-30T01:01:02.500Z',
      reportRequestId, triggerId: 'om_phase_a_trigger', targetSessionId: f.context.coordinatorSessionId,
      contentHash: `sha256:${f.fence.phaseA.failedReportSha256}`, projectRevision: failed.revision,
    });
    const terminal = trust.issue({
      ...common, eventKind: 'terminal', occurredAt: '2026-09-30T01:01:03.000Z',
      terminalStatus: 'completed', finalOutputPresent: false,
    });
    store.enqueueProjectWorkerEvidence(failedReport, value => trust.verify(value));
    store.enqueueProjectWorkerEvidence(terminal, value => trust.verify(value));
    const failedReportClaim = store.claimProjectWorkerEvidence({
      now: Date.parse(failedReport.occurredAt), claimToken: `claim:${failedReport.evidenceId}`,
      staleClaimMs: 5_000,
    });
    store.settleProjectWorkerEvidenceDelivered(
      failedReportClaim!.outboxId, failedReportClaim!.claimToken!, `receipt:${failedReport.evidenceId}`,
      Date.parse(failedReport.occurredAt) + 1,
    );
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'phase_a_terminal_no_canary',
      now: '2026-09-30T01:01:03.500Z',
    })).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');
    const terminalClaim = store.claimProjectWorkerEvidence({
      now: Date.parse(terminal.occurredAt) + 2, claimToken: `claim:${terminal.evidenceId}`,
      staleClaimMs: 5_000,
    });
    store.settleProjectWorkerEvidenceDelivered(
      terminalClaim!.outboxId, terminalClaim!.claimToken!, `receipt:${terminal.evidenceId}`,
      Date.parse(terminal.occurredAt) + 3,
    );
    store.close();

    const clear = {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'phase_a_terminal_no_canary',
      now: '2026-09-30T01:02:00.000Z',
    } as const;
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.dispatchReservations!.push({
        reservationId: f.fence.dispatchOperationId,
        targetAppIds: f.fence.targetAppIds,
        access: { mode: 'write', scopes: f.fence.writeScopes },
        createdAt: '2026-09-30T01:01:30.000Z', expiresAt: '2026-09-30T02:01:30.000Z',
      });
      return current;
    });
    await expect(f.coordinator.run(f.context, clear))
      .rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.dispatchReservations = [];
      return current;
    });

    atomicWriteFailure.targetSuffix = 'project-groups.json';
    atomicWriteFailure.remaining = 1;
    await expect(f.coordinator.run(f.context, clear))
      .rejects.toThrow('injected_write_failure:project-groups.json');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));

    const restarted = await collectChild(spawnTsEvalWithRepoImports(`
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      const project = await coordinator.run(${JSON.stringify(f.context)}, ${JSON.stringify(clear)});
      console.log(JSON.stringify({ blockers: project.blockerRecords }));
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout.trim()).blockers).not.toContainEqual(
      expect.objectContaining({ code: 'task_control_canary_quarantine' }),
    );
  }, 10_000);

  it('persists authoritative two-phase success before delivered_terminal clears the fence', async () => {
    const f = fixture();
    const controllerAppId = 'cli_controller_1234567890123456';
    const workerAppId = 'cli_worker_1234567890123456';
    const reviewerAppId = 'cli_review_1234567890123456';
    const acceptorAppId = 'cli_accept_1234567890123456';
    const historicalWorkerAppId = 'cli_historical_worker_1234567890123456';
    const dispatchRoot = 'om_canaryroot';
    const kickoffMessageId = 'om_canary_kickoff';
    f.context.larkAppId = controllerAppId;
    f.fence.controllerAppId = controllerAppId;
    f.fence.workerAppId = workerAppId;
    f.fence.reviewerAppId = reviewerAppId;
    f.fence.acceptorAppId = acceptorAppId;
    f.fence.targetAppIds = [workerAppId, reviewerAppId];
    f.fence.phaseA.mappedWorkerAppId = historicalWorkerAppId;
    (f.fence as typeof f.fence & { kickoff: object }).kickoff = {
      templateVersion: 'TaskControlKickoff.v1', rootPlaceholder: '{{dispatchRoot}}',
      brief: f.fence.purpose,
      briefSha256: createHash('sha256').update(f.fence.purpose).digest('hex'),
      bots: [
        { appId: workerAppId, openId: 'ou_worker', displayName: 'Worker', role: 'worker' },
        { appId: reviewerAppId, openId: 'ou_reviewer', displayName: 'Reviewer', role: 'reviewer' },
      ],
    };
    await installFence(f);
    const fingerprint = fenceFingerprint(f);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');

    const bridge = new DaemonTaskControlBridge({ approvals: taskControlApprovals(), larkAppId: controllerAppId });
    const lifecycle = await startTaskControlPlaneRuntime({
      dataDir: f.dataDir, larkAppId: controllerAppId, flags: { ledgerEnabled: true },
      authority: bridge.authority, logger: { warn: () => {} },
    });
    const controllerStore = lifecycle.getStore()!;
    const reviewerVerifier = createDaemonReviewerVerdictVerifier({
      hostSecret: 'success-certificate-secret', controllerBotAppId: controllerAppId,
    });
    const integration = new DaemonTaskControlIntegration({
      dataDir: f.dataDir, larkAppId: controllerAppId, lifecycle, store: controllerStore,
      bridge, logger: { warn: () => {} }, projectReviewerTrust: reviewerVerifier,
    });
    integration.setReviewerVerdictVerifier(reviewerVerifier);
    f.coordinator.setTaskControlSuccessEvidenceReader(
      input => controllerStore.readTaskControlSuccessEvidence(input),
    );

    expect(integration.registerMapping(f.fence.phaseA.historicalDispatchRoot, {
      projectId: `project-group:${f.context.chatId}`, phaseId: 'workstream:historical',
      phaseTaskGuids: [f.fence.phaseA.historicalTaskGuid], taskGuid: f.fence.phaseA.historicalTaskGuid,
      topicRootId: f.fence.phaseA.historicalDispatchRoot, ownerId: historicalWorkerAppId,
      reviewerId: reviewerAppId, acceptorId: acceptorAppId,
      registrationRef: `topic-message:${f.fence.phaseA.historicalDispatchRoot}`,
      mappingAuthority: {
        kind: 'project_group', chatId: f.context.chatId, reservationId: 'h'.repeat(50),
        projectRevision: 2, acceptorAppId, mode: 'audit_only',
      },
    }, controllerAppId)).toBe(true);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams.push({
        dispatchRoot: f.fence.phaseA.historicalDispatchRoot, title: '历史任务',
        purpose: '提交冻结失败报告', owners: ['Worker'], targetAppIds: [historicalWorkerAppId],
        workerAppIds: [historicalWorkerAppId], reviewerAppIds: [],
        access: { mode: 'write', scopes: f.fence.writeScopes }, status: 'in_progress', progress: 40,
        taskControl: {
          taskGuid: f.fence.phaseA.historicalTaskGuid, phaseId: 'workstream:historical',
          mappingRef: `topic-message:${f.fence.phaseA.historicalDispatchRoot}`,
          mappingStatus: 'registered', sourceKind: 'project_group', controllerAppId,
          workerAppId: historicalWorkerAppId, reviewerAppId, acceptorAppId, projectRevision: 2,
          reservationId: 'h'.repeat(50), coordinatorSessionId: f.context.coordinatorSessionId,
          originTurnId: 'om_historical_origin', reservationCreatedAt: '2026-09-29T00:00:00.000Z',
          reservationExpiresAt: '2026-09-29T01:00:00.000Z', rootCreateTime: '2026-09-29T00:00:01.000Z',
          reservationProof: {
            schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: controllerAppId,
            issuedAt: '2026-09-29T00:00:00.000Z', keyId: 'tcpr1:historical', signature: 'a'.repeat(64),
          },
        },
        createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
      });
      return current;
    });
    await f.coordinator.run(f.context, {
      action: 'begin_task_control_phase_a_instruction', fenceFingerprint: fingerprint,
      instructionTemplateSha256: f.fence.phaseA.instructionTemplateSha256,
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z', bootId: 'boot-success-certificate',
        processStartedAt: '2026-09-30T01:00:00.000Z', monotonicMs: 1_000,
      },
    });
    await f.coordinator.run(f.context, {
      action: 'complete_task_control_phase_a_instruction', fenceFingerprint: fingerprint,
      messageId: 'om_phase_a_success_instruction',
    });
    const phaseATurn = {
      messageId: 'om_phase_a_success_instruction', chatId: f.context.chatId,
      dispatchRoot: f.fence.phaseA.historicalDispatchRoot, targetAppId: historicalWorkerAppId,
      sessionId: 'session_phase_a_success',
    };
    claimTaskControlTurnAdmissionPendingSync(registryPath, phaseATurn, '2026-09-30T01:01:01.000Z');
    activateTaskControlTurnAdmissionSync(
      registryPath, { ...phaseATurn, workerGeneration: 3 }, '2026-09-30T01:01:02.000Z',
    );
    const phaseAReportRequestId = `report:${createHash('sha256').update(JSON.stringify({
      sourceSessionId: phaseATurn.sessionId, sourceTurnId: phaseATurn.messageId,
      dispatchRoot: f.fence.phaseA.historicalDispatchRoot, reporterAppId: historicalWorkerAppId,
      content: f.fence.phaseA.failedReportContent, projectUpdate: { status: 'failed' },
    })).digest('hex')}`;
    const failedProject = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: f.fence.phaseA.historicalDispatchRoot,
      reporterAppId: historicalWorkerAppId, status: 'failed', content: f.fence.phaseA.failedReportContent,
      phaseAReport: {
        operationId: f.fence.dispatchOperationId, fenceFingerprint: fingerprint,
        sourceSessionId: phaseATurn.sessionId, sourceTurnId: phaseATurn.messageId,
        workerGeneration: 3, reportRequestId: phaseAReportRequestId,
      },
    });
    terminalizeTaskControlTurnAdmissionSync(
      registryPath, { ...phaseATurn, workerGeneration: 3 }, '2026-09-30T01:01:03.000Z',
    );

    const sourceAuthority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    const historicalSourceStore = await TaskControlPlaneStore.open(f.dataDir, sourceAuthority, historicalWorkerAppId);
    const historicalTrust = new ProjectWorkerEvidenceTrust({
      hostSecret: 'success-certificate-secret', sourceAppId: historicalWorkerAppId,
    });
    const deliver = async (evidence: Parameters<DaemonTaskControlIntegration['ingestProjectWorkerEvidence']>[0]) => {
      const trust = evidence.sourceAppId === historicalWorkerAppId
        ? historicalTrust
        : evidence.sourceAppId === workerAppId
          ? workerTrust
          : reviewerTrust;
      const result = integration.ingestProjectWorkerEvidence(evidence, value => trust.verify(value));
      if (!result.ok) throw new Error(result.reason);
      return result.receiptRef;
    };
    const historicalRelay = new ProjectWorkerEvidenceRelay({
      store: historicalSourceStore, trust: historicalTrust, deliver,
    });
    const phaseABase = {
      schemaVersion: 'ProjectWorkerEvidence.v1' as const, sourceAppId: historicalWorkerAppId,
      controllerAppId, sourceSessionId: phaseATurn.sessionId, sourceTurnId: phaseATurn.messageId,
      workerGeneration: 3, dispatchAttempt: 1, dispatchRoot: f.fence.phaseA.historicalDispatchRoot,
    };
    historicalRelay.capture({
      ...phaseABase, eventKind: 'failed_report', occurredAt: '2026-09-30T01:01:02.500Z',
      reportRequestId: phaseAReportRequestId, triggerId: 'om_phase_a_report_trigger',
      targetSessionId: f.context.coordinatorSessionId,
      contentHash: `sha256:${f.fence.phaseA.failedReportSha256}`, projectRevision: failedProject.revision,
    });
    historicalRelay.capture({
      ...phaseABase, eventKind: 'terminal', occurredAt: '2026-09-30T01:01:03.000Z',
      terminalStatus: 'completed', finalOutputPresent: false,
    });
    await historicalRelay.flushOnce(Date.parse('2026-09-30T01:01:04.000Z'));
    await historicalRelay.flushOnce(Date.parse('2026-09-30T01:01:04.000Z'));

    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams.push({
        dispatchRoot, title: f.fence.title, purpose: f.fence.purpose, owners: f.fence.owners,
        targetAppIds: f.fence.targetAppIds, workerAppIds: [workerAppId], reviewerAppIds: [reviewerAppId],
        access: { mode: 'write', scopes: f.fence.writeScopes }, status: 'pending', progress: 0,
        taskControl: {
          taskGuid: f.fence.taskGuid, phaseId: `workstream:${f.fence.taskGuid}`,
          mappingRef: `topic-message:${dispatchRoot}`, mappingStatus: 'registered', sourceKind: 'project_group',
          controllerAppId, workerAppId, reviewerAppId, acceptorAppId, projectRevision: 4,
          reservationId: f.fence.dispatchOperationId, coordinatorSessionId: f.context.coordinatorSessionId,
          originTurnId: f.fence.originTurnId, reservationCreatedAt: '2026-09-30T01:02:00.000Z',
          reservationExpiresAt: '2026-09-30T02:02:00.000Z', rootCreateTime: '2026-09-30T01:02:01.000Z',
          reservationProof: {
            schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: controllerAppId,
            issuedAt: '2026-09-30T01:02:00.000Z', keyId: 'tcpr1:canary', signature: 'b'.repeat(64),
          },
        },
        createdAt: '2026-09-30T01:02:01.000Z', updatedAt: '2026-09-30T01:02:01.000Z',
      });
      return current;
    });
    expect(integration.registerMapping(dispatchRoot, {
      projectId: `project-group:${f.context.chatId}`, phaseId: `workstream:${f.fence.taskGuid}`,
      phaseTaskGuids: [f.fence.taskGuid], taskGuid: f.fence.taskGuid, topicRootId: dispatchRoot,
      ownerId: workerAppId, reviewerId: reviewerAppId, acceptorId: acceptorAppId,
      registrationRef: `topic-message:${dispatchRoot}`,
      mappingAuthority: {
        kind: 'project_group', chatId: f.context.chatId, reservationId: f.fence.dispatchOperationId,
        projectRevision: 4, acceptorAppId, mode: 'audit_only',
      },
    }, controllerAppId)).toBe(true);
    await recordDispatchRegistryEntry(
      registryPath,
      dispatchRoot,
      exactCanaryRegistryEntry(f, dispatchRoot),
    );
    const providerAttempt = {
      wallTime: '2026-09-30T01:02:00.000Z', bootId: 'boot-success-certificate',
      processStartIdentity: 'process-success-certificate', monotonicMs: 2_000,
    };
    beginTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId, sourceAppId: controllerAppId,
      targetChatId: f.context.chatId, messageType: 'text', payloadHash: canarySeedPayloadHash(f),
      attempt: providerAttempt,
    });
    completeTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId, dispatchRoot,
    });
    beginTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId, sourceAppId: controllerAppId,
      chatId: f.context.chatId, dispatchRoot, fenceFingerprint: fingerprint,
      targetAppIds: f.fence.targetAppIds, messageType: 'post',
      payloadHash: canaryKickoffPayloadHash(f, dispatchRoot),
      attempt: { ...providerAttempt, monotonicMs: 2_001 },
    });
    completeTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId, messageId: kickoffMessageId,
    });

    const workerSourceStore = await TaskControlPlaneStore.open(f.dataDir, sourceAuthority, workerAppId);
    const reviewerSourceStore = await TaskControlPlaneStore.open(f.dataDir, sourceAuthority, reviewerAppId);
    const workerTrust = new ProjectWorkerEvidenceTrust({
      hostSecret: 'success-certificate-secret', sourceAppId: workerAppId,
    });
    const reviewerTrust = new ProjectWorkerEvidenceTrust({
      hostSecret: 'success-certificate-secret', sourceAppId: reviewerAppId,
    });
    const workerRelay = new ProjectWorkerEvidenceRelay({ store: workerSourceStore, trust: workerTrust, deliver });
    const reviewerRelay = new ProjectWorkerEvidenceRelay({ store: reviewerSourceStore, trust: reviewerTrust, deliver });
    const workerBase = {
      schemaVersion: 'ProjectWorkerEvidence.v1' as const, sourceAppId: workerAppId, controllerAppId,
      sourceSessionId: 'session_canary_worker', sourceTurnId: kickoffMessageId,
      workerGeneration: 2, dispatchAttempt: 1, dispatchRoot,
    };
    workerRelay.capture({ ...workerBase, eventKind: 'accepted', occurredAt: '2026-09-30T01:03:00.000Z' });
    workerRelay.capture({ ...workerBase, eventKind: 'execution_started', occurredAt: '2026-09-30T01:03:01.000Z' });
    const workerContent = 'worker delivery';
    const workerProject = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot, reporterAppId: workerAppId,
      status: 'completed', content: workerContent,
    });
    workerRelay.capture({
      ...workerBase, eventKind: 'submitted', occurredAt: '2026-09-30T01:03:02.000Z',
      reportRequestId: 'report:canary-worker', triggerId: 'om_worker_report',
      targetSessionId: f.context.coordinatorSessionId,
      contentHash: `sha256:${createHash('sha256').update(workerContent).digest('hex')}`,
      projectRevision: workerProject.revision,
    });
    workerRelay.capture({
      ...workerBase, eventKind: 'terminal', occurredAt: '2026-09-30T01:03:03.000Z',
      terminalStatus: 'completed', finalOutputPresent: false,
    });
    for (let index = 0; index < 4; index += 1) {
      await workerRelay.flushOnce(Date.parse('2026-09-30T01:03:10.000Z'));
    }

    const reviewerContent = 'review PASS';
    const reviewedProject = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot, reporterAppId: reviewerAppId,
      reviewVerdict: 'pass', reviewRound: 1, content: reviewerContent,
    });
    const persistCertificate = (now: string) => f.coordinator.run(f.context, {
      action: 'persist_task_control_success_certificate', fence: f.fence, now,
    } as any);
    await expect(persistCertificate('2026-09-30T01:03:04.000Z'))
      .rejects.toThrow('project_task_control_success_certificate_phase_b_evidence_invalid');
    const reviewerBase = {
      schemaVersion: 'ProjectWorkerEvidence.v1' as const, sourceAppId: reviewerAppId, controllerAppId,
      sourceSessionId: 'session_canary_reviewer', sourceTurnId: kickoffMessageId,
      workerGeneration: 4, dispatchAttempt: 1, dispatchRoot,
    };
    const reviewArtifact = {
      kind: 'project_report' as const, reportRequestId: 'report:canary-reviewer',
      triggerId: 'om_reviewer_report', dispatchRoot, sourceSessionId: reviewerBase.sourceSessionId,
      sourceTurnId: reviewerBase.sourceTurnId, reporterAppId: reviewerAppId,
      targetSessionId: f.context.coordinatorSessionId, projectRevision: reviewedProject.revision,
      contentHash: `sha256:${createHash('sha256').update(reviewerContent).digest('hex')}`,
    };
    const reviewerVerdict = reviewerVerifier.providerForApp(reviewerAppId)!.issueVerdict({
      verdictId: 'rv_success_certificate', projectId: `project-group:${f.context.chatId}`,
      phaseId: `workstream:${f.fence.taskGuid}`, taskGuid: f.fence.taskGuid,
      topicRootId: dispatchRoot, taskSetSnapshot: [f.fence.taskGuid], reviewRound: 1,
      designatedReviewerRef: reviewerDesignationRef(dispatchRoot, reviewerAppId, 1, 4),
      reviewerId: reviewerAppId, reviewerBotAppId: reviewerAppId,
      sessionId: reviewerBase.sourceSessionId, workerGeneration: 4,
      capability: 'review-capability', sourceMessageId: reviewArtifact.triggerId,
      sourceVersionHash: reviewArtifact.contentHash, kind: 'verdict', verdict: 'pass',
      conditionIds: [], resolvedConditionEvidence: {}, artifactEvidence: reviewArtifact,
      issuedAt: '2026-09-30T01:03:04.000Z', expiresAt: '2099-09-30T01:03:04.000Z',
    });
    reviewerRelay.capture({
      ...reviewerBase, eventKind: 'reviewed', occurredAt: '2026-09-30T01:03:04.000Z',
      reportRequestId: reviewArtifact.reportRequestId, triggerId: reviewArtifact.triggerId,
      targetSessionId: reviewArtifact.targetSessionId, contentHash: reviewArtifact.contentHash,
      projectRevision: reviewArtifact.projectRevision, reviewVerdict: 'pass', reviewRound: 1,
      reviewerVerdict,
    });
    reviewerRelay.capture({
      ...reviewerBase, eventKind: 'terminal', occurredAt: '2026-09-30T01:03:05.000Z',
      terminalStatus: 'completed', finalOutputPresent: false,
    });
    await expect(persistCertificate('2026-09-30T01:03:06.000Z'))
      .rejects.toThrow('project_task_control_success_certificate_evidence_unsettled');
    await reviewerRelay.flushOnce(Date.parse('2026-09-30T01:03:10.000Z'));
    await reviewerRelay.flushOnce(Date.parse('2026-09-30T01:03:10.000Z'));

    expect(controllerStore.getTaskTrustedTerminalDecision(dispatchRoot, f.fence.taskGuid))
      .toMatchObject({ released: true, releaseKind: 'valid_delivered_done' });
    expect(workerSourceStore.listProjectWorkerEvidenceOutbox().every(row => row.status === 'delivered')).toBe(true);
    expect(reviewerSourceStore.listProjectWorkerEvidenceOutbox().every(row => row.status === 'delivered')).toBe(true);

    const workerTurn = {
      messageId: kickoffMessageId, chatId: f.context.chatId, dispatchRoot,
      targetAppId: workerAppId, sessionId: workerBase.sourceSessionId, workerGeneration: 2,
    };
    claimTaskControlTurnAdmissionPendingSync(registryPath, workerTurn, '2026-09-30T01:03:10.000Z');
    activateTaskControlTurnAdmissionSync(registryPath, workerTurn, '2026-09-30T01:03:11.000Z');
    terminalizeTaskControlTurnAdmissionSync(registryPath, workerTurn, '2026-09-30T01:03:12.000Z');
    await expect(persistCertificate('2026-09-30T01:03:13.000Z'))
      .rejects.toThrow('project_task_control_success_certificate_phase_b_turn_invalid');
    const reviewerTurn = {
      messageId: kickoffMessageId, chatId: f.context.chatId, dispatchRoot,
      targetAppId: reviewerAppId, sessionId: reviewerBase.sourceSessionId, workerGeneration: 4,
    };
    claimTaskControlTurnAdmissionPendingSync(registryPath, reviewerTurn, '2026-09-30T01:03:14.000Z');
    activateTaskControlTurnAdmissionSync(registryPath, reviewerTurn, '2026-09-30T01:03:15.000Z');
    terminalizeTaskControlTurnAdmissionSync(registryPath, reviewerTurn, '2026-09-30T01:03:16.000Z');

    atomicWriteFailure.targetSuffix = 'orchestrate-dispatch.json';
    atomicWriteFailure.remaining = 1;
    await expect(persistCertificate('2026-09-30T01:03:17.000Z'))
      .rejects.toThrow('injected_write_failure:orchestrate-dispatch.json');
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))
      .__taskControlSuccessCertificatesV1).toBeUndefined();

    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'delivered_terminal',
      now: '2026-09-30T01:03:59.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');

    const unexpectedScopeFile = join(f.fence.writeScopes[0]!, 'unexpected.txt');
    writeFileSync(unexpectedScopeFile, 'unexpected');
    await expect(persistCertificate('2026-09-30T01:04:00.000Z'))
      .rejects.toThrow('project_task_control_success_certificate_scope_not_empty');
    rmSync(unexpectedScopeFile);

    await persistCertificate('2026-09-30T01:04:00.000Z');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as any;
    const certificate = registry.__taskControlSuccessCertificatesV1?.certificates?.[f.fence.dispatchOperationId];
    expect(certificate?.certificateHash).toEqual(expect.stringMatching(/^tcsc1:[a-f0-9]{64}$/));
    await persistCertificate('2026-09-30T01:04:01.000Z');
    const replayed = JSON.parse(readFileSync(registryPath, 'utf8')) as any;
    expect(replayed.__taskControlSuccessCertificatesV1.certificates[f.fence.dispatchOperationId])
      .toEqual(certificate);

    const foreignOperationId = 'e'.repeat(50);
    const foreignCertificate = {
      ...certificate,
      operationId: foreignOperationId,
      dispatchRoot: 'om_foreign_success_root',
      taskGuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    foreignCertificate.certificateHash = successCertificateHash(foreignCertificate);
    const withForeignCertificate = structuredClone(replayed);
    withForeignCertificate.__taskControlSuccessCertificatesV1.certificates[foreignOperationId]
      = foreignCertificate;
    writeFileSync(registryPath, JSON.stringify(withForeignCertificate, null, 2));
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'delivered_terminal',
      successCertificateHash: foreignCertificate.certificateHash,
      now: '2026-09-30T01:04:01.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');

    const partialCertificate = {
      ...certificate,
      evidence: { phaseA: certificate.evidence.phaseA },
    };
    partialCertificate.certificateHash = successCertificateHash(partialCertificate);
    const withPartialCertificate = structuredClone(replayed);
    withPartialCertificate.__taskControlSuccessCertificatesV1.certificates[f.fence.dispatchOperationId]
      = partialCertificate;
    writeFileSync(registryPath, JSON.stringify(withPartialCertificate, null, 2));
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'delivered_terminal',
      successCertificateHash: partialCertificate.certificateHash,
      now: '2026-09-30T01:04:01.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');
    writeFileSync(registryPath, JSON.stringify(replayed, null, 2));

    writeFileSync(unexpectedScopeFile, 'late unexpected');
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'delivered_terminal',
      successCertificateHash: certificate.certificateHash,
      now: '2026-09-30T01:04:01.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');
    rmSync(unexpectedScopeFile);

    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'delivered_terminal',
      successCertificateHash: `tcsc1:${'0'.repeat(64)}`,
      now: '2026-09-30T01:04:01.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');

    const tampered = structuredClone(replayed);
    tampered.__taskControlSuccessCertificatesV1.certificates[f.fence.dispatchOperationId]
      .evidence.phaseB.deliveryRound = 2;
    writeFileSync(registryPath, JSON.stringify(tampered, null, 2));
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'delivered_terminal',
      successCertificateHash: certificate.certificateHash,
      now: '2026-09-30T01:04:01.000Z',
    } as any)).rejects.toThrow('project_task_control_success_certificate_registry_invalid');
    writeFileSync(registryPath, JSON.stringify(replayed, null, 2));

    const certifiedProject = readProjectGroup(f.dataDir, f.context.chatId)!;
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      const workstream = current!.workstreams.find(item => item.dispatchRoot === dispatchRoot)!;
      workstream.review = { ...workstream.review!, reviewerAppId: 'cli_foreign_reviewer' };
      current!.revision += 1;
      current!.updatedAt = '2026-09-30T01:04:02.000Z';
      return current;
    });
    await expect(f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'delivered_terminal',
      successCertificateHash: certificate.certificateHash,
      now: '2026-09-30T01:04:03.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_fence_cleanup_not_safe');
    await mutateProjectGroup(f.dataDir, f.context.chatId, () => certifiedProject);

    const clear = {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'delivered_terminal',
      successCertificateHash: certificate.certificateHash,
      now: '2026-09-30T01:04:04.000Z',
    } as const;
    const restarted = await collectChild(spawnTsEvalWithRepoImports(`
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      const project = await coordinator.run(${JSON.stringify(f.context)}, ${JSON.stringify(clear)});
      console.log(JSON.stringify({ blockers: project.blockerRecords }));
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout.trim()).blockers).not.toContainEqual(
      expect.objectContaining({ code: 'task_control_canary_quarantine' }),
    );
    const retried = await f.coordinator.run(f.context, clear);
    expect(retried.blockerRecords).not.toContainEqual(
      expect.objectContaining({ code: 'task_control_canary_quarantine' }),
    );

    await historicalRelay.close(100);
    await workerRelay.close(100);
    await reviewerRelay.close(100);
    historicalSourceStore.close();
    workerSourceStore.close();
    reviewerSourceStore.close();
    await lifecycle.close();
  }, 20_000);

  it.each([
    ['mode=standard', (current: any) => ({ chatId: current.chatId, mode: 'standard' })],
    ['coordinator replacement', (current: any) => ({ ...current, coordinatorAppId: 'cli_foreign' })],
    ['worker addition', (current: any) => ({ ...current, workerAppIds: [...current.workerAppIds, 'cli_foreign'] })],
    ['worker removal', (current: any) => ({ ...current, workerAppIds: current.workerAppIds.slice(1) })],
    ['progress-card mutation', (current: any) => ({
      ...current,
      progressCard: {
        schemaVersion: 1, templateId: 'compact-list', sections: ['goal'], milestonesExpanded: false,
      },
    })],
  ])('rejects %s through the ordinary write path while fenced', async (_label, mutate) => {
    const f = fixture();
    await installFence(f);
    const before = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
    const input = mutate(before);
    delete input.schemaVersion;
    delete input.createdAt;
    delete input.updatedAt;
    delete input.onboardingCard;

    await expect(writeGroupCollaborationMode(f.dataDir, input))
      .rejects.toThrow('project_task_control_canary_fence_rejects_config_mutation');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(before);
  });

  it('rejects stale enable hashes, foreign fence fingerprints, and non-empty reservations', async () => {
    const stale = fixture();
    await installFence(stale);
    const staleBefore = readGroupCollaborationMode(stale.dataDir, stale.context.chatId)!;
    const request = {
      chatId: staleBefore.chatId, mode: staleBefore.mode, coordinatorAppId: staleBefore.coordinatorAppId,
      workerAppIds: staleBefore.workerAppIds, autoEnrollWorkers: staleBefore.autoEnrollWorkers,
      taskControlPlane: {
        mode: 'audit_only' as const, acceptorAppId: stale.fence.acceptorAppId, maxActiveMappings: 1 as const,
      },
      taskControlPlaneCas: {
        operation: 'enable' as const, expectedConfigHash: `pgc1:${'0'.repeat(64)}`,
        expectedFenceFingerprint: fenceFingerprint(stale), now: '2026-09-30T01:01:00.000Z',
      },
    };
    await expect(writeGroupCollaborationMode(stale.dataDir, request))
      .rejects.toThrow('project_task_control_config_cas_conflict');
    await expect(writeGroupCollaborationMode(stale.dataDir, {
      ...request,
      taskControlPlaneCas: {
        ...request.taskControlPlaneCas, expectedConfigHash: configHash(staleBefore),
        expectedFenceFingerprint: `tccq1:${'0'.repeat(64)}`,
      },
    })).rejects.toThrow('project_task_control_canary_fence_conflict');
    await expect(writeGroupCollaborationMode(stale.dataDir, {
      ...request,
      taskControlPlane: {
        ...request.taskControlPlane, acceptorAppId: stale.fence.reviewerAppId,
      },
      taskControlPlaneCas: {
        ...request.taskControlPlaneCas, expectedConfigHash: configHash(staleBefore),
      },
    })).rejects.toThrow('project_task_control_config_cas_conflict');

    const reserved = fixture();
    await installFence(reserved);
    await mutateProjectGroup(reserved.dataDir, reserved.context.chatId, current => {
      current!.dispatchReservations!.push({
        reservationId: 'foreign', targetAppIds: ['cli_foreign'], access: { mode: 'read_only' },
        createdAt: '2026-09-30T01:00:00.000Z', expiresAt: '2026-09-30T02:00:00.000Z',
      });
      return current;
    });
    await expect(enableFenceConfig(reserved))
      .rejects.toThrow('project_task_control_config_enable_precondition_failed');
  });

  it('never removes a foreign audit-only value during disable', async () => {
    const f = fixture();
    await installFence(f);
    const enabled = await enableFenceConfig(f);
    const path = join(f.dataDir, 'group-collaboration-modes.json');
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    registry.configs[f.context.chatId].taskControlPlane.acceptorAppId = f.fence.reviewerAppId;
    writeFileSync(path, JSON.stringify(registry));

    await expect(writeGroupCollaborationMode(f.dataDir, {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      taskControlPlane: null,
      taskControlPlaneCas: {
        operation: 'disable', expectedConfigHash: configHash(enabled),
        expectedFenceFingerprint: fenceFingerprint(f),
      },
    })).rejects.toThrow('project_task_control_config_cas_conflict');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane?.acceptorAppId)
      .toBe(f.fence.reviewerAppId);
  });

  it('fails closed on stale or foreign disable and explicit or implicit task-control removal', async () => {
    const f = fixture();
    await installFence(f);
    const enabled = await enableFenceConfig(f);
    const exactRequest = {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      progressCard: enabled.progressCard, taskControlPlane: null,
      taskControlPlaneCas: {
        operation: 'disable' as const, expectedConfigHash: configHash(enabled),
        expectedFenceFingerprint: fenceFingerprint(f), now: '2026-09-30T01:02:00.000Z',
      },
    };

    await expect(writeGroupCollaborationMode(f.dataDir, {
      ...exactRequest,
      taskControlPlaneCas: { ...exactRequest.taskControlPlaneCas, expectedConfigHash: `pgc1:${'0'.repeat(64)}` },
    })).rejects.toThrow('project_task_control_config_cas_conflict');
    await expect(writeGroupCollaborationMode(f.dataDir, {
      ...exactRequest,
      taskControlPlaneCas: {
        ...exactRequest.taskControlPlaneCas, expectedFenceFingerprint: `tccq1:${'0'.repeat(64)}`,
      },
    })).rejects.toThrow('project_task_control_canary_fence_conflict');
    await expect(writeGroupCollaborationMode(f.dataDir, {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      progressCard: enabled.progressCard, taskControlPlane: null,
    })).rejects.toThrow('project_task_control_config_cas_required');
    await expect(writeGroupCollaborationMode(f.dataDir, {
      chatId: enabled.chatId, mode: 'standard',
    })).rejects.toThrow('project_task_control_config_cas_required');

    const omitted = await writeGroupCollaborationMode(f.dataDir, {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      progressCard: enabled.progressCard,
    });
    expect(omitted).toEqual(enabled);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(enabled);
  });

  it.each([
    ['mode change', (input: any) => { input.mode = 'standard'; }],
    ['coordinator replacement', (input: any) => { input.coordinatorAppId = 'cli_foreign'; }],
    ['worker removal', (input: any, f: ReturnType<typeof fixture>) => {
      input.workerAppIds = input.workerAppIds.filter((appId: string) => appId !== f.fence.workerAppId);
    }],
    ['worker replacement', (input: any, f: ReturnType<typeof fixture>) => {
      input.workerAppIds = input.workerAppIds.map((appId: string) => (
        appId === f.fence.workerAppId ? 'cli_foreign_worker' : appId
      ));
    }],
    ['reviewer removal', (input: any, f: ReturnType<typeof fixture>) => {
      input.workerAppIds = input.workerAppIds.filter((appId: string) => appId !== f.fence.reviewerAppId);
    }],
    ['reviewer replacement', (input: any, f: ReturnType<typeof fixture>) => {
      input.workerAppIds = input.workerAppIds.map((appId: string) => (
        appId === f.fence.reviewerAppId ? 'cli_foreign_reviewer' : appId
      ));
    }],
    ['acceptor removal', (input: any, f: ReturnType<typeof fixture>) => {
      input.workerAppIds = input.workerAppIds.filter((appId: string) => appId !== f.fence.acceptorAppId);
    }],
    ['acceptor replacement', (input: any, f: ReturnType<typeof fixture>) => {
      input.workerAppIds = input.workerAppIds.map((appId: string) => (
        appId === f.fence.acceptorAppId ? 'cli_foreign_acceptor' : appId
      ));
    }],
    ['progress-card mutation', (input: any) => {
      input.progressCard = {
        schemaVersion: 1, templateId: 'compact-list', sections: ['goal'], milestonesExpanded: false,
      };
    }],
  ])('rejects a %s bundled into the exact disable CAS', async (_label, mutate) => {
    const f = fixture();
    await installFence(f);
    const enabled = await enableFenceConfig(f);
    const input: any = {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      progressCard: enabled.progressCard, taskControlPlane: null,
      taskControlPlaneCas: {
        operation: 'disable', expectedConfigHash: configHash(enabled),
        expectedFenceFingerprint: fenceFingerprint(f), now: '2026-09-30T01:02:00.000Z',
      },
    };
    mutate(input, f);

    await expect(writeGroupCollaborationMode(f.dataDir, input))
      .rejects.toThrow('project_task_control_config_cas_field_scope');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(enabled);
  });

  it('serializes enable against fence clear across independent processes', async () => {
    const f = fixture();
    await installFence(f);
    const before = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
    const enable = {
      chatId: before.chatId, mode: before.mode, coordinatorAppId: before.coordinatorAppId,
      workerAppIds: before.workerAppIds, autoEnrollWorkers: before.autoEnrollWorkers,
      taskControlPlane: {
        mode: 'audit_only', acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1,
      },
      taskControlPlaneCas: {
        operation: 'enable', expectedConfigHash: configHash(before),
        expectedFenceFingerprint: fenceFingerprint(f), now: '2026-09-30T01:01:00.000Z',
      },
    };
    const enableSource = `
      import { writeGroupCollaborationMode } from './src/services/group-collaboration-mode-store.js';
      try {
        await writeGroupCollaborationMode(${JSON.stringify(f.dataDir)}, ${JSON.stringify(enable)});
        console.log(JSON.stringify({ ok: true, action: 'enable' }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, action: 'enable', error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const clearSource = `
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      try {
        await coordinator.run(${JSON.stringify(f.context)}, ${JSON.stringify({
          action: 'clear_task_control_canary_fence', fence: f.fence,
          auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
          now: '2026-09-30T01:00:00.000Z',
        })});
        console.log(JSON.stringify({ ok: true, action: 'clear' }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, action: 'clear', error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const results = await Promise.all([enableSource, clearSource].map(source => (
      collectChild(spawnTsEvalWithRepoImports(source, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }))
    )));
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    const outcomes = results.map(result => JSON.parse(result.stdout.trim()));
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);
    const configEnabled = readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane !== undefined;
    const fencePresent = readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords
      .some(record => record.code === 'task_control_canary_quarantine') === true;
    expect(configEnabled && !fencePresent).toBe(false);
  }, 10_000);

  it('preserves concurrent same-chat auto-enrolment across independent processes', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: [f.fence.workerAppId, f.fence.reviewerAppId, f.fence.acceptorAppId],
      autoEnrollWorkers: true,
    });
    const sources = ['cli_late_a', 'cli_late_b'].map(appId => `
      import { addProjectWorkerIfNeeded } from './src/services/group-collaboration-mode-store.js';
      await addProjectWorkerIfNeeded(${JSON.stringify(f.dataDir)}, ${JSON.stringify(f.context.chatId)}, ${JSON.stringify(appId)});
    `);

    const results = await Promise.all(sources.map(source => (
      collectChild(spawnTsEvalWithRepoImports(source, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }))
    )));
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    expect(new Set(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.workerAppIds)).toEqual(new Set([
      f.fence.workerAppId, f.fence.reviewerAppId, f.fence.acceptorAppId, 'cli_late_a', 'cli_late_b',
    ]));
  }, 10_000);

  it('keeps cross-process auto-enrolment as a no-op while fenced', async () => {
    const f = fixture();
    await installFence(f);
    const before = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
    const source = `
      import { addProjectWorkerIfNeeded } from './src/services/group-collaboration-mode-store.js';
      const result = await addProjectWorkerIfNeeded(
        ${JSON.stringify(f.dataDir)}, ${JSON.stringify(f.context.chatId)}, 'cli_late_process',
      );
      console.log(JSON.stringify({ result: result ?? null }));
    `;

    const result = await collectChild(
      spawnTsEvalWithRepoImports(source, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ result: null });
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(before);
  }, 10_000);

  it('serializes a repeated fence install against exact disable across independent processes', async () => {
    const f = fixture();
    await installFence(f);
    const enabled = await enableFenceConfig(f);
    const disable = {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      progressCard: enabled.progressCard, taskControlPlane: null,
      taskControlPlaneCas: {
        operation: 'disable', expectedConfigHash: configHash(enabled),
        expectedFenceFingerprint: fenceFingerprint(f), now: '2026-09-30T01:02:00.000Z',
      },
    };
    const installSource = `
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      try {
        await coordinator.run(${JSON.stringify(f.context)}, ${JSON.stringify({
          action: 'install_task_control_canary_fence', fence: f.fence, now: '2026-09-30T01:00:00.000Z',
        })});
        console.log(JSON.stringify({ ok: true, action: 'install' }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, action: 'install', error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const disableSource = `
      import { writeGroupCollaborationMode } from './src/services/group-collaboration-mode-store.js';
      try {
        await writeGroupCollaborationMode(${JSON.stringify(f.dataDir)}, ${JSON.stringify(disable)});
        console.log(JSON.stringify({ ok: true, action: 'disable' }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, action: 'disable', error: error instanceof Error ? error.message : String(error) }));
      }
    `;

    const results = await Promise.all([installSource, disableSource].map(source => (
      collectChild(spawnTsEvalWithRepoImports(source, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }))
    )));
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    const outcomes = results.map(result => JSON.parse(result.stdout.trim()));
    expect(outcomes).toContainEqual({ ok: true, action: 'disable' });
    const install = outcomes.find(result => result.action === 'install');
    expect(install.ok || install.error === 'project_task_control_canary_fence_requires_config_absent').toBe(true);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane).toBeUndefined();
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));

    await f.coordinator.run(f.context, {
      action: 'clear_task_control_canary_fence', fence: f.fence,
      auditOnlyConfirmedAbsent: true, cleanupState: 'pre_dispatch_abort',
      now: '2026-09-30T01:00:00.000Z',
    } as any);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords).toEqual([]);
  }, 10_000);

  it('converges concurrent exact fence installation across independent processes', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: [f.fence.workerAppId, f.fence.reviewerAppId, f.fence.acceptorAppId],
      autoEnrollWorkers: true,
    });
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '验证并发 fence install' });
    const installSource = `
      import { ProjectCoordinator } from './src/services/project-coordinator.js';
      const coordinator = new ProjectCoordinator({
        sendCard: async () => 'om_card', updateCard: async () => {}, pinMessage: async () => true,
        unpinMessage: async () => true, resolveThreadId: async () => null,
        isMessageWithdrawn: () => false, brand: () => 'feishu',
      });
      try {
        await coordinator.run(${JSON.stringify(f.context)}, ${JSON.stringify({
          action: 'install_task_control_canary_fence', fence: f.fence, now: '2026-09-30T01:00:00.000Z',
        })});
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;

    const results = await Promise.all([installSource, installSource].map(source => (
      collectChild(spawnTsEvalWithRepoImports(source, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }))
    )));
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    expect(results.map(result => JSON.parse(result.stdout.trim())))
      .toEqual([{ ok: true }, { ok: true }]);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords.filter(
      record => record.code === 'task_control_canary_quarantine',
    )).toHaveLength(1);
  }, 10_000);

  it('recovers after process crashes immediately after enable and disable writes', async () => {
    const f = fixture();
    await installFence(f);
    const before = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
    const enable = {
      chatId: before.chatId, mode: before.mode, coordinatorAppId: before.coordinatorAppId,
      workerAppIds: before.workerAppIds, autoEnrollWorkers: before.autoEnrollWorkers,
      progressCard: before.progressCard,
      taskControlPlane: {
        mode: 'audit_only', acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1,
      },
      taskControlPlaneCas: {
        operation: 'enable', expectedConfigHash: configHash(before),
        expectedFenceFingerprint: fenceFingerprint(f), now: '2026-09-30T01:01:00.000Z',
      },
    };
    const enableCrash = await collectChild(spawnTsEvalWithRepoImports(`
      import { writeGroupCollaborationMode } from './src/services/group-collaboration-mode-store.js';
      await writeGroupCollaborationMode(${JSON.stringify(f.dataDir)}, ${JSON.stringify(enable)});
      process.exit(17);
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(enableCrash.code, enableCrash.stderr).toBe(17);
    const enabled = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
    expect(enabled.taskControlPlane?.mode).toBe('audit_only');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));

    const disable = {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      progressCard: enabled.progressCard, taskControlPlane: null,
      taskControlPlaneCas: {
        operation: 'disable', expectedConfigHash: configHash(enabled),
        expectedFenceFingerprint: fenceFingerprint(f), now: '2026-09-30T01:02:00.000Z',
      },
    };
    const disableCrash = await collectChild(spawnTsEvalWithRepoImports(`
      import { writeGroupCollaborationMode } from './src/services/group-collaboration-mode-store.js';
      await writeGroupCollaborationMode(${JSON.stringify(f.dataDir)}, ${JSON.stringify(disable)});
      process.exit(19);
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(disableCrash.code, disableCrash.stderr).toBe(19);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane).toBeUndefined();
    expect(await writeGroupCollaborationMode(f.dataDir, disable))
      .toEqual(readGroupCollaborationMode(f.dataDir, f.context.chatId));
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));
  }, 10_000);

  it('leaves only safe config and fence states after every injected write failure', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: [f.fence.workerAppId, f.fence.reviewerAppId, f.fence.acceptorAppId],
      autoEnrollWorkers: true,
    });
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '验证写失败恢复' });
    const install = {
      action: 'install_task_control_canary_fence' as const,
      fence: f.fence,
      now: '2026-09-30T01:00:00.000Z',
    };

    atomicWriteFailure.targetSuffix = 'project-groups.json';
    atomicWriteFailure.remaining = 1;
    await expect(f.coordinator.run(f.context, install as any))
      .rejects.toThrow('injected_write_failure:project-groups.json');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane).toBeUndefined();
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords).toEqual([]);

    await f.coordinator.run(f.context, install as any);
    const before = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
    const enable = {
      chatId: before.chatId, mode: before.mode, coordinatorAppId: before.coordinatorAppId,
      workerAppIds: before.workerAppIds, autoEnrollWorkers: before.autoEnrollWorkers,
      progressCard: before.progressCard,
      taskControlPlane: {
        mode: 'audit_only' as const, acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1 as const,
      },
      taskControlPlaneCas: {
        operation: 'enable' as const, expectedConfigHash: configHash(before),
        expectedFenceFingerprint: fenceFingerprint(f), now: '2026-09-30T01:01:00.000Z',
      },
    };
    atomicWriteFailure.targetSuffix = 'group-collaboration-modes.json';
    atomicWriteFailure.remaining = 1;
    await expect(writeGroupCollaborationMode(f.dataDir, enable))
      .rejects.toThrow('injected_write_failure:group-collaboration-modes.json');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(before);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));

    const enabled = await writeGroupCollaborationMode(f.dataDir, enable);
    const disable = {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      progressCard: enabled.progressCard, taskControlPlane: null,
      taskControlPlaneCas: {
        operation: 'disable' as const, expectedConfigHash: configHash(enabled),
        expectedFenceFingerprint: fenceFingerprint(f), now: '2026-09-30T01:02:00.000Z',
      },
    };
    atomicWriteFailure.remaining = 1;
    await expect(writeGroupCollaborationMode(f.dataDir, disable))
      .rejects.toThrow('injected_write_failure:group-collaboration-modes.json');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(enabled);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));

    const disabled = await writeGroupCollaborationMode(f.dataDir, disable);
    atomicWriteFailure.targetSuffix = 'project-groups.json';
    atomicWriteFailure.remaining = 1;
    const clear = {
      action: 'clear_task_control_canary_fence' as const,
      fence: f.fence,
      auditOnlyConfirmedAbsent: true,
      cleanupState: 'pre_dispatch_abort' as const,
      now: '2026-09-30T01:00:00.000Z',
    };
    await expect(f.coordinator.run(f.context, clear as any))
      .rejects.toThrow('injected_write_failure:project-groups.json');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(disabled);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));

    await f.coordinator.run(f.context, clear as any);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)).toEqual(disabled);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords).toEqual([]);
  });

  it('preserves a concurrent other-chat update across independent processes', async () => {
    const f = fixture();
    await installFence(f);
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: 'oc_other', mode: 'project', coordinatorAppId: 'cli_other_coordinator',
      workerAppIds: ['cli_other_worker'],
    });
    const before = readGroupCollaborationMode(f.dataDir, f.context.chatId)!;
    const enable = {
      chatId: before.chatId, mode: before.mode, coordinatorAppId: before.coordinatorAppId,
      workerAppIds: before.workerAppIds, autoEnrollWorkers: before.autoEnrollWorkers,
      taskControlPlane: {
        mode: 'audit_only', acceptorAppId: f.fence.acceptorAppId, maxActiveMappings: 1,
      },
      taskControlPlaneCas: {
        operation: 'enable', expectedConfigHash: configHash(before),
        expectedFenceFingerprint: fenceFingerprint(f), now: '2026-09-30T01:01:00.000Z',
      },
    };
    const sources = [
      `import { writeGroupCollaborationMode } from './src/services/group-collaboration-mode-store.js';
       await writeGroupCollaborationMode(${JSON.stringify(f.dataDir)}, ${JSON.stringify(enable)});`,
      `import { writeGroupCollaborationMode } from './src/services/group-collaboration-mode-store.js';
       await writeGroupCollaborationMode(${JSON.stringify(f.dataDir)}, ${JSON.stringify({
         chatId: 'oc_other', mode: 'project', coordinatorAppId: 'cli_other_coordinator',
         workerAppIds: ['cli_other_worker', 'cli_other_new'],
       })});`,
    ];
    const results = await Promise.all(sources.map(source => (
      collectChild(spawnTsEvalWithRepoImports(source, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }))
    )));
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane?.mode).toBe('audit_only');
    expect(readGroupCollaborationMode(f.dataDir, 'oc_other')?.workerAppIds)
      .toEqual(['cli_other_worker', 'cli_other_new']);
  }, 10_000);

  it('converts a disabled canary fence to an idempotent durable abandonment tombstone', async () => {
    const f = fixture();
    await installFence(f);
    const fingerprint = fenceFingerprint(f);
    const enabled = await enableFenceConfig(f);
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: enabled.chatId, mode: enabled.mode, coordinatorAppId: enabled.coordinatorAppId,
      workerAppIds: enabled.workerAppIds, autoEnrollWorkers: enabled.autoEnrollWorkers,
      progressCard: enabled.progressCard, taskControlPlane: null,
      taskControlPlaneCas: {
        operation: 'disable', expectedConfigHash: configHash(enabled),
        expectedFenceFingerprint: fingerprint, now: '2026-09-30T01:02:00.000Z',
      },
    });
    const before = readProjectGroup(f.dataDir, f.context.chatId)!;
    const action = {
      action: 'abandon_task_control_canary', fence: f.fence,
      expectedConfigHash: configHash(enabled),
      authorizationRef: 'om_abandon', authorizedByOpenId: 'ou_authorized',
      now: '2026-09-30T01:03:00.000Z',
    } as any;
    const abandoned = await f.coordinator.run(f.context, action);
    expect(abandoned.blockerRecords).not.toContainEqual(
      expect.objectContaining({ code: 'task_control_canary_quarantine' }),
    );
    const tombstone = abandoned.blockerRecords.find(
      record => record.code === 'task_control_canary_abandoned',
    );
    expect(tombstone).toMatchObject({
      blockerId: before.blockerRecords[0]!.blockerId,
      eventId: f.fence.dispatchOperationId,
      taskGuid: f.fence.taskGuid,
    });
    expect(JSON.parse(tombstone!.summary)).toMatchObject({
      schemaVersion: 'TaskControlCanaryAbandoned.v2',
      fenceFingerprint: fingerprint,
      phaseBDispatchRoot: null,
      fingerprint: expect.stringMatching(/^tcca2:[a-f0-9]{64}$/),
      authorizationRef: 'om_abandon',
      authorizedByOpenId: 'ou_authorized',
      fence: expect.objectContaining({ dispatchOperationId: f.fence.dispatchOperationId }),
    });
    const replayed = await f.coordinator.run(f.context, action);
    expect(replayed).toEqual(abandoned);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane).toBeUndefined();
  });

  it('atomically disables an enabled canary and replaces its fence with the abandonment tombstone', async () => {
    const f = fixture();
    await installFence(f);
    const enabled = await enableFenceConfig(f);

    const abandoned = await f.coordinator.run(f.context, {
      action: 'abandon_task_control_canary', fence: f.fence,
      expectedConfigHash: configHash(enabled),
      authorizationRef: 'om_abandon', authorizedByOpenId: 'ou_authorized',
      now: '2026-09-30T01:03:00.000Z',
    } as any);

    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.taskControlPlane).toBeUndefined();
    expect(abandoned.blockerRecords).not.toContainEqual(
      expect.objectContaining({ code: 'task_control_canary_quarantine' }),
    );
    expect(abandoned.blockerRecords).toContainEqual(
      expect.objectContaining({ code: 'task_control_canary_abandoned' }),
    );
  });

  it('persists the exact Phase-B root in the canonical abandonment tombstone', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = await addBoundCanaryWorkstream(f, 'om_durable_abandoned_phase_b_root');

    const abandoned = await abandonFence(f);
    const tombstone = abandoned.blockerRecords.find(
      record => record.code === 'task_control_canary_abandoned',
    );
    expect(JSON.parse(tombstone!.summary)).toMatchObject({
      schemaVersion: 'TaskControlCanaryAbandoned.v2',
      phaseBDispatchRoot: dispatchRoot,
      fingerprint: expect.stringMatching(/^tcca2:[a-f0-9]{64}$/),
    });
    const changed = JSON.parse(tombstone!.summary);
    changed.phaseBDispatchRoot = 'om_tampered_phase_b_root';
    expect(() => projectTaskControlCanaryAbandonmentFromRecord({
      ...tombstone!,
      summary: JSON.stringify(changed),
    })).toThrow('project_task_control_canary_abandonment_conflict');
  });

  it('persists a delivered seed root when the dispatch registry and workstream are not written yet', async () => {
    const f = fixture();
    await installFence(f);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    const dispatchRoot = 'om_seed_only_abandoned_phase_b_root';
    beginTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      targetChatId: f.context.chatId,
      messageType: 'text',
      payloadHash: canarySeedPayloadHash(f),
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z',
        bootId: 'boot-seed-only-abandonment',
        processStartIdentity: 'process-seed-only-abandonment',
        monotonicMs: 1_000,
      },
    });
    completeTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      dispatchRoot,
    });

    const abandoned = await abandonFence(f);
    const tombstone = abandoned.blockerRecords.find(
      record => record.code === 'task_control_canary_abandoned',
    );
    expect(JSON.parse(tombstone!.summary)).toMatchObject({
      schemaVersion: 'TaskControlCanaryAbandoned.v2',
      phaseBDispatchRoot: dispatchRoot,
      fingerprint: expect.stringMatching(/^tcca2:[a-f0-9]{64}$/),
    });
  });

  it('persists an exact kickoff root when the dispatch registry and workstream are not written yet', async () => {
    const f = fixture();
    await installFence(f);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    const dispatchRoot = 'om_kickoff_only_abandoned_phase_b_root';
    beginTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      chatId: f.context.chatId,
      dispatchRoot,
      fenceFingerprint: fenceFingerprint(f),
      targetAppIds: f.fence.targetAppIds,
      messageType: 'post',
      payloadHash: canaryKickoffPayloadHash(f, dispatchRoot),
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z',
        bootId: 'boot-kickoff-only-abandonment',
        processStartIdentity: 'process-kickoff-only-abandonment',
        monotonicMs: 1_000,
      },
    });
    completeTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      messageId: 'om_kickoff_only_abandonment_message',
    });

    const abandoned = await abandonFence(f);
    const tombstone = abandoned.blockerRecords.find(
      record => record.code === 'task_control_canary_abandoned',
    );
    expect(JSON.parse(tombstone!.summary).phaseBDispatchRoot).toBe(dispatchRoot);
  });

  it('persists an exact root-created reservation when later Phase-B stores are not written yet', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = 'om_reservation_only_abandoned_phase_b_root';
    await addBoundCanaryReservation(f, dispatchRoot);

    const abandoned = await abandonFence(f);
    const tombstone = abandoned.blockerRecords.find(
      record => record.code === 'task_control_canary_abandoned',
    );
    expect(JSON.parse(tombstone!.summary).phaseBDispatchRoot).toBe(dispatchRoot);
  });

  it('persists an exact root-created reservation with distinct daemon and report-binding secrets', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = 'om_distinct_secret_reservation_root';
    ensureTaskControlReportBindingSecret(f);
    await addBoundCanaryReservation(f, dispatchRoot);

    const abandoned = await abandonFence(f);
    const tombstone = abandoned.blockerRecords.find(
      record => record.code === 'task_control_canary_abandoned',
    );
    expect(JSON.parse(tombstone!.summary).phaseBDispatchRoot).toBe(dispatchRoot);
  });

  it.each(['pending', 'registered'] as const)(
    'preserves an exact %s workstream with distinct daemon and report-binding secrets',
    async mappingStatus => {
      const f = fixture();
      await installFence(f);
      const dispatchRoot = await addBoundCanaryWorkstream(
        f,
        `om_distinct_secret_${mappingStatus}_workstream_root`,
      );
      ensureTaskControlReportBindingSecret(f);
      if (mappingStatus === 'pending') {
        await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
          const taskControl = current!.workstreams.find(
            item => item.dispatchRoot === dispatchRoot,
          )!.taskControl!;
          taskControl.mappingStatus = 'pending';
          delete taskControl.registeredAt;
          return current;
        });
      }

      const abandoned = await abandonFence(f);
      const tombstone = abandoned.blockerRecords.find(
        record => record.code === 'task_control_canary_abandoned',
      );
      expect(JSON.parse(tombstone!.summary).phaseBDispatchRoot).toBe(dispatchRoot);
    },
  );

  it.each([
    ['missing', (secretPath: string) => rmSync(secretPath)],
    ['empty', (secretPath: string) => writeFileSync(secretPath, '', { mode: 0o600 })],
    ['broad permissions', (secretPath: string) => chmodSync(secretPath, 0o644)],
    ['unreadable permissions', (secretPath: string) => chmodSync(secretPath, 0o000)],
    ['symlink', (secretPath: string) => {
      const targetPath = `${secretPath}.target`;
      writeFileSync(targetPath, TEST_TASK_CONTROL_DAEMON_IPC_SECRET, { mode: 0o600 });
      rmSync(secretPath);
      symlinkSync(targetPath, secretPath);
    }],
  ] as const)(
    'fails closed before tombstone persistence when the daemon IPC secret is %s',
    async (_scenario, breakSecret) => {
      const f = fixture();
      await installFence(f);
      ensureTaskControlReportBindingSecret(f);
      await addBoundCanaryReservation(f, 'om_unsafe_daemon_secret_reservation_root');
      breakSecret(join(dirname(f.dataDir), '.dashboard-secret'));

      await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
      expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
        .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
    },
  );

  it('persists an exact success-certificate root when mutable Phase-B stores are absent', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = 'om_certificate_only_abandoned_phase_b_root';
    persistTaskControlSuccessCertificateSync(join(f.dataDir, 'orchestrate-dispatch.json'), {
      operationId: f.fence.dispatchOperationId,
      chatId: f.context.chatId,
      fenceFingerprint: fenceFingerprint(f),
      dispatchRoot,
      taskGuid: f.fence.taskGuid,
      evidence: exactCanarySuccessEvidence(f, dispatchRoot),
      createdAt: '2026-09-30T01:02:02.000Z',
    });

    const abandoned = await abandonFence(f);
    const tombstone = abandoned.blockerRecords.find(
      record => record.code === 'task_control_canary_abandoned',
    );
    expect(JSON.parse(tombstone!.summary).phaseBDispatchRoot).toBe(dispatchRoot);
  });

  it('fails closed when a delivered seed payload does not match the frozen canary', async () => {
    const f = fixture();
    await installFence(f);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    beginTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      targetChatId: f.fence.targetChatId,
      messageType: 'text',
      payloadHash: '0'.repeat(64),
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z',
        bootId: 'boot-seed-payload-conflict',
        processStartIdentity: 'process-seed-payload-conflict',
        monotonicMs: 1_000,
      },
    });
    completeTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      dispatchRoot: 'om_seed_payload_conflict_root',
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when a delivered kickoff payload does not match the frozen canary', async () => {
    const f = fixture();
    await installFence(f);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    const dispatchRoot = 'om_kickoff_payload_conflict_root';
    beginTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      chatId: f.fence.targetChatId,
      dispatchRoot,
      fenceFingerprint: fenceFingerprint(f),
      targetAppIds: f.fence.targetAppIds,
      messageType: 'post',
      payloadHash: '0'.repeat(64),
      attempt: {
        wallTime: '2026-09-30T01:01:01.000Z',
        bootId: 'boot-kickoff-payload-conflict',
        processStartIdentity: 'process-kickoff-payload-conflict',
        monotonicMs: 1_001,
      },
    });
    completeTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      messageId: 'om_kickoff_payload_conflict_message',
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when delivered seed and kickoff attempt times are reversed', async () => {
    const f = fixture();
    await installFence(f);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    const dispatchRoot = 'om_reversed_seed_kickoff_time_root';
    beginTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      targetChatId: f.fence.targetChatId,
      messageType: 'text',
      payloadHash: canarySeedPayloadHash(f),
      attempt: {
        wallTime: '2026-09-30T01:02:00.000Z',
        bootId: 'boot-reversed-seed-kickoff-time',
        processStartIdentity: 'process-reversed-seed-kickoff-time',
        monotonicMs: 2_000,
      },
    });
    completeTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      dispatchRoot,
    });
    beginTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      chatId: f.fence.targetChatId,
      dispatchRoot,
      fenceFingerprint: fenceFingerprint(f),
      targetAppIds: f.fence.targetAppIds,
      messageType: 'post',
      payloadHash: canaryKickoffPayloadHash(f, dispatchRoot),
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z',
        bootId: 'boot-reversed-seed-kickoff-time',
        processStartIdentity: 'process-reversed-seed-kickoff-time',
        monotonicMs: 1_000,
      },
    });
    completeTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      messageId: 'om_reversed_seed_kickoff_time_message',
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when delivered kickoff targets differ from the frozen canary', async () => {
    const f = fixture();
    await installFence(f);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    const dispatchRoot = 'om_kickoff_targets_conflict_root';
    beginTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      chatId: f.fence.targetChatId,
      dispatchRoot,
      fenceFingerprint: fenceFingerprint(f),
      targetAppIds: [f.fence.workerAppId],
      messageType: 'post',
      payloadHash: canaryKickoffPayloadHash(f, dispatchRoot),
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z',
        bootId: 'boot-kickoff-target-conflict',
        processStartIdentity: 'process-kickoff-target-conflict',
        monotonicMs: 1_000,
      },
    });
    completeTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      messageId: 'om_kickoff_targets_conflict_message',
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when a root-created reservation has an invalid proof', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = 'om_invalid_reservation_proof_root';
    await addBoundCanaryReservation(f, dispatchRoot);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.dispatchReservations![0]!.taskControl!.proof.signature = '0'.repeat(64);
      return current;
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when a registered workstream has an invalid proof and time chain', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = await addBoundCanaryWorkstream(f, 'om_invalid_workstream_proof_root');
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      const workstream = current!.workstreams.find(item => item.dispatchRoot === dispatchRoot)!;
      workstream.taskControl!.reservationProof.signature = '0'.repeat(64);
      workstream.createdAt = '2026-09-30T01:00:59.000Z';
      return current;
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when a success certificate lacks exact success evidence', async () => {
    const f = fixture();
    await installFence(f);
    persistTaskControlSuccessCertificateSync(join(f.dataDir, 'orchestrate-dispatch.json'), {
      operationId: f.fence.dispatchOperationId,
      chatId: f.fence.targetChatId,
      fenceFingerprint: fenceFingerprint(f),
      dispatchRoot: 'om_incomplete_certificate_evidence_root',
      taskGuid: f.fence.taskGuid,
      evidence: { phaseB: { settled: true } },
      createdAt: '2026-09-30T00:59:59.000Z',
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when exact durable Phase-B sources disagree on the root', async () => {
    const f = fixture();
    await installFence(f);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    beginTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      targetChatId: f.context.chatId,
      messageType: 'text',
      payloadHash: canarySeedPayloadHash(f),
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z',
        bootId: 'boot-conflicting-abandonment',
        processStartIdentity: 'process-conflicting-abandonment',
        monotonicMs: 1_000,
      },
    });
    completeTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      dispatchRoot: 'om_seed_conflicting_abandonment_root',
    });
    beginTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      chatId: f.context.chatId,
      dispatchRoot: 'om_kickoff_conflicting_abandonment_root',
      fenceFingerprint: fenceFingerprint(f),
      targetAppIds: f.fence.targetAppIds,
      messageType: 'post',
      payloadHash: canaryKickoffPayloadHash(f, 'om_kickoff_conflicting_abandonment_root'),
      attempt: {
        wallTime: '2026-09-30T01:01:01.000Z',
        bootId: 'boot-conflicting-abandonment',
        processStartIdentity: 'process-conflicting-abandonment',
        monotonicMs: 1_001,
      },
    });
    completeTaskControlKickoffOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      messageId: 'om_kickoff_conflicting_abandonment_message',
    });

    await expect(abandonFence(f))
      .rejects.toThrow('project_task_control_canary_abandonment_phase_b_root_conflict');
  });

  it('fails closed when a seed operation is not in the delivered state', async () => {
    const f = fixture();
    await installFence(f);
    beginTaskControlSeedOperationSync(join(f.dataDir, 'orchestrate-dispatch.json'), {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      targetChatId: f.context.chatId,
      messageType: 'text',
      payloadHash: '5'.repeat(64),
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z',
        bootId: 'boot-pending-seed-abandonment',
        processStartIdentity: 'process-pending-seed-abandonment',
        monotonicMs: 1_000,
      },
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
  });

  it('fails closed when a kickoff operation is not in the delivered state', async () => {
    const f = fixture();
    await installFence(f);
    beginTaskControlKickoffOperationSync(join(f.dataDir, 'orchestrate-dispatch.json'), {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: f.fence.controllerAppId,
      chatId: f.context.chatId,
      dispatchRoot: 'om_pending_kickoff_abandonment_root',
      fenceFingerprint: fenceFingerprint(f),
      targetAppIds: f.fence.targetAppIds,
      messageType: 'post',
      payloadHash: '6'.repeat(64),
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z',
        bootId: 'boot-pending-kickoff-abandonment',
        processStartIdentity: 'process-pending-kickoff-abandonment',
        monotonicMs: 1_000,
      },
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
  });

  it('fails closed when a matching reservation has not durably reached root_created', async () => {
    const f = fixture();
    await installFence(f);
    await addBoundCanaryReservation(f, 'om_reserved_not_rooted', { stage: 'reserved' });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
  });

  it('fails closed when a seed source has a different controller identity', async () => {
    const f = fixture();
    await installFence(f);
    const registryPath = join(f.dataDir, 'orchestrate-dispatch.json');
    beginTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      sourceAppId: 'cli_foreign_controller',
      targetChatId: f.context.chatId,
      messageType: 'text',
      payloadHash: '7'.repeat(64),
      attempt: {
        wallTime: '2026-09-30T01:01:00.000Z',
        bootId: 'boot-foreign-controller-abandonment',
        processStartIdentity: 'process-foreign-controller-abandonment',
        monotonicMs: 1_000,
      },
    });
    completeTaskControlSeedOperationSync(registryPath, {
      operationId: f.fence.dispatchOperationId,
      dispatchRoot: 'om_foreign_controller_abandonment_root',
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
  });

  it('fails closed when a success certificate has a different chat identity', async () => {
    const f = fixture();
    await installFence(f);
    persistTaskControlSuccessCertificateSync(join(f.dataDir, 'orchestrate-dispatch.json'), {
      operationId: f.fence.dispatchOperationId,
      chatId: 'oc_foreign_project',
      fenceFingerprint: fenceFingerprint(f),
      dispatchRoot: 'om_foreign_certificate_abandonment_root',
      taskGuid: f.fence.taskGuid,
      evidence: { phaseB: { settled: true } },
      createdAt: '2026-09-30T01:02:00.000Z',
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
  });

  it('fails closed when a same-task reservation has a different operation identity', async () => {
    const f = fixture();
    await installFence(f);
    await addBoundCanaryReservation(f, 'om_foreign_operation_abandonment_root', {
      reservationId: 'e'.repeat(50),
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
  });

  it('fails closed when a same-task workstream has a foreign Phase-B binding', async () => {
    const f = fixture();
    await installFence(f);
    const foreignRoot = 'om_foreign_workstream_abandonment_root';
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams.push({
        dispatchRoot: foreignRoot,
        title: 'foreign',
        purpose: 'foreign',
        owners: ['Foreign'],
        targetAppIds: ['cli_foreign_worker', 'cli_foreign_reviewer'],
        workerAppIds: ['cli_foreign_worker'],
        reviewerAppIds: ['cli_foreign_reviewer'],
        access: { mode: 'read_only' },
        status: 'pending',
        progress: 0,
        taskControl: {
          taskGuid: f.fence.taskGuid,
          phaseId: `workstream:${f.fence.taskGuid}`,
          mappingRef: `topic-message:${foreignRoot}`,
          mappingStatus: 'registered',
          sourceKind: 'project_group',
          controllerAppId: 'cli_foreign_controller',
          workerAppId: 'cli_foreign_worker',
          reviewerAppId: 'cli_foreign_reviewer',
          acceptorAppId: 'cli_foreign_acceptor',
          projectRevision: current!.revision,
          reservationId: 'e'.repeat(50),
          coordinatorSessionId: 'session_foreign',
          originTurnId: 'om_foreign_origin',
          reservationCreatedAt: '2026-09-30T01:01:00.000Z',
          reservationExpiresAt: '2026-09-30T02:01:00.000Z',
          rootCreateTime: '2026-09-30T01:01:01.000Z',
          reservationProof: {
            schemaVersion: 'ProjectDispatchReservationProof.v1',
            larkAppId: 'cli_foreign_controller',
            issuedAt: '2026-09-30T01:01:00.000Z',
            keyId: 'tcpr1:foreign',
            signature: 'a'.repeat(64),
          },
        },
        createdAt: '2026-09-30T01:01:01.000Z',
        updatedAt: '2026-09-30T01:01:01.000Z',
      } as any);
      return current;
    });

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
  });

  it('fails closed when a same-operation registry entry has a foreign Phase-B binding', async () => {
    const f = fixture();
    await installFence(f);
    await recordDispatchRegistryEntry(
      join(f.dataDir, 'orchestrate-dispatch.json'),
      'om_foreign_registry_abandonment_root',
      {
        dispatchOperationId: f.fence.dispatchOperationId,
        orchChatId: 'oc_foreign',
        orchAppId: 'cli_foreign_controller',
        orchSessionId: 'session_foreign',
        targetChatId: 'oc_foreign',
        targetAppIds: ['cli_foreign_worker'],
        workerAppIds: ['cli_foreign_worker'],
        reviewerAppIds: ['cli_foreign_reviewer'],
        access: { mode: 'read_only' },
        taskControl: {
          mode: 'audit_only',
          taskGuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          phaseId: 'workstream:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          controllerAppId: 'cli_foreign_controller',
          workerAppId: 'cli_foreign_worker',
          reviewerAppId: 'cli_foreign_reviewer',
          acceptorAppId: 'cli_foreign_acceptor',
        },
      },
    );

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
  });

  it('fails closed when an exact-operation registry entry has foreign dispatch metadata', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = 'om_foreign_registry_metadata_abandonment_root';
    const entry = exactCanaryRegistryEntry(f, dispatchRoot);
    entry.title = 'foreign title';
    entry.purpose = 'foreign purpose';
    entry.owners = ['Foreign Owner'];
    entry.bots = ['ou_foreign_worker', 'ou_foreign_reviewer'];
    entry.reportBinding = createDispatchReportBinding('registry-binding-test-secret', {
      dispatchRoot,
      targetLarkAppId: 'cli_foreign_controller',
      targetSessionId: 'session_foreign',
      targetChatId: 'oc_foreign',
      targetScope: 'thread',
      sourceName: 'foreign title',
      issuedAt: '2026-09-30T01:01:01.000Z',
    });
    await recordDispatchRegistryEntry(
      join(f.dataDir, 'orchestrate-dispatch.json'),
      dispatchRoot,
      entry,
    );

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when an exact registry report binding has a wrong HMAC', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = 'om_wrong_registry_hmac_abandonment_root';
    const entry = exactCanaryRegistryEntry(f, dispatchRoot);
    entry.reportBinding = createDispatchReportBinding('registry-binding-wrong-secret', {
      dispatchRoot,
      targetLarkAppId: f.fence.controllerAppId,
      targetSessionId: f.fence.coordinatorSessionId,
      targetChatId: f.fence.targetChatId,
      targetScope: 'chat',
      sourceName: f.fence.title,
      issuedAt: '2026-09-30T01:01:01.000Z',
    });
    await recordDispatchRegistryEntry(
      join(f.dataDir, 'orchestrate-dispatch.json'),
      dispatchRoot,
      entry,
    );

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when a valid registry report binding has no canary-authoritative root proof', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = 'om_registry_only_foreign_binding_root';
    await recordDispatchRegistryEntry(
      join(f.dataDir, 'orchestrate-dispatch.json'),
      dispatchRoot,
      exactCanaryRegistryEntry(f, dispatchRoot),
    );

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed before comparing multiple registry-only report-binding roots', async () => {
    const f = fixture();
    await installFence(f);
    const firstRoot = 'om_first_registry_only_foreign_binding_root';
    const secondRoot = 'om_second_registry_only_foreign_binding_root';
    await recordDispatchRegistryEntry(
      join(f.dataDir, 'orchestrate-dispatch.json'),
      firstRoot,
      exactCanaryRegistryEntry(f, firstRoot),
    );
    await recordDispatchRegistryEntry(
      join(f.dataDir, 'orchestrate-dispatch.json'),
      secondRoot,
      exactCanaryRegistryEntry(f, secondRoot),
    );

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when the registry report-binding secret is missing', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = 'om_missing_registry_binding_secret_root';
    const entry = exactCanaryRegistryEntry(f, dispatchRoot);
    rmSync(dispatchReportBindingSecretPath(f.dataDir));
    await recordDispatchRegistryEntry(
      join(f.dataDir, 'orchestrate-dispatch.json'),
      dispatchRoot,
      entry,
    );

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('fails closed when the registry report-binding secret cannot be read safely', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = 'om_unreadable_registry_binding_secret_root';
    const entry = exactCanaryRegistryEntry(f, dispatchRoot);
    const secretPath = dispatchReportBindingSecretPath(f.dataDir);
    rmSync(secretPath);
    mkdirSync(secretPath);
    await recordDispatchRegistryEntry(
      join(f.dataDir, 'orchestrate-dispatch.json'),
      dispatchRoot,
      entry,
    );

    await expect(abandonFence(f)).rejects.toThrow('project_task_control_canary_fence_conflict');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockerRecords)
      .not.toContainEqual(expect.objectContaining({ code: 'task_control_canary_abandoned' }));
  });

  it('preserves an exact bound workstream root while mapping registration is pending', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = await addBoundCanaryWorkstream(
      f,
      'om_pending_mapping_abandonment_root',
    );
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      current!.workstreams.find(item => item.dispatchRoot === dispatchRoot)!
        .taskControl!.mappingStatus = 'pending';
      delete current!.workstreams.find(item => item.dispatchRoot === dispatchRoot)!
        .taskControl!.registeredAt;
      return current;
    });

    const abandoned = await abandonFence(f);
    const tombstone = abandoned.blockerRecords.find(
      record => record.code === 'task_control_canary_abandoned',
    );
    expect(JSON.parse(tombstone!.summary).phaseBDispatchRoot).toBe(dispatchRoot);
  });

  it('deduplicates the same root from exact registry and workstream bindings', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = await addBoundCanaryWorkstream(
      f,
      'om_exact_registry_workstream_abandonment_root',
    );
    await recordDispatchRegistryEntry(
      join(f.dataDir, 'orchestrate-dispatch.json'),
      dispatchRoot,
      exactCanaryRegistryEntry(f, dispatchRoot),
    );

    const abandoned = await abandonFence(f);
    const tombstone = abandoned.blockerRecords.find(
      record => record.code === 'task_control_canary_abandoned',
    );
    expect(JSON.parse(tombstone!.summary).phaseBDispatchRoot).toBe(dispatchRoot);
  });

  it('serializes a mapped report mutation with the chat-scoped abandonment lock', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = await addBoundCanaryWorkstream(f, 'om_locked_report');
    const lockReady = join(f.dataDir, 'outer-lock-ready');
    const releaseLock = join(f.dataDir, 'outer-lock-release');
    const child = collectChild(spawnTsEvalWithRepoImports(`
      import { existsSync, writeFileSync } from 'node:fs';
      import { withProjectTaskControlChatLockSync } from './src/services/project-group-store.js';
      withProjectTaskControlChatLockSync(${JSON.stringify(f.dataDir)}, ${JSON.stringify(f.context.chatId)}, () => {
        writeFileSync(${JSON.stringify(lockReady)}, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(${JSON.stringify(releaseLock)})) Atomics.wait(wait, 0, 0, 10);
      });
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }));
    await vi.waitFor(() => expect(existsSync(lockReady)).toBe(true));

    let settled = false;
    const report = f.coordinator.runReport(f.context, {
      action: 'report', dispatchRoot, reporterAppId: f.fence.workerAppId,
      status: 'completed', content: 'must wait for the outer lock',
    }).then(value => {
      settled = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const settledWhileLocked = settled;
    writeFileSync(releaseLock, 'release');
    const childResult = await child;
    expect(childResult.code, childResult.stderr).toBe(0);
    await report;
    expect(settledWhileLocked).toBe(false);
  }, 10_000);

  it('rejects every future audit-only reservation after abandonment but allows unrelated project updates', async () => {
    const f = fixture();
    await installFence(f);
    await abandonFence(f);

    await expect(f.coordinator.run(f.context, {
      action: 'reserve_dispatch', reservationId: 'a'.repeat(50),
      targetAppIds: [f.fence.workerAppId, f.fence.reviewerAppId],
      access: { mode: 'write', scopes: f.fence.writeScopes },
      now: '2026-09-30T01:04:00.000Z', maxActiveTaskControlMappings: 1,
      getTaskControlMappingDecision: () => ({ capacityReleased: false, admissionSafe: false }),
      taskControl: {
        mode: 'audit_only', taskGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        phaseId: 'workstream:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        workerAppId: f.fence.workerAppId, reviewerAppId: f.fence.reviewerAppId,
        acceptorAppId: f.fence.acceptorAppId, originTurnId: 'om_new_canary',
        proof: {
          schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: f.context.larkAppId,
          issuedAt: '2026-09-30T01:04:00.000Z', keyId: 'tcpr1:new', signature: 'b'.repeat(64),
        },
      },
    } as any)).rejects.toThrow('project_task_control_canary_abandoned');

    const updated = await f.coordinator.run(f.context, {
      action: 'update', phase: 'unrelated ordinary work',
    });
    expect(updated.phase).toBe('unrelated ordinary work');
  });

  it('rejects a triggering ingress on a canary root after abandonment', async () => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = await addBoundCanaryWorkstream(f);
    await abandonFence(f);

    await expect(f.coordinator.run(f.context, {
      action: 'claim_task_control_turn_admission',
      claim: {
        messageId: 'om_late_kickoff', dispatchRoot, targetAppId: f.fence.workerAppId,
        sessionId: 'session_late_worker', workerGeneration: 3,
      },
      now: '2026-09-30T01:04:00.000Z',
    })).rejects.toThrow('project_task_control_canary_abandoned');
  });

  it.each([
    ['worker report', {
      reporter: 'worker' as const, action: { status: 'completed' as const, content: 'late delivery' },
    }],
    ['reviewer verdict', {
      reporter: 'reviewer' as const,
      action: { reviewVerdict: 'pass' as const, reviewRound: 1, content: 'late review' },
    }],
  ])('rejects a late bound %s after abandonment', async (_label, scenario) => {
    const f = fixture();
    await installFence(f);
    const dispatchRoot = await addBoundCanaryWorkstream(f);
    await abandonFence(f);
    const reporterAppId = scenario.reporter === 'worker'
      ? f.fence.workerAppId
      : f.fence.reviewerAppId;

    await expect(f.coordinator.run(f.context, {
      action: 'report', dispatchRoot, reporterAppId, ...scenario.action,
    })).rejects.toThrow('project_task_control_canary_abandoned');
  });

  it('requires an exact canonical tombstone before a newly authorized fence can replace it', async () => {
    const f = fixture();
    await installFence(f);
    await abandonFence(f);
    await mutateProjectGroup(f.dataDir, f.context.chatId, current => {
      const tombstone = current!.blockerRecords.find(
        record => record.code === 'task_control_canary_abandoned',
      )!;
      const parsed = JSON.parse(tombstone.summary);
      tombstone.summary = JSON.stringify({ ...parsed, fenceFingerprint: `tccq1:${'0'.repeat(64)}` });
      return current;
    });
    const replacement = {
      ...f.fence,
      dispatchOperationId: 'b'.repeat(50), taskGuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      originTurnId: 'om_replacement', authorizationRef: 'om_replacement',
    };

    await expect(f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence: replacement,
      now: '2026-09-30T01:05:00.000Z',
    } as any)).rejects.toThrow('project_task_control_canary_abandonment_conflict');
  });

  it('atomically replaces an exact canonical tombstone with a newly authorized fence', async () => {
    const f = fixture();
    await installFence(f);
    await abandonFence(f);
    const replacement = {
      ...f.fence,
      dispatchOperationId: 'b'.repeat(50), taskGuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      originTurnId: 'om_replacement', authorizationRef: 'om_replacement',
    };

    const replaced = await f.coordinator.run(f.context, {
      action: 'install_task_control_canary_fence', fence: replacement,
      now: '2026-09-30T01:05:00.000Z',
    } as any);

    expect(replaced.blockerRecords.filter(
      record => record.code === 'task_control_canary_quarantine',
    )).toHaveLength(1);
    expect(replaced.blockerRecords).not.toContainEqual(
      expect.objectContaining({ code: 'task_control_canary_abandoned' }),
    );
  });
});
