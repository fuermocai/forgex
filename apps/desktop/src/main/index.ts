import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';
import { registerShellIpcHandlers } from './ipc-handlers.js';
import { DesktopRuntime } from './desktop-runtime.js';
import { IPC_CHANNELS } from '../shared/desktop-api.js';
import { RecentProjectStore } from './recent-project-store.js';

const isDevelopment = !app.isPackaged;

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#10151c',
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        color: '#171e27',
        symbolColor: '#9aa8b8',
        height: 40,
      },
    } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const desktopRuntime = new DesktopRuntime((event) => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event);
  }, new RecentProjectStore(join(app.getPath('userData'), 'recent-projects.json')));

  const allowedOrigin = isDevelopment ? process.env.ELECTRON_RENDERER_URL : undefined;
  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (allowedOrigin && new URL(url).origin === new URL(allowedOrigin).origin) return;
    if (!allowedOrigin && url.startsWith('file://')) return;
    event.preventDefault();
  });

  const unregisterIpc = registerShellIpcHandlers(window, desktopRuntime);
  let closing = false;
  window.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void desktopRuntime.close().finally(() => window.close());
  });
  window.once('closed', () => {
    unregisterIpc();
  });

  if (allowedOrigin) await window.loadURL(allowedOrigin);
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'win32') Menu.setApplicationMenu(null);
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
