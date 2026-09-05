import type { TaskControlPlaneLifecycle } from './task-control-plane-runtime.js';

export type TaskControlCollectionKind = 'task' | 'task_comment' | 'topic' | 'doc_revision';

export interface TaskControlCollectedRecord {
  kind: TaskControlCollectionKind;
  projectId: string;
  phaseId: string;
  taskGuid: string;
  topicRootId: string;
  sourceRef: string;
  eventId: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}

export interface TaskControlCollectionSource {
  list(input: { kind: TaskControlCollectionKind; cursor?: string }): Promise<{ records: TaskControlCollectedRecord[]; nextCursor?: string }>;
}

/**
 * Read-only active collector seam.  Production code supplies authenticated task,
 * comment, topic and document-revision readers; this module never writes a
 * remote Lark object and never infers review/freeze from text or task status.
 */
export class TaskControlActiveCollector {
  private readonly cursors = new Map<TaskControlCollectionKind, string | undefined>();

  constructor(
    private readonly lifecycle: TaskControlPlaneLifecycle,
    private readonly source: TaskControlCollectionSource,
  ) {}

  async collect(kind: TaskControlCollectionKind): Promise<number> {
    const response = await this.source.list({ kind, cursor: this.cursors.get(kind) });
    let accepted = 0;
    for (const record of response.records) {
      this.lifecycle.appendUnknownObservation({
        eventId: record.eventId, attemptedEventType: 'unknown.declared',
        sourceRef: record.sourceRef, idempotencyKey: record.idempotencyKey,
        payload: {
          collectionKind: record.kind,
          projectId: record.projectId,
          phaseId: record.phaseId,
          taskGuid: record.taskGuid,
          topicRootId: record.topicRootId,
          sourceRef: record.sourceRef,
          ...(record.payload ?? {}),
        },
      });
      accepted++;
    }
    this.cursors.set(kind, response.nextCursor);
    return accepted;
  }
}
