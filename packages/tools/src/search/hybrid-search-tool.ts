/**
 * hybrid_search 工具（v0.3.0 Phase 3）。
 *
 * 三层混合检索（关键词 + 结构符号 + TF-IDF 语义），RRF 融合排序。
 * 与 grep_search 的关系：
 *   - grep_search：字面正则，用户已知道精确模式时用；
 *   - hybrid_search：自然语言/符号名/模糊意图，用户不确定精确写法时用。
 *
 * 全离线、只读，路径经 WorkspaceGuard 校验。
 */
import { relative, sep } from 'node:path';
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolOk } from '../tool-result.js';
import { hybridSearch } from './hybrid-search.js';

const inputSchema = z.object({
  query: z.string().min(1).describe('自然语言或符号名查询，例如 "用户登录校验" 或 loginUser'),
  path: z.string().min(1).default('.').describe('搜索路径（文件或目录），默认工作区根目录'),
  glob: z.string().optional().describe('文件名过滤 glob，例如 *.ts 或 **/*.py'),
  layers: z
    .array(z.enum(['keyword', 'structure', 'semantic']))
    .optional()
    .describe('启用哪些检索层（默认全开），可用于消融调试'),
  maxPerLayer: z.number().int().min(1).max(100).default(20).describe('每层最多返回多少条，默认 20'),
  maxResults: z.number().int().min(1).max(100).default(30).describe('融合后最多返回多少条，默认 30'),
  caseSensitive: z.boolean().default(false).describe('关键词层是否区分大小写'),
});

type Input = z.infer<typeof inputSchema>;

export function createHybridSearchTool(): ToolDefinition<Input> {
  return {
    name: 'hybrid_search',
    description:
      '混合检索：关键词 + 结构符号 + 语义三层搜索代码，RRF 融合排序。' +
      '适合用自然语言或符号名定位实现，不确定精确写法时优先于 grep_search 使用。' +
      '返回文件路径、行号、命中片段、融合得分与各层贡献。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 30_000,
    maxOutputBytes: 200 * 1024,
    tags: ['coding', 'read', 'search'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const absPath = await ctx.workspace.resolve(input.path, 'read', ctx.cwd);
        const result = await hybridSearch({
          query: input.query,
          root: absPath,
          ...(input.glob ? { glob: input.glob } : {}),
          ...(input.layers ? { layers: input.layers } : {}),
          maxPerLayer: input.maxPerLayer,
          maxResults: input.maxResults,
          caseSensitive: input.caseSensitive,
          signal: ctx.signal,
        });

        const rootRel = relative(ctx.workspaceRoot, absPath).split(sep).join('/') || '.';
        return toolOk(
          result.hits.length === 0
            ? `混合检索未找到与 "${input.query}" 相关的内容`
            : `混合检索找到 ${result.hits.length} 条与 "${input.query}" 相关的结果（扫描 ${result.scannedFiles} 个文件）`,
          {
            query: input.query,
            path: rootRel,
            scannedFiles: result.scannedFiles,
            layerStats: result.layerStats,
            hits: result.hits.map((h) => ({
              path: h.path,
              line: h.line,
              snippet: h.snippet,
              fusedScore: Number(h.fusedScore.toFixed(6)),
              layers: h.contributions.map((c) => c.layer),
              ...(h.symbol ? { symbol: h.symbol, symbolKind: h.symbolKind } : {}),
            })),
          },
          result.truncated,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
