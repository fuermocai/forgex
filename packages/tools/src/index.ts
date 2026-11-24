/**
 * @forgex/tools：内置工具集合。
 *
 * 工具本身只负责"做什么"，权限/审批/超时/审计由 Core 的 ToolDispatcher 统一负责。
 */
import type { RegisteredTool } from './registry/tool-registry.js';
import { createReadFileTool } from './coding/read-file.js';
import { createListDirectoryTool } from './coding/list-directory.js';
import { createGrepSearchTool } from './coding/grep-search.js';
import { createEditFileTool } from './coding/edit-file.js';
import { createHashlineEditTool } from './coding/hashline-edit.js';
import { createWriteFileTool } from './coding/write-file.js';
import { createGitStatusTool } from './coding/git-status.js';
import { createGitDiffTool } from './coding/git-diff.js';
import { createInspectProcessTool } from './system/inspect-process.js';
import { createInspectPortTool } from './system/inspect-port.js';
import { createInspectDiskTool } from './system/inspect-disk.js';
import { createInspectMemoryTool } from './system/inspect-memory.js';
import { createReadLogsTool } from './system/read-logs.js';
import { createRunCommandTool, type RunCommandToolOptions } from './execution/run-command.js';
import { createSshInspectTool } from './system/ssh-inspect.js';
import { createCorrelateCodeRuntimeTool } from './system/correlate-code-runtime.js';
import { createHybridSearchTool } from './search/hybrid-search-tool.js';
import { createLspTool } from './lsp/lsp-tool.js';
import type { LspServerConfig } from './lsp/lsp-client.js';
import { WorkspaceEditPreviewStore } from './lsp/workspace-edit.js';
import { createApplyWorkspaceEditTool } from './lsp/apply-workspace-edit-tool.js';
import { CodeExecutionSessionManager } from './execution/code-session.js';
import { createCodeSessionTool, type CodeExecutionToolOptions } from './execution/code-session-tool.js';
import { DapSessionManager, type DebugAdapterConfig } from './debug/dap-client.js';
import { createDapTool } from './debug/dap-tool.js';
import { createWebSearchTool, createGitHubQueryTool } from './web/web-query.js';
import { BrowserSessionManager, type BrowserAutomationConfig } from './browser/browser-session.js';
import { createBrowserTool } from './browser/browser-tool.js';
import { createDelegateTaskTool, type DelegateTaskExecutor } from './delegation/delegate-task.js';
import { createMemoryTools, type MemoryToolService } from './memory/memory-tools.js';

export { createDelegateTaskTool } from './delegation/delegate-task.js';
export { createMemoryTools } from './memory/memory-tools.js';
export type { MemoryToolEntry, MemoryToolService } from './memory/memory-tools.js';
export type { DelegateTaskInput, DelegateTaskResult, DelegateTaskBatchResult, DelegateTaskExecutor } from './delegation/delegate-task.js';

export * from './registry/tool-registry.js';
export { runProcess, killTree, resolveLaunch } from './execution/process-runner.js';
export { CodeExecutionSessionManager } from './execution/code-session.js';
export type { CodeLanguage, CodeSessionExecutionInput, CodeSessionExecutionResult, CodeSessionManagerOptions } from './execution/code-session.js';
export { createCodeSessionTool } from './execution/code-session-tool.js';
export type { CodeExecutionToolOptions } from './execution/code-session-tool.js';
export { DapSessionManager, createDapTool } from './debug/index.js';
export type { DebugAdapterConfig, DebugBreakpoint } from './debug/dap-client.js';
export { createWebSearchTool, createGitHubQueryTool } from './web/web-query.js';
export type { WebQueryToolOptions, GitHubQueryToolOptions } from './web/web-query.js';
export { BrowserSessionManager, createBrowserTool } from './browser/index.js';
export type { BrowserAutomationConfig } from './browser/browser-session.js';
export type { ProcessSpec, ProcessResult, ProcessLaunch } from './execution/process-runner.js';
export type { RunCommandToolOptions } from './execution/run-command.js';
export { runViaExecutor, resolveExecutorBinary } from './execution/executor-client.js';
export type { ExecutorSpec, ExecutorResult } from './execution/executor-client.js';
export { createReadFileTool } from './coding/read-file.js';
export { createListDirectoryTool } from './coding/list-directory.js';
export { createGrepSearchTool } from './coding/grep-search.js';
export { createEditFileTool } from './coding/edit-file.js';
export { createHashlineEditTool } from './coding/hashline-edit.js';
export { createWriteFileTool } from './coding/write-file.js';
export { createGitStatusTool } from './coding/git-status.js';
export { createGitDiffTool } from './coding/git-diff.js';
export { createInspectProcessTool } from './system/inspect-process.js';
export { createInspectPortTool } from './system/inspect-port.js';
export { createInspectDiskTool } from './system/inspect-disk.js';
export { createInspectMemoryTool } from './system/inspect-memory.js';
export { createReadLogsTool } from './system/read-logs.js';
export { createRunCommandTool } from './execution/run-command.js';
export { createSshInspectTool } from './system/ssh-inspect.js';
export { createCorrelateCodeRuntimeTool } from './system/correlate-code-runtime.js';
export { createHybridSearchTool } from './search/hybrid-search-tool.js';
export { createLspTool } from './lsp/lsp-tool.js';
export { createApplyWorkspaceEditTool } from './lsp/apply-workspace-edit-tool.js';
export { WorkspaceEditPreviewStore } from './lsp/workspace-edit.js';
export type { WorkspaceEditPreview, WorkspaceEditFilePreview, WorkspaceEditSnapshot, WorkspaceEditPreviewStoreOptions } from './lsp/workspace-edit.js';
export { LspClient, type LspServerConfig, type LspPosition } from './lsp/lsp-client.js';
export { hybridSearch } from './search/hybrid-search.js';
export { walkTextFiles } from './search/walk.js';
export type {
  HybridSearchQuery,
  HybridSearchResult,
  FusedHit,
  SearchHit,
  SearchLayer,
  SymbolKind,
} from './search/types.js';
export { SEARCH_LAYERS, tokenizeQuery } from './search/types.js';

