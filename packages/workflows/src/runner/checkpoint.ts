/**
 * WorkflowCheckpoint：工作流快照持久化与崩溃恢复（v0.4.0 Phase 1）。
 *
 * 工作流快照通过共享 JSONL 事件流追加保存，删除也保留历史事件。
 *
 * 持久化时机（由 WorkflowRunner 调用）：
 *   - 执行节点前先保存 running，节点结束后再保存最终状态；
 *   - 工作流取消时；
 *   - 恢复时校验定义版本与节点集合；遇到 running 节点时暂停，避免重复副作用。
 */
import { ForgeError, JsonlEventStore } from '@forgex/shared';
import type { WorkflowCheckpointRecord } from '../types.js';
import { workflowNowIso } from '../types.js';

export class WorkflowCheckpoint {
  private readonly events: JsonlEventStore;

  constructor(events: JsonlEventStore) { this.events = events; }

  /**
   * 保存（覆盖）一个工作流实例的 checkpoint。
   * WorkflowRunner 在每个节点状态变化后调用。
   */
  save(record: WorkflowCheckpointRecord): void {
    try {
      const parent = this.events.readAll().findLast((event) => event.data.workflowInstanceId === record.workflow_instance_id);
      this.events.append('workflow.checkpoint.saved', { workflowInstanceId: record.workflow_instance_id, record }, parent?.id ?? null);
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
      let record: WorkflowCheckpointRecord | null = null;
      for (const event of this.events.readAll()) {
        if (event.data.workflowInstanceId !== workflowInstanceId) continue;
        if (event.type === 'workflow.checkpoint.saved' && event.data.record && typeof event.data.record === 'object' && !Array.isArray(event.data.record)) {
          record = event.data.record as WorkflowCheckpointRecord;
        }
        if (event.type === 'workflow.checkpoint.deleted') record = null;
      }
      return record;
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
      const parent = this.events.readAll().findLast((event) => event.data.workflowInstanceId === workflowInstanceId);
      this.events.append('workflow.checkpoint.deleted', { workflowInstanceId }, parent?.id ?? null);
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
      const latest = new Map<string, boolean>();
      for (const event of this.events.readAll()) {
        if (typeof event.data.workflowInstanceId !== 'string') continue;
        if (event.type === 'workflow.checkpoint.saved') latest.set(event.data.workflowInstanceId, true);
        if (event.type === 'workflow.checkpoint.deleted') latest.set(event.data.workflowInstanceId, false);
      }
      return [...latest.entries()].filter(([, exists]) => exists).map(([id]) => id);
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
