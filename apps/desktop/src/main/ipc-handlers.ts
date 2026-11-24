import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { basename } from 'node:path';
import { IPC_CHANNELS, type ProjectSelection } from '../shared/desktop-api.js';
import { DesktopRuntime } from './desktop-runtime.js';

function assertTrustedSender(event: IpcMainInvokeEvent, owner: BrowserWindow): void {
  if (event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) {
    throw new Error('拒绝来自非主窗口的 IPC 请求');
  }

  const senderUrl = event.senderFrame.url;
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    if (new URL(senderUrl).origin !== new URL(devUrl).origin) throw new Error('拒绝来自非本地渲染器的 IPC 请求');
  } else if (!senderUrl.startsWith('file://')) {
    throw new Error('拒绝来自非打包界面的 IPC 请求');
  }
}

export function registerShellIpcHandlers(owner: BrowserWindow, runtime: DesktopRuntime): () => void {
  const appState = (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, owner);
    return { ...runtime.getAppState(), version: app.getVersion() };
  };

  const recentProjects = (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, owner);
    return runtime.listRecentProjects();
  };

  const selectProject = async (event: IpcMainInvokeEvent): Promise<ProjectSelection | null> => {
    assertTrustedSender(event, owner);
    const result = await dialog.showOpenDialog(owner, {
      title: '选择 ForgeX 项目',
      properties: ['openDirectory'],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    runtime.authorizeProjectPath(path);
    return { path, name: basename(path) };
  };

  const connectModel = async (event: IpcMainInvokeEvent, input: unknown) => {
    assertTrustedSender(event, owner);
    if (!isRecord(input) || typeof input.providerId !== 'string' || typeof input.baseUrl !== 'string'
      || typeof input.model !== 'string' || typeof input.apiKey !== 'string') {
      throw new Error('模型配置参数无效');
    }
    return runtime.connectModel({ providerId: input.providerId, baseUrl: input.baseUrl, model: input.model, apiKey: input.apiKey });
  };

  const startSession = async (event: IpcMainInvokeEvent, input: unknown) => {
    assertTrustedSender(event, owner);
    if (!isRecord(input) || typeof input.projectPath !== 'string'
      || (input.sessionId !== undefined && typeof input.sessionId !== 'string')) {
      throw new Error('项目会话参数无效');
    }
    return runtime.startProject(input.projectPath, input.sessionId);
  };

  const sendMessage = (event: IpcMainInvokeEvent, text: unknown) => {
    assertTrustedSender(event, owner);
    if (typeof text !== 'string' || text.length > 100_000) throw new Error('消息格式无效或超出长度限制');
    runtime.sendMessage(text);
  };

  const cancelTurn = (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, owner);
    runtime.cancelTurn();
  };

  const listSessions = (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, owner);
    return runtime.listSessions();
  };

  const sessionMessages = (event: IpcMainInvokeEvent, sessionId: unknown) => {
    assertTrustedSender(event, owner);
    if (typeof sessionId !== 'string' || sessionId.length > 200) throw new Error('会话 id 无效');
    return runtime.getSessionMessages(sessionId);
  };

  const renameSession = (event: IpcMainInvokeEvent, input: unknown): void => {
    assertTrustedSender(event, owner);
    if (!isRecord(input) || typeof input.sessionId !== 'string' || typeof input.title !== 'string') {
      throw new Error('会话重命名参数无效');
    }
    runtime.renameSession(input.sessionId, input.title);
  };

  const deleteSession = (event: IpcMainInvokeEvent, sessionId: unknown): void => {
    assertTrustedSender(event, owner);
    if (typeof sessionId !== 'string' || sessionId.length > 200) throw new Error('会话 id 无效');
    runtime.deleteSession(sessionId);
  };

  const resolveApproval = (event: IpcMainInvokeEvent, input: unknown): void => {
    assertTrustedSender(event, owner);
    if (!isRecord(input) || typeof input.approvalId !== 'string'
      || (input.decision !== 'approve' && input.decision !== 'reject')) {
      throw new Error('审批操作参数无效');
    }
    if (!runtime.approvals.resolve(input.approvalId, input.decision)) throw new Error('该审批已结束或不存在');
  };

  const openExternal = async (event: IpcMainInvokeEvent, url: unknown): Promise<void> => {
    assertTrustedSender(event, owner);
    if (typeof url !== 'string') throw new Error('链接格式无效');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('仅允许打开 HTTP 或 HTTPS 链接');
    await shell.openExternal(parsed.toString());
  };

  ipcMain.handle(IPC_CHANNELS.appState, appState);
  ipcMain.handle(IPC_CHANNELS.recentProjects, recentProjects);
  ipcMain.handle(IPC_CHANNELS.selectProject, selectProject);
  ipcMain.handle(IPC_CHANNELS.connectModel, connectModel);
  ipcMain.handle(IPC_CHANNELS.startSession, startSession);
  ipcMain.handle(IPC_CHANNELS.sendMessage, sendMessage);
  ipcMain.handle(IPC_CHANNELS.cancelTurn, cancelTurn);
  ipcMain.handle(IPC_CHANNELS.listSessions, listSessions);
  ipcMain.handle(IPC_CHANNELS.sessionMessages, sessionMessages);
  ipcMain.handle(IPC_CHANNELS.renameSession, renameSession);
  ipcMain.handle(IPC_CHANNELS.deleteSession, deleteSession);
  ipcMain.handle(IPC_CHANNELS.resolveApproval, resolveApproval);
  ipcMain.handle(IPC_CHANNELS.openExternal, openExternal);

  return () => {
    for (const channel of [IPC_CHANNELS.appState, IPC_CHANNELS.recentProjects, IPC_CHANNELS.selectProject, IPC_CHANNELS.connectModel,
      IPC_CHANNELS.startSession, IPC_CHANNELS.sendMessage, IPC_CHANNELS.cancelTurn, IPC_CHANNELS.listSessions,
      IPC_CHANNELS.sessionMessages, IPC_CHANNELS.renameSession, IPC_CHANNELS.deleteSession,
      IPC_CHANNELS.resolveApproval, IPC_CHANNELS.openExternal]) {
      ipcMain.removeHandler(channel);
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
