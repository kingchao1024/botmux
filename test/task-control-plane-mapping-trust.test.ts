import { describe, expect, it } from 'vitest';
import {
  TaskControlMappingTrust,
  createTaskControlProductionMappingVerifier,
  taskControlMappingFacts,
} from '../src/services/task-control-plane-mapping-trust.js';
import { DaemonTaskControlBridge } from '../src/services/task-control-plane-daemon-bridge.js';

const APP = 'app-production';
const HOST_SECRET = 'host-only-task-control-test-secret';

function approvalGate() {
  return { approvalRef: 'approval:gate-1', runId: 'run-1', nodeId: 'gate', instanceId: 'gate#1', waitId: 'wait-1', operatorId: 'acceptor', approverPolicy: ['acceptor'] };
}

function mapping(taskGuid: string, topicRootId: string, registrationRef: string) {
  return {
    controllerId: 'daemon:app-production', projectId: 'project', phaseId: 'phase', phaseTaskGuids: ['task-a', 'task-b'], taskGuid, topicRootId,
    ownerId: `worker-${taskGuid}`, reviewerId: `reviewer-${taskGuid}`, acceptorId: 'acceptor', registrationRef, approvalGate: approvalGate(), docToken: 'doc-token-12345678',
  };
}

function source() {
  return { validateBinding: () => true, get: () => undefined };
}

describe('task control production mapping trust', () => {
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
    expect(bridge.registerMapping('om_a', first, 'daemon:app-production')).toBe(true);
    expect(bridge.registerMapping('om_b', second, 'daemon:app-production')).toBe(true);
    expect(bridge.listMappings()).toHaveLength(2);
    const crossApp = new TaskControlMappingTrust({ hostSecret: HOST_SECRET, larkAppId: 'app-other' });
    const forged = { ...first, mappingProof: crossApp.issueMapping(taskControlMappingFacts({ ...first, dispatchRoot: 'om_a' })) };
    const another = new DaemonTaskControlBridge({ larkAppId: APP, approvals: source(), productionMapping: createTaskControlProductionMappingVerifier({ trust }) });
    expect(another.registerMapping('om_a', forged, 'daemon:app-production')).toBe(false);
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
});
