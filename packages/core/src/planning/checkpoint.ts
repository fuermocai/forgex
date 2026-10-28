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
import { TASK_STATUSES, type CheckpointRecord, type TaskPlan } from './types.js';
import { nowIso } from './types.js';

/** 当前快照 schema 版本（与 types.ts CheckpointRecord.schema_version 保持一致） */
export const CHECKPOINT_SCHEMA_VERSION = 2 as const;

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
      schema_version: CHECKPOINT_SCHEMA_VERSION,
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
   *
   * 加载即校验（schema 版本、结构、依赖完整性）：
   * 损坏或旧版本的快照抛 PLANNING_CHECKPOINT_ERROR，**拒绝恢复**并给出诊断，
   * 宁可人工介入也不基于不可信快照继续产生副作用。
   */
  load(planId: string): CheckpointRecord | null {
    try {
      const row = this.db
        .prepare('SELECT payload FROM plan_checkpoints WHERE plan_id = ?')
        .get(planId) as { payload: string } | undefined;
      if (!row) return null;
      let record: CheckpointRecord;
      try {
        record = JSON.parse(row.payload) as CheckpointRecord;
      } catch (parseErr) {
        throw new ForgeError('PLANNING_CHECKPOINT_ERROR', `checkpoint payload 解析失败: ${planId}`, {
          cause: parseErr,
          details: { planId },
        });
      }
      validateCheckpointRecord(record);
      return record;
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

/* ------------------------------------------------------------------ */
/* 快照校验：加载即验证，不兼容/损坏一律拒绝恢复                        */
/* ------------------------------------------------------------------ */

/**
 * 校验一条 checkpoint 记录的结构完整性。纯函数，供 load() 与恢复流程复用。
 *
 * 校验项（全部通过才返回，否则抛 PLANNING_CHECKPOINT_ERROR）：
 *   1. schema_version === 2 —— 旧版快照（无此字段）直接拒绝；
 *   2. plan_id 存在且与请求一致；
 *   3. plan.steps 非空数组、step_id 唯一；
 *   4. 每步 dependencies 引用的 step_id 都存在（无悬空依赖）；
 *   5. 步骤 status 都是合法枚举值；
 *   6. running_step_id / completed_step_ids / failed_step_ids 与 plan.steps 一致。
 */
export function validateCheckpointRecord(record: unknown): asserts record is CheckpointRecord {
  const problems: string[] = [];
  const rec = record as Partial<CheckpointRecord> | null;

  if (!rec || typeof rec !== 'object') {
    throw new ForgeError('PLANNING_CHECKPOINT_ERROR', '快照不是合法对象', {
      details: { problems: ['payload 不是对象'] },
    });
  }
  if (rec.schema_version === undefined || rec.schema_version === null) {
    throw new ForgeError(
      'PLANNING_CHECKPOINT_ERROR',
      '旧版本快照（缺少 schema_version，schema v1）无法校验兼容性，拒绝恢复；该快照由旧版 ForgeX 写入，请人工核对任务状态',
      { details: { planId: rec.plan_id ?? null, schemaVersion: null } },
    );
  }
  if (rec.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
    throw new ForgeError(
      'PLANNING_CHECKPOINT_ERROR',
      `快照 schema 版本不兼容：快照 v${String(rec.schema_version)}，当前 v${CHECKPOINT_SCHEMA_VERSION}，拒绝恢复`,
      { details: { planId: rec.plan_id ?? null, schemaVersion: rec.schema_version } },
    );
  }
  if (typeof rec.plan_id !== 'string' || rec.plan_id.length === 0) {
    problems.push('plan_id 缺失或非字符串');
  }
  const plan = rec.plan as TaskPlan | undefined;
  if (!plan || typeof plan !== 'object' || plan.plan_id !== rec.plan_id) {
    problems.push('plan 缺失，或 plan.plan_id 与记录不一致');
  } else {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      problems.push('plan.steps 为空或不是数组');
    } else {
      const ids = new Set<string>();
      for (const step of plan.steps) {
        if (!step || typeof step.step_id !== 'string' || step.step_id.length === 0) {
          problems.push('存在缺少 step_id 的步骤');
          continue;
        }
        if (ids.has(step.step_id)) problems.push(`step_id 重复: ${step.step_id}`);
        ids.add(step.step_id);
        if (!TASK_STATUSES.includes(step.status)) {
          problems.push(`步骤 ${step.step_id} 状态非法: ${String(step.status)}`);
        }
        if (!Array.isArray(step.dependencies)) {
          problems.push(`步骤 ${step.step_id} 的 dependencies 不是数组`);
        } else {
          for (const dep of step.dependencies) {
            // 依赖允许指向本批 ids；悬空依赖在这里就能查出来
            if (!plan.steps.some((s) => s.step_id === dep)) {
              problems.push(`步骤 ${step.step_id} 依赖了不存在的步骤: ${dep}`);
            }
          }
        }
      }
      const validIds = new Set(plan.steps.filter((s) => typeof s?.step_id === 'string').map((s) => s.step_id));
      for (const [field, list] of [
        ['completed_step_ids', rec.completed_step_ids],
        ['failed_step_ids', rec.failed_step_ids],
      ] as const) {
        if (!Array.isArray(list)) {
          problems.push(`${field} 不是数组`);
        } else {
          for (const id of list) {
            if (!validIds.has(id)) problems.push(`${field} 引用了不存在的步骤: ${String(id)}`);
          }
        }
      }
      if (rec.running_step_id !== undefined && !validIds.has(rec.running_step_id)) {
        problems.push(`running_step_id 引用了不存在的步骤: ${String(rec.running_step_id)}`);
      }
      const runningInPlan = plan.steps.filter((s) => s.status === 'running').map((s) => s.step_id);
      if (runningInPlan.length > 1) {
        problems.push(`多个步骤处于 running 态: ${runningInPlan.join(', ')}`);
      }
      if (rec.running_step_id && runningInPlan.length > 0 && !runningInPlan.includes(rec.running_step_id)) {
        problems.push(`running_step_id(${rec.running_step_id}) 与 plan 中的 running 步骤(${runningInPlan.join(', ')})不一致`);
      }
    }
  }
  if (problems.length > 0) {
    throw new ForgeError(
      'PLANNING_CHECKPOINT_ERROR',
      `快照校验失败，拒绝恢复（${problems.length} 个问题）：${problems.join('；')}`,
      {
        details: { planId: rec.plan_id ?? null, problems },
      },
    );
  }
}
