import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { AgentConfigSchema } from '../src/core/config.js';
import { PermissionEngine } from '../src/core/permission/engine.js';
import { createPermissionSettings, describeJudgeStatus, describePermissionRule, type PermissionSettingsPicker } from '../src/cli/permission-settings.js';
import { SettingsInputPanel, type SettingsInputRequest } from '../src/cli/settings-input.js';
import type { Agent } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-permissions-ui-')); dirs.push(cwd);
  const globalConfigPath = join(cwd, 'global.json');
  const path = join(cwd, 'agent.config.json');
  writeFileSync(globalConfigPath, JSON.stringify({ permissions: { deny: ['bash(rm *)'] } }));
  writeFileSync(path, JSON.stringify({ permissionMode: 'ask', permissions: { allow: ['read_file'] }, unknownSecret: 'not-in-ui' }));
  const config = AgentConfigSchema.parse({ permissionMode: 'ask', permissions: { allow: ['read_file'], deny: ['bash(rm *)'] } });
  const permission = new PermissionEngine({ mode: 'ask', rules: config.permissions });
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

describe('TUI 权限中心', () => {
  it('按实际运行状态显示审批模型与来源，不以 judgeModel 配置推断是否加载', () => {
    const h = setup();
    expect(h.config.judgeModel).toBeUndefined();
    h.getJudgeStatus.mockReturnValue({ loaded: true, model: 'current-runtime-model', source: 'current' });
    h.settings.open();
    expect(h.picker.items.find(item => item.value === 'judge')?.label).toContain('已加载 current-runtime-model（跟随当前模型）');
    h.pick('mode');
    expect(h.picker.items.find(item => item.value === 'auto')?.description).toContain('current-runtime-model');
    h.getJudgeStatus.mockReturnValue({ loaded: true, model: 'explicit-runtime-model', source: 'explicit' });
    h.settings.open(); h.pick('judge');
    expect(h.detail.body()).toContain('已加载 explicit-runtime-model（显式指定）');
    h.config.judgeModel = 'configured-but-not-loaded';
    h.getJudgeStatus.mockReturnValue({ loaded: false });
    expect(h.detail.body()).toContain('未加载');
    expect(h.detail.body()).not.toContain('configured-but-not-loaded');
    h.settings.openModes();
    expect(h.picker.items.find(item => item.value === 'auto')?.description).toContain('当前未加载审批模型');
  });

  it('项目可保存空字符串跟随当前模型并覆盖全局，也可恢复继承；保存不冒充当前运行状态', () => {
    const h = setup();
    writeFileSync(h.globalConfigPath, JSON.stringify({ judgeModel: 'global-reviewer' }));
    h.getJudgeStatus.mockReturnValue({ loaded: true, model: 'global-reviewer', source: 'explicit' });
    h.settings.open(); h.pick('project'); h.pick('judge');
    expect(h.picker.items.some(item => item.value === 'off' || item.label.includes('关闭'))).toBe(false);
    expect(h.picker.items.find(item => item.value === 'inherit')?.label).toContain('global-reviewer');
    h.pick('current');
    expect(h.picker.body?.()).toContain('跟随当前模型（覆盖全局）');
    h.pick('save'); h.pick('confirm');
    expect(JSON.parse(readFileSync(h.path, 'utf8')).judgeModel).toBe('');
    h.pick('back');
    expect(h.picker.items.find(item => item.value === 'judge')?.label).toContain('已加载 global-reviewer（显式指定）');
    h.pick('project'); h.pick('judge'); h.pick('inherit'); h.pick('save'); h.pick('confirm');
    expect(JSON.parse(readFileSync(h.path, 'utf8'))).not.toHaveProperty('judgeModel');
  });

  it('审批状态中的模型名称转义终端控制字符', () => {
    const label = describeJudgeStatus({ loaded: true, model: 'model\x1b[2J\nnext', source: 'current' });
    expect(label).toContain('model\\u001b[2J\\u000anext');
    expect(label).not.toContain('\x1b');
    expect(label).not.toContain('\n');
  });

  it('模式只能明确确认后改变，取消不变，准确解释作用范围与已有规则', () => {
    const h = setup(); h.settings.open(); h.pick('mode'); h.pick('yolo');
    expect(h.permission.mode).toBe('ask'); expect(h.picker.requireSelection).toBe(true); expect(h.picker.initialValue).toBeUndefined();
    expect(h.picker.body?.()).toContain('已弹出的审批不自动放行'); expect(h.picker.body?.()).toContain('allow 与 ask 规则继续生效');
    h.pick('cancel'); expect(h.permission.mode).toBe('ask'); h.pick('auto'); h.pick('confirm');
    expect(h.permission.mode).toBe('auto'); expect(h.onModeChange).toHaveBeenCalledWith('auto'); expect(h.config.permissionMode).toBe('ask');
    expect(JSON.parse(readFileSync(h.path, 'utf8')).permissionMode).toBe('ask');
  });

  it('会话移除不扩大到其他规则，取消和陈旧确认均不修改', () => {
    const h = setup(); h.permission.addSessionRule('allow', 'bash(="npm test")'); h.permission.addSessionRule('deny', 'write_file(secrets*)');
    h.settings.open(); h.pick('session'); h.pick('0'); expect(h.picker.body?.()).toContain('其他参数可能不同'); h.pick('cancel');
    expect(h.permission.getSessionRules().allow).toHaveLength(1);
    h.pick('0'); h.permission.addSessionRule('allow', 'glob'); h.pick('confirm');
    expect(h.permission.getSessionRules().allow).toHaveLength(2); expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('规则已变化'), true);
    h.pick('0'); h.pick('confirm');
    expect(h.permission.getSessionRules()).toEqual({ allow: ['glob'], ask: [], deny: ['write_file(secrets*)'] });
    expect(h.config.permissions.allow).toEqual(['read_file']);
  });

  it('配置规则只读，有可核验全局/项目标签，精确目标与工具全范围含义不同', () => {
    const h = setup(); h.settings.open(); h.pick('effective');
    expect(h.detail.body()).toContain('全局 ~/.agent/config.json'); expect(h.detail.body()).toContain('项目 agent.config.json');
    expect(h.detail.body()).not.toContain('not-in-ui'); expect(h.detail.body()).toContain('启动时加载的快照');
    expect(describePermissionRule('read_file')).toContain('全部调用');
    expect(describePermissionRule('bash(="npm test")')).toContain('精确目标');
    expect(describePermissionRule('edit_file(src/**)')).toContain('glob 目标');
  });

  it('项目 mode / allow / ask / deny / judgeModel 共用草稿，取消 Save 不写入，保存不改当前引擎', () => {
    const h = setup(); const original = readFileSync(h.path, 'utf8'); h.settings.open(); h.pick('project');
    h.pick('mode'); h.pick('yolo');
    for (const kind of ['allow', 'ask', 'deny']) {
      h.pick('rules'); h.pick(kind); h.pick('add');
      expect(h.input.validate?.('invalid rule')).toBeTruthy(); h.input.onSubmit(`${kind === 'allow' ? 'glob' : kind === 'ask' ? 'bash' : 'write_file'}(src/**)`);
      h.picker.onCancel(); h.picker.onCancel();
    }
    h.pick('judge'); h.pick('name'); h.input.onSubmit('review-model');
    h.pick('save'); expect(h.picker.requireSelection).toBe(true); expect(h.picker.body?.()).toContain('恢复旧会话');
    h.pick('cancel'); expect(readFileSync(h.path, 'utf8')).toBe(original);
    h.pick('save'); h.pick('confirm');
    const saved = JSON.parse(readFileSync(h.path, 'utf8'));
    expect(saved).toMatchObject({ permissionMode: 'yolo', judgeModel: 'review-model', unknownSecret: 'not-in-ui', permissions: { allow: ['read_file', 'glob(src/**)'], ask: ['bash(src/**)'], deny: ['write_file(src/**)'] } });
    expect(h.permission.mode).toBe('ask'); expect(h.config.permissions).toEqual({ allow: ['read_file'], ask: [], deny: ['bash(rm *)'] }); expect(h.config.judgeModel).toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('项目权限设置已保存'));
  });

  it('编辑/删除规则只更新草稿，冲突失败保留草稿，退出询问放弃', () => {
    const h = setup(); h.settings.open(); h.pick('project'); h.pick('rules'); h.pick('allow'); h.pick('0'); h.pick('edit'); h.input.onSubmit('glob');
    h.pick('0'); h.pick('delete'); h.pick('confirm'); h.picker.onCancel(); h.picker.onCancel();
    h.pick('review'); expect(h.detail.body()).toContain('allow:\n  (无)'); h.detail.onBack();
    writeFileSync(h.path, '{"custom":"external"}'); h.pick('save'); h.pick('confirm');
    expect(readFileSync(h.path, 'utf8')).toBe('{"custom":"external"}'); expect(h.picker.title).toContain('未保存'); expect(h.picker.context).toContain('草稿保留');
    h.picker.onCancel(); expect(h.picker.title).toContain('放弃'); h.pick('cancel'); expect(h.picker.title).toContain('未保存');
  });

  it('每次独立打开清除旧返回目标；确认前切换会话不改新会话模式', () => {
    const h = setup(); const back = vi.fn(); h.settings.open(back); h.picker.onCancel(); expect(back).toHaveBeenCalledTimes(1);
    h.settings.open(); h.picker.onCancel(); expect(back).toHaveBeenCalledTimes(1);
    h.settings.openModes(back); h.picker.onCancel(); expect(back).toHaveBeenCalledTimes(2);
    h.settings.openModes(); h.picker.onCancel(); expect(back).toHaveBeenCalledTimes(2);
    h.settings.requestMode('yolo'); h.session.id = 'session-two'; h.pick('confirm'); expect(h.permission.mode).toBe('ask');
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
