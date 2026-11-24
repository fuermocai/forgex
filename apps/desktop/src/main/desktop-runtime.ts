import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRuntime, type CreateRuntimeOptions, type ForgeRuntime } from '../../../cli/src/runtime/create-runtime.js';
import { loadConfig } from '../../../cli/src/config/load-config.js';
import { VERSION } from '../../../cli/src/version.js';
import {
  PROVIDERS,
  PROVIDERS_KEYS,
  defaultConfigPath,
  persistApiKey,
  readExistingConfig,
  saveConnectionConfig,
  testConnectivity,
} from '../../../cli/src/runtime/connect-core.js';
import { redactText } from '../../../../packages/shared/src/utils/redact.js';
import type { ConnectModelInput, ConnectModelResult, DesktopAppState, DesktopEvent, GitStatusResult, SessionSummary } from '../shared/desktop-api.js';
import { DesktopApprovalBroker } from './desktop-approval-broker.js';
import { DesktopGitService } from './desktop-git-service.js';
import { RecentProjectStore } from './recent-project-store.js';

export class DesktopRuntime {
  readonly approvals: DesktopApprovalBroker;
  private readonly git = new DesktopGitService();
  private runtime: ForgeRuntime | null = null;
  private projectPath: string | null = null;
  private workspaceRoot: string | null = null;
  private authorizedProjectPaths = new Set<string>();
  private activeController: AbortController | null = null;
  private activeRun: Promise<void> | null = null;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(private readonly emit: (event: DesktopEvent) => void, private readonly recentProjectStore: RecentProjectStore) {
    this.approvals = new DesktopApprovalBroker(emit);
    for (const project of recentProjectStore.list()) this.authorizedProjectPaths.add(resolve(project.path));
  }

  authorizeProjectPath(path: string): void {
    this.authorizedProjectPaths.add(resolve(path));
  }

  listRecentProjects() {
    return this.recentProjectStore.list();
  }

  getAppState(): DesktopAppState {
    let loaded: ReturnType<typeof loadConfig> | null = null;
    try {
      loaded = loadConfig({ cwd: this.projectPath ?? homedir() });
    } catch {
      // Invalid project-local configuration is reported when the project is opened.
    }
    return {
      version: VERSION,
      modelConfigured: loaded?.modelConfigured ?? false,
      permissionMode: loaded?.config.security.mode ?? 'standard',
      projectPath: this.projectPath,
      modelConfigPath: loaded?.configPath ?? defaultConfigPath(),
      providers: PROVIDERS_KEYS.map((id) => {
        const provider = PROVIDERS[id]!;
        return { id, name: provider.name, defaultBaseUrl: provider.defaultBaseUrl, defaultModel: provider.defaultModel, apiKeyEnv: provider.apiKeyEnv };
      }),
    };
  }

  async connectModel(input: ConnectModelInput): Promise<ConnectModelResult> {
    const provider = PROVIDERS[input.providerId];
    if (!provider || !PROVIDERS_KEYS.includes(input.providerId)) throw new Error('不支持的模型提供方');
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    const model = input.model.trim();
    const apiKey = input.apiKey.trim();
    if (!baseUrl || !model || (!apiKey && input.providerId !== 'custom')) throw new Error('API 地址、模型名称和 API Key 都不能为空');
    if (apiKey.length > 4096 || model.length > 200 || baseUrl.length > 2048) throw new Error('模型配置字段超出长度限制');
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('API 地址格式无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('API 地址仅支持 HTTP(S)，且不能在地址中嵌入凭据');
    }

    const connectivity = await testConnectivity({ baseUrl, apiKey, model });
    if (!connectivity.ok) throw new Error(`连接失败：${connectivity.reason}${connectivity.detail ? `（${connectivity.detail}）` : ''}`);

    const envName = provider.apiKeyEnv;
    const configPath = this.runtime?.configPath
      ?? loadConfig({ cwd: this.projectPath ?? homedir() }).configPath
      ?? defaultConfigPath();
    if (apiKey) {
      const persisted = persistApiKey(envName, apiKey);
      if (!persisted.ok) throw new Error(`凭据保存失败：${persisted.hint}`);
      process.env[envName] = apiKey;
    }
    saveConnectionConfig(configPath, readExistingConfig(configPath), {
      baseUrl,
      model,
      envName,
      contextWindow: provider.contextWindow,
      maxOutputTokens: provider.maxOutputTokens,
    });

    if (this.projectPath && this.runtime) {
      const activeSessionId = this.runtime.agent.sessionId;
      await this.startProject(this.projectPath, activeSessionId);
    }
    return { model, latencyMs: connectivity.latencyMs ?? 0 };
  }

