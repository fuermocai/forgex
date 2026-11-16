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
import { ForgeError, uuid } from '@forgex/shared';
import { MemoryStore } from './store.js';
import { MemoryRetriever, type RecallQuery, type RecallHit } from './retriever.js';
import { MemoryConsolidator, type ConsolidateResult } from './consolidator.js';
import { validateMemoryInput } from './validator.js';
import {
  isActive,
  type CreateMemoryInput,
  type MemoryCandidate,
  type MemoryCandidateStatus,
  type MemoryEntry,
} from './types.js';

export type UpdateMemoryInput = Partial<Pick<CreateMemoryInput,
  'kind' | 'source' | 'content' | 'tags' | 'confidence' | 'expires_at' | 'evidence_refs'>>;

export interface MemoryManagerOptions {
  /** JSONL 事件文件路径，':memory:' 表示仅存内存（测试用） */
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

  /** Store a reviewable proposal without making it available to recall. */
  propose(input: CreateMemoryInput, sessionId: string): MemoryCandidate {
    if (!sessionId.trim()) throw new ForgeError('MEMORY_INVALID', '记忆候选必须关联会话');
    if (input.scope !== 'project') throw new ForgeError('MEMORY_INVALID', '长期记忆候选必须使用 project scope');
    validateMemoryInput(input);
    const prior = this.store.listCandidates({ workspace: input.workspace, session_id: sessionId })
      .find((candidate) => candidate.status !== 'rejected'
        && candidate.input.key === input.key
        && candidate.input.content === input.content);
    if (prior) return prior;
    const now = new Date().toISOString();
    const candidate: MemoryCandidate = {
      id: uuid(),
      session_id: sessionId,
      workspace: input.workspace,
      input: JSON.parse(JSON.stringify(input)) as CreateMemoryInput,
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    this.store.insertCandidate(candidate);
    return candidate;
  }

  listCandidates(workspace: string, options: { session_id?: string; status?: MemoryCandidateStatus } = {}): MemoryCandidate[] {
    return this.store.listCandidates({ workspace, ...options });
  }

  getCandidate(id: string, workspace?: string): MemoryCandidate | null {
    const candidate = this.store.getCandidate(id);
    return candidate && (workspace === undefined || candidate.workspace === workspace) ? candidate : null;
  }

  /** A conflict leaves the candidate pending so the user can correct it. */
  approveCandidate(id: string, workspace: string): { candidate: MemoryCandidate; result: ConsolidateResult } {
    const candidate = this.getCandidate(id, workspace);
    if (!candidate || candidate.status !== 'pending') {
      throw new ForgeError('MEMORY_NOT_FOUND', `找不到当前工作区中待审核的记忆候选: ${id}`);
    }
    const result = this.remember(candidate.input);
    if (!result.conflict) this.store.setCandidateStatus(id, 'approved', result.entry.id);
    return { candidate: this.getCandidate(id, workspace)!, result };
  }

  rejectCandidate(id: string, workspace: string): MemoryCandidate {
    const candidate = this.getCandidate(id, workspace);
    if (!candidate || candidate.status !== 'pending' || !this.store.setCandidateStatus(id, 'rejected')) {
      throw new ForgeError('MEMORY_NOT_FOUND', `找不到当前工作区中待审核的记忆候选: ${id}`);
    }
    return this.getCandidate(id, workspace)!;
  }

  /** 召回记忆（详见 MemoryRetriever.recall） */
  recall(query: RecallQuery): RecallHit[] {
    return this.retriever.recall(query);
  }

  /** Active project memories for one exact workspace. */
  list(workspace: string): MemoryEntry[] {
    return this.store.query({ workspace, scope: 'project', limit: Number.MAX_SAFE_INTEGER })
      .filter((entry) => isActive(entry));
  }

  /** Search project memories without crossing the selected workspace boundary. */
  search(workspace: string, text: string, options: Pick<RecallQuery, 'limit' | 'tags' | 'kind'> = {}): RecallHit[] {
    return this.recall({ workspace, scopes: ['project'], text, ...options });
  }

  /** Update an active entry by creating a new version and superseding the old one. */
  update(id: string, patch: UpdateMemoryInput): ConsolidateResult {
    const existing = this.store.getById(id);
    if (!existing || existing.superseded_by !== undefined) {
      throw new ForgeError('MEMORY_NOT_FOUND', `找不到可更新的活动记忆: ${id}`);
    }
    if (patch.content !== undefined && patch.content !== existing.content && !patch.evidence_refs?.length) {
      throw new ForgeError('MEMORY_INVALID', '修改记忆内容必须提供新的证据引用');
    }
    const input: CreateMemoryInput = {
      kind: patch.kind ?? existing.kind,
      source: patch.source ?? existing.source,
      scope: existing.scope,
      key: existing.key,
      content: patch.content ?? existing.content,
      workspace: existing.workspace,
      tags: patch.tags ?? existing.tags,
      confidence: patch.confidence ?? existing.confidence,
      evidence_refs: patch.evidence_refs ?? existing.evidence_refs,
      ...(patch.expires_at ?? existing.expires_at ? { expires_at: patch.expires_at ?? existing.expires_at } : {}),
      ...(existing.session_id ? { session_id: existing.session_id } : {}),
      ...(existing.task_id ? { task_id: existing.task_id } : {}),
    };
    return this.remember(input);
  }

  /** Export every project-scoped version for one workspace as portable JSON. */
  exportProject(workspace: string): string {
    const entries = this.store.query({
      workspace,
      scope: 'project',
      includeSuperseded: true,
      limit: Number.MAX_SAFE_INTEGER,
    });
    return JSON.stringify({ version: 1, workspace, exported_at: new Date().toISOString(), entries }, null, 2);
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

  /** Soft-delete every active project entry in exactly one workspace. */
  clearProject(workspace: string): number {
    let cleared = 0;
    for (const entry of this.list(workspace)) {
      if (this.store.markSuperseded(entry.id, entry.id)) cleared += 1;
    }
    return cleared;
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
