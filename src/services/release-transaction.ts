import {
  appendReleaseJournalEvent,
  createReleaseTransaction,
  inspectReleaseTransaction,
  withReleaseTransactionExecutionLock,
  type ReleaseJournalEvent,
  type ReleaseTransactionReceipt,
  type ReleaseTransactionRequest,
} from './release-transaction-store.js';

export interface ReleaseObservedState {
  layout: 'old-dist-old-runtime' | 'new-dist-old-runtime' | 'new-dist-new-runtime' | 'old-dist-new-runtime' | 'unknown';
  artifactTreeHash: string | null;
  stagedArtifactTreeHash: string | null;
  rollbackTreeHash: string | null;
  runtimeHash: string | null;
  sameFilesystem: boolean;
  serviceInspectable: boolean;
  serviceActive: boolean;
  fleetHealthy: boolean;
  cgroupHealthy: boolean;
  liveBehaviorHealthy: boolean;
  completionGateHealthy: boolean;
  evidence?: Record<string, unknown>;
}

export interface ReleaseTransactionAdapters {
  now(): string;
  inspect(request: ReleaseTransactionRequest): ReleaseObservedState;
  renameCurrentToRollback(request: ReleaseTransactionRequest): void;
  renameStagedToCurrent(request: ReleaseTransactionRequest): void;
  renameCurrentToStaged(request: ReleaseTransactionRequest): void;
  renameRollbackToCurrent(request: ReleaseTransactionRequest): void;
  restart(request: ReleaseTransactionRequest): void;
  withExclusive?<T>(fn: () => T): T;
  close?(): void;
}

export interface RunReleaseTransactionOptions {
  dataDir: string;
  request: ReleaseTransactionRequest;
  expectedBarrier: {
    state: 'frozen' | 'transaction_active';
    barrierId: string;
    revision: number;
    authorizationRef: string;
  };
  env: NodeJS.ProcessEnv;
  adapters: ReleaseTransactionAdapters;
}

