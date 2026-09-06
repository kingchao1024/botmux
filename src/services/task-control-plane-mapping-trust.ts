import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const TASK_CONTROL_MAPPING_TRUST_DOMAIN = 'botmux.task-control.mapping.v1';
export const TASK_CONTROL_DELIVERY_RECEIPT_TRUST_DOMAIN = 'botmux.task-control.delivery-receipt.v1';

export interface TaskControlMappingProof {
  schemaVersion: 'TaskControlMapping.v1';
  larkAppId: string;
  issuedAt: string;
  keyId: string;
  signature: string;
}

export interface TaskControlDeliveryReceiptMarker {
  schemaVersion: 'TaskControlDeliveryReceipt.v1';
  larkAppId: string;
  eventId: string;
  destinationId: string;
  issuedAt: string;
  keyId: string;
  signature: string;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sortedStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  const out = value.map(nonBlank);
  return out.every((item): item is string => !!item) ? [...new Set(out)].sort() : undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(canonical(item))));
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, JSON.parse(canonical(item))])));
}

function keyFor(hostSecret: string, domain: string, larkAppId: string): Buffer {
  return createHmac('sha256', hostSecret).update(`${domain}\0${larkAppId}`, 'utf8').digest();
}

function keyId(key: Buffer, prefix: string): string {
  return `${prefix}:${createHash('sha256').update(key).digest('hex')}`;
}

function signature(key: Buffer, payload: Record<string, unknown>): string {
  return createHmac('sha256', key).update(canonical(payload)).digest('hex');
}

function equalSignature(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function mappingPayload(proof: Omit<TaskControlMappingProof, 'signature'>, facts: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: proof.schemaVersion, larkAppId: proof.larkAppId, issuedAt: proof.issuedAt, keyId: proof.keyId, facts };
}

function deliveryReceiptPayload(marker: Omit<TaskControlDeliveryReceiptMarker, 'signature'>): Record<string, unknown> {
  return {
    schemaVersion: marker.schemaVersion, larkAppId: marker.larkAppId, eventId: marker.eventId,
    destinationId: marker.destinationId, issuedAt: marker.issuedAt, keyId: marker.keyId,
  };
}

/** One host-root-derived signer/verifier per app and purpose. No key material leaves this module. */
export class TaskControlMappingTrust {
  private readonly mappingKey: Buffer;
  private readonly deliveryReceiptKey: Buffer;
  readonly mappingKeyId: string;
  readonly deliveryReceiptKeyId: string;
  readonly larkAppId: string;

  constructor(private readonly input: { hostSecret: string; larkAppId: string }) {
    if (!nonBlank(input.hostSecret) || !nonBlank(input.larkAppId)) throw new Error('task_control_mapping_trust_root_invalid');
    this.larkAppId = input.larkAppId;
    this.mappingKey = keyFor(input.hostSecret, TASK_CONTROL_MAPPING_TRUST_DOMAIN, input.larkAppId);
    this.deliveryReceiptKey = keyFor(input.hostSecret, TASK_CONTROL_DELIVERY_RECEIPT_TRUST_DOMAIN, input.larkAppId);
    this.mappingKeyId = keyId(this.mappingKey, 'tcm1');
    this.deliveryReceiptKeyId = keyId(this.deliveryReceiptKey, 'tcr1');
  }

  issueMapping(facts: Record<string, unknown>, issuedAt = new Date().toISOString()): TaskControlMappingProof {
    const proof: Omit<TaskControlMappingProof, 'signature'> = {
      schemaVersion: 'TaskControlMapping.v1', larkAppId: this.input.larkAppId, issuedAt, keyId: this.mappingKeyId,
    };
    return { ...proof, signature: signature(this.mappingKey, mappingPayload(proof, facts)) };
  }

  verifyMapping(proof: TaskControlMappingProof | undefined, facts: Record<string, unknown>, options: { allowedKeyIds?: readonly string[]; revokedKeyIds?: readonly string[] } = {}): boolean {
    if (!proof || proof.schemaVersion !== 'TaskControlMapping.v1' || proof.larkAppId !== this.input.larkAppId
      || !Number.isFinite(Date.parse(proof.issuedAt)) || proof.keyId !== this.mappingKeyId
      || options.revokedKeyIds?.includes(proof.keyId)
      || (options.allowedKeyIds !== undefined && !options.allowedKeyIds.includes(proof.keyId))) return false;
    return equalSignature(proof.signature, signature(this.mappingKey, mappingPayload(proof, facts)));
  }

