import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WorkerHost } from '../main/worker-host.ts';
import { ProjectCatalog } from '../main/project-catalog.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'desktop/dist');
const temporary = await mkdtemp(join(tmpdir(), 'agentlab-desktop-preview-'));
const project = join(temporary, 'project'),
  secondProject = join(temporary, 'sample-project'),
  home = join(temporary, 'home');
await mkdir(project);
await mkdir(home);
await mkdir(secondProject);
await writeFile(
  join(secondProject, 'README.md'),
  '# Sample project\n\n第二个隔离项目，用于验证项目切换。\n',
);
await writeFile(
  join(project, 'README.md'),
  '# agentlab\n\n这是隔离的真实离线工作台，不连接模型。\n',
);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ANTHROPIC_API_KEY: 'test-only-never-sent',
  OPENAI_API_KEY: 'test-only-never-sent',
  AGENTLAB_DEMO_KEY: 'test-only-never-sent',
};
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.OPENAI_BASE_URL;
const catalog = new ProjectCatalog();
catalog.open(secondProject, true);
catalog.open(project, true);
let state = { version: 1, revision: 0, connecting: false, projects: catalog.projects };
let worker,
  changing = false,
  generation;
const clients = new Set();
function publish() {
  catalog.observe(state.runtime);
  state.projects = catalog.projects;
  state.revision++;
  const data = 'data: ' + JSON.stringify(state) + '\n\n';
  for (const client of clients) client.write(data);
}
async function start(cwd = project, fresh = false) {
  if (changing || state.runtime?.busy) throw new Error('请先停止当前任务并等待结算。');
  if (!fresh && state.runtime?.cwd === cwd && worker) return;
  const lastSessionId = fresh ? undefined : catalog.get(cwd)?.lastSessionId;
  changing = true;
  state.connecting = true;
  state.error = undefined;
  publish();
  try {
    await worker?.dispose();
    catalog.observe(state.runtime);
    state.runtime = undefined;
    generation = randomUUID();
    const current = generation;
    worker = new WorkerHost(
      join(output, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
      join(output, 'worker/index.mjs'),
      cwd,
      env,
      (snapshot) => {
        if (snapshot.generation !== generation) return;
        state.runtime = snapshot;
        state.connecting = false;
        publish();
      },
      () => {
        if (current === generation) {
          state.error = '离线进程中断';
          state.connecting = false;
          publish();
        }
      },
    );
    await worker.request({ type: 'init', cwd, demo: true, generation });
    catalog.open(cwd, true);
    if (lastSessionId)
      await worker.request({
        type: 'resume',
        generation,
        sessionId: state.runtime.sessionId,
        id: lastSessionId,
      });
  } finally {
    changing = false;
    state.connecting = false;
    publish();
  }
}
const port = Number(process.env.AGENTLAB_PREVIEW_PORT ?? 4175);
const origin = 'http://127.0.0.1:' + port;
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== '127.0.0.1:' + port) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.origin && req.headers.origin !== origin) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (
        req.headers['sec-fetch-site'] &&
        req.headers['sec-fetch-site'] !== 'same-origin' &&
        req.headers['sec-fetch-site'] !== 'none'
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (clients.size >= 20) {
          res.writeHead(429);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        clients.add(res);
        res.write('data: ' + JSON.stringify(state) + '\n\n');
        req.on('close', () => clients.delete(res));
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
        res.writeHead(405);
        res.end('{}');
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 128 * 1024) {
          res.writeHead(413);
          res.end('{}');
          return;
        }
      }
      const data = JSON.parse(body || '{}');
      if (url.pathname === '/api/snapshot') {
        res.end(JSON.stringify(state));
        return;
      }
      if (url.pathname === '/api/pick-directory') {
        res.end(JSON.stringify({ path: project }));
        return;
      }
      if (url.pathname === '/api/demo') await start();
      else if (url.pathname === '/api/new-session') {
        if (!state.runtime) throw new Error('请先打开项目');
        await start(state.runtime.cwd, true);
      } else if (url.pathname === '/api/open-project') {
        const entry = typeof data.id === 'string' ? catalog.get(data.id) : undefined;
        if (!entry) throw new Error('仅允许打开列表中的隔离演示项目');
        await start(entry.path);
      } else if (url.pathname === '/api/request') {
        if (changing || !worker) throw new Error('演示进程尚未就绪');
        await worker.request(data);
      } else throw new Error('浏览器预览仅允许隔离演示；打开真实项目请使用 Windows 应用。');
      res.end('{}');
      return;
    }
    const renderer = join(output, 'renderer');
    const relative =
      url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = resolve(renderer, relative);
    if (
      !file.startsWith(renderer + sep) ||
      !(relative === 'index.html' || relative.startsWith('assets/'))
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      'Content-Type',
      file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : file.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'application/octet-stream',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.end(await readFile(file));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : '操作失败' }));
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log('真实离线工作台：' + origin + '\n隔离项目：' + project),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void worker?.dispose().finally(() => process.exit());
  });
