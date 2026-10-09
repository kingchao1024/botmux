import { describe, expect, it } from 'vitest';
import {
  resolveProjectGroupMappingFacts,
  projectGroupRootSnapshotFromLarkDetail,
  projectGroupTaskGuid,
  type ProjectGroupMappingSourceInput,
} from '../src/services/task-control-plane-project-group-mapping-source.js';

const controllerAppId = 'cli_aac926f0eb795bc1';
const workerAppId = 'cli_aa1e53f7aaf81bc6';
const reviewerAppId = 'cli_aa1e4c5508f8dbd3';
const acceptorAppId = 'cli_aa24868c4c78dbc1';
const chatId = 'oc_82e925a0a305e884ca7cdf5a66804463';
const taskGuid = '11111111-1111-4111-8111-111111111111';
const phaseId = `workstream:${taskGuid}`;

function fixture(): ProjectGroupMappingSourceInput {
  const reservationFacts = {
    schemaVersion: 'ProjectDispatchReservation.v1' as const,
    larkAppId: controllerAppId,
    chatId,
    coordinatorSessionId: 'session-controller',
    originTurnId: 'turn-1',
    reservationId: 'reservation-1',
    taskGuid,
    phaseId,
    workerAppId,
    reviewerAppId,
    acceptorAppId,
    access: { mode: 'write' as const, scopes: ['/data00/home/root/workspaces/botmux-upstream/src/services'] },
    createdAt: '2026-09-29T00:00:00.000Z',
    expiresAt: '2026-09-29T01:00:00.000Z',
    dispatch: {
      seedText: 'seed', title: '任务', purpose: '验证', owners: [], botOpenIds: [], acceptanceRequested: true,
    },
  };
  return {
    selfLarkAppId: controllerAppId,
    controllerBotOpenId: 'ou_controller',
    now: '2026-09-29T00:30:00.000Z',
    liveSession: {
      larkAppId: controllerAppId,
      chatId,
      sessionId: 'session-controller',
      workerGeneration: 7,
      turnCapability: 'capability-1',
    },
    project: {
      chatId,
      larkAppId: controllerAppId,
      coordinatorSessionId: 'session-controller',
      revision: 12,
    },
    reservation: {
      ...reservationFacts,
      taskControlMode: 'audit_only',
      stage: 'root_created',
      targetAppIds: [reviewerAppId, workerAppId],
      dispatchRoot: 'om_project_root',
      rootCreateTime: '2026-09-29T00:05:00.000Z',
      proof: {
        schemaVersion: 'ProjectDispatchReservationProof.v1',
        larkAppId: controllerAppId,
        issuedAt: '2026-09-29T00:00:00.000Z',
        keyId: 'tcpr1:test-key',
        signature: JSON.stringify(reservationFacts),
      },
    },
    root: {
      messageId: 'om_project_root',
      chatId,
      senderId: 'ou_controller',
      createTime: '2026-09-29T00:05:00.000Z',
    },
    allowedWorkerAppIds: [workerAppId, reviewerAppId, acceptorAppId],
    verifyReservationProof: (facts, proof) => proof.signature === JSON.stringify(facts),
  };
}

