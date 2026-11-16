/**
 * 运行时装配（Composition Root）。
 *
 * 只在这里创建全局协作者，其余模块一律通过构造参数注入：
 *  - 便于测试替换（假模型、临时数据库）；
 *  - 避免隐式单例导致权限配置被绕过；
 *  - 审计、审批、策略三者的依赖方向保持单向。
 */
import type { Logger } from '@forgex/shared';
import { createLogger } from '@forgex/shared';
import { createProvider, ModelRouter, RoutedModelProvider, type ModelProvider } from '@forgex/models';
import {
  ApprovalManager,
  AuditLogger,
  WorkspaceGuard,
  createDefaultPolicySettings,
  type ApprovalHandler,
} from '@forgex/security';
import { BrowserSessionManager, CodeExecutionSessionManager, DapSessionManager, ToolRegistry, createBuiltinTools } from '@forgex/tools';
import { Advisor, Agent, MemoryManager, SessionStore, type AdvisorStage, type ForgeExtension } from '@forgex/core';
import type { LoadedConfig, ResolvedConfig } from '../config/load-config.js';
import { SubagentManager } from './subagent-manager.js';

export interface CreateRuntimeOptions {
  cwd: string;
  loaded: LoadedConfig;
  /** 人工审批回调；不传表示非交互环境（所有审批自动拒绝） */
  approvalHandler?: ApprovalHandler;
  logger?: Logger;
  /** 恢复指定会话 */
  sessionId?: string;
  extensions?: ReadonlyArray<ForgeExtension>;
}

export interface ForgeRuntime {
  agent: Agent;
  /** 直连模型的 provider（TaskPlanGenerator 用它纯 JSON 生成计划，不经过 AgentLoop/ToolDispatcher） */
  provider: ModelProvider;
  /** Role aware provider router used by the primary Agent. */
  modelRouter: ModelRouter;
  /** Process-local worker control surface for the local Agent Hub. */
  workers: SubagentManager;
  /** Undefined when project memory is disabled; disabled storage paths are never opened. */
  memory?: MemoryManager;
  store: SessionStore;
  approvals: ApprovalManager;
  audit: AuditLogger;
  config: ResolvedConfig;
  /** 实际生效的策略配置（TUI 运行时切换计划模式会改 mode） */
  settings: ReturnType<typeof createDefaultPolicySettings>;
  /** 实际读取的配置文件路径；未找到为 null（TUI 切换模型时用于持久化） */
  configPath: string | null;
  logger: Logger;
  close(): Promise<void>;
}

