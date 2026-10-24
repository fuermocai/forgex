/**
 * DependencyScheduler：依赖就绪计算 + 并行组划分（v0.3.0 Phase 1）。
 *
 * 纯函数，不修改 TaskPlan 状态——PlanManager / StepExecutor 调它拿结果后自己改。
 *
 * 两个核心问题：
 *   1. **就绪计算**：给定一个 TaskPlan（可能有已完成/失败/运行中的步骤），
 *      哪些 pending 步骤的 dependencies 全部在 completed 或 failed（可跳过重跑）？
 *      → 返回 ready_step_ids（可以从 pending 标记为 ready 的集合）
 *
 *   2. **并行组划分**：ready 步骤里哪些可以并行执行？
 *      条件：(a) parallelizable=true，(b) 不共享同一文件的写操作（安全层已经
 *      处理，这里只做 structural 判断——同一轮 ready 且互不依赖即可并行）
 *
 * 不做：环检测（PlanManager 建计划时已经保证 DAG）、优先级排序（TaskPlanner 管）。
 */
import { type TaskPlan, type TaskStep } from './types.js';

export interface ScheduleResult {
  /** 所有 dependencies 都已完成的 pending 步骤 → 可以标记 ready */
  ready_step_ids: string[];
  /** 已处于 ready 态的步骤（StepExecutor 下一批可以执行的） */
  ready_existing_step_ids: string[];
  /** ready_step_ids + ready_existing_step_ids 合并去重 */
  total_ready_step_ids: string[];
  /** 已经完成的 step_id 集合（供 StepExecutor 判断依赖满足） */
  completed_step_ids: string[];
  /** 失败但重试预算还没用完的 step_id（它们的下游可以等它们完成，也可以跳过——这是重规划决策） */
  failed_step_ids: string[];
  /** ready 步骤分成可以并行执行的组；组间必须串行，组内可以并发 */
  parallel_groups: string[][];
  /** 如果计划处于终态（completed/cancelled），ready_step_ids 会为空，这个字段提示原因 */
  plan_terminal: boolean;
  /** 如果计划 blocked，ready_step_ids 会为空 */
  plan_blocked: boolean;
}

/**
 * 主入口：对一个 TaskPlan 做全部调度计算。
 */
export function computeSchedule(plan: TaskPlan): ScheduleResult {
  const completed = new Set<string>();
  const failed = new Set<string>();
  const pending: TaskStep[] = [];
  const ready: TaskStep[] = [];

  for (const step of plan.steps) {
    if (step.status === 'completed') completed.add(step.step_id);
    else if (step.status === 'failed') failed.add(step.step_id);
    else if (step.status === 'pending') pending.push(step);
    else if (step.status === 'ready') ready.push(step);
    // running → 不纳入计算（正在执行）
  }

  // 依赖满足判定：dependencies 全部在 completed 里
  // 注意：failed 步骤**不能**满足依赖（它没成功）——下游必须等待它成功或重规划
  const readyFromPending = pending
    .filter((step) => {
      if (step.dependencies.length === 0) return true; // 根步骤，永远就绪
      return step.dependencies.every((dep) => completed.has(dep));
    })
    .map((s) => s.step_id);

  const readyExisting = ready.map((s) => s.step_id);

  // 合并去重
  const totalReady = [...new Set([...readyFromPending, ...readyExisting])];

  // 并行组划分（拓扑排序的简化版——同一层的步骤互不依赖就可以并行）
  const parallelGroups = buildParallelGroups(plan.steps, totalReady);

  return {
    ready_step_ids: readyFromPending,
    ready_existing_step_ids: readyExisting,
    total_ready_step_ids: totalReady,
    completed_step_ids: [...completed],
    failed_step_ids: [...failed],
    parallel_groups: parallelGroups,
    plan_terminal: plan.status === 'completed' || plan.status === 'cancelled',
    plan_blocked: plan.status === 'blocked',
  };
}

/**
 * 把 ready 步骤按依赖拓扑分层——同一层互不依赖，可以并行。
 *
 * 算法：
 *   1. 维护 remaining = ready 步骤集合
 *   2. 每一层取出 remaining 里依赖全部在 completed 或 "已在更高层" 的步骤
 *   3. 如果某层一个都取不出但 remaining 还非空 → 有环（PlanManager 应该已阻止），
 *      兜底把剩下的全塞到最后一个组里
 */
