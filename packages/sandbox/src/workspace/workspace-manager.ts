/**
 * WorkspaceManager：工作区管理器（v0.4.0 Phase 2，v0.5.5 消除静默降级）。
 *
 * 职责：
 *   - 创建隔离工作区（临时目录 / Git worktree / OS 沙箱的工作目录）；
 *   - 获取工作区路径；
 *   - 清理工作区。
 *
 * 安全约束：
 *   - 所有路径通过 WorkspaceGuard 校验；
 *   - Git Worktree 只做**代码隔离**，不替代 OS 级沙箱；
 *   - 显式请求 `type: 'git_worktree'` 但 Git 不可用时**报错**，除非调用方显式
 *     `allowWorkspaceFallback: true`；不再默认静默换成临时目录；
 *   - 显式请求 `type: 'os_sandbox'` 但 OS 沙箱不可用时直接拒绝（fail closed）。
 */
import { ForgeError } from '@forgex/shared';
import type { WorkspaceGuard } from '@forgex/security';
import type { Sandbox, SandboxSpec, SandboxType } from '../types.js';
import { GitWorktreeProvider } from '../providers/git-worktree-provider.js';
import { TempDirProvider } from '../providers/temp-dir-provider.js';
import type { OsSandboxProvider } from '../providers/os-sandbox-provider.js';

const KNOWN_TYPES: readonly SandboxType[] = ['temp_dir', 'git_worktree', 'os_sandbox'];

export interface WorkspaceManagerOptions {
  /** OS 沙箱 provider（用于校验 os_sandbox 类型是否真的可用） */
  osSandboxProvider?: OsSandboxProvider;
}

export class WorkspaceManager {
  private readonly gitWorktreeProvider: GitWorktreeProvider;
  private readonly tempDirProvider: TempDirProvider;
  private readonly osSandboxProvider: OsSandboxProvider | undefined;

  constructor(workspaceGuard: WorkspaceGuard, options: WorkspaceManagerOptions = {}) {
    this.gitWorktreeProvider = new GitWorktreeProvider(workspaceGuard);
    this.tempDirProvider = new TempDirProvider();
    this.osSandboxProvider = options.osSandboxProvider;
  }

  /**
   * 创建隔离工作区。
   * - `os_sandbox`：要求 OS 沙箱能力已验证，工作目录仍是 workspaceRoot 内的临时目录；
   * - `git_worktree`：要求 Git 可用（或显式允许回退）；
   * - `temp_dir` / 未指定：临时目录；`needGitWorktree` 时优先 worktree。
   */
  async createWorkspace(spec: SandboxSpec): Promise<Sandbox> {
    const type = spec.type;
    if (type !== undefined && !KNOWN_TYPES.includes(type)) {
      throw new ForgeError(
        'SANDBOX_CREATE_FAILED',
        `未知的沙箱类型: ${String(type)}（可选：${KNOWN_TYPES.join(' / ')}）`,
        { details: { type: String(type) } },
      );
    }

    if (type === 'os_sandbox') {
      if (!this.osSandboxProvider) {
        throw new ForgeError(
          'SANDBOX_UNAVAILABLE',
          '未配置 OS 沙箱 provider，拒绝以 os_sandbox 类型创建沙箱',
        );
      }
      const status = await this.osSandboxProvider.status();
      if (!status.available) {
        throw new ForgeError('SANDBOX_UNAVAILABLE', status.reason, {
          details: { type: 'os_sandbox', ...status.details },
        });
      }
      // 工作目录是 workspaceRoot 内的可写区；隔离来自 bwrap，而不是这个目录
      const workspace = await this.tempDirProvider.create(spec);
      return { ...workspace, type: 'os_sandbox' };
    }

    if (type === 'git_worktree') {
      const gitAvailable = await this.gitWorktreeProvider.isAvailable();
      if (gitAvailable) return this.gitWorktreeProvider.create(spec);
      if (spec.allowWorkspaceFallback === true) {
        return this.tempDirProvider.create(spec);
      }
      throw new ForgeError(
        'SANDBOX_UNAVAILABLE',
        '请求了 git_worktree 工作区隔离，但当前环境没有可用的 Git；'
          + '如需退回临时目录请显式传 allowWorkspaceFallback: true（临时目录不提供 worktree 级别的代码隔离）',
        { details: { type: 'git_worktree', allowWorkspaceFallback: false } },
      );
    }

    if (spec.needGitWorktree) {
      const gitAvailable = await this.gitWorktreeProvider.isAvailable();
      if (gitAvailable) return this.gitWorktreeProvider.create(spec);
      // needGitWorktree 只是"优先"，回退临时目录是既定行为
    }

    return this.tempDirProvider.create(spec);
  }

  /** 清理工作区 */
  async destroyWorkspace(sandbox: Sandbox): Promise<void> {
    if (sandbox.type === 'git_worktree') {
      await this.gitWorktreeProvider.destroy(sandbox);
      return;
    }
    // temp_dir / os_sandbox 的工作目录都是临时目录，清理方式相同
    await this.tempDirProvider.destroy(sandbox);
  }

  /** 获取 GitWorktreeProvider（供外部检查可用性） */
  getGitWorktreeProvider(): GitWorktreeProvider {
    return this.gitWorktreeProvider;
  }

  /** 获取 TempDirProvider */
  getTempDirProvider(): TempDirProvider {
    return this.tempDirProvider;
  }
}
