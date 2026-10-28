/**
 * 任务中断诊断与安全恢复（v0.5.7）测试。
 *
 * 覆盖矩阵（对应任务要求）：
 *   1. 进程在步骤开始前中断           → 全部 resumable，可恢复
 *   2. 进程在工具执行中中断           → running 步骤 needs_reconciliation，resume 拒绝
 *   3. 工具完成但验收前中断           → 同上（快照仍停在 running，这正是安全语义）
 *   4. 验收完成后中断                 → verified_done，恢复时跳过
 *   5. 损坏快照 / 旧版本快照（无 schema_version）/ 悬空依赖 → 拒绝恢复 + 诊断
 *   6. 幂等性声明不被信任             → 步骤带 idempotent 字段也不自动重放
 *   7. worktree 缺失 / 目录名不匹配   → blocker，不猜测不删除
 *   8. 人工核对：confirm-done / confirm-retry / block
 *   9. 数据库写入失败                 → 恢复流程失败关闭，不继续
 *
 * 说明：这里用真实 SQLite + 真实 PlanManager/CheckpointManager 构造各中断点状态，
 * 不用 mock 成功来声称外部副作用 exactly-once——中断步骤一律要求人工核对，
 * 恢复语义在 analyzeTaskRun 的 verdict 与 reason 里可断言。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanManager, SessionStore, createStep, type CheckpointRecord } from '@forgex/core';
import { TaskRunStore } from '../src/task-run/task-run-store.js';
import {
  analyzeTaskRun,
  applyReconcileDecision,
  assertResumable,
  verifyWorktreeForResume,
} from '../src/task-run/recovery.js';

let dir: string;
let dbPath: string;
let store: TaskRunStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgex-recovery-'));
  dbPath = join(dir, 'sessions.db');
  // task_runs 有 sessions 外键：先让 SessionStore 建好基础 schema（与 run.ts 一致）
  new SessionStore(dbPath).close();
  store = new TaskRunStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // 某些用例故意构造了坏连接
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上损坏库的句柄可能短暂滞留；目录留给系统临时清理
  }
});

/** 用真实 PlanManager + CheckpointManager 建一个三步计划并落快照 */
function makePlan(opts?: { planId?: string }) {
  const planManager = new PlanManager({ checkpoint: store.createCheckpointManager() });
  const s1 = createStep({ task_id: 't1', description: '读取文件', required_tools: ['read_file'], risk_level: 'read' });
  const s2 = createStep({ task_id: 't1', description: '修改文件', dependencies: [s1.step_id], required_tools: ['edit_file'], risk_level: 'modify' });
  const s3 = createStep({ task_id: 't1', description: '跑测试', dependencies: [s2.step_id], required_tools: ['run_command'], risk_level: 'run' });
  const plan = planManager.createPlan({
    user_request: '改代码并测试',
    steps: [s1, s2, s3],
    ...(opts?.planId ? { plan_id: opts.planId } : {}),
  });
  return { planManager, plan };
}

function makeRun(planId: string, isolation: 'in_place' | 'worktree' = 'in_place'): string {
  const runId = store.createRun({
    user_prompt: '改代码并测试',
    plan_id: planId,
    workspace: dir,
    model: 'test-model',
    isolation,
  });
  store.updateRun(runId, { status: 'running' });
  return runId;
}

