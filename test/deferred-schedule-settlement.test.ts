import { describe, expect, it, vi } from 'vitest';
import { settleDeferredScheduleRun } from '../src/core/deferred-schedule-settlement.js';
import type { DaemonSession } from '../src/core/types.js';

function makeSession(): DaemonSession {
  return {
    session: {
      sessionId: 'sess-deferred',
      chatId: 'oc_chat',
      rootMessageId: 'schedule-run:task-1:run-1',
      title: 'hidden schedule',
      status: 'active',
      createdAt: '2026-07-21T00:00:00.000Z',
      scope: 'chat',
      deferredScheduleRun: {
        taskId: 'task-1',
        turnId: 'schedule:task-1:run-1',
        routingAnchor: 'schedule-run:task-1:run-1',
        createdAt: '2026-07-21T00:00:00.000Z',
      },
    },
    scope: 'chat',
    chatId: 'oc_chat',
    larkAppId: 'cli_app',
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

describe('deferred schedule turn settlement', () => {
  it('suspends an unmaterialized hidden run at exact terminal completion without closing its evidence', async () => {
    const ds = makeSession();
    const suspend = vi.fn(() => true);
    const result = await settleDeferredScheduleRun(ds, {
      turnId: 'schedule:task-1:run-1', source: 'terminal',
    }, { reconcile: () => undefined, suspend });

    expect(result).toEqual({ action: 'suspended' });
    expect(suspend).toHaveBeenCalledWith(ds, 'schedule:task-1:run-1');
    expect(ds.session.status).toBe('active');
  });

  it('suspends a materialized run after preserving its reply-thread evidence', async () => {
    const suspend = vi.fn(() => true);
    const result = await settleDeferredScheduleRun(makeSession(), {
      turnId: 'schedule:task-1:run-1', source: 'terminal',
    }, { reconcile: () => 'om_materialized', suspend });

    expect(result).toEqual({ action: 'suspended', rootMessageId: 'om_materialized' });
    expect(suspend).toHaveBeenCalledTimes(1);
  });

  it('ignores stale turn edges and non-idle screen fallbacks', async () => {
    const ds = makeSession();
    const suspend = vi.fn(() => true);
    const deps = { reconcile: vi.fn(() => undefined), suspend };

    expect(await settleDeferredScheduleRun(ds, {
      turnId: 'schedule:task-1:stale', source: 'terminal',
    }, deps)).toEqual({ action: 'ignored' });
    ds.lastScreenStatus = 'working';
    expect(await settleDeferredScheduleRun(ds, {
      turnId: 'schedule:task-1:run-1', source: 'idle',
    }, deps)).toEqual({ action: 'ignored' });
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();
  });

  it('settles a matching idle edge for a screen-only adapter', async () => {
    const ds = makeSession();
    const suspend = vi.fn(() => true);

    const result = await settleDeferredScheduleRun(ds, {
      turnId: 'schedule:task-1:run-1', source: 'idle',
    }, { reconcile: () => undefined, suspend });

    expect(result).toEqual({ action: 'suspended' });
    expect(suspend).toHaveBeenCalledWith(ds, 'schedule:task-1:run-1');
  });

  it('retains the worker when a newer turn, queued input, or tool still owns it', async () => {
    const suspend = vi.fn(() => false);

    const result = await settleDeferredScheduleRun(makeSession(), {
      turnId: 'schedule:task-1:run-1', source: 'terminal',
    }, { reconcile: () => undefined, suspend });

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ action: 'retained' });
  });
});
