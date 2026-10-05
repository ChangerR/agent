#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createAgent } from '../index.js';
import { startTui } from './app.js';

const help = `AgentLab

用法: agentlab [选项]

  --resume <id>   启动后恢复指定会话，id 为 latest 时恢复最近一次
  --sessions      列出本项目已保存的会话后退出
  -h, --help      显示帮助
`;

let values: { resume?: string; sessions?: boolean; help?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      resume: { type: 'string' },
      sessions: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (values.help) {
  console.log(help);
  process.exit(0);
}

const cwd = process.cwd();
const agent = await createAgent(cwd);

if (values.sessions) {
  const listing = await agent.session.list();
  if (listing.sessions.length === 0 && listing.broken.length === 0) {
    console.log('(本项目还没有已保存的会话)');
  } else {
    for (const item of listing.sessions) {
      const mark = item.id === agent.session.id ? ' ✓' : '';
      console.log(`${item.id}${mark} · ${item.title} · ${item.messageCount} 条`);
    }
  }
  for (const item of listing.broken) {
    console.error(`[坏文件] ${item.id}: ${item.error.message}`);
  }
  await agent.dispose();
  process.exit(listing.broken.length > 0 ? 1 : 0);
}

if (values.resume && !process.stdin.isTTY) {
  console.error('会话恢复需要交互式终端');
  await agent.dispose();
  process.exit(1);
}

if (!startTui(agent, values.resume ? { resume: values.resume } : {})) await agent.dispose();
