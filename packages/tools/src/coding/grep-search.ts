/**
 * grep_search：代码搜索，优先使用 ripgrep。
 *
 * 为什么用 `rg --json`：
 *  - 文本输出在 Windows 路径（`C:\a\b:12:...`）下难以可靠解析；
 *  - JSON 事件包含路径、行号、行内容，解析确定且不会被文件名里的冒号干扰。
 *
 * 若系统未安装 rg，则降级为纯 Node 实现，并在结果中标注 engine=fallback。
 */
import { relative, sep } from 'node:path';
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { ForgeError } from '@forgex/shared';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';
import { runProcess } from '../execution/process-runner.js';
import { fallbackGrep, type GrepMatch } from './grep-fallback.js';

const inputSchema = z.object({
  pattern: z.string().min(1).describe('正则表达式（ripgrep 语法）'),
  path: z.string().min(1).default('.').describe('搜索路径（文件或目录），默认工作区根目录'),
  glob: z.string().optional().describe('文件名过滤 glob，例如 *.ts 或 **/*.ts'),
  caseSensitive: z.boolean().default(false).describe('是否区分大小写'),
  maxResults: z.number().int().min(1).max(500).default(100).describe('最多返回匹配数，默认 100'),
});

type Input = z.infer<typeof inputSchema>;

interface RgJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

export function createGrepSearchTool(): ToolDefinition<Input> {
  return {
    name: 'grep_search',
    description:
      '在工作区内按正则搜索代码（优先使用 ripgrep，遵循 .gitignore）。' +
      '返回文件相对路径、行号与整行内容，适合定位实现、配置与调用点。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 20_000,
    maxOutputBytes: 200 * 1024,
    tags: ['coding', 'read', 'search'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const absPath = await ctx.workspace.resolve(input.path, 'read', ctx.cwd);
        const args = [
          '--json',
          '--no-config',
          '--max-count',
          '200',
          '--max-filesize',
          '1M',
          '--max-columns',
          '500',
          '--max-columns-preview',
          ...(input.caseSensitive ? [] : ['-i']),
          ...(input.glob ? ['--glob', input.glob] : []),
          '--',
          input.pattern,
          absPath,
        ];

        let rgResult;
        try {
          rgResult = await runProcess({
            program: 'rg',
            args,
            cwd: ctx.workspaceRoot,
            signal: ctx.signal,
            timeoutMs: 15_000,
            maxOutputBytes: 2 * 1024 * 1024,
          });
        } catch (err) {
          if (err instanceof ForgeError && (err.details as { code?: string } | undefined)?.code === 'ENOENT') {
            return await runFallback(input, ctx, absPath);
          }
          throw err;
        }

        if (rgResult.timedOut) {
          return toolError('TOOL_TIMEOUT', 'ripgrep 搜索超时', { retryable: true });
        }
        if (rgResult.code === 2) {
          return toolError('TOOL_INVALID_INPUT', `ripgrep 执行失败: ${rgResult.stderr.slice(0, 500)}`);
        }

        const matches: GrepMatch[] = [];
        let truncated = rgResult.truncated;
        for (const line of rgResult.stdout.split('\n')) {
          if (matches.length >= input.maxResults) {
            truncated = true;
            break;
          }
          if (line.trim().length === 0) continue;
          let event: RgJsonEvent;
          try {
            event = JSON.parse(line) as RgJsonEvent;
          } catch {
            continue;
          }
          if (event.type !== 'match' || !event.data) continue;
          const reported = event.data.path?.text;
          const lineNumber = event.data.line_number;
          if (!reported || typeof lineNumber !== 'number') continue;
          matches.push({
            path: relative(ctx.workspaceRoot, reported).split(sep).join('/'),
            line: lineNumber,
            text: (event.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 500),
          });
        }

        return toolOk(
          matches.length === 0
            ? `未找到匹配 ${input.pattern} 的内容`
            : `在 ${matches.length} 个位置找到匹配 ${input.pattern}${truncated ? '（已截断）' : ''}`,
          {
            engine: 'ripgrep',
            pattern: input.pattern,
            path: relative(ctx.workspaceRoot, absPath).split(sep).join('/') || '.',
            matches,
            matchCount: matches.length,
          },
          truncated,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}

/** 未安装 ripgrep 时的降级搜索 */
async function runFallback(input: Input, ctx: ToolContext, absPath: string): Promise<ToolOutcome<JsonValue>> {
  const result = await fallbackGrep({
    root: absPath,
    pattern: input.pattern,
    caseSensitive: input.caseSensitive,
    ...(input.glob ? { glob: input.glob } : {}),
    maxResults: input.maxResults,
    signal: ctx.signal,
  });
  return toolOk(
    result.matches.length === 0
      ? `未找到匹配 ${input.pattern} 的内容（降级搜索）`
      : `在 ${result.matches.length} 个位置找到匹配 ${input.pattern}（降级搜索，未使用 ripgrep）`,
    {
      engine: 'fallback',
      pattern: input.pattern,
      path: relative(ctx.workspaceRoot, absPath).split(sep).join('/') || '.',
      matches: result.matches,
      matchCount: result.matches.length,
      scannedFiles: result.scannedFiles,
    },
    result.truncated,
  );
}
