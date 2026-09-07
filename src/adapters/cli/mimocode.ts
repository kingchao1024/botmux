import { createOpenCodeLikeAdapter } from './opencode.js';
import { mimocodeDbPath } from '../../services/mimocode-paths.js';

export function createMiMoCodeAdapter(pathOverride?: string) {
  return createOpenCodeLikeAdapter(pathOverride, {
    id: 'mimocode',
    defaultBin: 'mimo',
    dataRoot: '~/.local/share/mimocode',
    authPaths: [
      '~/.config/mimocode',
      '~/.local/share/mimocode',
      '~/.local/state/mimocode',
      '~/.cache/mimocode',
    ],
    dbPath: mimocodeDbPath,
    skillsDir: '~/.config/mimocode/skills',
    hookConfigPath: '~/.config/mimocode/plugin/botmux-ask.js',
    modelChoices: [
      'xiaomi/mimo-v2.5-pro',
      'xiaomi/mimo-v2.5-pro-ultraspeed',
    ],
  });
}

export const create = createMiMoCodeAdapter;