function runReleaseTransactionLocked(
  options: RunReleaseTransactionOptions,
): ReleaseTransactionReceipt {
  const { dataDir, request, expectedBarrier, env, adapters } = options;
  let receipt = inspectReleaseTransaction(dataDir, request.transactionId);

  const append = (
    type: string,
    phase: 'prepare' | 'commit' | 'verify' | 'rollback',
    action?: string,
    details?: Record<string, unknown>,
  ): ReleaseJournalEvent => appendReleaseJournalEvent(dataDir, request.transactionId, {
    at: adapters.now(), type, phase, ...(action ? { action } : {}), ...(details ? { details } : {}),
  });
  const refresh = (): ReleaseTransactionReceipt => {
    receipt = inspectReleaseTransaction(dataDir, request.transactionId);
    return receipt;
  };
  const hasEvent = (type: string, action?: string): boolean =>
    receipt.events.some(event => event.type === type && (action === undefined || event.action === action));
  const terminal = (
    status: 'verified' | 'rolled_back' | 'rollback_failed' | 'unknown',
    phase: 'verify' | 'rollback',
    details: Record<string, unknown> = {},
  ): ReleaseTransactionReceipt => {
    append('terminal', phase, undefined, { status, ...details });
    return refresh();
  };
  const stateMatchesTerminal = (state: ReleaseObservedState, status: 'verified' | 'rolled_back'): boolean => {
    const hostHealthy = state.sameFilesystem && state.serviceInspectable
      && state.serviceActive && state.fleetHealthy && state.cgroupHealthy;
    if (status === 'verified') {
      return state.layout === 'new-dist-new-runtime'
        && state.artifactTreeHash === request.artifactTreeHash
        && state.runtimeHash === request.targetRuntimeHash
        && hostHealthy
        && state.liveBehaviorHealthy
        && state.completionGateHealthy;
    }
    return state.layout === 'old-dist-old-runtime'
      && state.artifactTreeHash === request.rollbackTreeHash
      && state.runtimeHash === request.oldRuntimeHash
      && hostHealthy;
  };

  if (receipt.status === 'verified' || receipt.status === 'rolled_back') {
    const observed = adapters.inspect(request);
    if (!stateMatchesTerminal(observed, receipt.status)) {
      return terminal('unknown', receipt.status === 'verified' ? 'verify' : 'rollback', {
        reason: 'terminal_receipt_state_conflict', observed,
      });
    }
    return receipt;
  }
  if (receipt.status === 'rollback_failed' || receipt.status === 'unknown') return receipt;

  if (expectedBarrier.barrierId !== request.barrierId
      || expectedBarrier.revision !== request.barrierRevision
      || expectedBarrier.authorizationRef !== request.authorizationRef
      || !['frozen', 'transaction_active'].includes(expectedBarrier.state)) {
    throw new Error('release_barrier_mismatch');
  }
  if (env.XDG_RUNTIME_DIR !== '/run/user/0'
      || env.DBUS_SESSION_BUS_ADDRESS !== 'unix:path=/run/user/0/bus') {
    throw new Error('release_systemd_bus_invalid');
  }

  let observed = adapters.inspect(request);
  const unresolvedIntent = receipt.events.find(event => event.type === 'intent' && event.action
    && !receipt.events.some(candidate => candidate.type === 'result' && candidate.action === event.action));
  if (unresolvedIntent) {
    const actionCompleted = (
      unresolvedIntent.action === 'rename_current_to_rollback'
        && observed.artifactTreeHash === null
        && observed.stagedArtifactTreeHash === request.artifactTreeHash
        && observed.rollbackTreeHash === request.rollbackTreeHash
        && observed.runtimeHash === request.oldRuntimeHash
    ) || (
      unresolvedIntent.action === 'rename_staged_to_current'
        && ['new-dist-old-runtime', 'new-dist-new-runtime'].includes(observed.layout)
        && observed.artifactTreeHash === request.artifactTreeHash
        && observed.stagedArtifactTreeHash === null
        && observed.rollbackTreeHash === request.rollbackTreeHash
    ) || (
      unresolvedIntent.action === 'restart'
        && observed.layout === 'new-dist-new-runtime'
        && observed.runtimeHash === request.targetRuntimeHash
    ) || (
      unresolvedIntent.action === 'rename_current_to_staged'
        && observed.artifactTreeHash === null
        && observed.stagedArtifactTreeHash === request.artifactTreeHash
        && observed.rollbackTreeHash === request.rollbackTreeHash
    ) || (
      unresolvedIntent.action === 'rename_rollback_to_current'
        && ['old-dist-new-runtime', 'old-dist-old-runtime'].includes(observed.layout)
        && observed.artifactTreeHash === request.rollbackTreeHash
        && observed.rollbackTreeHash === null
    ) || (
      unresolvedIntent.action === 'rollback_restart'
        && observed.layout === 'old-dist-old-runtime'
        && observed.runtimeHash === request.oldRuntimeHash
    );
    if (!actionCompleted) {
      return terminal('unknown', unresolvedIntent.phase === 'rollback' ? 'rollback' : 'verify', {
        reason: 'intent_outcome_unproven',
        action: unresolvedIntent.action,
        observed,
      });
    }
    append('result', unresolvedIntent.phase === 'rollback' ? 'rollback' : 'commit', unresolvedIntent.action, {
      ok: true, recoveredFromObservedState: true,
    });
    refresh();
  }
  if (!observed.serviceInspectable) throw new Error('release_systemd_unit_uninspectable');
  if (!observed.sameFilesystem) throw new Error('release_cross_filesystem_swap');
  if (!['old-dist-old-runtime', 'new-dist-old-runtime', 'new-dist-new-runtime'].includes(observed.layout)) {
    throw new Error('release_prepare_layout_unknown');
  }
  const oldLayoutValid = observed.layout !== 'old-dist-old-runtime'
    || (observed.artifactTreeHash === request.rollbackTreeHash
      && observed.stagedArtifactTreeHash === request.artifactTreeHash
      && (observed.rollbackTreeHash === null || observed.rollbackTreeHash === request.rollbackTreeHash)
      && observed.runtimeHash === request.oldRuntimeHash);
  const newOldLayoutValid = observed.layout !== 'new-dist-old-runtime'
    || (observed.artifactTreeHash === request.artifactTreeHash
      && observed.stagedArtifactTreeHash === null
      && observed.rollbackTreeHash === request.rollbackTreeHash
      && observed.runtimeHash === request.oldRuntimeHash);
  const newNewLayoutValid = observed.layout !== 'new-dist-new-runtime'
    || (observed.artifactTreeHash === request.artifactTreeHash
      && observed.stagedArtifactTreeHash === null
      && observed.rollbackTreeHash === request.rollbackTreeHash
      && observed.runtimeHash === request.targetRuntimeHash);
  if (!oldLayoutValid || !newOldLayoutValid || !newNewLayoutValid) {
    throw new Error('release_prepare_identity_mismatch');
  }
  if (!hasEvent('prepared')) {
    append('prepared', 'prepare', undefined, {
      layout: observed.layout,
      artifactTreeHash: observed.artifactTreeHash,
      runtimeHash: observed.runtimeHash,
      systemdBus: 'validated',
    });
    refresh();
  }

  const runAction = (phase: 'commit' | 'rollback', action: string, fn: () => void): void => {
    if (hasEvent('result', action)) return;
    if (!hasEvent('intent', action)) append('intent', phase, action);
    fn();
    append('result', phase, action, { ok: true });
    refresh();
  };

  try {
    if (observed.layout === 'old-dist-old-runtime') {
      runAction('commit', 'rename_current_to_rollback', () => adapters.renameCurrentToRollback(request));
      runAction('commit', 'rename_staged_to_current', () => adapters.renameStagedToCurrent(request));
      observed = adapters.inspect(request);
    }
    if (observed.layout === 'new-dist-old-runtime') {
      if (hasEvent('result', 'restart')) {
        return terminal('unknown', 'verify', {
          reason: 'confirmed_restart_runtime_conflict', observed,
        });
      }
      runAction('commit', 'restart', () => adapters.restart(request));
      observed = adapters.inspect(request);
    }
    if (observed.layout !== 'new-dist-new-runtime'
        || observed.artifactTreeHash !== request.artifactTreeHash
        || observed.runtimeHash !== request.targetRuntimeHash) {
      throw new Error('release_verify_identity_mismatch');
    }
    const requiredChecks = {
      serviceActive: observed.serviceActive,
      fleetHealthy: observed.fleetHealthy,
      cgroupHealthy: observed.cgroupHealthy,
      liveBehaviorHealthy: observed.liveBehaviorHealthy,
      completionGateHealthy: observed.completionGateHealthy,
    };
    if (Object.values(requiredChecks).some(value => value !== true)) {
      throw new Error('release_verify_required_check_failed');
    }
    append('verified_checks', 'verify', undefined, requiredChecks);
    return terminal('verified', 'verify', { observed });
  } catch (error) {
    if (!hasEvent('rollback_started')) {
      append('rollback_started', 'rollback', undefined, {
        cause: error instanceof Error ? error.message : String(error),
      });
      refresh();
    }
  }

  try {
    observed = adapters.inspect(request);
    if (observed.artifactTreeHash === request.artifactTreeHash) {
      runAction('rollback', 'rename_current_to_staged', () => adapters.renameCurrentToStaged(request));
      runAction('rollback', 'rename_rollback_to_current', () => adapters.renameRollbackToCurrent(request));
    }
    runAction('rollback', 'rollback_restart', () => adapters.restart(request));
    observed = adapters.inspect(request);
    const rollbackHealthy = observed.layout === 'old-dist-old-runtime'
      && observed.artifactTreeHash === request.rollbackTreeHash
      && observed.runtimeHash === request.oldRuntimeHash
      && observed.serviceActive
      && observed.fleetHealthy
      && observed.cgroupHealthy;
    if (!rollbackHealthy) throw new Error('release_rollback_verification_failed');
    append('rollback_verified', 'rollback', undefined, { observed });
    return terminal('rolled_back', 'rollback', { observed });
  } catch (error) {
    observed = adapters.inspect(request);
    return terminal('rollback_failed', 'rollback', {
      cause: error instanceof Error ? error.message : String(error),
      residualEvidence: observed,
    });
  }
}

export function runReleaseTransaction(
  options: RunReleaseTransactionOptions,
): ReleaseTransactionReceipt {
  const execute = (): ReleaseTransactionReceipt => {
    createReleaseTransaction(options.dataDir, options.request);
    return withReleaseTransactionExecutionLock(
      options.dataDir,
      options.request.transactionId,
      () => runReleaseTransactionLocked(options),
    );
  };
  return options.adapters.withExclusive
    ? options.adapters.withExclusive(execute)
    : execute();
}
