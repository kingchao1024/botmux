import { getBotClient } from '../bot-registry.js';
import { getMessageDetail, larkGet } from '../im/lark/client.js';
import { TaskControlActiveCollector, type TaskControlCollectionKind, type TaskControlCollectionSource } from './task-control-plane-collector.js';
import { DaemonTaskControlBridge, type DaemonTaskControlMapping } from './task-control-plane-daemon-bridge.js';
import { TaskControlEventAdapters, taskControlEventIdempotencyKey } from './task-control-plane-events.js';
import type { TaskControlPlaneDeliveryResult, TaskControlPlaneLifecycle } from './task-control-plane-runtime.js';
import type { DeliveryOutboxRow, TaskControlPlaneStore } from './task-control-plane-store.js';

const MAX_REFERENCE_POLL = 100;

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validDocToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,256}$/.test(value);
}

function reference(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * The daemon-side integration intentionally owns only typed mappings and stable
 * remote references. It is not a report/body parser: if a controller has not
 * explicitly registered a mapping, lifecycle hooks emit only UNKNOWN.
 */
export class DaemonTaskControlIntegration {
  readonly adapters: TaskControlEventAdapters;
  readonly collector: TaskControlActiveCollector;

  constructor(
    private readonly input: {
      dataDir: string;
      larkAppId: string;
      lifecycle: TaskControlPlaneLifecycle;
      store: TaskControlPlaneStore;
      bridge: DaemonTaskControlBridge;
      logger: { warn(message: string): void };
    },
  ) {
    this.adapters = new TaskControlEventAdapters(input.lifecycle);
    this.collector = new TaskControlActiveCollector(input.lifecycle, this.collectionSource());
    this.restoreMappings();
  }

  private restoreMappings(): void {
    for (const mapping of this.input.store.listTrustedMappings()) {
      if (!this.input.bridge.restoreMapping(mapping)) {
        this.input.logger.warn('[task-control] ignored invalid persisted mapping reference');
      }
    }
  }

  registerMapping(
    dispatchRoot: string,
    mapping: Omit<DaemonTaskControlMapping, 'controllerId'>,
    controllerId: string,
  ): boolean {
    const controllerMapping: DaemonTaskControlMapping = { ...mapping, controllerId };
    if (!this.input.bridge.registerMapping(dispatchRoot, controllerMapping, controllerId)) return false;
    try {
      const authentication = this.input.bridge.issueAuthentication(dispatchRoot, 'controller');
      if (!authentication) return false;
      const registered = this.input.store.registerTrustedMapping({
        dispatchRoot, projectId: controllerMapping.projectId, phaseId: controllerMapping.phaseId, phaseTaskGuids: controllerMapping.phaseTaskGuids,
        taskGuid: mapping.taskGuid, topicRootId: mapping.topicRootId, ownerId: mapping.ownerId, reviewerId: mapping.reviewerId,
        acceptorId: mapping.acceptorId, registrationRef: mapping.registrationRef, controllerId, docToken: mapping.docToken, authentication,
      });
      return this.input.bridge.restoreMapping(registered.mapping);
    } catch (error) {
      this.input.bridge.removeMapping(dispatchRoot);
      this.input.logger.warn(`[task-control] mapping registry persistence failed: ${String(error)}`);
      return false;
    }
  }

  /** Read-only bridge accessors keep daemon routes out of bridge internals. */
  mapping(dispatchRoot: string): DaemonTaskControlMapping | undefined {
    return this.input.bridge.mapping(dispatchRoot);
  }

  issueAuthentication(
    dispatchRoot: string,
    principal: 'controller' | 'worker' | 'reviewer' | 'acceptor' | 'collector',
  ) {
    return this.input.bridge.issueAuthentication(dispatchRoot, principal);
  }

  approval(approvalRef: string) {
    return this.input.bridge.approval(approvalRef);
  }

  dispatchRequested(dispatchRoot: string, sourceSessionId: string, occurredAt: string): void {
    const event = this.input.bridge.event({
      dispatchRoot, principal: 'controller',
      eventId: `tcp-dispatch:${dispatchRoot}`,
      idempotencyKey: taskControlEventIdempotencyKey('task.dispatch_requested', reference('dispatch', dispatchRoot)),
      sourceRef: reference('dispatch', dispatchRoot),
      payload: { sourceSessionId, dispatchRoot },
    });
    if (!event) {
      this.input.lifecycle.enqueueUnknownObservation({
        eventId: `tcp-unknown-dispatch:${dispatchRoot}`, attemptedEventType: 'task.dispatch_requested',
        sourceRef: reference('dispatch', dispatchRoot), idempotencyKey: `tcp-unknown-dispatch:${dispatchRoot}`,
        occurredAt, payload: { source: 'dispatch', referenceOnly: true },
      });
      return;
    }
    this.adapters.enqueue('task.dispatch_requested', { ...event, payload: { dispatchRoot, sourceSessionId } });
  }

  workerAccepted(dispatchRoot: string, sourceRef: string, occurredAt?: string): void {
    this.appendMapped('task.accepted', dispatchRoot, 'worker', sourceRef, occurredAt);
  }

  workerExecutionStarted(dispatchRoot: string, sourceRef: string, occurredAt?: string): void {
    this.appendMapped('task.execution_started', dispatchRoot, 'worker', sourceRef, occurredAt);
  }

  terminalWithoutRevision(dispatchRoot: string, sourceRef: string, payload: Record<string, unknown>): void {
    this.input.lifecycle.enqueueUnknownObservation({
      eventId: `tcp-unknown-terminal:${sourceRef}`, attemptedEventType: 'task.delivered', sourceRef,
      idempotencyKey: `tcp-unknown-terminal:${sourceRef}`,
      payload: { dispatchRoot, source: 'turn_terminal', referenceOnly: true, ...payload },
    });
  }

  reportFallbackUnknown(sourceRef: string, errorClass: string): void {
    this.input.lifecycle.enqueueUnknownObservation({
      eventId: `tcp-unknown-report:${sourceRef}`, attemptedEventType: 'task.delivery_fallback_verified', sourceRef,
      idempotencyKey: `tcp-unknown-report:${sourceRef}`,
      payload: { source: 'report-fallback', errorClass, referenceOnly: true },
    });
  }

  private appendMapped(
    eventType: 'task.accepted' | 'task.execution_started',
    dispatchRoot: string,
    principal: 'worker',
    sourceRef: string,
    occurredAt?: string,
  ): void {
    const event = this.input.bridge.event({
      dispatchRoot, principal, eventId: `tcp-${eventType}:${sourceRef}`,
      idempotencyKey: taskControlEventIdempotencyKey(eventType, sourceRef), sourceRef, payload: {},
    });
    if (!event) {
      this.input.lifecycle.enqueueUnknownObservation({
        eventId: `tcp-unknown-${eventType}:${sourceRef}`, attemptedEventType: eventType, sourceRef,
        idempotencyKey: `tcp-unknown-${eventType}:${sourceRef}`, occurredAt,
        payload: { source: 'daemon-hook', referenceOnly: true },
      });
      return;
    }
    this.adapters.enqueue(eventType, event);
  }

  async collectAll(): Promise<void> {
    for (const kind of ['task', 'task_comment', 'topic', 'doc_revision'] as const) {
      try { await this.collector.collect(kind); }
      catch (error) { this.input.logger.warn(`[task-control] ${kind} collector failed: ${String(error)}`); }
    }
  }

  /** Controlled delivery: a stable task/topic reference is the destination. */
  async deliver(row: DeliveryOutboxRow): Promise<TaskControlPlaneDeliveryResult> {
    if (row.destinationId.startsWith('topic-message:')) {
      const messageId = row.destinationId.slice('topic-message:'.length);
      try {
        await larkGet(getBotClient(this.input.larkAppId), `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
        return { kind: 'delivered' };
      } catch (error) { return { kind: 'retry', error: `topic_reference_unavailable:${String(error)}` }; }
    }
    if (row.destinationId.startsWith('task-comment:')) {
      // A delivery destination is not a permission to write comments. The active
      // collector verifies visibility through the canonical task source instead.
      return { kind: 'degraded', error: 'task_comment_delivery_requires_verified_visible_reference' };
    }
    return { kind: 'degraded', error: 'delivery_destination_unrecognized' };
  }

  private collectionSource(): TaskControlCollectionSource {
    return {
      list: async ({ kind, cursor }) => ({
        records: await this.collectReferences(kind, cursor),
        nextCursor: undefined,
      }),
    };
  }

  private async collectReferences(kind: TaskControlCollectionKind, _cursor?: string) {
    const records: Array<{ kind: TaskControlCollectionKind; sourceRef: string; eventId: string; idempotencyKey: string; occurredAt?: string }> = [];
    for (const { dispatchRoot, mapping } of this.input.bridge.listMappings().slice(0, MAX_REFERENCE_POLL)) {
      try {
        if (kind === 'topic') {
          await getMessageDetail(this.input.larkAppId, dispatchRoot, { userCardContent: false });
          const sourceRef = reference('topic-message', dispatchRoot);
          records.push({ kind, sourceRef, eventId: DaemonTaskControlBridge.observationId(kind, sourceRef), idempotencyKey: `tcp-collect:${kind}:${sourceRef}` });
        } else if (kind === 'doc_revision' && mapping.docToken && validDocToken(mapping.docToken)) {
          const document = await larkGet(getBotClient(this.input.larkAppId), `/open-apis/docx/v1/documents/${encodeURIComponent(mapping.docToken)}`);
          const revision = Number(document?.data?.document?.revision_id);
          if (Number.isSafeInteger(revision) && revision >= 0) {
            const sourceRef = reference('doc-revision', `${mapping.docToken}@${revision}`);
            records.push({ kind, sourceRef, eventId: DaemonTaskControlBridge.observationId(kind, sourceRef), idempotencyKey: `tcp-collect:${kind}:${sourceRef}` });
          }
        } else if (kind === 'task_comment') {
          const task = await larkGet(getBotClient(this.input.larkAppId), '/open-apis/task/v2/comments', { resource_type: 'task', resource_id: mapping.taskGuid, page_size: 1 });
          const commentId = nonBlank(task?.data?.items?.[0]?.comment_id);
          if (commentId) {
            const sourceRef = reference('task-comment', commentId);
            records.push({ kind, sourceRef, eventId: DaemonTaskControlBridge.observationId(kind, sourceRef), idempotencyKey: `tcp-collect:${kind}:${sourceRef}` });
          }
        } else if (kind === 'task') {
          await larkGet(getBotClient(this.input.larkAppId), `/open-apis/task/v2/tasks/${encodeURIComponent(mapping.taskGuid)}`);
          const sourceRef = reference('task', mapping.taskGuid);
          records.push({ kind, sourceRef, eventId: DaemonTaskControlBridge.observationId(kind, sourceRef), idempotencyKey: `tcp-collect:${kind}:${sourceRef}` });
        }
      } catch (error) {
        this.input.logger.warn(`[task-control] ${kind} reference unavailable for ${dispatchRoot}: ${String(error)}`);
        const sourceRef = reference('collection-error', `${kind}:${dispatchRoot}`);
        records.push({
          kind, sourceRef, eventId: DaemonTaskControlBridge.observationId(kind, sourceRef),
          idempotencyKey: `tcp-collect:${kind}:${sourceRef}`,
        });
      }
    }
    return records;
  }
}
