/**
 * AutonomousRunner：长任务自主执行引擎（v0.5.0 Phase 2）。
 *
 * 核心设计：
 *   - 接收注入的步骤计划与执行器，不负责 CLI / Workflow 的装配；
 *   - 执行器通过 controls 在模型/工具调用前记账，并接收取消信号；
 *   - 通过 ApprovalManager 对 L2/L3 操作作执行前审批；
 *   - 检查点由调用层持久化，本类不提供崩溃恢复。
 *
 * 安全约束：
 *   - 不允许无限循环 → maxSteps 硬上限；
 *   - 模型/工具预算须由执行器在实际调用前通过 controls 报告；
 *   - 不因为用户离线自动扩大权限；
 *   - 高风险操作必须经 ApprovalManager；
 *   - 所有工具执行经 Security Gateway。
 */
import { ForgeError } from '@forgex/shared';
import type { ApprovalManager } from '@forgex/approval';
import type { StructuredRequirement, RequirementTrace } from '@forgex/requirement-engine';
import type { BudgetTracker } from '../budget/execution-budget.js';
import type { RequirementAnalyzer } from '@forgex/requirement-engine';

export interface AutonomousRunnerOptions {
  /** 预算追踪器（必填，由上层创建并注入） */
  budget: BudgetTracker;
  /** 需求分析器（执行前门禁） */
  analyzer: RequirementAnalyzer;
  /** 审批管理器（高风险操作） */
  approvalManager?: ApprovalManager;
  /** 最大循环尝试次数（防止无限循环重试同一错误） */
  maxRetryPerStep?: number;
}

export interface StepResult {
  stepId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'skipped';
  message?: string;
  tokenUsage?: number;
}

/** 执行适配器必须在实际调用前报告模型/工具请求，并在响应后报告用量。 */
export interface AutonomousStepControls {
  signal: AbortSignal;
  beforeModelCall(): void;
  beforeToolCall(count?: number): void;
  recordTokens(tokens: number): void;
}

export interface AutonomousRunResult {
  requirementId: string;
  traceId: string;
  success: boolean;
  steps: StepResult[];
  totalStepsExecuted: number;
  budgetSnapshot: ReturnType<BudgetTracker['snapshot']>;
  finalMessage: string;
}

export class AutonomousRunner {
  private readonly budget: BudgetTracker;
  private readonly analyzer: RequirementAnalyzer;
  private readonly approvalManager?: ApprovalManager;
  private readonly maxRetryPerStep: number;

  constructor(options: AutonomousRunnerOptions) {
    this.budget = options.budget;
    this.analyzer = options.analyzer;
    this.approvalManager = options.approvalManager;
    this.maxRetryPerStep = options.maxRetryPerStep ?? 2;
    if (!Number.isInteger(this.maxRetryPerStep) || this.maxRetryPerStep < 0) {
      throw new ForgeError('CONFIG_INVALID', 'maxRetryPerStep 必须是非负整数');
    }
  }

  /**
   * 执行单个需求。
   *
   * @param requirement 已批准的需求（analyzer 会再次门禁）
   * @param trace 追溯链（Phase 1 创建的）
   * @param executor 步骤执行器（由上层注入，隔离 LLM 和具体调度）
   */
  async execute(
    requirement: StructuredRequirement,
    trace: RequirementTrace,
    executor: AutonomousStepExecutor,
    options: { signal?: AbortSignal } = {},
  ): Promise<AutonomousRunResult> {
    // 1. 执行前门禁（必须再次验证需求已批准 + 风险可接受）
    this.analyzer.assertReady(requirement);
    if (trace.requirementId !== requirement.id || trace.traceId !== requirement.traceId) {
      throw new ForgeError('REQUIREMENT_TRACE_NOT_FOUND', '需求与追溯链不匹配，拒绝执行', {
        details: { requirementId: requirement.id, traceRequirementId: trace.requirementId, traceId: trace.traceId },
      });
    }

    const steps: StepResult[] = [];
    const stepPlan = executor.planSteps(requirement);

    if (!Array.isArray(stepPlan) || stepPlan.length === 0) {
      return {
        requirementId: requirement.id,
        traceId: trace.traceId,
        success: false,
        steps: [{ stepId: '__empty_plan', status: 'failed', message: '执行器没有生成任何步骤' }],
        totalStepsExecuted: 0,
        budgetSnapshot: this.budget.snapshot(),
        finalMessage: '需求执行未开始：没有可执行步骤',
      };
    }
    const stepIds = new Set<string>();
    const riskLevels = new Set(['L0', 'L1', 'L2', 'L3', 'production-deploy']);
    for (const step of stepPlan) {
      if (!step || typeof step.id !== 'string' || !step.id.trim() || typeof step.name !== 'string' || !step.name.trim() || typeof step.description !== 'string' || !step.description.trim() || stepIds.has(step.id) || (step.riskLevel !== undefined && !riskLevels.has(step.riskLevel))) {
        return {
          requirementId: requirement.id,
          traceId: trace.traceId,
          success: false,
          steps: [{ stepId: '__invalid_plan', status: 'failed', message: '执行器返回了无效或重复的步骤定义' }],
          totalStepsExecuted: 0,
          budgetSnapshot: this.budget.snapshot(),
          finalMessage: '需求执行未开始：步骤计划无效',
        };
      }
      stepIds.add(step.id);
    }

    const controller = new AbortController();
    const parentSignal = options.signal;
    const forwardAbort = (): void => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) forwardAbort();
    else parentSignal?.addEventListener('abort', forwardAbort, { once: true });
    let timeBudgetExpired = false;
    const budgetAtStart = this.budget.snapshot();
    const remainingMs = Math.max(0, budgetAtStart.limits.maxTimeMs - budgetAtStart.usage.timeMs);
    const budgetTimer = setTimeout(() => {
      timeBudgetExpired = true;
      controller.abort(new ForgeError('BUDGET_EXCEEDED', '时间预算耗尽'));
    }, Math.max(1, remainingMs));
    budgetTimer.unref?.();

