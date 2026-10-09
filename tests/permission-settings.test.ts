import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
function setup(options: { missingGlobal?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-permissions-ui-')); dirs.push(cwd); mkdirSync(join(cwd, '.git'));
  const globalConfigPath = options.missingGlobal ? join(cwd, 'home', '.agent', 'config.json') : join(cwd, 'global.json');
  const path = join(cwd, 'agent.config.json');
  if (!options.missingGlobal) writeFileSync(globalConfigPath, JSON.stringify({ permissions: { deny: ['bash(rm *)'] } }));
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
  it('保存入口靠前，草稿同时显示当前与重启有效模式，并明确提供两种保存方式', () => {
    const h = setup(); h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('auto');
    expect(h.picker.items[0].value).toBe('save');
    expect(h.picker.title).toContain('未保存');
    expect(h.picker.context).toContain('当前 ask'); expect(h.picker.context).toContain('重启 auto');
    h.pick('save');
    expect(h.picker.requireSelection).toBe(true);
    expect(h.picker.items.find(item => item.value === 'confirm')?.label).toContain('仅保存启动默认');
    expect(h.picker.items.find(item => item.value === 'apply')?.label).toContain('保存并应用模式');
    expect(h.picker.body?.()).toContain('当前会话模式: ask');
    expect(h.picker.body?.()).toContain('重启后本项目新会话模式: auto');
  });

  it('保存并应用须再次精确确认，只即时改变模式，不热更新规则或审批员', () => {
    const h = setup(); const globalBefore = readFileSync(h.globalConfigPath, 'utf8');
    h.permission.addSessionRule('deny', 'write_file(private/**)');
    h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('auto');
    h.pick('judge'); h.pick('name'); h.input.onSubmit('next-reviewer');
    h.pick('rules'); h.pick('allow'); h.pick('add'); h.input.onSubmit('glob'); h.picker.onCancel(); h.picker.onCancel();
    h.pick('save'); h.pick('apply');
    expect(h.picker.requireSelection).toBe(true); expect(h.picker.initialValue).toBeUndefined();
    expect(h.picker.body?.()).toContain('ask → auto');
    expect(h.picker.body?.()).toContain('规则和审批模型仍需重启');
    expect(h.picker.body?.()).toContain('已弹出的审批不自动放行');
    expect(h.permission.mode).toBe('ask'); expect(JSON.parse(readFileSync(h.path, 'utf8')).permissionMode).toBe('ask');
    h.pick('cancel'); h.pick('apply'); h.pick('confirm');
    expect(h.permission.mode).toBe('auto'); expect(h.onModeChange).toHaveBeenCalledOnce(); expect(h.onModeChange).toHaveBeenCalledWith('auto');
    expect(JSON.parse(readFileSync(h.path, 'utf8'))).toMatchObject({ permissionMode: 'auto', judgeModel: 'next-reviewer', permissions: { allow: ['read_file', 'glob'] } });
    expect(h.config.permissionMode).toBe('ask'); expect(h.config.judgeModel).toBeUndefined();
    expect(h.config.permissions.allow).toEqual(['read_file']);
    expect(h.permission.getSessionRules().deny).toEqual(['write_file(private/**)']);
    expect(readFileSync(h.globalConfigPath, 'utf8')).toBe(globalBefore);
    expect(h.picker.title).not.toContain('未保存'); expect(h.picker.context).toContain('当前 auto');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('规则和审批模型仍需重启'));
  });

  it.each(['legacy', 'namespace'])('全局草稿被项目 %s 模式覆盖时显示原因且只应用合并后的 ask', representation => {
    const h = setup();
    writeFileSync(h.path, JSON.stringify(representation === 'legacy' ? { permissionMode: 'ask' }
      : { pluginConfig: { 'agentlab.policy-legacy': { permissionMode: 'ask' } } }));
    const projectBefore = readFileSync(h.path, 'utf8');
    h.permission.setMode('auto'); h.settings.open(); h.pick('global'); h.pick('mode'); h.pick('yolo');
    expect(h.picker.body?.()).toContain('全局默认 yolo 被本项目 ask 覆盖');
    expect(h.picker.context).toContain('当前 auto'); expect(h.picker.context).toContain('重启 ask');
    h.pick('save'); h.pick('apply');
    expect(h.picker.body?.()).toContain('auto → ask'); h.pick('confirm');
    expect(h.permission.mode).toBe('ask'); expect(h.onModeChange).toHaveBeenCalledWith('ask');
    expect(JSON.parse(readFileSync(h.globalConfigPath, 'utf8')).permissionMode).toBe('yolo');
    expect(readFileSync(h.path, 'utf8')).toBe(projectBefore);
  });

  it.each(['legacy', 'namespace'])('项目恢复继承时即时应用全局 %s auto，并删除同层模式别名', representation => {
    const h = setup();
    writeFileSync(h.globalConfigPath, JSON.stringify(representation === 'legacy' ? { permissionMode: 'auto' }
      : { pluginConfig: { 'agentlab.policy-legacy': { permissionMode: 'auto' } } }));
    writeFileSync(h.path, JSON.stringify({ permissionMode: 'ask', pluginConfig: { 'agentlab.policy-legacy': { permissionMode: 'ask' } } }));
    h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('inherit');
    expect(h.picker.body?.()).toContain('重启后本项目新会话模式: auto');
    h.pick('save'); h.pick('apply'); h.pick('confirm');
    expect(h.permission.mode).toBe('auto');
    const saved = JSON.parse(readFileSync(h.path, 'utf8'));
    expect(saved).not.toHaveProperty('permissionMode');
    expect(saved.pluginConfig['agentlab.policy-legacy']).not.toHaveProperty('permissionMode');
  });

  it('保存冲突失败时不应用模式，保留未保存草稿', () => {
    const h = setup(); h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('auto'); h.pick('save'); h.pick('apply');
    writeFileSync(h.path, '{"custom":"external"}'); h.pick('confirm');
    expect(h.permission.mode).toBe('ask'); expect(h.onModeChange).not.toHaveBeenCalled();
    expect(readFileSync(h.path, 'utf8')).toBe('{"custom":"external"}');
    expect(h.picker.title).toContain('未保存'); expect(h.picker.context).toContain('草稿保留');
  });

  it.each(['session', 'mode'])('保存并应用的确认遇到 %s 变化时失效，不修改新会话或配置', change => {
    const h = setup(); const before = readFileSync(h.path, 'utf8');
    h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('auto'); h.pick('save'); h.pick('apply');
    if (change === 'session') h.session.id = 'session-two'; else h.permission.setMode('yolo');
    h.pick('confirm');
    expect(h.permission.mode).toBe(change === 'session' ? 'ask' : 'yolo'); expect(h.onModeChange).not.toHaveBeenCalled();
    expect(readFileSync(h.path, 'utf8')).toBe(before); expect(h.picker.title).toContain('未保存');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('会话已变化'), true);
  });

  it('确认期间继承层变化须重新确认有效模式，不写入已变更的授权目标', () => {
    const h = setup(); writeFileSync(h.globalConfigPath, '{"permissionMode":"auto"}');
    const before = readFileSync(h.path, 'utf8');
    h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('inherit'); h.pick('save'); h.pick('apply');
    writeFileSync(h.globalConfigPath, '{"permissionMode":"yolo"}'); h.pick('confirm');
    expect(h.permission.mode).toBe('ask'); expect(h.onModeChange).not.toHaveBeenCalled();
    expect(readFileSync(h.path, 'utf8')).toBe(before); expect(h.picker.title).toContain('未保存');
    h.pick('save'); h.pick('apply'); expect(h.picker.body?.()).toContain('ask → yolo'); h.pick('confirm');
    expect(h.permission.mode).toBe('yolo');
  });

  it('仅保存后也能应用已保存有效模式，无需制造新草稿且旧确认不能重复执行', () => {
    const h = setup(); h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('auto'); h.pick('save'); h.pick('confirm');
    expect(h.permission.mode).toBe('ask'); const saved = readFileSync(h.path, 'utf8');
    h.pick('save'); h.pick('apply'); const confirm = h.picker;
    h.pick('confirm'); h.permission.setMode('ask'); confirm.onPick('confirm');
    expect(h.permission.mode).toBe('ask'); expect(h.onModeChange).toHaveBeenCalledTimes(1);
    expect(readFileSync(h.path, 'utf8')).toBe(saved);
  });

  it('取消应用确认后旧回调失效，未保存退出仍询问是否放弃', () => {
    const h = setup(); const before = readFileSync(h.path, 'utf8');
    h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('yolo'); h.pick('save'); h.pick('apply');
    const expired = h.picker; h.picker.onCancel(); expired.onPick('confirm');
    expect(h.picker.title).toContain('确认 Save');
    expect(h.permission.mode).toBe('ask'); expect(h.onModeChange).not.toHaveBeenCalled();
    expect(readFileSync(h.path, 'utf8')).toBe(before);
    h.pick('cancel'); h.picker.onCancel(); expect(h.picker.title).toContain('放弃未保存');
    h.pick('cancel'); expect(h.picker.title).toContain('未保存');
  });

  it('全局保存应用确认期间项目出现覆盖，保留全局草稿并要求重新确认', () => {
    const h = setup(); writeFileSync(h.path, '{}'); const before = readFileSync(h.globalConfigPath, 'utf8');
    h.settings.open(); h.pick('global'); h.pick('mode'); h.pick('auto'); h.pick('save'); h.pick('apply');
    writeFileSync(h.path, '{"pluginConfig":{"agentlab.policy-legacy":{"permissionMode":"ask"}}}'); h.pick('confirm');
    expect(h.permission.mode).toBe('ask'); expect(h.onModeChange).not.toHaveBeenCalled();
    expect(readFileSync(h.globalConfigPath, 'utf8')).toBe(before);
    expect(h.picker.body?.()).toContain('全局默认 auto 被本项目 ask 覆盖');
    expect(h.picker.title).toContain('未保存');
  });

  it('项目与全局均恢复默认时应用内置 ask，未设置的字段不被写入全局', () => {
    const h = setup(); h.permission.setMode('yolo'); const globalBefore = readFileSync(h.globalConfigPath, 'utf8');
    h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('inherit'); h.pick('save'); h.pick('apply');
    expect(h.picker.body?.()).toContain('yolo → ask'); h.pick('confirm');
    expect(h.permission.mode).toBe('ask'); expect(JSON.parse(readFileSync(h.path, 'utf8'))).not.toHaveProperty('permissionMode');
    expect(readFileSync(h.globalConfigPath, 'utf8')).toBe(globalBefore);
  });

  it('未修改的默认配置在应用确认期间被外部更改，不应用陈旧模式', () => {
    const h = setup(); h.permission.setMode('auto');
    h.settings.open(); h.pick('project'); h.pick('save'); h.pick('apply');
    writeFileSync(h.path, '{"permissionMode":"yolo"}'); h.pick('confirm');
    expect(h.permission.mode).toBe('auto'); expect(h.onModeChange).not.toHaveBeenCalled();
    expect(readFileSync(h.path, 'utf8')).toBe('{"permissionMode":"yolo"}');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('配置已变化'), true);
  });

  it('首次全局无更改时仅保存与应用均不建目录，也不声称写入成功', () => {
    const h = setup({ missingGlobal: true }); const globalDirectory = join(h.cwd, 'home');
    h.settings.open(); h.pick('global'); h.pick('save'); h.pick('confirm');
    expect(existsSync(globalDirectory)).toBe(false);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('没有需要保存的全局更改'));
    h.permission.setMode('auto'); h.pick('save'); h.pick('apply'); h.pick('confirm');
    expect(h.permission.mode).toBe('ask'); expect(existsSync(globalDirectory)).toBe(false);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('全局启动默认未改写'));
  });

  it('仅保存确认期间继承层改变，成功后立即显示最新重启有效模式', () => {
    const h = setup(); writeFileSync(h.globalConfigPath, '{"permissionMode":"auto"}');
    h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('inherit'); h.pick('save');
    writeFileSync(h.globalConfigPath, '{"permissionMode":"yolo"}'); h.pick('confirm');
    expect(h.permission.mode).toBe('ask'); expect(h.picker.title).not.toContain('未保存');
    expect(h.picker.body?.()).toContain('重启后本项目新会话模式: yolo');
  });

  it('仅保存成功后继承层损坏，明确已保存但无法核验，不误报保存失败或显示陈旧重启模式', () => {
    const h = setup(); writeFileSync(h.globalConfigPath, '{"permissionMode":"auto"}');
    h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('inherit'); h.pick('save');
    writeFileSync(h.globalConfigPath, 'invalid'); h.pick('confirm');
    expect(JSON.parse(readFileSync(h.path, 'utf8'))).not.toHaveProperty('permissionMode');
    expect(h.permission.mode).toBe('ask'); expect(h.picker.title).not.toContain('未保存');
    expect(h.picker.context).toContain('无法核验'); expect(h.picker.context).not.toContain('保存失败');
    expect(h.picker.body?.()).toContain('重启后本项目新会话模式: 无法核验');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('已保存，但无法核验'), true);
  });

  it('清楚显示本次会话、本项目、全局及真实文件；项目继承查看始终只读', () => {
    const h = setup(); h.settings.open();
    expect(h.picker.items.find(item => item.value === 'mode')?.label).toContain('本次会话');
    expect(h.picker.items.find(item => item.value === 'project')).toMatchObject({ label: expect.stringContaining('本项目'), description: expect.stringContaining(h.path) });
    expect(h.picker.items.find(item => item.value === 'global')?.description).toContain(h.globalConfigPath);
    h.pick('project'); h.pick('global');
    expect(h.detail.title).toContain('只读'); expect(h.detail.body()).toContain(h.globalConfigPath);
  });

  it('全局只编辑原始全局层；保存不提升项目权限、审批模型、writeRoots或运行时默认值', () => {
    const h = setup(); const projectBefore = readFileSync(h.path, 'utf8');
    writeFileSync(h.globalConfigPath, '{"custom":{"keep":true},"permissions":{"deny":["bash(rm *)"]}}');
    h.config.permissionMode = 'yolo'; h.config.judgeModel = 'project-only-reviewer';
    h.config.pluginConfig['agentlab.policy-deterministic-v2'] = { writeRoots: ['project-output'] };
    h.permission.addSessionRule('allow', 'session_only');
    h.settings.open(); h.pick('global');
    expect(h.picker.body?.()).toContain('内置默认 ask');
    expect(h.picker.body?.()).toContain('allow: 0 条');
    expect(h.picker.body?.()).not.toContain('project-only-reviewer');
    h.pick('mode'); h.pick('auto'); h.pick('review');
    expect(h.detail.body()).toContain('作用范围: 全局'); expect(h.detail.body()).toContain(h.globalConfigPath);
    expect(h.detail.body()).not.toContain('read_file'); expect(h.detail.body()).not.toContain('session_only');
    h.detail.onBack(); h.pick('save'); expect(h.picker.requireSelection).toBe(true); h.pick('cancel');
    expect(JSON.parse(readFileSync(h.globalConfigPath, 'utf8'))).not.toHaveProperty('permissionMode');
    h.pick('save'); h.pick('confirm');
    expect(JSON.parse(readFileSync(h.globalConfigPath, 'utf8'))).toEqual({ custom: { keep: true }, permissionMode: 'auto', permissions: { deny: ['bash(rm *)'] } });
    expect(readFileSync(h.path, 'utf8')).toBe(projectBefore);
    expect(h.permission.mode).toBe('ask'); expect(h.config.judgeModel).toBe('project-only-reviewer');
  });

  it('首次全局编辑取消、review和放弃均不建目录；只有明确Save才落盘', () => {
    const h = setup({ missingGlobal: true }); const globalDirectory = join(h.cwd, 'home');
    h.settings.open(); h.pick('global'); h.picker.onCancel();
    expect(existsSync(globalDirectory)).toBe(false);
    h.pick('global'); h.pick('mode'); h.pick('auto'); h.pick('review'); h.detail.onBack();
    h.pick('save'); h.pick('cancel'); expect(existsSync(globalDirectory)).toBe(false);
    h.pick('back'); expect(h.picker.title).toContain('放弃'); h.pick('confirm');
    expect(existsSync(globalDirectory)).toBe(false);
    h.pick('global'); expect(h.picker.body?.()).toContain('内置默认 ask');
    h.pick('mode'); h.pick('auto'); h.pick('save'); h.pick('confirm');
    expect(JSON.parse(readFileSync(h.globalConfigPath, 'utf8'))).toEqual({ permissionMode: 'auto' });
  });

  it('全局规则和optional字段可编辑删除，namespace别名不造成新旧冲突', () => {
    const h = setup(); writeFileSync(h.globalConfigPath, JSON.stringify({ pluginConfig: {
      'agentlab.policy-legacy': { permissionMode: 'auto', permissions: { allow: ['glob'] } },
      'agentlab.reviewer-model': { judgeModel: 'global-reviewer' },
    } }));
    h.settings.open(); h.pick('global'); expect(h.picker.body?.()).toContain('global-reviewer');
    h.pick('mode'); h.pick('inherit'); h.pick('judge'); h.pick('inherit');
    h.pick('rules'); h.pick('allow'); h.pick('0'); h.pick('delete'); h.pick('confirm');
    h.pick('add'); h.input.onSubmit('read_file'); h.picker.onCancel(); h.picker.onCancel();
    h.pick('save'); h.pick('confirm');
    const raw = JSON.parse(readFileSync(h.globalConfigPath, 'utf8'));
    expect(raw).not.toHaveProperty('permissionMode'); expect(raw).not.toHaveProperty('judgeModel'); expect(raw).not.toHaveProperty('permissions');
    expect(raw.pluginConfig['agentlab.policy-legacy']).toEqual({ permissions: { allow: ['read_file'], ask: [], deny: [] } });
    expect(raw.pluginConfig['agentlab.reviewer-model']).toEqual({});
  });

  it('全局并发冲突保留草稿，项目编辑与会话模式不变', () => {
    const h = setup(); h.settings.open(); h.pick('global'); h.pick('mode'); h.pick('yolo');
    writeFileSync(h.globalConfigPath, '{"custom":"external-global"}');
    h.pick('save'); h.pick('confirm');
    expect(readFileSync(h.globalConfigPath, 'utf8')).toBe('{"custom":"external-global"}');
    expect(h.picker.title).toContain('未保存'); expect(h.picker.body?.()).toContain('yolo');
    expect(h.picker.context).toContain('草稿保留'); expect(h.permission.mode).toBe('ask');
    expect(JSON.parse(readFileSync(h.path, 'utf8')).permissionMode).toBe('ask');
  });

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
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('启动默认，请在 /permissions 的本项目或全局默认设置中 Save'));
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
    expect(h.detail.body()).toContain(`全局配置 ${h.globalConfigPath}`); expect(h.detail.body()).toContain(`项目配置 ${h.path}`);
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
