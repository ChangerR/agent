#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createAgent } from '../index.js';
import { initializeCliHome } from './initialize.js';

const help = `AgentLab

用法: agentlab [选项]

  --command <line>  执行已注册命令后退出；不加载终端组件
  --json            --command 的结果输出 JSON
  --resume <id>     启动后恢复指定会话，id 为 latest 时恢复最近一次
  --allow-legacy-session  确认当前配置兼容，迁移缺少 provider 身份的旧会话
  --sessions        列出本项目已保存的会话后退出
  -h, --help        显示帮助
`;

let values: { command?: string; json?: boolean; resume?: string; sessions?: boolean; help?: boolean; 'allow-legacy-session'?: boolean };
try {
  ({ values } = parseArgs({ options: {
    command: { type: 'string' }, json: { type: 'boolean', default: false },
    resume: { type: 'string' }, 'allow-legacy-session': { type: 'boolean', default: false },
    sessions: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  }, allowPositionals: false, strict: true }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exit(1);
}
if (values.help) { console.log(help); process.exit(0); }
if (values.command && (values.resume || values.sessions)) { console.error('--command 不能与 --resume 或 --sessions 同时使用'); process.exit(1); }

// SDK 配置读取仍保持只读；实际 CLI 在装配 provider 前准备用户目录。
try { initializeCliHome(process.cwd()); }
catch (error) { console.error(`无法初始化用户配置/状态目录: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
const agent = await createAgent(process.cwd());
if (values.command !== undefined) {
  const controller = new AbortController(); const abort = () => controller.abort(); process.once('SIGINT', abort);
  try {
    const result = await agent.dispatchCommand(values.command, { signal: controller.signal });
    if (result?.type === 'interaction') {
      console.log(JSON.stringify({ status: 'interaction_required', request: result })); process.exitCode = 2;
    } else if (values.json) console.log(JSON.stringify(result ?? { type: 'text', text: '' }));
    else if (result?.type === 'text') console.log(result.text);
    else if (result?.type === 'data') console.log(result.text ?? JSON.stringify(result.data, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', abort); await agent.dispose(); }
} else if (values.sessions) {
  try {
    const listing = await agent.session.list();
    if (!listing.sessions.length && !listing.broken.length) console.log('(本项目还没有已保存的会话)');
    for (const item of listing.sessions) console.log(`${item.id}${item.id === agent.session.id ? ' ✓' : ''} · ${item.title} · ${item.messageCount} 条`);
    for (const item of listing.broken) console.error(`[坏文件] ${item.id}: ${item.error.message}`);
    process.exitCode = listing.broken.length ? 1 : 0;
  } finally { await agent.dispose(); }
} else if (values.resume && !process.stdin.isTTY) {
  console.error('会话恢复需要交互式终端'); await agent.dispose(); process.exitCode = 1;
} else {
  // 直到真正启动 TUI 才导入 pi-tui；脚本命令无需终端代码。
  const { startTui } = await import('./app.js');
  if (!startTui(agent, values.resume ? { resume: values.resume, allowLegacySession: values['allow-legacy-session'] } : {})) await agent.dispose();
}
