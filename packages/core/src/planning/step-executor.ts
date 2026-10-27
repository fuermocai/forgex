/**
 * StepExecutor：单个步骤的原子执行（v0.3.0 Phase 1）。
 *
 * 生命周期：
 *   1. 接收一个 plan + step_id
 *   2. 调 PlanManager.markStepRunning(planId, stepId)
 *   3. 构造 prompt（step.description + plan 上下文 + evidence 引用）
 *   4. 调 AgentLoop.run(prompt) 得到执行结果（异步）
 *   5. 调 TaskVerifier.verifyStep(step, result)
 *   6. 通过 PlanManager 标记 completed / failed
 *   7. 失败时检查重试预算，预算内则重试，预算外则 fail
 *
 * 关键：StepExecutor 不做 DAG 调度——那是 DependencyScheduler + PlanManager 的事。
 * 它只负责"跑一个 step，处理结果，更新状态"。
 *
 * 取消：AbortSignal 传入 AgentLoop → 被取消后返回 LoopResult.reason='cancelled'
 * StepExecutor 检测到 → PlanManager.updateStepStatus(cancelled) + 传播 abortRequested。
 *
 * 不实现 AgentLoop 调用的 mock 适配——Phase 1 先写骨架，集成时再补。
 */
import type { LoopResult } from '../agent/agent-loop.js';
import type { JsonValue } from '@forgex/shared';
import type { PlanManager } from './plan-manager.js';
import { verifyStep } from './task-verifier.js';
import type { ExecutionResult, TaskPlan, TaskStep } from './types.js';

export interface StepExecutorOptions {
  planManager: PlanManager;
  /** Agent 实例——用于执行单个步骤（可选，不传时 StepExecutor 只做状态推进测试用） */
  agent?: { run: (prompt: string, options?: { signal?: AbortSignal }) => Promise<LoopResult> };
  /** 最大重试次数上限（默认 2，每个 step 的 max_attempts 覆盖） */
  globalMaxAttempts?: number;
  /** 全局 AbortSignal（用户取消整个计划） */
  signal?: AbortSignal;
  /** 执行超时（毫秒）——单步超时，默认 120s */
  stepTimeoutMs?: number;
  /** 额外上下文注入（给 Agent 的 system prompt 补充） */
  contextBuilder?: (plan: TaskPlan, step: TaskStep) => string;
}

export interface StepExecResult {
  step_id: string;
  /** 最终状态（执行 + 重试后的） */
  final_status: 'completed' | 'failed' | 'cancelled';
  /** 实际调用了 AgentLoop 几次（含重试） */
  attemptsUsed: number;
  /** 执行结果（最后一次 attempt 的） */
  execution_result?: ExecutionResult;
  /** 验证结果（最后一次 attempt 的） */
  verification_result?: ReturnType<typeof verifyStep>;
  /** 总耗时毫秒 */
  duration_ms: number;
  /** 如果是取消导致的最终态 */
  cancelled: boolean;
}

export class StepExecutor {
  private readonly agent?: { run: (prompt: string, options?: { signal?: AbortSignal }) => Promise<LoopResult> };
  private readonly planManager: PlanManager;
  private readonly globalMaxAttempts: number;
  private readonly signal?: AbortSignal;
  private readonly stepTimeoutMs: number;
  private readonly contextBuilder?: (plan: TaskPlan, step: TaskStep) => string;

  constructor(options: StepExecutorOptions) {
    this.agent = options.agent;
    this.planManager = options.planManager;
    this.globalMaxAttempts = options.globalMaxAttempts ?? 2;
    this.signal = options.signal;
    this.stepTimeoutMs = options.stepTimeoutMs ?? 120_000;
    this.contextBuilder = options.contextBuilder;
  }

