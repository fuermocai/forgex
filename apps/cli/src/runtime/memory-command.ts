import { redactText } from '@forgex/shared';
import type { MemoryEntry } from '@forgex/core';
import type { ForgeRuntime } from './create-runtime.js';

const MEMORY_COMMAND = /^\/memory(?:\s|$)/;

export function isMemoryCommand(text: string): boolean {
  return MEMORY_COMMAND.test(text.trim());
}

/** Execute a workspace-scoped project-memory management command. */
export async function dispatchMemoryCommand(runtime: ForgeRuntime, text: string): Promise<string> {
  const [root = '', subcommand, ...args] = text.trim().split(/\s+/);
  const command = subcommand ? `${root} ${subcommand}` : root;
  const [id, ...rest] = args;
  const arg = rest.join(' ').trim();
  const memory = runtime.memory;
  if (!memory) return '项目记忆未启用；在配置中设置 memory.enabled=true 后重试';
  const workspace = runtime.settings.workspaceRoots[0] ?? runtime.config.security.workspaceRoots[0];
  if (!workspace) return '未配置工作区，无法访问项目记忆';

  try {
    switch (command) {
      case '/memory':
      case '/memory list': {
        const entries = memory.list(workspace);
        return entries.length ? entries.map(formatEntry).join('\n') : '当前工作区没有项目记忆';
      }
      case '/memory search': {
        if (!id) return '用法：/memory search <关键词>';
        const hits = memory.search(workspace, [id, ...rest].join(' '), { limit: 20 });
        return hits.length ? hits.map(({ entry, relevance }) => `${formatEntry(entry)} · 相关度 ${relevance.toFixed(2)}`).join('\n') : '没有找到相关项目记忆';
      }
      case '/memory show': {
        if (!id || rest.length > 0) return '用法：/memory show <id>';
        const entry = memory.get(id);
        if (!entry || entry.workspace !== workspace || entry.scope !== 'project') return '当前工作区中找不到这条项目记忆';
        return formatEntryDetails(entry);
      }
      case '/memory edit': {
        if (!id || !arg) return '用法：/memory edit <id> <新内容>';
        const entry = memory.get(id);
        if (!isCurrentWorkspaceEntry(entry, workspace)) return '当前工作区中找不到这条活动项目记忆';
        const evidenceRef = `session:${runtime.agent.sessionId}:cli-memory-edit:${id}`;
        const result = memory.update(id, {
          content: arg,
          source: 'user',
          evidence_refs: [...entry.evidence_refs, evidenceRef],
        });
        return result.conflict
          ? '更新与已有高置信用户事实冲突，未保存；请调整内容后重试'
          : `已更新项目记忆 ${result.entry.key}；旧版本 ${id} 已保留为历史`;
      }
      case '/memory forget': {
        if (!id || rest.length > 0) return '用法：/memory forget <id>';
        const entry = memory.get(id);
        if (!isCurrentWorkspaceEntry(entry, workspace)) return '当前工作区中找不到这条活动项目记忆';
        return memory.forget(id) ? `已作废项目记忆 ${id}` : '这条项目记忆已不存在或已作废';
      }
      case '/memory clear': {
        if (id !== 'confirm' || rest.length > 0) return '此操作会作废当前工作区全部活动项目记忆。确认后运行：/memory clear confirm';
        const cleared = memory.clearProject(workspace);
        return `已清空当前工作区的 ${cleared} 条活动项目记忆；历史版本仍保留在存储中`;
      }
      case '/memory export': {
        if (id || rest.length > 0) return '用法：/memory export';
        return redactText(memory.exportProject(workspace));
      }
      case '/memory candidates': {
        if (id || rest.length > 0) return '用法：/memory candidates';
        const candidates = memory.listCandidates(workspace, { status: 'pending' });
        return candidates.length
          ? candidates.map((candidate) => `${candidate.id} [pending] ${candidate.input.key} — ${redactText(candidate.input.content)}`).join('\n')
          : '当前工作区没有待审核记忆候选';
      }
      case '/memory approve': {
        if (!id || rest.length > 0) return '用法：/memory approve <candidateId>';
        const { result } = memory.approveCandidate(id, workspace);
        return result.conflict
          ? `候选 ${id} 与现有高置信用户事实冲突，仍待审核；请先 /memory reject ${id}，再用“记住：...”提交修正版`
          : `已批准并保存记忆候选 ${id}`;
      }
      case '/memory reject': {
        if (!id || rest.length > 0) return '用法：/memory reject <candidateId>';
        memory.rejectCandidate(id, workspace);
        return `已拒绝记忆候选 ${id}`;
      }
      default:
        return [
          '用法：/memory list|search <词>|show <id>|edit <id> <内容>|forget <id>|clear confirm|export',
          '      /memory candidates|approve <candidateId>|reject <candidateId>',
        ].join('\n');
    }
  } catch (error) {
    return redactText(error instanceof Error ? error.message : String(error));
  }
}

function isCurrentWorkspaceEntry(entry: MemoryEntry | null, workspace: string): entry is MemoryEntry {
  return entry !== null && entry.workspace === workspace && entry.scope === 'project' && entry.superseded_by === undefined;
}

function formatEntry(entry: MemoryEntry): string {
  return `${entry.id} [${entry.kind}/${entry.source}] ${entry.key} — ${redactText(entry.content)}`;
}

function formatEntryDetails(entry: MemoryEntry): string {
  return [
    formatEntry(entry),
    `来源：${entry.source}`,
    `范围：${entry.scope} · 类型：${entry.kind}`,
    `状态：${entry.superseded_by === undefined ? 'active' : `superseded by ${entry.superseded_by}`}`,
    `置信度：${entry.confidence}`,
    `更新时间：${entry.updated_at}`,
    `证据：${entry.evidence_refs.map(redactText).join(', ') || '无'}`,
    ...(entry.tags.length ? [`标签：${entry.tags.map(redactText).join(', ')}`] : []),
  ].join('\n');
}
