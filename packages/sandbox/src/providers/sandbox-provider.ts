/**
 * SandboxProvider：沙箱提供者接口（v0.4.0 Phase 2）。
 *
 * 不同的隔离级别有不同的实现：
 *   - TempDirProvider：临时目录隔离（最低级别）
 *   - GitWorktreeProvider：Git Worktree 代码隔离
 *   - OsSandboxProvider：OS 级沙箱（bubblewrap 等，第一版仅检测）
 *
 * 安全约束：
 *   - create 返回的 Sandbox.workDir 必须在授权工作区内；
 *   - destroy 必须清理所有临时资源；
 *   - 不允许 Provider 自行修改系统安全机制。
 */
import type { Sandbox, SandboxSpec } from '../types.js';

export interface SandboxProvider {
  /** 提供者类型 */
  readonly type: Sandbox['type'];

  /**
   * 创建沙箱。
   * @param spec 沙箱规格
   * @returns 沙箱实例
   */
  create(spec: SandboxSpec): Promise<Sandbox>;

  /**
   * 销毁沙箱，清理所有资源。
   * @param sandbox 要销毁的沙箱
   */
  destroy(sandbox: Sandbox): Promise<void>;

  /**
   * 检查该 Provider 是否可用。
   */
  isAvailable(): Promise<boolean>;
}