describe('ProjectGroupMappingSource', () => {
  it('derives one stable UUID from the controller, chat, and reservation', () => {
    const first = projectGroupTaskGuid({ larkAppId: controllerAppId, chatId, reservationId: 'reservation-1' });
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(projectGroupTaskGuid({ larkAppId: controllerAppId, chatId, reservationId: 'reservation-1' })).toBe(first);
    expect(projectGroupTaskGuid({ larkAppId: controllerAppId, chatId, reservationId: 'reservation-2' })).not.toBe(first);
  });

  it('extracts only one exact Lark root message', () => {
    expect(projectGroupRootSnapshotFromLarkDetail({
      items: [{
        message_id: 'om_project_root', root_id: '', chat_id: chatId,
        create_time: '1790640300000', sender: { id: 'ou_controller' },
      }],
    })).toEqual({
      messageId: 'om_project_root', rootId: undefined, chatId,
      senderId: 'ou_controller', createTime: '2026-09-29T00:05:00.000Z',
    });
    expect(projectGroupRootSnapshotFromLarkDetail({ items: [] })).toBeUndefined();
    expect(projectGroupRootSnapshotFromLarkDetail({ items: [{ message_id: 'om_a' }, { message_id: 'om_b' }] })).toBeUndefined();
  });

  it('uses open_bot_id for a Lark app sender instead of its app_id', () => {
    expect(projectGroupRootSnapshotFromLarkDetail({
      items: [{
        message_id: 'om_project_root', root_id: '', chat_id: chatId,
        create_time: '1790640300000',
        sender: {
          sender_type: 'app', id_type: 'app_id', id: controllerAppId, open_bot_id: 'ou_controller',
        },
      }],
    })).toEqual({
      messageId: 'om_project_root', rootId: undefined, chatId,
      senderId: 'ou_controller', createTime: '2026-09-29T00:05:00.000Z',
    });
  });

  it('returns canonical project-group facts only from an authenticated reserved root', () => {
    const result = resolveProjectGroupMappingFacts(fixture());

    expect(result).toEqual({
      ok: true,
      facts: {
        schemaVersion: 'ProjectGroupMappingRegistration.v1',
        sourceKind: 'project_group',
        larkAppId: controllerAppId,
        chatId,
        coordinatorSessionId: 'session-controller',
        projectRevision: 12,
        reservationId: 'reservation-1',
        reservationProofKeyId: expect.stringMatching(/^tcpr1:/),
        dispatchRoot: 'om_project_root',
        taskGuid,
        projectId: `project-group:${chatId}`,
        phaseId,
        controllerAppId,
        workerAppId,
        reviewerAppId,
        acceptorAppId,
        access: { mode: 'write', scopes: ['/data00/home/root/workspaces/botmux-upstream/src/services'] },
        rootCreateTime: '2026-09-29T00:05:00.000Z',
      },
    });
  });

  it.each([
    ['stale session', (input: ProjectGroupMappingSourceInput) => { input.liveSession.sessionId = 'stale'; }, 'coordinator_session_mismatch'],
    ['cross-chat root', (input: ProjectGroupMappingSourceInput) => { input.root.chatId = 'oc_other'; }, 'root_chat_mismatch'],
    ['role overlap', (input: ProjectGroupMappingSourceInput) => { input.reservation.reviewerAppId = workerAppId; }, 'role_overlap'],
    ['read-only scope', (input: ProjectGroupMappingSourceInput) => { input.reservation.access = { mode: 'read_only' }; }, 'write_scope_required'],
    ['expired reservation', (input: ProjectGroupMappingSourceInput) => { input.now = '2026-09-29T01:00:00.001Z'; }, 'reservation_expired'],
    ['untrusted worker', (input: ProjectGroupMappingSourceInput) => { input.allowedWorkerAppIds = [reviewerAppId, acceptorAppId]; }, 'role_not_allowlisted'],
    ['root mismatch', (input: ProjectGroupMappingSourceInput) => { input.root.messageId = 'om_other'; }, 'root_message_mismatch'],
    ['root sender mismatch', (input: ProjectGroupMappingSourceInput) => { input.root.senderId = 'ou_other'; }, 'root_sender_mismatch'],
  ])('fails closed for %s', (_name, mutate, error) => {
    const input = fixture();
    mutate(input);
    expect(resolveProjectGroupMappingFacts(input)).toEqual({ ok: false, error });
  });

  it('rejects reservation field drift against the host proof', () => {
    const input = fixture();
    input.reservation.taskGuid = '22222222-2222-4222-8222-222222222222';
    input.reservation.phaseId = `workstream:${input.reservation.taskGuid}`;

    expect(resolveProjectGroupMappingFacts(input)).toEqual({ ok: false, error: 'reservation_proof_invalid' });
  });

  it('binds the recoverable seed text and dispatch metadata into the reservation proof', () => {
    const input = fixture();
    input.reservation.dispatch.seedText = 'tampered seed';
    expect(resolveProjectGroupMappingFacts(input)).toEqual({ ok: false, error: 'reservation_proof_invalid' });
  });

  it('allows a new authenticated coordinator session to recover an already persisted root', () => {
    const input = fixture();
    input.liveSession.sessionId = 'session-after-restart';
    input.project.coordinatorSessionId = 'session-after-restart';
    input.liveSession.workerGeneration = 0;
    input.liveSession.turnCapability = '';
    input.recovery = true;

    expect(resolveProjectGroupMappingFacts(input)).toMatchObject({
      ok: true,
      facts: { coordinatorSessionId: 'session-controller' },
    });
  });

  it('does not accept caller text as an identity source', () => {
    const input = fixture() as ProjectGroupMappingSourceInput & { title: string; report: string; actorId: string };
    input.title = acceptorAppId;
    input.report = 'PASS completed';
    input.actorId = workerAppId;

    expect(resolveProjectGroupMappingFacts(input)).toMatchObject({ ok: true });
  });
});
