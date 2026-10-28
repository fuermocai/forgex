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
import { createProvider, type ModelProvider } from '@forgex/models';
import {
  ApprovalManager,
  AuditLogger,
  WorkspaceGuard,
  createDefaultPolicySettings,
  type ApprovalHandler,
} from '@forgex/security';
import { ToolRegistry, createBuiltinTools } from '@forgex/tools';
import { Agent, SessionStore } from '@forgex/core';
import type { LoadedConfig, ResolvedConfig } from '../config/load-config.js';

export interface CreateRuntimeOptions {
  cwd: string;
  loaded: LoadedConfig;
  /** 人工审批回调；不传表示非交互环境（所有审批自动拒绝） */
  approvalHandler?: ApprovalHandler;
  logger?: Logger;
  /** 恢复指定会话 */
  sessionId?: string;
}

export interface ForgeRuntime {
  agent: Agent;
  /** 直连模型的 provider（TaskPlanGenerator 用它纯 JSON 生成计划，不经过 AgentLoop/ToolDispatcher） */
  provider: ModelProvider;
  store: SessionStore;
  approvals: ApprovalManager;
  audit: AuditLogger;
  config: ResolvedConfig;
  /** 实际生效的策略配置（TUI 运行时切换计划模式会改 mode） */
  settings: ReturnType<typeof createDefaultPolicySettings>;
  /** 实际读取的配置文件路径；未找到为 null（TUI 切换模型时用于持久化） */
  configPath: string | null;
  logger: Logger;
  close(): void;
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

  // 会话库是审计 sink 之一：即使外部 JSONL 文件不可写，审计事件也不会丢
  const store = new SessionStore(config.session.dbPath);
  const audit = new AuditLogger({
    sinks: [store],
    filePath: config.security.auditLogPath,
    logger,
  });

  const approvals = new ApprovalManager({
    ...(options.approvalHandler ? { handler: options.approvalHandler } : {}),
    timeoutMs: config.security.approvalTimeoutMs,
    logger,
  });

  const provider = createProvider(config.model, { logger });
  // v0.2.0：根据 PolicySettings.remoteHosts 条件注册 ssh_inspect
  const registry = new ToolRegistry(createBuiltinTools({ remoteHosts: settings.remoteHosts }));

  // 工具的默认 cwd 必须是授权工作区根目录，而不是进程 cwd：
  // 否则用户在仓库外部启动 CLI 时，所有相对路径都会被判定为越界。
  const workspaceCwd = settings.workspaceRoots[0] ?? cwd;

  const agent = new Agent({
    provider,
    registry,
    settings,
    workspace,
    approvals,
    audit,
    store,
    cwd: workspaceCwd,
    maxIterations: config.agent.maxIterations,
    maxConcurrency: config.agent.maxConcurrency,
    logger,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });

  return {
    agent,
    provider,
    store,
    approvals,
    audit,
    config,
    settings,
    configPath: loaded.configPath,
    logger,
    close: () => store.close(),
  };
}
