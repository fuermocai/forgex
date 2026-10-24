/**
 * Sandbox Manager 类型定义（v0.4.0 Phase 2）。
 *
 * 设计原则：
 *   1. 所有字段可 JSON 序列化；
 *   2. SandboxType 区分三种隔离级别：临时目录、Git Worktree、OS 级沙箱；
 *   3. SandboxCapability 明确报告每项能力的可用状态和原因；
 *   4. 沙箱不可用时拒绝不可信代码执行，禁止自动降级。
 */

/** 沙箱类型 */
export type SandboxType = 'temp_dir' | 'git_worktree' | 'os_sandbox';

/** 单项沙箱能力检测结果 */
export interface SandboxCapability {
  /** 能力类型 */
  type: SandboxType | 'rust_executor' | 'git' | 'temp_dir';
  /** 是否可用 */
  available: boolean;
  /** 不可用时的原因（可用时为空字符串） */
  reason: string;
  /** 额外信息（如版本号、路径） */
  details?: Record<string, string>;
}

/** 整体沙箱能力检测报告 */
export interface SandboxCapabilityReport {
  /** Rust 安全执行器是否可用 */
  rustExecutor: SandboxCapability;
  /** Git 是否可用（用于 worktree） */
  git: SandboxCapability;
  /** 临时目录是否可写 */
  tempDir: SandboxCapability;
  /** OS 级沙箱是否可用（bubblewrap/seccomp/cgroups） */
  osSandbox: SandboxCapability;
  /** 是否至少有一种沙箱可用 */
  anyAvailable: boolean;
}

/** 沙箱规格 */
export interface SandboxSpec {
  /** 授权工作区根目录 */
  workspaceRoot: string;
  /** 沙箱类型（不指定时自动选择最佳可用） */
  type?: SandboxType;
  /** 是否需要 Git Worktree 隔离 */
  needGitWorktree?: boolean;
  /** 超时（毫秒） */
  timeoutMs?: number;
  /** 输出上限（字节） */
  maxOutputBytes?: number;
}

/** 沙箱实例 */
export interface Sandbox {
  /** 沙箱唯一 ID */
  id: string;
  /** 沙箱类型 */
  type: SandboxType;
  /** 沙箱工作目录（绝对路径） */
  workDir: string;
  /** 原始工作区根目录（Git 仓库根，临时目录沙箱时等于 workDir） */
  workspaceRoot: string;
  /** 是否已销毁 */
  destroyed: boolean;
}

/** 沙箱内命令执行结果 */
export interface SandboxExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/** 沙箱执行规格 */
export interface SandboxExecSpec {
  program: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** 沙箱不可用错误 */
export const SANDBOX_UNAVAILABLE_ERROR = 'SANDBOX_UNAVAILABLE';
