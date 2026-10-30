/** SSH stdio 入口。stdout 仅承载协议，所有业务对象保留在此进程。 */
import { randomUUID, createHash } from 'node:crypto';
import { realpath, stat, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { RemoteChannel } from './channel.js';
import { descriptionSchema } from './protocol.js';
import { snapshotDelta } from './snapshots.js';
import { acquireProjectLock } from './lock.js';
import { DesktopController } from '../worker/controller.js';
import { actionSchema, type RuntimeSnapshot } from '../shared/protocol.js';
import { createAgent } from '../../src/index.js';
import { composePreset } from '../../src/builtin/default-preset.js';
import {
  providerBridgePlugin,
  bridgeModelCatalogPlugin,
} from '../../src/builtin/provider-bridge.js';
import { loadConfigWithSources } from '../../src/core/config.js';
import type { ProviderDescription } from '../../src/providers/semantics.js';

const epoch = process.argv[2];
if (!epoch || !z.string().uuid().safeParse(epoch).success) throw new Error('INVALID_EPOCH');
const channel = new RemoteChannel(process.stdin, process.stdout, epoch);
declare const __AGENTLAB_REMOTE_BUILD__: string;
const buildId =
  typeof __AGENTLAB_REMOTE_BUILD__ === 'string' ? __AGENTLAB_REMOTE_BUILD__ : 'development';
let controller: DesktopController | undefined, release: (() => Promise<void>) | undefined;
let startup: Promise<void> = Promise.resolve();
let descriptions: ProviderDescription[] = [];
let workspace: ReturnType<typeof loadConfigWithSources> | undefined;
let active = false,
  initializing = false,
  closing = false,
  lease = Date.now();
let previous: RuntimeSnapshot | undefined,
  outbound: Promise<void> = Promise.resolve();
let operationDir: string | undefined;
const operations = new Map<string, { hash: string; status: string; sessionId: string }>();
let runningOperation: string | undefined;
let outboundFailed = false;
let pendingState: RuntimeSnapshot | undefined,
  sendingState = false;
function scheduleState(state: RuntimeSnapshot) {
  pendingState = state;
  if (sendingState) return;
  sendingState = true;
  outbound = outbound
    .then(async () => {
      while (pendingState) {
        const next = pendingState;
        pendingState = undefined;
        await publish(next);
      }
    })
    .catch(() => {
      outboundFailed = true;
      channel.close('SAVE_FAILED');
    })
    .finally(() => {
      sendingState = false;
      if (pendingState) scheduleState(pendingState);
    });
}
const saveOperation = async (id: string) => {
  if (!operationDir) throw new Error('RUNTIME_UNAVAILABLE');
  const path = join(operationDir, id + '.json'),
    temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(operations.get(id)), { mode: 0o600 });
  await rename(temporary, path);
};
async function publish(state: RuntimeSnapshot) {
  // 远程模型连接由本地主机维护；设置仍保留远程工具/权限/会话范围。
  state.settings = state.settings.filter((s) => !/provider|environment/.test(s.id));
  state.models = descriptions.find((d) => d.name === state.provider)
    ? Object.keys(descriptions.find((d) => d.name === state.provider)!.models)
    : state.models;
  state.modelDetails = state.modelDetails.filter((m) => state.models.includes(m.id));
  if (!state.busy && runningOperation) {
    const id = runningOperation;
    runningOperation = undefined;
    const record = operations.get(id)!;
    record.status = state.error ? 'failed' : state.phase === '已停止' ? 'aborted' : 'completed';
    await saveOperation(id);
  }
  if (!previous || previous.sessionId !== state.sessionId)
    await channel.notify('runtime.snapshot', state);
  else await channel.notify('runtime.delta', snapshotDelta(previous, state));
  previous = state;
}
async function shutdown() {
  if (closing) return;
  closing = true;
  active = false;
  try {
    await startup.catch(() => {});
    await controller?.dispose();
    await outbound;
    await release?.();
    release = undefined;
  } catch {
    closing = false;
    throw new Error('SAVE_FAILED');
  }
}
channel.on('closed', () => {
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
const heartbeat = setInterval(() => {
  if (Date.now() - lease > 20000) channel.close('LEASE_EXPIRED');
}, 1000);
heartbeat.unref();
channel.handle(async (method, payload) => {
  if (method === 'hello')
    return {
      version: 1,
      buildId,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    };
  if (method === 'heartbeat') {
    lease = Date.now();
    return null;
  }
  if (method === 'workspace.resolve') {
    if (controller || initializing) throw new Error('ALREADY_INITIALIZED');
    const p = z
      .object({
        path: z.string().min(1).max(4096),
        defaults: z.object({ provider: z.string(), model: z.string() }).strict(),
      })
      .strict()
      .parse(payload);
    if (!p.path.startsWith('/') || /[\x00-\x1f]/.test(p.path)) throw new Error('INVALID_PATH');
    const root = await realpath(p.path);
    if (!(await stat(root)).isDirectory()) throw new Error('INVALID_PATH');
    const loaded = loadConfigWithSources(root);
    const overrides = {
      ...(loaded.sources.provider.scope === 'default' ? { provider: p.defaults.provider } : {}),
      ...(loaded.sources.model.scope === 'default' ? { model: p.defaults.model } : {}),
    };
    workspace = loadConfigWithSources(root, overrides);
    const required = new Map<string, Set<string>>();
    const add = (name: string, model: string) => {
      const values = required.get(name) ?? new Set<string>();
      values.add(model);
      required.set(name, values);
    };
    const c = workspace.config;
    add(c.provider, c.model);
    for (const id of [
      'agentlab.planning',
      'agentlab.compaction-summary',
      'agentlab.reviewer-model',
    ]) {
      const cfg = c.pluginConfig[id] ?? {};
      add(
        String(cfg.provider ?? c.provider),
        String(cfg.model ?? (id.endsWith('reviewer-model') ? (c.judgeModel ?? c.model) : c.model)),
      );
    }
    return {
      root: workspace.paths.projectRoot,
      projectId: workspace.paths.projectId,
      requirements: [...required].map(([name, models]) => ({ name, models: [...models] })),
    };
  }
  if (method === 'runtime.init') {
    if (!workspace || controller || initializing) throw new Error('RUNTIME_UNAVAILABLE');
    const p = z
      .object({
        generation: z.string().uuid(),
        descriptions: z.array(descriptionSchema).min(1).max(50),
      })
      .strict()
      .parse(payload);
    descriptions = p.descriptions;
    initializing = true;
    try {
      const dir = join(workspace.paths.projectStateDir, 'remote');
      release = await acquireProjectLock(dir);
      operationDir = join(dir, 'operations');
      await mkdir(operationDir, { recursive: true, mode: 0o700 });
      controller = new DesktopController(scheduleState, (cwd, options) =>
        createAgent(cwd, {
          ...options,
          config: {
            ...options?.config,
            provider: workspace!.config.provider,
            model: workspace!.config.model,
          },
          preset: (input) =>
            composePreset(input, [providerBridgePlugin(channel, descriptions)], {
              modelCatalog: bridgeModelCatalogPlugin(descriptions),
            }),
        }),
      );
      startup = controller.initialize(workspace.paths.projectRoot, false, p.generation);
      await startup;
      await outbound;
      if (outboundFailed) throw new Error('SAVE_FAILED');
      return { ready: true };
    } catch (e) {
      await release?.();
      release = undefined;
      controller = undefined;
      throw e;
    } finally {
      initializing = false;
    }
  }
  if (method === 'runtime.activate') {
    if (!controller || closing) throw new Error('RUNTIME_UNAVAILABLE');
    active = true;
    return null;
  }
  if (method === 'runtime.snapshot') {
    if (!controller) throw new Error('RUNTIME_UNAVAILABLE');
    return controller.snapshot;
  }
  if (method === 'runtime.dispose') {
    await shutdown();
    setTimeout(() => process.exit(0), 100).unref();
    return null;
  }
  if (method === 'operation.get') {
    const p = z
      .object({ id: z.string().uuid(), sessionId: z.string().min(1).max(64) })
      .strict()
      .parse(payload);
    if (!operationDir || controller?.snapshot?.sessionId !== p.sessionId)
      throw new Error('SESSION_CHANGED');
    try {
      const record = JSON.parse(await readFile(join(operationDir, p.id + '.json'), 'utf8'));
      if (record.sessionId !== p.sessionId) throw new Error('SESSION_CHANGED');
      return record;
    } catch {
      throw new Error('OUTCOME_UNKNOWN');
    }
  }
  if (method === 'runtime.action') {
    if (!active || !controller || closing) throw new Error('RUNTIME_UNAVAILABLE');
    const p = z
      .object({ operationId: z.string().uuid(), action: actionSchema })
      .strict()
      .parse(payload);
    const action = p.action,
      state = controller.snapshot!;
    if (state.generation !== action.generation || state.sessionId !== action.sessionId)
      throw new Error('SESSION_CHANGED');
    if (
      action.type === 'setting' &&
      action.field === 'model' &&
      !descriptions.find((d) => d.name === state.provider)?.models[action.value]
    )
      throw new Error('MODEL_NOT_AUTHORIZED');
    if (action.type === 'submit' && /^\/model\s/.test(action.text)) {
      const model = action.text.slice(6).trim();
      if (model && !descriptions.find((d) => d.name === state.provider)?.models[model])
        throw new Error('MODEL_NOT_AUTHORIZED');
    }
    if (action.type === 'interact' && action.value) {
      const interaction = state.interaction;
      if (
        interaction?.prompt.includes('模型') &&
        !descriptions.find((d) => d.name === state.provider)?.models[action.value]
      )
        throw new Error('MODEL_NOT_AUTHORIZED');
    }
    const hash = createHash('sha256').update(JSON.stringify(action)).digest('hex');
    const before = operations.get(p.operationId);
    if (before) {
      if (before.hash !== hash) throw new Error('OPERATION_CONFLICT');
      return before;
    }
    if (operations.size >= 10000) throw new Error('OPERATION_LIMIT');
    if (action.type === 'submit') {
      if (state.busy) throw new Error('RUNTIME_BUSY');
      try {
        await readFile(join(operationDir!, p.operationId + '.json'));
        throw new Error('OUTCOME_UNKNOWN');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    operations.set(p.operationId, { hash, status: 'accepted', sessionId: state.sessionId });
    if (action.type === 'submit') {
      await saveOperation(p.operationId);
      runningOperation = p.operationId;
    }
    await controller.handle(action);
    await outbound;
    return operations.get(p.operationId);
  }
  throw new Error('METHOD_UNAVAILABLE');
});
