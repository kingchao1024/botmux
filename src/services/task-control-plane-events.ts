import type { TaskControlAuthentication } from './task-control-plane-authority.js';
import type { TaskControlPlaneLifecycle } from './task-control-plane-runtime.js';
import type { TaskControlEventType } from './task-control-plane-store.js';

export interface TaskControlEventIdentity {
  projectId: string;
  phaseId: string;
  taskGuid?: string;
  topicRootId?: string;
}

export interface TaskControlEventObservation extends TaskControlEventIdentity {
  eventId: string;
  idempotencyKey: string;
  sourceRef: string;
  authentication: TaskControlAuthentication;
  payload?: Record<string, unknown>;
  evidenceRef?: string;
}

/**
 * Narrow event adapter facade for real daemon hooks.  Each hook receives an
 * already-bound identity plus a stable source/event/idempotency triple; it does
 * not inspect report body, title, exit status or task-done state.
 */
export class TaskControlEventAdapters {
  constructor(private readonly lifecycle: TaskControlPlaneLifecycle) {}

  append(eventType: TaskControlEventType, observation: TaskControlEventObservation): void {
    this.lifecycle.append({
      eventType, eventId: observation.eventId, idempotencyKey: observation.idempotencyKey,
      projectId: observation.projectId, phaseId: observation.phaseId, taskGuid: observation.taskGuid,
      topicRootId: observation.topicRootId, sourceRef: observation.sourceRef,
      evidenceRef: observation.evidenceRef, authentication: observation.authentication, payload: observation.payload,
    });
  }

  phaseOpened(observation: TaskControlEventObservation): void { this.append('phase.opened', observation); }
  mappingRegistered(observation: TaskControlEventObservation): void { this.append('mapping.registered', observation); }
  dispatchRequested(observation: TaskControlEventObservation): void { this.append('task.dispatch_requested', observation); }
  acceptanceRequested(observation: TaskControlEventObservation): void { this.append('task.acceptance_requested', observation); }
  accepted(observation: TaskControlEventObservation): void { this.append('task.accepted', observation); }
  executionStarted(observation: TaskControlEventObservation): void { this.append('task.execution_started', observation); }
  firstSubmitted(observation: TaskControlEventObservation): void { this.append('task.first_submitted', observation); }
  reviewed(observation: TaskControlEventObservation): void { this.append('task.reviewed', observation); }
  reworkStarted(observation: TaskControlEventObservation): void { this.append('task.rework_started', observation); }
  delivered(observation: TaskControlEventObservation): void { this.append('task.delivered', observation); }
  doneMarked(observation: TaskControlEventObservation): void { this.append('task.done_marked', observation); }
  unknown(observation: TaskControlEventObservation): void { this.append('unknown.declared', observation); }
  conflict(observation: TaskControlEventObservation): void { this.append('event.conflict_detected', observation); }
}

/**
 * Stable, source-derived event keys.  The source reference stays human-auditable
 * while this key prevents a redelivery from becoming a second lifecycle fact.
 */
export function taskControlEventIdempotencyKey(eventType: TaskControlEventType, sourceRef: string): string {
  return `task-control:${eventType}:${sourceRef}`;
}
