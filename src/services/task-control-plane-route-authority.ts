import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { JsonBodyTooLargeError, isTrustedHostIpcRequest, jsonRes, readJsonBody } from '../core/dashboard-ipc-server.js';
import type { DaemonTaskControlMapping, DaemonTaskControlMappingRegistration } from './task-control-plane-daemon-bridge.js';
import type { TaskControlPlaneLifecycle } from './task-control-plane-runtime.js';
import type { DesignatedReviewerMapping, ReviewerConditionEvidence, ReviewerVerdictV1 } from './task-control-plane-reviewer-verdict.js';
import {
  createDaemonReviewerVerdictVerifier,
  deriveDaemonDesignatedReviewerProvider,
  deriveDaemonReviewerVerdictProvider,
  reviewerDesignationRef,
  reviewerVerdictKeyId,
  reviewerMessageSourceFromLarkDetail,
} from './task-control-plane-reviewer-verdict.js';

/**
 * Narrow authorization for the mapping route. A generic host HMAC proves only
 * loopback transport; it cannot by itself create a project/phase binding. The
 * request must additionally match the dispatch registry's active daemon
 * session, its current worker generation, and its rotating origin capability.
 */
export interface TaskControlRouteRegistryBinding {
  orchAppId?: unknown;
  orchSessionId?: unknown;
  orchRoot?: unknown;
}

type ReviewerControllerBinding = {
  controllerLarkAppId: string;
  controllerSessionId: string;
  controllerRootId: string;
};

export interface TaskControlRouteLiveSession {
  sessionId: string;
  larkAppId: string;
  rootMessageId?: string;
  workerGeneration?: number;
  managedTurnOrigin?: { capability: string; turnId?: string };
}

export type TaskControlRouteAuthorization =
  | { ok: true; controllerId: string }
  | { ok: false; error: 'transport_untrusted' | 'registry_unproven' | 'session_unproven' | 'generation_unproven' | 'capability_unproven' };

export function authorizeTaskControlMappingRoute(input: {
  transportTrusted: boolean;
  selfLarkAppId?: string;
  registry?: TaskControlRouteRegistryBinding;
  liveSession?: TaskControlRouteLiveSession;
  originCapability?: unknown;
  originTurnId?: unknown;
  workerGeneration?: unknown;
}): TaskControlRouteAuthorization {
  if (!input.transportTrusted) return { ok: false, error: 'transport_untrusted' };
  const registry = input.registry;
  const selfAppId = input.selfLarkAppId;
  if (!selfAppId || !registry || registry.orchAppId !== selfAppId || typeof registry.orchSessionId !== 'string') {
    return { ok: false, error: 'registry_unproven' };
  }
  const live = input.liveSession;
  if (!live || live.sessionId !== registry.orchSessionId || live.larkAppId !== selfAppId
    || (typeof registry.orchRoot === 'string' && registry.orchRoot && live.rootMessageId !== registry.orchRoot)) {
    return { ok: false, error: 'session_unproven' };
  }
  if (!Number.isSafeInteger(live.workerGeneration) || live.workerGeneration! <= 0
    || input.workerGeneration !== live.workerGeneration) {
    return { ok: false, error: 'generation_unproven' };
  }
  const origin = live.managedTurnOrigin;
  if (!origin || input.originCapability !== origin.capability || input.originTurnId !== origin.turnId) {
    return { ok: false, error: 'capability_unproven' };
  }
  return { ok: true, controllerId: `daemon:${selfAppId}` };
}

type ControllerTurnAuthorization = Exclude<TaskControlRouteAuthorization, { ok: true }> | {
  ok: true;
  controllerId: string;
  sessionId: string;
  rootMessageId?: string;
  workerGeneration: number;
  capability: string;
  turnId?: string;
};

function authorizeControllerTurn(input: {
  transportTrusted: boolean;
  dataDir: string;
  selfLarkAppId?: string;
  dispatchRoot?: string;
  controllerSessionId?: unknown;
  findActiveBySessionId: (sessionId: string) => RouteLiveSession | undefined;
  originCapability: unknown;
  originTurnId: unknown;
  workerGeneration: unknown;
}): ControllerTurnAuthorization {
  let registryEntry: Record<string, unknown> | undefined;
  if (input.dispatchRoot) {
    try {
      const registry = JSON.parse(readFileSync(join(input.dataDir, 'orchestrate-dispatch.json'), 'utf8')) as Record<string, unknown>;
      registryEntry = object(registry[input.dispatchRoot]);
    } catch { /* absent/malformed registry is unproven */ }
  }
  const orchestratorSessionId = text(registryEntry?.orchSessionId);
  if (input.controllerSessionId !== undefined && input.controllerSessionId !== orchestratorSessionId) {
    return { ok: false, error: 'session_unproven' };
  }
  const orchestrator = orchestratorSessionId ? input.findActiveBySessionId(orchestratorSessionId) : undefined;
  const authorization = authorizeTaskControlMappingRoute({
    transportTrusted: input.transportTrusted, selfLarkAppId: input.selfLarkAppId, registry: registryEntry,
    liveSession: orchestrator ? {
      sessionId: orchestrator.session.sessionId, larkAppId: orchestrator.larkAppId,
      rootMessageId: orchestrator.session.rootMessageId, workerGeneration: orchestrator.workerGeneration,
      ...(orchestrator.managedTurnOrigin ? { managedTurnOrigin: orchestrator.managedTurnOrigin } : {}),
    } : undefined,
    originCapability: input.originCapability, originTurnId: input.originTurnId, workerGeneration: input.workerGeneration,
  });
  if (!authorization.ok) return authorization;
  return {
    ...authorization,
    sessionId: orchestrator!.session.sessionId,
    ...(orchestrator!.session.rootMessageId ? { rootMessageId: orchestrator!.session.rootMessageId } : {}),
    workerGeneration: orchestrator!.workerGeneration!,
    capability: orchestrator!.managedTurnOrigin!.capability,
    ...(orchestrator!.managedTurnOrigin!.turnId ? { turnId: orchestrator!.managedTurnOrigin!.turnId } : {}),
  };
}

