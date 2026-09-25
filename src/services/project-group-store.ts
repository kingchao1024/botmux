import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import type { ProjectDispatchAccess } from '../core/dispatch-write-scope.js';

export const PROJECT_GROUP_STORE_FILE = 'project-groups.json';

export type ProjectGroupStatus = 'active' | 'paused' | 'completed';
export type ProjectWorkstreamStatus = 'pending' | 'in_progress' | 'in_review' | 'blocked' | 'completed' | 'failed';

export interface ProjectWorkstreamDelivery {
  reportedByAppId: string;
  content: string;
  reportedAt: string;
  round: number;
}

export interface ProjectWorkstreamReview {
  reviewerAppId: string;
  verdict: 'pass' | 'fail';
  content: string;
  reviewedAt: string;
  round: number;
}

export interface ProjectWorkstream {
  dispatchRoot: string;
  threadId?: string;
  title: string;
  purpose: string;
  owners: string[];
  targetAppIds?: string[];
  workerAppIds?: string[];
  reviewerAppIds?: string[];
  access?: ProjectDispatchAccess;
  delivery?: ProjectWorkstreamDelivery;
  review?: ProjectWorkstreamReview;
  status: ProjectWorkstreamStatus;
  progress: number;
  remaining?: string;
  lastReport?: string;
  blocker?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDispatchReservation {
  reservationId: string;
  targetAppIds: string[];
  access: ProjectDispatchAccess;
  createdAt: string;
  expiresAt: string;
}

export interface ProjectMilestone {
  content: string;
  createdAt: string;
}

export interface ProjectGroupState {
  schemaVersion: 2;
  revision: number;
  chatId: string;
  larkAppId: string;
  coordinatorSessionId: string;
  title: string;
  goal: string;
  phase: string;
  focus: string;
  status: ProjectGroupStatus;
  manualProgress?: number;
  remaining?: string;
  blockers: string[];
  workstreams: ProjectWorkstream[];
  /** Optional for backwards-compatible reads of project state written before reservations. */
  dispatchReservations?: ProjectDispatchReservation[];
  milestones: ProjectMilestone[];
  nextMilestone?: string;
  card?: {
    messageId: string;
    pinned: boolean;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface ProjectGroupRegistry {
  schemaVersion: 2;
  projects: Record<string, ProjectGroupState>;
}

function storePath(dataDir: string): string {
  return join(dataDir, PROJECT_GROUP_STORE_FILE);
}

function emptyRegistry(): ProjectGroupRegistry {
  return { schemaVersion: 2, projects: {} };
}

function readRegistry(path: string): ProjectGroupRegistry {
  if (!existsSync(path)) return emptyRegistry();
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} must contain an object`);
  }
  const raw = parsed as { schemaVersion?: number; projects?: unknown };
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2)
    || !raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) {
    throw new Error(`${PROJECT_GROUP_STORE_FILE} has an unsupported schema`);
  }
  const projects = Object.fromEntries(Object.entries(raw.projects as Record<string, unknown>).map(([chatId, project]) => [
    chatId, { ...(project as ProjectGroupState), schemaVersion: 2 as const },
  ]));
  return { schemaVersion: 2, projects };
}

function writeRegistry(path: string, registry: ProjectGroupRegistry): void {
  atomicWriteFileSync(path, JSON.stringify(registry, null, 2), {
    mode: 0o600,
    followTargetSymlink: false,
  });
}

export function readProjectGroup(dataDir: string, chatId: string): ProjectGroupState | undefined {
  return readRegistry(storePath(dataDir)).projects[chatId];
}

export function listProjectGroups(dataDir: string): ProjectGroupState[] {
  return Object.values(readRegistry(storePath(dataDir)).projects).map(project => structuredClone(project));
}

export async function mutateProjectGroup(
  dataDir: string,
  chatId: string,
  mutate: (current: ProjectGroupState | undefined) => ProjectGroupState | undefined | Promise<ProjectGroupState | undefined>,
): Promise<ProjectGroupState | undefined> {
  const path = storePath(dataDir);
  let result: ProjectGroupState | undefined;
  await withFileLock(path, async () => {
    const registry = readRegistry(path);
    const current = registry.projects[chatId];
    const next = await mutate(current ? structuredClone(current) : undefined);
    if (next === undefined) {
      delete registry.projects[chatId];
      result = undefined;
    } else {
      registry.projects[chatId] = next;
      result = structuredClone(next);
    }
    writeRegistry(path, registry);
  });
  return result;
}

export function projectOverallProgress(project: ProjectGroupState): number {
  if (project.manualProgress !== undefined) return project.manualProgress;
  if (project.workstreams.length === 0) return project.status === 'completed' ? 100 : 0;
  const total = project.workstreams.reduce((sum, item) => sum + item.progress, 0);
  return Math.round(total / project.workstreams.length);
}

export function projectRemainingSummary(project: ProjectGroupState): string {
  if (project.remaining?.trim()) return project.remaining.trim();
  if (project.workstreams.length === 0) return project.status === 'completed' ? '无' : '待拆解';
  const pending = project.workstreams.filter(item => item.status !== 'completed').length;
  return pending === 0 ? '无' : `${pending} 个子任务`;
}
