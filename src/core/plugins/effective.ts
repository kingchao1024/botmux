import type { BotConfig } from '../../bot-registry.js';
import type { GlobalConfig } from '../../global-config.js';
import { normalizePluginIdList } from './ids.js';

export function resolveEffectivePluginIds(bot: Pick<BotConfig, 'plugins'>, global: Pick<GlobalConfig, 'plugins'> = {}): string[] {
  const globalPlugins = normalizePluginIdList(global.plugins) ?? [];
  const botPlugins = normalizePluginIdList(bot.plugins) ?? [];
  const effective = new Set(globalPlugins);
  for (const pluginId of botPlugins) effective.add(pluginId);
  return [...effective];
}

/** Plugins enabled in at least one configured scope on this machine. */
export function resolveEnabledPluginIds(
  bots: readonly Pick<BotConfig, 'plugins'>[],
  global: Pick<GlobalConfig, 'plugins'> = {},
): string[] {
  const enabled = new Set(normalizePluginIdList(global.plugins) ?? []);
  for (const bot of bots) {
    for (const pluginId of normalizePluginIdList(bot.plugins) ?? []) enabled.add(pluginId);
  }
  return [...enabled];
}

export interface PluginServiceReconcileSelectionDeps {
  resolveConfigPath: () => string;
  loadBots: (configPath: string) => readonly Pick<BotConfig, 'plugins'>[];
  global: Pick<GlobalConfig, 'plugins'>;
}

/** Select auto services from the same bot registry authority as fleet lifecycle commands. */
export function selectPluginServiceReconcileIds(
  pluginIds: readonly string[] | undefined,
  options: { autoOnly?: boolean },
  deps: PluginServiceReconcileSelectionDeps,
): readonly string[] | undefined {
  if (!options.autoOnly) return pluginIds;
  return resolveEnabledPluginIds(deps.loadBots(deps.resolveConfigPath()), deps.global);
}

export function updateBotPluginOverride(
  botPlugins: string[] | undefined,
  pluginId: string,
  enabled: boolean,
): string[] {
  const current = normalizePluginIdList(botPlugins) ?? [];
  if (enabled) return current.includes(pluginId) ? current : [...current, pluginId];
  return current.filter(id => id !== pluginId);
}
