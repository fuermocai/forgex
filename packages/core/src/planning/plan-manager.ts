/**
 * PlanManager：计划的内存 CRUD + 合法性校验（v0.3.0 Phase 1）。
 *
 * 职责边界（纯内存，不执行，不持久化）：
 *   - 维护当前进程内所有 TaskPlan 的状态（Map<plan_id, TaskPlan>）；
 *   - createPlan()：在入库前做 **依赖环检测** + **悬空依赖检测**；
 *   - updateStepStatus()：先走 types.ts 的 isValidTransition()，
 *     再走 computePlanStatus() 折叠整体状态；
 *   - 可选注入 CheckpointManager：状态变化后调 snapshotPlan()。
 *
 * 不负责：执行（StepExecutor）、恢复（CheckpointManager 从 DB 加载后
 * 由 StepExecutor 负责推进）、重规划（TaskPlanner）。
 */
import { ForgeError } from '@forgex/shared';
import { CheckpointManager } from './checkpoint.js';
import {
  allowedTransitions,
  computePlanStatus,
  isTerminal,
  isValidTransition,
  newPlanId,
  nowIso,
  type RiskLevel,
  type TaskPlan,
  type TaskStatus,
  type TaskStep,
} from './types.js';

/* ------------------------------------------------------------------ */
/* 依赖检测工具（DFS）                                                  */
/* ------------------------------------------------------------------ */

interface CycleResult {
  hasCycle: boolean;
  cycle: string[]; // 路径（无环时为空数组）
}

/**
 * 检测步骤依赖图里的环。
 * 用 DFS + 三色标记：white（未访问）/ gray（当前路径）/ black（已完成）。
 * 遇到 gray 节点 → 找到环，回溯出完整路径。
 *
 * 时间 O(V+E)，空间 O(V)。
 */
export function detectCycle(steps: ReadonlyArray<TaskStep>): CycleResult {
  const stepMap = new Map<string, TaskStep>();
  for (const s of steps) stepMap.set(s.step_id, s);

  const color = new Map<string, 'white' | 'gray' | 'black'>();
  for (const s of steps) color.set(s.step_id, 'white');

  let cycleFound: string[] | null = null;

  function dfs(nodeId: string, path: string[]): void {
    if (cycleFound) return;
    if (color.get(nodeId) !== 'white') return;

    color.set(nodeId, 'gray');
    const currentPath = [...path, nodeId];
    const node = stepMap.get(nodeId);
    if (!node) {
      color.set(nodeId, 'black');
      return;
    }

    for (const dep of node.dependencies) {
      const depColor = color.get(dep);
      if (depColor === 'gray') {
        // 找到环：回溯出完整路径
        const idx = currentPath.indexOf(dep);
        if (idx >= 0) {
          cycleFound = [...currentPath.slice(idx), dep];
        } else {
          cycleFound = [dep, ...currentPath, dep];
        }
        return;
      }
      if (depColor === 'white') {
        dfs(dep, currentPath);
      }
    }

    color.set(nodeId, 'black');
  }

  for (const s of steps) {
    if (cycleFound) break;
    dfs(s.step_id, []);
  }

  return { hasCycle: cycleFound !== null, cycle: cycleFound ?? [] };
}

/**
 * 检测悬空依赖：dependencies 里引用的 step_id 不在 steps 列表里。
 * 返回悬空的 step_id 集合。
 */
export function findDanglingDependencies(steps: ReadonlyArray<TaskStep>): string[] {
  const existing = new Set(steps.map((s) => s.step_id));
  const dangling = new Set<string>();
  for (const s of steps) {
    for (const dep of s.dependencies) {
      if (!existing.has(dep)) dangling.add(dep);
    }
  }
  return [...dangling];
}

/** 单个步骤的自环（dependencies 里直接引用自己） */
export function findSelfLoops(steps: ReadonlyArray<TaskStep>): string[] {
  return steps.filter((s) => s.dependencies.includes(s.step_id)).map((s) => s.step_id);
}