  async startProject(projectPath: string, sessionId?: string): Promise<SessionSummary> {
    const absolutePath = await realpath(resolve(projectPath));
    if (!isAbsolute(absolutePath) || !this.authorizedProjectPaths.has(resolve(projectPath))) {
      throw new Error('请先通过项目选择器授权工作区');
    }
    if (!(await stat(absolutePath)).isDirectory()) throw new Error('所选项目路径不是文件夹');

    await this.closeRuntime();
    const loaded = loadConfig({ cwd: absolutePath });
    const options: CreateRuntimeOptions = {
      cwd: absolutePath,
      loaded,
      ...(sessionId ? { sessionId } : {}),
      approvalHandler: this.approvals.handler,
    };
    const runtime = createRuntime(options);
    const workspaceRoot = runtime.settings.workspaceRoots[0] ?? absolutePath;
    if (sessionId) {
      const session = runtime.store.getSession(sessionId);
      if (!session || !isSamePath(session.workspace, workspaceRoot)) {
        await runtime.close();
        throw new Error('会话不存在或不属于所选项目');
      }
    }

    this.runtime = runtime;
    this.projectPath = absolutePath;
    this.workspaceRoot = workspaceRoot;
    this.unsubscribeEvents = runtime.agent.events.on((event) => this.forwardAgentEvent(event));
    const session = runtime.store.getSession(runtime.agent.sessionId);
    if (!session) throw new Error('ForgeX 未能创建会话');
    this.recentProjectStore.remember({ path: absolutePath, name: basename(absolutePath) });
    return toSessionSummary(session);
  }

  sendMessage(text: string): void {
    const runtime = this.requireRuntime();
    const message = text.trim();
    if (!message) throw new Error('消息不能为空');
    if (this.activeRun) throw new Error('Agent 正在运行，请等待或取消当前任务');

    const controller = new AbortController();
    this.activeController = controller;
    this.activeRun = runtime.agent
      .run(message, { signal: controller.signal })
      .then(() => undefined)
      .catch((error: unknown) => {
        const message = redactText(error instanceof Error ? error.message : String(error));
        this.emit({ type: 'notice', level: 'error', message });
        this.emit({ type: 'turn:end', reason: controller.signal.aborted ? 'aborted' : 'error' });
      })
      .finally(() => {
        this.activeController = null;
        this.activeRun = null;
      });
  }

  cancelTurn(): void {
    this.activeController?.abort(new Error('桌面端取消当前任务'));
  }

  listSessions(): SessionSummary[] {
    const runtime = this.requireRuntime();
    const workspace = this.workspaceRoot;
    return runtime.store.listSessions(100)
      .filter((session) => session.workspace === workspace)
      .map(toSessionSummary);
  }