export function createRuntime(options: CreateRuntimeOptions): ForgeRuntime {
  const { loaded, cwd } = options;
  const config = loaded.config;
  const logger = options.logger ?? createLogger({ level: 'error' });

  const settings = createDefaultPolicySettings({
    workspaceRoots: config.security.workspaceRoots,
    writableRoots: config.security.writableRoots,
    mode: config.security.mode,
    allowedPrograms: config.security.allowedPrograms,
    requireApprovalForWrite: config.security.requireApprovalForWrite,
    requireApprovalForExecute: config.security.requireApprovalForExecute,
    commandTimeoutMs: config.security.commandTimeoutMs,
    auditLogPath: config.security.auditLogPath,
    // v0.2.0：SSH 远程授权主机从配置透传到策略
    remoteHosts: config.security.remoteHosts,
  });

  const workspace = new WorkspaceGuard({
    roots: settings.workspaceRoots,
    writableRoots: settings.writableRoots,
    protectedPaths: settings.protectedPaths,
  });

  // 主 JSONL 事件流同时保存会话与审计事件。
  const store = new SessionStore(config.session.dbPath);
  const audit = new AuditLogger({
    sinks: [store],
    logger,
  });

  const approvals = new ApprovalManager({
    ...(options.approvalHandler ? { handler: options.approvalHandler } : {}),
    timeoutMs: config.security.approvalTimeoutMs,
    logger,
  });

  const provider = createProvider(config.model, { logger });
  const modelRouter = new ModelRouter();
  for (const model of config.models) {
    modelRouter.register({
      id: model.id,
      provider: createProvider(model.config, { logger }),
      capabilities: model.capabilities,
      tier: model.speedTier,
      speedTier: model.speedTier,
      costTier: model.costTier,
      contextWindow: model.config.contextWindow,
      available: model.available,
    });
  }
  const routedProvider = new RoutedModelProvider(modelRouter, config.modelRoles);
  const advisorDescriptor = config.advisor.modelId
    ? modelRouter.getModel(config.advisor.modelId)
    : undefined;
  const reasoningModelId = config.modelRoles.reasoning
    ?? config.models.find((model) => model.available && model.capabilities.includes('reasoning'))?.id;
  let advisorProvider: ModelProvider = provider;
  if (advisorDescriptor?.available !== false && advisorDescriptor) {
    advisorProvider = advisorDescriptor.provider;
  } else if (!config.advisor.modelId && reasoningModelId) {
    const routedAdvisor = new RoutedModelProvider(modelRouter, { ...config.modelRoles, reasoning: reasoningModelId });
    routedAdvisor.setModelRole('reasoning');
    advisorProvider = routedAdvisor;
  }
  const advisor = new Advisor({
    provider: advisorProvider,
    enabled: config.advisor.enabled,
    stages: config.advisor.stages as AdvisorStage[],
    timeoutMs: config.advisor.timeoutMs,
    maxChecksPerTurn: config.advisor.maxChecksPerTurn,
    maxInterventionsPerTurn: config.advisor.maxInterventionsPerTurn,
  });
  const memory = config.memory.enabled ? new MemoryManager({ dbPath: config.memory.path }) : undefined;
  const codeExecution = config.tools.codeExecution.enabled
    ? {
        nodeCommand: config.tools.codeExecution.nodeCommand,
        pythonCommand: config.tools.codeExecution.pythonCommand,
        timeoutMs: config.tools.codeExecution.timeoutMs,
        maxOutputBytes: config.tools.codeExecution.maxOutputBytes,
      }
    : undefined;
  const codeSessions = codeExecution ? new CodeExecutionSessionManager(codeExecution) : undefined;
  const dapSessions = config.tools.debugAdapters.length > 0 ? new DapSessionManager() : undefined;
  const browserConfig = config.tools.browserAutomation.enabled && config.tools.browserAutomation.command
    ? {
        command: config.tools.browserAutomation.command,
        args: config.tools.browserAutomation.args,
        allowedHosts: config.tools.browserAutomation.allowedHosts,
        timeoutMs: config.tools.browserAutomation.timeoutMs,
      }
    : undefined;
  const browserSessions = browserConfig ? new BrowserSessionManager() : undefined;
  let agent: Agent;
  const subagents = new SubagentManager({
    config,
    settings,
    getProvider: () => agent.currentProvider,
    approvals,
    audit,
    store,
    logger,
    onEvent: (event) => agent.events.emit(event),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  });
  // v0.2.0：根据 PolicySettings.remoteHosts 条件注册 ssh_inspect
  const registry = new ToolRegistry(createBuiltinTools({
    remoteHosts: settings.remoteHosts,
    languageServers: config.tools.languageServers,
    ...(codeExecution && codeSessions ? { codeExecution, codeSessionManager: codeSessions } : {}),
    ...(dapSessions ? { debugAdapters: config.tools.debugAdapters, dapSessionManager: dapSessions } : {}),
    ...(browserConfig && browserSessions ? { browserAutomation: browserConfig, browserSessionManager: browserSessions } : {}),
    delegateTask: subagents.execute,
    ...(memory ? { memoryTools: memory } : {}),
  }));

  // 工具的默认 cwd 必须是授权工作区根目录，而不是进程 cwd：
  // 否则用户在仓库外部启动 CLI 时，所有相对路径都会被判定为越界。
  const workspaceCwd = settings.workspaceRoots[0] ?? cwd;

  agent = new Agent({
    provider: routedProvider,
    registry,
    settings,
    workspace,
    approvals,
    audit,
    store,
    advisor,
    ...(memory ? { memory: { manager: memory, autoRecall: config.memory.autoRecall, autoSave: config.memory.autoSave } } : {}),
    cwd: workspaceCwd,
    ...(config.agent.maxIterations !== undefined ? { maxIterations: config.agent.maxIterations } : {}),
    maxConcurrency: config.agent.maxConcurrency,
    logger,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  });

  return {
    agent,
    provider,
    modelRouter,
    workers: subagents,
    ...(memory ? { memory } : {}),
    store,
    approvals,
    audit,
    config,
    settings,
    configPath: loaded.configPath,
    logger,
    close: async () => {
      await subagents.close();
      memory?.close();
      codeSessions?.closeAll();
      if (dapSessions) void dapSessions.closeAll();
      if (browserSessions) void browserSessions.closeAll();
      store.close();
    },
  };
}
