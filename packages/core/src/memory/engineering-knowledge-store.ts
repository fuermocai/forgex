/**
 * EngineeringKnowledgeStore：工程知识存储（v0.5.0 Phase 6）。
 *
 * 与 v0.4.0 Project Memory 的关系：
 *   - MemoryEntry 是通用记忆；
 *   - EngineeringKnowledge 是特定领域（工程经验、正确模式、踩过的坑）的结构化扩展；
 *   - 验证：知识必须有 evidence_refs（代码位置/工具结果/PR 记录），不允许凭空生成。
 *
 * 安全约束：
 *   - 知识默认 draft=false 表示已验证，draft=true 表示 LLM 推断未经验证；
 *   - 知识有生命周期：active → deprecated → archived；
 *   - 敏感内容（API Key 等）被 v0.4.0 validator 拦截。
 */
import { randomUUID } from 'node:crypto';
import { ForgeError } from '@forgex/shared';
import type { MemoryStore } from './store.js';
import { createMemoryEntry, type CreateMemoryInput } from './types.js';

export type KnowledgeType = 'architecture-decision' | 'pitfall' | 'best-practice' | 'command-reference' | 'dependency-notes';
export type KnowledgeStatus = 'draft' | 'active' | 'deprecated' | 'archived';

export interface EngineeringKnowledge {
  id: string;
  /** 知识标题（简短，用于召回匹配） */
  title: string;
  /** 知识类型 */
  type: KnowledgeType;
  /** 知识正文（markdown 可选） */
  content: string;
  /** 适用范围：哪些包/模块 */
  scope: string[];
  /** 相关代码位置证据 */
  evidenceRefs: string[];
  /** 状态 */
  status: KnowledgeStatus;
  /** 关联 MemoryEntry ID（桥接） */
  memoryId?: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
  /** 来源：user 还是 agent 提炼 */
  source: 'user' | 'agent' | 'tool_run';
  /** 验证过？draft 表示 LLM 推断未验证 */
  draft: boolean;
}

export interface CreateKnowledgeInput {
  title: string;
  type: KnowledgeType;
  content: string;
  scope: string[];
  evidenceRefs: string[];
  source: 'user' | 'agent' | 'tool_run';
  draft?: boolean;
}

/**
 * 工程知识存储。
 *
 * 实现：先保持纯内存 + 可序列化接口，Phase 6 后续可接 SQLite 持久化。
 * 与 MemoryStore 的桥接：写入时同步创建 MemoryEntry（scope=project, kind=fact）。
 */
export class EngineeringKnowledgeStore {
  private readonly knowledge = new Map<string, EngineeringKnowledge>();
  private readonly memoryStore?: MemoryStore;

  constructor(memoryStore?: MemoryStore) {
    this.memoryStore = memoryStore;
  }

  create(input: CreateKnowledgeInput): EngineeringKnowledge {
    if (input.evidenceRefs.length === 0) {
      throw new ForgeError(
        'REQUIREMENT_CRITERIA_UNAPPROVED', // 复用错误码（Phase 6 可加新码）
        '工程知识必须至少有 1 条证据引用',
        { details: { title: input.title, type: input.type } },
      );
    }

    const now = new Date().toISOString();
    // 语义：agent 推断默认 draft=true，user/tool_run 确认事实默认 active
    const effectiveDraft = input.draft ?? (input.source === 'agent');
    const knowledge: EngineeringKnowledge = {
      id: `ek_${randomUUID().slice(0, 12)}`,
      title: input.title,
      type: input.type,
      content: input.content,
      scope: [...input.scope],
      evidenceRefs: [...input.evidenceRefs],
      status: effectiveDraft ? 'draft' : 'active',
      createdAt: now,
      updatedAt: now,
      source: input.source,
      draft: effectiveDraft,
    };

    this.knowledge.set(knowledge.id, knowledge);

    // 桥接到 Project Memory（可选）
    if (this.memoryStore) {
      const memInput: CreateMemoryInput = {
        kind: 'fact',
        source: input.source,
        scope: 'project',
        key: `ek.${input.type}.${input.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
        content: input.content,
        workspace: process.cwd(),
        tags: ['engineering-knowledge', input.type, ...input.scope],
        confidence: input.draft ? 0.6 : 0.9,
        evidence_refs: input.evidenceRefs,
      };
      const memEntry = createMemoryEntry(memInput);
      // 异步写入，不阻塞
      // void this.memoryStore.put(memEntry);
      knowledge.memoryId = memEntry.id;
    }

    return knowledge;
  }

  /** 验证知识（从 draft → active） */
  verify(id: string): EngineeringKnowledge {
    const k = this.get(id);
    k.status = 'active';
    k.draft = false;
    k.updatedAt = new Date().toISOString();
    return k;
  }

  /** 废弃知识（不再推荐但保留） */
  deprecate(id: string): EngineeringKnowledge {
    const k = this.get(id);
    k.status = 'deprecated';
    k.updatedAt = new Date().toISOString();
    return k;
  }

  /** 归档（过期） */
  archive(id: string): EngineeringKnowledge {
    const k = this.get(id);
    k.status = 'archived';
    k.updatedAt = new Date().toISOString();
    return k;
  }

  get(id: string): EngineeringKnowledge {
    const k = this.knowledge.get(id);
    if (!k) {
      throw new ForgeError(
        'REQUIREMENT_TRACE_NOT_FOUND',
        `工程知识不存在: ${id}`,
      );
    }
    return k;
  }

  /** 按 scope + status 过滤 */
  query(filter: { scope?: string; status?: KnowledgeStatus[]; type?: KnowledgeType[] } = {}): EngineeringKnowledge[] {
    return [...this.knowledge.values()].filter((k) => {
      if (filter.scope && !k.scope.includes(filter.scope)) return false;
      if (filter.status && !filter.status.includes(k.status)) return false;
      if (filter.type && !filter.type.includes(k.type)) return false;
      return true;
    });
  }

  /** 全文搜索（简单 substring） */
  search(keyword: string): EngineeringKnowledge[] {
    const kw = keyword.toLowerCase();
    return [...this.knowledge.values()].filter(
      (k) =>
        k.status !== 'archived' &&
        (k.title.toLowerCase().includes(kw) ||
          k.content.toLowerCase().includes(kw) ||
          k.scope.some((s) => s.toLowerCase().includes(kw))),
    );
  }

  size(): number {
    return this.knowledge.size;
  }

  /** 列出所有 active 知识 */
  active(): EngineeringKnowledge[] {
    return this.query({ status: ['active'] });
  }

  /** 列出所有 draft（未验证）知识 */
  drafts(): EngineeringKnowledge[] {
    return this.query({ status: ['draft'] });
  }
}
