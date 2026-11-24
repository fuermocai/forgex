import { contextBridge } from 'electron';

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS, type DesktopApi, type DesktopEvent } from '../shared/desktop-api.js';

const api: DesktopApi = {
  getAppState: () => ipcRenderer.invoke(IPC_CHANNELS.appState),
  getRecentProjects: () => ipcRenderer.invoke(IPC_CHANNELS.recentProjects),
  selectProject: () => ipcRenderer.invoke(IPC_CHANNELS.selectProject),
  connectModel: (input) => ipcRenderer.invoke(IPC_CHANNELS.connectModel, input),
  startSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.startSession, input),
  sendMessage: (text) => ipcRenderer.invoke(IPC_CHANNELS.sendMessage, text),
  cancelTurn: () => ipcRenderer.invoke(IPC_CHANNELS.cancelTurn),
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listSessions),
  getSessionMessages: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionMessages, sessionId),
  renameSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.renameSession, input),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.deleteSession, sessionId),
  resolveApproval: (input) => ipcRenderer.invoke(IPC_CHANNELS.resolveApproval, input),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  getGitStatus: () => ipcRenderer.invoke(IPC_CHANNELS.gitStatus),
  getGitDiff: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitDiff, input),
  stageGitFiles: (paths) => ipcRenderer.invoke(IPC_CHANNELS.gitStage, paths),
  unstageGitFiles: (paths) => ipcRenderer.invoke(IPC_CHANNELS.gitUnstage, paths),
  commitGit: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitCommit, input),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DesktopEvent) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld('forgex', api);