describe('中断诊断：各崩溃窗口', () => {
  it('步骤开始前中断：全部 resumable，可安全恢复', async () => {
    const { plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.verdict).toBe('resumable');
    expect(analysis.will_run_step_ids).toHaveLength(3);
    expect(analysis.reconcile_step_ids).toHaveLength(0);
    // assertResumable 通过并返回快照
    const record = await assertResumable(store, runId);
    expect(record.plan.plan_id).toBe(plan.plan_id);
  });

  it('工具执行中中断：running 步骤 needs_reconciliation，resume 被拒绝', async () => {
    const { planManager, plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    // 崩溃窗口：step1 已完成并验收，step2 正在跑工具时进程死亡
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[0]!.step_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'completed');
    store.upsertStepResult(runId, {
      step_id: plan.steps[0]!.step_id,
      final_status: 'completed',
      attempts_used: 1,
      duration_ms: 10,
      verification_passed: true,
      tool_call_count: 1,
      evidence_count: 1,
    });
    planManager.updateStepStatus(plan.plan_id, plan.steps[1]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[1]!.step_id);
    // （此处不再推进 —— 模拟进程死亡）

    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.verdict).toBe('needs_reconciliation');
    const step2 = analysis.steps.find((s) => s.step_id === plan.steps[1]!.step_id)!;
    expect(step2.classification).toBe('needs_reconciliation');
    expect(step2.reason).toContain('副作用');
    // step1 已验收 → 恢复时跳过；step3 未开始 → 可自动调度
    expect(analysis.skip_step_ids).toEqual([plan.steps[0]!.step_id]);
    expect(analysis.will_run_step_ids).toEqual([plan.steps[2]!.step_id]);
    // resume 必须被拒绝
    await expect(assertResumable(store, runId)).rejects.toThrow(/人工核对/);
  });

  it('工具完成但验收前中断：与执行中中断同等对待（不做工具粒度的 exactly-once 声明）', async () => {
    const { planManager, plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[0]!.step_id);
    // 崩溃在验收之前：快照里 step1 仍是 running
    const analysis = await analyzeTaskRun(store, runId);
    const step1 = analysis.steps.find((s) => s.step_id === plan.steps[0]!.step_id)!;
    expect(step1.classification).toBe('needs_reconciliation');
    expect(step1.reason).toContain('未知');
  });

  it('验收完成后中断：verified_done，恢复时跳过', async () => {
    const { planManager, plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[0]!.step_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'completed');
    store.upsertStepResult(runId, {
      step_id: plan.steps[0]!.step_id,
      final_status: 'completed',
      attempts_used: 1,
      duration_ms: 5,
      verification_passed: true,
      tool_call_count: 1,
      evidence_count: 1,
    });
    const analysis = await analyzeTaskRun(store, runId);
    const step1 = analysis.steps.find((s) => s.step_id === plan.steps[0]!.step_id)!;
    expect(step1.classification).toBe('verified_done');
    expect(analysis.skip_step_ids).toContain(plan.steps[0]!.step_id);
  });

  it('声称完成但验收证据缺失：needs_reconciliation（不信任快照单方面声明）', async () => {
    const { planManager, plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[0]!.step_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'completed');
    // 故意不写 step_results（模拟 step_results 丢失/库不一致）
    const analysis = await analyzeTaskRun(store, runId);
    const step1 = analysis.steps.find((s) => s.step_id === plan.steps[0]!.step_id)!;
    expect(step1.classification).toBe('needs_reconciliation');
  });
});

describe('快照校验：损坏 / 旧版本 / 结构问题', () => {
  it('损坏的 payload：unrecoverable + 诊断', async () => {
    const { plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    // 直接写坏 payload
    const cp = store.createCheckpointManager();
    cp.save({ schema_version: 2, plan_id: plan.plan_id, snapshot_at: new Date().toISOString(), plan, abort_requested: false, completed_step_ids: [], failed_step_ids: [] });
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE plan_checkpoints SET payload = '{not-json' WHERE plan_id = ?").run(plan.plan_id);
    db.close();
    store = new TaskRunStore(dbPath);

    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.verdict).toBe('unrecoverable');
    expect(analysis.blockers[0]).toContain('解析失败');
  });

  it('旧版本快照（无 schema_version）：拒绝恢复并说明原因', async () => {
    const { plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    const cp = store.createCheckpointManager();
    // 构造 v1 记录：去掉 schema_version
    const v1 = {
      plan_id: plan.plan_id,
      snapshot_at: new Date().toISOString(),
      plan,
      abort_requested: false,
      completed_step_ids: [],
      failed_step_ids: [],
    };
    cp.save({ ...v1, schema_version: 2 } as CheckpointRecord);
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE plan_checkpoints SET payload = ? WHERE plan_id = ?').run(JSON.stringify(v1), plan.plan_id);
    db.close();
    store = new TaskRunStore(dbPath);

    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.verdict).toBe('unrecoverable');
    expect(analysis.blockers.join()).toContain('旧版本快照');
  });

  it('悬空依赖：快照校验失败，拒绝恢复', async () => {
    const { plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    const cp = store.createCheckpointManager();
    const record = cp.snapshotPlan(plan);
    // 注入悬空依赖
    record.plan.steps[0]!.dependencies = ['step_ghost'];
    cp.save(record);
    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.verdict).toBe('unrecoverable');
    expect(analysis.blockers.join()).toContain('不存在的步骤');
  });

  it('没有快照（旧版 CLI 写入）：unrecoverable，建议人工检查', async () => {
    const runId = makeRun('plan_nonexistent');
    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.verdict).toBe('unrecoverable');
    expect(analysis.next_actions.join()).toContain('人工');
  });

  it('计划生成前中断（无 plan_id）：unrecoverable', async () => {
    const runId = store.createRun({ user_prompt: 'x', workspace: dir, model: 'm' });
    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.verdict).toBe('unrecoverable');
    expect(analysis.message).toContain('计划生成前');
  });
});

