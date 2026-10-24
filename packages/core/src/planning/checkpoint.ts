/**
 * CheckpointManager：计划快照持久化与崩溃恢复（v0.3.0 Phase 1）。
 *
 * 存储策略（按 Advisor 决策）：
 *   - 整个 CheckpointRecord 存单个 JSON blob 列（payload TEXT），
 *     不做规范化多表——因为永远只做"保存/加载完整快照"两种操作；
 *   - 接受 DatabaseSync 实例作为 DI，不自己开新连接——
 *     与 SessionStore 同库，审计 + 检查点自然共存，简化备份；
 *   - 表结构：plan_checkpoints(plan_id TEXT PK, snapshot_at TEXT, payload TEXT)。
 *
 * 持久化时机（由 StepExecutor / PlanManager 调用）：
 *   - 每个 TaskStep 状态变化时（running / completed / failed / blocked）；
 *   - 计划取消时（abort_requested=true 快照）；
 *   - 恢复时先 load checkpoint，决定从哪个 step_id 继续。
 *
 * 不负责执行逻辑——只有"查/存/删"原子操作，纯 CRUD。
 */
import { DatabaseSync } from 'node:sqlite';
import { ForgeError } from '@forgex/shared';
import type { CheckpointRecord, TaskPlan } from './types.js';
import { nowIso } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_checkpoints (
  plan_id TEXT PRIMARY KEY,
  snapshot_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  abort_requested INTEGER NOT NULL DEFAULT 0
);
`;

export interface CheckpointManagerOptions {
  /** 允许 CheckpointManager 使用 WAL 模式（与 SessionStore 保持一致即可） */
  enableWal?: boolean;
}

export class CheckpointManager {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, options: CheckpointManagerOptions = {}) {
    this.db = db;
    if (options.enableWal) {
      try {
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA busy_timeout = 3000');
      } catch {
        // WAL 设置失败不阻塞——可能连接是只读的（:memory: 总是成功）
      }
    }
    try {
      this.db.exec(SCHEMA);
    } catch (err) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', '无法初始化 checkpoint 表', { cause: err });
    }
  }

  /**
   * 保存（覆盖）一个计划的 checkpoint。
   * 这是 StepExecutor 在每个 step 状态变化后必须调用的方法。
   */
  save(record: CheckpointRecord): void {
    try {
      const payload = JSON.stringify(record);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO plan_checkpoints
           (plan_id, snapshot_at, payload, abort_requested)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          record.plan_id,
          record.snapshot_at,
          payload,
          record.abort_requested ? 1 : 0,
        );
    } catch (err) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', `写入 checkpoint 失败: ${record.plan_id}`, {
        cause: err,
        details: { planId: record.plan_id },
      });
    }
  }

  /**
   * 从 TaskPlan 构造一个 CheckpointRecord 并立即保存（快捷方法）。
   * StepExecutor 可以直接调这个，不必自己拼 completed_step_ids / failed_step_ids。
   */
  snapshotPlan(plan: TaskPlan, abortRequested = false): CheckpointRecord {
    const completed: string[] = [];
    const failed: string[] = [];
    let runningId: string | undefined;

    for (const step of plan.steps) {
      if (step.status === 'completed') completed.push(step.step_id);
      else if (step.status === 'failed') failed.push(step.step_id);
      else if (step.status === 'running') runningId = step.step_id;
    }

    const record: CheckpointRecord = {
      plan_id: plan.plan_id,
      snapshot_at: nowIso(),
      plan,
      abort_requested: abortRequested,
      running_step_id: runningId,
      completed_step_ids: completed,
      failed_step_ids: failed,
    };
    this.save(record);
    return record;
  }

  /**
   * 加载某个 plan_id 的最新 checkpoint。
   * 恢复流程第一步——拿到完整快照后，根据 status 和重试预算决定从哪里继续。
   */
  load(planId: string): CheckpointRecord | null {
    try {
      const row = this.db
        .prepare('SELECT payload FROM plan_checkpoints WHERE plan_id = ?')
        .get(planId) as { payload: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.payload) as CheckpointRecord;
      } catch (parseErr) {
        throw new ForgeError('PLANNING_CHECKPOINT_ERROR', `checkpoint payload 解析失败: ${planId}`, {
          cause: parseErr,
          details: { planId },
        });
      }
    } catch (err) {
      if (err instanceof ForgeError) throw err;
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', `读取 checkpoint 失败: ${planId}`, {
        cause: err,
        details: { planId },
      });
    }
  }

  /** 列出所有有 checkpoint 的 plan_id（供"恢复哪些计划"UI 用） */
  listPlanIds(limit = 50): string[] {
    try {
      const rows = this.db
        .prepare('SELECT plan_id FROM plan_checkpoints ORDER BY snapshot_at DESC LIMIT ?')
        .all(Math.max(1, limit)) as Array<{ plan_id: string }>;
      return rows.map((r) => r.plan_id);
    } catch (err) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', '列出 checkpoint 失败', { cause: err });
    }
  }

  /** 删除某个 plan 的 checkpoint（完成后清理） */
  delete(planId: string): boolean {
    try {
      const info = this.db
        .prepare('DELETE FROM plan_checkpoints WHERE plan_id = ?')
        .run(planId) as { changes: number };
      return info.changes > 0;
    } catch (err) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', `删除 checkpoint 失败: ${planId}`, {
        cause: err,
        details: { planId },
      });
    }
  }

  /** 全部删除（罕见操作：重置开发 / 测试清理） */
  deleteAll(): number {
    try {
      const info = this.db.prepare('DELETE FROM plan_checkpoints').run() as { changes: number };
      return info.changes;
    } catch (err) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', '清空 checkpoint 失败', { cause: err });
    }
  }

  /** 某个 plan 是否有 checkpoint */
  has(planId: string): boolean {
    try {
      const row = this.db
        .prepare('SELECT 1 FROM plan_checkpoints WHERE plan_id = ? LIMIT 1')
        .get(planId) as unknown as { '1': number } | undefined;
      return row !== undefined;
    } catch {
      return false;
    }
  }
}
