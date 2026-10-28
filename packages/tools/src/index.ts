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
import { createWriteFileTool } from './coding/write-file.js';
import { createGitStatusTool } from './coding/git-status.js';
import { createGitDiffTool } from './coding/git-diff.js';
import { createInspectProcessTool } from './system/inspect-process.js';
import { createInspectPortTool } from './system/inspect-port.js';
import { createInspectDiskTool } from './system/inspect-disk.js';
import { createInspectMemoryTool } from './system/inspect-memory.js';
import { createReadLogsTool } from './system/read-logs.js';
import { createRunCommandTool } from './execution/run-command.js';
import { createSshInspectTool } from './system/ssh-inspect.js';
import { createCorrelateCodeRuntimeTool } from './system/correlate-code-runtime.js';
import { createHybridSearchTool } from './search/hybrid-search-tool.js';

export * from './registry/tool-registry.js';
export { runProcess, killTree } from './execution/process-runner.js';
export type { ProcessSpec, ProcessResult } from './execution/process-runner.js';
export { runViaExecutor, resolveExecutorBinary } from './execution/executor-client.js';
export type { ExecutorSpec, ExecutorResult } from './execution/executor-client.js';
export { createReadFileTool } from './coding/read-file.js';
export { createListDirectoryTool } from './coding/list-directory.js';
export { createGrepSearchTool } from './coding/grep-search.js';
export { createEditFileTool } from './coding/edit-file.js';
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
export function createBuiltinTools(options?: { remoteHosts?: readonly RemoteHostConfig[] }): RegisteredTool[] {
  const hasRemoteHosts = (options?.remoteHosts?.length ?? 0) > 0;
  const tools: RegisteredTool[] = [
    createReadFileTool(),
    createListDirectoryTool(),
    createGrepSearchTool(),
    createEditFileTool(),
    createWriteFileTool(),
    createGitStatusTool(),
    createGitDiffTool(),
    createInspectProcessTool(),
    createInspectPortTool(),
    createInspectDiskTool(),
    createInspectMemoryTool(),
    createReadLogsTool(),
    createRunCommandTool(),
    // v0.2.0：SSH 远程只读诊断（条件注册）
    ...(hasRemoteHosts ? [createSshInspectTool()] : []),
    // v0.2.0：代码+运行环境关联分析（纯确定性，无条件注册）
    createCorrelateCodeRuntimeTool(),
    // v0.3.0：三层混合检索（关键词+结构+语义，全离线，无条件注册）
    createHybridSearchTool(),
  ];
  return tools as unknown as RegisteredTool[];
}
