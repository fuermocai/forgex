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
import type { JsonValue, RunMetrics } from '@forgex/shared';
import type { PlanManager } from './plan-manager.js';
import { verifyStep } from './task-verifier.js';
import type { ExecutionResult, TaskPlan, TaskStep } from './types.js';

export interface StepExecutorOptions {
  planManager: PlanManager;
  /** Agent 实例——用于执行单个步骤（可选，不传时 StepExecutor 只做状态推进测试用） */
  agent?: { run: (prompt: string, options?: { signal?: AbortSignal; allowedTools?: ReadonlySet<string> }) => Promise<LoopResult & { metrics?: Pick<RunMetrics, 'totalMs' | 'modelCalls' | 'totalTokens'> }> };
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
  private readonly agent?: { run: (prompt: string, options?: { signal?: AbortSignal; allowedTools?: ReadonlySet<string> }) => Promise<LoopResult & { metrics?: Pick<RunMetrics, 'totalMs' | 'modelCalls' | 'totalTokens'> }> };
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
    let totalToolCalls = 0;
    let totalModelCalls = 0;
    let totalTokens = 0;
    let totalDurationMs = 0;

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
      const attemptResult = await this.runAttempt(plan, step, retryHint);
      totalToolCalls += attemptResult.toolCallCount;
      totalModelCalls += attemptResult.modelCallCount ?? 0;
      totalTokens += attemptResult.tokenUsage ?? 0;
      totalDurationMs += attemptResult.durationMs;
      const result: ExecutionResult = {
        ...attemptResult,
        toolCallCount: totalToolCalls,
        durationMs: totalDurationMs,
        ...(totalModelCalls > 0 ? { modelCallCount: totalModelCalls } : {}),
        ...(totalTokens > 0 ? { tokenUsage: totalTokens } : {}),
      };
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
    const startedAt = Date.now();
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
    const verificationPrompt = step.verification.type === 'file_content'
      ? `验收要求: ${step.verification.target} 的完整内容必须与下面给出的预期内容一致。完成后使用本步骤允许的文件工具确认最终内容；如果允许 read_file，必须从第 1 行完整读取到文件末尾。\n预期完整内容:\n${step.verification.expectedContent ?? ''}\n`
      : '';
    const prompt =
      `${step.description}\n\n` +
      `目标: 执行上述步骤，完成后输出最终结果。\n` +
      `风险等级: ${step.risk_level}\n` +
      verificationPrompt +
      (step.required_tools.length > 0 ? `需要工具: ${step.required_tools.join(', ')}\n` : '') +
      (retryHint ? `\n上一轮未通过验证：${retryHint}\n请先检查当前状态，再完成缺失部分。\n` : '') +
      (extra ? `\n附加上下文:\n${extra}\n` : '');

    try {
      // [P3] 严格工具白名单：每步只能调用 step.required_tools 里声明的工具
      //      如果 required_tools 为空，allowedTools 传空 Set → 禁止所有工具（fail closed）
      const allowedTools = step.required_tools.length > 0
        ? new Set(step.required_tools)
        : new Set<string>();

      const result = await this.agent.run(prompt, { signal: this.signal, allowedTools });
      const toolCalls = result.toolCalls;
      const durationMs = result.metrics?.totalMs ?? Date.now() - startedAt;
      const modelCallCount = result.metrics?.modelCalls;
      const tokenUsage = result.metrics?.totalTokens;

      const cancelled = result.reason === 'aborted';
      if (cancelled) {
        return {
          success: false,
          toolCallCount: toolCalls,
          durationMs,
          ...(modelCallCount !== undefined ? { modelCallCount } : {}),
          ...(tokenUsage !== undefined ? { tokenUsage } : {}),
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
        durationMs,
        ...(modelCallCount !== undefined ? { modelCallCount } : {}),
        ...(tokenUsage !== undefined ? { tokenUsage } : {}),
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
        durationMs: Date.now() - startedAt,
        verificationPassed: false,
        failureReason: err instanceof Error ? err.message : String(err),
        // throw new Error 无法区分"provider 构造失败"（配置错误，重试无意义）和
        // "模型瞬态超时"（重试可能恢复）。保守策略：catch 块一律不重放，
        // 让调用方（benchmark）用 return LoopResult { error: { retryable: true } }
        // 明确标记可重试的瞬态失败，而不是依赖 throw。
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
      return typeof data.path === 'string'
        ? {
            path: data.path,
            ...(typeof data.contentHash === 'string' ? { contentHash: data.contentHash } : {}),
            contentComplete: data.truncated !== true && data.startLine === 1 && typeof data.totalLines === 'number' && data.endLine === data.totalLines,
          }
        : {};
    case 'edit_file':
    case 'write_file':
      return typeof data.path === 'string'
        ? {
            path: data.path,
            changed: data.changed === true,
            ...(typeof data.contentHash === 'string' ? { contentHash: data.contentHash } : {}),
            contentComplete: true,
          }
        : {};
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
