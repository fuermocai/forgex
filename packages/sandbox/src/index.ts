/**
 * @forgex/sandbox 公共入口（v0.4.0 Phase 2，v0.5.5 能力一致性加固）。
 *
 * 隔离能力分三层，命名上不得混用：
 *   - 工作区隔离：TempDirProvider / GitWorktreeProvider（只隔离文件视图）；
 *   - 资源限制：ResourceLimiter / Rust executor（超时、输出限额、进程树清理）；
 *   - OS 级隔离：OsSandboxProvider + bubblewrap（文件系统/网络/进程命名空间）。
 * 只有第三层可以支撑 `trustLevel: 'untrusted'`。
 */
export * from './types.js';
export * from './manager/capability-detector.js';
export * from './manager/resource-limiter.js';
export * from './manager/sandbox-manager.js';
export * from './providers/sandbox-provider.js';
export * from './providers/temp-dir-provider.js';
export * from './providers/git-worktree-provider.js';
export * from './providers/bubblewrap.js';
export * from './providers/os-sandbox-provider.js';
export * from './workspace/workspace-manager.js';
export * from './lifecycle/sandbox-lifecycle.js';
