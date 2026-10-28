/**
 * SandboxLifecycle：沙箱生命周期管理（v0.4.0 Phase 2，v0.5.5 移除旁路执行入口）。
 *
 * 职责：
 *   - 创建 / 销毁沙箱，保证异常时资源回收；
 *   - **不负责执行**：执行必须经过 SandboxManager 的路由（trusted → 资源限制，
 *     untrusted → OS 沙箱），因此这里不再提供 `runInSandbox()`——旧实现会直接
 *     调用 ResourceLimiter，等于给 untrusted 开了一条绕过 OS 沙箱的旁路。
 *
 * 安全约束：
 *   - 无论执行成功或失败，沙箱必须被销毁；
 *   - 不允许资源泄漏。
 */
import type { Sandbox, SandboxSpec } from '../types.js';
import type { WorkspaceManager } from '../workspace/workspace-manager.js';

export interface SandboxLifecycleOptions {
  workspaceManager: WorkspaceManager;
}

export class SandboxLifecycle {
  private readonly workspaceManager: WorkspaceManager;

  constructor(options: SandboxLifecycleOptions) {
    this.workspaceManager = options.workspaceManager;
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
