import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexRpcEngine } from '../../src/codex-rpc-engine.js';

const pidFile = process.argv[2];
if (!pidFile) throw new Error('expected pid-file argument');
const groupChildPidFile = process.argv[3];
if (!groupChildPidFile) throw new Error('expected group-child-pid-file argument');

const fakeServer = fileURLToPath(new URL('./fake-codex-rpc-server.mjs', import.meta.url));
const engine = new CodexRpcEngine({
  cliBin: fakeServer,
  cwd: tmpdir(),
  env: {
    ...process.env,
    FAKE_GROUP_CHILD_PID_FILE: groupChildPidFile,
    FAKE_LEADER_EXITS_ON_SIGTERM: '1',
  },
});

await engine.start();
writeFileSync(pidFile, String(engine.appServerPid));
engine.stop();
process.exit(0);
