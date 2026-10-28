/**
 * Sandbox Manager 类型定义（v0.4.0 Phase 2，v0.5.5 能力一致性加固）。
 *
 * 设计原则：
 *   1. 所有字段可 JSON 序列化；
 *   2. **隔离类别必须显式声明**：工作区隔离（temp dir / git worktree）与
 *      OS 级隔离（bubblewrap）是两种完全不同的保证，不允许混为一谈；
 *   3. 能力报告必须同时给出 available + verified + reason，
 *      "检测到二进制" 永远不足以让 os_sandbox 变成 available；
 *   4. 沙箱不可用时拒绝不可信代码执行，禁止自动降级。
 */

/** 沙箱类型（工作区维度的选择） */
export type SandboxType = 'temp_dir' | 'git_worktree' | 'os_sandbox';

/**
 * 隔离类别——用来防止"把普通执行包装成 OS 沙箱"。
 *
 * - `workspace_isolation`：只隔离文件系统视图（新目录 / 独立 worktree）。
 *   进程仍是同一用户权限，网络、进程表、可执行文件路径全部照旧。
 * - `resource_limits`：超时、输出限额、进程树清理。防止失控，但不是隔离边界。
 * - `os_isolation`：内核级隔离（mount / pid / net / ipc / uts namespaces）。
 *   只有这一类可以支撑 `trustLevel: 'untrusted'`。
 */
export type IsolationCategory = 'workspace_isolation' | 'resource_limits' | 'os_isolation';

/** 执行结果的实际隔离级别 */
export type ExecutionIsolation = 'none' | 'os_sandbox';

/** 单项沙箱能力检测结果 */
export interface SandboxCapability {
  /** 能力类型 */
  type: SandboxType | 'rust_executor' | 'git' | 'temp_dir';
  /** 该能力实际提供的隔离类别（不是名字，是保证） */
  category: IsolationCategory;
  /** 是否可用 */
  available: boolean;
  /**
   * 是否经过真实执行验证。
   * `os_sandbox` 只有在探针确实通过 bwrap 启动过程序后才允许 available=true；
   * 仅检测到二进制存在时 verified=false 且 available=false。
   */
  verified: boolean;
  /** 不可用时的原因（可用时为空字符串；不可用时必须非空） */
  reason: string;
  /** 额外信息（如版本号、路径、机制名） */
  details?: Record<string, string>;
}

/** 整体沙箱能力检测报告 */
export interface SandboxCapabilityReport {
  /** Rust 资源限制执行器是否可用（提供超时/输出限额/进程树清理，非隔离） */
  rustExecutor: SandboxCapability;
  /** Git 是否可用（用于 worktree，工作区隔离） */
  git: SandboxCapability;
  /** 临时目录是否可写（工作区隔离） */
  tempDir: SandboxCapability;
  /** OS 级沙箱是否可用（bubblewrap，OS 隔离） */
  osSandbox: SandboxCapability;
  /** 是否至少有一种工作区隔离能力可用 */
  anyAvailable: boolean;
  /** 不可信代码执行是否被允许；`allowed=false` 时 reason 必须说明原因 */
  untrustedExecution: { allowed: boolean; reason: string };
}

/** 沙箱规格 */
export interface SandboxSpec {
  /** 授权工作区根目录 */
  workspaceRoot: string;
  /** 沙箱类型（不指定时自动选择最佳可用工作区） */
  type?: SandboxType;
  /** 是否需要 Git Worktree 隔离 */
  needGitWorktree?: boolean;
  /**
   * 工作区类型无法满足时是否允许回退到临时目录。
   * 默认 `false`：请求 git_worktree 但 git 不可用时直接报错，
   * 避免"看着像隔离、其实只是换了个目录"。
   */
  allowWorkspaceFallback?: boolean;
  /** 是否允许 OS 沙箱内的网络访问（默认 false，即 `--unshare-net`） */
  allowNetwork?: boolean;
  /** 额外只读挂载点（OS 沙箱用，绝对路径；不存在时忽略） */
  extraRoBinds?: readonly string[];
  /** 超时（毫秒） */
  timeoutMs?: number;
  /** 输出上限（字节） */
  maxOutputBytes?: number;
}

/** 沙箱实例 */
export interface Sandbox {
  /** 沙箱唯一 ID */
  id: string;
  /**
   * 沙箱类型。
   * - `temp_dir` / `git_worktree`：**工作区隔离**，进程不会被 OS 沙箱包裹；
   * - `os_sandbox`：执行链必须通过 bwrap 启动目标程序。
   */
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
  /**
   * 实际隔离级别。
   * `none` = 普通进程（只有工作区隔离 + 资源限制）；
   * `os_sandbox` = 目标程序经 OS 沙箱启动。
   */
  isolation?: ExecutionIsolation;
  /** OS 沙箱机制名（仅 isolation='os_sandbox' 时有值） */
  mechanism?: 'bubblewrap';
  /** 实际被启动的可执行文件（审计与溯源自证用） */
  program?: string;
  /** 执行器启动失败原因（例如 bwrap 不存在 / 无权限创建 namespace） */
  spawnError?: string;
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

/** 经 OS 沙箱执行后的结果（带溯源信息，调用方必须校验后才可使用） */
export interface OsSandboxedExecResult extends SandboxExecResult {
  isolation: 'os_sandbox';
  mechanism: 'bubblewrap';
  /** bwrap 绝对路径 */
  bwrapPath: string;
  /** 实际启动的程序（必须是 bwrap 本身） */
  program: string;
}

/** 沙箱不可用错误 */
export const SANDBOX_UNAVAILABLE_ERROR = 'SANDBOX_UNAVAILABLE';