  /**
   * 执行一个步骤。不抛异常——所有错误都转成 StepExecResult.final_status='failed'。
   *
   * 完整流程：mark running → AgentLoop → verify → mark completed/failed
   *
   * 重试策略（v0.3.x）：**只有「明确可重试且没有产生工具副作用」的失败才重放**。
   * Agent 步骤可能已经改过文件、跑过命令，盲目重放会把写入/提交执行两遍；
   * 因此 `retryable !== true`，或本轮已有工具调用结果时，立刻结束。
   * 预算内重试时走 failed → ready → running 的合法转移。
   */
  async executeStep(planId: string, stepId: string): Promise<StepExecResult> {
    const started = Date.now();
    const plan = this.planManager.getPlan(planId);
    const step = plan.steps.find((s) => s.step_id === stepId);
    if (!step) {
      return {
        step_id: stepId,
        final_status: 'failed',
        attemptsUsed: 0,
        duration_ms: Date.now() - started,
        cancelled: false,
      };
    }

    // 调度器把"依赖已满足的 pending"视为就绪（见 dep-scheduler.computeSchedule），
    // 但状态机不允许 pending → running，因此执行前先幂等推进到 ready。
    // 这同时覆盖直接调用 executeStep 与 TaskPlanner.runSingle/runBatch 两条路径。
    if (step.status === 'pending') {
      try {
        this.planManager.updateStepStatus(planId, stepId, 'ready');
      } catch (err) {
        return {
          step_id: stepId,
          final_status: 'failed',
          attemptsUsed: 0,
          duration_ms: Date.now() - started,
          cancelled: false,
        };
      }
    }

    const maxAttempts = Math.min(step.max_attempts, this.globalMaxAttempts);
    let attemptsUsed = 0;
    let lastResult: ExecutionResult | undefined;
    let lastVerifyResult: ReturnType<typeof verifyStep> | undefined;

    while (attemptsUsed < maxAttempts) {
      // 检查全局取消
      if (this.signal?.aborted) {
        this.planManager.updateStepStatus(planId, stepId, 'cancelled');
        return {
          step_id: stepId,
          final_status: 'cancelled',
          attemptsUsed,
          duration_ms: Date.now() - started,
          cancelled: true,
        };
      }

      // 每次尝试都走 ready → running（首次在入口处已推进到 ready；
      // 重试时上一轮失败后已转回 ready），保证状态机转移合法。
      try {
        this.planManager.markStepRunning(planId, stepId);
      } catch {
        return {
          step_id: stepId,
          final_status: 'failed',
          attemptsUsed,
          duration_ms: Date.now() - started,
          cancelled: false,
        };
      }

      attemptsUsed++;

      const retryHint = lastVerifyResult && !lastVerifyResult.passed ? lastVerifyResult.reason : undefined;
      const result = await this.runAttempt(plan, step, retryHint);
      lastResult = result;
      if (result.cancelled) {
        this.planManager.updateStepStatus(planId, stepId, 'cancelled', result.failureReason ?? '执行被取消');
        this.planManager.updateStepResult(planId, stepId, result);
        return {
          step_id: stepId,
          final_status: 'cancelled',
          attemptsUsed,
          execution_result: result,
          duration_ms: Date.now() - started,
          cancelled: true,
        };
      }
      lastVerifyResult = verifyStep(step, result);

      if (result.success && lastVerifyResult.passed) {
        // 成功
        this.planManager.updateStepStatus(planId, stepId, 'completed');
        this.planManager.updateStepResult(planId, stepId, result);
        return {
          step_id: stepId,
          final_status: 'completed',
          attemptsUsed: attemptsUsed,
          execution_result: result,
          verification_result: lastVerifyResult,
          duration_ms: Date.now() - started,
          cancelled: false,
        };
      }

      // 本次尝试失败：running → failed（合法转移，PlanManager 会累加 attempts）
      this.planManager.updateStepStatus(planId, stepId, 'failed', result.failureReason);

      // 只有明确的瞬时错误且本轮没有工具调用/结果时才重放。
      // 验证失败本身不是瞬时错误；有工具记录就不能假定副作用可安全重放。
      if (
        result.retryable !== true ||
        result.toolCallCount > 0 ||
        (result.toolResults?.length ?? 0) > 0
      ) break;
      if (attemptsUsed >= maxAttempts) {
        break;
      }
      // 还有重试预算：failed → ready，准备下一轮
      this.planManager.updateStepStatus(planId, stepId, 'ready');
    }

    // 所有重试用完，步骤已处于 failed 态
    if (lastResult) this.planManager.updateStepResult(planId, stepId, lastResult);

    return {
      step_id: stepId,
      final_status: 'failed',
      attemptsUsed: attemptsUsed,
      execution_result: lastResult,
      verification_result: lastVerifyResult,
      duration_ms: Date.now() - started,
      cancelled: false,
    };
  }