  issueDeliveryReceiptMarker(input: { eventId: string; destinationId: string; issuedAt: string }): TaskControlDeliveryReceiptMarker {
    if (!nonBlank(input.eventId) || !nonBlank(input.destinationId) || !Number.isFinite(Date.parse(input.issuedAt))) {
      throw new Error('task_control_delivery_marker_invalid');
    }
    const unsigned: Omit<TaskControlDeliveryReceiptMarker, 'signature'> = {
      schemaVersion: 'TaskControlDeliveryReceipt.v1', larkAppId: this.larkAppId, eventId: input.eventId,
      destinationId: input.destinationId, issuedAt: new Date(Date.parse(input.issuedAt)).toISOString(), keyId: this.deliveryReceiptKeyId,
    };
    return { ...unsigned, signature: signature(this.deliveryReceiptKey, deliveryReceiptPayload(unsigned)) };
  }

  verifyDeliveryReceiptMarker(marker: unknown, expected: { eventId: string; destinationId: string }): marker is TaskControlDeliveryReceiptMarker {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
    const value = marker as Record<string, unknown>;
    const allowed = ['schemaVersion', 'larkAppId', 'eventId', 'destinationId', 'issuedAt', 'keyId', 'signature'];
    if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) return false;
    if (value.schemaVersion !== 'TaskControlDeliveryReceipt.v1' || value.larkAppId !== this.larkAppId
      || value.eventId !== expected.eventId || value.destinationId !== expected.destinationId
      || typeof value.issuedAt !== 'string' || !Number.isFinite(Date.parse(value.issuedAt))
      || value.keyId !== this.deliveryReceiptKeyId || typeof value.signature !== 'string') return false;
    const unsigned: Omit<TaskControlDeliveryReceiptMarker, 'signature'> = {
      schemaVersion: value.schemaVersion, larkAppId: value.larkAppId, eventId: value.eventId, destinationId: value.destinationId,
      issuedAt: value.issuedAt, keyId: value.keyId,
    };
    return equalSignature(value.signature, signature(this.deliveryReceiptKey, deliveryReceiptPayload(unsigned)));
  }

}

/** Keep signer and verifier on one exact canonical mapping contract. */
export function taskControlMappingFacts(input: {
  dispatchRoot: string; projectId: string; phaseId: string; phaseTaskGuids: readonly string[]; taskGuid: string; topicRootId: string;
  ownerId: string; reviewerId: string; acceptorId: string; registrationRef: string; controllerId: string; approvalGate: unknown; docToken?: string;
}): Record<string, unknown> {
  return {
    dispatchRoot: input.dispatchRoot, projectId: input.projectId, phaseId: input.phaseId, phaseTaskGuids: [...input.phaseTaskGuids].sort(),
    taskGuid: input.taskGuid, topicRootId: input.topicRootId, ownerId: input.ownerId, reviewerId: input.reviewerId,
    acceptorId: input.acceptorId, registrationRef: input.registrationRef, controllerId: input.controllerId, approvalGate: input.approvalGate,
    ...(input.docToken ? { docToken: input.docToken } : {}),
  };
}

export function createTaskControlProductionMappingVerifier(input: {
  trust: TaskControlMappingTrust;
  allowedKeyIds?: readonly string[];
  revokedKeyIds?: readonly string[];
}) {
  const options = { allowedKeyIds: input.allowedKeyIds, revokedKeyIds: input.revokedKeyIds };
  return {
    minimumTaskCount: 2,
    verifyMapping: (proof: TaskControlMappingProof | undefined, facts: Record<string, unknown>): boolean =>
      input.trust.verifyMapping(proof, facts, options),
  };
}

export function parseKeyIdSet(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try { return sortedStrings(JSON.parse(value)); } catch { return undefined; }
}
