import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopState } from '../shared/protocol.js';
/** 白名单桥只返回纯 DTO，不暴露原始 IPC、文件系统或 shell。 */
const bridge: DesktopBridge = {
  snapshot: () => ipcRenderer.invoke('agentlab:snapshot'),
  onState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state);
    ipcRenderer.on('agentlab:state', handler);
    return () => ipcRenderer.removeListener('agentlab:state', handler);
  },
  onNavigate(listener) {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => {
      if (['settings', 'new-session', 'open-project'].includes(action))
        listener(action as import('../shared/protocol.js').DesktopNavigation);
    };
    ipcRenderer.on('agentlab:navigate', handler);
    return () => ipcRenderer.removeListener('agentlab:navigate', handler);
  },
  settingsDirty: (dirty) => ipcRenderer.invoke('agentlab:settings-dirty', dirty),
  pickProject: () => ipcRenderer.invoke('agentlab:pick-project'),
  pickDirectory: () => ipcRenderer.invoke('agentlab:pick-directory'),
  openProject: (id) => ipcRenderer.invoke('agentlab:open-project', id),
  startDemo: () => ipcRenderer.invoke('agentlab:demo'),
  newSession: () => ipcRenderer.invoke('agentlab:new-session'),
  request: (action) => ipcRenderer.invoke('agentlab:request', action),
};
contextBridge.exposeInMainWorld('agentlab', bridge);
