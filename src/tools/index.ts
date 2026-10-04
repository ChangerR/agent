/**
 * 内置工具插件：与第三方插件走同一个 Plugin 接口注册 —— 自举示范。
 */
import type { Plugin } from '../core/plugin.js';
import { bashTool } from './bash.js';
import { editFileTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readFileTool } from './read.js';
import { writeFileTool } from './write.js';

export const builtinTools: Plugin = {
  name: 'builtin-tools',
  register(ctx) {
    for (const tool of [readFileTool, writeFileTool, editFileTool, bashTool, globTool, grepTool]) {
      ctx.tools.register(tool);
    }
  },
};
