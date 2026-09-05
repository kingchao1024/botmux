import { describe, expect, it } from 'vitest';
import { TaskControlActiveCollector } from '../src/services/task-control-plane-collector.js';
import type { TaskControlPlaneLifecycle } from '../src/services/task-control-plane-runtime.js';

describe('TaskControlActiveCollector', () => {
  it('only records stable read observations and never calls a remote writer', async () => {
    const appended: any[] = [];
    const lifecycle: TaskControlPlaneLifecycle = {
      enabled: true, append: input => { appended.push({ kind: 'event', input }); },
      appendUnknownObservation: input => { appended.push({ kind: 'observation', input }); }, close: async () => {},
    };
    const calls: any[] = [];
    const collector = new TaskControlActiveCollector(lifecycle, {
      list: async input => {
        calls.push(input);
        return { records: [{
          kind: 'doc_revision', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root',
          sourceRef: 'doc:doc-token@7', eventId: 'collector-doc-7', idempotencyKey: 'doc:doc-token@7',
        }], nextCursor: 'next-cursor' };
      },
    });
    expect(await collector.collect('doc_revision')).toBe(1);
    expect(calls).toEqual([{ kind: 'doc_revision', cursor: undefined }]);
    expect(appended).toEqual([expect.objectContaining({
      kind: 'observation', input: expect.objectContaining({
        attemptedEventType: 'unknown.declared', eventId: 'collector-doc-7', sourceRef: 'doc:doc-token@7',
        payload: expect.objectContaining({ collectionKind: 'doc_revision' }),
      }),
    })]);
  });
});
