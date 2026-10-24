/**
 * MemoryConsolidator：记忆合并与升级决策（v0.3.0 Phase 4）。
 *
 * 职责：写入新记忆前，决定它与既有记忆的关系。
 * 所有操作都是"标记旧 + 写新"，历史版本留在库中供审计回溯。
 *
 * 决策规则（按优先级）：
 *   1. 同 key 更新：workspace+scope+key（+session/task 限定）已有有效 entry
 *      → 新 entry 取代旧 entry（旧标记 superseded_by=新 id）；
 *   2. hypothesis 升级：旧为 hypothesis、新为同 key 的 fact 且新 confidence 更高
 *      → 视为"假设被证实"，同样取代，但返回 promoted=true 供上层记录；
 *   3. 冲突检测：同 key、不同 content、旧 entry 仍是高置信 fact 且来源为 user
 *      → 不自动覆盖 user 陈述（user 优先级最高），返回 conflict=true 由调用方决定；
 *      其余同 key 不同 content 按规则 1 正常更新。
 *
 * 不做的事：不做语义级去重（"内容差不多但 key 不同"的条目合并）——
 * 那会引入不确定性判断，违背"确定性优先"原则，交由 recall 排序兜底。
 */
import { ForgeError } from '@forgex/shared';
import type { MemoryStore } from './store.js';
import type { CreateMemoryInput, MemoryEntry } from './types.js';
import { createMemoryEntry } from './types.js';

/** 合并决策结果 */
export interface ConsolidateResult {
  /** 最终入库的新 entry */
  entry: MemoryEntry;
  /** 被取代的旧 entry（无则 undefined） */
  superseded?: MemoryEntry;
  /** hypothesis 被 fact 证实升级 */
  promoted: boolean;
  /**
   * 与既有高置信 user 事实冲突（本次未写入）。
   * 冲突时 entry/superseded 无效，调用方应放弃写入或走人工确认。
   */
  conflict: boolean;
}

export class MemoryConsolidator {
  constructor(private readonly store: MemoryStore) {}

  /**
   * 合并写入：返回决策结果。
   * 冲突时返回 conflict=true 且不写入任何数据。
   */
  consolidate(input: CreateMemoryInput): ConsolidateResult {
    // 定位同 key 的当前有效版本
    const existing = this.store.getCurrent(input.workspace, input.scope, input.key, {
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
    });

    const entry = createMemoryEntry(input);

    if (existing === null) {
      this.store.insert(entry);
      return { entry, promoted: false, conflict: false };
    }

    // 规则 3：user 陈述的高置信 fact 不被 agent/hypothesis 覆盖
    const existingIsAuthoritative =
      existing.kind === 'fact' && existing.source === 'user' && existing.confidence >= 0.9;
    const newOverridesUser = input.source === 'user' && input.kind === 'fact';
    if (existingIsAuthoritative && !newOverridesUser && existing.content !== entry.content) {
      return { entry, superseded: existing, promoted: false, conflict: true };
    }

    // 规则 1/2：正常取代
    const promoted =
      existing.kind === 'hypothesis' &&
      entry.kind === 'fact' &&
      entry.confidence > existing.confidence;

    if (!this.store.markSuperseded(existing.id, entry.id)) {
      // 并发下旧 entry 已被其他人取代——视为存储层异常，中止写入
      throw new ForgeError('MEMORY_STORE_ERROR', '记忆取代失败：目标版本已变化', {
        details: { existingId: existing.id, newId: entry.id },
        retryable: true,
      });
    }
    this.store.insert(entry);
    return { entry, superseded: existing, promoted, conflict: false };
  }
}
