import { PM2_GRACEFUL_EXIT_CODE } from '../pm2-graceful-exit.js';

/**
 * Descriptor capability required before a supervisor may signal a live daemon.
 * Bump this exact value whenever shutdown safety depends on a protocol that an
 * already-running older daemon does not implement.
 * （canonical 保留：上游精简了本模块，但 fork 的 fleet-runtime/daemon 仍消费此协议常量。）
 */
export const SUPERVISOR_SHUTDOWN_PROTOCOL = 'riff-fleet-prepare-persist-commit-managed-sentinel-v3' as const;

/**
 * PM2 normalizes signal-only child exits to code 0 (`code || 0`) before it
 * evaluates `stop_exit_codes`. Zero therefore cannot prove that the daemon
 * completed its shutdown protocol: SIGKILL/OOM may look identical. Only the
 * successful end of a supervised daemon.shutdown() exits with this reserved
 * non-zero code; foreground launches keep the conventional zero exit.
 */
export const DAEMON_GRACEFUL_EXIT_CODE = PM2_GRACEFUL_EXIT_CODE;

export type SupervisorShutdownProtocol = typeof SUPERVISOR_SHUTDOWN_PROTOCOL;
