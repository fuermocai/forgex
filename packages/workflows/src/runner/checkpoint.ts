/**
 * WorkflowCheckpoint：工作流快照持久化与崩溃恢复（v0.4.0 Phase 1）。
 *
 * 存储策略（复用 v0.3.0 CheckpointManager 模式）：
 *   - 整个 WorkflowCheckpointRecord 存单个 JSON blob 列（payload TEXT）；
 *   - 接受 DatabaseSync 实例作为 DI；
 *   - 表结构：workflow_checkpoints(workflow_instance_id TEXT PK, snapshot_at TEXT, payload TEXT)。
 *
 * 持久化时机（由 WorkflowRunner 调用）：
 *   - 执行节点前先保存 running，节点结束后再保存最终状态；
 *   - 工作流取消时；
 *   - 恢复时校验定义版本与节点集合；遇到 running 节点时暂停，避免重复副作用。
 */
import { DatabaseSync } from 'node:sqlite';
import { ForgeError } from '@forgex/shared';
import type { WorkflowCheckpointRecord } from '../types.js';
import { workflowNowIso } from '../types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  workflow_instance_id TEXT PRIMARY KEY,
  snapshot_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
`;

export interface WorkflowCheckpointOptions {
  /** 允许使用 WAL 模式 */
  enableWal?: boolean;
}

export class WorkflowCheckpoint {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, options: WorkflowCheckpointOptions = {}) {
    this.db = db;
    if (options.enableWal) {
      try {
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA busy_timeout = 3000');
      } catch {
        // WAL 设置失败不阻塞
      }
    }
    try {
      this.db.exec(SCHEMA);
    } catch (err) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', '无法初始化 workflow checkpoint 表', {
        cause: err,
      });
    }
  }

  /**
   * 保存（覆盖）一个工作流实例的 checkpoint。
   * WorkflowRunner 在每个节点状态变化后调用。
   */
  save(record: WorkflowCheckpointRecord): void {
    try {
      const payload = JSON.stringify(record);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO workflow_checkpoints
           (workflow_instance_id, snapshot_at, payload)
           VALUES (?, ?, ?)`,
        )
        .run(record.workflow_instance_id, record.snapshot_at, payload);
    } catch (err) {
      throw new ForgeError(
        'PLANNING_CHECKPOINT_ERROR',
        `写入 workflow checkpoint 失败: ${record.workflow_instance_id}`,
        { cause: err, details: { workflowInstanceId: record.workflow_instance_id } },
      );
    }
  }

  /**
   * 加载一个工作流实例的 checkpoint。
   * 不存在返回 null。
   */
  load(workflowInstanceId: string): WorkflowCheckpointRecord | null {
    try {
      const row = this.db
        .prepare('SELECT payload FROM workflow_checkpoints WHERE workflow_instance_id = ?')
        .get(workflowInstanceId) as { payload: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.payload) as WorkflowCheckpointRecord;
    } catch (err) {
      throw new ForgeError(
        'PLANNING_CHECKPOINT_ERROR',
        `读取 workflow checkpoint 失败: ${workflowInstanceId}`,
        { cause: err, details: { workflowInstanceId } },
      );
    }
  }

  /** 删除一个工作流实例的 checkpoint */
  delete(workflowInstanceId: string): void {
    try {
      this.db
        .prepare('DELETE FROM workflow_checkpoints WHERE workflow_instance_id = ?')
        .run(workflowInstanceId);
    } catch (err) {
      throw new ForgeError(
        'PLANNING_CHECKPOINT_ERROR',
        `删除 workflow checkpoint 失败: ${workflowInstanceId}`,
        { cause: err, details: { workflowInstanceId } },
      );
    }
  }

  /** 列出所有 checkpoint 的 workflow_instance_id */
  listIds(): string[] {
    try {
      const rows = this.db
        .prepare('SELECT workflow_instance_id FROM workflow_checkpoints')
        .all() as Array<{ workflow_instance_id: string }>;
      return rows.map((r) => r.workflow_instance_id);
    } catch (err) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', '列出 workflow checkpoint 失败', {
        cause: err,
      });
    }
  }
}

/**
 * 从节点列表构造 WorkflowCheckpointRecord。
 * WorkflowRunner 在保存检查点时调用。
 */
export function buildCheckpointRecord(params: {
  workflowInstanceId: string;
  workflowId: string;
  workflowVersion: number;
  nodes: WorkflowCheckpointRecord['nodes'];
  state: WorkflowCheckpointRecord['state'];
}): WorkflowCheckpointRecord {
  const completedNodeIds = params.nodes.filter((n) => n.status === 'completed').map((n) => n.id);
  const failedNodeIds = params.nodes.filter((n) => n.status === 'failed').map((n) => n.id);
  const runningNode = params.nodes.find((n) => n.status === 'running');

  return {
    workflow_instance_id: params.workflowInstanceId,
    workflow_id: params.workflowId,
    workflow_version: params.workflowVersion,
    snapshot_at: workflowNowIso(),
    nodes: params.nodes,
    state: params.state,
    completed_node_ids: completedNodeIds,
    running_node_id: runningNode?.id,
    failed_node_ids: failedNodeIds,
  };
}