    // 绑定追溯链到工作流（Phase 2 关联）
    // 这里仅更新状态，workflowRunId 由 WorkflowRunner 启动时回填
    // 实际绑定在 executor 内部

    try {
    for (const step of stepPlan) {
      if (controller.signal.aborted) {
        steps.push({
          stepId: '__cancelled',
          status: 'cancelled',
          message: timeBudgetExpired ? '时间预算耗尽，已停止' : '执行已取消',
        });
        break;
      }
      try {
        // 2. 预算检查（每步前必须过）
        this.budget.addStep();
      } catch (err) {
        // 预算耗尽 → 优雅停止（不 propagate）
        if (err instanceof ForgeError && err.code === 'BUDGET_EXCEEDED') {
          steps.push({
            stepId: '__budget_exhausted',
            status: 'cancelled',
            message: '执行预算耗尽，已停止。可申请追加预算后恢复',
          });
          break;
        }
        throw err;
      }

      // 3. 高风险操作检查
      if (step.riskLevel === 'L2' || step.riskLevel === 'L3' || step.riskLevel === 'production-deploy') {
        if (!this.approvalManager) {
          // 无审批管理器时默认拒绝
          steps.push({ stepId: step.id, status: 'cancelled', message: '该高风险操作需要审批管理器' });
          break;
        }
        const approval = await this.approvalManager.requestApproval({
          operation: step.id,
          riskLevel: step.riskLevel === 'L2' ? 'L2' : 'L3',
          summary: `${step.name}: ${step.description}`,
          params: { requirementId: requirement.id, stepId: step.id, description: step.description },
          targetEnvironment: step.riskLevel === 'production-deploy' ? 'production' : 'unknown',
        });
        if (!approval.approved) {
          steps.push({ stepId: step.id, status: 'cancelled', message: approval.record.denialReason ?? '高风险步骤未获批准' });
          break;
        }
        if (controller.signal.aborted) {
          steps.push({ stepId: step.id, status: 'cancelled', message: timeBudgetExpired ? '时间预算耗尽，已停止' : '执行已取消' });
          break;
        }
      }

      // 4. 执行步骤
      let result: StepResult;
      try {
        result = await this.executeStepWithRetry(step, executor, controller.signal);
      } catch (err) {
        if (!(err instanceof ForgeError) || err.code !== 'BUDGET_EXCEEDED') throw err;
        steps.push({ stepId: step.id, status: 'cancelled', message: err.message });
        break;
      }
      steps.push(result);

      // 5. 失败且不可重试 → 停止
      if (result.status === 'failed') {
        break;
      }
      if (result.status === 'cancelled') break;

      // 6. 预算耗尽 → 停止
      if (!this.budget.hasBudget()) {
        steps.push({
          stepId: '__budget_exhausted',
          status: 'cancelled',
          message: '执行预算耗尽，已停止。可申请追加预算后恢复',
        });
        break;
      }
    }
    } finally {
      clearTimeout(budgetTimer);
      parentSignal?.removeEventListener('abort', forwardAbort);
    }

