import { describe, expect, it } from 'vitest';
import {
  TaskControlMappingTrust,
  createTaskControlProductionMappingVerifier,
  taskControlMappingFacts,
} from '../src/services/task-control-plane-mapping-trust.js';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';
import type { ProjectDispatchReservationFactsV1 } from '../src/services/task-control-plane-project-group-mapping-source.js';

const APP = 'app-production';
const HOST_SECRET = 'host-only-task-control-test-secret';

function approvalGate() {
  return { approvalRef: 'approval:gate-1', runId: 'run-1', nodeId: 'gate', instanceId: 'gate#1', waitId: 'wait-1', operatorId: 'acceptor', approverPolicy: ['acceptor'] };
}

function mapping(taskGuid: string, topicRootId: string, registrationRef: string) {
  return {
    controllerId: APP, projectId: 'project', phaseId: 'phase', phaseTaskGuids: ['task-a', 'task-b'], taskGuid, topicRootId,
    ownerId: `worker-${taskGuid}`, reviewerId: `reviewer-${taskGuid}`, acceptorId: 'acceptor', registrationRef, approvalGate: approvalGate(), docToken: 'doc-token-12345678',
  };
}

function source() {
  return { validateBinding: () => true, get: () => undefined };
}

describe('task control production mapping trust', () => {
  it('signs project dispatch reservations in an independent app-scoped domain', () => {
    const facts: ProjectDispatchReservationFactsV1 = {
      schemaVersion: 'ProjectDispatchReservation.v1',
      larkAppId: APP,
      chatId: 'oc_project_chat',
      coordinatorSessionId: 'session-controller',
      originTurnId: 'turn-1',
      reservationId: 'reservation-1',
      taskGuid: '11111111-1111-4111-8111-111111111111',
      phaseId: 'workstream:11111111-1111-4111-8111-111111111111',
      workerAppId: 'cli_worker_1234567890123456',
      reviewerAppId: 'cli_review_1234567890123456',
      acceptorAppId: 'cli_accept_1234567890123456',
      access: { mode: 'write', scopes: ['/repo/src'] },
      createdAt: '2026-09-29T00:00:00.000Z',
      expiresAt: '2026-09-29T01:00:00.000Z',
      dispatch: { seedText: 'seed', title: '任务', purpose: '验证', owners: [], botOpenIds: [], acceptanceRequested: true },
    };
    const trust = new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: APP });
    const proof = trust.issueProjectDispatchReservation(facts, facts.createdAt);

    expect(trust.verifyProjectDispatchReservation(proof, structuredClone(facts))).toBe(true);
    expect(proof).toMatchObject({
      schemaVersion: 'ProjectDispatchReservationProof.v1',
      larkAppId: APP,
      issuedAt: facts.createdAt,
      keyId: expect.stringMatching(/^tcpr1:/),
    });
    expect(trust.verifyMapping(proof as never, facts as never)).toBe(false);
    expect(trust.verifyProjectDispatchReservation(proof, { ...facts, taskGuid: '22222222-2222-4222-8222-222222222222' })).toBe(false);
    expect(new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: 'app-other' })
      .verifyProjectDispatchReservation(proof, facts)).toBe(false);
  });

  it('applies allow and revoke sets to project dispatch reservation keys', () => {
    const facts: ProjectDispatchReservationFactsV1 = {
      schemaVersion: 'ProjectDispatchReservation.v1', larkAppId: APP, chatId: 'oc_project_chat',
      coordinatorSessionId: 'session-controller', originTurnId: 'turn-1', reservationId: 'reservation-1',
      taskGuid: '11111111-1111-4111-8111-111111111111',
      phaseId: 'workstream:11111111-1111-4111-8111-111111111111',
      workerAppId: 'cli_worker_1234567890123456', reviewerAppId: 'cli_review_1234567890123456',
      acceptorAppId: 'cli_accept_1234567890123456', access: { mode: 'write', scopes: ['/repo/src'] },
      createdAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-09-29T01:00:00.000Z',
      dispatch: { seedText: 'seed', title: '任务', purpose: '验证', owners: [], botOpenIds: [], acceptanceRequested: true },
    };
    const overlap = new TaskControlMappingTrust({
      hostSecret: 'current-secret', previousHostSecret: 'previous-secret', larkAppId: APP,
    });
    const previous = new TaskControlMappingTrust({ hostSecret: 'previous-secret', larkAppId: APP });
    const proof = previous.issueProjectDispatchReservation(facts, facts.createdAt);
    expect(overlap.verifyProjectDispatchReservation(proof, facts, {
      allowedKeyIds: [overlap.projectDispatchReservationKeyId, overlap.previousProjectDispatchReservationKeyId!],
    })).toBe(true);
    expect(overlap.verifyProjectDispatchReservation(proof, facts, {
      allowedKeyIds: [overlap.projectDispatchReservationKeyId, overlap.previousProjectDispatchReservationKeyId!],
      revokedKeyIds: [overlap.previousProjectDispatchReservationKeyId!],
    })).toBe(false);
  });

  it('applies allow and revoke sets to project dispatch reservation keys', () => {
    const facts: ProjectDispatchReservationFactsV1 = {
      schemaVersion: 'ProjectDispatchReservation.v1', larkAppId: APP, chatId: 'oc_project_chat',
      coordinatorSessionId: 'session-controller', originTurnId: 'turn-1', reservationId: 'reservation-1',
      taskGuid: '11111111-1111-4111-8111-111111111111',
      phaseId: 'workstream:11111111-1111-4111-8111-111111111111',
      workerAppId: 'cli_worker_1234567890123456', reviewerAppId: 'cli_review_1234567890123456',
      acceptorAppId: 'cli_accept_1234567890123456', access: { mode: 'write', scopes: ['/repo/src'] },
      createdAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-09-29T01:00:00.000Z',
      dispatch: { seedText: 'seed', title: '任务', purpose: '验证', owners: [], botOpenIds: [], acceptanceRequested: true },
    };
    const overlap = new TaskControlMappingTrust({
      hostSecret: 'current-secret', previousHostSecret: 'previous-secret', larkAppId: APP,
    });
    const previous = new TaskControlMappingTrust({ hostSecret: 'previous-secret', larkAppId: APP });
    const proof = previous.issueProjectDispatchReservation(facts, facts.createdAt);
    expect(overlap.verifyProjectDispatchReservation(proof, facts, {
      allowedKeyIds: [overlap.projectDispatchReservationKeyId, overlap.previousProjectDispatchReservationKeyId!],
    })).toBe(true);
    expect(overlap.verifyProjectDispatchReservation(proof, facts, {
      allowedKeyIds: [overlap.projectDispatchReservationKeyId, overlap.previousProjectDispatchReservationKeyId!],
      revokedKeyIds: [overlap.previousProjectDispatchReservationKeyId!],
    })).toBe(false);
  });

  it('signs exact two-task mappings with purpose/app domain separation and key allow/revoke fail-close', () => {
    const trust = new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: APP });
    const first = mapping('task-a', 'om_a', 'task-comment:101');
    const proof = trust.issueMapping(taskControlMappingFacts({ ...first, dispatchRoot: 'om_a' }));
    const verifier = createTaskControlProductionMappingVerifier({ trust, allowedKeyIds: [trust.mappingKeyId] });
    expect(verifier.verifyMapping(proof, taskControlMappingFacts({ ...first, dispatchRoot: 'om_a' }))).toBe(true);
    expect(verifier.verifyMapping(proof, taskControlMappingFacts({ ...first, dispatchRoot: 'om_a', taskGuid: 'task-b' }))).toBe(false);
    expect(createTaskControlProductionMappingVerifier({ trust, revokedKeyIds: [trust.mappingKeyId] })
      .verifyMapping(proof, taskControlMappingFacts({ ...first, dispatchRoot: 'om_a' }))).toBe(false);
  });

  it('requires two signed mappings in one exact task-set and isolates app mappings', () => {
    const trust = new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: APP });
    const bridge = new DaemonTaskControlBridge({
      larkAppId: APP, approvals: source(), productionMapping: createTaskControlProductionMappingVerifier({ trust }),
    });
    const first = mapping('task-a', 'om_a', 'task-comment:101');
    const second = mapping('task-b', 'om_b', 'task-comment:102');
    first.mappingProof = trust.issueMapping(taskControlMappingFacts({ ...first, dispatchRoot: 'om_a' }));
    second.mappingProof = trust.issueMapping(taskControlMappingFacts({ ...second, dispatchRoot: 'om_b' }));
    expect(bridge.registerMapping('om_a', first, APP)).toBe(true);
    expect(bridge.registerMapping('om_b', second, APP)).toBe(true);
    expect(bridge.listMappings()).toHaveLength(2);
    const crossApp = new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: 'app-other' });
    const forged = { ...first, mappingProof: crossApp.issueMapping(taskControlMappingFacts({ ...first, dispatchRoot: 'om_a' })) };
    const another = new DaemonTaskControlBridge({ larkAppId: APP, approvals: source(), productionMapping: createTaskControlProductionMappingVerifier({ trust }) });
    expect(another.registerMapping('om_a', forged, APP)).toBe(false);
  });

  it('rejects duplicate task GUIDs before production task-count or mapping-signature acceptance', () => {
    const trust = new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: APP });
    const bridge = new DaemonTaskControlBridge({
      larkAppId: APP, approvals: source(), productionMapping: createTaskControlProductionMappingVerifier({ trust }),
    });
    const duplicate = { ...mapping('task-a', 'om_a', 'task-comment:101'), phaseTaskGuids: ['task-a', 'task-a'] };
    duplicate.mappingProof = trust.issueMapping(taskControlMappingFacts({ ...duplicate, dispatchRoot: 'om_a' }));
    expect(bridge.registerMapping('om_a', duplicate, APP)).toBe(false);
  });

  it('strictly verifies an independent receipt marker across restart and rejects tampering/cross-app markers', () => {
    const trust = new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: APP });
    const marker = trust.issueDeliveryReceiptMarker({
      eventId: 'evt-1', destinationId: 'task-comment:task-a', issuedAt: '2026-09-06T01:02:03.000Z',
    });
    expect(trust.verifyDeliveryReceiptMarker(structuredClone(marker), { eventId: 'evt-1', destinationId: 'task-comment:task-a' })).toBe(true);
    expect(new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: APP })
      .verifyDeliveryReceiptMarker(structuredClone(marker), { eventId: 'evt-1', destinationId: 'task-comment:task-a' })).toBe(true);
    expect(trust.verifyDeliveryReceiptMarker({ ...marker, eventId: 'evt-2' }, { eventId: 'evt-1', destinationId: 'task-comment:task-a' })).toBe(false);
    expect(trust.verifyDeliveryReceiptMarker({ ...marker, signature: `${marker.signature.slice(0, -1)}0` }, { eventId: 'evt-1', destinationId: 'task-comment:task-a' })).toBe(false);
    expect(new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: 'app-other' })
      .verifyDeliveryReceiptMarker(marker, { eventId: 'evt-1', destinationId: 'task-comment:task-a' })).toBe(false);
  });

  it('accepts only the explicit previous root during overlap and rejects it after revoke', () => {
    const oldTrust = new TaskControlMappingTrust({ hostSecret: 'old-host-root', larkAppId: APP });
    const facts = taskControlMappingFacts({ ...mapping('task-a', 'om_a', 'task-comment:101'), dispatchRoot: 'om_a' });
    const proof = oldTrust.issueMapping(facts);
    const overlap = new TaskControlMappingTrust({ hostSecret: HOST_SECRET, previousHostSecret: 'old-host-root', larkAppId: APP });
    expect(overlap.verifyMapping(proof, facts, { allowedKeyIds: [overlap.mappingKeyId, overlap.previousMappingKeyId!] })).toBe(true);
    expect(overlap.verifyMapping(proof, facts, { allowedKeyIds: [overlap.mappingKeyId, overlap.previousMappingKeyId!], revokedKeyIds: [overlap.previousMappingKeyId!] })).toBe(false);
    expect(new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: APP }).verifyMapping(proof, facts)).toBe(false);
  });

  it('applies the same allow and revoke policy to prior delivery receipt markers', () => {
    const oldTrust = new TaskControlMappingTrust({ hostSecret: 'old-host-root', larkAppId: APP });
    const marker = oldTrust.issueDeliveryReceiptMarker({ eventId: 'evt-old', destinationId: 'task-comment:task-a', issuedAt: '2026-09-06T01:02:03.000Z' });
    const overlap = new TaskControlMappingTrust({ hostSecret: HOST_SECRET, previousHostSecret: 'old-host-root', larkAppId: APP });
    const expected = { eventId: 'evt-old', destinationId: 'task-comment:task-a' };
    expect(overlap.verifyDeliveryReceiptMarker(marker, expected, { allowedKeyIds: [overlap.deliveryReceiptKeyId, overlap.previousDeliveryReceiptKeyId!] })).toBe(true);
    expect(overlap.verifyDeliveryReceiptMarker(marker, expected, { allowedKeyIds: [overlap.deliveryReceiptKeyId, overlap.previousDeliveryReceiptKeyId!], revokedKeyIds: [overlap.previousDeliveryReceiptKeyId!] })).toBe(false);
  });
});
