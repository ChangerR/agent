/**
 * 内置工具插件：与第三方插件走同一个 Plugin 接口注册 —— 自举示范。
 */
import type { Plugin } from '../sdk/plugin.js';
import { bashTool } from './bash.js';
import { editFileTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readFileTool } from './read.js';
import { writeFileTool } from './write.js';

export const builtinToolDefinitions = [readFileTool, writeFileTool, editFileTool, bashTool, globTool, grepTool] as const;

export const builtinTools: Plugin = {
  manifest: { id: 'agentlab.builtin-tools', version: '1.0.0', apiVersion: 1 },
  setup(ctx) {
    for (const tool of builtinToolDefinitions) {
      ctx.provide.tool(tool.name, tool);
    }
  },
};
