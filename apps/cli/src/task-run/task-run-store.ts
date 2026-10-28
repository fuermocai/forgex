/**
 * TaskRunStore：在 SessionStore 里扩展 task_runs + step_results + gate_results 表。
 *
 * 设计选择：
 *   - 不修改 core 的 SessionStore SCHEMA（保持正交）；
 *   - 独立扩展表，复用已有的 node:sqlite 连接（WAL + busy_timeout 继承）；
 *   - 字段全可 JSON 序列化，便于调试与导出。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CheckpointManager, type CheckpointRecord } from '@forgex/core';
import type { ForgeRuntime } from '../runtime/create-runtime.js';

export type TaskRunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'blocked' | 'unverified' | 'aborted' | 'invalid_plan';

export interface StepResultRecord {
  step_id: string;
  /**
   * completed / failed / cancelled：一次真实执行的终态；
   * running：步骤已开始但进程中断，结果未知（恢复时据此判 needs_reconciliation）；
   * needs_reconciliation：等待人工核对；pending：人工确认外部状态后允许重新调度。
   */
  final_status: 'completed' | 'failed' | 'cancelled' | 'running' | 'needs_reconciliation' | 'pending';
  attempts_used: number;
  duration_ms: number;
  verification_passed: boolean;
  verification_reason?: string;
  tool_call_count: number;
  failure_reason?: string;
  evidence_count: number;
  summary?: string;
  /** 验收来源：'executor'（缺省） / 'manual'（人工核对确认） */
  verified_by?: string;
}

export interface GateResultRecord {
  passed: boolean;
  stages_completed: string[];
  stages_failed: string[];
  details_json?: string;
  final_message: string;
}

export interface CreateTaskRunInput {
  user_prompt: string;
  plan_id?: string;
  session_id?: string;
  workspace: string;
  model: string;
  /** 隔离方式：默认原地执行 */
  isolation?: 'in_place' | 'worktree';
  /** 计划阶段已发生的指标，在创建 run 时与计划 ID 一起持久化 */
  metrics?: { toolCalls: number; modelCalls: number; totalTokens: number };
}

/** 对外暴露的 run 摘要（`forgex task list/show/diff/clean` 用） */
export interface TaskRunSummary {
  runId: string;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  status: TaskRunStatus;
  workspace: string;
  model: string;
  exitCode: number | null;
  finalMessage: string | null;
  durationMs: number | null;
  toolCalls: number;
  modelCalls: number;
  totalTokens: number;
  metricsSource: 'recorded' | 'partial' | 'backfilled_estimate' | 'unavailable';
  isolation: 'in_place' | 'worktree';
  worktreeRoot: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  baseCommit: string | null;
}

export interface WorktreeBinding {
  /** ForgeX 管理的 worktree 根目录（清理时用于核对归属） */
  root: string;
  path: string;
  branch: string;
  baseCommit: string;
}

const EXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_runs (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  plan_id TEXT,
  session_id TEXT,
  workspace TEXT NOT NULL,
  model TEXT NOT NULL,
  exit_code INTEGER,
  final_message TEXT,
  duration_ms INTEGER,
  tool_calls INTEGER DEFAULT 0,
  model_calls INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  metrics_source TEXT NOT NULL DEFAULT 'unknown',
  -- v0.5.6 可审阅 worktree：in_place（默认，原地执行） / worktree
  isolation TEXT NOT NULL DEFAULT 'in_place',
  worktree_root TEXT,
  worktree_path TEXT,
  worktree_branch TEXT,
  base_commit TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);

CREATE TABLE IF NOT EXISTS step_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  final_status TEXT NOT NULL,
  attempts_used INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  verification_passed INTEGER NOT NULL DEFAULT 0,
  verification_reason TEXT,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, step_id),
  FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_step_results_run ON step_results(run_id);

CREATE TABLE IF NOT EXISTS gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  stages_completed TEXT NOT NULL,
  stages_failed TEXT NOT NULL,
  details_json TEXT,
  final_message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_gate_results_run ON gate_results(run_id);