/* ------------------------------------------------------------------ */
/* PlanManager                                                         */
/* ------------------------------------------------------------------ */

export interface CreatePlanInput {
  user_request: string;
  steps: TaskStep[];
  metadata?: TaskPlan['metadata'];
  /** 可选指定 plan_id（一般不需要） */
  plan_id?: string;
}

export interface PlanManagerOptions {
  checkpoint?: CheckpointManager;
  /** 状态变化是否自动做 checkpoint（默认 true） */
  autoCheckpoint?: boolean;
}

export class PlanManager {
  private readonly plans = new Map<string, TaskPlan>();
  private readonly checkpoint?: CheckpointManager;
  private readonly autoCheckpoint: boolean;

  constructor(options: PlanManagerOptions = {}) {
    this.checkpoint = options.checkpoint;
    this.autoCheckpoint = options.autoCheckpoint !== false;
  }

  /**
   * 创建新计划（入库前做合法性校验）。
   * 校验顺序：自环 → 悬空依赖 → 环检测（三者独立，全部跑完再报错）。
   */
  createPlan(input: CreatePlanInput): TaskPlan {
    if (!input.user_request.trim()) {
      throw new ForgeError('PLANNING_PLAN_INVALID', 'user_request 不能为空');
    }
    if (input.steps.length === 0) {
      throw new ForgeError('PLANNING_PLAN_INVALID', '计划必须至少有一个步骤');
    }

    // 1. 自环
    const selfLoops = findSelfLoops(input.steps);
    if (selfLoops.length > 0) {
      throw new ForgeError('PLANNING_DEPENDENCY_ERROR', `步骤直接依赖自己: ${selfLoops.join(', ')}`, {
        details: { selfLoops },
      });
    }

    // 2. 悬空依赖
    const dangling = findDanglingDependencies(input.steps);
    if (dangling.length > 0) {
      throw new ForgeError('PLANNING_DEPENDENCY_ERROR', `依赖不存在的 step_id: ${dangling.join(', ')}`, {
        details: { dangling },
      });
    }

    // 3. 环检测
    const cycle = detectCycle(input.steps);
    if (cycle.hasCycle) {
      throw new ForgeError('PLANNING_DEPENDENCY_ERROR', `依赖图存在环: ${cycle.cycle.join(' → ')}`, {
        details: { cycle: cycle.cycle },
      });
    }

    const now = nowIso();
    const plan: TaskPlan = {
      plan_id: input.plan_id ?? newPlanId(),
      user_request: input.user_request,
      created_at: now,
      updated_at: now,
      status: computePlanStatus(input.steps),
      steps: input.steps.map((s) => ({ ...s })), // 深拷贝防外部修改
      metadata: { model: 'unknown', ...(input.metadata ?? {}) },
    };

    this.plans.set(plan.plan_id, plan);

    if (this.autoCheckpoint) {
      this.checkpoint?.snapshotPlan(plan);
    }

    return plan;
  }

  /** 从 CheckpointRecord 恢复一个计划（供崩溃恢复流程用） */
  restoreFromCheckpoint(record: { plan: TaskPlan }): TaskPlan {
    const plan = JSON.parse(JSON.stringify(record.plan)) as TaskPlan;
    this.plans.set(plan.plan_id, plan);
    return plan;
  }

