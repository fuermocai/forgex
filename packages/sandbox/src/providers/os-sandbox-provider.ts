/**
 * OsSandboxProvider：OS 级沙箱提供者（v0.5.5 真实 bwrap 执行链）。
 *
 * 核心不变式（防止"能力报告"与"实际隔离效果"不一致）：
 *   1. `isAvailable()` 只有在**探针真的通过 bwrap 启动过程序**之后才可能返回 true；
 *      仅检测到 `bwrap` 二进制存在 → 不可用，并给出原因。
 *   2. 不可信代码执行**只能**走 `execUntrusted()`：它返回带
 *      `isolation: 'os_sandbox'` 溯源标记的结果，且实际被启动的 program 必须是 bwrap。
 *      调用方（SandboxManager）会校验该标记，任何"检查通过但实际裸跑"的路径都会抛错。
 *   3. 任何失败都 fail closed：bwrap 缺失、无权限创建命名空间、执行器缺失、
 *      启动报错、探针不通过 —— 一律抛 SANDBOX_UNAVAILABLE / SANDBOX_CREATE_FAILED，
 *      不降级到临时目录、Git worktree 或普通进程执行。
 *
 * 仅在 Linux 报告该能力可用。Windows / macOS 没有真实实现，明确拒绝。
 */
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveExecutorBinary } from '@forgex/tools';
import { ForgeError } from '@forgex/shared';
import type { OsSandboxedExecResult, Sandbox, SandboxExecSpec, SandboxSpec } from '../types.js';
import type { SandboxProvider } from './sandbox-provider.js';
import {
  buildBubblewrapPlan,
  createExecutorRunner,
  probeBubblewrap,
  resolveBubblewrapPath,
  type BwrapLookup,
  type SandboxRunner,
} from './bubblewrap.js';

export interface OsSandboxProviderOptions {
  /** 目标平台（测试注入，默认 process.platform） */
  platform?: NodeJS.Platform;
  /** 环境变量（测试注入，默认 process.env） */
  env?: NodeJS.ProcessEnv;
  /** bwrap 路径解析（测试注入） */
  lookupBwrap?: () => BwrapLookup;
  /** 命令执行器（测试注入；默认 Rust executor） */
  runner?: SandboxRunner;
  /** Rust 执行器路径；未提供时按 workspaceRoot 自动解析 */
  executorBinary?: string | null;
  /** 工作区根（用于解析 .forgex/bin/forgex-executor） */
  workspaceRoot?: string;
  callerToken?: string;
  allowedCwdRoots?: readonly string[];
  /** 探针使用的已存在可写目录，默认 os.tmpdir() */
  probeWorkDir?: string;
  /** 探针目标程序，默认 /bin/true（或 /usr/bin/true）；测试可注入 */
  probeProgram?: string;
  /** 探针超时，默认 5s */
  probeTimeoutMs?: number;
}

export interface OsSandboxStatus {
  available: boolean;
  platform: NodeJS.Platform;
  mechanism: 'bubblewrap' | null;
  bwrapPath: string | null;
  /** available=false 时必非空 */
  reason: string;
  /** 是否通过真实执行探针验证 */
  verified: boolean;
  /** 探针耗时（毫秒） */
  probeDurationMs?: number;
  details: Record<string, string>;
}

