import { randomUUID } from 'node:crypto';
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
import type { ConnectModelInput, ConnectModelResult, DesktopAppState, DesktopEvent, GitSnapshot, GitStatusResult, SessionSummary } from '../shared/desktop-api.js';
import { DesktopApprovalBroker } from './desktop-approval-broker.js';
import { DesktopGitService } from './desktop-git-service.js';
import { RecentProjectStore } from './recent-project-store.js';

import type { RemoteDiagActionDto, SshHostOperation, SshHostProfile, SshHostProfileInput } from '../shared/desktop-api.js';
import type { DesktopSshService } from './desktop-ssh-service.js';
import type { SshHostStore } from './ssh-host-store.js';

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

  private readonly sshOperations = new Map<string, { hostId: string; controller: AbortController }>();
  private readonly probedFingerprints = new Map<string, { profile: SshHostProfile; fingerprint: string }>();
  private closing = false;

  constructor(
    private readonly emit: (event: DesktopEvent) => void,
    private readonly recentProjectStore: RecentProjectStore,
    private readonly sshHosts: SshHostStore,
    private readonly sshService: DesktopSshService,
  ) {
    this.approvals = new DesktopApprovalBroker(emit);
    for (const project of recentProjectStore.list()) this.authorizedProjectPaths.add(resolve(project.path));
  }

  listSshHosts() { return this.sshHosts.list(); }

  private requireHost(id: string): SshHostProfile {
    const profile = this.sshHosts.list().find((row) => row.id === id);
    if (!profile) throw new Error('SSH 主机不存在');
    return profile;
  }

  private invalidateHost(id: string): void {
    this.probedFingerprints.delete(id);
    for (const { hostId, controller } of this.sshOperations.values()) {
      if (id === hostId) controller.abort(new Error('主机配置已更新，请重试'));
    }
  }

  saveSshHost(input: SshHostProfileInput & { id?: string }) {
    const old = input.id ? this.requireHost(input.id) : undefined;
    const sameIdentity = old?.host === input.host && old.port === input.port && old.username === input.username;
    const saved = this.sshHosts.upsert({ ...input, id: old?.id ?? randomUUID(),
      hostKeyFingerprint: sameIdentity ? old.hostKeyFingerprint : null });
    this.invalidateHost(saved.id);
    return saved;
  }

  deleteSshHost(id: string): void {
    this.sshHosts.remove(id);
    this.invalidateHost(id);
  }

  trustSshHostKey(id: string, fingerprint: string) {
    const profile = this.requireHost(id);
    const probe = this.probedFingerprints.get(id);
    if (!probe || probe.fingerprint !== fingerprint || probe.profile.host !== profile.host
      || probe.profile.port !== profile.port || probe.profile.username !== profile.username
      || probe.profile.hostKeyFingerprint !== profile.hostKeyFingerprint) throw new Error('请重新探测并核对主机指纹');
    const saved = this.sshHosts.upsert({ ...profile, hostKeyFingerprint: fingerprint });
    this.invalidateHost(id);
    return saved;
  }

  probeSshHost(input: SshHostOperation) {
    this.probedFingerprints.delete(input.id);
    return this.runSshOperation(input, async (profile, signal) => {
      const fingerprint = await this.sshService.probeHostKey(profile, signal);
      signal.throwIfAborted();
      this.probedFingerprints.set(profile.id, { profile, fingerprint });
      return { fingerprint };
    });
  }

  testSshHost(input: SshHostOperation) {
    return this.runSshOperation(input, (profile, signal) => this.sshService.testConnection(profile, signal));
  }

  runSshDiagnostic(input: SshHostOperation, action: RemoteDiagActionDto) {
    return this.runSshOperation(input, (profile, signal) => this.sshService.diagnose(profile, action, signal));
  }

  cancelSshOperation(id: string): void {
    this.sshOperations.get(id)?.controller.abort(new Error('SSH 操作已取消'));
  }

  private async runSshOperation<T>(input: SshHostOperation, run: (p: SshHostProfile, s: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('窗口正在关闭');
    if (this.sshOperations.has(input.operationId)) throw new Error('SSH 操作标识已被使用');
    if (this.sshOperations.size >= 32) throw new Error('SSH 操作过多，请稍后重试');
    const profile = this.requireHost(input.id);
    const controller = new AbortController();
    this.sshOperations.set(input.operationId, { hostId: input.id, controller });
    const timer = setTimeout(() => controller.abort(new Error('SSH 操作超时')), 45_000);
    try {
      const result = await run(profile, controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (err) {
      controller.signal.throwIfAborted();
      throw err;
    } finally {
      clearTimeout(timer);
      this.sshOperations.delete(input.operationId);
    }
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

  async commitGit(input: { message: string; snapshot: GitSnapshot }): Promise<{ commit: string }> {
    return this.git.commit(await this.requireGitWorkspaceRoot(), input.message, input.snapshot);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.probedFingerprints.clear();
    for (const id of this.sshOperations.keys()) this.cancelSshOperation(id);
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
