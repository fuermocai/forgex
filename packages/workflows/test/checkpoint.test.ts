/**
 * WorkflowCheckpoint 测试（v0.4.0 Phase 1）。
 *
 * 使用 :memory: SQLite 数据库测试 save/load/delete。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowCheckpoint, buildCheckpointRecord } from '../src/runner/checkpoint.js';
import { createWorkflowNode, type WorkflowState } from '../src/types.js';

function createDb(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

describe('WorkflowCheckpoint', () => {
  let db: DatabaseSync;
  let checkpoint: WorkflowCheckpoint;

  beforeEach(() => {
    db = createDb();
    checkpoint = new WorkflowCheckpoint(db, { enableWal: false });
  });

  it('save 后 load 返回相同记录', () => {
    const nodes = [
      createWorkflowNode({ name: 'A', type: 'task', description: 'A' }),
      createWorkflowNode({
        name: 'B',
        type: 'verification',
        description: 'B',
        dependencies: ['A'],
        mandatory: true,
      }),
    ];
    nodes[0]!.status = 'completed';

    const record = buildCheckpointRecord({
      workflowInstanceId: 'wf-test-001',
      workflowId: 'bug-fix',
      workflowVersion: 1,
      nodes,
      state: 'running' as WorkflowState,
    });

    checkpoint.save(record);
    const loaded = checkpoint.load('wf-test-001');

    expect(loaded).not.toBeNull();
    expect(loaded?.workflow_instance_id).toBe('wf-test-001');
    expect(loaded?.workflow_id).toBe('bug-fix');
    expect(loaded?.workflow_version).toBe(1);
    expect(loaded?.nodes).toHaveLength(2);
    expect(loaded?.completed_node_ids).toContain(nodes[0]!.id);
  });

  it('load 不存在返回 null', () => {
    expect(checkpoint.load('nonexistent')).toBeNull();
  });

  it('delete 删除检查点', () => {
    const nodes = [createWorkflowNode({ name: 'A', type: 'task', description: 'A' })];
    const record = buildCheckpointRecord({
      workflowInstanceId: 'wf-del',
      workflowId: 'test',
      workflowVersion: 1,
      nodes,
      state: 'pending',
    });
    checkpoint.save(record);
    expect(checkpoint.load('wf-del')).not.toBeNull();

    checkpoint.delete('wf-del');
    expect(checkpoint.load('wf-del')).toBeNull();
  });

  it('save 覆盖已有记录', () => {
    const nodes1 = [createWorkflowNode({ name: 'A', type: 'task', description: 'A' })];
    const record1 = buildCheckpointRecord({
      workflowInstanceId: 'wf-cover',
      workflowId: 'test',
      workflowVersion: 1,
      nodes: nodes1,
      state: 'pending',
    });
    checkpoint.save(record1);

    const nodes2 = [
      createWorkflowNode({ name: 'A', type: 'task', description: 'A' }),
      createWorkflowNode({
        name: 'B',
        type: 'verification',
        description: 'B',
        mandatory: true,
      }),
    ];
    const record2 = buildCheckpointRecord({
      workflowInstanceId: 'wf-cover',
      workflowId: 'test',
      workflowVersion: 1,
      nodes: nodes2,
      state: 'running',
    });
    checkpoint.save(record2);

    const loaded = checkpoint.load('wf-cover');
    expect(loaded?.nodes).toHaveLength(2);
  });

  it('listIds 返回所有检查点 ID', () => {
    const node = createWorkflowNode({ name: 'A', type: 'task', description: 'A' });
    for (const id of ['wf-1', 'wf-2', 'wf-3']) {
      checkpoint.save(
        buildCheckpointRecord({
          workflowInstanceId: id,
          workflowId: 'test',
          workflowVersion: 1,
          nodes: [node],
          state: 'pending',
        }),
      );
    }
    const ids = checkpoint.listIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain('wf-1');
    expect(ids).toContain('wf-2');
    expect(ids).toContain('wf-3');
  });

  it('buildCheckpointRecord 正确计算 completed/running/failed 集合', () => {
    const a = createWorkflowNode({ name: 'A', type: 'task', description: 'A' });
    a.status = 'completed';
    const b = createWorkflowNode({ name: 'B', type: 'task', description: 'B' });
    b.status = 'running';
    const c = createWorkflowNode({ name: 'C', type: 'task', description: 'C' });
    c.status = 'failed';

    const record = buildCheckpointRecord({
      workflowInstanceId: 'wf-sets',
      workflowId: 'test',
      workflowVersion: 1,
      nodes: [a, b, c],
      state: 'running',
    });

    expect(record.completed_node_ids).toContain(a.id);
    expect(record.running_node_id).toBe(b.id);
    expect(record.failed_node_ids).toContain(c.id);
  });
});
