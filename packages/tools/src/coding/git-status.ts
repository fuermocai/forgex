/**
 * git_status：只读查看仓库状态。
 *
 * 直接以 argv 形式调用 `git -C <dir> status --porcelain=v1 --branch`，
 * 不经过 shell，因此分支名/文件名中的特殊字符不会被解释执行。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';
import { runProcess } from '../execution/process-runner.js';
import { toWorkspaceRelative } from './fs-utils.js';

const inputSchema = z.object({
  path: z.string().min(1).default('.').describe('仓库内的相对路径，默认工作区根目录'),
});

type Input = z.infer<typeof inputSchema>;

interface StatusEntry {
  status: string;
  path: string;
  originalPath?: string;
}

export function createGitStatusTool(): ToolDefinition<Input> {
  return {
    name: 'git_status',
    description: '查看 Git 仓库的当前分支与工作区变更（只读）。返回分支、上游跟踪信息与文件状态列表。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    tags: ['coding', 'read', 'git'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const repoDir = await ctx.workspace.resolve(input.path, 'read', ctx.cwd);
        const result = await runProcess({
          program: 'git',
          args: ['-C', repoDir, 'status', '--porcelain=v1', '--branch', '--untracked-files=normal'],
          cwd: ctx.workspaceRoot,
          signal: ctx.signal,
          timeoutMs: 15_000,
          maxOutputBytes: 512 * 1024,
        });

        if (result.timedOut) return toolError('TOOL_TIMEOUT', 'git status 执行超时', { retryable: true });
        if (result.code !== 0) {
          return toolError('TOOL_FAILED', `不是 Git 仓库或 git 执行失败: ${result.stderr.trim().slice(0, 500)}`);
        }

        const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
        let branch = 'unknown';
        let upstream: string | null = null;
        const entries: StatusEntry[] = [];
        let truncated = false;

        for (const line of lines) {
          if (line.startsWith('## ')) {
            const header = line.slice(3);
            const [branchPart, ...rest] = header.split(' ');
            branch = branchPart ?? 'unknown';
            upstream = rest.length > 0 ? rest.join(' ') : null;
            continue;
          }
          if (entries.length >= 500) {
            truncated = true;
            break;
          }
          const status = line.slice(0, 2).trim();
          const rawPath = line.slice(3);
          if (rawPath.includes(' -> ')) {
            const [from, to] = rawPath.split(' -> ');
            entries.push({ status, path: to ?? rawPath, ...(from ? { originalPath: from } : {}) });
          } else {
            entries.push({ status, path: rawPath });
          }
        }

        return toolOk(
          entries.length === 0
            ? `分支 ${branch} 工作区干净`
            : `分支 ${branch} 有 ${entries.length} 项变更${truncated ? '（已截断）' : ''}`,
          {
            path: toWorkspaceRelative(ctx.workspaceRoot, repoDir),
            branch,
            upstream,
            clean: entries.length === 0,
            entries,
          },
          truncated,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
