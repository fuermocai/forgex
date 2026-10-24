/**
 * SandboxLifecycle：沙箱生命周期管理（v0.4.0 Phase 2）。
 *
 * 职责：
 *   - 创建 → 执行 → 清理的完整生命周期；
 *   - 异常时确保资源回收（try/finally）；
 *   - 超时后进程被清理。
 *
 * 安全约束：
 *   - 无论执行成功或失败，沙箱必须被销毁；
 *   - 不允许资源泄漏。
 */
import type { Sandbox, SandboxExecResult, SandboxExecSpec, SandboxSpec } from '../types.js';
import type { ResourceLimiter } from '../manager/resource-limiter.js';
import type { WorkspaceManager } from '../workspace/workspace-manager.js';

export interface SandboxLifecycleOptions {
  workspaceManager: WorkspaceManager;
  resourceLimiter: ResourceLimiter;
}

export class SandboxLifecycle {
  private readonly workspaceManager: WorkspaceManager;
  private readonly resourceLimiter: ResourceLimiter;

  constructor(options: SandboxLifecycleOptions) {
    this.workspaceManager = options.workspaceManager;
    this.resourceLimiter = options.resourceLimiter;
  }

  /**
   * 在沙箱中执行一个操作，确保沙箱最终被清理。
   */
  async runInSandbox(
    spec: SandboxSpec,
    execSpec: SandboxExecSpec,
    signal?: AbortSignal,
  ): Promise<{ sandbox: Sandbox; result: SandboxExecResult }> {
    const sandbox = await this.workspaceManager.createWorkspace(spec);
    try {
      const result = await this.resourceLimiter.exec(
        {
          ...execSpec,
          cwd: execSpec.cwd ?? sandbox.workDir,
        },
        signal,
      );
      return { sandbox, result };
    } finally {
      await this.workspaceManager.destroyWorkspace(sandbox);
    }
  }

  /**
   * 创建沙箱并返回，由调用方负责销毁。
   * 调用方必须在 finally 中调用 destroy。
   */
  async create(spec: SandboxSpec): Promise<Sandbox> {
    return this.workspaceManager.createWorkspace(spec);
  }

  /** 销毁沙箱 */
  async destroy(sandbox: Sandbox): Promise<void> {
    await this.workspaceManager.destroyWorkspace(sandbox);
  }
}
