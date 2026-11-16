import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';

export interface MemoryToolEntry {
  id: string;
  workspace: string;
  kind: 'fact' | 'hypothesis';
  source: 'user' | 'agent' | 'tool_run';
  scope: 'project' | 'session' | 'task';
  key: string;
  content: string;
  tags: string[];
  confidence: number;
  updated_at: string;
  evidence_refs: string[];
  superseded_by?: string;
}

export interface MemoryToolCandidate {
  id: string;
  session_id: string;
  status: 'pending' | 'approved' | 'rejected';
  input: {
    key: string;
    content: string;
    kind: 'fact' | 'hypothesis';
    source: 'user' | 'agent' | 'tool_run';
  };
}

export interface MemoryToolService {
  search(
    workspace: string,
    text: string,
    options?: { limit?: number; tags?: readonly string[]; kind?: 'fact' | 'hypothesis' },
  ): Array<{ entry: MemoryToolEntry; relevance: number; rankScore: number }>;
  propose(input: {
    kind: 'fact' | 'hypothesis';
    source: 'agent';
    scope: 'project';
    key: string;
    content: string;
    workspace: string;
    tags: string[];
    confidence?: number;
    evidence_refs: string[];
  }, sessionId: string): MemoryToolCandidate;
  update(id: string, input: {
    kind?: 'fact' | 'hypothesis';
    content?: string;
    tags?: string[];
    confidence?: number;
    evidence_refs?: string[];
  }): { entry: MemoryToolEntry; conflict: boolean };
  forget(id: string): boolean;
  get(id: string): MemoryToolEntry | null;
}

const searchSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  tags: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
  kind: z.enum(['fact', 'hypothesis']).optional(),
  limit: z.number().int().min(1).max(20).default(8),
});

const proposeSchema = z.object({
  kind: z.enum(['fact', 'hypothesis']).default('fact'),
  key: z.string().trim().min(1).max(128),
  content: z.string().trim().min(1).max(4096),
  tags: z.array(z.string().trim().min(1).max(64)).max(12).default([]),
  confidence: z.number().min(0).max(1).optional(),
  evidence_refs: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
});

const updateSchema = z.object({
  id: z.string().trim().min(1).max(128),
  kind: z.enum(['fact', 'hypothesis']).optional(),
  content: z.string().trim().min(1).max(4096).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence_refs: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
}).refine(({ kind, content, tags, confidence, evidence_refs }) =>
  (kind !== undefined || content !== undefined || tags !== undefined || confidence !== undefined || evidence_refs !== undefined)
    && (content === undefined || Boolean(evidence_refs?.length)),
'至少提供一个要更新的字段');

const forgetSchema = z.object({ id: z.string().trim().min(1).max(128) });

type SearchInput = z.infer<typeof searchSchema>;
type ProposeInput = z.infer<typeof proposeSchema>;
type UpdateInput = z.infer<typeof updateSchema>;
type ForgetInput = z.infer<typeof forgetSchema>;

