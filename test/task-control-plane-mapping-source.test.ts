import { describe, expect, it } from 'vitest';
import { resolveTaskControlMappingRegistration } from '../src/services/task-control-plane-mapping-source.js';

const tasks = ['task-1', 'task-2'];
const refs = { 'task-1': 'task-comment:101', 'task-2': 'task-comment:102' };

function registration(taskGuid: string, updatedAt: string) {
  return JSON.stringify({
    schemaVersion: 'TaskControlMappingRegistration.v1', projectId: 'project-1', phaseId: 'phase-1',
    phaseTaskGuids: tasks, phaseRegistrationRefs: refs, taskGuid, topicRootId: 'om_root',
    ownerId: 'worker-1', reviewerId: 'reviewer-1', acceptorId: 'acceptor-1', docToken: 'doc-token-12345678', docRevision: 9,
    registrationVersion: updatedAt, approvalGate: { runId: 'run-1', nodeId: 'node-1', instanceId: 'node-1#1', waitId: 'wait-1', operatorId: 'acceptor-1', approverPolicy: ['acceptor-1'] },
  });
}

function reader(author = 'app-1') {
  return {
    readTaskComment: async (_app: string, id: string) => {
      const taskGuid = id === '101' ? 'task-1' : id === '102' ? 'task-2' : '';
      return { data: { comment: { id, resource_type: 'task', resource_id: taskGuid, creator: { id: author }, updated_at: `v-${id}`, content: registration(taskGuid, `v-${id}`) } } };
    },
    readTask: async (_app: string, taskGuid: string) => ({ data: { task: { guid: taskGuid } } }),
    readTopic: async () => ({ items: [{ message_id: 'om_root', root_id: 'om_root' }] }),
    readDocumentRevision: async () => 9,
  };
}

describe('task control authoritative mapping source', () => {
  it('reconstructs only a controller-authored, two-task, source-consistent registration', async () => {
    const resolved = await resolveTaskControlMappingRegistration(reader(), 'app-1', {
      dispatchRoot: 'om_root', registrationRef: 'task-comment:101', controllerId: 'app-1',
    });
    expect(resolved).toMatchObject({
      projectId: 'project-1', phaseId: 'phase-1', phaseTaskGuids: tasks, taskGuid: 'task-1',
      registrationVersion: 'v-101', phaseRegistrationRefs: refs, docRevision: 9,
    });
  });

  it('fails closed when the live controller did not author every phase registration', async () => {
    await expect(resolveTaskControlMappingRegistration(reader('other-app'), 'app-1', {
      dispatchRoot: 'om_root', registrationRef: 'task-comment:101', controllerId: 'app-1',
    })).resolves.toBeUndefined();
  });
});
