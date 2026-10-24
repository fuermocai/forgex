/**
 * MemoryManager：Project Memory 对外门面（v0.3.0 Phase 4）。
 *
 * 编排 validator → consolidator → store / retriever，提供三个核心 API：
 *   - remember：校验 + 合并写入；冲突与敏感内容会以 ForgeError 形式拒绝
 *   - recall：分层召回 + 排序
 *   - forget：软删除指定记忆（标记为被一条"墓碑"取代会污染查询，
 *      这里采用直接置 superseded_by = 自身 id 的自指标记，语义为"已作废"）
 *
 * 设计约束：
 *   - 所有写入必须先过 validateMemoryInput——敏感信息没有"降级入库"路径；
 *   - conflict 由调用方决定如何处理（提示用户 / 走审批），Manager 不静默覆盖；
 *   - 本类不做任何模型调用，全部确定性逻辑，可离线运行。
 */
import { ForgeError } from '@forgex/shared';
import { MemoryStore } from './store.js';
import { MemoryRetriever, type RecallQuery, type RecallHit } from './retriever.js';
import { MemoryConsolidator, type ConsolidateResult } from './consolidator.js';
import { validateMemoryInput } from './validator.js';
import type { CreateMemoryInput, MemoryEntry } from './types.js';

export interface MemoryManagerOptions {
  /** SQLite 路径，':memory:' 为内存库（测试用） */
  dbPath: string;
}

export class MemoryManager {
  private readonly store: MemoryStore;
  private readonly retriever: MemoryRetriever;
  private readonly consolidator: MemoryConsolidator;

  constructor(options: MemoryManagerOptions) {
    this.store = new MemoryStore(options.dbPath);
    this.retriever = new MemoryRetriever(this.store);
    this.consolidator = new MemoryConsolidator(this.store);
  }

  /**
   * 写入记忆。
   *
   * @throws ForgeError MEMORY_INVALID 输入非法
   * @throws ForgeError MEMORY_SENSITIVE_CONTENT 含敏感信息
   * @returns ConsolidateResult；conflict=true 表示与 user 高置信事实冲突、未写入
   */
  remember(input: CreateMemoryInput): ConsolidateResult {
    validateMemoryInput(input);
    return this.consolidator.consolidate(input);
  }

  /** 召回记忆（详见 MemoryRetriever.recall） */
  recall(query: RecallQuery): RecallHit[] {
    return this.retriever.recall(query);
  }

  /**
   * 遗忘一条记忆（软删除）。
   * 采用自指 superseded 标记：superseded_by = 自身 id，语义为"已作废"。
   * 幂等：对不存在或已作废的 id 返回 false。
   */
  forget(id: string): boolean {
    const existing = this.store.getById(id);
    if (existing === null) return false;
    if (existing.superseded_by !== undefined) return false;
    return this.store.markSuperseded(id, id);
  }

  /** 按 ID 读取（含已作废历史版本） */
  get(id: string): MemoryEntry | null {
    return this.store.getById(id);
  }

  /**
   * 更新一条 user 事实的便捷入口：source 固定 user、kind 固定 fact。
   * 用于"用户明确纠正系统认知"的场景，绕过 conflict 检查（user 永远优先）。
   */
  rememberUserFact(
    input: Omit<CreateMemoryInput, 'kind' | 'source'>,
  ): ConsolidateResult {
    return this.remember({ ...input, kind: 'fact', source: 'user' });
  }

  /** 统计 workspace 下的有效记忆条数（监控/调试用） */
  count(workspace: string): number {
    return this.store.count(workspace);
  }

  /**
   * 清理某个 session 的所有 session/task 级记忆（会话结束时调用）。
   * 返回作废条数。project 级记忆不受影响。
   */
  purgeSession(sessionId: string, workspace: string): number {
    const rows = this.store.query({ workspace, session_id: sessionId });
    let purged = 0;
    for (const row of rows) {
      if (row.scope === 'project') continue;
      if (this.store.markSuperseded(row.id, row.id)) purged += 1;
    }
    return purged;
  }

  close(): void {
    this.store.close();
  }
}

/** 便捷工厂（与 SessionStore 的使用风格一致） */
export function createMemoryManager(dbPath: string): MemoryManager {
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw new ForgeError('MEMORY_INVALID', 'MemoryManager dbPath 不能为空');
  }
  return new MemoryManager({ dbPath });
}
