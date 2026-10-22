import type { DesktopBridge } from '../shared/protocol.js';
declare global {
  interface Window {
    agentlab?: DesktopBridge;
  }
}
/** 浏览器预览仅连接隔离的本地 FakeProvider 服务，不能打开真实项目。 */
export function getBridge(): DesktopBridge {
  if (window.agentlab) return window.agentlab;
  if (!['127.0.0.1', 'localhost'].includes(location.hostname))
    throw new Error('请通过 agentlab 打开应用。');
  const call = async (path: string, payload?: unknown) => {
    const response = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '离线预览连接失败');
    return data;
  };
  return {
    snapshot: () => call('snapshot'),
    onState(listener) {
      const events = new EventSource('/api/events');
      events.onmessage = (e) => listener(JSON.parse(e.data));
      return () => events.close();
    },
    onNavigate: () => () => {},
    settingsDirty: () => Promise.resolve(),
    pickProject: () => call('unavailable'),
    pickDirectory: async () => (await call('pick-directory')).path,
    openProject: (id) => call('open-project', { id }),
    startDemo: () => call('demo'),
    newSession: () => call('new-session'),
    request: (action) => call('request', action),
  };
}
