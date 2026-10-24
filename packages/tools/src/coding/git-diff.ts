/**
 * git_diff：只读查看变更差异。
 *
 * 支持：工作区 vs 暂存区、暂存区 vs HEAD（staged）、与指定 base 比较。
 * 输出按行数截断，避免超大 diff 撑爆上下文。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';
import { runProcess } from '../execution/process-runner.js';
import { toWorkspaceRelative } from './fs-utils.js';

const inputSchema = z.object({
  path: z.string().optional().describe('限定文件或目录（相对工作区），默认整个仓库'),
  staged: z.boolean().default(false).describe('查看已暂存（--cached）的变更'),
  base: z.string().optional().describe('对比基线，例如 HEAD~1、main、某个 commit sha'),
  maxLines: z.number().int().min(10).max(3000).default(500).describe('最多返回的行数，默认 500'),
});

type Input = z.infer<typeof inputSchema>;

export function createGitDiffTool(): ToolDefinition<Input> {
  return {
    name: 'git_diff',
    description:
      '查看 Git 变更 diff（只读）。可用于审查修改、确认暂存内容或与历史基线对比。' +
      '默认对比工作区与暂存区，文件名与内容均不会被执行。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 20_000,
    maxOutputBytes: 220 * 1024,
    tags: ['coding', 'read', 'git'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const target = input.path ? await ctx.workspace.resolve(input.path, 'read', ctx.cwd) : ctx.workspaceRoot;
        const args = ['-C', ctx.workspaceRoot, 'diff', '--no-color', '--no-ext-diff'];
        if (input.staged) args.push('--cached');
        if (input.base) args.push(input.base);
        if (input.path) args.push('--', target);

        const result = await runProcess({
          program: 'git',
          args,
          cwd: ctx.workspaceRoot,
          signal: ctx.signal,
          timeoutMs: 15_000,
          maxOutputBytes: 1024 * 1024,
        });

        if (result.timedOut) return toolError('TOOL_TIMEOUT', 'git diff 执行超时', { retryable: true });
        if (result.code !== 0) {
          return toolError('TOOL_FAILED', `git diff 执行失败: ${result.stderr.trim().slice(0, 500)}`);
        }
        if (result.stdout.trim().length === 0) {
          return toolOk('指定范围内没有差异', {
            path: input.path ? toWorkspaceRelative(ctx.workspaceRoot, target) : null,
            diff: '',
            lines: 0,
            hasChanges: false,
          });
        }

        const allLines = result.stdout.split(/\r?\n/);
        const truncatedByLines = allLines.length > input.maxLines;
        const outputLines = truncatedByLines ? allLines.slice(0, input.maxLines) : allLines;
        const diff = outputLines.join('\n');

        return toolOk(
          `diff 共 ${allLines.length} 行${truncatedByLines || result.truncated ? '（已截断）' : ''}`,
          {
            path: input.path ? toWorkspaceRelative(ctx.workspaceRoot, target) : null,
            staged: input.staged,
            base: input.base ?? null,
            diff,
            lines: allLines.length,
            hasChanges: true,
          },
          truncatedByLines || result.truncated,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
