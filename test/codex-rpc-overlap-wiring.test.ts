import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('Codex RPC overlap wiring', () => {
  it('keeps ordinary RPC type-ahead behind the native terminal', () => {
    const start = workerSource.indexOf('if (rpcLifecycleFailClosedOwners.size > 0) break;');
    const end = workerSource.indexOf("if (item.trustedCaller && lastInitConfig?.cliId === 'codex') break;", start);
    const tail = workerSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(tail).toContain('if (writeRpcEngine) break;');
  });

  it('uses turn/steer only for an authenticated bot control with an exact native id', () => {
    const start = workerSource.indexOf('if (isTrustedRpcSteer) {');
    const end = workerSource.indexOf('if (item.taskContinuation', start);
    const rpcBranch = workerSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(workerSource).toContain("item.trustedCaller?.senderType === 'bot'");
    expect(rpcBranch).toContain('const expectedTurnId = writeRpcEngine.activeNativeTurnId;');
    expect(rpcBranch).toContain('pendingMessages.unshift(item);');
    expect(rpcBranch).toContain('await writeRpcEngine.steerTurn(msg, expectedTurnId);');
    expect(rpcBranch).not.toContain('await writeRpcEngine.sendTurn(msg, rpcTurnIdentity!);');
  });
});