  getSessionMessages(sessionId: string) {
    const runtime = this.requireRuntime();
    const session = runtime.store.getSession(sessionId);
    if (!session || session.workspace !== this.workspaceRoot) throw new Error('会话不存在或不属于当前项目');
    return runtime.store.getMessages(sessionId)
      .filter((message) => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content! }));
  }

  renameSession(sessionId: string, title: string): void {
    const runtime = this.requireRuntime();
    const session = runtime.store.getSession(sessionId);
    if (!session || session.workspace !== this.workspaceRoot) throw new Error('会话不存在或不属于当前项目');
    const normalizedTitle = title.trim();
    if (!normalizedTitle || normalizedTitle.length > 120) throw new Error('会话名称不能为空，且最多 120 个字符');
    runtime.store.updateSession(sessionId, { title: normalizedTitle });
  }

  deleteSession(sessionId: string): void {
    const runtime = this.requireRuntime();
    const session = runtime.store.getSession(sessionId);
    if (!session || session.workspace !== this.workspaceRoot) throw new Error('会话不存在或不属于当前项目');
    if (runtime.agent.sessionId === sessionId && this.activeRun) throw new Error('当前会话正在运行，请先取消或等待任务结束');
    if (!runtime.store.deleteSession(sessionId)) throw new Error('会话已不存在');
  }

  async getGitStatus(): Promise<GitStatusResult> {
    return this.git.status(await this.requireGitWorkspaceRoot());
  }

  async getGitDiff(input: { path: string; staged: boolean }): Promise<string> {
    return this.git.diff(await this.requireGitWorkspaceRoot(), input.path, input.staged);
  }

  async stageGitFiles(paths: string[]): Promise<void> {
    await this.git.stage(await this.requireGitWorkspaceRoot(), paths);
  }

  async unstageGitFiles(paths: string[]): Promise<void> {
    await this.git.unstage(await this.requireGitWorkspaceRoot(), paths);
  }

  async commitGit(input: { message: string }): Promise<{ commit: string }> {
    return this.git.commit(await this.requireGitWorkspaceRoot(), input.message);
  }

  async close(): Promise<void> {
    await this.closeRuntime();
  }

  private async closeRuntime(): Promise<void> {
    this.approvals.cancelAll();
    this.cancelTurn();
    await this.activeRun;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    const runtime = this.runtime;
    this.runtime = null;
    this.projectPath = null;
    this.workspaceRoot = null;
    if (runtime) await runtime.close();
  }

  private requireRuntime(): ForgeRuntime {
    if (!this.runtime) throw new Error('请先选择项目并启动会话');
    return this.runtime;
  }

  private async requireGitWorkspaceRoot(): Promise<string> {
    const { runtime, projectPath, workspaceRoot } = this;
    if (!runtime || !projectPath || !workspaceRoot) {
      throw new Error('请先选择本地项目并启动会话');
    }
    const root = await realpath(workspaceRoot).catch(() => {
      throw new Error('无法访问当前项目的工作区');
    });
    if (projectPath !== root || this.runtime !== runtime) {
      throw new Error('Git 工作区必须是当前已授权的项目目录');
    }
    return root;
  }

  private forwardAgentEvent(event: Parameters<ForgeRuntime['agent']['events']['on']>[0] extends (value: infer E) => void ? E : never): void {
    switch (event.type) {
      case 'assistant:delta':
      case 'assistant:message':
        this.emit(event.type === 'assistant:delta' ? { type: event.type, text: event.text } : { type: event.type, text: event.text });
        break;
      case 'tool:start':
        this.emit({ type: 'tool:start', callId: event.callId, name: event.name });
        break;
      case 'tool:end':
        this.emit({
          type: 'tool:end',
          callId: event.callId,
          name: event.name,
          ok: event.result.ok,
          summary: redactText(event.result.summary),
          ...(event.result.error ? { error: redactText(event.result.error.message) } : {}),
          durationMs: event.result.durationMs,
        });
        break;
      case 'approval:required':
        // ApprovalBroker emits the renderer DTO after redacting input and preview.
        // Never forward the raw agent event through the desktop event channel.
        break;
      case 'notice':
        this.emit({ type: 'notice', level: event.level, message: redactText(event.message) });
        break;
      case 'metrics':
        this.emit({ type: 'metrics', totalTokens: event.metrics.totalTokens, totalMs: event.metrics.totalMs, toolCalls: event.metrics.toolCalls });
        break;
      case 'turn:end':
        this.emit({ type: 'turn:end', reason: event.reason });
        break;
      case 'approval:resolved':
        this.approvals.dismiss(event.id);
        this.emit({ type: 'approval:resolved', id: event.id });
        break;
    }
  }
}

function toSessionSummary(session: { id: string; title: string | null; workspace: string; model: string; updatedAt: string; status: string }): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    model: session.model,
    updatedAt: session.updatedAt,
    status: session.status,
  };
}

function isSamePath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase();
}
