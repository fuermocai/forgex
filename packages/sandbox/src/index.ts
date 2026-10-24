/**
 * @forgex/sandbox 公共入口（v0.4.0 Phase 2）。
 *
 * 沙箱管理器提供工作区隔离、资源限制和不可信代码执行拒绝能力。
 * Git Worktree 只做代码隔离，不替代 OS 级安全沙箱。
 */
export * from './types.js';
export * from './manager/capability-detector.js';
export * from './manager/resource-limiter.js';
export * from './manager/sandbox-manager.js';
export * from './providers/sandbox-provider.js';
export * from './providers/temp-dir-provider.js';
export * from './providers/git-worktree-provider.js';
export * from './providers/os-sandbox-provider.js';
export * from './workspace/workspace-manager.js';
export * from './lifecycle/sandbox-lifecycle.js';
