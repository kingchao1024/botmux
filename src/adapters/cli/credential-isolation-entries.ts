import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVICE_CREDENTIAL_ISOLATION_READERS_DIRECTORY,
  isCredentialIsolationReservedBasename,
} from './read-isolation.js';
import { DEVICE_AUTHORITY_DIRECTORY } from '../../platform/device-paths.js';

/** Collect exact host-side mount destinations without following symlinks.
 * The caller creates and masks device-auth separately, including when absent. */
export function collectCredentialIsolationEntries(root: string): { directories: string[]; files: string[] } {
  const directories: string[] = [];
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === DEVICE_AUTHORITY_DIRECTORY) continue;
    const dashboard = name === '.dashboard-secret' || name.startsWith('.dashboard-secret.')
      || name === '.dashboard-token' || name.startsWith('.dashboard-token.');
    if (!isCredentialIsolationReservedBasename(name) && !dashboard) continue;
    const entry = join(root, name);
    try {
      const stat = lstatSync(entry);
      if (name === DEVICE_CREDENTIAL_ISOLATION_READERS_DIRECTORY) {
        if (!stat.isDirectory()) {
          throw new Error(`[device-credential-isolation] authority entry is not a directory: ${entry}`);
        }
        directories.push(entry);
      } else {
        if (!stat.isFile()) {
          throw new Error(`[device-credential-isolation] authority entry is not a regular file: ${entry}`);
        }
        files.push(entry);
      }
    } catch (error) {
      // A racing removal needs no mask. The long-lived device authority
      // namespace itself is protected wholesale by the caller.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { directories, files };
}