  /**
   * 单次 attempt 执行：组装 prompt → 调 Agent → 解析结果。
   * 如果没注入 agent（测试场景），返回空的失败结果。
   */
  private async runAttempt(plan: TaskPlan, step: TaskStep, retryHint?: string): Promise<ExecutionResult> {
    if (!this.agent) {
      return {
        success: false,
        toolCallCount: 0,
        durationMs: 0,
        verificationPassed: false,
        failureReason: 'StepExecutor 未注入 agent，无法执行',
        // 没有执行者，重试多少次结果都一样，直接判定不可重试
        retryable: false,
      };
    }

    const extra = this.contextBuilder ? this.contextBuilder(plan, step) : '';
    const prompt =
      `${step.description}\n\n` +
      `目标: 执行上述步骤，完成后输出最终结果。\n` +
      `风险等级: ${step.risk_level}\n` +
      (step.required_tools.length > 0 ? `需要工具: ${step.required_tools.join(', ')}\n` : '') +
      (retryHint ? `\n上一轮未通过验证：${retryHint}\n请先检查当前状态，再完成缺失部分。\n` : '') +
      (extra ? `\n附加上下文:\n${extra}\n` : '');

    try {
      const result = await this.agent.run(prompt, { signal: this.signal });
      const toolCalls = result.toolCalls;

      const cancelled = result.reason === 'aborted';
      if (cancelled) {
        return {
          success: false,
          toolCallCount: toolCalls,
          durationMs: 0,
          verificationPassed: false,
          failureReason: '执行被取消',
          cancelled: true,
        };
      }

      const success = result.reason === 'completed';
      const toolResults = result.toolResults ?? [];
      // Agent 正常结束只是模型轮次结束，不等于工作已完成。
      // auto 验证至少要求有工具执行证据，且没有失败或被截断的结果。
      const hasVerifiedToolEvidence =
        toolResults.length > 0 && toolResults.every(({ result: toolResult }) => toolResult.ok && !toolResult.truncated);

      return {
        success,
        toolCallCount: toolCalls,
        durationMs: 0, // Phase 1 暂时拿不到 LoopResult 的总耗时，后续集成 metrics
        verificationPassed: success && hasVerifiedToolEvidence,
        summary: result.text,
        ...(success ? {} : { failureReason: `AgentLoop 终止原因: ${result.reason}` }),
        retryable:
          result.reason === 'error' &&
          result.error?.retryable === true &&
          (result.toolResults?.length ?? 0) === 0,
        toolResults: toolResults.map(({ toolName, result: toolResult }) => ({
          toolName,
          ok: toolResult.ok,
          truncated: toolResult.truncated,
          ...(toolResult.data !== undefined ? { data: projectVerificationData(toolName, toolResult.data) } : {}),
        })),
      };
    } catch (err) {
      return {
        success: false,
        toolCallCount: 0,
        durationMs: 0,
        verificationPassed: false,
        failureReason: err instanceof Error ? err.message : String(err),
        // 抛异常代表 AgentLoop 自身的意外状态（bug、provider 构造失败等），
        // 且无法确认是否已产生副作用，一律不重放
        retryable: false,
      };
    }
  }
}

/** 只把验证需要的字段写入计划结果，避免将整份文件/diff/命令输出塞进 checkpoint。 */
function projectVerificationData(toolName: string, raw: JsonValue): JsonValue {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, JsonValue>;
  switch (toolName) {
    case 'read_file':
      return typeof data.path === 'string' ? { path: data.path } : {};
    case 'list_directory':
      return {
        entries: Array.isArray(data.entries)
          ? data.entries.flatMap((entry) => {
              if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
              const item = entry as Record<string, JsonValue>;
              return typeof item.path === 'string' && typeof item.type === 'string'
                ? [{ path: item.path, type: item.type }]
                : [];
            })
          : [],
      };
    case 'run_command':
      return typeof data.exitCode === 'number' ? { exitCode: data.exitCode } : {};
    case 'git_status':
      return {
        entries: Array.isArray(data.entries)
          ? data.entries.flatMap((entry) => {
              if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
              const item = entry as Record<string, JsonValue>;
              return typeof item.status === 'string' ? [{ status: item.status }] : [];
            })
          : [],
      };
    case 'git_diff': {
      const hasDiff = typeof data.diff === 'string';
      const diff = hasDiff ? data.diff as string : '';
      return { complete: hasDiff, hasConflictMarkers: hasDiff && /^(<<<<<<<|=======|>>>>>>>)(?:\s.*)?$/m.test(diff) };
    }
    default:
      return {};
  }
}
