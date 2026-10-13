import type { RepositoryIdentity } from './git-worktree.js';
import {
  abandonRepositoryWriter,
  bindRepositoryWriterGeneration,
  heartbeatRepositoryWriter,
  readRepositoryControl,
  type RepositoryLeaseRef,
} from './repository-control.js';

export interface RepositoryLeaseRuntimeBinding {
  identity: RepositoryIdentity;
  leaseRef: RepositoryLeaseRef;
  dispatchRoot: string;
  workerAppId: string;
  workingDir: string;
  sessionId: string;
  workerGeneration: number;
}
export type ActiveRepositoryLeaseRuntimeBinding = Omit<RepositoryLeaseRuntimeBinding, 'leaseRef'> & {
  leaseRef?: RepositoryLeaseRef;
};
export interface RepositoryLeaseRuntimeHandle {
  ready: Promise<void>;
  stop(): void;
  generationTerminated(evidence: Record<string, unknown>): void;
}
export class RepositoryLeaseRuntime {
  constructor(
    private readonly dataDir: string,
    private readonly options: {
      heartbeatIntervalMs?: number;
      attachRetryIntervalMs?: number;
      attachTimeoutMs?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {}
  attachActive(binding: ActiveRepositoryLeaseRuntimeBinding): RepositoryLeaseRuntimeHandle | undefined {
    if (binding.leaseRef) return this.attach({ ...binding, leaseRef: binding.leaseRef });
    const currentLease = readRepositoryControl(this.dataDir, binding.identity).writerLease;
    if (!currentLease) return undefined;
    if (currentLease.dispatchRoot !== binding.dispatchRoot) {
      if (currentLease.workerAppId === binding.workerAppId
          && currentLease.workingDir === binding.workingDir
          && currentLease.generationBoundAt === undefined) {
        return this.attachPending(binding);
      }
      return undefined;
    }
    return this.attach({
      ...binding,
      leaseRef: {
        repoKey: currentLease.repoKey,
        leaseId: currentLease.leaseId,
        fencingToken: currentLease.fencingToken,
        workingDir: currentLease.workingDir,
      },
    });
  }
  private attachPending(binding: ActiveRepositoryLeaseRuntimeBinding): RepositoryLeaseRuntimeHandle {
    const startedAt = Date.now();
    const intervalMs = this.options.attachRetryIntervalMs ?? 25;
    const timeoutMs = this.options.attachTimeoutMs ?? 5_000;
    let delegate: RepositoryLeaseRuntimeHandle | undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectReady: (error: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      const retry = (): void => {
        if (stopped) return;
        try {
          const lease = readRepositoryControl(this.dataDir, binding.identity).writerLease;
          if (!lease) throw new Error('repository_lease_missing');
          if (lease.dispatchRoot === binding.dispatchRoot) {
            delegate = this.attach({
              ...binding,
              leaseRef: {
                repoKey: lease.repoKey, leaseId: lease.leaseId, fencingToken: lease.fencingToken,
                workingDir: lease.workingDir,
              },
            });
            resolve();
            return;
          }
          if (lease.workerAppId !== binding.workerAppId || lease.workingDir !== binding.workingDir
              || lease.generationBoundAt !== undefined) {
            throw new Error('repository_lease_binding_mismatch');
          }
          if (Date.now() - startedAt >= timeoutMs) throw new Error('repository_lease_dispatch_root_pending');
          timer = setTimeout(retry, intervalMs);
          timer.unref?.();
        } catch (error) {
          stopped = true;
          this.options.onError?.(error);
          reject(error);
        }
      };
      timer = setTimeout(retry, intervalMs);
      timer.unref?.();
    });
    return {
      ready,
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        delegate?.stop();
        if (!delegate) rejectReady(new Error('repository_lease_attach_cancelled'));
      },
      generationTerminated: evidence => {
        if (delegate) delegate.generationTerminated(evidence);
        else {
          stopped = true;
          if (timer) clearTimeout(timer);
          rejectReady(new Error('repository_lease_generation_terminated_before_attach'));
        }
      },
    };
  }
  attach(binding: RepositoryLeaseRuntimeBinding): RepositoryLeaseRuntimeHandle {
    if (binding.leaseRef.repoKey !== binding.identity.repoKey) throw new Error('repository_lease_identity_mismatch');
    bindRepositoryWriterGeneration(this.dataDir, {
      identity: binding.identity,
      operationId: `${binding.leaseRef.leaseId}:bind:${binding.sessionId}:${binding.workerGeneration}`,
      leaseId: binding.leaseRef.leaseId,
      fencingToken: binding.leaseRef.fencingToken,
      dispatchRoot: binding.dispatchRoot,
      workerAppId: binding.workerAppId,
      workingDir: binding.workingDir,
      sessionId: binding.sessionId,
      workerGeneration: binding.workerGeneration,
      now: new Date().toISOString(),
    });
    let stopped = false;
    let heartbeatSequence = 0;
    let timer: ReturnType<typeof setInterval>;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    };
    timer = setInterval(() => {
      if (stopped) return;
      heartbeatSequence += 1;
      try {
        heartbeatRepositoryWriter(this.dataDir, {
          identity: binding.identity,
          operationId: `${binding.leaseRef.leaseId}:heartbeat:${heartbeatSequence}`,
          leaseId: binding.leaseRef.leaseId,
          fencingToken: binding.leaseRef.fencingToken,
          sessionId: binding.sessionId,
          workerGeneration: binding.workerGeneration,
          now: new Date().toISOString(),
        });
      } catch (error) {
        stop();
        this.options.onError?.(error);
      }
    }, this.options.heartbeatIntervalMs ?? 15_000);
    timer.unref?.();
    return {
      ready: Promise.resolve(),
      stop,
      generationTerminated: evidence => {
        if (stopped) return;
        stop();
        abandonRepositoryWriter(this.dataDir, {
          identity: binding.identity,
          operationId: `${binding.leaseRef.leaseId}:generation-terminated`,
          leaseId: binding.leaseRef.leaseId,
          fencingToken: binding.leaseRef.fencingToken,
          sessionId: binding.sessionId,
          workerGeneration: binding.workerGeneration,
          terminationEvidence: structuredClone(evidence),
          now: typeof evidence.observedAt === 'string' ? evidence.observedAt : new Date().toISOString(),
        });
      },
    };
  }
}
