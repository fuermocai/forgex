/**
 * read_file：按行读取工作区内的文本文件。
 *
 * 设计取舍：
 *  - 必须提供 offset/limit 才能精确读大文件；默认最多 400 行、128KB；
 *  - 返回行号范围与总行数，便于模型继续分段读取；
 *  - 路径解析强制经过 WorkspaceGuard（ctx.workspace），防止穿越。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolOk } from '../tool-result.js';
import { readFileLines, toWorkspaceRelative } from './fs-utils.js';

const inputSchema = z.object({
  path: z.string().min(1).describe('相对于工作区根目录的文件路径'),
  offset: z.number().int().min(1).optional().describe('起始行号（从 1 开始）'),
  limit: z.number().int().min(1).max(2000).optional().describe('最多读取的行数，默认 400'),
});

type Input = z.infer<typeof inputSchema>;

export function createReadFileTool(): ToolDefinition<Input> {
  return {
    name: 'read_file',
    description:
      '读取工作区内文本文件的内容。支持按行范围读取（offset/limit），大文件请分段读取。' +
      '返回内容带行号语义，但不修改文件。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 15_000,
    maxOutputBytes: 160 * 1024,
    tags: ['coding', 'read'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const absPath = await ctx.workspace.resolve(input.path, 'read', ctx.cwd);
        const limit = Math.min(input.limit ?? 400, 2000);
        const result = await readFileLines(absPath, {
          startLine: input.offset ?? 1,
          limit,
          maxBytes: 128 * 1024,
        });
        const rel = toWorkspaceRelative(ctx.workspaceRoot, absPath);
        const total = result.totalLines === null ? '未知' : String(result.totalLines);
        const summary =
          result.text.length === 0
            ? `文件 ${rel} 在指定范围内没有内容（共 ${total} 行）`
            : `读取 ${rel} 第 ${result.startLine}-${result.endLine} 行（共 ${total} 行）` +
              (result.truncated ? '，已达读取上限' : '');
        return toolOk(
          summary,
          {
            path: rel,
            startLine: result.startLine,
            endLine: result.endLine,
            totalLines: result.totalLines,
            content: result.text,
            sizeBytes: result.sizeBytes,
          },
          result.truncated,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
