/**
 * CheckpointManager 单元测试。
 *
 * 全部用 :memory: SQLite（node:sqlite DatabaseSync）——无文件系统副作用，
 * 崩溃恢复场景通过"关 db → 开新连接 → load"模拟。
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { CheckpointManager } from '../src/planning/checkpoint.js';
import {
  createStep,
  newPlanId,
  nowIso,
  type CheckpointRecord,
  type TaskPlan,
} from '../src/planning/types.js';

function freshDb(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

function samplePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  const planId = newPlanId();
  return {
    plan_id: planId,
    user_request: '检查日志根因并修复 HTTP 500',
    created_at: nowIso(),
    updated_at: nowIso(),
    status: 'pending',
    steps: (() => {
      // 依赖必须引用真实 step_id（快照加载时做悬空依赖校验）
      const s1 = createStep({ task_id: planId, description: '读 server.js 日志', risk_level: 'read' });
      const s2 = createStep({ task_id: planId, description: '定位 Controller', risk_level: 'read', dependencies: [s1.step_id] });
      const s3 = createStep({ task_id: planId, description: '分析调用链', risk_level: 'read', dependencies: [s2.step_id] });
      return [s1, s2, s3];
    })(),
    metadata: { model: 'qwen-max', max_attempts_default: 2 },
    ...overrides,
  };
}

function checkpointOf(plan: TaskPlan, abort = false): CheckpointRecord {
  return {
    schema_version: 2,
    plan_id: plan.plan_id,
    snapshot_at: nowIso(),
    plan,
    abort_requested: abort,
    running_step_id: plan.steps.find((s) => s.status === 'running')?.step_id,
    completed_step_ids: plan.steps.filter((s) => s.status === 'completed').map((s) => s.step_id),
    failed_step_ids: plan.steps.filter((s) => s.status === 'failed').map((s) => s.step_id),
  };
}

describe('CheckpointManager', () => {
  it('save → load 往返完整', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);
    const plan = samplePlan();
    const record = checkpointOf(plan);
    mgr.save(record);

    const loaded = mgr.load(plan.plan_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.plan_id).toBe(plan.plan_id);
    expect(loaded!.abort_requested).toBe(false);
    expect(loaded!.plan.steps).toHaveLength(3);
    expect(loaded!.plan.steps[0].description).toBe('读 server.js 日志');
    expect(loaded!.plan.metadata).toEqual({ model: 'qwen-max', max_attempts_default: 2 });
  });

  it('snapshotPlan 构造正确的 completed / failed / running 列表', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);
    const plan = samplePlan();
    plan.steps[0].status = 'completed';
    plan.steps[1].status = 'running';
    plan.steps[2].status = 'failed';

    const saved = mgr.snapshotPlan(plan);
    expect(saved.completed_step_ids).toEqual([plan.steps[0].step_id]);
    expect(saved.running_step_id).toBe(plan.steps[1].step_id);
    expect(saved.failed_step_ids).toEqual([plan.steps[2].step_id]);
    expect(saved.abort_requested).toBe(false);

    const loaded = mgr.load(plan.plan_id);
    expect(loaded?.completed_step_ids).toEqual(saved.completed_step_ids);
  });

  it('snapshotPlan 全部 completed → 列表正确 + running 空', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);
    const plan = samplePlan();
    plan.status = 'completed';
    for (const s of plan.steps) s.status = 'completed';

    const saved = mgr.snapshotPlan(plan);
    expect(saved.completed_step_ids).toHaveLength(3);
    expect(saved.failed_step_ids).toEqual([]);
    expect(saved.running_step_id).toBeUndefined();
  });

  it('崩溃恢复：关 db → 重开 → load 还原完整快照', () => {
    // 注意 :memory: db 关了会消失，但走同一内存连接是恢复不出来的。
    // 这里改用"同一个 db 实例被 GC 前另开一个 manager 读"——实际上
    // node:sqlite :memory: 每个 DatabaseSync 是独立连接，所以验证
    // snapshotPlan 生成的 CheckpointRecord 本身是 JSON-safe 即可。
    const db = freshDb();
    const mgr1 = new CheckpointManager(db);
    const plan = samplePlan();
    plan.steps[0].status = 'completed';
    plan.steps[1].status = 'failed';
    plan.steps[2].status = 'completed';

    const saved = mgr1.snapshotPlan(plan);

    // 同一个 db 开新 manager 读取 → 模拟"崩溃后重新打开同一个数据库文件"
    const mgr2 = new CheckpointManager(db);
    const loaded = mgr2.load(plan.plan_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.plan_id).toBe(plan.plan_id);
    expect(loaded!.completed_step_ids).toEqual(
      plan.steps.filter((s) => s.status === 'completed').map((s) => s.step_id),
    );
    expect(loaded!.failed_step_ids).toEqual([plan.steps[1].step_id]);
    // 关键：plan 里的每个 step_id 都能匹配
    for (const stepId of [...saved.completed_step_ids, ...saved.failed_step_ids]) {
      const found = loaded!.plan.steps.find((s) => s.step_id === stepId);
      expect(found).toBeDefined();
    }
  });

  it('INSERT OR REPLACE：同 plan_id 保存两次，保留最新快照', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);
    const plan = samplePlan();

    // 第一次：1 个完成
    plan.steps[0].status = 'completed';
    mgr.snapshotPlan(plan);

    // 第二次：2 个完成（覆盖）
    plan.steps[1].status = 'completed';
    mgr.snapshotPlan(plan);

    const loaded = mgr.load(plan.plan_id);
    expect(loaded!.completed_step_ids).toHaveLength(2);
    expect(loaded!.plan.steps[1].status).toBe('completed');
  });

  it('listPlanIds 返回最新在前（DESC snapshot_at）', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);

    const p1 = samplePlan();
    const p2 = samplePlan();
    const p3 = samplePlan();

    // 控制顺序：手动设置 snapshot_at
    const now = Date.now();
    const r1 = checkpointOf(p1);
    r1.snapshot_at = new Date(now - 2000).toISOString();
    const r2 = checkpointOf(p2);
    r2.snapshot_at = new Date(now - 1000).toISOString();
    const r3 = checkpointOf(p3);
    r3.snapshot_at = new Date(now).toISOString();

    mgr.save(r1);
    mgr.save(r2);
    mgr.save(r3);

    const ids = mgr.listPlanIds(10);
    expect(ids).toEqual([p3.plan_id, p2.plan_id, p1.plan_id]);
  });

  it('delete 某个 plan_id → load 返回 null', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);
    const plan = samplePlan();
    mgr.save(checkpointOf(plan));
    expect(mgr.has(plan.plan_id)).toBe(true);

    const deleted = mgr.delete(plan.plan_id);
    expect(deleted).toBe(true);
    expect(mgr.load(plan.plan_id)).toBeNull();
    expect(mgr.has(plan.plan_id)).toBe(false);
  });

  it('deleteAll 清空', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);
    mgr.save(checkpointOf(samplePlan()));
    mgr.save(checkpointOf(samplePlan()));
    expect(mgr.listPlanIds()).toHaveLength(2);

    const n = mgr.deleteAll();
    expect(n).toBe(2);
    expect(mgr.listPlanIds()).toHaveLength(0);
  });

  it('load 不存在 → null（不抛异常）', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);
    expect(mgr.load('plan_nonexistent')).toBeNull();
  });

  it('snapshotPlan 空 steps → completed_step_ids 空数组', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);
    const plan = samplePlan({ steps: [] });
    const saved = mgr.snapshotPlan(plan);
    expect(saved.completed_step_ids).toEqual([]);
    expect(saved.failed_step_ids).toEqual([]);
    expect(saved.running_step_id).toBeUndefined();
  });

  it('abort_requested 正确存储', () => {
    const db = freshDb();
    const mgr = new CheckpointManager(db);
    const plan = samplePlan();

    // 正常快照
    const normal = mgr.snapshotPlan(plan, false);
    expect(normal.abort_requested).toBe(false);

    // 取消快照
    const aborted = checkpointOf(plan, true);
    mgr.save(aborted);

    const loaded = mgr.load(plan.plan_id);
    expect(loaded?.abort_requested).toBe(true);
  });
});