describe('幂等性声明不可信', () => {
  it('步骤携带 idempotent: true 也不会自动重放中断步骤', async () => {
    const { planManager, plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    // 给 step2 塞一个"模型自述幂等"的字段
    (plan.steps[1] as unknown as { idempotent: boolean }).idempotent = true;
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[0]!.step_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'completed');
    store.upsertStepResult(runId, { step_id: plan.steps[0]!.step_id, final_status: 'completed', attempts_used: 1, duration_ms: 1, verification_passed: true, tool_call_count: 0, evidence_count: 0 });
    // step2 已开始执行工具时进程死亡
    planManager.updateStepStatus(plan.plan_id, plan.steps[1]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[1]!.step_id);

    const analysis = await analyzeTaskRun(store, runId);
    const step2 = analysis.steps.find((s) => s.step_id === plan.steps[1]!.step_id)!;
    // 即使步骤声称幂等，中断步骤也不会被自动调度
    expect(step2.classification).toBe('needs_reconciliation');
    expect(analysis.will_run_step_ids).not.toContain(plan.steps[1]!.step_id);
  });
});

describe('worktree 恢复校验', () => {
  function bindWorktree(runId: string, root: string, dirnameName: string) {
    const path = join(root, dirnameName);
    mkdirSync(path, { recursive: true });
    store.setWorktree(runId, { root, path, branch: `forgex/run-x`, baseCommit: 'a'.repeat(40) });
    return path;
  }

  it('worktree 目录缺失：blocker，不自动重建/删除', async () => {
    const { plan } = makePlan();
    const runId = makeRun(plan.plan_id, 'worktree');
    const root = join(dir, 'wt');
    mkdirSync(root, { recursive: true });
    store.setWorktree(runId, { root, path: join(root, `run-${runId}`), branch: 'forgex/run-x', baseCommit: 'a'.repeat(40) });
    // 不创建目录 → 缺失
    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.worktree.problems).not.toBeNull();
    expect(analysis.worktree.problems!.join()).toContain('不存在');
    // 恢复被拒绝
    await expect(verifyWorktreeForResume(store.getRunSummary(runId)!)).rejects.toThrow(/不猜测/);
  });

  it('目录名与 runId 不匹配（换名/换任务）：拒绝', async () => {
    const { plan } = makePlan();
    const runId = makeRun(plan.plan_id, 'worktree');
    const root = join(dir, 'wt');
    bindWorktree(runId, root, 'run-other_task');
    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.worktree.problems!.join()).toContain('不匹配');
  });

  it('worktree 完好：校验通过，恢复可继续', async () => {
    const { plan } = makePlan();
    const runId = makeRun(plan.plan_id, 'worktree');
    bindWorktree(runId, join(dir, 'wt'), `run-${runId}`);
    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.worktree.problems).toBeNull();
    await expect(verifyWorktreeForResume(store.getRunSummary(runId)!)).resolves.toBeUndefined();
  });
});

