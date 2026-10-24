/**
 * MemoryRetriever：记忆召回层（v0.3.0 Phase 4）。
 *
 * 召回策略（确定性，无模型参与）：
 *   1. 范围过滤：按 workspace + scope（+ session_id / task_id）圈定候选集，
 *      只取 isActive（未取代、未过期）的 entry；
 *   2. 相关度打分：
 *      - tags 与查询词重叠加权；
 *      - key / content 包含查询词（子串匹配）加权；
 *      - 无查询词时按"纯范围列举"处理，score 全为 0，仅靠 confidence+新鲜度排序；
 *   3. 排序：relevance * W_REL + confidence * W_CONF + freshness * W_FRESH；
 *      新鲜度按 updated_at 距今天数指数衰减（半衰期 30 天）。
 *
 * 为什么不用向量检索：项目要求全离线部署，不下载 Embedding 模型；
 * 记忆条数通常远小于代码库规模，子串+标签+置信度排序已够用。
 */
import {
  DEFAULT_RECALL_LIMIT,
  MAX_RECALL_LIMIT,
  isActive,
  type MemoryEntry,
  type MemoryScope,
} from './types.js';
import type { MemoryStore } from './store.js';

/** 召回请求 */
export interface RecallQuery {
  workspace: string;
  /** 召回哪些 scope（缺省全部三层都召回） */
  scopes?: readonly MemoryScope[];
  session_id?: string;
  task_id?: string;
  /** 自然语言查询词（会被粗略分词后做子串匹配） */
  text?: string;
  /** 只召回含这些标签的记忆（AND 语义：每个 tag 都要命中） */
  tags?: readonly string[];
  /** 只召回指定 kind */
  kind?: MemoryEntry['kind'];
  limit?: number;
}

/** 召回结果：entry + 排序分解（供审计与调试） */
export interface RecallHit {
  entry: MemoryEntry;
  /** 相关度得分（子串/标签命中累计，0 表示无查询词） */
  relevance: number;
  /** 新鲜度系数 (0, 1]，越新越接近 1 */
  freshness: number;
  /** 最终排序分 */
  rankScore: number;
}

/** 排序权重：相关度主导，置信度次之，新鲜度兜底 */
const W_REL = 1.0;
const W_CONF = 0.5;
const W_FRESH = 0.2;

/** 新鲜度半衰期（天）：30 天前的记忆新鲜度约减半 */
const FRESHNESS_HALF_LIFE_DAYS = 30;

/** 子串匹配打分：key 命中权重高于 content */
const KEY_HIT_SCORE = 2.0;
const CONTENT_HIT_SCORE = 1.0;
const TAG_HIT_SCORE = 1.5;

export class MemoryRetriever {
  constructor(private readonly store: MemoryStore) {}

  /** 召回记忆（按 rankScore 降序） */
  recall(query: RecallQuery, now: Date = new Date()): RecallHit[] {
    const scopes = query.scopes ?? ['project', 'session', 'task'];
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_RECALL_LIMIT), MAX_RECALL_LIMIT);

    // 1. 分层取候选（scope 内可再叠加 session/task 过滤，收紧候选集）
    const candidates: MemoryEntry[] = [];
    for (const scope of scopes) {
      const rows = this.store.query({
        workspace: query.workspace,
        scope,
        // scope 级过滤只在显式给出对应 id 时生效，避免误过滤 project 级记忆
        ...(query.session_id !== undefined && scope !== 'project'
          ? { session_id: query.session_id }
          : {}),
        ...(query.task_id !== undefined && scope === 'task' ? { task_id: query.task_id } : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
        // 多取一些供排序后截断；上限 4 倍 limit
        limit: limit * 4,
      });
      candidates.push(...rows);
    }

    // 2. 过滤失效项 + 必选标签
    const requiredTags = query.tags ?? [];
    const active = candidates.filter(
      (entry) =>
        isActive(entry, now) && requiredTags.every((tag) => entry.tags.includes(tag)),
    );

    // 3. 打分
    const terms = query.text !== undefined ? extractTerms(query.text) : [];
    const hits = active.map((entry) => {
      const relevance = terms.length === 0 ? 0 : scoreEntry(entry, terms);
      const freshness = computeFreshness(entry, now);
      const rankScore = W_REL * relevance + W_CONF * entry.confidence + W_FRESH * freshness;
      return { entry, relevance, freshness, rankScore };
    });

    // 4. 有查询词时，0 相关的记忆不返回（避免把不相关的 project 记忆硬塞给上层）
    const filtered = terms.length > 0 ? hits.filter((h) => h.relevance > 0) : hits;

    filtered.sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      // 同分时新的在前，保证稳定可预期
      return b.entry.updated_at.localeCompare(a.entry.updated_at);
    });
    return filtered.slice(0, limit);
  }
}

/**
 * 查询词粗分词：
 *  - 按空白/标点切分；
 *  - 转小写、去重、过滤长度 < 2 的词；
 *  - 中文整段保留（与 search/tokenizeQuery 思路一致，但不做驼峰拆分——记忆 key 多为点分格式）。
 */
export function extractTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const raw of text.split(/[\s,，。.!?:;?；、/\\()[\]{}<>"'`~@#$%^&*+=|-]+/)) {
    const term = raw.trim().toLowerCase();
    if (term.length >= 2) terms.add(term);
  }
  return [...terms].slice(0, 16);
}

/** 单条记忆对查询词集的相关度得分 */
export function scoreEntry(entry: MemoryEntry, terms: readonly string[]): number {
  let score = 0;
  const keyLower = entry.key.toLowerCase();
  const contentLower = entry.content.toLowerCase();
  const tagsLower = entry.tags.map((t) => t.toLowerCase());
  for (const term of terms) {
    if (keyLower.includes(term)) score += KEY_HIT_SCORE;
    if (contentLower.includes(term)) score += CONTENT_HIT_SCORE;
    if (tagsLower.some((tag) => tag.includes(term))) score += TAG_HIT_SCORE;
  }
  return score;
}

/** 新鲜度：指数衰减，半衰期 30 天；未来时间按 1 处理（防御时钟漂移） */
export function computeFreshness(entry: MemoryEntry, now: Date = new Date()): number {
  const ageMs = now.getTime() - new Date(entry.updated_at).getTime();
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);
}
