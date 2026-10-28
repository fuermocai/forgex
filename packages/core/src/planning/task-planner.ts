/**
 * TaskPlanner：端到端编排——从用户请求到完整计划的生命周期管理（v0.3.0 Phase 1）。
 *
 * 设计定位：
 *   TaskPlanner 是 PlanManager + DependencyScheduler + StepExecutor 的上层胶水。
 *   它自己不做 DAG 计算（PlanManager.createPlan 已保证合法性）、不做就绪判定
 *   （DependencyScheduler）、不跑步骤（StepExecutor）——它只负责串起来。
 *
 * Phase 1 范围：
 *   - createPlan（输入用户请求 + 预拆解的步骤列表 → 输出 TaskPlan）
 *   - runSingle（串行执行所有 ready 步骤，一次一个）
 *   - runBatch（执行 parallel_groups 里的组，组间串行、组内并发）
 *   - cancel（取消整个计划，传播 AbortSignal）
 *   - replan（失败后重规划——替换 steps，保留已完成）
 *
 *   **不实现**：让 LLM 自动拆解步骤（Phase 2 Sub-Agent / Phase 5 Context 层再补）。
 *   Phase 1 里 steps 由调用方显式提供——TaskPlanner 只做编排和执行。
 */
import { ForgeError } from '@forgex/shared';
import { PlanManager } from './plan-manager.js';
import { CheckpointManager } from './checkpoint.js';
import { StepExecutor, type StepExecResult, type StepExecutorOptions } from './step-executor.js';
import { computeSchedule, topologicalOrder, hasWorkRemaining } from './dep-scheduler.js';
import {
  type TaskPlan,
  type TaskStep,
  type TaskStatus,
} from './types.js';

export interface TaskPlannerOptions {
  planManager: PlanManager;
  checkpoint?: CheckpointManager;
  stepExecutor?: StepExecutor;
  /** 最大并发 step 数（runBatch 时），默认 3 */
  maxConcurrency?: number;
}

export interface RunPlanOptions {
  /** 单次执行的 step 数量上限（防止无限循环） */
  maxSteps?: number;
  /** 手动指定要执行的 step_ids（调试用——跳过 DependencyScheduler） */
  stepIds?: string[];
  /** 每个步骤结束后立即回调，适合持久化恢复所需的状态与指标 */
  onStepResult?: (result: StepExecResult) => void;
}

export interface RunPlanResult {
  plan_id: string;
  plan_status: TaskStatus;
  total_steps: number;
  completed: number;
  failed: number;
  cancelled: number;
  results: StepExecResult[];
  /** 总耗时毫秒 */
  duration_ms: number;
  /** 是否达到 maxSteps 提前返回 */
  truncated: boolean;
}

export class TaskPlanner {
  private readonly planManager: PlanManager;
  private readonly checkpoint?: CheckpointManager;
  private readonly executor?: StepExecutor;
  private readonly maxConcurrency: number;

  constructor(options: TaskPlannerOptions) {
    this.planManager = options.planManager;
    this.checkpoint = options.checkpoint;
    this.executor = options.stepExecutor;
    this.maxConcurrency = options.maxConcurrency ?? 3;
  }

  /**
   * 接收预拆解步骤列表 → 交给 PlanManager 做合法性校验 → 入库 → 返回 TaskPlan。
   * 这是 Phase 1 的 createPlan 入口（不让 LLM 拆解，调用方显式提供 steps）。
   */
  create(userRequest: string, steps: TaskStep[], metadata?: TaskPlan['metadata']): TaskPlan {
    return this.planManager.createPlan({
      user_request: userRequest,
      steps,
      metadata,
    });
  }

  /**
   * 串行执行：按拓扑排序一个一个跑 ready 步骤。
   * 每个步骤通过 StepExecutor.executeStep 执行（内置重试 + 验证）。
   * 循环直到没有 ready 步骤 或 计划进入终态。
   */
  async runSingle(planId: string, options: RunPlanOptions = {}): Promise<RunPlanResult> {
    if (!this.executor) {
      throw new ForgeError('PLANNING_STEP_EXEC_ERROR', 'StepPlanner 未注入 StepExecutor');
    }

    const started = Date.now();
    const maxSteps = options.maxSteps ?? 20;
    const results: StepExecResult[] = [];

    // 如果传了 stepIds 就跳过自动调度
    const manualIds = options.stepIds;

    let safetyCounter = 0;
    while (safetyCounter++ < maxSteps) {
      const plan = this.planManager.getPlan(planId);
      if (!hasWorkRemaining(plan)) break;

      const schedule = computeSchedule(plan);
      if (manualIds && manualIds.length > 0) {
        // 手动模式：只跑指定的（必须在 ready 里）
        const toRun = manualIds.filter((id) => schedule.total_ready_step_ids.includes(id));
        if (toRun.length === 0) break;
        for (const stepId of toRun) {
          if (results.length >= maxSteps) break;
          const r = await this.executor.executeStep(planId, stepId);
          options.onStepResult?.(r);
          results.push(r);
        }
        break; // 手动模式只跑一次
      }

      // 自动模式：取 ready 步骤按拓扑排序执行
      if (schedule.total_ready_step_ids.length === 0) break;
      const order = topologicalOrder(schedule.total_ready_step_ids, plan.steps);
      if (order.length === 0) break;

      const stepId = order[0]!;
      const r = await this.executor.executeStep(planId, stepId);
      options.onStepResult?.(r);
      results.push(r);

      // 取消则提前退出
      if (r.cancelled) break;
    }

    const finalPlan = this.planManager.getPlan(planId);
    return {
      plan_id: planId,
      plan_status: finalPlan.status,
      total_steps: finalPlan.steps.length,
      completed: results.filter((r) => r.final_status === 'completed').length,
      failed: results.filter((r) => r.final_status === 'failed').length,
      cancelled: results.filter((r) => r.final_status === 'cancelled').length,
      results,
      duration_ms: Date.now() - started,
      truncated: results.length >= maxSteps && hasWorkRemaining(finalPlan),
    };
  }

  /** 取消整个计划（PlanManager.cancelPlan 传播 abort） */
  cancel(planId: string, reason?: string): TaskPlan {
    return this.planManager.cancelPlan(planId, reason);
  }

  /** 从 CheckpointManager 恢复（崩溃后继续跑） */
  restoreFromCheckpoint(planId: string): TaskPlan | null {
    if (!this.checkpoint) return null;
    const record = this.checkpoint.load(planId);
    if (!record) return null;
    const plan = this.planManager.restoreFromCheckpoint(record);
    // 如果 abort_requested=true → 恢复后自动取消
    if (record.abort_requested && !isTerminalPlan(plan.status)) {
      this.planManager.cancelPlan(planId, '恢复时检测到 abort_requested=true');
    }
    return plan;
  }

  /** 获取依赖的 PlanManager（外部可以直接调它做低级操作） */
  getPlanManager(): PlanManager {
    return this.planManager;
  }

  /** 获取计划当前状态（外部查询用） */
  getPlan(planId: string): TaskPlan {
    return this.planManager.getPlan(planId);
  }

  /** 列出所有计划 */
  listPlans(): ReturnType<PlanManager['listPlans']> {
    return this.planManager.listPlans();
  }
}

function isTerminalPlan(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}
