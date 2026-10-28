/**
 * 任务中断诊断与安全恢复（v0.5.7）。
 *
 * 恢复语义（一句话版）：
 *   - **自动继续**：快照里 pending/ready 且从未执行过的步骤；
 *     已完成且验收通过（verified_by=executor）的步骤直接跳过。
 *   - **必须人工核对**：进程中断时处于 running 的步骤（副作用结果未知）、
 *     声称完成但验收证据缺失的步骤、被取消的步骤、失败的步骤。
 *     模型永远无权把这些步骤标记为完成或安全重试——只有 `forgex task reconcile`
 *     的显式人工决定可以。
 *
 * 关键取舍：**步骤是恢复的原子单位**。进程在工具调用中途崩溃时，快照停在
 * `running`——我们无法证明工具副作用是否落盘，所以一律进人工核对，
 * 不做"工具调用粒度的续跑"，也不因步骤声称幂等就自动重放
 * （幂等性必须来自可信的工具定义，不信任 LLM 生成的 `idempotent` 字段）。
 */
import { existsSync } from 'node:fs';
import { worktreeDirName, assertPathInsideRoot } from './review-worktree.js';
import type { TaskRunStore, TaskRunSummary, StepResultRecord } from './task-run-store.js';
import type { CheckpointRecord, TaskStep } from '@forgex/core';

export type StepClassification =
  | 'verified_done' // 已完成且验收通过 → 恢复时直接跳过
  | 'manual_done' // 已完成但验收来自人工确认 → 跳过（附来源标注）
  | 'resumable' // 从未开始（pending/ready 且无执行记录）→ 自动调度
  | 'needs_reconciliation' // 副作用结果未知 → 禁止自动重试，等人工核对
  | 'failed' // 已知失败 → 等人工决定是否重试（不会自动重放）
  | 'blocked'; // 人工决定暂不继续

export interface StepRecoveryInfo {
  step_id: string;
  description: string;
  status: string;
  classification: StepClassification;
  /** 为什么是这个分类（给用户的诊断话术） */
  reason: string;
  dependencies: string[];
  /** 依赖本步骤的下游步骤（人工决策时要看见影响面） */
  downstream_step_ids: string[];
  required_tools: string[];
  verification: unknown;
  /** 该步骤最近的执行记录（可能缺失 = 从未开始） */
  db_result?: StepResultRecord;
}

export interface WorktreeCheck {
  isolation: 'in_place' | 'worktree';
  /** null = 通过；否则是不通过的具体原因列表 */
  problems: string[] | null;
  path: string | null;
  branch: string | null;
}

export interface RunRecoveryAnalysis {
  runId: string;
  runStatus: string;
  workspace: string;
  prompt: string;
  verdict: 'finished' | 'resumable' | 'needs_reconciliation' | 'unrecoverable';
  /** 一句话诊断 */
  message: string;
  /** 恢复会自动调度的步骤 */
  will_run_step_ids: string[];
  /** 恢复会跳过的已完成步骤 */
  skip_step_ids: string[];
  /** 等待人工核对的步骤（reconcile 的对象） */
  reconcile_step_ids: string[];
  steps: StepRecoveryInfo[];
  worktree: WorktreeCheck;
  blockers: string[];
  next_actions: string[];
  planId: string | null;
  snapshotAt: string | null;
}

/** 判断 run 是否已终结（无恢复意义） */
function isFinishedStatus(status: string): boolean {
  return status === 'completed' || status === 'unverified' || status === 'invalid_plan';
}