`;

type Row = Record<string, unknown>;

export class TaskRunStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.db.exec(EXT_SCHEMA);
    this.migrate();
    this.backfillHistoricalMetrics();
  }

  /**
   * 老库补齐 v0.5.6 新增列。
   * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，先读 table_info 再决定是否 ALTER。
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(task_runs)').all() as Row[]).map((r) => String(r.name)),
    );
    const additions: ReadonlyArray<[string, string]> = [
      ['isolation', "TEXT NOT NULL DEFAULT 'in_place'"],
      ['worktree_root', 'TEXT'],
      ['worktree_path', 'TEXT'],
      ['worktree_branch', 'TEXT'],
      ['base_commit', 'TEXT'],
      ['metrics_source', "TEXT NOT NULL DEFAULT 'unknown'"],
    ];
    for (const [name, ddl] of additions) {
      if (columns.has(name)) continue;
      this.db.exec(`ALTER TABLE task_runs ADD COLUMN ${name} ${ddl}`);
    }

    // v0.5.7：步骤验收来源。'executor'（默认，缺省不写） / 'manual'（人工核对确认）。
    // 恢复流程用它区分"机器验收通过"和"人拍板说完成了"。
    const stepColumns = new Set(
      (this.db.prepare('PRAGMA table_info(step_results)').all() as Row[]).map((r) => String(r.name)),
    );
    if (!stepColumns.has('verified_by')) {
      this.db.exec("ALTER TABLE step_results ADD COLUMN verified_by TEXT DEFAULT 'executor'");
    }
  }

  /**
   * Reconstruct legacy task metrics from durable step/gate records and session metrics.
   * Values are labeled as estimates because old runs did not persist task-level boundaries.
   */
  private backfillHistoricalMetrics(): void {
    const hasSessionMetrics = Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metrics'").get(),
    );
    const rows = this.db.prepare(
      `SELECT run_id, session_id, created_at, updated_at, plan_id
       FROM task_runs
       WHERE metrics_source = 'unknown' AND status NOT IN ('planned', 'running')`,
    ).all() as Row[];
    const update = this.db.prepare(
      `UPDATE task_runs
       SET tool_calls = ?, model_calls = ?, total_tokens = ?, metrics_source = 'backfilled_estimate'
       WHERE run_id = ? AND metrics_source = 'unknown'`,
    );
    const markUnavailable = this.db.prepare(
      `UPDATE task_runs SET metrics_source = 'unavailable'
       WHERE run_id = ? AND metrics_source = 'unknown'`,
    );
    const getSteps = this.db.prepare('SELECT tool_call_count FROM step_results WHERE run_id = ?');
    const getGates = this.db.prepare("SELECT details_json FROM gate_results WHERE run_id = ? AND kind = 'production'");
    const getMetrics = hasSessionMetrics
      ? this.db.prepare('SELECT ts, payload FROM metrics WHERE session_id = ? ORDER BY id ASC')
      : null;

    for (const row of rows) {
      const runId = String(row.run_id);
      const createdAt = String(row.created_at);
      const updatedAt = String(row.updated_at);
      let modelCalls = typeof row.plan_id === 'string' ? 1 : 0;
      let totalTokens = 0;
      let hasEvidence = modelCalls > 0;
      if (typeof row.session_id === 'string' && getMetrics) {
        for (const metricRow of getMetrics.all(row.session_id) as Row[]) {
          const ts = String(metricRow.ts);
          if (ts < createdAt || ts > updatedAt) continue;
          try {
            const metrics = JSON.parse(String(metricRow.payload)) as Record<string, unknown>;
            if (typeof metrics.modelCalls === 'number') modelCalls += metrics.modelCalls;
            if (typeof metrics.totalTokens === 'number') totalTokens += metrics.totalTokens;
            hasEvidence = true;
          } catch { /* skip malformed legacy rows */ }
        }
      }

      const stepRows = getSteps.all(runId) as Row[];
      const stepToolCalls = stepRows.reduce((sum, step) => sum + Number(step.tool_call_count ?? 0), 0);
      hasEvidence ||= stepRows.length > 0;
      let gateToolCalls = 0;
      for (const gate of getGates.all(runId) as Row[]) {
        if (typeof gate.details_json !== 'string') continue;
        try {
          const stages = JSON.parse(gate.details_json) as unknown;
          if (!Array.isArray(stages)) continue;
          gateToolCalls += stages.filter((stage) =>
            Boolean(stage && typeof stage === 'object' && 'command' in stage
              && typeof (stage as { command?: unknown }).command === 'string'
              && (stage as { command: string }).command.length > 0),
          ).length;
          hasEvidence = true;
        } catch { /* skip malformed legacy rows */ }
      }

      if (hasEvidence) update.run(stepToolCalls + gateToolCalls, modelCalls, totalTokens, runId);
      else markUnavailable.run(runId);
    }
  }
  /**
   * 在 TaskRunStore 的连接上开一个 CheckpointManager（共享同一 SQLite 文件，
   * 计划快照与 task_runs / step_results 天然同库，恢复诊断一次查全）。
   */
  createCheckpointManager(): CheckpointManager {
    return new CheckpointManager(this.db, { enableWal: false });
  }

  /** 直接读一条快照（已校验 schema/结构），供恢复诊断用 */
  loadCheckpoint(planId: string): CheckpointRecord | null {
    return this.createCheckpointManager().load(planId);
  }

  /** 保存一条快照（恢复/核对流程写回用） */
  saveCheckpoint(record: CheckpointRecord): void {
    this.createCheckpointManager().save(record);
  }

  /** 从 ForgeRuntime 的 store 直接拿底层 dbPath（如果需要共享同一个文件） */
  static fromRuntime(runtime: ForgeRuntime): TaskRunStore {
    // 复用同一个 SQLite 文件——SessionStore 构造时已经 mkdirSync + WAL
    // 通过 session.dbPath 拿路径（SessionStore 暴露了 getSession 等方法，但 dbPath 是私有的）
    // 我们用配置里的 session.dbPath 再开一次连接（SQLite WAL 支持并行读）
    const path = runtime.config.session.dbPath;
    return new TaskRunStore(path);
  }

  createRun(input: CreateTaskRunInput): string {
    const now = new Date().toISOString();
    const runId = `run_${Math.random().toString(36).slice(2, 10)}`;
    this.db
      .prepare(
        `INSERT INTO task_runs (
           run_id, created_at, updated_at, user_prompt, status, plan_id, session_id, workspace, model, isolation,
           tool_calls, model_calls, total_tokens, metrics_source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        now,
        now,
        input.user_prompt,
        'planned',
        input.plan_id ?? null,
        input.session_id ?? null,
        input.workspace,
        input.model,
        input.isolation ?? 'in_place',
        input.metrics?.toolCalls ?? 0,
        input.metrics?.modelCalls ?? 0,
        input.metrics?.totalTokens ?? 0,
        input.metrics ? 'recorded' : 'unknown',
      );
    return runId;
  }

  /** 记录 runId ↔ worktree 路径 / 分支 / 基线 commit 的映射（创建成功后立即写） */
  setWorktree(runId: string, binding: WorktreeBinding): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE task_runs SET isolation = 'worktree', worktree_root = ?, worktree_path = ?, worktree_branch = ?, base_commit = ?, updated_at = ? WHERE run_id = ?",
      )
      .run(binding.root, binding.path, binding.branch, binding.baseCommit, now, runId);
  }

  getRunSummary(runId: string): TaskRunSummary | null {
    const row = this.db.prepare('SELECT * FROM task_runs WHERE run_id = ?').get(runId) as Row | undefined;
    return row ? toSummary(row) : null;
  }

  listRuns(limit = 20): TaskRunSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM task_runs ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as Row[];
    return rows.map(toSummary);
  }

  updateRun(runId: string, patch: { status?: TaskRunStatus; plan_id?: string; session_id?: string; exit_code?: number; final_message?: string; duration_ms?: number; tool_calls?: number; model_calls?: number; total_tokens?: number }): void {
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: Array<string | number | null> = [now];
    if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status); }
    if (patch.plan_id !== undefined) { fields.push('plan_id = ?'); values.push(patch.plan_id ?? null); }
    if (patch.session_id !== undefined) { fields.push('session_id = ?'); values.push(patch.session_id ?? null); }
    if (patch.exit_code !== undefined) { fields.push('exit_code = ?'); values.push(patch.exit_code); }
    if (patch.final_message !== undefined) { fields.push('final_message = ?'); values.push(patch.final_message ?? null); }
    if (patch.duration_ms !== undefined) { fields.push('duration_ms = ?'); values.push(patch.duration_ms); }
    if (patch.tool_calls !== undefined) { fields.push('tool_calls = ?'); values.push(patch.tool_calls); }
    if (patch.model_calls !== undefined) { fields.push('model_calls = ?'); values.push(patch.model_calls); }
    if (patch.total_tokens !== undefined) { fields.push('total_tokens = ?'); values.push(patch.total_tokens); }
    if (patch.tool_calls !== undefined || patch.model_calls !== undefined || patch.total_tokens !== undefined) {
      fields.push("metrics_source = CASE WHEN metrics_source IN ('partial', 'backfilled_estimate') THEN metrics_source ELSE 'recorded' END");
    }
    values.push(runId);
    this.db.prepare(`UPDATE task_runs SET ${fields.join(', ')} WHERE run_id = ?`).run(...values);
  }

  getRun(runId: string): Row | null {
    const row = this.db.prepare('SELECT * FROM task_runs WHERE run_id = ?').get(runId) as Row | undefined;
    return row ?? null;
  }

  upsertStepResult(runId: string, step: StepResultRecord & { verified_by?: string }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO step_results (run_id, step_id, final_status, attempts_used, duration_ms, verification_passed, verification_reason, tool_call_count, failure_reason, evidence_count, summary, verified_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_id) DO UPDATE SET
           final_status = excluded.final_status,
           attempts_used = excluded.attempts_used,
           duration_ms = excluded.duration_ms,
           verification_passed = excluded.verification_passed,
           verification_reason = excluded.verification_reason,
           tool_call_count = excluded.tool_call_count,
           failure_reason = excluded.failure_reason,
           evidence_count = excluded.evidence_count,
           summary = excluded.summary,
           verified_by = excluded.verified_by`,
      )
      .run(
        runId,
        step.step_id,
        step.final_status,
        step.attempts_used,
        step.duration_ms,
        step.verification_passed ? 1 : 0,
        step.verification_reason ?? null,
        step.tool_call_count,
        step.failure_reason ?? null,
        step.evidence_count,
        step.summary ?? null,
        step.verified_by ?? 'executor',
        now,
      );
  }

  /** Persist the completed step and its task-level metrics atomically. */
  recordStepExecution(
    runId: string,
    step: StepResultRecord,
    metrics: { toolCalls: number; modelCalls: number; totalTokens: number },
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.upsertStepResult(runId, step);
      this.db.prepare(
        `UPDATE task_runs
         SET tool_calls = COALESCE(tool_calls, 0) + ?,
             model_calls = COALESCE(model_calls, 0) + ?,
             total_tokens = COALESCE(total_tokens, 0) + ?,
             metrics_source = CASE WHEN metrics_source IN ('partial', 'backfilled_estimate') THEN metrics_source ELSE 'recorded' END,
             updated_at = ?
         WHERE run_id = ?`,
      ).run(metrics.toolCalls, metrics.modelCalls, metrics.totalTokens, new Date().toISOString(), runId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Mark resumed totals as partial when an interrupted call may have ended before its metrics were returned. */
  markMetricsPartial(runId: string): void {
    this.db.prepare(
      `UPDATE task_runs SET metrics_source = 'partial', updated_at = ?
       WHERE run_id = ? AND metrics_source <> 'backfilled_estimate'`,
    ).run(new Date().toISOString(), runId);
  }

  listStepResults(runId: string): StepResultRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM step_results WHERE run_id = ? ORDER BY id ASC')
      .all(runId) as Row[];
    return rows.map((r) => ({
      step_id: String(r.step_id),
      final_status: String(r.final_status) as StepResultRecord['final_status'],
      attempts_used: Number(r.attempts_used),
      duration_ms: Number(r.duration_ms),
      verification_passed: Number(r.verification_passed) === 1,
      verification_reason: typeof r.verification_reason === 'string' ? r.verification_reason : undefined,
      tool_call_count: Number(r.tool_call_count),
      failure_reason: typeof r.failure_reason === 'string' ? r.failure_reason : undefined,
      evidence_count: Number(r.evidence_count),
      summary: typeof r.summary === 'string' ? r.summary : undefined,
      ...(typeof r.verified_by === 'string' ? { verified_by: r.verified_by } : {}),
    }));
  }

  insertGateResult(runId: string, kind: string, result: GateResultRecord): void {
    this.db
      .prepare(
        'INSERT INTO gate_results (run_id, kind, passed, stages_completed, stages_failed, details_json, final_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        runId,
        kind,
        result.passed ? 1 : 0,
        JSON.stringify(result.stages_completed),
        JSON.stringify(result.stages_failed),
        result.details_json ?? null,
        result.final_message,
        new Date().toISOString(),
      );
  }

  close(): void {
    this.db.close();
  }
}

function toSummary(row: Row): TaskRunSummary {
  const isolation = String(row.isolation ?? 'in_place') === 'worktree' ? 'worktree' : 'in_place';
  return {
    runId: String(row.run_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    prompt: String(row.user_prompt),
    status: String(row.status) as TaskRunStatus,
    workspace: String(row.workspace),
    model: String(row.model),
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    finalMessage: typeof row.final_message === 'string' ? row.final_message : null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    toolCalls: Number(row.tool_calls ?? 0),
    modelCalls: Number(row.model_calls ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    metricsSource: typeof row.metrics_source === 'string' && (row.metrics_source === 'recorded' || row.metrics_source === 'partial' || row.metrics_source === 'backfilled_estimate' || row.metrics_source === 'unavailable')
      ? row.metrics_source as TaskRunSummary['metricsSource']
      : 'unavailable',
    isolation,
    worktreeRoot: typeof row.worktree_root === 'string' ? row.worktree_root : null,
    worktreePath: typeof row.worktree_path === 'string' ? row.worktree_path : null,
    worktreeBranch: typeof row.worktree_branch === 'string' ? row.worktree_branch : null,
    baseCommit: typeof row.base_commit === 'string' ? row.base_commit : null,
  };
}
