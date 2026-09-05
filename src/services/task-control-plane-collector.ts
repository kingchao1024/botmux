import type { TaskControlPlaneLifecycle } from './task-control-plane-runtime.js';

export type TaskControlCollectionKind = 'task' | 'task_comment' | 'topic' | 'doc_revision';

export interface TaskControlCollectedRecord {
  kind: TaskControlCollectionKind;
  /** A stable remote-object reference, never remote content or a parsed verdict. */
  sourceRef: string;
  eventId: string;
  idempotencyKey: string;
  occurredAt?: string;
}

export interface TaskControlCollectionSource {
  list(input: { kind: TaskControlCollectionKind; cursor?: string }): Promise<{ records: TaskControlCollectedRecord[]; nextCursor?: string }>;
}

/**
 * Read-only active collector seam. Production code supplies authenticated task,
 * comment, topic and document-revision readers; this module never writes a
 * remote Lark object and never infers review/freeze from text or task status.
 *
 * The ledger gets only a bounded source reference. In particular, it must not
 * become a second store for task descriptions, comments, topic bodies or doc
 * contents just because Shadow is enabled.
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
        occurredAt: record.occurredAt,
        payload: {
          collectionKind: record.kind,
          referenceOnly: true,
        },
      });
      accepted++;
    }
    this.cursors.set(kind, response.nextCursor);
    return accepted;
  }
}
