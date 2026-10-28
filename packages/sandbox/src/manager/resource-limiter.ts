/**
 * ResourceLimiter：资源限制器（v0.4.0 Phase 2，v0.5.5 补齐参数透传）。
 *
 * 职责：
 *   - 对沙箱内命令施加超时（复用 Rust executor timeoutMs）；
 *   - 限制输出大小（maxOutputBytes）；
 *   - 超时后清理进程树（复用 Rust executor kill_tree）；
 *   - 传递 callerToken、allowedCwdRoots、auditTag 给 Rust executor。
 *
 * **这不是隔离**：进程仍是同一用户权限，网络、进程表、可执行文件路径全部照旧。
 * 它只保证"不会失控"，不保证"不能越界"。`isolation` 一律标注为 `none`。
 *
 * 安全约束：
 *   - 不经过 shell，直接传递 program + args；
 *   - 环境变量只注入白名单（调用方负责筛选）；
 *   - cwd 限制在 allowedCwdRoots 内（由 Rust executor 二次校验）。
 */
import { runViaExecutor, resolveExecutorBinary, type ExecutorSpec, type ExecutorResult } from '@forgex/tools';
import { ForgeError } from '@forgex/shared';
import type { SandboxExecSpec, SandboxExecResult } from '../types.js';

export interface ResourceLimiterOptions {
  /** Rust 执行器路径（可选，不传则自动检测） */
  executorBinary?: string;
  /** 调用方 token（用于 Rust executor 身份验证） */
  callerToken?: string;
  /** cwd 允许的根目录白名单（透传给 Rust executor） */
  allowedCwdRoots?: readonly string[];
  /** 默认超时（毫秒） */
  defaultTimeoutMs?: number;
  /** 默认输出上限（字节） */
  defaultMaxOutputBytes?: number;
}

export class ResourceLimiter {
  private readonly executorBinary: string | null;
  private readonly callerToken?: string;
  private readonly allowedCwdRoots?: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;

  constructor(workspaceRoot: string, options: ResourceLimiterOptions = {}) {
    this.executorBinary = options.executorBinary ?? resolveExecutorBinary(workspaceRoot);
    this.callerToken = options.callerToken;
    this.allowedCwdRoots = options.allowedCwdRoots;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? 256 * 1024;
  }

  /** Rust 执行器是否可用 */
  get executorAvailable(): boolean {
    return this.executorBinary !== null;
  }

  /**
   * 执行命令（trusted 路径）。
   * 使用 Rust executor 获得超时、进程树清理、环境隔离等能力；
   * 结果 `isolation` 恒为 `none`——它没有 OS 级隔离。
   */
  async exec(spec: SandboxExecSpec, signal?: AbortSignal): Promise<SandboxExecResult> {
    if (!this.executorBinary) {
      throw new ForgeError(
        'SANDBOX_UNAVAILABLE',
        'Rust 执行器不可用，无法在沙箱内执行命令。',
      );
    }

    const executorSpec: ExecutorSpec = {
      program: spec.program,
      args: spec.args,
      cwd: spec.cwd ?? process.cwd(),
      env: spec.env ?? {},
      timeoutMs: spec.timeoutMs ?? this.defaultTimeoutMs,
      maxOutputBytes: spec.maxOutputBytes ?? this.defaultMaxOutputBytes,
      ...(this.callerToken ? { callerToken: this.callerToken } : {}),
      ...(this.allowedCwdRoots ? { allowedCwdRoots: this.allowedCwdRoots } : {}),
      auditTag: 'sandbox-trusted',
    };

    const result = await runViaExecutor(this.executorBinary, executorSpec, signal);
    return this.normalizeResult(result, spec.program);
  }

  private normalizeResult(result: ExecutorResult, program: string): SandboxExecResult {
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs,
      isolation: 'none',
      program,
      ...(result.spawnError ? { spawnError: result.spawnError } : {}),
    };
  }
}