/** 校验 worktree 归属：缺失/换根/改名都算问题；绝不猜测、绝不删除 */
async function checkWorktree(run: TaskRunSummary): Promise<WorktreeCheck> {
  if (run.isolation !== 'worktree' || !run.worktreePath) {
    return { isolation: run.isolation, problems: null, path: null, branch: null };
  }
  const problems: string[] = [];
  if (!run.worktreeRoot) {
    problems.push('记录缺少 worktree 根目录（旧版本数据），无法核对归属');
  }
  if (existsSync(run.worktreePath)) {
    if (run.worktreeRoot) {
      try {
        // realpath 包含校验（与创建时同一套规则）；不通过 = 目录被移动/改名/软链替换
        const resolved = await assertPathInsideRoot(run.worktreeRoot, run.worktreePath);
        // 目录名也必须与 runId 匹配
        const expected = worktreeDirName(run.runId);
        if (!resolved.endsWith(expected)) {
          problems.push(`worktree 目录名与 runId 不匹配：期望 .../${expected}，实际 ${resolved}`);
        }
      } catch (err) {
        problems.push(`worktree 归属校验失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    problems.push(`worktree 目录不存在：${run.worktreePath}（可能已被外部删除；不会自动重建或删除记录）`);
  }
  return {
    isolation: 'worktree',
    problems: problems.length > 0 ? problems : null,
    path: run.worktreePath,
    branch: run.worktreeBranch,
  };
}

/** 从快照 + step_results 推导每个步骤的恢复分类 */
function classifySteps(
  record: CheckpointRecord,
  dbResults: Map<string, StepResultRecord>,
  allStepIds: string[],
): StepRecoveryInfo[] {
  const downstream = new Map<string, string[]>();
  for (const step of record.plan.steps) {
    for (const dep of step.dependencies) {
      downstream.set(dep, [...(downstream.get(dep) ?? []), step.step_id]);
    }
  }

  return record.plan.steps.map((step: TaskStep) => {
    const db = dbResults.get(step.step_id);
    const base = {
      step_id: step.step_id,
      description: step.description,
      dependencies: step.dependencies,
      downstream_step_ids: downstream.get(step.step_id) ?? [],
      required_tools: step.required_tools,
      verification: step.verification,
      db_result: db,
    };
    switch (step.status) {
      case 'completed': {
        if (db?.verified_by === 'manual') {
          return { ...base, status: step.status, classification: 'manual_done' as const, reason: '已完成（人工核对确认）' };
        }
        if (db && db.verification_passed) {
          return { ...base, status: step.status, classification: 'verified_done' as const, reason: '已完成且验收通过' };
        }
        return {
          ...base,
          status: step.status,
          classification: 'needs_reconciliation' as const,
          reason: '快照声称完成，但缺少验收通过的证据（可能在验收前中断）',
        };
      }
      case 'running':
        return {
          ...base,
          status: step.status,
          classification: 'needs_reconciliation' as const,
          reason: '进程中断时正在执行，工具副作用是否生效未知',
        };
      case 'failed':
        return { ...base, status: step.status, classification: 'failed' as const, reason: '执行失败（不会自动重放）' };
      case 'cancelled':
        return {
          ...base,
          status: step.status,
          classification: 'needs_reconciliation' as const,
          reason: '步骤被取消；取消前的副作用需要人工确认',
        };
      case 'blocked':
        return { ...base, status: step.status, classification: 'blocked' as const, reason: step.block_reason ?? '步骤被阻塞' };
      case 'ready':
      case 'pending':
      default: {
        if (db && (db.final_status === 'running' || db.final_status === 'needs_reconciliation')) {
          return {
            ...base,
            status: step.status,
            classification: 'needs_reconciliation' as const,
            reason: `执行记录停在 ${db.final_status}（进程可能在执行中崩溃），副作用结果未知`,
          };
        }
        return {
          ...base,
          status: step.status,
          classification: 'resumable' as const,
          reason: allStepIds.length > 0 ? '未开始，恢复时自动调度' : '未开始',
        };
      }
    }
  });
}

/**
 * 诊断一次 task run 的中断状态。
 *
 * 纯读取：不修改任何状态。快照缺失/损坏 → unrecoverable + 具体原因；
 * worktree 异常 → 记入 blockers，不猜测、不删除。
 */
export async function analyzeTaskRun(store: TaskRunStore, runId: string): Promise<RunRecoveryAnalysis> {
  const run = store.getRunSummary(runId);
  if (!run) {
    throw new Error(`任务不存在: ${runId}`);
  }
  const worktree = await checkWorktree(run);
  const blockers: string[] = [...(worktree.problems ?? [])];

  const rawRun = store.getRun(runId) as Record<string, unknown>;
  const planId = typeof rawRun.plan_id === 'string' ? rawRun.plan_id : null;
  if (isFinishedStatus(run.status)) {
    return {
      runId,
      runStatus: run.status,
      workspace: run.workspace,
      prompt: run.prompt,
      verdict: 'finished',
      message: `任务已终结（${run.status}），无需恢复`,
      will_run_step_ids: [],
      skip_step_ids: [],
      reconcile_step_ids: [],
      steps: [],
      worktree,
      blockers,
      next_actions: [],
      planId,
      snapshotAt: null,
    };
  }
  if (!planId) {
    blockers.push('run 没有关联计划（可能在计划生成前就中断）');
    return {
      runId,
      runStatus: run.status,
      workspace: run.workspace,
      prompt: run.prompt,
      verdict: 'unrecoverable',
      message: '没有计划快照可恢复：任务在计划生成前中断',
      will_run_step_ids: [],
      skip_step_ids: [],
      reconcile_step_ids: [],
      steps: [],
      worktree,
      blockers,
      next_actions: ['用相同的提示重新发起 `forgex run`'],
      planId: null,
      snapshotAt: null,
    };
  }

  let record: CheckpointRecord;
  try {
    const loaded = store.loadCheckpoint(planId);
    if (!loaded) {
      blockers.push(`计划 ${planId} 没有快照（由未接入快照的旧版本写入）`);
      return {
        runId,
        runStatus: run.status,
        workspace: run.workspace,
        prompt: run.prompt,
        verdict: 'unrecoverable',
        message: `计划 ${planId} 无快照，无法安全恢复`,
        will_run_step_ids: [],
        skip_step_ids: [],
        reconcile_step_ids: [],
        steps: [],
        worktree,
        blockers,
        next_actions: ['人工检查工作区产物后，用相同的提示重新发起 `forgex run`'],
        planId,
        snapshotAt: null,
      };
    }
    record = loaded;
  } catch (err) {
    blockers.push(err instanceof Error ? err.message : String(err));
    return {
      runId,
      runStatus: run.status,
      workspace: run.workspace,
      prompt: run.prompt,
      verdict: 'unrecoverable',
      message: '计划快照损坏或不兼容，拒绝恢复',
      will_run_step_ids: [],
      skip_step_ids: [],
      reconcile_step_ids: [],
      steps: [],
      worktree,
      blockers,
      next_actions: ['人工检查工作区与 worktree 产物；不要基于损坏快照自动重跑'],
      planId,
      snapshotAt: null,
    };
  }

  const dbResults = new Map(store.listStepResults(runId).map((r) => [r.step_id, r]));
  const steps = classifySteps(record, dbResults, record.plan.steps.map((s) => s.step_id));

  const willRun = steps.filter((s) => s.classification === 'resumable').map((s) => s.step_id);
  const skip = steps.filter((s) => s.classification === 'verified_done' || s.classification === 'manual_done').map((s) => s.step_id);
  // blocked 的步骤也必须人工解除（confirm-done / confirm-retry），resume 不得静默跳过它
  const reconcile = steps
    .filter((s) => s.classification === 'needs_reconciliation' || s.classification === 'failed' || s.classification === 'blocked')
    .map((s) => s.step_id);

  let verdict: RunRecoveryAnalysis['verdict'];
  let message: string;
  if (reconcile.length > 0) {
    verdict = 'needs_reconciliation';
    message = `${reconcile.length} 个步骤副作用结果未知或已失败，必须人工核对后才能恢复（用 forgex task reconcile ${runId}）`;
  } else if (blockers.length > 0) {
    verdict = 'needs_reconciliation';
    message = `存在环境问题（worktree 异常等），先解决 blocker 再恢复`;
  } else if (willRun.length > 0) {
    verdict = 'resumable';
    message = `可安全恢复：自动执行 ${willRun.length} 个未开始步骤，跳过 ${skip.length} 个已完成步骤`;
  } else {
    verdict = 'finished';
    message = '所有步骤都已完成，可直接查看结果';
  }

  const nextActions: string[] = [];
  if (verdict === 'needs_reconciliation') {
    nextActions.push(`forgex task reconcile ${runId}            # 查看待核对步骤与影响面`);
    nextActions.push(`forgex task reconcile ${runId} --step <step_id> --confirm-done   # 确认该步骤已完成`);
    nextActions.push(`forgex task reconcile ${runId} --step <step_id> --confirm-retry  # 确认外部状态后允许重试`);
    nextActions.push(`forgex task reconcile ${runId} --step <step_id> --block          # 暂不继续`);
  }
  if (verdict === 'resumable') {
    nextActions.push(`forgex task resume ${runId}                 # 自动继续未开始的步骤`);
  }
  if (worktree.path) {
    nextActions.push(`forgex task diff ${runId}                   # 查看 worktree 产物`);
  }

  return {
    runId,
    runStatus: run.status,
    workspace: run.workspace,
    prompt: run.prompt,
    verdict,
    message,
    will_run_step_ids: willRun,
    skip_step_ids: skip,
    reconcile_step_ids: reconcile,
    steps,
    worktree,
    blockers,
    next_actions: nextActions,
    planId,
    snapshotAt: record.snapshot_at,
  };
}

export type ReconcileDecision = 'confirm_done' | 'confirm_retry' | 'block';

/**
 * 人工核对决定。只改**持久化快照 + step_results + run 状态**，
 * 不经过运行时状态机——恢复时快照会再次经过完整校验。
 *
 * 决定语义：
 *   - confirm_done：步骤 → completed（verified_by='manual'）。用户为副作用结果背书。
 *   - confirm_retry：步骤 → ready（调度器会重新执行）。用户确认外部状态已核对。
 *   - block：步骤 → blocked，任务停住，什么都不自动跑。
 */
export async function applyReconcileDecision(
  store: TaskRunStore,
  runId: string,
  stepId: string,
  decision: ReconcileDecision,
  note?: string,
): Promise<{ step: StepRecoveryInfo; affected_downstream: string[] }> {
  const analysis = await analyzeTaskRun(store, runId);
  if (analysis.verdict === 'unrecoverable' || analysis.verdict === 'finished') {
    throw new Error(`任务当前状态（${analysis.verdict}）不支持核对：${analysis.message}`);
  }
  const info = analysis.steps.find((s) => s.step_id === stepId);
  if (!info) {
    throw new Error(`步骤不存在: ${stepId}（可用步骤: ${analysis.steps.map((s) => s.step_id).join(', ')}）`);
  }
  if (info.classification !== 'needs_reconciliation' && info.classification !== 'failed' && info.classification !== 'blocked') {
    throw new Error(
      `步骤 ${stepId} 状态为 ${info.status}（${info.classification}），无需人工核对；只有 needs_reconciliation / failed / blocked 的步骤可以核对`,
    );
  }

  const record = store.loadCheckpoint(analysis.planId!)!;
  const step = record.plan.steps.find((s) => s.step_id === stepId)!;
  const now = new Date().toISOString();
  const db = info.db_result;

  switch (decision) {
    case 'confirm_done': {
      step.status = 'completed';
      step.updated_at = now;
      record.running_step_id = record.running_step_id === stepId ? undefined : record.running_step_id;
      record.completed_step_ids = [...new Set([...record.completed_step_ids, stepId])];
      record.failed_step_ids = record.failed_step_ids.filter((id) => id !== stepId);
      store.upsertStepResult(runId, {
        step_id: stepId,
        final_status: 'completed',
        attempts_used: db?.attempts_used ?? 1,
        duration_ms: db?.duration_ms ?? 0,
        verification_passed: true,
        verification_reason: `人工确认完成${note ? `：${note}` : ''}`,
        tool_call_count: db?.tool_call_count ?? 0,
        evidence_count: db?.evidence_count ?? 0,
        summary: note ?? '人工核对确认该步骤已完成',
        verified_by: 'manual',
      });
      break;
    }
    case 'confirm_retry': {
      // → ready：恢复时调度器直接重新执行（用户已确认外部状态）
      step.status = 'ready';
      step.block_reason = undefined;
      step.updated_at = now;
      record.running_step_id = record.running_step_id === stepId ? undefined : record.running_step_id;
      store.upsertStepResult(runId, {
        step_id: stepId,
        final_status: 'pending',
        attempts_used: db?.attempts_used ?? 0,
        duration_ms: db?.duration_ms ?? 0,
        verification_passed: false,
        verification_reason: `人工确认外部状态后允许重试${note ? `：${note}` : ''}`,
        tool_call_count: db?.tool_call_count ?? 0,
        failure_reason: undefined,
        evidence_count: db?.evidence_count ?? 0,
        summary: note ?? '人工确认外部状态后允许重试',
        verified_by: 'manual',
      });
      break;
    }
    case 'block': {
      step.status = 'blocked';
      step.block_reason = note ?? '人工核对：暂不继续';
      step.updated_at = now;
      store.upsertStepResult(runId, {
        step_id: stepId,
        final_status: 'needs_reconciliation',
        attempts_used: db?.attempts_used ?? 0,
        duration_ms: db?.duration_ms ?? 0,
        verification_passed: false,
        verification_reason: step.block_reason,
        tool_call_count: db?.tool_call_count ?? 0,
        evidence_count: db?.evidence_count ?? 0,
        summary: step.block_reason,
        verified_by: 'manual',
      });
      break;
    }
  }

  store.saveCheckpoint(record);
  store.updateRun(runId, { status: 'blocked' });
  return {
    step: { ...info, status: step.status, classification: decision === 'confirm_done' ? 'manual_done' : decision === 'confirm_retry' ? 'resumable' : 'blocked' },
    affected_downstream: info.downstream_step_ids,
  };
}

/** `forgex task resume` 前置校验：可恢复时返回快照，否则抛错（带诊断） */
export async function assertResumable(store: TaskRunStore, runId: string): Promise<CheckpointRecord> {
  const analysis = await analyzeTaskRun(store, runId);
  if (analysis.verdict === 'unrecoverable') {
    throw new Error(`无法恢复：${analysis.message}${analysis.blockers.length ? `（${analysis.blockers.join('；')}）` : ''}`);
  }
  if (analysis.verdict === 'finished') {
    throw new Error(`任务已终结（${analysis.runStatus}），无需恢复`);
  }
  if (analysis.reconcile_step_ids.length > 0) {
    throw new Error(
      `有 ${analysis.reconcile_step_ids.length} 个步骤等待人工核对（${analysis.reconcile_step_ids.join(', ')}），先执行 forgex task reconcile ${runId}`,
    );
  }
  if (analysis.blockers.length > 0) {
    throw new Error(`存在未解决的环境问题：${analysis.blockers.join('；')}`);
  }
  const record = store.loadCheckpoint(analysis.planId!)!;
  if (record.abort_requested) {
    throw new Error('快照带有取消标记（abort_requested），恢复被拒绝；请重新发起任务');
  }
  return record;
}

/** worktree 归属校验给 run.ts 的 resume 复用 */
export async function verifyWorktreeForResume(run: TaskRunSummary): Promise<void> {
  const check = await checkWorktree(run);
  if (check.problems) {
    throw new Error(`worktree 校验失败，拒绝恢复（不猜测、不删除）：${check.problems.join('；')}`);
  }
}

