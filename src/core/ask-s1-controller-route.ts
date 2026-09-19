import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  type AskApiS1ExecutionBody,
  askPathClassificationForPath,
  parseAskBody,
  validateAskRouteContract,
  type AskApiS1ControllerBody,
} from './ask-api.js';
import {
  ipcRoute,
  isTrustedHostIpcRequest,
  jsonRes,
  readJsonBody,
} from './dashboard-ipc-server.js';
import {
  AskS1WindowExpiredError,
} from './ask-broker.js';
import {
  authorizeSessionScopedIpc,
  type SessionScopedIpcIdentity,
} from './daemon-ipc-session-auth.js';
import type { AskResult, CreateAskInput } from './ask-types.js';
import { getSessionPersistentBackendType } from './persistent-backend.js';
import type { DaemonSession } from './types.js';
import type { VcMeetingLiveManagedOrigin } from '../services/vc-meeting-send-policy.js';

export interface AskS1ControllerBindingBody extends AskApiS1ControllerBody {
  phase: 'binding';
}

export interface AskS1ControllerExecutionBody extends AskApiS1ControllerBody {
  phase: 'execution';
  sessionId: string;
  rootMessageId: string;
  originCapability?: string;
  originTurnId?: string;
  originDispatchAttempt?: number;
}

export type AskS1ControllerParsedBody =
  | AskS1ControllerBindingBody
  | AskS1ControllerExecutionBody;

export interface AskS1ControllerExecutionBinding extends SessionScopedIpcIdentity {
  chatType?: 'group' | 'p2p';
  backendSurvivesRestart?: boolean;
  capability?: string;
}

export type AskS1ControllerSelectionError =
  | 'binding_mismatch'
  | 'session_selector_unresolved'
  | 'authority_unavailable'
  | 'store_unavailable';

export type AskS1ControllerSelectionResult =
  | { ok: true; binding: AskS1ControllerExecutionBinding }
  | { ok: false; error: AskS1ControllerSelectionError };

export type AskS1ControllerRegisterResult =
  | { ok: true; result: AskResult }
  | {
      ok: false;
      error: 'binding_mismatch' | 'recovery_expired' | 'authority_unavailable' | 'store_unavailable';
    };

export type AskS1ControllerRecoverResult =
  | { ok: true; result: Extract<AskResult, { kind: 'answered' }> }
  | {
      ok: false;
      error: 'receipt_not_found' | 'binding_mismatch' | 'recovery_expired' | 'store_unavailable';
    };

export interface AskS1ControllerSelectInput {
  body: AskS1ControllerParsedBody;
  recoverOnly: boolean;
  trustedHost: boolean;
}

export interface AskS1ControllerRegisterInput {
  body: AskS1ControllerParsedBody;
  binding: AskS1ControllerExecutionBinding;
  ask: CreateAskInput;
}

export interface AskS1ControllerRecoverInput {
  body: AskS1ControllerParsedBody;
  binding: AskS1ControllerExecutionBinding;
  now: number;
}

export interface AskS1ControllerRouteDeps {
  selectBinding(
    input: AskS1ControllerSelectInput,
  ): Promise<AskS1ControllerSelectionResult> | AskS1ControllerSelectionResult;
  register(
    input: AskS1ControllerRegisterInput,
  ): Promise<AskS1ControllerRegisterResult> | AskS1ControllerRegisterResult;
  recover(
    input: AskS1ControllerRecoverInput,
  ): Promise<AskS1ControllerRecoverResult> | AskS1ControllerRecoverResult;
  now?: () => number;
}

export interface AskS1ControllerSelectorDeps {
  listActiveSessions(): DaemonSession[];
  findActiveBySessionId(sessionId: string): DaemonSession | undefined;
  getLiveOrigin?(session: DaemonSession): VcMeetingLiveManagedOrigin | undefined;
  hasLarkTransport(session: DaemonSession): boolean;
}

export function classifyS1ControllerRegisterThrownError(
  err: unknown,
): Extract<AskS1ControllerRegisterResult, { ok: false }>['error'] | undefined {
  return err instanceof AskS1WindowExpiredError ? 'recovery_expired' : undefined;
}

function eligibleS1BindingSession(
  candidate: DaemonSession,
  body: AskS1ControllerParsedBody,
  deps: AskS1ControllerSelectorDeps,
): boolean {
  return candidate.session.status === 'active'
    && !candidate.session.vcMeetingReceiver
    && candidate.larkAppId === body.larkAppId
    && candidate.chatId === body.chatId
    && candidate.scope === 'thread'
    && typeof candidate.session.rootMessageId === 'string'
    && candidate.session.rootMessageId.length > 0
    && getSessionPersistentBackendType(candidate) !== undefined
    && deps.hasLarkTransport(candidate);
}

function executionBindingFromSession(
  selected: DaemonSession,
  capability?: string,
): AskS1ControllerExecutionBinding {
  return {
    sessionId: selected.session.sessionId,
    larkAppId: selected.larkAppId,
    chatId: selected.chatId,
    rootMessageId: selected.session.rootMessageId!,
    chatType: selected.chatType,
    backendSurvivesRestart: getSessionPersistentBackendType(selected) !== undefined,
    ...(capability ? { capability } : {}),
  };
}

