import type { DaemonTaskControlMappingRegistration } from './task-control-plane-daemon-bridge.js';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function commentId(ref: string): string | undefined {
  const id = ref.startsWith('task-comment:') ? ref.slice('task-comment:'.length) : '';
  return /^[0-9]+$/.test(id) ? id : undefined;
}

/** The daemon injects existing Lark reads; this service owns mapping parsing and proof checks. */
export type TaskControlMappingSourceReader = {
  readTaskComment(larkAppId: string, commentId: string): Promise<unknown>;
  readTask(larkAppId: string, taskGuid: string): Promise<unknown>;
  readTopic(larkAppId: string, topicRootId: string): Promise<unknown>;
  readDocumentRevision(larkAppId: string, docToken: string): Promise<number | undefined>;
};

export async function resolveTaskControlMappingRegistration(
  reader: TaskControlMappingSourceReader,
  larkAppId: string,
  input: { dispatchRoot: string; registrationRef: string; controllerId: string },
): Promise<DaemonTaskControlMappingRegistration | undefined> {
  const initialCommentId = commentId(input.registrationRef);
  if (!initialCommentId) return undefined;
  const initialResponse = record(await reader.readTaskComment(larkAppId, initialCommentId));
  const initial = record(record(initialResponse?.data)?.comment);
  const taskGuid = text(initial?.resource_id);
  if (!taskGuid || initial?.resource_type !== 'task' || record(initial?.creator)?.id !== input.controllerId) return undefined;
  let raw: RecordValue | undefined;
  try { raw = record(JSON.parse(String(initial.content))); } catch { return undefined; }
  const docToken = text(raw?.docToken);
  const topicRootId = text(raw?.topicRootId);
  const phaseTaskGuids = Array.isArray(raw?.phaseTaskGuids) && raw!.phaseTaskGuids.every(task => typeof task === 'string' && task)
    ? raw!.phaseTaskGuids as string[] : undefined;
  if (!raw || !docToken || !topicRootId || raw.taskGuid !== taskGuid || raw.registrationVersion !== initial.updated_at
    || !phaseTaskGuids || phaseTaskGuids.length < 2 || new Set(phaseTaskGuids).size !== phaseTaskGuids.length) return undefined;
  const phaseRegistrationRefs = record(raw.phaseRegistrationRefs);
  if (!phaseRegistrationRefs || Object.keys(phaseRegistrationRefs).length !== phaseTaskGuids.length
    || phaseTaskGuids.some(task => !commentId(String(phaseRegistrationRefs[task])))) return undefined;
  const phaseCommentIds = phaseTaskGuids.map(task => commentId(String(phaseRegistrationRefs[task]))!);
  const [taskResponse, topicDetail, revision, ...sources] = await Promise.all([
    reader.readTask(larkAppId, taskGuid), reader.readTopic(larkAppId, topicRootId), reader.readDocumentRevision(larkAppId, docToken),
    ...phaseTaskGuids.map(task => reader.readTask(larkAppId, task)),
    ...phaseCommentIds.map(id => reader.readTaskComment(larkAppId, id)),
  ]);
  const topicRoot = record(topicDetail);
  const topicItems = Array.isArray(topicRoot?.items) && topicRoot!.items.length === 1 ? record(topicRoot!.items[0]) : undefined;
  const gate = record(raw.approvalGate);
  const required = [raw.projectId, raw.phaseId, raw.ownerId, raw.reviewerId, raw.acceptorId, gate?.runId, gate?.nodeId, gate?.instanceId, gate?.waitId, gate?.operatorId];
  const phaseTasks = sources.slice(0, phaseTaskGuids.length);
  const phaseComments = sources.slice(phaseTaskGuids.length);
  const taskMatches = record(record(taskResponse)?.data)?.task as RecordValue | undefined;
  const allTasksMatch = phaseTasks.every((response, index) => record(record(record(response)?.data)?.task)?.guid === phaseTaskGuids[index]);
  const allCommentsMatch = phaseComments.every((response, index) => {
    const source = record(record(record(response)?.data)?.comment);
    if (source?.resource_type !== 'task' || source?.resource_id !== phaseTaskGuids[index] || record(source?.creator)?.id !== input.controllerId) return false;
    try {
      const registration = record(JSON.parse(String(source.content)));
      return registration?.schemaVersion === 'TaskControlMappingRegistration.v1'
        && registration?.projectId === raw!.projectId && registration?.phaseId === raw!.phaseId
        && registration?.taskGuid === phaseTaskGuids[index] && registration?.topicRootId === topicRootId
        && JSON.stringify(registration?.phaseTaskGuids) === JSON.stringify(phaseTaskGuids);
    } catch { return false; }
  });
  if (taskMatches?.guid !== taskGuid || !allTasksMatch || !allCommentsMatch
    || topicItems?.message_id !== topicRootId || (topicItems?.root_id ?? topicItems?.message_id) !== topicRootId
    || revision !== raw.docRevision || required.some(value => !text(value))
    || !Array.isArray(gate?.approverPolicy) || gate!.approverPolicy.some(value => !text(value))) return undefined;
  return {
    projectId: raw.projectId as string, phaseId: raw.phaseId as string, phaseTaskGuids, taskGuid, topicRootId,
    ownerId: raw.ownerId as string, reviewerId: raw.reviewerId as string, acceptorId: raw.acceptorId as string,
    registrationRef: input.registrationRef, registrationVersion: raw.registrationVersion as string,
    phaseRegistrationRefs: phaseRegistrationRefs as Record<string, string>, docToken, docRevision: revision,
    approvalGate: { runId: gate!.runId as string, nodeId: gate!.nodeId as string, instanceId: gate!.instanceId as string, waitId: gate!.waitId as string, operatorId: gate!.operatorId as string, approverPolicy: gate!.approverPolicy as string[] },
  };
}
