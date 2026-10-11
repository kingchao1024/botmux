import type { ProjectCoordinatorAction } from '../services/project-coordinator.js';

export type ProjectCliResult =
  | { ok: true; help: true }
  | { ok: true; help: false; sessionId?: string; json: boolean; action: ProjectCoordinatorAction }
  | { ok: false; error: string };

function values(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === flag) {
      if (args[i + 1] !== undefined) out.push(args[++i]!);
    } else if (token.startsWith(`${flag}=`)) {
      out.push(token.slice(flag.length + 1));
    }
  }
  return out;
}

function one(args: readonly string[], flag: string): string | undefined {
  return values(args, flag)[0];
}

function has(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function parseProgress(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  if (!/^\d{1,3}$/.test(raw)) return 'invalid';
  const value = Number(raw);
  return value <= 100 ? value : 'invalid';
}

export function parseProjectArgs(subcommand: string, args: readonly string[]): ProjectCliResult {
  if (args.includes('--help') || args.includes('-h')
    || subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || !subcommand) {
    return { ok: true, help: true };
  }
  if (subcommand === 'gate') {
    const operation = args[0];
    const gateArgs = args.slice(1);
    let allowed: Set<string> | undefined;
    if (operation === 'add') {
      allowed = new Set(['--id', '--source-chat-id', '--dispatch-root', '--task-guid', '--label', '--session-id', '--json']);
    } else if (operation === 'status') {
      allowed = new Set(['--session-id', '--json']);
    } else if (operation === 'retire') {
      allowed = new Set(['--id', '--expected-fingerprint', '--authorization-ref', '--reason', '--session-id', '--json']);
    } else if (operation === 'replace') {
      allowed = new Set([
        '--id', '--expected-fingerprint', '--new-id', '--source-chat-id', '--dispatch-root',
        '--task-guid', '--label', '--authorization-ref', '--reason', '--session-id', '--json',
      ]);
    }
    if (!allowed) return { ok: false, error: 'project gate 只支持 add、status、retire 或 replace' };
    for (let i = 0; i < gateArgs.length; i += 1) {
      const token = gateArgs[i]!;
      if (!token.startsWith('-')) return { ok: false, error: `不支持位置参数: ${token}` };
      const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (!allowed.has(flag)) return { ok: false, error: `未知选项: ${flag}` };
      if (flag === '--json') {
        if (token.includes('=')) return { ok: false, error: '--json 不接受值' };
        continue;
      }
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : gateArgs[++i];
      if (value === undefined || !value.trim() || value.startsWith('--')) {
        return { ok: false, error: `${flag} 需要一个值` };
      }
    }
    const sessionId = one(gateArgs, '--session-id');
    const json = has(gateArgs, '--json');
    if (operation === 'status') {
      return { ok: true, help: false, sessionId, json: true, action: { action: 'status' } };
    }
    const gateId = one(gateArgs, '--id')?.trim();
    const expectedDefinitionFingerprint = one(gateArgs, '--expected-fingerprint')?.trim();
    const authorizationRef = one(gateArgs, '--authorization-ref')?.trim();
    const reason = one(gateArgs, '--reason')?.trim();
    if (operation === 'retire') {
      if (!gateId || !expectedDefinitionFingerprint || !authorizationRef || !reason) {
        return { ok: false, error: 'project gate retire 需要 --id、--expected-fingerprint、--authorization-ref 和 --reason' };
      }
      return {
        ok: true, help: false, sessionId, json,
        action: { action: 'retire_completion_gate', gateId, expectedDefinitionFingerprint, authorizationRef, reason },
      };
    }
    const sourceChatId = one(gateArgs, '--source-chat-id')?.trim();
    const dispatchRoot = one(gateArgs, '--dispatch-root')?.trim();
    const taskGuid = one(gateArgs, '--task-guid')?.trim();
    const label = one(gateArgs, '--label')?.trim();
    if (operation === 'replace') {
      const newGateId = one(gateArgs, '--new-id')?.trim();
      if (!gateId || !expectedDefinitionFingerprint || !newGateId || !sourceChatId
        || !dispatchRoot || !taskGuid || !label || !authorizationRef || !reason) {
        return {
          ok: false,
          error: 'project gate replace 需要 --id、--expected-fingerprint、--new-id、--source-chat-id、--dispatch-root、--task-guid、--label、--authorization-ref 和 --reason',
        };
      }
      return {
        ok: true, help: false, sessionId, json,
        action: {
          action: 'replace_completion_gate', gateId, expectedDefinitionFingerprint, newGateId,
          sourceChatId, dispatchRoot, taskGuid, label, authorizationRef, reason,
        },
      };
    }
    if (!gateId || !sourceChatId || !dispatchRoot || !taskGuid || !label) {
      return { ok: false, error: 'project gate add 需要 --id、--source-chat-id、--dispatch-root、--task-guid 和 --label' };
    }
    return {
      ok: true, help: false, sessionId, json,
      action: { action: 'add_completion_gate', gateId, sourceChatId, dispatchRoot, taskGuid, label },
    };
  }
  const allowedByCommand: Record<string, Set<string>> = {
    init: new Set(['--title', '--goal', '--phase', '--focus', '--remaining', '--session-id', '--json']),
    status: new Set(['--session-id', '--json']),
    update: new Set(['--goal', '--phase', '--focus', '--progress', '--remaining', '--blocker', '--clear-blockers', '--milestone', '--next-milestone', '--clear-next-milestone', '--session-id', '--json']),
    close: new Set(['--milestone', '--session-id', '--json']),
    resume: new Set(['--phase', '--focus', '--session-id', '--json']),
  };
  const allowed = allowedByCommand[subcommand];
  if (!allowed) return { ok: false, error: `未知 project 子命令: ${subcommand}` };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith('-')) return { ok: false, error: `不支持位置参数: ${token}` };
    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (!allowed.has(flag)) return { ok: false, error: `未知选项: ${flag}` };
    if ((flag === '--json' || flag === '--clear-blockers' || flag === '--clear-next-milestone')) {
      if (token.includes('=')) return { ok: false, error: `${flag} 不接受值` };
      continue;
    }
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : args[++i];
    if (value === undefined || !value.trim() || value.startsWith('--')) {
      return { ok: false, error: `${flag} 需要一个值` };
    }
  }
  const sessionId = one(args, '--session-id');
  const json = has(args, '--json');
  if (subcommand === 'init') {
    const title = one(args, '--title')?.trim();
    const goal = one(args, '--goal')?.trim();
    if (!title || !goal) return { ok: false, error: 'project init 需要 --title 和 --goal' };
    return { ok: true, help: false, sessionId, json, action: {
      action: 'init', title, goal,
      phase: one(args, '--phase'), focus: one(args, '--focus'), remaining: one(args, '--remaining'),
    } };
  }
  if (subcommand === 'status') return { ok: true, help: false, sessionId, json, action: { action: 'status' } };
  if (subcommand === 'update') {
    const progress = parseProgress(one(args, '--progress'));
    if (progress === 'invalid') return { ok: false, error: '--progress 必须是 0-100 的整数' };
    const action: ProjectCoordinatorAction = {
      action: 'update', goal: one(args, '--goal'), phase: one(args, '--phase'), focus: one(args, '--focus'),
      progress, remaining: one(args, '--remaining'), blocker: one(args, '--blocker'),
      clearBlockers: has(args, '--clear-blockers'), milestone: one(args, '--milestone'),
      nextMilestone: has(args, '--clear-next-milestone') ? '' : one(args, '--next-milestone'),
    };
    const changed = Object.entries(action).some(([key, value]) => key !== 'action' && value !== undefined && value !== false);
    if (!changed) return { ok: false, error: 'project update 至少需要一个更新选项' };
    return { ok: true, help: false, sessionId, json, action };
  }
  if (subcommand === 'close') return { ok: true, help: false, sessionId, json, action: { action: 'close', milestone: one(args, '--milestone') } };
  return { ok: true, help: false, sessionId, json, action: { action: 'resume', phase: one(args, '--phase'), focus: one(args, '--focus') } };
}