/** Project memories stay workspace-scoped; every durable mutation requires ApprovalManager approval. */
export function createMemoryTools(memory: MemoryToolService): ToolDefinition<unknown>[] {
  const tools: ToolDefinition<unknown>[] = [
    {
      name: 'memory_search',
      description: '在当前工作区检索已有项目记忆；只读，结果包含来源与证据引用。',
      parameters: searchSchema as unknown as ToolDefinition<SearchInput>['parameters'],
      riskLevel: 'read',
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
      tags: ['memory', 'read'],
      async execute(input: SearchInput, ctx: ToolContext): Promise<ToolOutcome> {
        try {
          const hits = memory.search(ctx.workspaceRoot, input.text, {
            limit: input.limit,
            ...(input.tags ? { tags: input.tags } : {}),
            ...(input.kind ? { kind: input.kind } : {}),
          });
          const entries = hits.map(({ entry, rankScore }) => ({
            id: entry.id,
            key: entry.key,
            content: entry.content,
            source: entry.source,
            kind: entry.kind,
            confidence: entry.confidence,
            updated_at: entry.updated_at,
            evidence_refs: entry.evidence_refs,
            rankScore,
          }));
          return toolOk(entries.length ? `找到 ${entries.length} 条项目记忆` : '未找到相关项目记忆', entries);
        } catch (error) {
          return errorToOutcome(error, 'MEMORY_STORE_ERROR');
        }
      },
    },
    {
      name: 'memory_propose',
      description: '提议将有来源依据的事实或经验保存为当前工作区项目记忆；每次保存都需用户审批。',
      parameters: proposeSchema as unknown as ToolDefinition<ProposeInput>['parameters'],
      riskLevel: 'write',
      alwaysRequireApproval: true,
      requireCompleteApprovalPreview: true,
      maxApprovalPreviewChars: 16_000,
      getApprovalPreview(input: ProposeInput, ctx: ToolContext): string {
        return formatApprovalPreview('将提议一条项目记忆（批准后仅创建待审核候选）', {
          workspace: ctx.workspaceRoot,
          kind: input.kind,
          source: 'agent',
          scope: 'project',
          key: input.key,
          content: input.content,
          tags: input.tags,
          confidence: input.confidence ?? null,
          evidence_refs: input.evidence_refs,
        });
      },
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
      tags: ['memory', 'write'],
      async execute(input: ProposeInput, ctx: ToolContext): Promise<ToolOutcome> {
        try {
          const candidate = memory.propose({
            kind: input.kind,
            source: 'agent',
            scope: 'project',
            key: input.key,
            content: input.content,
            workspace: ctx.workspaceRoot,
            tags: input.tags,
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
            evidence_refs: input.evidence_refs,
          }, ctx.sessionId);
          return toolOk(`已创建待审核项目记忆候选 ${input.key}`, {
            candidate: {
              id: candidate.id,
              session_id: candidate.session_id,
              status: candidate.status,
              key: candidate.input.key,
              content: candidate.input.content,
            },
          });
        } catch (error) {
          return errorToOutcome(error, 'MEMORY_INVALID');
        }
      },
    },
    {
      name: 'memory_update',
      description: '更新当前工作区的一条项目记忆；创建新版本并保留旧版本历史，每次更新都需用户审批。',
      parameters: updateSchema as unknown as ToolDefinition<UpdateInput>['parameters'],
      riskLevel: 'write',
      alwaysRequireApproval: true,
      requireCompleteApprovalPreview: true,
      maxApprovalPreviewChars: 16_000,
      getApprovalPreview(input: UpdateInput, ctx: ToolContext): string {
        const entry = memory.get(input.id);
        if (!entry || entry.workspace !== ctx.workspaceRoot || entry.superseded_by !== undefined) {
          throw new Error('当前工作区中找不到这条活动项目记忆');
        }
        const { id: _id, ...changes } = input;
        return formatApprovalPreview('将以新版本纠正项目记忆', {
          workspace: ctx.workspaceRoot,
          previous: publicEntry(entry),
          changes,
        });
      },
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
      tags: ['memory', 'write'],
      async execute(input: UpdateInput, ctx: ToolContext): Promise<ToolOutcome> {
        if (!belongsToWorkspace(memory, input.id, ctx.workspaceRoot)) {
          return toolError('MEMORY_NOT_FOUND', '当前工作区中找不到这条活动项目记忆');
        }
        try {
          const { id: _id, ...patch } = input;
          const result = memory.update(input.id, patch);
          return result.conflict
            ? toolOk('更新与既有高置信用户事实冲突，未保存', { conflict: true, entry: publicEntry(result.entry) })
            : toolOk(`已更新项目记忆 ${result.entry.key}`, { conflict: false, entry: publicEntry(result.entry) });
        } catch (error) {
          return errorToOutcome(error, 'MEMORY_STORE_ERROR');
        }
      },
    },
    {
      name: 'memory_forget',
      description: '作废当前工作区的一条项目记忆并保留审计历史；每次作废都需用户审批。',
      parameters: forgetSchema as unknown as ToolDefinition<ForgetInput>['parameters'],
      riskLevel: 'write',
      alwaysRequireApproval: true,
      requireCompleteApprovalPreview: true,
      maxApprovalPreviewChars: 16_000,
      getApprovalPreview(input: ForgetInput, ctx: ToolContext): string {
        const entry = memory.get(input.id);
        if (!entry || entry.workspace !== ctx.workspaceRoot || entry.superseded_by !== undefined) {
          throw new Error('当前工作区中找不到这条活动项目记忆');
        }
        return formatApprovalPreview('将作废当前项目记忆并保留历史', {
          workspace: ctx.workspaceRoot,
          entry: publicEntry(entry),
        });
      },
      timeoutMs: 5_000,
      maxOutputBytes: 2 * 1024,
      tags: ['memory', 'write'],
      async execute(input: ForgetInput, ctx: ToolContext): Promise<ToolOutcome> {
        if (!belongsToWorkspace(memory, input.id, ctx.workspaceRoot)) {
          return toolError('MEMORY_NOT_FOUND', '当前工作区中找不到这条活动项目记忆');
        }
        try {
          return memory.forget(input.id)
            ? toolOk(`已作废项目记忆 ${input.id}`)
            : toolError('MEMORY_NOT_FOUND', '这条项目记忆已不存在或已作废');
        } catch (error) {
          return errorToOutcome(error, 'MEMORY_STORE_ERROR');
        }
      },
    },
  ];
  return tools;
}

function belongsToWorkspace(memory: MemoryToolService, id: string, workspace: string): boolean {
  const entry = memory.get(id);
  return entry !== null && entry.workspace === workspace && entry.superseded_by === undefined;
}

function publicEntry(entry: MemoryToolEntry): Omit<MemoryToolEntry, 'workspace'> {
  const { workspace: _workspace, ...rest } = entry;
  return rest;
}

function formatApprovalPreview(title: string, detail: unknown): string {
  return `${title}\n${JSON.stringify(detail, null, 2)}`;
}