function sameControllerTurn(left: Extract<ControllerTurnAuthorization, { ok: true }>, right: ControllerTurnAuthorization): boolean {
  return right.ok
    && right.controllerId === left.controllerId
    && right.sessionId === left.sessionId
    && right.rootMessageId === left.rootMessageId
    && right.workerGeneration === left.workerGeneration
    && right.capability === left.capability
    && right.turnId === left.turnId;
}

export const TASK_CONTROL_MAPPING_REGISTER_ROUTE = '/api/task-control/mappings';
export const TASK_CONTROL_FREEZE_ROUTE = '/api/task-control/freeze';
export const TASK_CONTROL_DESIGNATED_REVIEWER_ROUTE = '/api/task-control/designated-reviewers';
export const TASK_CONTROL_DESIGNATED_REVIEWER_RESOLVE_ROUTE = '/api/task-control/designated-reviewers/resolve';
/** Reviewer-daemon HMAC-only source resolver used by the controller designation path. */
export const TASK_CONTROL_REVIEWER_SOURCE_ROUTE = '/api/task-control/reviewer-sources/resolve';
/** Untrusted worker-to-own-reviewer-daemon capability ingress only. */
export const TASK_CONTROL_REVIEWER_INGRESS_ROUTE = '/api/task-control/reviewer-verdicts/submit';
/** Controller-only HMAC receiver for already signed reviewer verdicts. */
export const TASK_CONTROL_REVIEWER_VERDICT_ROUTE = '/api/task-control/reviewer-verdicts';
export const TASK_CONTROL_MAPPING_REGISTER_MAX_BYTES = 16 * 1024;
export const TASK_CONTROL_FREEZE_MAX_BYTES = 16 * 1024;
export const TASK_CONTROL_REVIEWER_MAX_BYTES = 16 * 1024;

type RouteIntegration = {
  registerMapping(dispatchRoot: string, mapping: DaemonTaskControlMappingRegistration, controllerId: string): boolean;
  mapping(dispatchRoot: string): DaemonTaskControlMapping | undefined;
  issueAuthentication(dispatchRoot: string, principal: 'acceptor'): unknown | undefined;
  approval(dispatchRoot: string, approvalRef: string): unknown | undefined;
  setReviewerVerdictVerifier(verifier: { verifyDesignatedReviewer(value: DesignatedReviewerMapping): boolean; verifyVerdict(value: ReviewerVerdictV1): boolean }): void;
  currentDesignatedReviewer(dispatchRoot: string, reviewRound: number, now?: string): DesignatedReviewerMapping | undefined;
  registerVerifiedDesignatedReviewer(input: {
    mapping: DesignatedReviewerMapping;
    verifier: { verifyDesignatedReviewer(value: DesignatedReviewerMapping): boolean; verifyVerdict(value: ReviewerVerdictV1): boolean };
  }): boolean;
  submitVerifiedReviewerVerdict(input: {
    dispatchRoot: string; verdict: ReviewerVerdictV1;
    attestation: { reviewerId: string; reviewerBotAppId: string; sessionId: string; workerGeneration: number; capabilityHash: string };
    verifier: { verifyDesignatedReviewer(value: DesignatedReviewerMapping): boolean; verifyVerdict(value: ReviewerVerdictV1): boolean };
    expectedReviewerBotAppId: string; expectedReviewerId: string; now?: string;
  }): { status: string; reason?: string; verdict?: ReviewerVerdictV1 };
  reviewerVerdictUnknown(dispatchRoot: string, verdictId: string, reason: string, sourceRef?: string): void;
};

type RouteLiveSession = {
  session: { sessionId: string; rootMessageId?: string };
  larkAppId: string;
  workerGeneration?: number;
  managedTurnOrigin?: { capability: string; turnId?: string };
};

type ReviewerLiveSession = RouteLiveSession & {
  session: { sessionId: string; rootMessageId?: string; chatId?: string };
  worker: unknown;
};

type ReviewerLiveSnapshot = {
  selfLarkAppId: string;
  sessionId: string;
  rootMessageId: string;
  worker: unknown;
  workerGeneration: number;
  capability: string;
  turnId?: string;
};

type ForwardedReviewerVerdict = {
  dispatchRoot: string;
  verdict: ReviewerVerdictV1;
  attestation: { reviewerId: string; reviewerBotAppId: string; sessionId: string; workerGeneration: number; capabilityHash: string };
};

type ResolvedReviewerDesignation = {
  designation: DesignatedReviewerMapping;
  docToken: string;
};

type ResolvedReviewerSource = { reviewerId: string };

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function controllerBindingFromRegistry(dataDir: string, dispatchRoot: string): ReviewerControllerBinding | undefined {
  if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(dispatchRoot)) return undefined;
  try {
    const registry = JSON.parse(readFileSync(join(dataDir, 'orchestrate-dispatch.json'), 'utf8')) as Record<string, unknown>;
    const entry = object(registry[dispatchRoot]);
    const controllerLarkAppId = text(entry?.orchAppId);
    const controllerSessionId = text(entry?.orchSessionId);
    const controllerRootId = text(entry?.orchRoot);
    return controllerLarkAppId && controllerSessionId && controllerRootId
      && /^om_[A-Za-z0-9_-]{1,128}$/.test(controllerRootId)
      ? { controllerLarkAppId, controllerSessionId, controllerRootId }
      : undefined;
  } catch { return undefined; }
}

function liveControllerBinding(input: {
  dataDir: string; dispatchRoot: string; selfLarkAppId?: string;
  findActiveBySessionId: (sessionId: string) => RouteLiveSession | undefined;
}): ReviewerControllerBinding | undefined {
  const binding = controllerBindingFromRegistry(input.dataDir, input.dispatchRoot);
  if (!binding || binding.controllerLarkAppId !== input.selfLarkAppId) return undefined;
  const live = input.findActiveBySessionId(binding.controllerSessionId);
  return live
    && live.larkAppId === binding.controllerLarkAppId
    && live.session.sessionId === binding.controllerSessionId
    && live.session.rootMessageId === binding.controllerRootId
    ? binding
    : undefined;
}

function stringArray(value: unknown, limit = 64): string[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const normalized = text(item);
    if (!normalized) return undefined;
    out.push(normalized);
  }
  return out;
}

