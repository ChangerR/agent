import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { AgentConfigSchema } from '../src/core/config.js';
import { PermissionController } from '../src/builtin/policy/controller.js';
import { createPermissionSettings, describeJudgeStatus, describePermissionRule, type PermissionSettingsPicker } from '../src/builtin/policy/tui.js';
import { SettingsInputPanel, type SettingsInputRequest } from '../src/cli/settings-input.js';
import type { Agent } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(options: { missingGlobal?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-permissions-ui-')); dirs.push(cwd); mkdirSync(join(cwd, '.git'));
  const globalConfigPath = options.missingGlobal ? join(cwd, 'home', '.agent', 'config.json') : join(cwd, 'global.json');
  const path = join(cwd, 'agent.config.json');
  if (!options.missingGlobal) writeFileSync(globalConfigPath, JSON.stringify({ permissions: { deny: ['bash(rm *)'] } }));
  writeFileSync(path, JSON.stringify({ permissionMode: 'ask', permissions: { allow: ['read_file'] }, unknownSecret: 'not-in-ui' }));
  const config = AgentConfigSchema.parse({ permissionMode: 'ask', permissions: { allow: ['read_file'], deny: ['bash(rm *)'] } });
  const permission = new PermissionController({ mode: 'ask', rules: config.permissions });
  const session = { id: 'session-one' };
  const getJudgeStatus = vi.fn<() => ReturnType<Agent['loop']['getJudgeStatus']>>(() => ({ loaded: true, model: config.model, source: 'current' }));
  const agent = { cwd, config, permission, session, loop: { getJudgeStatus } } as unknown as Agent;
  let picker!: PermissionSettingsPicker;
  let input!: SettingsInputRequest;
  let detail = { title: '', body: () => '', onBack: () => {} };
  const notify = vi.fn(); const onModeChange = vi.fn();
  const settings = createPermissionSettings({ agent, globalConfigPath,
    showPicker: request => { picker = request; }, showInput: request => { input = request; },
    showDetails: (title, body, onBack) => { detail = { title, body, onBack }; }, notify, onModeChange });
  const pick = (value: string) => { expect(picker.items.some(item => item.value === value), `Missing ${value} in ${picker.title}`).toBe(true); picker.onPick(value); };
  return { settings, permission, config, session, path, globalConfigPath, cwd, notify, onModeChange, getJudgeStatus, pick, get picker() { return picker; }, get input() { return input; }, get detail() { return detail; } };
}

describe('TUI 权限自动保存', () => {
  it('直接打开本项目，选择一次模式就保存并应用，没有 Save 或二次确认', () => {
    const h = setup(); const before = readFileSync(h.globalConfigPath, 'utf8'); h.settings.open();
    expect(h.picker.title).toContain('本项目权限设置');
    expect(h.picker.items.map(item => item.value)).not.toContain('save');
    expect(h.picker.items.find(item => item.value === 'global')?.label).toContain('可选');
    h.pick('mode'); h.pick('auto');
    expect(h.permission.mode).toBe('auto'); expect(h.onModeChange).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(h.path, 'utf8')).permissionMode).toBe('auto');
    expect(readFileSync(h.globalConfigPath, 'utf8')).toBe(before);
    expect(h.picker.title).toContain('本项目权限设置'); expect(h.picker.requireSelection).not.toBe(true);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('已保存'));
  });

  it('直接模式命令与模式选择都写项目配置，已有审批不被处理', () => {
    const h = setup(); const back = vi.fn(); h.settings.openModes(back); h.pick('yolo');
    expect(h.permission.mode).toBe('yolo'); expect(back).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(h.path, 'utf8')).permissionMode).toBe('yolo');
    h.settings.requestMode('auto');
    expect(h.permission.mode).toBe('auto'); expect(JSON.parse(readFileSync(h.path, 'utf8')).permissionMode).toBe('auto');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('已有审批仍需处理'));
  });

  it('全局编辑保留项目覆盖，应用合并后的有效模式', () => {
    const h = setup(); writeFileSync(h.path, JSON.stringify({ permissionMode: 'ask' }));
    const before = readFileSync(h.path, 'utf8'); h.permission.setMode('auto');
    h.settings.open(); h.pick('global'); h.pick('mode'); h.pick('yolo');
    expect(h.permission.mode).toBe('ask'); expect(readFileSync(h.path, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(h.globalConfigPath, 'utf8')).permissionMode).toBe('yolo');
    expect(h.picker.body?.()).toContain('全局默认 yolo 被本项目 ask 覆盖');
  });

  it('项目恢复继承立即保存并应用全局模式', () => {
    const h = setup(); writeFileSync(h.globalConfigPath, JSON.stringify({ permissionMode: 'auto' }));
    writeFileSync(h.path, JSON.stringify({ permissionMode: 'ask' }));
    h.settings.open(); h.pick('mode'); h.pick('inherit');
    expect(h.permission.mode).toBe('auto'); const raw = JSON.parse(readFileSync(h.path, 'utf8'));
    expect(raw).not.toHaveProperty('permissionMode');
  });

  it('自动保存冲突不覆盖外部文件、不改当前模式或误报成功', () => {
    const h = setup(); h.settings.open(); h.pick('mode'); writeFileSync(h.path, '{"custom":"external"}'); h.pick('auto');
    expect(readFileSync(h.path, 'utf8')).toBe('{"custom":"external"}'); expect(h.permission.mode).toBe('ask');
    expect(h.onModeChange).not.toHaveBeenCalled(); expect(h.notify).toHaveBeenCalledWith(expect.any(String), true);
    expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining('已保存'));
  });

  it('保存锁阻止写入，模式保持不变', () => {
    const h = setup(); const before = readFileSync(h.path, 'utf8'); writeFileSync(`${h.path}.settings.lock`, '');
    h.settings.requestMode('auto'); expect(readFileSync(h.path, 'utf8')).toBe(before); expect(h.permission.mode).toBe('ask');
    expect(h.onModeChange).not.toHaveBeenCalled(); expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('保存锁'), true);
  });

  it('继承层在模式选择期间变化时不应用旧显示值，也不写入', () => {
    const h = setup(); writeFileSync(h.globalConfigPath, '{"permissionMode":"auto"}'); const before = readFileSync(h.path, 'utf8');
    h.settings.open(); h.pick('mode'); writeFileSync(h.globalConfigPath, '{"permissionMode":"yolo"}'); h.pick('inherit');
    expect(readFileSync(h.path, 'utf8')).toBe(before); expect(h.permission.mode).toBe('ask'); expect(h.notify).toHaveBeenCalledWith(expect.any(String), true);
  });

  it.each(['session', 'mode'])('陈旧 %s 选择不会写入或影响新会话', change => {
    const h = setup(); const before = readFileSync(h.path, 'utf8'); h.settings.open(); h.pick('mode');
    if (change === 'session') h.session.id = 'session-two'; else h.permission.setMode('yolo');
    h.pick('auto'); expect(readFileSync(h.path, 'utf8')).toBe(before); expect(h.onModeChange).not.toHaveBeenCalled();
    expect(h.permission.mode).toBe(change === 'session' ? 'ask' : 'yolo');
  });

  it('取消、重复或先前面板的回调失效', () => {
    const h = setup(); const before = readFileSync(h.path, 'utf8'); h.settings.open(); h.pick('mode');
    const cancelled = h.picker; cancelled.onCancel(); cancelled.onPick('yolo'); expect(readFileSync(h.path, 'utf8')).toBe(before);
    h.pick('mode'); const selected = h.picker; h.pick('auto'); selected.onPick('yolo');
    expect(h.permission.mode).toBe('auto'); expect(h.onModeChange).toHaveBeenCalledOnce();
    h.pick('mode'); const old = h.picker; h.settings.open(); old.onPick('yolo'); expect(h.permission.mode).toBe('auto');
  });

  it('规则 Enter 只提交一次，立即持久化；Esc 未提交输入不写盘', () => {
    const h = setup(); const before = readFileSync(h.path, 'utf8'); h.settings.open(); h.pick('rules'); h.pick('allow'); h.pick('add');
    const cancelled = h.input; h.input.onCancel(); cancelled.onSubmit('write_file'); expect(readFileSync(h.path, 'utf8')).toBe(before);
    h.pick('add'); const submitted = h.input; h.input.onSubmit('glob(src/**)'); submitted.onSubmit('glob(src/**)');
    expect(JSON.parse(readFileSync(h.path, 'utf8')).permissions.allow).toEqual(['read_file', 'glob(src/**)']);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('重启'));
    expect(h.config.permissions.allow).toEqual(['read_file']); expect(h.permission.getSessionRules().allow).toEqual([]);
  });

  it('规则编辑与删除立即写盘，保留其他类型、全局和未知字段', () => {
    const h = setup(); const globalBefore = readFileSync(h.globalConfigPath, 'utf8'); h.settings.open(); h.pick('rules'); h.pick('allow'); h.pick('0'); h.pick('edit'); h.input.onSubmit('glob');
    expect(JSON.parse(readFileSync(h.path, 'utf8')).permissions.allow).toEqual(['glob']);
    h.pick('0'); h.pick('delete'); expect(JSON.parse(readFileSync(h.path, 'utf8'))).toMatchObject({ unknownSecret: 'not-in-ui', permissions: { allow: [] } });
    expect(readFileSync(h.globalConfigPath, 'utf8')).toBe(globalBefore); expect(h.picker.items.map(item => item.value)).toEqual(['add']);
  });

  it('无效或冲突规则不写入，不通知保存成功', () => {
    const h = setup(); h.settings.open(); h.pick('rules'); h.pick('allow'); h.pick('add'); const before = readFileSync(h.path, 'utf8');
    h.input.onSubmit('invalid rule'); expect(readFileSync(h.path, 'utf8')).toBe(before);
    writeFileSync(h.path, '{"custom":"external"}'); h.input.onSubmit('glob'); expect(readFileSync(h.path, 'utf8')).toBe('{"custom":"external"}');
    expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining('已保存'));
  });

  it('审批模型选项和输入自动保存，准确提示重启并保留实际运行状态', () => {
    const h = setup(); writeFileSync(h.globalConfigPath, '{"judgeModel":"global-reviewer"}');
    h.settings.open(); h.pick('judge'); expect(h.picker.items.find(item => item.value === 'inherit')?.label).toContain('global-reviewer');
    h.pick('current'); expect(JSON.parse(readFileSync(h.path, 'utf8')).judgeModel).toBe('');
    h.pick('judge'); h.pick('inherit'); expect(JSON.parse(readFileSync(h.path, 'utf8'))).not.toHaveProperty('judgeModel');
    h.pick('judge'); h.pick('name'); const input = h.input; input.onSubmit('next-reviewer'); input.onSubmit('other-reviewer');
    expect(JSON.parse(readFileSync(h.path, 'utf8')).judgeModel).toBe('next-reviewer'); expect(h.config.judgeModel).toBeUndefined();
    expect(h.picker.items.find(item => item.value === 'judgeStatus')?.label).toContain('已加载');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('重启'));
  });

  it('全局打开、取消和继承无更改时不创建目录，真正修改才写原始层', () => {
    const h = setup({ missingGlobal: true }); h.settings.open(); h.pick('global'); h.pick('mode'); h.pick('inherit');
    expect(existsSync(h.globalConfigPath)).toBe(false); h.pick('mode'); h.pick('auto');
    expect(JSON.parse(readFileSync(h.globalConfigPath, 'utf8'))).toEqual({ permissionMode: 'auto' });
    expect(h.permission.mode).toBe('ask');
  });

  it('会话规则一次选择移除，陈旧规则集合不被覆盖', () => {
    const h = setup(); h.permission.addSessionRule('allow', 'glob'); h.permission.addSessionRule('deny', 'write_file(private/**)');
    h.settings.open(); h.pick('session'); const stale = h.picker; h.permission.addSessionRule('allow', 'read_file'); stale.onPick('0');
    expect(h.permission.getSessionRules().allow).toEqual(['glob', 'read_file']);
    h.pick('0'); expect(h.permission.getSessionRules()).toEqual({ allow: ['read_file'], ask: [], deny: ['write_file(private/**)'] });
    expect(h.config.permissions.allow).toEqual(['read_file']);
  });

  it('运行中配置规则只读，核验来源；审批状态不推测已加载模型', () => {
    const h = setup(); h.settings.open(); h.pick('effective');
    expect(h.detail.body()).toContain(`全局配置 ${h.globalConfigPath}`); expect(h.detail.body()).toContain(`项目配置 ${h.path}`);
    expect(h.detail.body()).not.toContain('not-in-ui'); expect(h.detail.body()).toContain('启动时加载的快照'); h.detail.onBack();
    h.getJudgeStatus.mockReturnValue({ loaded: false }); h.pick('judgeStatus'); expect(h.detail.body()).toContain('未加载');
    expect(describePermissionRule('read_file')).toContain('全部调用'); expect(describePermissionRule('bash(="npm test")')).toContain('精确目标');
    expect(describeJudgeStatus({ loaded: true, model: 'model\x1b[2J\nnext', source: 'current' })).toContain('model\\u001b[2J\\u000anext');
  });

  it('控制器拒绝模式时先验证，不改文件或报告成功', () => {
    const h = setup(); const before = readFileSync(h.path, 'utf8');
    Object.assign(h.permission, { validateMode: () => { throw new Error('unsupported mode'); } });
    h.settings.requestMode('auto'); expect(readFileSync(h.path, 'utf8')).toBe(before); expect(h.permission.mode).toBe('ask');
    h.settings.open(); h.pick('mode'); h.pick('yolo'); expect(readFileSync(h.path, 'utf8')).toBe(before);
    expect(h.onModeChange).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining('已保存'));
  });

  it('自定义控制器提交后应用失败，准确报告已保存而非未保存，界面可返回', () => {
    const h = setup(); vi.spyOn(h.permission, 'setMode').mockImplementation(() => { throw new Error('private controller detail'); });
    h.settings.open(); h.pick('mode'); expect(() => h.pick('auto')).not.toThrow();
    expect(JSON.parse(readFileSync(h.path, 'utf8')).permissionMode).toBe('auto'); expect(h.permission.mode).toBe('ask');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('已保存，但当前策略应用失败'), true);
    expect(h.onModeChange).not.toHaveBeenCalled(); expect(h.picker.title).toContain('本项目权限设置');
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain('private controller detail');
  });

  it('格式化 JSON 初始值可直接提交且保留转义字符串', () => {
    const onSubmit = vi.fn(); const original = { list: ['glob'], escaped: 'a\nb' };
    const panel = new SettingsInputPanel({ title: 'JSON', value: JSON.stringify(original, null, 2), format: 'json', description: '', onSubmit, onCancel: vi.fn(), rows: () => 20, changed: vi.fn() });
    panel.handleInput('\r'); expect(JSON.parse(onSubmit.mock.calls[0][0])).toEqual(original);
  });

  it('输入面板有效 Enter 与 Esc 回调均只能执行一次', () => {
    const onSubmit = vi.fn(); const onCancel = vi.fn();
    const panel = new SettingsInputPanel({ title: '字段', value: 'glob', description: '', onSubmit, onCancel, rows: () => 20, changed: vi.fn() });
    panel.handleInput('\r'); panel.handleInput('\r'); panel.handleInput('\x1b'); expect(onSubmit).toHaveBeenCalledOnce(); expect(onCancel).not.toHaveBeenCalled();
    const cancelled = new SettingsInputPanel({ title: '字段', value: 'glob', description: '', onSubmit, onCancel, rows: () => 20, changed: vi.fn() });
    cancelled.handleInput('\x1b'); cancelled.handleInput('\r'); expect(onSubmit).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
  });

  it('完整多行 JSON 粘贴无需逐行确认，Enter 提交一次', () => {
    const onSubmit = vi.fn(); const panel = new SettingsInputPanel({ title: 'JSON', value: '', description: '',
      validate: value => { try { JSON.parse(value); } catch { return 'invalid JSON'; } }, onSubmit, onCancel: vi.fn(), rows: () => 20, changed: vi.fn() });
    panel.handleInput('\x1b[200~{\n\t"allow": ["glob"],\n\t"path": "a\\nb"\n}\x1b[201~'); expect(onSubmit).not.toHaveBeenCalled();
    panel.handleInput('\r'); panel.handleInput('\r'); expect(onSubmit).toHaveBeenCalledOnce(); expect(JSON.parse(onSubmit.mock.calls[0][0])).toEqual({ allow: ['glob'], path: 'a\nb' });
  });

  it('每次独立打开重置返回目标', () => {
    const h = setup(); const back = vi.fn(); h.settings.open(back); h.picker.onCancel(); expect(back).toHaveBeenCalledTimes(1);
    h.settings.open(); h.picker.onCancel(); expect(back).toHaveBeenCalledTimes(1);
    h.settings.openModes(back); h.picker.onCancel(); expect(back).toHaveBeenCalledTimes(2);
    h.settings.openModes(); h.picker.onCancel(); expect(back).toHaveBeenCalledTimes(2);
  });

  it('设置输入使用细分隔线，窄终端宽高有界，无效输入不提交，Esc 取消', () => {
    const onSubmit = vi.fn(); const onCancel = vi.fn();
    const panel = new SettingsInputPanel({ title: '项目规则', value: 'bad rule', description: '规则说明', validate: value => value.includes(' ') ? '无效规则' : undefined,
      onSubmit, onCancel, rows: () => 8, changed: vi.fn() });
    const lines = panel.render(24).map(stripTerminalSequences);
    expect(lines.length).toBeLessThanOrEqual(5); expect(lines[0]).toMatch(/^╭.*╮$/); expect(lines.at(-1)).toMatch(/^╰.*╯$/);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    panel.handleInput('\r'); expect(onSubmit).not.toHaveBeenCalled(); expect(panel.render(24).join('\n')).toContain('无效规则');
    panel.handleInput('\x1b'); expect(onCancel).toHaveBeenCalledOnce();
    panel.handleInput('\x1b[200~\x1b[2J\x1b]52;c;fake\x07\x1b[201~');
    const output = panel.render(80).join('\n');
    expect(output).not.toContain('\x1b[2J'); expect(output).not.toContain('\x1b]52');
  });
});
