/**
 * GitWorktreeProvider：Git Worktree 沙箱提供者（v0.4.0 Phase 2）。
 *
 * 使用 `git worktree add` 在授权工作区内创建隔离的工作树，
 * 任务结束后 `git worktree remove` + 删除分支。
 *
 * 安全约束：
 *   - worktree 路径必须在授权工作区内（通过 WorkspaceGuard 校验）；
 *   - Git Worktree 只做代码隔离，不替代 OS 级沙箱；
 *   - 执行命令仍须通过 SandboxManager（使用 Rust executor）。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { ForgeError } from '@forgex/shared';
import type { WorkspaceGuard } from '@forgex/security';
import type { Sandbox, SandboxSpec } from '../types.js';
import type { SandboxProvider } from './sandbox-provider.js';

export class GitWorktreeProvider implements SandboxProvider {
  readonly type = 'git_worktree' as const;
  private readonly workspaceGuard: WorkspaceGuard;

  constructor(workspaceGuard: WorkspaceGuard) {
    this.workspaceGuard = workspaceGuard;
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
      const child = spawn(gitName, ['--version'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    const branchName = `forgex-sandbox-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const worktreeName = `forgex-worktree-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const workDir = join(spec.workspaceRoot, worktreeName);

    // 校验 worktree 路径在授权工作区内
    await this.workspaceGuard.resolve(workDir, 'write');

    // git worktree add -b <branch> <path>
    const result = await this.runGit([
      'worktree',
      'add',
      '-b',
      branchName,
      workDir,
    ], spec.workspaceRoot);

    if (result.code !== 0) {
      throw new ForgeError(
        'TOOL_FAILED',
        `git worktree add 失败: ${result.stderr}`,
        { details: { branch: branchName, workDir } },
      );
    }

    return {
      id: `sandbox_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      type: 'git_worktree',
      workDir,
      workspaceRoot: spec.workspaceRoot,
      destroyed: false,
    };
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    if (sandbox.destroyed) return;

    try {
      // git worktree remove --force <path>
      await this.runGit(['worktree', 'remove', '--force', sandbox.workDir], sandbox.workspaceRoot);
    } catch {
      // worktree remove 失败，尝试手动删除目录
    }

    try {
      await rm(sandbox.workDir, { recursive: true, force: true });
    } catch {
      // 忽略删除失败
    }

    sandbox.destroyed = true;
  }

  /** 执行 git 命令 */
  private runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
      const child = spawn(gitName, args, {
        shell: false,
        windowsHide: true,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }
}