function conditionEvidence(value: unknown): Record<string, ReviewerConditionEvidence> | undefined {
  const raw = object(value);
  if (!raw || Object.keys(raw).length > 64) return undefined;
  const out: Record<string, ReviewerConditionEvidence> = {};
  for (const [conditionId, evidence] of Object.entries(raw)) {
    const item = object(evidence);
    const evidenceRef = text(item?.evidenceRef);
    const observedAt = text(item?.observedAt);
    if (!text(conditionId) || !evidenceRef || !observedAt || !Number.isFinite(Date.parse(observedAt))) return undefined;
    out[conditionId] = { evidenceRef, observedAt };
  }
  return out;
}

function snapshotLiveReviewer(input: {
  selfLarkAppId?: string; originCapability: unknown; originTurnId: unknown;
  listReviewerSessions: () => ReviewerLiveSession[];
}): ReviewerLiveSnapshot | undefined {
  if (!input.selfLarkAppId) return undefined;
  const matches = input.listReviewerSessions().flatMap(live => {
    const rootMessageId = live.session.rootMessageId;
    const origin = live.managedTurnOrigin;
    return live.worker && live.larkAppId === input.selfLarkAppId && rootMessageId && origin
      && Number.isSafeInteger(live.workerGeneration) && live.workerGeneration! > 0
      && origin.capability === input.originCapability && origin.turnId === input.originTurnId
      ? [{
          selfLarkAppId: input.selfLarkAppId!, sessionId: live.session.sessionId, rootMessageId, worker: live.worker,
          workerGeneration: live.workerGeneration!, capability: origin.capability,
          ...(origin.turnId ? { turnId: origin.turnId } : {}),
        }]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Every external await may have crossed a worker replacement. Re-read the
 * complete daemon-owned reviewer tuple before signing or forwarding. */
function reviewerStillLive(
  snapshot: ReviewerLiveSnapshot,
  findActiveBySessionId: (sessionId: string) => ReviewerLiveSession | undefined,
): boolean {
  const current = findActiveBySessionId(snapshot.sessionId);
  return !!current
    && current.larkAppId === snapshot.selfLarkAppId
    && current.session.sessionId === snapshot.sessionId
    && current.session.rootMessageId === snapshot.rootMessageId
    && current.worker === snapshot.worker
    && current.workerGeneration === snapshot.workerGeneration
    && current.managedTurnOrigin?.capability === snapshot.capability
    && current.managedTurnOrigin?.turnId === snapshot.turnId;
}

function sameControllerBinding(left: ReviewerControllerBinding, right: ReviewerControllerBinding | undefined): boolean {
  return !!right
    && left.controllerLarkAppId === right.controllerLarkAppId
    && left.controllerSessionId === right.controllerSessionId
    && left.controllerRootId === right.controllerRootId;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

/** The receiver must be idempotent for a lost first response. Anchor the
 * signed expiry to the Lark-resolved source version instead of this request's
 * arrival time, so a retry produces the same canonical verdict. */
function reviewerVerdictExpiresAt(sourceCreatedAt: string): string | undefined {
  const createdAt = Date.parse(sourceCreatedAt);
  if (!Number.isFinite(createdAt)) return undefined;
  return new Date(createdAt + 24 * 60 * 60_000).toISOString();
}

function safeAppId(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9._-]{1,256}$/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function forwardedVerdict(body: Record<string, unknown>): {
  dispatchRoot: string; verdict: ReviewerVerdictV1;
  attestation: { reviewerId: string; reviewerBotAppId: string; sessionId: string; workerGeneration: number; capabilityHash: string };
} | undefined {
  if (!hasOnlyKeys(body, ['dispatchRoot', 'verdict', 'attestation'])) return undefined;
  const dispatchRoot = text(body.dispatchRoot);
  const rawVerdict = object(body.verdict);
  const rawAttestation = object(body.attestation);
  if (!dispatchRoot || !rawVerdict || !rawAttestation || !hasOnlyKeys(rawVerdict, [
    'schemaVersion', 'provider', 'verdictId', 'projectId', 'phaseId', 'taskGuid', 'topicRootId', 'taskSetSnapshot', 'reviewRound',
    'designatedReviewerRef', 'reviewerId', 'reviewerBotAppId', 'sessionId', 'workerGeneration', 'capabilityHash', 'sourceMessageId',
    'sourceVersionHash', 'kind', 'verdict', 'conditionIds', 'resolvedConditionEvidence', 'docToken', 'docRevision', 'issuedAt', 'expiresAt', 'keyId', 'signature',
  ]) || !hasOnlyKeys(rawAttestation, ['reviewerId', 'reviewerBotAppId', 'sessionId', 'workerGeneration', 'capabilityHash'])) return undefined;
  const taskSetSnapshot = stringArray(rawVerdict.taskSetSnapshot);
  const conditionIds = stringArray(rawVerdict.conditionIds);
  const resolvedConditionEvidence = conditionEvidence(rawVerdict.resolvedConditionEvidence);
  const verdict = {
    schemaVersion: rawVerdict.schemaVersion, provider: rawVerdict.provider, verdictId: text(rawVerdict.verdictId), projectId: text(rawVerdict.projectId),
    phaseId: text(rawVerdict.phaseId), taskGuid: text(rawVerdict.taskGuid), topicRootId: text(rawVerdict.topicRootId), taskSetSnapshot, reviewRound: rawVerdict.reviewRound,
    designatedReviewerRef: text(rawVerdict.designatedReviewerRef), reviewerId: text(rawVerdict.reviewerId), reviewerBotAppId: text(rawVerdict.reviewerBotAppId),
    sessionId: text(rawVerdict.sessionId), workerGeneration: rawVerdict.workerGeneration, capabilityHash: text(rawVerdict.capabilityHash),
    sourceMessageId: text(rawVerdict.sourceMessageId), sourceVersionHash: text(rawVerdict.sourceVersionHash), kind: rawVerdict.kind, verdict: rawVerdict.verdict,
    conditionIds, resolvedConditionEvidence, docToken: text(rawVerdict.docToken), docRevision: rawVerdict.docRevision, issuedAt: text(rawVerdict.issuedAt),
    expiresAt: text(rawVerdict.expiresAt), keyId: text(rawVerdict.keyId), signature: text(rawVerdict.signature),
  };
  const reviewerId = text(rawAttestation.reviewerId);
  const reviewerBotAppId = text(rawAttestation.reviewerBotAppId);
  const sessionId = text(rawAttestation.sessionId);
  const capabilityHash = text(rawAttestation.capabilityHash);
  if (verdict.schemaVersion !== 'ReviewerVerdict.v1' || verdict.provider !== 'ReviewerVerdict.v1' || verdict.kind !== 'verdict'
    || (verdict.verdict !== 'pass' && verdict.verdict !== 'fail' && verdict.verdict !== 'conditional')
    || !verdict.verdictId || !verdict.projectId || !verdict.phaseId || !verdict.taskGuid || !verdict.topicRootId || !taskSetSnapshot
    || !Number.isSafeInteger(verdict.reviewRound) || !verdict.designatedReviewerRef || !verdict.reviewerId || !safeAppId(verdict.reviewerBotAppId)
    || !verdict.sessionId || !Number.isSafeInteger(verdict.workerGeneration) || !verdict.capabilityHash || !verdict.sourceMessageId
    || !verdict.sourceVersionHash || !conditionIds || !resolvedConditionEvidence || !verdict.docToken || !Number.isSafeInteger(verdict.docRevision)
    || !verdict.issuedAt || !verdict.expiresAt || !verdict.keyId || !verdict.signature || !reviewerId || !safeAppId(reviewerBotAppId) || !sessionId
    || !Number.isSafeInteger(rawAttestation.workerGeneration) || !capabilityHash) return undefined;
  return {
    dispatchRoot, verdict: verdict as ReviewerVerdictV1,
    attestation: { reviewerId, reviewerBotAppId, sessionId, workerGeneration: rawAttestation.workerGeneration as number, capabilityHash },
  };
}

/**
 * The daemon owns the only production registrations for these handlers. The
 * factory exists solely so the exact signed HTTP boundary can be exercised
 * without importing a running daemon or creating an additional endpoint.
 */
export function createTaskControlRouteHandlers(input: {
  dataDir: () => string;
  selfLarkAppId: () => string | undefined;
  integration: () => RouteIntegration | undefined;
  lifecycle: () => Pick<TaskControlPlaneLifecycle, 'freeze'> | undefined;
  findActiveBySessionId: (sessionId: string) => RouteLiveSession | undefined;
  findReviewerSession: (sessionId: string) => ReviewerLiveSession | undefined;
  listReviewerSessions: () => ReviewerLiveSession[];
  hostSecret: () => string | undefined;
  readMessageDetail: (larkAppId: string, messageId: string) => Promise<unknown>;
  readDocumentRevision: (larkAppId: string, docToken: string) => Promise<number | undefined>;
  resolveReviewerSource: (reviewerLarkAppId: string, input: {
    sourceMessageId: string; topicRootId: string;
  }) => Promise<{ status: number; source?: ResolvedReviewerSource } | undefined>;
  resolveReviewerDesignation: (controllerLarkAppId: string, input: {
    dispatchRoot: string; reviewerBotAppId: string; reviewRound: number;
  }) => Promise<{ status: number; resolved?: ResolvedReviewerDesignation } | undefined>;
  forwardReviewerVerdict: (controllerLarkAppId: string, body: ForwardedReviewerVerdict) => Promise<{ status: number } | undefined>;
}): {
  mapping(req: IncomingMessage, res: ServerResponse): Promise<void>;
  freeze(req: IncomingMessage, res: ServerResponse): Promise<void>;
  designatedReviewer(req: IncomingMessage, res: ServerResponse): Promise<void>;
  designatedReviewerResolve(req: IncomingMessage, res: ServerResponse): Promise<void>;
  reviewerSource(req: IncomingMessage, res: ServerResponse): Promise<void>;
  reviewerIngress(req: IncomingMessage, res: ServerResponse): Promise<void>;
  reviewerVerdict(req: IncomingMessage, res: ServerResponse): Promise<void>;
} {
  return {
    async mapping(req, res): Promise<void> {
      const integration = input.integration();
      if (!isTrustedHostIpcRequest(req) || !integration) {
        jsonRes(res, 403, { ok: false, error: 'task_control_mapping_unavailable' });
        return;
      }
      let raw: unknown;
      try { raw = await readJsonBody<unknown>(req, TASK_CONTROL_MAPPING_REGISTER_MAX_BYTES); }
      catch (error) {
        jsonRes(res, error instanceof JsonBodyTooLargeError ? 413 : 400, { ok: false, error: 'bad_json' });
        return;
      }
      const body = object(raw);
      const dispatchRoot = text(body?.dispatchRoot);
      const routeAuthority = authorizeControllerTurn({
        transportTrusted: isTrustedHostIpcRequest(req), dataDir: input.dataDir(), selfLarkAppId: input.selfLarkAppId(), dispatchRoot,
        findActiveBySessionId: input.findActiveBySessionId, originCapability: body?.originCapability,
        originTurnId: body?.originTurnId, workerGeneration: body?.workerGeneration,
      });
      if (!routeAuthority.ok) {
        jsonRes(res, 403, { ok: false, error: `task_control_mapping_${routeAuthority.error}` });
        return;
      }
      const approvalGate = object(body?.approvalGate);
      const mapping: DaemonTaskControlMappingRegistration = {
        projectId: text(body?.projectId) ?? '', phaseId: text(body?.phaseId) ?? '',
        phaseTaskGuids: Array.isArray(body?.phaseTaskGuids) ? body!.phaseTaskGuids.filter((item): item is string => typeof item === 'string') : [],
        taskGuid: text(body?.taskGuid) ?? '', topicRootId: text(body?.topicRootId) ?? '',
        ownerId: text(body?.ownerId) ?? '', reviewerId: text(body?.reviewerId) ?? '',
        acceptorId: text(body?.acceptorId) ?? '', registrationRef: text(body?.registrationRef) ?? '',
        approvalGate: {
          runId: text(approvalGate?.runId) ?? '', nodeId: text(approvalGate?.nodeId) ?? '',
          instanceId: text(approvalGate?.instanceId) ?? '', waitId: text(approvalGate?.waitId) ?? '',
          operatorId: text(approvalGate?.operatorId) ?? '',
          approverPolicy: Array.isArray(approvalGate?.approverPolicy)
            ? approvalGate.approverPolicy.filter((item): item is string => typeof item === 'string') : [],
        },
        ...(text(body?.docToken) ? { docToken: text(body?.docToken)! } : {}),
      };
      if (!dispatchRoot || !integration.registerMapping(dispatchRoot, mapping, routeAuthority.controllerId)) {
        jsonRes(res, 400, { ok: false, error: 'task_control_mapping_invalid_or_conflict' });
        return;
      }
      jsonRes(res, 201, { ok: true, dispatchRoot });
    },

    async freeze(req, res): Promise<void> {
      const integration = input.integration();
      const lifecycle = input.lifecycle();
      if (!isTrustedHostIpcRequest(req) || !integration || !lifecycle) {
        jsonRes(res, 403, { ok: false, error: 'task_control_freeze_unavailable' });
        return;
      }
      let raw: unknown;
      try { raw = await readJsonBody<unknown>(req, TASK_CONTROL_FREEZE_MAX_BYTES); }
      catch (error) {
        jsonRes(res, error instanceof JsonBodyTooLargeError ? 413 : 400, { ok: false, error: 'bad_json' });
        return;
      }
      const body = object(raw);
      const dispatchRoot = text(body?.dispatchRoot);
      const approvalRef = text(body?.approvalRef);
      const eventId = text(body?.eventId);
      const idempotencyKey = text(body?.idempotencyKey);
      if (!dispatchRoot || !approvalRef || !eventId || !idempotencyKey) {
        jsonRes(res, 400, { ok: false, error: 'task_control_freeze_invalid' });
        return;
      }
      let mapping = integration.mapping(dispatchRoot);
      const authentication = integration.issueAuthentication(dispatchRoot, 'acceptor');
      const approval = integration.approval(dispatchRoot, approvalRef);
      if (!mapping || !authentication || !approval) {
        jsonRes(res, 403, { ok: false, error: 'task_control_freeze_unproven' });
        return;
      }
      try {
        const result = lifecycle.freeze({
          eventId, projectId: mapping.projectId, phaseId: mapping.phaseId, authentication: authentication as never, approval, idempotencyKey,
          evidenceRef: `approval:${approvalRef.replace(/^approval:/, '')}`,
        });
        jsonRes(res, result.kind === 'frozen' ? 201 : 409, { ok: result.kind === 'frozen', result });
      } catch (error) {
        jsonRes(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },

    async designatedReviewer(req, res): Promise<void> {
      const integration = input.integration();
      const selfAppId = input.selfLarkAppId();
      const hostSecret = input.hostSecret();
      if (!isTrustedHostIpcRequest(req) || !integration || !selfAppId || !hostSecret) {
        jsonRes(res, 403, { ok: false, error: 'task_control_designated_reviewer_unavailable' });
        return;
      }
      let raw: unknown;
      try { raw = await readJsonBody<unknown>(req, TASK_CONTROL_REVIEWER_MAX_BYTES); }
      catch (error) {
        jsonRes(res, error instanceof JsonBodyTooLargeError ? 413 : 400, { ok: false, error: 'bad_json' });
        return;
      }
      const body = object(raw);
      const dispatchRoot = text(body?.dispatchRoot);
      const reviewerBotAppId = text(body?.reviewerBotAppId);
      const sourceMessageId = text(body?.sourceMessageId);
      const mapping = dispatchRoot ? integration.mapping(dispatchRoot) : undefined;
      const reviewRound = body?.reviewRound;
      const taskSetSnapshot = stringArray(body?.taskSetSnapshot);
      const effectiveAt = text(body?.effectiveAt);
      const expiresAt = text(body?.expiresAt);
      const supersedesDesignatedReviewerRef = text(body?.supersedesDesignatedReviewerRef);
      if (!body || !hasOnlyKeys(body, [
        'dispatchRoot', 'reviewerBotAppId', 'sourceMessageId', 'reviewRound', 'taskSetSnapshot', 'effectiveAt', 'expiresAt', 'supersedesDesignatedReviewerRef',
        'controllerSessionId', 'originCapability', 'originTurnId', 'workerGeneration',
      ]) || !dispatchRoot || !mapping || !safeAppId(reviewerBotAppId) || !sourceMessageId || !text(body.controllerSessionId)
        || !positiveSafeInteger(reviewRound) || !taskSetSnapshot
        || !effectiveAt || !expiresAt || !Number.isFinite(Date.parse(effectiveAt))
        || !Number.isFinite(Date.parse(expiresAt)) || !sameStrings(taskSetSnapshot, mapping.phaseTaskGuids)) {
        jsonRes(res, 400, { ok: false, error: 'task_control_designated_reviewer_invalid' });
        return;
      }
      const routeAuthority = authorizeControllerTurn({
        transportTrusted: isTrustedHostIpcRequest(req), dataDir: input.dataDir(), selfLarkAppId: selfAppId, dispatchRoot,
        controllerSessionId: body.controllerSessionId,
        findActiveBySessionId: input.findActiveBySessionId, originCapability: body.originCapability,
        originTurnId: body.originTurnId, workerGeneration: body.workerGeneration,
      });
      if (!routeAuthority.ok) {
        jsonRes(res, 403, { ok: false, error: `task_control_designated_reviewer_${routeAuthority.error}` });
        return;
      }
      const sourceResponse = await input.resolveReviewerSource(reviewerBotAppId, {
        sourceMessageId, topicRootId: mapping.topicRootId,
      }).catch(() => undefined);
      const reviewerId = sourceResponse?.status === 200 ? sourceResponse.source?.reviewerId : undefined;
      if (!reviewerId) {
        jsonRes(res, 409, { ok: false, error: 'task_control_designated_reviewer_source_unproven' });
        return;
      }
      const currentRouteAuthority = authorizeControllerTurn({
        transportTrusted: isTrustedHostIpcRequest(req), dataDir: input.dataDir(), selfLarkAppId: selfAppId, dispatchRoot,
        controllerSessionId: body.controllerSessionId,
        findActiveBySessionId: input.findActiveBySessionId, originCapability: body.originCapability,
        originTurnId: body.originTurnId, workerGeneration: body.workerGeneration,
      });
      if (!sameControllerTurn(routeAuthority, currentRouteAuthority)) {
        jsonRes(res, 409, { ok: false, error: 'task_control_designated_reviewer_origin_changed' });
        return;
      }
      const signer = deriveDaemonDesignatedReviewerProvider({ hostSecret, controllerBotAppId: selfAppId });
      let designatedReviewerRef: string;
      let designation: DesignatedReviewerMapping;
      try {
        designatedReviewerRef = reviewerDesignationRef(dispatchRoot, reviewerBotAppId, reviewRound);
        designation = signer.issueDesignatedReviewer({
          designatedReviewerRef, projectId: mapping.projectId, phaseId: mapping.phaseId, taskGuid: mapping.taskGuid,
          topicRootId: mapping.topicRootId, taskSetSnapshot, reviewRound, reviewerId, reviewerBotAppId,
          controllerId: routeAuthority.controllerId, controllerBotAppId: selfAppId, effectiveAt, expiresAt, issuedAt: effectiveAt,
          ...(supersedesDesignatedReviewerRef ? { supersedesDesignatedReviewerRef } : {}),
        });
      } catch {
        jsonRes(res, 400, { ok: false, error: 'task_control_designated_reviewer_invalid' });
        return;
      }
      const verifier = createDaemonReviewerVerdictVerifier({ hostSecret, controllerBotAppId: selfAppId });
      if (!integration.registerVerifiedDesignatedReviewer({ mapping: designation, verifier })) {
        jsonRes(res, 409, { ok: false, error: 'task_control_designated_reviewer_unproven' });
        return;
      }
      jsonRes(res, 201, { ok: true, dispatchRoot, designatedReviewerRef });
    },

    async reviewerSource(req, res): Promise<void> {
      const selfAppId = input.selfLarkAppId();
      if (!isTrustedHostIpcRequest(req) || !selfAppId || !input.integration()) {
        jsonRes(res, 403, { ok: false, error: 'task_control_reviewer_source_unavailable' });
        return;
      }
      let raw: unknown;
      try { raw = await readJsonBody<unknown>(req, TASK_CONTROL_REVIEWER_MAX_BYTES); }
      catch (error) {
        jsonRes(res, error instanceof JsonBodyTooLargeError ? 413 : 400, { ok: false, error: 'bad_json' });
        return;
      }
      const body = object(raw);
      const sourceMessageId = text(body?.sourceMessageId);
      const topicRootId = text(body?.topicRootId);
      if (!body || !hasOnlyKeys(body, ['sourceMessageId', 'topicRootId']) || !sourceMessageId || !topicRootId) {
        jsonRes(res, 400, { ok: false, error: 'task_control_reviewer_source_invalid' });
        return;
      }
      let source: ReturnType<typeof reviewerMessageSourceFromLarkDetail>;
      try {
        source = reviewerMessageSourceFromLarkDetail({
          detail: await input.readMessageDetail(selfAppId, sourceMessageId),
          expectedMessageId: sourceMessageId, expectedTopicRootId: topicRootId,
        });
      } catch { source = undefined; }
      if (!source) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_source_unproven' });
        return;
      }
      jsonRes(res, 200, { ok: true, source: { reviewerId: source.senderId } });
    },

    async reviewerIngress(req, res): Promise<void> {
      const selfAppId = input.selfLarkAppId();
      const hostSecret = input.hostSecret();
      if (!selfAppId || !hostSecret || !input.integration()) {
        jsonRes(res, 503, { ok: false, error: 'task_control_reviewer_ingress_unavailable' });
        return;
      }
      let raw: unknown;
      try { raw = await readJsonBody<unknown>(req, TASK_CONTROL_REVIEWER_MAX_BYTES); }
      catch (error) {
        jsonRes(res, error instanceof JsonBodyTooLargeError ? 413 : 400, { ok: false, error: 'bad_json' });
        return;
      }
      const body = object(raw);
      const sourceMessageId = text(body?.sourceMessageId);
      const verdictId = text(body?.verdictId);
      const verdictKind = body?.verdict;
      const docToken = text(body?.docToken);
      const docRevision = positiveSafeInteger(body?.docRevision) ? body.docRevision : undefined;
      const reviewRound = positiveSafeInteger(body?.reviewRound) ? body.reviewRound : undefined;
      const conditionIds = stringArray(body?.conditionIds);
      const resolvedConditionEvidence = conditionEvidence(body?.resolvedConditionEvidence);
      if (!body || !hasOnlyKeys(body, [
        'originCapability', 'originTurnId',
        'sourceMessageId', 'verdictId', 'verdict', 'docToken', 'docRevision', 'reviewRound', 'conditionIds', 'resolvedConditionEvidence',
      ]) || !sourceMessageId || !verdictId || !docToken
        || (verdictKind !== 'pass' && verdictKind !== 'fail' && verdictKind !== 'conditional')
        || docRevision === undefined || reviewRound === undefined
        || !conditionIds || !resolvedConditionEvidence
        || (verdictKind === 'conditional') !== (conditionIds.length > 0)) {
        jsonRes(res, 400, { ok: false, error: 'task_control_reviewer_ingress_invalid' });
        return;
      }
      const reviewer = snapshotLiveReviewer({
        selfLarkAppId: selfAppId, originCapability: body.originCapability, originTurnId: body.originTurnId,
        listReviewerSessions: input.listReviewerSessions,
      });
      if (!reviewer) {
        jsonRes(res, 403, { ok: false, error: 'task_control_reviewer_ingress_origin_unproven' });
        return;
      }
      const dispatchRoot = reviewer.rootMessageId;
      const controller = controllerBindingFromRegistry(input.dataDir(), dispatchRoot);
      if (!controller) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_ingress_controller_unproven' });
        return;
      }
      let source: ReturnType<typeof reviewerMessageSourceFromLarkDetail>;
      try {
        source = reviewerMessageSourceFromLarkDetail({
          detail: await input.readMessageDetail(selfAppId, sourceMessageId),
          expectedMessageId: sourceMessageId, expectedTopicRootId: dispatchRoot,
        });
      } catch { source = undefined; }
      if (!reviewerStillLive(reviewer, input.findReviewerSession)
        || !sameControllerBinding(controller, controllerBindingFromRegistry(input.dataDir(), dispatchRoot))) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_ingress_origin_changed' });
        return;
      }
      if (!source) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_ingress_source_unproven' });
        return;
      }
      const designationResponse = await input.resolveReviewerDesignation(controller.controllerLarkAppId, {
        dispatchRoot, reviewerBotAppId: selfAppId, reviewRound,
      }).catch(() => undefined);
      if (!reviewerStillLive(reviewer, input.findReviewerSession)
        || !sameControllerBinding(controller, controllerBindingFromRegistry(input.dataDir(), dispatchRoot))) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_ingress_origin_changed' });
        return;
      }
      const resolved = designationResponse?.status === 200 ? designationResponse.resolved : undefined;
      const designation = resolved?.designation;
      if (!designation
        || designation.reviewerBotAppId !== selfAppId
        || designation.reviewerId !== source.senderId
        || designation.designatedReviewerRef !== reviewerDesignationRef(dispatchRoot, selfAppId, reviewRound)
        || designation.topicRootId !== dispatchRoot) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_ingress_designation_unproven' });
        return;
      }
      // doc identity comes from the controller mapping, never the worker body.
      if (docToken !== resolved.docToken) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_ingress_document_unproven' });
        return;
      }
      let revision: number | undefined;
      try { revision = await input.readDocumentRevision(selfAppId, resolved.docToken); } catch { revision = undefined; }
      if (!reviewerStillLive(reviewer, input.findReviewerSession)
        || !sameControllerBinding(controller, controllerBindingFromRegistry(input.dataDir(), dispatchRoot))) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_ingress_origin_changed' });
        return;
      }
      if (revision !== docRevision) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_ingress_document_unproven' });
        return;
      }
      const signer = deriveDaemonReviewerVerdictProvider({ hostSecret, reviewerBotAppId: selfAppId });
      const expiresAt = reviewerVerdictExpiresAt(source.createdAt);
      let verdict: ReviewerVerdictV1;
      try {
        verdict = signer.issueVerdict({
          verdictId, projectId: designation.projectId, phaseId: designation.phaseId, taskGuid: designation.taskGuid, topicRootId: designation.topicRootId,
          taskSetSnapshot: designation.taskSetSnapshot, reviewRound, designatedReviewerRef: designation.designatedReviewerRef, reviewerId: source.senderId, reviewerBotAppId: selfAppId,
          sessionId: reviewer.sessionId, workerGeneration: reviewer.workerGeneration, capability: reviewer.capability,
          sourceMessageId: source.sourceMessageId, sourceVersionHash: source.sourceVersionHash, kind: 'verdict', verdict: verdictKind,
          conditionIds, resolvedConditionEvidence, docToken: resolved.docToken, docRevision, issuedAt: source.createdAt,
          expiresAt: expiresAt!,
        });
      } catch { verdict = undefined as never; }
      if (!verdict) {
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_ingress_scope_unproven' });
        return;
      }
      const forwarded: ForwardedReviewerVerdict = {
        dispatchRoot, verdict, attestation: { reviewerId: source.senderId, reviewerBotAppId: selfAppId,
          sessionId: reviewer.sessionId, workerGeneration: reviewer.workerGeneration, capabilityHash: verdict.capabilityHash },
      };
      const forwardedResponse = await input.forwardReviewerVerdict(controller.controllerLarkAppId, forwarded).catch(() => undefined);
      if (!forwardedResponse) {
        jsonRes(res, 502, { ok: false, error: 'task_control_reviewer_ingress_controller_unreachable' });
        return;
      }
      jsonRes(res, forwardedResponse.status === 201 ? 201 : 409, {
        ok: forwardedResponse.status === 201, verdictId,
        ...(forwardedResponse.status === 201 ? {} : { error: 'task_control_reviewer_ingress_controller_rejected' }),
      });
    },

    async designatedReviewerResolve(req, res): Promise<void> {
      const integration = input.integration();
      const selfAppId = input.selfLarkAppId();
      const hostSecret = input.hostSecret();
      if (!isTrustedHostIpcRequest(req) || !integration || !selfAppId || !hostSecret) {
        jsonRes(res, 403, { ok: false, error: 'task_control_designation_resolve_unavailable' });
        return;
      }
      let raw: unknown;
      try { raw = await readJsonBody<unknown>(req, TASK_CONTROL_REVIEWER_MAX_BYTES); }
      catch (error) {
        jsonRes(res, error instanceof JsonBodyTooLargeError ? 413 : 400, { ok: false, error: 'bad_json' });
        return;
      }
      const body = object(raw);
      const dispatchRoot = text(body?.dispatchRoot);
      const reviewerBotAppId = text(body?.reviewerBotAppId);
      const reviewRound = positiveSafeInteger(body?.reviewRound) ? body.reviewRound : undefined;
      if (!body || !hasOnlyKeys(body, ['dispatchRoot', 'reviewerBotAppId', 'reviewRound'])
        || !dispatchRoot || !safeAppId(reviewerBotAppId) || reviewRound === undefined) {
        jsonRes(res, 400, { ok: false, error: 'task_control_designation_resolve_invalid' });
        return;
      }
      if (!liveControllerBinding({
        dataDir: input.dataDir(), dispatchRoot, selfLarkAppId: selfAppId, findActiveBySessionId: input.findActiveBySessionId,
      })) {
        jsonRes(res, 409, { ok: false, error: 'task_control_designation_resolve_controller_unproven' });
        return;
      }
      const verifier = createDaemonReviewerVerdictVerifier({ hostSecret, controllerBotAppId: selfAppId });
      integration.setReviewerVerdictVerifier(verifier);
      const designation = integration.currentDesignatedReviewer(dispatchRoot, reviewRound);
      if (!designation || designation.reviewerBotAppId !== reviewerBotAppId
        || designation.designatedReviewerRef !== reviewerDesignationRef(dispatchRoot, reviewerBotAppId, reviewRound)) {
        jsonRes(res, 409, { ok: false, error: 'task_control_designation_resolve_unproven' });
        return;
      }
      let mapping = integration.mapping(dispatchRoot);
      if (!mapping?.docToken) {
        jsonRes(res, 409, { ok: false, error: 'task_control_designation_resolve_document_unproven' });
        return;
      }
      jsonRes(res, 200, { ok: true, resolved: { designation: {
        schemaVersion: designation.schemaVersion, designatedReviewerRef: designation.designatedReviewerRef,
        projectId: designation.projectId, phaseId: designation.phaseId, taskGuid: designation.taskGuid, topicRootId: designation.topicRootId,
        taskSetSnapshot: designation.taskSetSnapshot, reviewRound: designation.reviewRound, reviewerId: designation.reviewerId,
        reviewerBotAppId: designation.reviewerBotAppId, controllerId: designation.controllerId, controllerBotAppId: designation.controllerBotAppId,
        effectiveAt: designation.effectiveAt, expiresAt: designation.expiresAt, issuedAt: designation.issuedAt, signature: designation.signature,
        ...(designation.supersedesDesignatedReviewerRef ? { supersedesDesignatedReviewerRef: designation.supersedesDesignatedReviewerRef } : {}),
      }, docToken: mapping.docToken } });
    },

    async reviewerVerdict(req, res): Promise<void> {
      const integration = input.integration();
      const selfAppId = input.selfLarkAppId();
      const hostSecret = input.hostSecret();
      if (!isTrustedHostIpcRequest(req) || !integration || !selfAppId || !hostSecret) {
        jsonRes(res, 403, { ok: false, error: 'task_control_reviewer_verdict_unavailable' });
        return;
      }
      let raw: unknown;
      try { raw = await readJsonBody<unknown>(req, TASK_CONTROL_REVIEWER_MAX_BYTES); }
      catch (error) {
        jsonRes(res, error instanceof JsonBodyTooLargeError ? 413 : 400, { ok: false, error: 'bad_json' });
        return;
      }
      const body = object(raw);
      if (!body) {
        jsonRes(res, 400, { ok: false, error: 'task_control_reviewer_verdict_invalid' });
        return;
      }
      const forwarded = forwardedVerdict(body);
      if (!forwarded) {
        jsonRes(res, 400, { ok: false, error: 'task_control_reviewer_verdict_invalid' });
        return;
      }
      const { dispatchRoot, verdict, attestation } = forwarded;
      const controller = liveControllerBinding({
        dataDir: input.dataDir(), dispatchRoot, selfLarkAppId: selfAppId, findActiveBySessionId: input.findActiveBySessionId,
      });
      if (!controller) {
        integration.reviewerVerdictUnknown(dispatchRoot, verdict.verdictId, 'reviewer_verdict_controller_unproven');
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_verdict_controller_unproven' });
        return;
      }
      let mapping = integration.mapping(dispatchRoot);
      if (!mapping?.docToken) {
        integration.reviewerVerdictUnknown(dispatchRoot, verdict.verdictId, 'reviewer_verdict_document_unproven');
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_verdict_document_unproven' });
        return;
      }
      let revision: number | undefined;
      try { revision = await input.readDocumentRevision(selfAppId, mapping.docToken); } catch { revision = undefined; }
      const currentMapping = integration.mapping(dispatchRoot);
      if (!sameControllerBinding(controller, liveControllerBinding({
        dataDir: input.dataDir(), dispatchRoot, selfLarkAppId: selfAppId, findActiveBySessionId: input.findActiveBySessionId,
      })) || !currentMapping || currentMapping.docToken !== mapping.docToken) {
        integration.reviewerVerdictUnknown(dispatchRoot, verdict.verdictId, 'reviewer_verdict_controller_changed');
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_verdict_controller_changed' });
        return;
      }
      if (revision !== verdict.docRevision) {
        integration.reviewerVerdictUnknown(dispatchRoot, verdict.verdictId, 'reviewer_verdict_document_unproven');
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_verdict_document_unproven' });
        return;
      }
      mapping = currentMapping;
      const verifier = createDaemonReviewerVerdictVerifier({ hostSecret, controllerBotAppId: selfAppId });
      integration.setReviewerVerdictVerifier(verifier);
      const designated = integration.currentDesignatedReviewer(dispatchRoot, verdict.reviewRound);
      if (!mapping || !mapping.docToken || !designated
        || designated.designatedReviewerRef !== verdict.designatedReviewerRef
        || designated.reviewerId !== verdict.reviewerId
        || designated.reviewerBotAppId !== verdict.reviewerBotAppId
        || !sameStrings(designated.taskSetSnapshot, verdict.taskSetSnapshot)
        || verdict.projectId !== mapping.projectId || verdict.phaseId !== mapping.phaseId
        || verdict.taskGuid !== mapping.taskGuid || verdict.topicRootId !== mapping.topicRootId
        || verdict.docToken !== mapping.docToken
        || verdict.keyId !== reviewerVerdictKeyId(designated.reviewerBotAppId)
        || attestation.reviewerId !== verdict.reviewerId || attestation.reviewerBotAppId !== verdict.reviewerBotAppId
        || attestation.sessionId !== verdict.sessionId || attestation.workerGeneration !== verdict.workerGeneration
        || attestation.capabilityHash !== verdict.capabilityHash) {
        integration.reviewerVerdictUnknown(dispatchRoot, verdict.verdictId, 'reviewer_verdict_designation_unproven');
        jsonRes(res, 409, { ok: false, error: 'task_control_reviewer_verdict_designation_unproven' });
        return;
      }
      const head = integration.submitVerifiedReviewerVerdict({
        dispatchRoot, verdict, attestation, verifier, expectedReviewerBotAppId: designated.reviewerBotAppId,
        expectedReviewerId: designated.reviewerId, now: new Date().toISOString(),
      });
      if (head.status !== 'active') {
        jsonRes(res, 409, { ok: false, error: head.reason ?? 'task_control_reviewer_verdict_unproven' });
        return;
      }
      jsonRes(res, 201, { ok: true, verdictId: verdict.verdictId });
    },
  };
}
