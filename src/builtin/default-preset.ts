/** 默认产品装配集中在 preset；runtime/core 不知道具体实现。 */
import { loadModelsFile } from '../core/config.js';
import { createDeterministicPolicyPlugin } from './policy/index.js';
import { modelReviewerPlugin } from './reviewer-model/plugin.js';
import { runtimeSettingsPlugin } from './runtime-settings.js';
import { uiPlugin } from './ui-plugin.js';
import { providerPlugins } from './providers.js';
import { localToolsPlugin } from './local-tools.js';
import { skillsLocalPlugin } from './skills-local.js';
import { builtinMcpPlugin } from './mcp.js';
import { createContextDefaultPlugin } from './context-default/index.js';
import { createCompactionSummaryPlugin } from './compaction-summary/index.js';
import { createCachePrefixPlugin } from './cache-prefix/index.js';
import { createModelCatalogPlugin } from './model-catalog/index.js';
import { createSessionFilePlugin } from './session-file/index.js';
import { createTelemetryJsonlPlugin } from './telemetry-jsonl/index.js';
import { modelCommandsPlugin, permissionCommandsPlugin, sessionCommandsPlugin, type BuiltinCommandServices } from './commands.js';
import type { Preset, PresetContext } from '../runtime/preset.js';
export function defaultPreset(input: PresetContext): Preset {
  const { cwd, config, services } = input;
  return {
    selections: { policy: 'deterministic', reviewer: 'model', compactor: 'summary', cacheStrategy: 'prefix', modelCatalog: 'presets', sessionStore: 'file' },
    plugins: [
      ...providerPlugins(config), localToolsPlugin, skillsLocalPlugin(cwd), builtinMcpPlugin(config.mcpConfig),
      createDeterministicPolicyPlugin({ cwd, config }), modelReviewerPlugin(input), createContextDefaultPlugin(), createCompactionSummaryPlugin(), createCachePrefixPlugin(),
      createModelCatalogPlugin(loadModelsFile(config.modelsFile)), createSessionFilePlugin(),
      createTelemetryJsonlPlugin({ path: input.logPath, includeBodies: config.pluginConfig['agentlab.telemetry-jsonl']?.includeBodies === true }),
      modelCommandsPlugin(services, cwd), permissionCommandsPlugin(services, cwd), sessionCommandsPlugin(services), uiPlugin(), runtimeSettingsPlugin(input),
    ],
  };
}
