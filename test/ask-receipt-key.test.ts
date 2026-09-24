import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadOrCreateAskReceiptSigner } from '../src/daemon/ask-receipt-authority.js';

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'botmux-ask-receipt-'));
  roots.push(value);
  chmodSync(value, 0o700);
  return value;
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('Ask receipt signing authority', () => {
  it('creates once with private modes and reloads the same identity', () => {
    const dir = join(root(), 'authority');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'signing-key.json');
    const first = loadOrCreateAskReceiptSigner(file);
    const bytes = readFileSync(file);
    const second = loadOrCreateAskReceiptSigner(file);
    expect(second.keyId).toBe(first.keyId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(readFileSync(file)).toEqual(bytes);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it('fails closed for corrupt or symlinked authority files', () => {
    const dir = join(root(), 'authority');
    mkdirSync(dir, { mode: 0o700 });
    const target = join(dir, 'target');
    const file = join(dir, 'signing-key.json');
    writeFileSync(target, '{}');
    chmodSync(target, 0o600);
    symlinkSync(target, file);
    expect(() => loadOrCreateAskReceiptSigner(file)).toThrow();
  });

  it('fails closed for lax parent/file modes and oversized key state', () => {
    if (process.platform === 'win32') return;
    const dir = join(root(), 'authority');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'signing-key.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    expect(() => loadOrCreateAskReceiptSigner(file)).toThrow(/0600/);

    chmodSync(file, 0o600);
    writeFileSync(file, 'x'.repeat(4_097), { mode: 0o600 });
    expect(() => loadOrCreateAskReceiptSigner(file)).toThrow(/大小|large/);

    rmSync(file);
    chmodSync(dir, 0o750);
    expect(() => loadOrCreateAskReceiptSigner(file)).toThrow(/0700/);
  });
});