function buildParallelGroups(allSteps: TaskStep[], readyIds: string[]): string[][] {
  if (readyIds.length === 0) return [];

  const stepMap = new Map<string, TaskStep>();
  for (const s of allSteps) stepMap.set(s.step_id, s);

  const completedLike = new Set<string>();
  for (const s of allSteps) {
    if (s.status === 'completed') completedLike.add(s.step_id);
  }

  const remaining = new Set(readyIds);
  const groups: string[][] = [];

  while (remaining.size > 0) {
    const layer: string[] = [];
    for (const id of remaining) {
      const step = stepMap.get(id);
      if (!step) continue;
      // 依赖全部满足：要么在 completedLike，要么在当前层（同一层依赖不算——实际上 ready 步骤的依赖应该已经满足）
      const depsMet = step.dependencies.every((dep) => completedLike.has(dep) || remaining.has(dep) === false);
      if (depsMet) layer.push(id);
    }

    if (layer.length === 0) {
      // 环兜底（不应到达）
      layer.push(...remaining);
      groups.push(layer);
      break;
    }

    // 把 layer 从 remaining 移除，标记为"已处理"
    for (const id of layer) {
      remaining.delete(id);
      completedLike.add(id); // 当前层的步骤对下一层来说"依赖已满足"
    }
    groups.push(layer);
  }

  return groups;
}

/**
 * 给定一个 step_id 集合，找出它们按依赖拓扑排序后的执行顺序。
 * 这是 StepExecutor 串行执行时用的；并行执行直接用 parallel_groups。
 */
export function topologicalOrder(stepIds: string[], allSteps: ReadonlyArray<TaskStep>): string[] {
  const stepMap = new Map<string, TaskStep>();
  for (const s of allSteps) stepMap.set(s.step_id, s);

  const targetSet = new Set(stepIds);
  const inGroup: Record<string, number> = {}; // 在目标集合内的入度
  const outEdges: Record<string, string[]> = {}; // 在目标集合内的出边

  for (const id of stepIds) inGroup[id] = 0;
  for (const s of allSteps) {
    if (!targetSet.has(s.step_id)) continue;
    outEdges[s.step_id] = [];
    inGroup[s.step_id] = inGroup[s.step_id] ?? 0;
    for (const dep of s.dependencies) {
      if (targetSet.has(dep)) {
        inGroup[s.step_id] = (inGroup[s.step_id] ?? 0) + 1;
        // dep → s 方向
        if (!outEdges[dep]) outEdges[dep] = [];
        outEdges[dep]!.push(s.step_id);
      }
    }
  }

  // Kahn 算法
  const queue = stepIds.filter((id) => inGroup[id] === 0);
  const result: string[] = [];

  while (queue.length > 0) {
    queue.sort(); // 稳定排序让测试可预测
    const current = queue.shift()!;
    result.push(current);
    for (const next of outEdges[current] ?? []) {
      const count = inGroup[next] ?? 0;
      inGroup[next] = count - 1;
      if (inGroup[next] === 0) queue.push(next);
    }
  }

  if (result.length !== stepIds.length) {
    // 有环（PlanManager 应已阻止），兜底把剩余的加上
    for (const id of stepIds) if (!result.includes(id)) result.push(id);
  }

  return result;
}

/** 计划里剩余未终态的步骤数（供 PlanManager 判断还有没有活要干） */
export function countActiveSteps(plan: TaskPlan): { pending: number; ready: number; running: number; blocked: number; failed: number } {
  const counts = { pending: 0, ready: 0, running: 0, blocked: 0, failed: 0 };
  for (const step of plan.steps) {
    if (step.status in counts) counts[step.status as keyof typeof counts]++;
  }
  return counts;
}

/** 是否还有步骤可以推进（ready 或 pending 能变成 ready） */
export function hasWorkRemaining(plan: TaskPlan): boolean {
  if (plan.status === 'completed' || plan.status === 'cancelled') return false;
  if (plan.status === 'failed') return true; // 还有重试或重规划
  if (plan.status === 'blocked') return false;
  // pending / ready / running 都算还有活
  return true;
}
