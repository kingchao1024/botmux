import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function typescriptFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) out.push(...typescriptFiles(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('Ask receipt authority import boundary', () => {
  it('keeps the daemon authority out of non-daemon production modules', () => {
    const srcRoot = resolve('src');
    const offenders = typescriptFiles(srcRoot)
      .filter(path => relative(srcRoot, path) !== 'daemon.ts')
      .filter(path => relative(srcRoot, path) !== join('daemon', 'ask-receipt-authority.ts'))
      .filter(path => readFileSync(path, 'utf8').includes('daemon/ask-receipt-authority'));
    expect(offenders.map(path => relative(srcRoot, path))).toEqual([]);
  });

  it('keeps private-key and mint factory implementation out of the public codec', () => {
    const source = readFileSync(resolve('src/core/ask-receipt.ts'), 'utf8');
    expect(source).not.toMatch(/createPrivateKey|generateKeyPair|cryptoSign|createAskReceiptSigner|createAskAnswerProvenanceAuthority/);
  });

  it('allows the daemon authority import only from daemon bootstrap in production', () => {
    const srcRoot = resolve('src');
    const importers = typescriptFiles(srcRoot)
      .filter(path => relative(srcRoot, path) !== join('daemon', 'ask-receipt-authority.ts'))
      .filter(path => {
        const source = readFileSync(path, 'utf8');
        return source.includes("from './daemon/ask-receipt-authority.js'")
          || source.includes('from "./daemon/ask-receipt-authority.js"');
      })
      .map(path => relative(srcRoot, path));
    expect(importers).toEqual(['daemon.ts']);
  });
});
