/**
 * edit_file：精确文本替换（类似 Claude Code 的 Edit 工具）。
 *
 * 为什么不用"整文件覆盖"：
 *  - 整文件覆盖容易让模型丢失未读内容，且 diff 噪声大；
 *  - 精确替换要求 oldText 唯一存在，可显著降低误改风险。
 *
 * 安全：
 *  - 路径经 WorkspaceGuard 的 write 模式解析（含受保护目录检查）；
 *  - 修改前生成 unified diff 并返回，供 UI 展示与审计留痕；
 *  - 原子写入，避免半截文件。
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { createUnifiedDiff } from '@forgex/shared';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';
import { atomicWriteText, readWholeText, toWorkspaceRelative } from './fs-utils.js';

const inputSchema = z.object({
  path: z.string().min(1).describe('相对于工作区的文件路径'),
  oldText: z.string().min(1).describe('要被替换的原文，必须与文件内容完全一致（含缩进）'),
  newText: z.string().describe('替换后的新文本；传空字符串表示删除该段'),
  replaceAll: z.boolean().default(false).describe('oldText 出现多次时是否全部替换，默认 false'),
});

type Input = z.infer<typeof inputSchema>;

const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export function createEditFileTool(): ToolDefinition<Input> {
  return {
    name: 'edit_file',
    description:
      '在工作区内对文本文件做精确替换。oldText 必须唯一匹配（除非 replaceAll=true），' +
      '执行后返回 unified diff。适合修复 Bug、调整配置与重命名。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    // 注意：具体是否允许写入由 PolicyEngine 判定，这里声明风险等级
    riskLevel: 'write',
    timeoutMs: 15_000,
    maxOutputBytes: 200 * 1024,
    tags: ['coding', 'write'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const absPath = await ctx.workspace.resolve(input.path, 'write', ctx.cwd);
        const original = await readWholeText(absPath, MAX_EDIT_BYTES);

        const adapted = adaptLineEndings(original, input.oldText, input.newText);
        const occurrences = countOccurrences(original, adapted.oldText);

        if (occurrences === 0) {
          return toolError(
            'TOOL_FAILED',
            'oldText 在文件中不存在。请先 read_file 确认原文（注意缩进、换行与空格），再重试。',
            { details: { path: input.path } },
          );
        }
        if (occurrences > 1 && !input.replaceAll) {
          return toolError(
            'TOOL_FAILED',
            `oldText 在文件中出现 ${occurrences} 次。请提供更长的上下文使其唯一，或设置 replaceAll=true。`,
            { details: { path: input.path, occurrences } },
          );
        }

        const updated = input.replaceAll
          ? original.split(adapted.oldText).join(adapted.newText)
          : original.replace(adapted.oldText, adapted.newText);

        if (updated === original) {
          const persisted = await readWholeText(absPath, MAX_EDIT_BYTES);
          return toolOk('新旧内容相同，未修改文件', {
            path: toWorkspaceRelative(ctx.workspaceRoot, absPath),
            changed: false,
            contentHash: hashContent(persisted),
            replacements: 0,
          });
        }

        const rel = toWorkspaceRelative(ctx.workspaceRoot, absPath);
        const diff = createUnifiedDiff(original, updated, rel);
        const bytesWritten = await atomicWriteText(absPath, updated);
        const persisted = await readWholeText(absPath, MAX_EDIT_BYTES);

        return toolOk(
          `已修改 ${rel}：+${diff.stat.added} -${diff.stat.removed} 行` +
            (input.replaceAll && occurrences > 1 ? `（${occurrences} 处）` : ''),
          {
            path: rel,
            changed: true,
            contentHash: hashContent(persisted),
            replacements: input.replaceAll ? occurrences : 1,
            added: diff.stat.added,
            removed: diff.stat.removed,
            diff: diff.patch,
            bytesWritten,
          },
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}

function hashContent(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

/** 统计不重叠出现次数 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

/**
 * 适配 CRLF 文件：模型给出的 oldText 通常使用 \n，
 * 若原文件为 CRLF 且直接匹配失败，则双方都转换为 CRLF 再尝试。
 */
function adaptLineEndings(
  original: string,
  oldText: string,
  newText: string,
): { oldText: string; newText: string } {
  if (countOccurrences(original, oldText) > 0 || !original.includes('\r\n')) {
    return { oldText, newText };
  }
  const oldCrlf = oldText.replace(/\r?\n/g, '\r\n');
  if (countOccurrences(original, oldCrlf) > 0) {
    return { oldText: oldCrlf, newText: newText.replace(/\r?\n/g, '\r\n') };
  }
  return { oldText, newText };
}