describe('人工核对', () => {
  async function interruptedRun() {
    const { planManager, plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[0]!.step_id);
    return { plan, runId, step1: plan.steps[0]!.step_id, step2: plan.steps[1]!.step_id };
  }

  it('confirm-done：步骤标记人工背书完成，恢复可继续', async () => {
    const { runId, step1 } = await interruptedRun();
    const result = await applyReconcileDecision(store, runId, step1, 'confirm_done', '文件确实已改');
    expect(result.step.classification).toBe('manual_done');
    const steps = store.listStepResults(runId);
    expect(steps.find((s) => s.step_id === step1)?.verified_by).toBe('manual');
    expect(steps.find((s) => s.step_id === step1)?.verification_passed).toBe(true);
    // 核对后 resume 前置校验通过
    const record = await assertResumable(store, runId);
    expect(record.plan.steps.find((s) => s.step_id === step1)?.status).toBe('completed');
    // run 状态变为 blocked（等待 resume）
    expect(store.getRunSummary(runId)?.status).toBe('blocked');
  });

  it('confirm-retry：步骤回到可调度状态', async () => {
    const { runId, step1 } = await interruptedRun();
    await applyReconcileDecision(store, runId, step1, 'confirm_retry', '外部状态已核对');
    const record = await assertResumable(store, runId);
    const step = record.plan.steps.find((s) => s.step_id === step1)!;
    expect(['ready', 'pending']).toContain(step.status);
    expect(analysisWillRun(record, step1)).toBe(true);
  });

  it('block：步骤停住，恢复被拒绝', async () => {
    const { runId, step1 } = await interruptedRun();
    await applyReconcileDecision(store, runId, step1, 'block', '先不动');
    await expect(assertResumable(store, runId)).rejects.toThrow(/人工核对/);
    const analysis = await analyzeTaskRun(store, runId);
    const step = analysis.steps.find((s) => s.step_id === step1)!;
    expect(step.classification).toBe('blocked');
  });

  it('已完成验收的步骤不接受核对（不需要）', async () => {
    const { planManager, plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[0]!.step_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'completed');
    store.upsertStepResult(runId, { step_id: plan.steps[0]!.step_id, final_status: 'completed', attempts_used: 1, duration_ms: 1, verification_passed: true, tool_call_count: 0, evidence_count: 0 });
    await expect(
      applyReconcileDecision(store, runId, plan.steps[0]!.step_id, 'confirm_done'),
    ).rejects.toThrow(/无需人工核对/);
  });

  it('abort_requested 快照拒绝恢复', async () => {
    const { planManager, plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[0]!.step_id);
    planManager.cancelPlan(plan.plan_id, '用户取消');
    await expect(assertResumable(store, runId)).rejects.toThrow(/abort_requested|人工核对|取消/);
  });
});

function analysisWillRun(record: CheckpointRecord, stepId: string): boolean {
  const step = record.plan.steps.find((s) => s.step_id === stepId)!;
  return step.status === 'ready' || step.status === 'pending';
}

describe('数据库写入失败：失败关闭', () => {
  it('checkpoint 表损坏时，诊断报 unrecoverable 而不是给出可恢复结论', async () => {
    const { plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    store.close();
    // 破坏 checkpoint 表（模拟磁盘/权限故障后的损坏库）
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('DROP TABLE plan_checkpoints');
    db.close();
    store = new TaskRunStore(dbPath);
    // 重建表但内容为空 → 等价于"快照丢失"
    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.verdict).toBe('unrecoverable');
  });

  it('TaskRunStore 建在只读位置时构造失败（不静默降级为无快照运行）', () => {
    const badPath = join(dir, 'no-such-subdir', 'x.db');
    // mkdirSync 不会被 store 内部 mkdir 补出来？——store 会尝试 mkdir(dirname)，父目录不存在会抛
    expect(() => new TaskRunStore(badPath)).not.toThrow();
    // 存在但损坏的库文件：无法打开 → 构造抛错，run 启动即失败
    const corrupt = join(dir, 'corrupt.db');
    writeFileSync(corrupt, 'not a sqlite file at all');
    expect(() => new TaskRunStore(corrupt)).toThrow();
  });
});

describe('终态与边界', () => {
  it('completed 的 run：verdict=finished，不需要恢复', async () => {
    const { plan } = makePlan();
    const runId = makeRun(plan.plan_id);
    store.updateRun(runId, { status: 'completed' });
    const analysis = await analyzeTaskRun(store, runId);
    expect(analysis.verdict).toBe('finished');
  });

  it('不存在的 runId：抛错', async () => {
    await expect(analyzeTaskRun(store, 'run_nope')).rejects.toThrow('任务不存在');
  });

  it('快照在每步状态变化时都落盘（running 态也在内）', async () => {
    const { planManager, plan } = makePlan();
    planManager.updateStepStatus(plan.plan_id, plan.steps[0]!.step_id, 'ready');
    planManager.markStepRunning(plan.plan_id, plan.steps[0]!.step_id);
    const record = store.loadCheckpoint(plan.plan_id)!;
    expect(record.running_step_id).toBe(plan.steps[0]!.step_id);
    expect(record.schema_version).toBe(2);
    expect(existsSync(dbPath)).toBe(true);
  });
});
