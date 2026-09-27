import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDurableProcessIdentity } from '../../utils/process-identity.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { parseInvocation, type InvocationRequest, type InvocationResult } from './contract.js';
import { NativeInvocationError, type NativeInvocationOutput } from './runtime.js';
import { sanitizeNativeError, SAFE_NATIVE_ERROR_CODES } from './error-sanitize.js';

interface StoredInvocation { fingerprint: string; lease: string; ownerPid: number; ownerIdentity?: string; result: InvocationResult }
export interface InvocationServiceOptions {
  directory: string;
  run(request: InvocationRequest, signal: AbortSignal): Promise<NativeInvocationOutput>;
  maxConcurrent?: number;
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** A daemon-owned, single-turn headless worker. Requests cannot select an
 * existing interactive session, provide an owner, resume, steer, or publish. */
export class InvocationService {
  private readonly lease = randomUUID();
  private readonly ownerIdentity = readDurableProcessIdentity(process.pid);
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  constructor(private readonly options: InvocationServiceOptions) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  }
  private path(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('invalid_request_id');
    return join(this.options.directory, `${id}.json`);
  }
  private read(id: string): StoredInvocation | undefined {
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    const record: StoredInvocation = JSON.parse(readFileSync(path, 'utf8'));
    if (record.result.state === 'running' && record.lease !== this.lease) {
      const currentIdentity = readDurableProcessIdentity(record.ownerPid);
      const reusedPid = currentIdentity && record.ownerIdentity && currentIdentity !== record.ownerIdentity;
      try {
        process.kill(record.ownerPid, 0);
        if (!reusedPid) return record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('invocation_owner_unknown');
      }
      // A daemon restart is ambiguous. Never repeat an accepted inference.
      record.result.state = 'failed';
      record.result.error = 'interrupted_unknown_outcome';
      this.save(record);
    }
    return record;
  }
  private save(record: StoredInvocation): void {
    atomicWriteFileSync(this.path(record.result.requestId), JSON.stringify(record), { mode: 0o600 });
  }
  private sanitizedResult(record: StoredInvocation): InvocationResult {
    if (record.result.state === 'failed' && record.result.error && !SAFE_NATIVE_ERROR_CODES.has(record.result.error)) {
      record.result.error = 'native_inference_failed';
      // A legacy raw error must not remain on disk for the next non-wait retry.
      this.save(record);
    }
    return record.result;
  }
  get(id: string): InvocationResult | undefined {
    const record = this.read(id);
    if (!record) return undefined;
    return this.sanitizedResult(record);
  }
  start(input: unknown): InvocationResult {
    const request = parseInvocation(input);
    const fingerprint = createHash('sha256').update(stable(request)).digest('hex');
    const previous = this.read(request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('idempotency_conflict');
      return this.sanitizedResult(previous);
    }
    if (this.active.size >= (this.options.maxConcurrent ?? 4)) throw new Error('invocation_capacity_exceeded');
    const record: StoredInvocation = { fingerprint, lease: this.lease, ownerPid: process.pid, ownerIdentity: this.ownerIdentity, result: {
      requestId: request.requestId, state: 'running', output: null, error: null,
      startedAt: new Date().toISOString(), durationMs: null, startupMs: null,
      configuredModel: null, actualModel: null, reasoningEffort: null, usage: null, usageSource: null,
    } };
    // Reserve before any async work. wx also fences a duplicate daemon writer.
    writeFileSync(this.path(request.requestId), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, request.deadlineMs);
    const done = Promise.resolve().then(async () => {
      try {
        const output = await this.options.run(request, controller.signal);
        if (!controller.signal.aborted) Object.assign(record.result, output, { state: 'completed' });
      } catch (error) {
        if (error instanceof NativeInvocationError) {
          Object.assign(record.result, error.telemetry);
          // Sanitize: only explicit SAFE_NATIVE_ERROR_CODES may appear in
          // persisted error. Everything else (raw CLI stderr, paths,
          // API keys, provider error text) is rewritten to a generic code.
          record.result.error = sanitizeNativeError(error.message);
        } else {
          record.result.error = error instanceof Error && SAFE_NATIVE_ERROR_CODES.has(error.message)
            ? error.message
            : 'invocation_failed';
        }
        record.result.state = 'failed';
      } finally {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          record.result.state = expired ? 'timed_out' : 'cancelled';
          record.result.error = expired ? 'deadline_exceeded' : 'cancelled';
          record.result.output = null;
        }
        record.result.durationMs = Date.now() - Date.parse(record.result.startedAt);
        try { this.save(record); } finally { this.active.delete(request.requestId); }
      }
    });
    this.active.set(request.requestId, { controller, done });
    // A storage failure is surfaced by wait/result (record remains running),
    // and must not become an unhandled daemon rejection.
    void done.catch(() => {});
    return { ...record.result };
  }
  async cancel(id: string): Promise<InvocationResult | undefined> {
    const active = this.active.get(id);
    active?.controller.abort();
    await active?.done;
    return this.get(id);
  }
  async wait(id: string, waitMs: number): Promise<InvocationResult | undefined> {
    const active = this.active.get(id);
    if (active && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([active.done, new Promise(resolve => { timer = setTimeout(resolve, Math.min(waitMs, 30_000)); })]);
      } finally { clearTimeout(timer); }
    }
    return this.get(id);
  }
  async close(): Promise<void> {
    const running = [...this.active.values()];
    for (const entry of running) entry.controller.abort();
    await Promise.allSettled(running.map(entry => entry.done));
  }
}
