import { definePlugin } from '../sdk/index.js';
import { bashTool } from '../tools/bash.js';
import { editFileTool } from '../tools/edit.js';
import { globTool } from '../tools/glob.js';
import { grepTool } from '../tools/grep.js';
import { readFileTool } from '../tools/read.js';
import { writeFileTool } from '../tools/write.js';
import { z } from 'zod';
export const localToolsPlugin = definePlugin({
  manifest: { id: 'agentlab.local-tools', version: '1.0.0', apiVersion: 1, configVersion: 1 },
  config: { schema: z.object({ disabled: z.array(z.string()).default([]) }), defaults: { disabled: [] }, applyMode: 'new-session' },
  setup(ctx) {
    const disabled = ctx.config.value.disabled as string[];
    for (const tool of [readFileTool, writeFileTool, editFileTool, bashTool, globTool, grepTool]) if (!disabled.includes(tool.name)) ctx.provide.tool(tool.name, tool);
    ctx.provide.settings('local-tools', { title: '本地工具', description: '禁用单个工具后，重启或新会话生效。', applyMode: 'new-session', schema: { type: 'object', properties: { disabled: { type: 'array', items: { type: 'string' } } } }, read: () => ctx.config.value });
  },
});
