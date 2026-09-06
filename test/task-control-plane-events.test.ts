import { describe, expect, it } from 'vitest';
import { TaskControlEventAdapters, taskControlEventIdempotencyKey } from '../src/services/task-control-plane-events.js';
import type { TaskControlPlaneLifecycle } from '../src/services/task-control-plane-runtime.js';

describe('TaskControlEventAdapters', () => {
  it('forwards only supplied stable references and never derives state from body or exit status', () => {
    const appended: any[] = [];
    const lifecycle: TaskControlPlaneLifecycle = {
      enabled: true,
      append: event => appended.push(event),
      appendUnknownObservation: () => {},
      enqueueUnknownObservation: () => {},
      close: async () => {},
    };
    const adapters = new TaskControlEventAdapters(lifecycle);
    const authentication = {} as any;
    adapters.dispatchRequested({
      projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root',
      eventId: 'evt-dispatch', sourceRef: 'dispatch:om_seed',
      idempotencyKey: taskControlEventIdempotencyKey('task.dispatch_requested', 'dispatch:om_seed'),
      authentication, payload: { title: 'untrusted display title', reportBody: 'PASS', exitCode: 0 },
    });
    expect(appended).toEqual([expect.objectContaining({
      eventType: 'task.dispatch_requested', eventId: 'evt-dispatch', sourceRef: 'dispatch:om_seed',
      idempotencyKey: 'task-control:task.dispatch_requested:dispatch:om_seed',
    })]);
  });
});
