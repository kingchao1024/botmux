import { existsSync, readFileSync } from 'node:fs';

import { verifyAskReceipt } from './ask-receipt.js';

export interface AskReceiptCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readSource(source: string, stdin: string): string {
  return source === '-' ? stdin : readFileSync(source, 'utf8');
}

function parseReceipt(raw: string): unknown {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'receipt' in parsed) {
    return (parsed as { receipt?: unknown }).receipt;
  }
  return parsed;
}

function resolvePublicKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!existsSync(raw)) return raw;
  const text = readFileSync(raw, 'utf8').trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof (parsed as Record<string, unknown>).publicKey === 'string') {
      return (parsed as { publicKey: string }).publicKey;
    }
  } catch { /* plain encoded key */ }
  return text;
}

/** Offline verifier. It performs no daemon discovery and needs no BOTMUX_* env. */
export function runAskReceiptCommand(
  args: readonly string[],
  stdin = '',
): AskReceiptCommandResult {
  const usage = 'Usage: botmux ask receipt verify <receipt.json|-> [--public-key <base64url|file>] [--key-id <sha256>] [--at <epoch-ms>] [--allow-expired] [--json]';
  if (args[0] !== 'verify') return { code: 2, stdout: '', stderr: `${usage}\n` };
  const source = args[1];
  if (!source || source.startsWith('--')) return { code: 2, stdout: '', stderr: `${usage}\n` };
  const json = args.includes('--json');
  const publicKeyRaw = valueAfter(args, '--public-key');
  const keyId = valueAfter(args, '--key-id');
  if (!publicKeyRaw && !keyId) {
    return {
      code: 2, stdout: '',
      stderr: 'botmux ask receipt verify: require --public-key or --key-id trust anchor\n',
    };
  }
  if ((args.includes('--public-key') && !publicKeyRaw) || (args.includes('--key-id') && !keyId)) {
    return { code: 2, stdout: '', stderr: `${usage}\n` };
  }
  const atRaw = valueAfter(args, '--at');
  const at = atRaw === undefined ? undefined : Number(atRaw);
  if (atRaw !== undefined && (!Number.isSafeInteger(at) || at! < 0)) {
    return { code: 2, stdout: '', stderr: 'botmux ask receipt verify: --at must be a non-negative epoch-ms integer\n' };
  }
  try {
    const candidate = parseReceipt(readSource(source, stdin));
    const verification = verifyAskReceipt(candidate, {
      publicKey: resolvePublicKey(publicKeyRaw),
      keyId,
      now: at,
      allowExpired: args.includes('--allow-expired'),
    });
    if (!verification.ok) {
      const body = { ok: false, error: verification.error };
      return {
        code: verification.error === 'expired' ? 4 : 3,
        stdout: json ? `${JSON.stringify(body)}\n` : '',
        stderr: json ? '' : `Ask receipt verification failed: ${verification.error}\n`,
      };
    }
    const body = { ok: true, expired: verification.expired, payload: verification.payload };
    return {
      code: 0,
      stdout: json ? `${JSON.stringify(body)}\n` : `valid ${verification.payload.jti}\n`,
      stderr: '',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const body = { ok: false, error: 'malformed', detail };
    return {
      code: 2,
      stdout: json ? `${JSON.stringify(body)}\n` : '',
      stderr: json ? '' : `Ask receipt verification failed: ${detail}\n`,
    };
  }
}
