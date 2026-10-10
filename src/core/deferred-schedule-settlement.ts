import type { DaemonSession } from './types.js';

export type DeferredScheduleSettlementResult =
  | { action: 'ignored' }
  | { action: 'suspended'; rootMessageId?: string }
  | { action: 'retained'; rootMessageId?: string };

/** Execute the exact-turn lifecycle decision after a temporary schedule run
 * reaches a terminal/idle edge. Timer debounce lives in daemon.ts; keeping the
 * decision here makes the preserve-and-suspend contract independently testable. */
export async function settleDeferredScheduleRun(
  ds: DaemonSession,
  context: { turnId: string; source: 'terminal' | 'idle' },
  deps: {
    reconcile: (ds: DaemonSession) => string | undefined;
    /** Returns false when a current turn, queued input, or in-flight tool owns the worker. */
    suspend: (ds: DaemonSession, turnId: string) => boolean;
  },
): Promise<DeferredScheduleSettlementResult> {
  const run = ds.session.deferredScheduleRun;
  if (!run || run.turnId !== context.turnId || ds.session.status === 'closed') {
    return { action: 'ignored' };
  }
  if (context.source === 'idle' && ds.lastScreenStatus !== 'idle') {
    return { action: 'ignored' };
  }
  const rootMessageId = deps.reconcile(ds);
  const result = deps.suspend(ds, context.turnId);
  return result
    ? { action: 'suspended', ...(rootMessageId ? { rootMessageId } : {}) }
    : { action: 'retained', ...(rootMessageId ? { rootMessageId } : {}) };
}
