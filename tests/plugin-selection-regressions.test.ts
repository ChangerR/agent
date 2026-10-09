import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/core/events.js';
import { AgentConfigSchema } from '../src/core/config.js';
import { PermissionEngine } from '../src/builtin/policy-legacy/engine.js';
import { fileSessionStore } from '../src/builtin/session-file/index.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import { PluginHost } from '../src/runtime/plugin-host.js';
import { createRuntime } from '../src/runtime/create-agent.js';
import { definePlugin, type CapabilitySelections, type Policy } from '../src/sdk/index.js';

function preset(version: string, selection?: string, explicit?: { id: string; version: string }) {
  return () => ({ selections: selection ? { policy: selection } : {}, plugins: [definePlugin({
    manifest: { id: 'test.custom-runtime', version: '9.0.0', apiVersion: 1 },
    setup(ctx) {
      const controller = new PermissionEngine({ mode: 'ask', rules: { allow: [], ask: [], deny: [] } });
      const policy: Policy = { ...explicit, controller, decide: () => ({ kind: 'deny', source: 'config', reason: 'test' }) };
      ctx.provide.tool('identity-probe', { name: 'identity-probe', description: 'identity audit', risk: 'write', inputSchema: { type: 'object' }, async execute() { return { content: 'ok' }; } });
      ctx.provide.provider('fake', new FakeProvider([textResponse('ok')]));
      ctx.provide.policy('custom-policy', policy, { version, aliases: ['policy-alias'] });
      if (selection === 'second-alias') ctx.provide.policy('second-policy', policy, { version: '4.0.0', aliases: ['second-alias'] });
      ctx.provide.compactor('noop', { async compact(messages) { return messages; } });
      ctx.provide.modelCatalog('catalog', { get: () => ({ contextWindow: 100000, maxOutputTokens: 1000 }), list: () => ({}) });
      ctx.provide.sessionStore('file', fileSessionStore);
    },
  })] });
}

describe('policy capability identity', () => {
  it.each([undefined, 'policy-alias'])('saves canonical identity for implicit/alias selection %s and rejects upgraded grants', async selection => {
    const cwd = await mkdtemp(join(tmpdir(), 'policy-identity-'));
    const first = await createRuntime(cwd, preset('2.3.0', selection), { autoSaveSessions: false, config: { provider: 'fake', model: 'fake' } });
    try {
      const audits: Array<Extract<AgentEvent, { type: 'tool_execution' }>> = [];
      first.events.on('tool_execution', event => { audits.push(event); });
      await first.invokeTool('identity-probe', {});
      expect(audits.length).toBeGreaterThan(0);
      expect(audits.every(event => event.policyId === 'custom-policy' && event.policyVersion === '2.3.0')).toBe(true);
      await first.loop.run('hello');
      first.permission.addSessionRule('allow', 'read_file');
      await first.session.save();
      const saved = await fileSessionStore.load(cwd, first.session.id);
      expect(saved.policy).toEqual({ id: 'custom-policy', version: '2.3.0', stateSchemaVersion: 1 });
      const second = await createRuntime(cwd, preset('3.0.0', selection), { autoSaveSessions: false, config: { provider: 'fake', model: 'fake' } });
      try {
        await expect(second.session.resume(first.session.id)).rejects.toMatchObject({ code: 'unsupported_version' });
        expect(second.permission.getSessionRules().allow).toEqual([]);
      } finally { await second.dispose(); }
    } finally { await first.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
  it('resolves the selected record even when implementations share identity', async () => {
    const implementation: Policy = { decide: () => ({ kind: 'deny', source: 'config', reason: 'test' }) };
    const host = new PluginHost({ selections: { policy: 'second-alias' } });
    await host.load([definePlugin({ manifest: { id: 'test.shared-policy', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      ctx.provide.policy('first', implementation, { version: '1.0.0' });
      ctx.provide.policy('second', implementation, { version: '2.0.0', aliases: ['second-alias'] });
    } })]);
    try { expect(host.selectedRecord('policy')).toMatchObject({ capabilityId: 'second', version: '2.0.0' }); }
    finally { await host.dispose(); }
  });
  it('reports canonical settings selection and persisted identity for shared implementations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'policy-choices-'));
    let choices!: () => Record<string, { selected: string | false }>;
    const agent = await createRuntime(cwd, input => {
      choices = input.capabilityChoices;
      return preset('2.3.0', 'second-alias')();
    }, { autoSaveSessions: false, config: { provider: 'fake', model: 'fake' } });
    try {
      expect(choices().policy.selected).toBe('second-policy');
      const audits: Array<Extract<AgentEvent, { type: 'tool_execution' }>> = [];
      agent.events.on('tool_execution', event => { audits.push(event); });
      await agent.invokeTool('identity-probe', {});
      expect(audits.length).toBeGreaterThan(0);
      expect(audits.every(event => event.policyId === 'second-policy' && event.policyVersion === '4.0.0')).toBe(true);
      await agent.loop.run('hello'); await agent.session.save();
      expect((await fileSessionStore.load(cwd, agent.session.id)).policy).toMatchObject({ id: 'second-policy', version: '4.0.0' });
    } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
  it('keeps explicitly declared policy identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'policy-explicit-'));
    const agent = await createRuntime(cwd, preset('2.3.0', undefined, { id: 'stable-policy', version: '4.0.0' }), { autoSaveSessions: false, config: { provider: 'fake', model: 'fake' } });
    try {
      const audits: Array<Extract<AgentEvent, { type: 'tool_execution' }>> = [];
      agent.events.on('tool_execution', event => { audits.push(event); });
      await agent.invokeTool('identity-probe', {});
      expect(audits.length).toBeGreaterThan(0);
      expect(audits.every(event => event.policyId === 'stable-policy' && event.policyVersion === '4.0.0')).toBe(true);
      await agent.loop.run('hello'); await agent.session.save();
      expect((await fileSessionStore.load(cwd, agent.session.id)).policy).toMatchObject({ id: 'stable-policy', version: '4.0.0' });
    } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
});

describe('capability selection validation', () => {
  it.each(['polciy', 'tool', 'constructor'])('rejects unknown/non-singleton key %s in schema and host', async key => {
    const selections = { [key]: 'deterministic-v2' };
    expect(() => AgentConfigSchema.parse({ capabilities: selections })).toThrow(key);
    await expect(new PluginHost({ selections: selections as CapabilitySelections }).load([])).rejects.toThrow(key);
  });
  it('accepts all six singleton selections and false values', async () => {
    const capabilities = { policy: false, reviewer: false, compactor: false, cacheStrategy: false, modelCatalog: false, sessionStore: false } as const;
    expect(AgentConfigSchema.parse({ capabilities }).capabilities).toEqual(capabilities);
    const host = new PluginHost({ selections: capabilities }); await host.load([]); await host.dispose();
  });
  it('rejects typo+yolo passed directly via runtime options', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'policy-typo-'));
    try {
      await expect(createRuntime(cwd, preset('2.3.0'), { config: { provider: 'fake', permissionMode: 'yolo', capabilities: { polciy: 'deterministic-v2' } as CapabilitySelections } })).rejects.toThrow('polciy');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
