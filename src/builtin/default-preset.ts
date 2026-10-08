/** 默认产品装配集中在 preset；runtime/core 不知道具体实现。 */
import { join, resolve } from 'node:path';
import { loadModelsFile, type AgentConfig } from '../core/config.js';
import type { Provider } from '../core/provider.js';
import { definePlugin, type CapabilitySelections, type Plugin } from '../sdk/index.js';
import { uiPlugin } from './ui-plugin.js';
import { providerPlugins } from './providers.js';
import { localToolsPlugin } from './local-tools.js';
import { skillsLocalPlugin } from './skills-local.js';
import { builtinMcpPlugin } from './mcp.js';
import { createLegacyPolicy, PermissionEngine } from './policy-legacy/index.js';
import { AutoJudge, createModelReviewer } from './reviewer-model/index.js';
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
    selections: { policy: 'legacy-v1', reviewer: 'model-v1', compactor: 'summary', cacheStrategy: 'prefix', modelCatalog: 'presets', sessionStore: 'file' },
    plugins: [
      ...providerPlugins(config), localToolsPlugin, skillsLocalPlugin(cwd), builtinMcpPlugin(resolve(cwd, config.mcpConfig)),
      definePlugin({ manifest: { id: 'agentlab.policy-legacy', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
        const controller = new PermissionEngine({ mode: config.permissionMode, rules: config.permissions, dangerForceAsk: config.dangerForceAsk });
        ctx.provide.policy('legacy-v1', createLegacyPolicy(controller));
      } }),
      definePlugin({ manifest: { id: 'agentlab.reviewer-model', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
        const provider: Provider = { name: config.provider, get capabilities() { return input.provider().capabilities; }, stream: (request, signal) => input.provider().stream(request, signal) };
        ctx.provide.reviewer('model-v1', createModelReviewer(new AutoJudge(provider, config.judgeModel?.trim() || services.model, input.modelInfo)));
      } }),
      createContextDefaultPlugin(), createCompactionSummaryPlugin(), createCachePrefixPlugin(),
      createModelCatalogPlugin(loadModelsFile(join(cwd, config.modelsFile))), createSessionFilePlugin(),
      createTelemetryJsonlPlugin({ path: input.logPath, includeBodies: config.pluginConfig['agentlab.telemetry-jsonl']?.includeBodies === true }),
      modelCommandsPlugin(services), permissionCommandsPlugin(services), sessionCommandsPlugin(services), uiPlugin(),
    ],
  };
}
