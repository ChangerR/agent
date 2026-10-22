/** 从已装配的真实设置注册表生成覆盖清单；不读用户配置，不发送模型请求。 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] ?? join(repo, 'docs/SETTINGS-FIELD-COVERAGE.md'));
const fixture = await mkdtemp(join(tmpdir(), 'agentlab-field-coverage-'));
const home = join(fixture, 'home'),
  project = join(fixture, 'project');
for (const key of Object.keys(process.env))
  if (!['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].includes(key))
    delete process.env[key];
process.env.HOME = home;
process.env.USERPROFILE = home;
await mkdir(home);
await mkdir(project);
await writeFile(
  join(project, 'agent.config.json'),
  JSON.stringify({
    provider: 'fake',
    capabilities: { reviewer: false },
    pluginConfig: { 'agentlab.planning': { mode: 'off' } },
  }),
);
const child = fork(join(repo, 'desktop/dist/worker/index.mjs'), [], {
  cwd: project,
  env: process.env,
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
});
let snapshot;
const pending = new Map();
const ready = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code) reject(Error('worker exited: ' + code));
  });
  child.on('message', (message) => {
    if (message.type === 'ready') resolve();
    if (message.type === 'state') snapshot = message.state;
    if (message.type === 'reply') {
      const p = pending.get(message.id);
      if (p) {
        pending.delete(message.id);
        message.error ? p.reject(Error(message.error)) : p.resolve();
      }
    }
  });
});
const deadline = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
  console.error('覆盖盘点超时');
}, 30000);
const request = (action) =>
  new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    child.send({ id, action });
  });
const control = (s) =>
  s.writeOnly
    ? '安全密码输入 / 保留 / 替换 / 清除'
    : s['x-rule']
      ? '工具与目标规则构建器'
      : s.anyOf
        ? '类型选择 + 对应结构化控件'
        : s.enum || s.const !== undefined
          ? '枚举下拉'
          : Array.isArray(s.type)
            ? '类型选择'
            : s.type === 'object'
              ? s.properties
                ? '分组字段'
                : '键值行 / 列表详情 / 增删改名'
              : s.type === 'array'
                ? '列表增删排序'
                : s.type === 'boolean'
                  ? '启用/关闭下拉'
                  : ['number', 'integer'].includes(s.type)
                    ? '数值输入'
                    : s.type === 'string'
                      ? '文本 / 候选输入'
                      : s.type === 'null'
                        ? '空值选择'
                        : '明确类型选择 + 递归控件';
const rows = [];
function walk(section, s, path) {
  rows.push({
    section: section.id,
    title: section.title,
    path,
    control: control(s),
    scope: section.scopes.map((s) => s.scope).join(' / '),
    effect: section.applyMode ?? '声明',
    constraints: [
      s.enum?.join(', '),
      s.minimum !== undefined ? 'min ' + s.minimum : '',
      s.maximum !== undefined ? 'max ' + s.maximum : '',
    ]
      .filter(Boolean)
      .join('; '),
  });
  for (const [key, child] of Object.entries(s.properties ?? {}))
    walk(section, child, path ? path + '.' + key : key);
  if (s.items) walk(section, s.items, path + '[]');
  if (typeof s.additionalProperties === 'object')
    walk(section, s.additionalProperties, path + '.*');
  if (s.anyOf)
    s.anyOf.forEach((child, i) => walk(section, child, path + ' [' + (child.title ?? i + 1) + ']'));
}
try {
  await ready;
  await request({ type: 'init', cwd: project, demo: false, generation: randomUUID() });
  const sections = snapshot.settings.filter((s) => s.editable);
  for (const section of sections) {
    const schema = section.schema;
    if (schema.properties)
      for (const [key, child] of Object.entries(schema.properties)) walk(section, child, key);
    else walk(section, schema, '(根)');
  }
  const md = [
    '# 设置字段覆盖矩阵',
    '',
    '先运行 `pnpm desktop:build`，再以 `node desktop/scripts/settings-coverage.mjs` 从真实默认 preset、构建后的 Node worker、已装配 SettingsSection 和动态 getSchema 生成；不按手写字段清单推测。`*` 是可增删/改名的 map 键，`[]` 是可增删/排序的数组项，方括号表示条件分支。嵌套字段均有独立覆盖开关，未选中不回填默认。',
    '',
    '所有配置写入都由原始 schema、领域校验及受控 CAS 后端最终校验；表中的边界是表单附加提示。newSession 表示 App 明确“重新装配并新建会话”或退出重启后采用；nextRequest 为原有即时设置协议，权限仍按后端规则检查。用户/项目原始值、合成有效值与当前会话分开显示。',
    '',
    `本清单：${sections.length} 个可编辑入口，${rows.length} 个字段/容器/分支节点。外观与当前会话快捷控件、项目/会话动作另见 [说明](CONFIGURATION-SETTINGS.md)。外部插件动态字段按其实际 schema/ownedFields 在运行时添加；未加载的未知命名空间保持原样，不提供任意文件写入口。`,
    '',
    '| 页面 / 注册 ID | 字段 | 控件 | 作用域 | 生效 | 附加约束 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.title}<br>\`${r.section}\` | \`${r.path}\` | ${r.control} | ${r.scope} | ${r.effect} | ${r.constraints.replaceAll('|', '\\|')} |`,
    ),
    '',
  ];
  await writeFile(output, md.join('\n'));
  await writeFile(
    join(dirname(output), 'evidence/graphical-settings/registered-fields.json'),
    JSON.stringify({ sections: sections.length, nodes: rows.length, fields: rows }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ sections: sections.length, nodes: rows.length, output }));
} finally {
  clearTimeout(deadline);
  if (child.connected) {
    await request({ type: 'dispose' });
    child.disconnect();
  }
  await rm(fixture, { recursive: true, force: true });
}
