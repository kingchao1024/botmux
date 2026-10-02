#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import { resolveBotmuxAncestorContext } from '../src/cli/current-actor.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';

const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FENCE_FINGERPRINT = /^tccq1:[a-f0-9]{64}$/;
const CONFIG_HASH = /^pgc1:[a-f0-9]{64}$/;
const CERTIFICATE_HASH = /^tcsc1:[a-f0-9]{64}$/;

function requireExact(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error('invalid_task_control_canary_operation_argv');
  }
  return value;
}
export function parseTaskControlCanaryOperationArgs(argv) {
  if (argv.length === 1 && argv[0] === 'status') {
    return { action: 'task_control_canary_status' };
  }
  if (argv.length === 7 && argv[0] === 'prepare'
    && argv[1] === '--authorization-ref' && argv[3] === '--plan-sha256'
    && argv[5] === '--dispatch-spec') {
    const dispatchSpecPath = argv[6];
    if (!dispatchSpecPath) throw new Error('invalid_task_control_canary_operation_argv');
    return {
      action: 'prepare_task_control_canary',
      authorizationRef: requireExact(argv[2], MESSAGE_ID),
      planSha256: requireExact(argv[4], SHA256),
      dispatchSpecPath,
    };
  }
  if (argv.length === 5 && (argv[0] === 'enable' || argv[0] === 'disable')
    && argv[1] === '--fence-fingerprint' && argv[3] === '--expected-config-hash') {
    return {
      action: argv[0] === 'enable' ? 'enable_task_control_canary' : 'disable_task_control_canary',
      fenceFingerprint: requireExact(argv[2], FENCE_FINGERPRINT),
      expectedConfigHash: requireExact(argv[4], CONFIG_HASH),
    };
  }
  if (argv.length === 5 && argv[0] === 'phase-a-send'
    && argv[1] === '--fence-fingerprint' && argv[3] === '--instruction-template-sha256') {
    return {
      action: 'send_task_control_phase_a',
      fenceFingerprint: requireExact(argv[2], FENCE_FINGERPRINT),
      instructionTemplateSha256: requireExact(argv[4], SHA256),
    };
  }
  if ((argv.length === 5 || argv.length === 7) && argv[0] === 'clear'
    && argv[1] === '--fence-fingerprint' && argv[3] === '--cleanup-state') {
    const cleanupState = argv[4];
    const exactState = cleanupState === 'pre_dispatch_abort'
      || cleanupState === 'phase_a_terminal_no_canary'
      || cleanupState === 'delivered_terminal';
    if (!exactState) throw new Error('invalid_task_control_canary_operation_argv');
    const fenceFingerprint = requireExact(argv[2], FENCE_FINGERPRINT);
    if (cleanupState === 'delivered_terminal') {
      if (argv.length !== 7 || argv[5] !== '--success-certificate-hash') {
        throw new Error('invalid_task_control_canary_operation_argv');
      }
      return {
        action: 'clear_task_control_canary_fence', fenceFingerprint, cleanupState,
        successCertificateHash: requireExact(argv[6], CERTIFICATE_HASH),
      };
    }
    if (argv.length !== 5) throw new Error('invalid_task_control_canary_operation_argv');
    return { action: 'clear_task_control_canary_fence', fenceFingerprint, cleanupState };
  }
  if (argv.length === 7 && argv[0] === 'abandon'
    && argv[1] === '--authorization-ref' && argv[3] === '--fence-fingerprint'
    && argv[5] === '--expected-config-hash') {
    return {
      action: 'abandon_task_control_canary',
      authorizationRef: requireExact(argv[2], MESSAGE_ID),
      fenceFingerprint: requireExact(argv[4], FENCE_FINGERPRINT),
      expectedConfigHash: requireExact(argv[6], CONFIG_HASH),
    };
  }
  throw new Error('invalid_task_control_canary_operation_argv');
}

async function readDispatchSpec(path) {
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) {
    throw new Error('invalid_task_control_canary_dispatch_spec');
  }
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_task_control_canary_dispatch_spec');
  }
  return value;
}

export async function runTaskControlCanaryOperation(argv, overrides = {}) {
  const parsed = parseTaskControlCanaryOperationArgs(argv);
  const resolveContext = overrides.resolveContext ?? resolveBotmuxAncestorContext;
  const loadDispatchSpec = overrides.readDispatchSpec ?? readDispatchSpec;
  const postDaemon = overrides.fetchDaemonIpc ?? fetchDaemonIpc;
  const context = resolveContext();
  if (!context || typeof context.sessionId !== 'string' || !context.sessionId
    || typeof context.ipcPort !== 'number' || !Number.isSafeInteger(context.ipcPort)
    || context.ipcPort < 1 || context.ipcPort > 65_535) {
    throw new Error('current_botmux_session_unavailable');
  }
  const { dispatchSpecPath, ...body } = parsed;
  if (dispatchSpecPath !== undefined) {
    body.dispatchSpec = await loadDispatchSpec(dispatchSpecPath);
  }
  const path = `/api/sessions/${encodeURIComponent(context.sessionId)}/project`;
  const response = await postDaemon(context.ipcPort, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`task_control_canary_operation_http_${response.status}`);
  }
  if (!response.ok || !payload || typeof payload !== 'object' || payload.ok !== true) {
    const detail = payload && typeof payload === 'object' && typeof payload.error === 'string'
      ? payload.error
      : `task_control_canary_operation_http_${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

if (import.meta.main) {
  runTaskControlCanaryOperation(process.argv.slice(2)).then(
    payload => process.stdout.write(`${JSON.stringify(payload)}\n`),
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
