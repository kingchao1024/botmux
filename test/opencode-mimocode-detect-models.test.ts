import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileCalls: { file: string; args: string[] }[] = [];
let execFileStdout = '';

vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      execFileCalls.push({ file, args });
      cb(null, { stdout: execFileStdout, stderr: '' });
    },
  };
});

import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { createMiMoCodeAdapter } from '../src/adapters/cli/mimocode.js';

describe('OpenCode-like live model discovery', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileStdout = '';
  });

  it('discovers OpenCode models, including MiMo Token Plan', async () => {
    execFileStdout = 'xiaomi-token-plan-cn/mimo-v2.5\nopenrouter/anthropic/claude-sonnet-4\n';
    await expect(createOpenCodeAdapter('/usr/bin/opencode').detectModels!()).resolves.toEqual([
      'xiaomi-token-plan-cn/mimo-v2.5',
      'openrouter/anthropic/claude-sonnet-4',
    ]);
    expect(execFileCalls).toEqual([{ file: '/usr/bin/opencode', args: ['models'] }]);
  });

  it('discovers MiMoCode models and strips display metadata', async () => {
    execFileStdout = 'xiaomi-token-plan-cn/mimo-v2.5-pro — window 1.05M\n';
    await expect(createMiMoCodeAdapter('/usr/bin/mimo').detectModels!()).resolves.toEqual([
      'xiaomi-token-plan-cn/mimo-v2.5-pro',
    ]);
    expect(execFileCalls).toEqual([{ file: '/usr/bin/mimo', args: ['models'] }]);
  });
});
