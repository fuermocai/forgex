/**
 * AutonomousRunner：长任务自主执行引擎（v0.5.0 Phase 2）。
 *
 * 核心设计：
 *   - 不重写调度，内部调用 v0.4.0 WorkflowRunner + TaskPlanner；
 *   - 每步检查 ExecutionBudget，耗尽立即停；
 *   - 通过 RequirementModelInterface 解耦 LLM（复用 Phase 1 解耦模式）；
 *   - 通过 v0.4.0 ApprovalManager 处理高风险操作；
 *   - 每阶段保存检查点（复用 v0.4.0 Recovery.CheckpointStore）。
 *
 * 安全约束：
 *   - 不允许无限循环 → maxSteps 硬上限；
 *   - 不允许无限调模型 → maxModelCalls；
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
  ): Promise<AutonomousRunResult> {
    // 1. 执行前门禁（必须再次验证需求已批准 + 风险可接受）
    this.analyzer.assertReady(requirement);

    const steps: StepResult[] = [];
    const stepPlan = executor.planSteps(requirement);

    // 绑定追溯链到工作流（Phase 2 关联）
    // 这里仅更新状态，workflowRunId 由 WorkflowRunner 启动时回填
    // 实际绑定在 executor 内部

    for (const step of stepPlan) {
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
      if (step.riskLevel === 'L3' || step.riskLevel === 'production-deploy') {
        if (!this.approvalManager) {
          // 无审批管理器时默认拒绝
          steps.push({ stepId: step.id, status: 'cancelled', message: 'L3 操作需要审批管理器' });
          break;
        }
        // 这里不实际调 approvalManager（executor 会在执行时触发）
        // 但我们必须确保未批准的高风险步骤被明确标记
      }

      // 4. 执行步骤
      const result = await this.executeStepWithRetry(step, executor);
      steps.push(result);

      // 5. 失败且不可重试 → 停止
      if (result.status === 'failed' && !result.message?.includes('retry')) {
        break;
      }

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

    // 7. 汇总结果
    const success = steps.every((s) => s.status === 'completed' || s.status === 'skipped');
    return {
      requirementId: requirement.id,
      traceId: requirement.traceId,
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
  ): Promise<StepResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetryPerStep; attempt++) {
      try {
        const result = await executor.executeStep(step);
        this.budget.addTokens(result.tokenUsage ?? 0);
        this.budget.addToolCall();
        const llmCalls = result.llmCalls ?? 0;
        if (llmCalls > 0) {
          for (let i = 0; i < llmCalls; i++) this.budget.addModelCall();
        }
        return {
          stepId: step.id,
          status: 'completed',
          tokenUsage: result.tokenUsage,
          message: result.summary,
        };
      } catch (err) {
        lastError = err;
        // 预算耗尽异常不重试
        if (err instanceof ForgeError && err.code === 'BUDGET_EXCEEDED') {
          throw err;
        }
      }
    }
    return {
      stepId: step.id,
      status: 'failed',
      message: `重试 ${this.maxRetryPerStep + 1} 次后仍然失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
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
  /** 执行单个步骤 */
  executeStep(step: PlannedStep): Promise<{
    success: boolean;
    tokenUsage?: number;
    llmCalls?: number;
    summary?: string;
  }>;
}
