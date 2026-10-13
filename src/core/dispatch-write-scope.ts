import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import {
  resolveRepositoryIdentity,
  worktreeRootFor,
  type RepositoryIdentity,
} from '../services/git-worktree.js';

export type ProjectDispatchAccess =
  | Readonly<{ mode: 'read_only' }>
  | Readonly<{ mode: 'write'; scopes: string[] }>;

export interface DispatchRepositoryLeaseRequirement {
  identity: RepositoryIdentity;
  workingDir: string;
  scopes: string[];
}

export function normalizeDispatchWriteScopes(scopes: readonly string[]): string[] {
  const normalized = [...new Set(scopes.map(scope => {
    if (!isAbsolute(scope)) throw new Error('write_scope_must_be_absolute');
    let path: string;
    try { path = realpathSync(scope); } catch { throw new Error('write_scope_must_exist'); }
    if (!statSync(path).isDirectory()) throw new Error('write_scope_must_be_directory');
    return path;
  }))].sort((left, right) => left.length - right.length || left.localeCompare(right));
  return normalized.filter((scope, index) => (
    !normalized.slice(0, index).some(parent => pathContains(parent, scope))
  ));
}

function pathContains(parent: string, child: string): boolean {
  const childFromParent = relative(parent, child);
  return childFromParent === ''
    || (!childFromParent.startsWith('..') && !isAbsolute(childFromParent));
}

export function projectDispatchAccessConflicts(
  _left: ProjectDispatchAccess,
  _right: ProjectDispatchAccess,
): boolean {
  if (_left.mode === 'read_only' || _right.mode === 'read_only') return false;
  return _left.scopes.some(left => _right.scopes.some(right => (
    pathContains(left, right) || pathContains(right, left)
  )));
}

export async function resolveDispatchRepositoryLeaseRequirement(
  access: ProjectDispatchAccess,
): Promise<DispatchRepositoryLeaseRequirement | null> {
  if (access.mode === 'read_only') return null;
  const scopes = normalizeDispatchWriteScopes(access.scopes);
  if (scopes.length === 0) throw new Error('write_scope_required');
  const identities = await Promise.all(scopes.map(scope => resolveRepositoryIdentity(scope)));
  const identity = identities[0]!;
  if (identities.some(candidate => candidate.repoKey !== identity.repoKey)) {
    throw new Error('write_scope_spans_multiple_repositories');
  }
  const root = await worktreeRootFor(scopes[0]!);
  if (!root) throw new Error('repository_worktree_root_unavailable');
  return { identity, workingDir: realpathSync(root), scopes };
}
