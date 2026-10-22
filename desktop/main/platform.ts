import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron';
import type { DesktopNavigation } from '../shared/protocol.js';

/** 保留原生窗口边框；macOS 仅将内容延伸到标题栏，交通灯由系统管理。 */
export function platformWindowOptions(platform: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    ...(platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 16 } }
      : { autoHideMenuBar: true }),
  };
}
export function desktopMenu(
  platform: string,
  navigate: (action: DesktopNavigation) => void,
): MenuItemConstructorOptions[] {
  const settings: MenuItemConstructorOptions = {
    label: '设置…',
    accelerator: 'CmdOrCtrl+,',
    click: () => navigate('settings'),
  };
  return [
    ...(platform === 'darwin'
      ? [
          {
            label: 'AgentLab',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'services' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '打开项目…', accelerator: 'CmdOrCtrl+O', click: () => navigate('open-project') },
        { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: () => navigate('new-session') },
        ...(platform === 'darwin' ? [] : [settings]),
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}
