/**
 * GitService：本地 Git 操作封装（v0.4.0 Phase 4）。
 *
 * 支持：diff、status、branch、worktree、commit。
 *
 * 安全约束：
 *   - 禁止默认自动合并到受保护分支；
 *   - 禁止默认自动推送代码（不提供 push 方法）；
 *   - commit 生成必须经过人工确认（L2 审批）；
 *   - 不自动修改仓库权限或 CI 凭据。
 */
import { spawn } from 'node:child_process';
import { ForgeError } from '@forgex/shared';
import type {
  BranchInfo,
  CommitSpec,
  GitDiffResult,
  WorktreeInfo,
  ChangedFile,
  ChangeStatus,
} from '../types.js';

export class GitService {
  private readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  /** 获取 git status */
  async status(): Promise<ChangedFile[]> {
    const result = await this.runGit(['status', '--porcelain']);
    if (result.code !== 0) {
      throw new ForgeError('TOOL_FAILED', `git status 失败: ${result.stderr}`);
    }
    return this.parsePorcelainStatus(result.stdout);
  }

  /** 获取 diff */
  async diff(): Promise<GitDiffResult> {
    const result = await this.runGit(['diff', '--stat', '--patch']);
    if (result.code !== 0) {
      throw new ForgeError('TOOL_FAILED', `git diff 失败: ${result.stderr}`);
    }
    return this.parseDiffOutput(result.stdout);
  }

  /** 列出分支 */
  async listBranches(): Promise<BranchInfo[]> {
    const result = await this.runGit(['branch', '--list', '--verbose']);
    if (result.code !== 0) {
      throw new ForgeError('TOOL_FAILED', `git branch 失败: ${result.stderr}`);
    }
    return this.parseBranchOutput(result.stdout);
  }

  /** 创建分支 */
  async createBranch(name: string, base?: string): Promise<void> {
    const args = base ? ['branch', name, base] : ['branch', name];
    const result = await this.runGit(args);
    if (result.code !== 0) {
      throw new ForgeError('TOOL_FAILED', `创建分支失败: ${result.stderr}`);
    }
  }

  /** 列出 worktree */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const result = await this.runGit(['worktree', 'list', '--porcelain']);
    if (result.code !== 0) {
      throw new ForgeError('TOOL_FAILED', `git worktree list 失败: ${result.stderr}`);
    }
    return this.parseWorktreeOutput(result.stdout);
  }

  /** 添加 worktree */
  async addWorktree(path: string, branch: string): Promise<void> {
    const result = await this.runGit(['worktree', 'add', '-b', branch, path]);
    if (result.code !== 0) {
      throw new ForgeError('TOOL_FAILED', `git worktree add 失败: ${result.stderr}`);
    }
  }

  /** 移除 worktree */
  async removeWorktree(path: string): Promise<void> {
    const result = await this.runGit(['worktree', 'remove', '--force', path]);
    if (result.code !== 0) {
      throw new ForgeError('TOOL_FAILED', `git worktree remove 失败: ${result.stderr}`);
    }
  }

  /**
   * 创建 commit。
   * 注意：调用方必须确保已获得人工审批（L2）。
   * 此方法不执行 push。
   */
  async commit(spec: CommitSpec): Promise<string> {
    // 先 add 指定文件（或全部）
    if (spec.files && spec.files.length > 0) {
      for (const file of spec.files) {
        const addResult = await this.runGit(['add', file]);
        if (addResult.code !== 0) {
          throw new ForgeError('TOOL_FAILED', `git add 失败: ${addResult.stderr}`);
        }
      }
    } else {
      const addResult = await this.runGit(['add', '-A']);
      if (addResult.code !== 0) {
        throw new ForgeError('TOOL_FAILED', `git add -A 失败: ${addResult.stderr}`);
      }
    }

    const result = await this.runGit(['commit', '-m', spec.message]);
    if (result.code !== 0) {
      throw new ForgeError('TOOL_FAILED', `git commit 失败: ${result.stderr}`);
    }

    // 获取 commit hash
    const hashResult = await this.runGit(['rev-parse', 'HEAD']);
    return hashResult.stdout.trim();
  }

  /** 注意：不提供 push 方法——禁止默认自动推送 */

  /* ------------------------------------------------------------------ */
  /* 内部方法                                                             */
  /* ------------------------------------------------------------------ */

  private runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
      const child = spawn(gitName, args, {
        shell: false,
        windowsHide: true,
        cwd: this.repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('error', (err) => reject(err));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  private parsePorcelainStatus(output: string): ChangedFile[] {
    const files: ChangedFile[] = [];
    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      const statusCode = line.slice(0, 2);
      const path = line.slice(3).trim();
      const status = this.mapStatus(statusCode);
      if (status) {
        files.push({ path, status });
      }
    }
    return files;
  }

  private mapStatus(code: string): ChangeStatus | null {
    const x = code[0];
    const y = code[1];
    if (x === '?' || y === '?') return 'untracked';
    if (x === 'A' || y === 'A') return 'added';
    if (x === 'M' || y === 'M') return 'modified';
    if (x === 'D' || y === 'D') return 'deleted';
    if (x === 'R' || y === 'R') return 'renamed';
    return null;
  }

  private parseDiffOutput(output: string): GitDiffResult {
    const files: ChangedFile[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    // 解析 --stat 部分（简化）
    const statMatch = output.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (statMatch) {
      totalAdditions = parseInt(statMatch[2] ?? '0', 10);
      totalDeletions = parseInt(statMatch[3] ?? '0', 10);
    }

    // 解析 diff --git 行获取文件列表
    const diffFileRegex = /^diff --git a\/(.+?) b\/(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = diffFileRegex.exec(output)) !== null) {
      files.push({ path: match[2]!, status: 'modified' });
    }

    return {
      files,
      patch: output,
      totalAdditions,
      totalDeletions,
    };
  }

  private parseBranchOutput(output: string): BranchInfo[] {
    const branches: BranchInfo[] = [];
    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      const current = line.startsWith('*');
      const rest = current ? line.slice(1).trim() : line.trim();
      const parts = rest.split(/\s+/);
      const name = parts[0] ?? '';
      const commit = parts[1];
      branches.push({
        name,
        current,
        protected: false, // 由 RepositoryManager 判断
        commit,
      });
    }
    return branches;
  }

  private parseWorktreeOutput(output: string): WorktreeInfo[] {
    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current as WorktreeInfo);
        current = { path: line.slice(9).trim() };
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      } else if (line.startsWith('bare')) {
        current.isMain = true;
      }
    }
    if (current.path) worktrees.push(current as WorktreeInfo);
    return worktrees;
  }
}
