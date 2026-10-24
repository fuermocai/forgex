/**
 * list_directory：列出工作区目录结构。
 *
 * 安全与性能：
 *  - 不跟随符号链接（只标记），避免通过链接遍历到工作区外；
 *  - 深度与条目数双重上限，防止 node_modules 之类目录撑爆上下文；
 *  - 默认跳过隐藏文件，可通过 includeHidden 打开。
 */
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolOk } from '../tool-result.js';
import { toWorkspaceRelative } from './fs-utils.js';

const inputSchema = z.object({
  path: z.string().min(1).default('.').describe('目录路径，默认工作区根目录'),
  depth: z.number().int().min(1).max(3).default(1).describe('递归深度，默认 1'),
  includeHidden: z.boolean().default(false).describe('是否包含以 . 开头的隐藏项'),
  limit: z.number().int().min(1).max(1000).default(300).describe('最多返回条目数，默认 300'),
});

type Input = z.infer<typeof inputSchema>;

interface Entry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
}

export function createListDirectoryTool(): ToolDefinition<Input> {
  return {
    name: 'list_directory',
    description:
      '列出工作区内目录的文件与子目录（不跟随符号链接）。' +
      '返回相对路径、类型与文件大小，适合快速理解项目结构。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    tags: ['coding', 'read'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const absDir = await ctx.workspace.resolve(input.path, 'read', ctx.cwd);
        const entries: Entry[] = [];
        let truncated = false;

        const walk = async (dir: string, currentDepth: number): Promise<void> => {
          if (truncated) return;
          const items = await readdir(dir, { withFileTypes: true });
          items.sort((a, b) => {
            const aDir = a.isDirectory() ? 0 : 1;
            const bDir = b.isDirectory() ? 0 : 1;
            if (aDir !== bDir) return aDir - bDir;
            return a.name.localeCompare(b.name);
          });

          for (const item of items) {
            if (entries.length >= input.limit) {
              truncated = true;
              return;
            }
            if (!input.includeHidden && item.name.startsWith('.')) continue;

            const full = join(dir, item.name);
            const rel = toWorkspaceRelative(ctx.workspaceRoot, full);
            if (item.isSymbolicLink()) {
              entries.push({ path: `${rel}`, type: 'symlink' });
              continue;
            }
            if (item.isDirectory()) {
              entries.push({ path: `${rel}/`, type: 'directory' });
              if (currentDepth < input.depth) await walk(full, currentDepth + 1);
              continue;
            }
            if (item.isFile()) {
              const size = await lstat(full)
                .then((s) => s.size)
                .catch(() => undefined);
              entries.push({ path: rel, type: 'file', ...(size !== undefined ? { size } : {}) });
              continue;
            }
            entries.push({ path: rel, type: 'other' });
          }
        };

        await walk(absDir, 1);
        const relDir = toWorkspaceRelative(ctx.workspaceRoot, absDir);

        return toolOk(
          `目录 ${relDir} 共列出 ${entries.length} 项${truncated ? '（已截断）' : ''}`,
          { path: relDir, entries },
          truncated,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
