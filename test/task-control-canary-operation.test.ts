import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseTaskControlCanaryOperationArgs,
  runTaskControlCanaryOperation,
} from '../scripts/task-control-canary-operation.mjs';

describe('repository-local TaskControl canary maintenance entrypoint', () => {
  const SHA = 'a'.repeat(64);
  const FENCE = `tccq1:${'b'.repeat(64)}`;
  const CONFIG = `pgc1:${'c'.repeat(64)}`;
  const CERTIFICATE = `tcsc1:${'d'.repeat(64)}`;

  it('maps the exact status argv to the internal status action', () => {
    expect(parseTaskControlCanaryOperationArgs(['status'])).toEqual({
      action: 'task_control_canary_status',
    });
  });

  it.each([
    {
      argv: ['prepare', '--authorization-ref', 'om_authorize', '--plan-sha256', SHA,
        '--dispatch-spec', '/tmp/dispatch.json'],
      expected: {
        action: 'prepare_task_control_canary', authorizationRef: 'om_authorize', planSha256: SHA,
        dispatchSpecPath: '/tmp/dispatch.json',
      },
    },
    {
      argv: ['enable', '--fence-fingerprint', FENCE, '--expected-config-hash', CONFIG],
      expected: { action: 'enable_task_control_canary', fenceFingerprint: FENCE, expectedConfigHash: CONFIG },
    },
    {
      argv: ['phase-a-send', '--fence-fingerprint', FENCE, '--instruction-template-sha256', SHA],
      expected: { action: 'send_task_control_phase_a', fenceFingerprint: FENCE, instructionTemplateSha256: SHA },
    },
    {
      argv: ['disable', '--fence-fingerprint', FENCE, '--expected-config-hash', CONFIG],
      expected: { action: 'disable_task_control_canary', fenceFingerprint: FENCE, expectedConfigHash: CONFIG },
    },
    {
      argv: ['clear', '--fence-fingerprint', FENCE, '--cleanup-state', 'pre_dispatch_abort'],
      expected: { action: 'clear_task_control_canary_fence', fenceFingerprint: FENCE,
        cleanupState: 'pre_dispatch_abort' },
    },
    {
      argv: ['clear', '--fence-fingerprint', FENCE, '--cleanup-state', 'delivered_terminal',
        '--success-certificate-hash', CERTIFICATE],
      expected: { action: 'clear_task_control_canary_fence', fenceFingerprint: FENCE,
        cleanupState: 'delivered_terminal', successCertificateHash: CERTIFICATE },
    },
    {
      argv: ['abandon', '--authorization-ref', 'om_abandon', '--fence-fingerprint', FENCE,
        '--expected-config-hash', CONFIG],
      expected: { action: 'abandon_task_control_canary', authorizationRef: 'om_abandon',
        fenceFingerprint: FENCE, expectedConfigHash: CONFIG },
    },
  ])('maps exact argv for $argv.0', ({ argv, expected }) => {
    expect(parseTaskControlCanaryOperationArgs(argv)).toEqual(expected);
  });

  it.each([
    ['status', '--session-id', 'foreign'],
    ['status', '--app-id', 'cli_foreign'],
    ['status', '--chat-id', 'oc_foreign'],
    ['status', '--root', 'om_foreign'],
    ['prepare', '--plan-sha256', SHA, '--authorization-ref', 'om_authorize',
      '--dispatch-spec', '/tmp/dispatch.json'],
    ['enable', '--fence-fingerprint', FENCE, '--expected-config-hash', `pgc1:${'X'.repeat(64)}`],
    ['clear', '--fence-fingerprint', FENCE, '--cleanup-state', 'delivered_terminal'],
    ['clear', '--fence-fingerprint', FENCE, '--cleanup-state', 'pre_dispatch_abort',
      '--success-certificate-hash', CERTIFICATE],
    ['unknown'],
  ])('rejects non-canonical argv: %j', argv => {
    expect(() => parseTaskControlCanaryOperationArgs(argv)).toThrow('invalid_task_control_canary_operation_argv');
  });

  it('rejects an empty argv', () => {
    expect(() => parseTaskControlCanaryOperationArgs([])).toThrow('invalid_task_control_canary_operation_argv');
  });

  it('loads the current managed session and sends only the canonical request through host IPC', async () => {
    const dispatchSpec = { dispatchOperationId: 'e'.repeat(50), targetChatId: 'oc_project' };
    const calls: Array<{ port: number; path: string; init: RequestInit }> = [];
    const result = await runTaskControlCanaryOperation(
      ['prepare', '--authorization-ref', 'om_authorize', '--plan-sha256', SHA,
        '--dispatch-spec', '/tmp/dispatch.json'],
      {
        resolveContext: () => ({
          sessionId: 'session-current', larkAppId: 'cli_current', ipcPort: 4321,
        }),
        readDispatchSpec: async (path: string) => {
          expect(path).toBe('/tmp/dispatch.json');
          return dispatchSpec;
        },
        fetchDaemonIpc: async (port: number, path: string, init: RequestInit) => {
          calls.push({ port, path, init });
          return new Response(JSON.stringify({ ok: true, fenceFingerprint: FENCE }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    expect(result).toEqual({ ok: true, fenceFingerprint: FENCE });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      port: 4321,
      path: '/api/sessions/session-current/project',
      init: { method: 'POST' },
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      action: 'prepare_task_control_canary',
      authorizationRef: 'om_authorize',
      planSha256: SHA,
      dispatchSpec,
    });
  });

  it('wires Phase A send to one daemon-generation attempt identity', () => {
    const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    expect(daemon).toContain('setTaskControlCanaryPhaseASendHandler');
    expect(daemon).toContain('taskControlPhaseAProcessStartedAt');
    expect(daemon).toContain("processStartedAt: taskControlPhaseAProcessStartedAt");
    expect(daemon).toContain('setTaskControlCanaryPhaseASendHandler(null)');
  });
});