export function selectS1ControllerBinding(
  input: AskS1ControllerSelectInput,
  deps: AskS1ControllerSelectorDeps,
): AskS1ControllerSelectionResult {
  if (input.body.phase === 'binding') {
    if (!input.trustedHost) return { ok: false, error: 'binding_mismatch' };
    const matches = deps.listActiveSessions().filter((candidate) => eligibleS1BindingSession(candidate, input.body, deps));
    if (matches.length !== 1) return { ok: false, error: 'session_selector_unresolved' };
    return { ok: true, binding: executionBindingFromSession(matches[0]!) };
  }

  const execution = input.body as AskS1ControllerExecutionBody;
  const selected = deps.findActiveBySessionId(execution.sessionId);
  if (!selected || !eligibleS1BindingSession(selected, input.body, deps)) {
    return { ok: false, error: 'binding_mismatch' };
  }
  if (selected.session.rootMessageId !== execution.rootMessageId
      || selected.larkAppId !== execution.larkAppId
      || selected.chatId !== execution.chatId) {
    return { ok: false, error: 'binding_mismatch' };
  }
  const authorized = authorizeSessionScopedIpc({
    trustedHost: input.trustedHost,
    sessionExists: true,
    receiverSession: !!selected.session.vcMeetingReceiver,
    allowReceiver: false,
    sessionId: selected.session.sessionId,
    liveOrigin: deps.getLiveOrigin?.(selected),
    claimedCapability: execution.originCapability,
    claimedTurnId: execution.originTurnId,
    claimedDispatchAttempt: execution.originDispatchAttempt,
  });
  if (!authorized.ok) return { ok: false, error: 'binding_mismatch' };
  return {
    ok: true,
    binding: executionBindingFromSession(selected, execution.originCapability),
  };
}

function buildS1CreateAskInput(
  body: AskS1ControllerParsedBody,
  binding: AskS1ControllerExecutionBinding,
  deadlineAt: number,
): CreateAskInput {
  return {
    larkAppId: binding.larkAppId,
    chatId: binding.chatId,
    rootMessageId: binding.rootMessageId,
    sessionId: binding.sessionId,
    requestId: body.requestId,
    originKind: 's1-controller',
    backendSurvivesRestart: binding.backendSurvivesRestart,
    questions: body.questions,
    timeoutMs: body.timeoutMs,
    deadlineAt,
    notBeforeMs: body.notBeforeMs,
    expiresAtMs: body.expiresAtMs,
    chatType: binding.chatType,
  };
}

function selectorStatus(error: AskS1ControllerSelectionError): 409 | 503 {
  return error === 'authority_unavailable' || error === 'store_unavailable'
    ? 503
    : 409;
}

function registerStatus(error: Extract<AskS1ControllerRegisterResult, { ok: false }>['error']): 409 | 410 | 503 {
  if (error === 'binding_mismatch') return 409;
  if (error === 'recovery_expired') return 410;
  return 503;
}

function recoverStatus(
  error: Extract<AskS1ControllerRecoverResult, { ok: false }>['error'],
): 404 | 409 | 410 | 503 {
  switch (error) {
    case 'receipt_not_found':
      return 404;
    case 'binding_mismatch':
      return 409;
    case 'recovery_expired':
      return 410;
    case 'store_unavailable':
      return 503;
  }
  const exhaustive: never = error;
  throw new Error(`unhandled recover status: ${String(exhaustive)}`);
}

export async function handleAskS1ControllerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: '/api/asks/s1-controller' | '/api/asks/s1-controller/recover',
  deps: AskS1ControllerRouteDeps,
): Promise<void> {
  const route = askPathClassificationForPath(pathname);
  if (!route || route.originKind !== 's1-controller') {
    return jsonRes(res, 404, { ok: false, error: 'not_found' });
  }

  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }

  const parsed = parseAskBody(raw);
  if ('error' in parsed) {
    return jsonRes(res, 400, { ok: false, error: parsed.error });
  }

  const now = deps.now?.() ?? Date.now();
  const contract = validateAskRouteContract(parsed, route, now);
  if (!contract.ok) {
    return jsonRes(res, contract.status, { ok: false, error: contract.error });
  }

  const trustedHost = isTrustedHostIpcRequest(req);
  const body = parsed as AskS1ControllerParsedBody;
  if (body.phase === 'binding' && !trustedHost) {
    return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  }
  const selected = await deps.selectBinding({
    body,
    recoverOnly: route.recoverOnly,
    trustedHost,
  });
  if (!selected.ok) {
    return jsonRes(res, selectorStatus(selected.error), { ok: false, error: selected.error });
  }

  if (route.recoverOnly) {
    const recovered = await deps.recover({
      body,
      binding: selected.binding,
      now,
    });
    if (!recovered.ok) {
      return jsonRes(res, recoverStatus(recovered.error), { ok: false, error: recovered.error });
    }
    return jsonRes(res, 200, recovered.result);
  }

  // A retry of the initial endpoint after the terminal commit must replay the
  // exact durable result. Checking before register also closes the race window
  // where response loss would otherwise create a second card.
  const existing = await deps.recover({ body, binding: selected.binding, now });
  if (existing.ok) return jsonRes(res, 200, existing.result);
  if (existing.error !== 'receipt_not_found') {
    return jsonRes(res, recoverStatus(existing.error), { ok: false, error: existing.error });
  }

  const registerNow = deps.now?.() ?? Date.now();
  if (registerNow >= contract.deadlineAt) {
    return jsonRes(res, 410, { ok: false, error: 'recovery_expired' });
  }

  const ask = buildS1CreateAskInput(body, selected.binding, contract.deadlineAt);
  const registered = await deps.register({
    body,
    binding: selected.binding,
    ask,
  });
  if (!registered.ok) {
    return jsonRes(res, registerStatus(registered.error), { ok: false, error: registered.error });
  }
  return jsonRes(res, 200, registered.result);
}

export function registerAskS1ControllerIpcRoutes(deps: AskS1ControllerRouteDeps): void {
  for (const pathname of ['/api/asks/s1-controller', '/api/asks/s1-controller/recover'] as const) {
    ipcRoute('POST', pathname, async (req, res) => {
      await handleAskS1ControllerRoute(req, res, pathname, deps);
    });
  }
}