/** `execUntrusted` 的入参 */
export interface OsSandboxExecOptions {
  /** 唯一可写目录（通常是沙箱 workDir） */
  workDir: string;
  allowNetwork?: boolean;
  extraRoBinds?: readonly string[];
  /** 单次执行超时（毫秒） */
  timeoutMs?: number;
  /** 输出上限（字节） */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export class OsSandboxProvider implements SandboxProvider {
  readonly type = 'os_sandbox' as const;

  private readonly platform: NodeJS.Platform;
  private readonly lookupBwrap: () => BwrapLookup;
  private readonly injectedRunner: SandboxRunner | null;
  private readonly workspaceRoot: string;
  private readonly executorBinary: string | null | undefined;
  private readonly callerToken?: string;
  private readonly allowedCwdRoots?: readonly string[];
  private readonly probeWorkDir: string;
  private readonly probeProgram: string | undefined;
  private readonly probeTimeoutMs: number;

  private statusPromise: Promise<OsSandboxStatus> | null = null;
  private cachedStatus: OsSandboxStatus | null = null;
  private runner: SandboxRunner | null = null;

  constructor(options: OsSandboxProviderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    this.lookupBwrap = options.lookupBwrap ?? (() => resolveBubblewrapPath(env, this.platform));
    this.injectedRunner = options.runner ?? null;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.executorBinary = options.executorBinary;
    this.callerToken = options.callerToken;
    this.allowedCwdRoots = options.allowedCwdRoots;
    this.probeWorkDir = options.probeWorkDir ?? tmpdir();
    this.probeProgram = options.probeProgram;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  }

  /** 当前状态（带缓存；`refresh=true` 时重新探测） */
  async status(options: { refresh?: boolean } = {}): Promise<OsSandboxStatus> {
    if (options.refresh) {
      this.statusPromise = null;
      this.cachedStatus = null;
    }
    if (this.cachedStatus) return this.cachedStatus;
    this.statusPromise ??= this.runProbe();
    this.cachedStatus = await this.statusPromise;
    return this.cachedStatus;
  }

  /**
   * OS 沙箱是否可用。
   * 返回 true 的前提：Linux + bwrap 可执行 + 探针真的通过 bwrap 启动过目标程序。
   */
  async isAvailable(): Promise<boolean> {
    return (await this.status()).available;
  }

  /**
   * 不可信执行的 gate（只做检查，不放行执行）。
   * 真正的执行必须走 `execUntrusted()`——它返回带溯源标记的结果。
   */
  async requestUntrustedExecution(): Promise<void> {
    const status = await this.status();
    if (!status.available) {
      throw new ForgeError('SANDBOX_UNAVAILABLE', status.reason, {
        details: { platform: this.platform, ...status.details },
      });
    }
  }

  /**
   * 通过 bwrap 执行不可信代码。
   *
   * 与 `requestUntrustedExecution()` 的区别：这个方法是**执行**入口，
   * 不存在"先检查再交给别的执行器"的窗口。
   */
  async execUntrusted(
    spec: SandboxExecSpec,
    options: OsSandboxExecOptions,
  ): Promise<OsSandboxedExecResult> {
    const status = await this.status();
    if (!status.available || !status.bwrapPath) {
      throw new ForgeError('SANDBOX_UNAVAILABLE', status.reason, {
        details: { platform: this.platform, ...status.details },
      });
    }

    const workDir = options.workDir;
    if (!existsSync(workDir) || !statSync(workDir).isDirectory()) {
      throw new ForgeError('SANDBOX_UNAVAILABLE', `OS 沙箱的可写目录不存在或不是目录: ${workDir}`, {
        details: { workDir },
      });
    }

    // 构建阶段就会校验：workDir 不能是文件系统根、cwd 必须落在 workDir 内
    const plan = buildBubblewrapPlan({
      bwrapPath: status.bwrapPath,
      program: spec.program,
      args: spec.args,
      workDir,
      cwd: spec.cwd ?? workDir,
      env: spec.env ?? {},
      allowNetwork: options.allowNetwork ?? false,
      extraRoBinds: options.extraRoBinds ?? [],
    });

    const runner = this.getRunner();
    const result = await runner.run(
      {
        program: plan.bwrapPath,
        args: plan.args,
        cwd: plan.cwd,
        // bwrap 自身不需要继承任何环境变量；目标程序的环境由 --setenv 注入
        env: {},
        timeoutMs: options.timeoutMs ?? 30_000,
        maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
        auditTag: 'sandbox-untrusted',
      },
      options.signal,
    );

    // 溯源校验 1：执行器必须真的启动了 bwrap，而不是目标程序本身
    if (result.program !== plan.bwrapPath) {
      throw new ForgeError(
        'SANDBOX_UNAVAILABLE',
        `执行链没有通过 bwrap 启动目标程序（实际 program=${result.program}），拒绝把这次执行视为已隔离`,
        { details: { expected: plan.bwrapPath, actual: result.program } },
      );
    }

    // 溯源校验 2：执行器启动 bwrap 失败（ENOENT / EACCES 等）
    if (result.spawnError) {
      throw new ForgeError(
        'SANDBOX_CREATE_FAILED',
        `bwrap 启动失败，拒绝在未隔离状态下执行: ${result.spawnError}`,
        { details: { bwrapPath: plan.bwrapPath } },
      );
    }

    // 溯源校验 3：bwrap 自身报错（命名空间 / 挂载 / execvp 失败）时不得当作普通失败
    const bwrapError = detectBwrapSetupError(result.stderr, result.code);
    if (bwrapError) {
      throw new ForgeError('SANDBOX_CREATE_FAILED', `bwrap 未能建立沙箱: ${bwrapError}`, {
        details: { bwrapPath: plan.bwrapPath, exitCode: String(result.code) },
      });
    }

    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs,
      isolation: 'os_sandbox',
      mechanism: 'bubblewrap',
      bwrapPath: plan.bwrapPath,
      program: result.program,
    };
  }

