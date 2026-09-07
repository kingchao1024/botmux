import { homedir } from 'node:os';
import { join } from 'node:path';

function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

/** MiMoCode data root: XDG_DATA_HOME, or ~/.local/share/mimocode. */
export function mimocodeDataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg ? expandHome(xdg) : join(homedir(), '.local', 'share');
  return join(base, 'mimocode');
}

/** MiMoCode's SQLite store, using the OpenCode V1 session schema. */
export function mimocodeDbPath(): string {
  return join(mimocodeDataRoot(), 'mimocode.db');
}
