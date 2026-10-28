/**
 * SandboxManager：沙箱管理器（v0.4.0 Phase 2，v0.5.5 执行链一致性加固）。
 *
 * 统一入口，负责：
 *   - 检测沙箱能力（与执行共用同一个 OsSandboxProvider 实例）；
 *   - 选择合适的 Provider / 工作区；
 *   - 创建/销毁沙箱；
 *   - 执行命令：trusted → 资源限制执行；untrusted → **必须**经 OS 沙箱。
 *
 * 安全约束：
 *   - `trustLevel: 'untrusted'` 与 `type: 'os_sandbox'` 一律走
 *     `OsSandboxProvider.execUntrusted()`，**永远不会**落到普通 ResourceLimiter；
 *   - OS 沙箱返回的结果必须带 `isolation: 'os_sandbox'` 且 `program === bwrapPath`，
 *     否则抛错——防止"检查通过、实际裸跑"；
 *   - 沙箱不可用时拒绝不可信代码执行，禁止自动降级到临时目录 / worktree / 普通进程；
 *   - 不自动关闭 AppArmor 或其他系统安全机制；
 *   - Git Worktree 只做代码隔离，不替代 OS 级沙箱。
 */
import { ForgeError } from '@forgex/shared';
import type { WorkspaceGuard } from '@forgex/security';
import type {
  OsSandboxedExecResult,
  Sandbox,
  SandboxCapabilityReport,
  SandboxExecResult,
  SandboxExecSpec,
  SandboxSpec,
} from '../types.js';
import { detectCapabilities, describeCapabilityReport } from './capability-detector.js';
import { ResourceLimiter } from './resource-limiter.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { SandboxLifecycle } from '../lifecycle/sandbox-lifecycle.js';
import { OsSandboxProvider } from '../providers/os-sandbox-provider.js';

export interface SandboxManagerOptions {
  /** 授权工作区根目录 */
  workspaceRoot: string;
  /** WorkspaceGuard 实例 */
  workspaceGuard: WorkspaceGuard;
  /** Rust 执行器路径 */
  executorBinary?: string;
  /** 调用方 token */
  callerToken?: string;
  /** 注入 OS 沙箱 provider（测试 / 自定义 bwrap 执行器） */
  osSandboxProvider?: OsSandboxProvider;
  /** OS 沙箱内是否允许联网（默认 false：`--unshare-net`） */
  allowSandboxNetwork?: boolean;
}

/** 不可信代码执行的风险等级 */
export type ExecutionTrustLevel = 'trusted' | 'untrusted';

export class SandboxManager {
  private readonly workspaceRoot: string;
  private readonly workspaceManager: WorkspaceManager;
  private readonly resourceLimiter: ResourceLimiter;
  private readonly lifecycle: SandboxLifecycle;
  private readonly osSandboxProvider: OsSandboxProvider;
  private readonly allowSandboxNetwork: boolean;
  private capabilityReport: SandboxCapabilityReport | null = null;

  constructor(options: SandboxManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.osSandboxProvider =
      options.osSandboxProvider ??
      new OsSandboxProvider({
        workspaceRoot: options.workspaceRoot,
        ...(options.executorBinary ? { executorBinary: options.executorBinary } : {}),
        ...(options.callerToken ? { callerToken: options.callerToken } : {}),
        allowedCwdRoots: [options.workspaceRoot],
      });
    this.allowSandboxNetwork = options.allowSandboxNetwork === true;

    this.workspaceManager = new WorkspaceManager(options.workspaceGuard, {
      osSandboxProvider: this.osSandboxProvider,
    });
    this.resourceLimiter = new ResourceLimiter(options.workspaceRoot, {
      executorBinary: options.executorBinary,
      callerToken: options.callerToken,
      allowedCwdRoots: [options.workspaceRoot],
    });
    this.lifecycle = new SandboxLifecycle({
      workspaceManager: this.workspaceManager,
    });
  }

  /** 检测沙箱能力（缓存结果；与执行共用同一 provider 实例） */
  async detectCapabilities(options: { refresh?: boolean } = {}): Promise<SandboxCapabilityReport> {
    if (options.refresh) {
      this.capabilityReport = null;
      await this.osSandboxProvider.status({ refresh: true });
    }
    if (!this.capabilityReport) {
      this.capabilityReport = await detectCapabilities(this.workspaceRoot, {
        osSandboxProvider: this.osSandboxProvider,
      });
    }
    return this.capabilityReport;
  }

  /** 能力说明文本：明确区分工作区隔离 / 资源限制 / OS 级隔离 */
  async describeCapabilities(): Promise<string[]> {
    return describeCapabilityReport(await this.detectCapabilities());
  }

