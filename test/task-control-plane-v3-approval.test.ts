import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';
import { DaemonTaskControlIntegration } from '../src/services/task-control-plane-daemon-integration.js';
import { startTaskControlPlaneRuntime } from '../src/services/task-control-plane-runtime.js';
import { createV3TaskControlApprovalSource } from '../src/services/task-control-plane-v3-approval.js';
import { resolveWait, writePendingWait } from '../src/workflows/v3/gate-wait-store.js';
import { normalizeGateWaitInput } from '../src/workflows/v3/gate-policy.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import {
  artifactRef,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';

const WRITE = {
  grantRef: 'grant:write-1',
  projectId: 'project-1',
  phaseId: 'phase-1',
  taskGuid: 'task-1',
  candidate: 'candidate-c8',
  action: 'git.commit',
  attempt: 2,
  operatorId: 'acceptor-1',
};
const RUN_ID = 'task-control-write-run';
const NODE_ID = 'write-gate';
const INSTANCE_ID = 'write-gate#001';
const WAIT_ID = 'write-gate#001-gate';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function seedApprovedWriteGate(baseDir: string): number {
  const runDir = join(baseDir, RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const humanGate = {
    prompt: 'Approve the exact write?',
    approvers: [WRITE.operatorId],
    writeExecution: WRITE,
  };
  writeJson(join(runDir, 'dag.json'), {
    runId: RUN_ID,
    nodes: [{
      id: NODE_ID,
      type: 'goal',
      goal: 'authorize one exact control-plane write',
      depends: [],
      inputs: [],
      humanGate,
    }],
  });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1,
    runId: RUN_ID,
    title: 'write authorization',
    requirement: 'approve one exact write',
    nodes: [{
      sketchId: NODE_ID,
      goal: 'authorize one exact control-plane write',
      input_needs: [],
      expected_outputs: ['authorization'],
      acceptance: 'exact binding approved',
      risk_gate: true,
      unknowns: [],
    }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), {});
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId: RUN_ID,
    createdAt: '2026-09-05T00:00:00.000Z',
    authorizedAt: '2026-09-05T00:01:00.000Z',
    authorizedByOpenId: WRITE.operatorId,
    chatBinding: {
      larkAppId: 'app-1',
      chatId: 'oc_project',
      rootMessageId: 'om_root',
      ownerOpenId: WRITE.operatorId,
    },
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  }));

  writePendingWait(runDir, {
    waitId: WAIT_ID,
    nodeId: NODE_ID,
    instanceId: INSTANCE_ID,
    ...normalizeGateWaitInput(humanGate),
  });
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId: RUN_ID });
  appendEvent(join(runDir, 'journal.ndjson'), {
    type: 'gateDispatched',
    nodeId: NODE_ID,
    instanceId: INSTANCE_ID,
    waitId: WAIT_ID,
    writeExecution: WRITE,
  });
  const resolved = resolveWait(runDir, WAIT_ID, 'approved', WRITE.operatorId, 'approve');
  appendEvent(join(runDir, 'journal.ndjson'), {
    type: 'gateResolved',
    nodeId: NODE_ID,
    instanceId: INSTANCE_ID,
    waitId: WAIT_ID,
    resolution: 'approved',
    by: WRITE.operatorId,
    selected: 'approve',
    writeExecution: WRITE,
  });
  return resolved.resolvedAt!;
}

function mapping() {
  return {
    projectId: WRITE.projectId,
    phaseId: WRITE.phaseId,
    phaseTaskGuids: [WRITE.taskGuid],
    taskGuid: WRITE.taskGuid,
    topicRootId: 'om_root',
    ownerId: 'worker-1',
    reviewerId: 'reviewer-1',
    acceptorId: WRITE.operatorId,
    registrationRef: 'task-comment:123',
    approvalGate: {
      runId: RUN_ID,
      nodeId: NODE_ID,
      instanceId: INSTANCE_ID,
      waitId: WAIT_ID,
      operatorId: WRITE.operatorId,
      approverPolicy: [WRITE.operatorId],
    },
  };
}

describe('v3 production task-control approval source', () => {
  it('mints and consumes one exact write grant through the real constructor', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'botmux-v3-write-source-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-v3-write-ledger-'));
    try {
      seedApprovedWriteGate(baseDir);
      const source = createV3TaskControlApprovalSource({ baseDir });
      const bridge = new DaemonTaskControlBridge({ approvals: source, larkAppId: 'app-1' });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir,
        larkAppId: 'app-1',
        flags: { ledgerEnabled: true },
        authority: bridge.authority,
        logger: { warn: () => {} },
      });
      try {
        const integration = new DaemonTaskControlIntegration({
          dataDir,
          larkAppId: 'app-1',
          lifecycle,
          store: lifecycle.getStore()!,
          bridge,
          logger: { warn: () => {} },
        });
        expect(integration.registerMapping('om_root', mapping(), 'controller-1')).toBe(true);
        const input = { dispatchRoot: 'om_root', ...WRITE };
        expect(integration.consumeWriteExecutionGrant(input)).toEqual({ ok: true });
        expect(integration.consumeWriteExecutionGrant(input)).toEqual({
          ok: false,
          reason: 'task_control_write_execution_grant_unavailable',
        });
        expect(integration.consumeWriteExecutionGrant({ ...input, candidate: 'candidate-drift' })).toEqual({
          ok: false,
          reason: 'write_execution_grant_unproven',
        });
      } finally {
        await lifecycle.close();
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the durable gate evidence drifts or expires', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'botmux-v3-write-source-reject-'));
    try {
      const resolvedAt = seedApprovedWriteGate(baseDir);
      const exact = { ...WRITE, larkAppId: 'app-1', gate: { ...mapping().approvalGate, approvalRef: 'approval:gate-test' } };
      const source = createV3TaskControlApprovalSource({ baseDir, now: () => resolvedAt + 60_000 });
      expect(source.get({
        approvalRef: exact.gate.approvalRef,
        larkAppId: exact.larkAppId,
        gate: exact.gate,
      })).toBeUndefined();
      expect(source.getWriteExecution!(exact)).toEqual({
        issuedAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(source.getWriteExecution!({ ...exact, action: 'git.push' })).toBeUndefined();
      expect(source.getWriteExecution!({ ...exact, attempt: 3 })).toBeUndefined();
      expect(source.getWriteExecution!({ ...exact, operatorId: 'other-acceptor' })).toBeUndefined();
      expect(createV3TaskControlApprovalSource({
        baseDir,
        now: () => resolvedAt + 15 * 60 * 1_000,
      }).getWriteExecution!(exact)).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
