/**
 * CheckpointStore：恢复检查点存储（v0.4.0 Phase 6）。
 *
 * 基于 SQLite 持久化检查点。
 * 包含环境快照和权限策略版本，用于恢复前兼容性校验。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { EnvironmentSnapshot, RecoveryCheckpoint } from '../types.js';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS recovery_checkpoints (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    current_step_id TEXT NOT NULL,
    completed_steps TEXT NOT NULL,
    environment_snapshot TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    idempotency_keys TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_checkpoint_run ON recovery_checkpoints(workflow_run_id)`;

export class CheckpointStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(CREATE_TABLE);
    db.exec(CREATE_INDEX);
  }

  /** 创建检查点 */
  create(params: {
    workflowRunId: string;
    workflowId: string;
    currentStepId: string;
    completedSteps: string[];
    environmentSnapshot: EnvironmentSnapshot;
    policyVersion: string;
    idempotencyKeys: string[];
  }): RecoveryCheckpoint {
    const now = new Date().toISOString();
    const checkpoint: RecoveryCheckpoint = {
      id: randomUUID(),
      workflowRunId: params.workflowRunId,
      workflowId: params.workflowId,
      currentStepId: params.currentStepId,
      completedSteps: params.completedSteps,
      environmentSnapshot: params.environmentSnapshot,
      policyVersion: params.policyVersion,
      idempotencyKeys: params.idempotencyKeys,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO recovery_checkpoints
         (id, workflow_run_id, workflow_id, current_step_id, completed_steps,
          environment_snapshot, policy_version, idempotency_keys, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.id,
        checkpoint.workflowRunId,
        checkpoint.workflowId,
        checkpoint.currentStepId,
        JSON.stringify(checkpoint.completedSteps),
        JSON.stringify(checkpoint.environmentSnapshot),
        checkpoint.policyVersion,
        JSON.stringify(checkpoint.idempotencyKeys),
        checkpoint.createdAt,
        checkpoint.updatedAt,
      );

    return checkpoint;
  }

  /** 更新检查点 */
  update(id: string, updates: Partial<Pick<RecoveryCheckpoint, 'currentStepId' | 'completedSteps' | 'idempotencyKeys'>>): void {
    const existing = this.get(id);
    if (!existing) return;

    const merged: RecoveryCheckpoint = {
      ...existing,
      currentStepId: updates.currentStepId ?? existing.currentStepId,
      completedSteps: updates.completedSteps ?? existing.completedSteps,
      idempotencyKeys: updates.idempotencyKeys ?? existing.idempotencyKeys,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE recovery_checkpoints
         SET current_step_id = ?, completed_steps = ?, idempotency_keys = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.currentStepId,
        JSON.stringify(merged.completedSteps),
        JSON.stringify(merged.idempotencyKeys),
        merged.updatedAt,
        id,
      );
  }

  /** 获取检查点 */
  get(id: string): RecoveryCheckpoint | null {
    const row = this.db
      .prepare('SELECT * FROM recovery_checkpoints WHERE id = ?')
      .get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapRow(row);
  }

  /** 按 workflow run id 获取最新检查点 */
  getLatestByRun(workflowRunId: string): RecoveryCheckpoint | null {
    const row = this.db
      .prepare('SELECT * FROM recovery_checkpoints WHERE workflow_run_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(workflowRunId) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapRow(row);
  }

  /** 列出所有检查点 */
  list(): RecoveryCheckpoint[] {
    const rows = this.db
      .prepare('SELECT * FROM recovery_checkpoints ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(this.mapRow);
  }

  /** 删除检查点 */
  delete(id: string): void {
    this.db.prepare('DELETE FROM recovery_checkpoints WHERE id = ?').run(id);
  }

  private mapRow(row: Record<string, unknown>): RecoveryCheckpoint {
    return {
      id: String(row.id),
      workflowRunId: String(row.workflow_run_id),
      workflowId: String(row.workflow_id),
      currentStepId: String(row.current_step_id),
      completedSteps: JSON.parse(String(row.completed_steps)) as string[],
      environmentSnapshot: JSON.parse(String(row.environment_snapshot)) as EnvironmentSnapshot,
      policyVersion: String(row.policy_version),
      idempotencyKeys: JSON.parse(String(row.idempotency_keys)) as string[],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