  /**
   * 创建 OS 沙箱实例。
   *
   * 工作目录由 SandboxManager 统一创建（workspaceRoot 内），这里只做能力校验后
   * 返回 `type: 'os_sandbox'` 的句柄——执行时一律走 `execUntrusted()`。
   */
  async create(spec: SandboxSpec): Promise<Sandbox> {
    const status = await this.status();
    if (!status.available) {
      throw new ForgeError('SANDBOX_UNAVAILABLE', status.reason, {
        details: { platform: this.platform, ...status.details },
      });
    }
    throw new ForgeError(
      'SANDBOX_CREATE_FAILED',
      'OS 沙箱的工作目录必须在 workspaceRoot 内创建，请通过 SandboxManager.createSandbox({ type: "os_sandbox" }) 使用',
      { details: { workspaceRoot: spec.workspaceRoot } },
    );
  }

  async destroy(_sandbox: Sandbox): Promise<void> {
    // 生命周期由 WorkspaceManager 负责；bwrap 进程随执行结束退出
  }

  /** 当前生效的 runner（便于测试与诊断） */
  getRunner(): SandboxRunner {
    if (this.injectedRunner) return this.injectedRunner;
    this.runner ??= createExecutorRunner({
      executorBinary:
        this.executorBinary === undefined
          ? resolveExecutorBinary(this.workspaceRoot)
          : this.executorBinary,
      ...(this.callerToken ? { callerToken: this.callerToken } : {}),
      ...(this.allowedCwdRoots ? { allowedCwdRoots: this.allowedCwdRoots } : {}),
    });
    return this.runner;
  }

  private async runProbe(): Promise<OsSandboxStatus> {
    const details: Record<string, string> = { platform: this.platform };

    if (this.platform !== 'linux') {
      const reason =
        `OS 级沙箱未实现：当前平台 ${this.platform} 没有真实隔离实现（只有 Linux bubblewrap 可用）。` +
        '不可信代码执行被拒绝，不自动降级到临时目录 / worktree / 普通进程。';
      return {
        available: false,
        platform: this.platform,
        mechanism: null,
        bwrapPath: null,
        reason,
        verified: false,
        details: { ...details, untrusted: 'denied' },
      };
    }

    const lookup = this.lookupBwrap();
    details.bwrapPath = lookup.path ?? '(未找到)';
    if (!lookup.found || !lookup.path) {
      return {
        available: false,
        platform: this.platform,
        mechanism: null,
        bwrapPath: null,
        reason: `OS 级沙箱不可用：${lookup.reason}。不可信代码执行被拒绝，不自动降级。`,
        verified: false,
        details: { ...details, untrusted: 'denied' },
      };
    }

    const probe = await probeBubblewrap({
      runner: this.getRunner(),
      lookup,
      probeWorkDir: this.probeWorkDir,
      ...(this.probeProgram ? { probeProgram: this.probeProgram } : {}),
      timeoutMs: this.probeTimeoutMs,
    });

    details.execution_integrated = probe.verified ? 'true' : 'false';
    if (!probe.verified) {
      return {
        available: false,
        platform: this.platform,
        mechanism: null,
        bwrapPath: lookup.path,
        reason: `OS 级沙箱不可用：${probe.reason}。检测到 bwrap 二进制不等于具备隔离能力，不可信代码执行被拒绝。`,
        verified: false,
        ...(probe.durationMs !== undefined ? { probeDurationMs: probe.durationMs } : {}),
        details: { ...details, untrusted: 'denied' },
      };
    }

    return {
      available: true,
      platform: this.platform,
      mechanism: 'bubblewrap',
      bwrapPath: probe.bwrapPath ?? lookup.path,
      reason: '',
      verified: true,
      ...(probe.durationMs !== undefined ? { probeDurationMs: probe.durationMs } : {}),
      details: {
        ...details,
        bubblewrap_binary_present: 'true',
        probe_program: probe.probeProgram ?? '',
        network: 'disabled',
        untrusted: 'allowed',
      },
    };
  }
}

/**
 * 识别 bwrap 自身的失败信息。
 *
 * bwrap 会把 setup 错误写成 `bwrap: ...`，例如：
 *   `bwrap: No permissions to creating new namespace`
 *   `bwrap: Creating new namespace failed: Operation not permitted`
 *   `bwrap: execvp /bin/foo: No such file or directory`
 * 这些说明隔离根本没建立，不能当成"命令执行失败"返回给调用方。
 */
export function detectBwrapSetupError(stderr: string, code: number | null): string | null {
  if (code === 0) return null;
  const line = stderr
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('bwrap:'));
  return line ? line.slice(0, 500) : null;
}
