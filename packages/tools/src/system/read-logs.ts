/**
 * read_logs：读取授权范围内的日志尾部（只读）。
 *
 * 路径必须位于授权工作区根目录内（可由配置把 /var/log、日志目录加入 roots）。
 * 读取上限与行数上限双重限制，避免超大日志撑爆上下文。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { readLogTail } from '@forgex/devops';
import { errorToOutcome, toolOk } from '../tool-result.js';
import { toWorkspaceRelative } from '../coding/fs-utils.js';

const inputSchema = z.object({
  path: z.string().min(1).describe('日志文件路径（必须在授权工作区内）'),
  lines: z.number().int().min(1).max(2000).default(200).describe('读取最后多少行，默认 200'),
});

type Input = z.infer<typeof inputSchema>;

export function createReadLogsTool(): ToolDefinition<Input> {
  return {
    name: 'read_logs',
    description:
      '读取授权工作区内日志文件的末尾内容（只读）。默认最后 200 行，最多 2000 行。' +
      '返回内容会标明是否被截断，请勿据此推断未出现的内容。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 20_000,
    maxOutputBytes: 160 * 1024,
    tags: ['devops', 'read', 'logs'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const absPath = await ctx.workspace.resolve(input.path, 'read', ctx.cwd);
        const tail = await readLogTail(absPath, { lines: input.lines, maxBytes: 128 * 1024 });
        const rel = toWorkspaceRelative(ctx.workspaceRoot, absPath);

        return toolOk(
          tail.lines === 0
            ? `日志 ${rel} 为空`
            : `读取 ${rel} 最后 ${tail.lines} 行（文件大小 ${tail.sizeBytes} 字节${tail.truncated ? '，已截断' : ''}）`,
          {
            path: rel,
            content: tail.content,
            lines: tail.lines,
            sizeBytes: tail.sizeBytes,
          },
          tail.truncated,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
