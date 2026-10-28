/**
 * write_file：在工作区内创建文本文件；默认拒绝覆盖已有文件。
 */
import { open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';
import { atomicWriteText, readWholeText, toWorkspaceRelative } from './fs-utils.js';

const inputSchema = z.object({
  path: z.string().min(1).describe('相对于工作区的文件路径'),
  content: z.string().describe('要写入的完整文本内容'),
  overwrite: z.boolean().default(false).describe('是否允许覆盖已有文件，默认 false'),
});

type Input = z.infer<typeof inputSchema>;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;

export function createWriteFileTool(): ToolDefinition<Input> {
  return {
    name: 'write_file',
    description: '在工作区内创建文本文件。默认拒绝覆盖已有文件；只有明确设置 overwrite=true 才覆盖。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'write',
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024,
    tags: ['coding', 'write'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const requestedBytes = Buffer.byteLength(input.content, 'utf8');
        if (requestedBytes > MAX_WRITE_BYTES) {
          return toolError('TOOL_FAILED', `文件内容过大（${requestedBytes} 字节），超过写入上限 ${MAX_WRITE_BYTES} 字节`);
        }
        const absPath = await ctx.workspace.resolve(input.path, 'write', ctx.cwd);
        const rel = toWorkspaceRelative(ctx.workspaceRoot, absPath);
        const bytesWritten = input.overwrite
          ? await atomicWriteText(absPath, input.content)
          : await createWithoutOverwrite(absPath, input.content);
        const persisted = await readWholeText(absPath, MAX_WRITE_BYTES);
        return toolOk(`已写入 ${rel}（${bytesWritten} 字节）`, {
          path: rel,
          changed: true,
          contentHash: hashContent(persisted),
          bytesWritten,
        });
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
          return toolError('TOOL_FAILED', `文件已存在，拒绝覆盖: ${input.path}（如需替换，请设置 overwrite=true）`, {
            details: { path: input.path },
          });
        }
        return errorToOutcome(err);
      }
    },
  };
}

function hashContent(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

async function createWithoutOverwrite(absPath: string, content: string): Promise<number> {
  const handle = await open(absPath, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(absPath).catch(() => undefined);
    throw err;
  }
  await handle.close();
  return Buffer.byteLength(content, 'utf8');
}