    // 7. 汇总结果
    const success = steps.length === stepPlan.length && steps.every((s) => s.status === 'completed' || s.status === 'skipped');
    return {
      requirementId: requirement.id,
      traceId: trace.traceId,
      success,
      steps,
      totalStepsExecuted: steps.length,
      budgetSnapshot: this.budget.snapshot(),
      finalMessage: success ? '需求执行完成' : '需求执行未完成，请检查失败步骤',
    };
  }

  /** 带重试的单步执行 */
  private async executeStepWithRetry(
    step: PlannedStep,
    executor: AutonomousStepExecutor,
    signal: AbortSignal,
  ): Promise<StepResult> {
    let lastError: unknown = null;
    let attemptsUsed = 0;
    for (let attempt = 0; attempt <= this.maxRetryPerStep; attempt++) {
      attemptsUsed = attempt + 1;
      if (signal.aborted) {
        return { stepId: step.id, status: 'cancelled', message: '执行已取消' };
      }
      const reported = { tokens: 0, toolCalls: 0, modelCalls: 0 };
      const controls: AutonomousStepControls = {
        signal,
        beforeModelCall: () => {
          if (signal.aborted) throw new ForgeError('BUDGET_EXCEEDED', '执行已取消或预算耗尽');
          this.budget.addModelCall();
          reported.modelCalls += 1;
        },
        beforeToolCall: (count = 1) => {
          if (signal.aborted) throw new ForgeError('BUDGET_EXCEEDED', '执行已取消或预算耗尽');
          if (!Number.isInteger(count) || count < 0) throw new ForgeError('INTERNAL', '工具调用计数无效');
          const safeCount = Math.max(0, Math.floor(count));
          for (let i = 0; i < safeCount; i += 1) this.budget.addToolCall();
          reported.toolCalls += safeCount;
        },
        recordTokens: (tokens) => {
          if (!Number.isFinite(tokens) || tokens < 0) throw new ForgeError('INTERNAL', '模型 token 用量无效');
          this.budget.addTokens(tokens);
          reported.tokens += tokens;
        },
      };
      try {
        const result = await executor.executeStep(step, controls);
        if (signal.aborted) return { stepId: step.id, status: 'cancelled', message: '执行已取消或时间预算耗尽' };
        if (!result || typeof result !== 'object') throw new ForgeError('INTERNAL', '执行器未返回有效结果');
        if (result.tokenUsage !== undefined && (!Number.isFinite(result.tokenUsage) || result.tokenUsage < 0)) {
          throw new ForgeError('INTERNAL', '执行器返回的 token 用量无效');
        }
        if (result.toolCalls !== undefined && (!Number.isInteger(result.toolCalls) || result.toolCalls < 0)) {
          throw new ForgeError('INTERNAL', '执行器返回的工具调用计数无效');
        }
        if (result.llmCalls !== undefined && (!Number.isInteger(result.llmCalls) || result.llmCalls < 0)) {
          throw new ForgeError('INTERNAL', '执行器返回的模型调用计数无效');
        }
        const reportedTokens = Math.max(0, (result.tokenUsage ?? 0) - reported.tokens);
        const reportedTools = Math.max(0, (result.toolCalls ?? 0) - reported.toolCalls);
        const reportedModels = Math.max(0, (result.llmCalls ?? 0) - reported.modelCalls);
        if (reportedTokens > 0) this.budget.addTokens(reportedTokens);
        for (let i = 0; i < reportedTools; i += 1) this.budget.addToolCall();
        for (let i = 0; i < reportedModels; i += 1) this.budget.addModelCall();
        if (!result.success && result.retryable === true && reported.toolCalls + reportedTools === 0 && attempt < this.maxRetryPerStep) {
          lastError = new ForgeError('INTERNAL', result.summary ?? '执行器报告可重试失败');
          continue;
        }
        return {
          stepId: step.id,
          status: result.success ? 'completed' : 'failed',
          tokenUsage: result.tokenUsage,
          message: result.summary ?? (result.success ? '步骤执行完成' : '执行器报告步骤失败'),
        };
      } catch (err) {
        if (signal.aborted) return { stepId: step.id, status: 'cancelled', message: '执行已取消或时间预算耗尽' };
        lastError = err;
        // 预算耗尽异常不重试
        if (err instanceof ForgeError && err.code === 'BUDGET_EXCEEDED') {
          throw err;
        }
        // 已开始工具调用的步骤可能产生副作用，禁止盲目重放。
        if (reported.toolCalls > 0) break;
      }
    }
    return {
      stepId: step.id,
      status: 'failed',
      message: `尝试 ${attemptsUsed} 次后仍然失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    };
  }
}

/** 规划好的执行步骤 */
export interface PlannedStep {
  id: string;
  name: string;
  riskLevel?: 'L0' | 'L1' | 'L2' | 'L3' | 'production-deploy';
  description: string;
}

/** 步骤执行器（解耦接口，生产注入，测试用 mock） */
export interface AutonomousStepExecutor {
  /** 从需求规划出执行步骤 */
  planSteps(requirement: StructuredRequirement): PlannedStep[];
  /**
   * 执行单个步骤。必须在模型/工具调用前调用对应 controls，传递 signal 给可取消操作，
   * 并通过 recordTokens 上报用量；否则相应预算无法在调用前拦截。
   */
  executeStep(step: PlannedStep, controls: AutonomousStepControls): Promise<{
    success: boolean;
    tokenUsage?: number;
    llmCalls?: number;
    toolCalls?: number;
    summary?: string;
    /** 只有确认本次失败无副作用时才能设置 true。 */
    retryable?: boolean;
  }>;
}