import type { RemoteHostConfig } from '@forgex/shared';

/**
 * 创建第一版全部内置工具。
 *
 * SSH 远程诊断（v0.2.0 新增）采用**条件注册**：
 *   只有当 options.remoteHosts 非空时才注册 ssh_inspect，
 *   否则不把它的 JSON Schema 发给模型——避免浪费 token 并诱导模型反复尝试未配置的功能。
 */
export function createBuiltinTools(options?: {
  remoteHosts?: readonly RemoteHostConfig[];
  languageServers?: readonly LspServerConfig[];
  codeExecution?: CodeExecutionToolOptions;
  codeSessionManager?: CodeExecutionSessionManager;
  debugAdapters?: readonly DebugAdapterConfig[];
  dapSessionManager?: DapSessionManager;
  browserAutomation?: BrowserAutomationConfig;
  browserSessionManager?: BrowserSessionManager;
  delegateTask?: DelegateTaskExecutor;
  memoryTools?: MemoryToolService;
  runCommand?: RunCommandToolOptions;
}): RegisteredTool[] {
  const hasRemoteHosts = (options?.remoteHosts?.length ?? 0) > 0;
  const languageServers = options?.languageServers ?? [];
  const hasLanguageServers = languageServers.length > 0;
  const debugAdapters = options?.debugAdapters ?? [];
  const hasDebugAdapters = debugAdapters.length > 0;
  const workspaceEdits = new WorkspaceEditPreviewStore();
  const tools: RegisteredTool[] = [
    createReadFileTool(),
    createListDirectoryTool(),
    createGrepSearchTool(),
    createEditFileTool(),
    createHashlineEditTool(),
    createWriteFileTool(),
    createGitStatusTool(),
    createGitDiffTool(),
    createInspectProcessTool(),
    createInspectPortTool(),
    createInspectDiskTool(),
    createInspectMemoryTool(),
    createReadLogsTool(),
    createRunCommandTool(options?.runCommand),
    // v0.2.0：SSH 远程只读诊断（条件注册）
    ...(hasRemoteHosts ? [createSshInspectTool()] : []),
    // v0.2.0：代码+运行环境关联分析（纯确定性，无条件注册）
    createCorrelateCodeRuntimeTool(),
    // v0.3.0：三层混合检索（关键词+结构+语义，全离线，无条件注册）
    createHybridSearchTool(),
    createWebSearchTool(),
    createGitHubQueryTool(),
    ...(hasLanguageServers ? [createLspTool(languageServers, workspaceEdits), createApplyWorkspaceEditTool(workspaceEdits)] : []),
    ...(options?.codeExecution
      ? [createCodeSessionTool(options.codeExecution, options.codeSessionManager ?? new CodeExecutionSessionManager(options.codeExecution))]
      : []),
    ...(hasDebugAdapters ? [createDapTool(debugAdapters, options?.dapSessionManager ?? new DapSessionManager())] : []),
    ...(options?.browserAutomation
      ? [createBrowserTool(options.browserAutomation, options.browserSessionManager ?? new BrowserSessionManager())]
      : []),
    ...(options?.delegateTask ? [createDelegateTaskTool(options.delegateTask)] : []),
    ...(options?.memoryTools ? createMemoryTools(options.memoryTools) : []),
  ];
  return tools as unknown as RegisteredTool[];
}
