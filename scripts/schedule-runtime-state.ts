#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import {
  isProjectActive,
  readScheduleRuntimeState,
  writeScheduleRuntimeState,
  type ScheduleRuntimeStateKind,
} from '../src/services/schedule-runtime-state-store.js';

const USAGE = `Usage:
  bun scripts/schedule-runtime-state.ts read <patrol|human-action|coordinator-action|delivery> --chat-id <oc_...>
  bun scripts/schedule-runtime-state.ts write <patrol|human-action|coordinator-action|delivery> --chat-id <oc_...> --expected-sha <sha256|missing>
  bun scripts/schedule-runtime-state.ts project-active --chat-id <oc_...>`;

function isKind(value: string | undefined): value is ScheduleRuntimeStateKind {
  return value === 'patrol'
    || value === 'human-action'
    || value === 'coordinator-action'
    || value === 'delivery';
}

function fail(message: string): never {
  process.stderr.write(`schedule-runtime-state: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const command = args[0];
if (command === '--help' || command === '-h') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const kind = args[1];
const projectActiveArgs = command === 'project-active'
  && args.length === 3
  && args[1] === '--chat-id';
const readArgs = command === 'read'
  && args.length === 4
  && isKind(kind)
  && args[2] === '--chat-id';
const writeArgs = command === 'write'
  && args.length === 6
  && isKind(kind)
  && args[2] === '--chat-id'
  && args[4] === '--expected-sha';
if (!projectActiveArgs && !readArgs && !writeArgs) fail(USAGE);
const chatId = projectActiveArgs ? args[2] : args[3];
if (!chatId) fail(USAGE);

try {
  if (command === 'project-active') {
    process.stdout.write(isProjectActive(chatId) ? '1\n' : '0\n');
  } else {
    if (!isKind(kind)) fail(USAGE);
    if (command === 'read') {
      process.stdout.write(`${JSON.stringify(readScheduleRuntimeState(kind, chatId))}\n`);
    } else if (command === 'write') {
      const expectedSha256 = args[5];
      if (!expectedSha256) fail(USAGE);
      const raw = readFileSync(0, 'utf8');
      if (!raw.trim()) fail('stdin JSON is required');
      let next: unknown;
      try {
        next = JSON.parse(raw);
      } catch {
        fail('stdin is not valid JSON');
      }
      const result = writeScheduleRuntimeState({ kind, chatId, expectedSha256, next });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        kind: result.kind,
        chatId: result.chatId,
        path: result.path,
        sha256: result.sha256,
      })}\n`);
    } else {
      fail(USAGE);
    }
  }
} catch (error) {
  process.stderr.write(`schedule-runtime-state: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