  /** 取计划（找不到抛 PLANNING_PLAN_INVALID） */
  getPlan(planId: string): TaskPlan {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new ForgeError('PLANNING_PLAN_INVALID', `计划不存在: ${planId}`, { details: { planId } });
    }
    return plan;
  }

  /** 列出所有计划的轻量视图（供 CLI "list plans"） */
  listPlans(): Array<{
    plan_id: string;
    user_request: string;
    status: TaskStatus;
    stepCount: number;
    created_at: string;
    updated_at: string;
  }> {
    return [...this.plans.values()].map((p) => ({
      plan_id: p.plan_id,
      user_request: p.user_request,
      status: p.status,
      stepCount: p.steps.length,
      created_at: p.created_at,
      updated_at: p.updated_at,
    }));
  }

  /**
   * 更新单个步骤的状态（唯一合法入口）。
   * 内部走 isValidTransition() 校验，更新后 recompute 整体计划状态。
   *
   * 禁止外部直接 step.status = ... 跳过校验。
   */
  updateStepStatus(planId: string, stepId: string, newStatus: TaskStatus, reason?: string): TaskStep {
    const plan = this.getPlan(planId);
    const step = plan.steps.find((s) => s.step_id === stepId);
    if (!step) {
      throw new ForgeError('PLANNING_PLAN_INVALID', `步骤不存在: ${stepId}`, { details: { stepId, planId } });
    }

    // 校验状态转移合法性
    if (!isValidTransition(step.status, newStatus)) {
      const allowed = allowedTransitions(step.status).join(', ') || '（终态不可转）';
      throw new ForgeError('PLANNING_DEPENDENCY_ERROR', `非法状态转移: ${step.status} → ${newStatus}`, {
        details: { stepId, from: step.status, to: newStatus, allowed },
      });
    }

    // 先记录旧状态——attempts 累加依赖"从非 failed 进入 failed"的判定，
    // 如果先赋值再判断，条件永远为 false（曾导致 attempts 从不累加）。
    const prevStatus = step.status;
    step.status = newStatus;
    step.updated_at = nowIso();
    if (reason) step.block_reason = reason;

    // failed 态：attempts++（只有从非 failed 到 failed 才累加，重跑回来再失败又加一次）
    if (newStatus === 'failed' && prevStatus !== 'failed') {
      step.attempts++;
    }

    // 折叠整体计划状态
    plan.status = computePlanStatus(plan.steps);
    plan.updated_at = nowIso();

    if (this.autoCheckpoint) {
      this.checkpoint?.snapshotPlan(plan);
    }

    return step;
  }

  /** 标记步骤 running（StepExecutor 入口调用） */
  markStepRunning(planId: string, stepId: string): TaskStep {
    return this.updateStepStatus(planId, stepId, 'running');
  }

  /** 标记步骤 completed（成功） */
  markStepCompleted(planId: string, stepId: string): TaskStep {
    return this.updateStepStatus(planId, stepId, 'completed');
  }

  /** 标记步骤 failed（自动累加 attempts，超过 max_attempts 则重规划时参考） */
  markStepFailed(planId: string, stepId: string, reason?: string): TaskStep {
    return this.updateStepStatus(planId, stepId, 'failed', reason);
  }

  /** 标记步骤 blocked（阻塞原因必填） */
  markStepBlocked(planId: string, stepId: string, reason: string): TaskStep {
    return this.updateStepStatus(planId, stepId, 'blocked', reason);
  }

  /** 解除阻塞，回到 ready（依赖解除） */
  unblockStep(planId: string, stepId: string): TaskStep {
    return this.updateStepStatus(planId, stepId, 'ready');
  }

  /** 取消整个计划——把所有非终态步骤设为 cancelled */
  cancelPlan(planId: string, reason?: string): TaskPlan {
    const plan = this.getPlan(planId);
    for (const step of plan.steps) {
      if (!isTerminal(step.status)) {
        // cancelled 只允许从 pending / ready / running / blocked 进入
        if (isValidTransition(step.status, 'cancelled')) {
          step.status = 'cancelled';
          step.updated_at = nowIso();
          if (reason) step.block_reason = reason;
        }
      }
    }
    plan.status = computePlanStatus(plan.steps);
    plan.updated_at = nowIso();

    if (this.autoCheckpoint) {
      this.checkpoint?.snapshotPlan(plan, true); // abort_requested=true
    }

    return plan;
  }

  /** 删除计划（完成后清理） */
  deletePlan(planId: string): boolean {
    if (!this.plans.has(planId)) return false;
    this.plans.delete(planId);
    this.checkpoint?.delete(planId);
    return true;
  }

  /** 步骤级：更新 result / evidence_refs（StepExecutor 填充执行结果后调用） */
  updateStepResult(planId: string, stepId: string, result: TaskStep['result'], evidenceRefs: TaskStep['evidence_refs'] = []): TaskStep {
    const plan = this.getPlan(planId);
    const step = plan.steps.find((s) => s.step_id === stepId);
    if (!step) {
      throw new ForgeError('PLANNING_PLAN_INVALID', `步骤不存在: ${stepId}`, { details: { stepId, planId } });
    }
    step.result = result;
    step.evidence_refs = [...step.evidence_refs, ...evidenceRefs];
    step.updated_at = nowIso();

    if (this.autoCheckpoint) {
      this.checkpoint?.snapshotPlan(plan);
    }

    return step;
  }

  /** 重规划：用新步骤替换现有 plan.steps（TaskPlanner 重新拆解后调用） */
  reshapePlan(planId: string, newSteps: TaskStep[], reason: string): TaskPlan {
    // 对新步骤做全套合法性校验（与 createPlan 相同）
    const selfLoops = findSelfLoops(newSteps);
    if (selfLoops.length > 0) {
      throw new ForgeError('PLANNING_DEPENDENCY_ERROR', `重规划后存在自环: ${selfLoops.join(', ')}`);
    }
    const dangling = findDanglingDependencies(newSteps);
    if (dangling.length > 0) {
      throw new ForgeError('PLANNING_DEPENDENCY_ERROR', `重规划后存在悬空依赖: ${dangling.join(', ')}`);
    }
    const cycle = detectCycle(newSteps);
    if (cycle.hasCycle) {
      throw new ForgeError('PLANNING_DEPENDENCY_ERROR', `重规划后存在环: ${cycle.cycle.join(' → ')}`);
    }

    const plan = this.getPlan(planId);
    // 保留已完成步骤的 result 和 evidence_refs，重设为 ready（重规划不需要重新执行已完成的步骤）
    const completedOldSteps = new Map(plan.steps.filter((s) => s.status === 'completed').map((s) => [s.step_id, s]));

    // 关键：如果重规划后的 step_id 和旧的一样 → 保留 completed 状态；如果 step_id 变了 → 新步骤
    for (const newStep of newSteps) {
      const old = completedOldSteps.get(newStep.step_id);
      if (old && old.status === 'completed') {
        newStep.status = 'completed';
        newStep.result = old.result;
        newStep.evidence_refs = old.evidence_refs;
        newStep.updated_at = nowIso();
      }
    }

    plan.steps = newSteps;
    plan.status = computePlanStatus(newSteps);
    plan.updated_at = nowIso();
    plan.metadata = {
      ...plan.metadata,
      replanned_at: nowIso(),
      replanned_reason: reason,
    };

    if (this.autoCheckpoint) {
      this.checkpoint?.snapshotPlan(plan);
    }

    return plan;
  }

  /** 修改单个步骤的 risk_level（TaskPlanner 根据重新评估调整） */
  updateStepRisk(planId: string, stepId: string, risk: RiskLevel): TaskStep {
    const plan = this.getPlan(planId);
    const step = plan.steps.find((s) => s.step_id === stepId);
    if (!step) {
      throw new ForgeError('PLANNING_PLAN_INVALID', `步骤不存在: ${stepId}`);
    }
    step.risk_level = risk;
    step.updated_at = nowIso();
    return step;
  }

  /** 修改单个步骤的 description（TaskPlanner 根据新发现调整） */
  updateStepDescription(planId: string, stepId: string, description: string): TaskStep {
    const plan = this.getPlan(planId);
    const step = plan.steps.find((s) => s.step_id === stepId);
    if (!step) {
      throw new ForgeError('PLANNING_PLAN_INVALID', `步骤不存在: ${stepId}`);
    }
    step.description = description;
    step.updated_at = nowIso();
    return step;
  }
}
