/**
 * SandboxManager：沙箱管理器（v0.4.0 Phase 2）。
 *
 * 统一入口，负责：
 *   - 检测沙箱能力；
 *   - 选择合适的 Provider；
 *   - 创建/销毁沙箱；
 *   - 执行命令；
 *   - 不可信代码执行在沙箱不可用时拒绝。
 *
 * 安全约束：
 *   - 沙箱不可用时拒绝不可信代码执行，禁止自动降级；
 *   - 不自动关闭 AppArmor 或其他系统安全机制；
 *   - Git Worktree 只做代码隔离，不替代 OS 级沙箱。
 */
import { ForgeError } from '@forgex/shared';
import type { WorkspaceGuard } from '@forgex/security';
import type {
  Sandbox,
  SandboxCapabilityReport,
  SandboxExecResult,
  SandboxExecSpec,
  SandboxSpec,
  SandboxType,
} from '../types.js';
import { detectCapabilities } from './capability-detector.js';
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
}

/** 不可信代码执行的风险等级 */
export type ExecutionTrustLevel = 'trusted' | 'untrusted';

export class SandboxManager {
  private readonly workspaceRoot: string;
  private readonly workspaceManager: WorkspaceManager;
  private readonly resourceLimiter: ResourceLimiter;
  private readonly lifecycle: SandboxLifecycle;
  private readonly osSandboxProvider: OsSandboxProvider;
  private capabilityReport: SandboxCapabilityReport | null = null;

  constructor(options: SandboxManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.workspaceManager = new WorkspaceManager(options.workspaceGuard);
    this.resourceLimiter = new ResourceLimiter(options.workspaceRoot, {
      executorBinary: options.executorBinary,
      callerToken: options.callerToken,
    });
    this.lifecycle = new SandboxLifecycle({
      workspaceManager: this.workspaceManager,
      resourceLimiter: this.resourceLimiter,
    });
    this.osSandboxProvider = new OsSandboxProvider();
  }

  /** 检测沙箱能力（缓存结果） */
  async detectCapabilities(): Promise<SandboxCapabilityReport> {
    if (!this.capabilityReport) {
      this.capabilityReport = await detectCapabilities(this.workspaceRoot);
    }
    return this.capabilityReport;
  }

  /**
   * 创建沙箱。
   * 根据 spec.type 或自动选择最佳可用 Provider。
   */
  async createSandbox(spec: SandboxSpec): Promise<Sandbox> {
    const effectiveSpec: SandboxSpec = {
      ...spec,
      workspaceRoot: this.workspaceRoot,
    };
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
   * @param trustLevel 可信级别——untrusted 需要 OS 级沙箱
   * @param signal 取消信号
   */
  async execInSandbox(
    sandbox: Sandbox,
    execSpec: SandboxExecSpec,
    trustLevel: ExecutionTrustLevel = 'trusted',
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    // 不可信代码需要 OS 级沙箱
    if (trustLevel === 'untrusted') {
      await this.ensureUntrustedExecutionAllowed();
    }

    return this.resourceLimiter.exec(
      {
        ...execSpec,
        cwd: execSpec.cwd ?? sandbox.workDir,
      },
      signal,
    );
  }

  /**
   * 一站式：创建沙箱 → 执行命令 → 销毁沙箱。
   */
  async runInSandbox(
    spec: SandboxSpec,
    execSpec: SandboxExecSpec,
    trustLevel: ExecutionTrustLevel = 'trusted',
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    if (trustLevel === 'untrusted') {
      await this.ensureUntrustedExecutionAllowed();
    }

    const sandbox = await this.createSandbox(spec);
    try {
      return await this.resourceLimiter.exec(
        {
          ...execSpec,
          cwd: execSpec.cwd ?? sandbox.workDir,
        },
        signal,
      );
    } finally {
      await this.destroySandbox(sandbox);
    }
  }

  /**
   * 确保不可信代码执行被允许。
   * OS 级沙箱不可用时拒绝，禁止自动降级。
   */
  private async ensureUntrustedExecutionAllowed(): Promise<void> {
    const osAvailable = await this.osSandboxProvider.isAvailable();
    if (!osAvailable) {
      const report = await this.detectCapabilities();
      throw new ForgeError(
        'SANDBOX_UNAVAILABLE',
        `不可信代码执行被拒绝：OS 级沙箱不可用。${report.osSandbox.reason}`,
        { details: { capabilities: report } },
      );
    }
  }

  /** 获取 ResourceLimiter（供高级用法） */
  getResourceLimiter(): ResourceLimiter {
    return this.resourceLimiter;
  }
}