  /**
   * 创建沙箱。
   * `spec.type` 会被严格校验：`os_sandbox` 要求 OS 沙箱能力已验证，
   * `git_worktree` 在 Git 不可用时不会被静默换成临时目录。
   */
  async createSandbox(spec: SandboxSpec): Promise<Sandbox> {
    const effectiveSpec: SandboxSpec = {
      ...spec,
      workspaceRoot: this.workspaceRoot,
    };
    // 先过类型与能力检查，避免创建出"名字叫 os_sandbox、其实只是临时目录"的对象
    if (effectiveSpec.type === 'os_sandbox') {
      await this.osSandboxProvider.requestUntrustedExecution();
    }
    return this.lifecycle.create(effectiveSpec);
  }

  /** 销毁沙箱 */
  async destroySandbox(sandbox: Sandbox): Promise<void> {
    await this.lifecycle.destroy(sandbox);
  }

  /**
   * 在沙箱中执行命令。
   *
   * @param sandbox 沙箱实例
   * @param execSpec 命令规格
   * @param trustLevel trusted → 资源限制执行；untrusted → 必须经 OS 沙箱
   * @param signal 取消信号
   */
  async execInSandbox(
    sandbox: Sandbox,
    execSpec: SandboxExecSpec,
    trustLevel: ExecutionTrustLevel = 'trusted',
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    return this.execute(sandbox, execSpec, trustLevel, signal);
  }

  /**
   * 一站式：创建沙箱 → 执行命令 → 销毁沙箱。
   * untrusted 时如果创建或执行失败，不会退回到普通进程执行。
   */
  async runInSandbox(
    spec: SandboxSpec,
    execSpec: SandboxExecSpec,
    trustLevel: ExecutionTrustLevel = 'trusted',
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    // 先确认不可信执行确实有 OS 沙箱可用，再创建任何资源
    if (trustLevel === 'untrusted' && spec.type !== 'os_sandbox') {
      await this.osSandboxProvider.requestUntrustedExecution();
    }

    const sandbox = await this.createSandbox(spec);
    try {
      return await this.execute(sandbox, execSpec, trustLevel, signal);
    } finally {
      await this.destroySandbox(sandbox);
    }
  }

  /**
   * 获取 ResourceLimiter（**仅限 trusted 执行的高级用法**）。
   *
   * 它只提供超时 / 输出限额 / 进程树清理，不是隔离边界。
   * 不可信代码必须走 `execInSandbox(..., 'untrusted')` 或 `runInSandbox(..., 'untrusted')`。
   */
  getResourceLimiter(): ResourceLimiter {
    return this.resourceLimiter;
  }

  /** 获取 OS 沙箱 provider（诊断用） */
  getOsSandboxProvider(): OsSandboxProvider {
    return this.osSandboxProvider;
  }

  /* ---------------- 内部执行路由 ---------------- */

  private async execute(
    sandbox: Sandbox,
    execSpec: SandboxExecSpec,
    trustLevel: ExecutionTrustLevel,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    // 需要 OS 隔离的两种情形：明确声明不可信，或沙箱本身声明为 os_sandbox
    const requireOsIsolation = trustLevel === 'untrusted' || sandbox.type === 'os_sandbox';

    if (!requireOsIsolation) {
      // trusted：只有工作区隔离 + 资源限制，结果显式标注 isolation='none'
      const result = await this.resourceLimiter.exec(
        {
          ...execSpec,
          cwd: execSpec.cwd ?? sandbox.workDir,
        },
        signal,
      );
      return { ...result, isolation: 'none', program: execSpec.program };
    }

    const outcome = await this.osSandboxProvider.execUntrusted(
      {
        ...execSpec,
        cwd: execSpec.cwd ?? sandbox.workDir,
      },
      {
        workDir: sandbox.workDir,
        allowNetwork: this.allowSandboxNetwork,
        signal,
      },
    );

    // 双保险：provider 必须返回带溯源标记的结果，且确实启动的是 bwrap
    assertOsIsolation(outcome, sandbox);
    return outcome;
  }
}

/**
 * 校验执行结果确实来自 OS 沙箱。
 *
 * 这是"能力检测"与"实际隔离"之间最后一道结构约束：
 * 任何把 untrusted 执行偷偷交给普通执行器的改动都会在这里抛错。
 */
function assertOsIsolation(outcome: OsSandboxedExecResult, sandbox: Sandbox): void {
  const problems: string[] = [];
  if (!outcome || outcome.isolation !== 'os_sandbox') {
    problems.push(`isolation=${String(outcome?.isolation)}`);
  }
  if (outcome?.mechanism !== 'bubblewrap') {
    problems.push(`mechanism=${String(outcome?.mechanism)}`);
  }
  if (!outcome?.bwrapPath || outcome.program !== outcome.bwrapPath) {
    problems.push(`program=${String(outcome?.program)} bwrapPath=${String(outcome?.bwrapPath)}`);
  }
  if (problems.length > 0) {
    throw new ForgeError(
      'SANDBOX_UNAVAILABLE',
      `执行结果未通过 OS 隔离校验（${problems.join('; ')}），拒绝把它当作不可信代码的沙箱执行结果`,
      { details: { sandboxId: sandbox.id, sandboxType: sandbox.type } },
    );
  }
}
