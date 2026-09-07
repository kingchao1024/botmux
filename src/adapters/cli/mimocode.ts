import { createOpenCodeLikeAdapter } from './opencode.js';
import {
  mimocodeCachePath,
  mimocodeConfigPath,
  mimocodeDataPath,
  mimocodeDbPath,
  mimocodeStatePath,
} from '../../services/mimocode-paths.js';

export function createMiMoCodeAdapter(pathOverride?: string) {
  return createOpenCodeLikeAdapter(pathOverride, {
    id: 'mimocode',
    defaultBin: 'mimo',
    dataRoot: mimocodeDataPath(),
    authPaths: [
      mimocodeConfigPath(),
      mimocodeDataPath(),
      mimocodeStatePath(),
      mimocodeCachePath(),
    ],
    dbPath: mimocodeDbPath,
    skillsDir: `${mimocodeConfigPath()}/skills`,
    hookConfigPath: `${mimocodeConfigPath()}/plugin/botmux-ask.js`,
    modelChoices: [
      'xiaomi/mimo-v2.5-pro',
      'xiaomi/mimo-v2.5-pro-ultraspeed',
    ],
  });
}

export const create = createMiMoCodeAdapter;
