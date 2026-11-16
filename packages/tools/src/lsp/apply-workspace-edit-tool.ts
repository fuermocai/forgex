import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolOk } from '../tool-result.js';
import { WorkspaceEditPreviewStore } from './workspace-edit.js';

const inputSchema = z.object({ previewId: z.string().regex(/^[a-f0-9]{24}$/) });

type Input = z.infer<typeof inputSchema>;

/** Creates the write tool that applies an LSP preview after dispatcher approval. */
export function createApplyWorkspaceEditTool(store: WorkspaceEditPreviewStore): ToolDefinition<Input> {
  return {
    name: 'apply_workspace_edit',
    description: '将 lsp rename/code action 生成的 WorkspaceEdit 预览应用到工作区。审批卡片会显示每个文件的精确 diff。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'write',
    alwaysRequireApproval: true,
    requireCompleteApprovalPreview: true,
    maxApprovalPreviewChars: 64_000,
    getApprovalPaths(input: Input, ctx: ToolContext): readonly string[] {
      return store.approvalPaths(input.previewId, ctx.sessionId);
    },
    getApprovalPreview(input: Input, ctx: ToolContext): string {
      return store.approvalPreview(input.previewId, ctx.sessionId);
    },
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    tags: ['coding', 'write', 'lsp'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const result = await store.apply(input.previewId, ctx);
        return toolOk(result.changed ? `已应用 WorkspaceEdit：${result.files.length} 个文件` : 'WorkspaceEdit 没有内容变化', result);
      } catch (error) {
        return errorToOutcome(error);
      }
    },
  };
}
