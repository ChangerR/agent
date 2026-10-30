import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopState } from '../shared/protocol.js';
/** 白名单桥只返回纯 DTO，不暴露原始 IPC、文件系统或 shell。 */
const bridge: DesktopBridge = {
  addRemoteHost: (input) => ipcRenderer.invoke('agentlab:add-remote-host', input),
  openRemoteProject: (input) => ipcRenderer.invoke('agentlab:open-remote-project', input),
  createProject: (input) => ipcRenderer.invoke('agentlab:create-project', input),
  cancelRemoteConnection: () => ipcRenderer.invoke('agentlab:cancel-remote-project'),
  remoteConnections: () => ipcRenderer.invoke('agentlab:remote-connections'),
  readModelSetup: (service) => ipcRenderer.invoke('agentlab:model-setup-read', service),
  saveModelSetup: (input) => ipcRenderer.invoke('agentlab:model-setup-save', input),
  globalSettingsRequest: (action) => ipcRenderer.invoke('agentlab:global-settings', action),
  credentialStatus: (provider) => ipcRenderer.invoke('agentlab:credential-status', provider),
  saveCredential: (token, key) => ipcRenderer.invoke('agentlab:credential-save', { token, key }),
  setTheme: (theme) => ipcRenderer.invoke('agentlab:theme', theme),
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
  pickProject: (options) => ipcRenderer.invoke('agentlab:pick-project', options),
  pickDirectory: () => ipcRenderer.invoke('agentlab:pick-directory'),
  pickRemoteDirectory: (input) => ipcRenderer.invoke('agentlab:pick-remote-directory', input),
  openProject: (id) => ipcRenderer.invoke('agentlab:open-project', id),
  startDemo: () => ipcRenderer.invoke('agentlab:demo'),
  newSession: (options) => ipcRenderer.invoke('agentlab:new-session', options),
  request: (action) => ipcRenderer.invoke('agentlab:request', action),
};
contextBridge.exposeInMainWorld('agentlab', bridge);
