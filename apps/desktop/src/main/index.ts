import { app, BrowserWindow, Menu } from 'electron';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { registerShellIpcHandlers } from './ipc-handlers.js';
import { DesktopRuntime } from './desktop-runtime.js';
import { IPC_CHANNELS } from '../shared/desktop-api.js';
import { RecentProjectStore } from './recent-project-store.js';

import { SshHostStore } from './ssh-host-store.js';
import { DesktopSshService } from './desktop-ssh-service.js';

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
  const userData = app.getPath('userData');
  const desktopRuntime = new DesktopRuntime(
    (event) => {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event);
    },
    new RecentProjectStore(join(userData, 'recent-projects.json')),
    new SshHostStore(join(userData, 'ssh-hosts.json')),
    new DesktopSshService(),
  );

  const rendererFile = join(import.meta.dirname, '../renderer/index.html');
  const allowedOrigin = isDevelopment ? process.env.ELECTRON_RENDERER_URL : undefined;
  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (allowedOrigin && new URL(url).origin === new URL(allowedOrigin).origin) return;
    if (!allowedOrigin && url.split(/[?#]/, 1)[0] === pathToFileURL(rendererFile).href) return;
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
  else await window.loadFile(rendererFile);
}

function showMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    void createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(() => {
    if (process.platform === 'win32') Menu.setApplicationMenu(null);
    showMainWindow();
    app.on('activate', showMainWindow);
    app.on('second-instance', showMainWindow);
  });
} else {
  app.quit();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
