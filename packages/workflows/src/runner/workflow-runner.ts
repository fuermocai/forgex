/**
 * WorkflowRunner：工作流执行编排器（v0.4.0 Phase 1）。
 *
 * 职责：
 *   1. 按依赖拓扑顺序执行节点；
 *   2. task 节点 → 委托给 NodeExecutor.executeTask（内部可复用 TaskPlanner）；
 *   3. approval 节点 → 调用 NodeExecutor.executeApproval 阻塞等待审批；
 *   4. condition 节点 → 调用 NodeExecutor.executeCondition 选择分支；
 *   5. verification 节点 → 调用 NodeExecutor.executeVerification 校验；
 *   6. 每个节点状态变化时写 WorkflowCheckpoint；
 *   7. maxSteps 硬上限防止无限循环；
 *   8. 支持超时、取消（AbortSignal）、失败重试。
 *
 * 设计原则：
 *   - WorkflowRunner 只做编排，不做具体执行——具体执行由 NodeExecutor 负责；
 *   - 这样 WorkflowRunner 可以脱离 AgentLoop / TaskPlanner 独立测试；
 *   - 生产环境的 NodeExecutor 实现内部复用 v0.3.0 TaskPlanner。
 *
 * 与 v0.3.0 Task Planner 的关系：
 *   - task 类型节点执行时，NodeExecutor 实现内部将 WorkflowNode 转为
 *     TaskStep，调用 TaskPlanner.create + runSingle 执行；
 *   - WorkflowRunner 本身不直接依赖 TaskPlanner，通过 NodeExecutor 解耦。
 */
import { ForgeError } from '@forgex/shared';
import {
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeResult,
  type WorkflowNodeStatus,
  type WorkflowExecutionReport,
  type WorkflowState,
  newWorkflowInstanceId,
  workflowNowIso,
  computeWorkflowState,
  isWorkflowTerminal,
  WORKFLOW_NODE_STATUSES,
} from '../types.js';
import { WorkflowStateMachine } from './state-machine.js';
import { WorkflowCheckpoint, buildCheckpointRecord } from './checkpoint.js';
import { WorkflowValidator } from '../validation/workflow-validator.js';

/* ------------------------------------------------------------------ */
/* NodeExecutor：节点执行器接口                                          */
/* ------------------------------------------------------------------ */

/**
 * 节点执行上下文。
 * 传递给 NodeExecutor 的每个方法，包含工作流实例信息和取消信号。
 */
export interface WorkflowContext {
  /** 工作流实例 ID */
  workflowInstanceId: string;
  /** 工作流定义 ID */
  workflowId: string;
  /** 全局取消信号 */
  signal?: AbortSignal;
  /** 已执行节点的结果（供 condition 节点查询） */
  nodeResults: Map<string, WorkflowNodeResult>;
}

/**
 * 节点执行器接口。
 *
 * 生产环境实现内部复用 v0.3.0 TaskPlanner 执行 task 节点；
 * 测试环境可用 mock 实现。
 */
export interface NodeExecutor {
  /** 执行 task 节点，返回执行结果 */
  executeTask(node: WorkflowNode, ctx: WorkflowContext): Promise<WorkflowNodeResult>;
  /** 执行 approval 节点，返回是否通过审批 */
  executeApproval(node: WorkflowNode, ctx: WorkflowContext): Promise<boolean>;
  /** 执行 verification 节点，返回是否通过验证 */
  executeVerification(node: WorkflowNode, ctx: WorkflowContext): Promise<boolean>;
  /**
   * 执行 condition 节点，返回选择的分支节点 ID。
   * 返回 null 表示不选择任何分支（条件不满足）。
   */
  executeCondition(node: WorkflowNode, ctx: WorkflowContext): Promise<string | null>;
}

/* ------------------------------------------------------------------ */
/* WorkflowRunner                                                      */
/* ------------------------------------------------------------------ */

export interface WorkflowRunnerOptions {
  /** 节点执行器（必填） */
  nodeExecutor: NodeExecutor;
  /** 检查点存储（可选，不传则不持久化） */
  checkpoint?: WorkflowCheckpoint;
  /** 全局取消信号 */
  signal?: AbortSignal;
  /** 最大步骤数（防止无限循环），默认 50 */
  maxSteps?: number;
}

/** 运行结果 */
export interface WorkflowRunResult {
  report: WorkflowExecutionReport;
  nodes: WorkflowNode[];
}

export class WorkflowRunner {
  private readonly nodeExecutor: NodeExecutor;
  private readonly checkpoint?: WorkflowCheckpoint;
  private readonly signal?: AbortSignal;
  private readonly maxSteps: number;
  private readonly stateMachine = new WorkflowStateMachine();
  private readonly validator = new WorkflowValidator();

  constructor(options: WorkflowRunnerOptions) {
    this.nodeExecutor = options.nodeExecutor;
    this.checkpoint = options.checkpoint;
    this.signal = options.signal;
    this.maxSteps = options.maxSteps ?? 50;
  }

  /**
   * 运行一个工作流。
   *
   * @param def 工作流定义
   * @param existingInstanceId 可选——从检查点恢复时传入已有实例 ID
   * @returns 执行报告 + 最终节点状态
   */
  async run(def: WorkflowDefinition, existingInstanceId?: string): Promise<WorkflowRunResult> {
    const validation = this.validator.validate(def);
    if (!validation.ok) {
      throw new ForgeError(
        'WORKFLOW_INVALID',
        `工作流定义校验失败: ${validation.errors.map((error) => error.message).join('; ')}`,
        { details: { workflowId: def.id, errors: validation.errors } },
      );
    }

    const workflowInstanceId = existingInstanceId ?? newWorkflowInstanceId();
    const started = Date.now();

    // 如果从检查点恢复，先加载已有节点状态
    let nodes = this.loadFromCheckpoint(def, workflowInstanceId);
    if (!nodes) {
      // 全新运行：深拷贝定义中的节点，重置状态为 pending
      nodes = def.nodes.map((n) => ({
        ...n,
        status: 'pending' as WorkflowNodeStatus,
        attempts: 0,
        result: undefined,
        block_reason: undefined,
        created_at: workflowNowIso(),
        updated_at: workflowNowIso(),
      }));
    }

    // 节点在上次运行时处于 running，说明进程可能在副作用发生后、结果落盘前崩溃。
    // 不自动重放：调用方必须先核对外部状态，再创建新的实例继续，避免重复部署/写入等操作。
    const interrupted = nodes.filter((node) => node.status === 'running');
    if (interrupted.length > 0) {
      for (const node of interrupted) {
        this.stateMachine.block(node, '上次运行中断；请先核对外部副作用，再决定是否重试');
      }
      this.persistCheckpoint(workflowInstanceId, def, nodes);
      const report = this.buildReport(
        workflowInstanceId,
        def,
        nodes,
        computeWorkflowState(nodes),
        Date.now() - started,
        0,
      );
      report.error = '检测到中断中的节点，已暂停自动恢复以避免重复执行副作用';
      return { report, nodes };
    }

    const ctx: WorkflowContext = {
      workflowInstanceId,
      workflowId: def.id,
      signal: this.signal,
      nodeResults: new Map(
        nodes
          .filter((node) => node.status === 'completed' && node.result)
          .map((node) => [node.id, node.result!] as const),
      ),
    };

    let stepsExecuted = 0;
    let cancelled = false;

    // 主循环：不断找就绪节点执行，直到没有就绪节点或达到 maxSteps
    while (stepsExecuted < this.maxSteps) {
      // 检查取消信号
      if (this.signal?.aborted) {
        cancelled = true;
        this.cancelAllPending(nodes);
        break;
      }

      const readyNode = this.findReadyNode(nodes);
      if (!readyNode) break; // 没有就绪节点，退出循环

      stepsExecuted++;

      // 执行节点
      await this.executeNode(readyNode, nodes, ctx, def);

      // 持久化检查点
      this.persistCheckpoint(workflowInstanceId, def, nodes);

      // 如果节点失败且不可重试，或被取消，终止工作流
      if (readyNode.status === 'failed' && !this.stateMachine.canRetry(readyNode)) {
        break;
      }
      if (readyNode.status === 'cancelled') {
        cancelled = true;
        break;
      }
    }

    // 取消时，所有非终态节点标记为 cancelled
    if (cancelled) {
      this.cancelAllPending(nodes);
    }

    const state = computeWorkflowState(nodes);
    const durationMs = Date.now() - started;

    const report = this.buildReport(workflowInstanceId, def, nodes, state, durationMs, stepsExecuted);

    return { report, nodes };
  }

  /* ------------------------------------------------------------------ */
  /* 内部方法                                                             */
  /* ------------------------------------------------------------------ */

  /** 从检查点加载节点状态 */
  private loadFromCheckpoint(def: WorkflowDefinition, instanceId: string): WorkflowNode[] | null {
    if (!this.checkpoint) return null;
    const record = this.checkpoint.load(instanceId);
    if (!record) return null;

    if (
      typeof record !== 'object' ||
      !Array.isArray(record.nodes) ||
      record.nodes.some((node) => !node || typeof node !== 'object' || typeof node.id !== 'string')
    ) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', '检查点格式无效或已损坏', {
        details: { instanceId },
      });
    }

    // 版本兼容性校验
    if (record.workflow_version !== def.version) {
      throw new ForgeError(
        'WORKFLOW_INVALID',
        `检查点版本不兼容: checkpoint=${record.workflow_version}, definition=${def.version}`,
        { details: { workflowId: def.id, instanceId } },
      );
    }

    if (record.workflow_id !== def.id) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', '检查点与工作流定义不匹配或已损坏', {
        details: { workflowId: def.id, checkpointWorkflowId: record.workflow_id, instanceId },
      });
    }
    const expectedNodeIds = new Set(def.nodes.map((node) => node.id));
    const restoredNodeIds = record.nodes.map((node) => node.id);
    if (
      restoredNodeIds.length !== expectedNodeIds.size ||
      new Set(restoredNodeIds).size !== expectedNodeIds.size ||
      restoredNodeIds.some((nodeId) => !expectedNodeIds.has(nodeId))
    ) {
      throw new ForgeError('PLANNING_CHECKPOINT_ERROR', '检查点节点与当前工作流定义不一致', {
        details: { workflowId: def.id, instanceId },
      });
    }

    const restoredById = new Map(record.nodes.map((node) => [node.id, node]));
    for (const expected of def.nodes) {
      const restored = restoredById.get(expected.id);
      if (
        !restored ||
        restored.type !== expected.type ||
        JSON.stringify(restored.dependencies) !== JSON.stringify(expected.dependencies) ||
        !WORKFLOW_NODE_STATUSES.includes(restored.status) ||
        !Number.isInteger(restored.attempts) ||
        restored.attempts < 0 ||
        (restored.status === 'completed' && restored.result?.success !== true) ||
        (restored.status === 'failed' && restored.result?.success === true)
      ) {
        throw new ForgeError('PLANNING_CHECKPOINT_ERROR', `检查点节点状态无效: ${expected.id}`, {
          details: { workflowId: def.id, instanceId, nodeId: expected.id },
        });
      }
    }

    // 定义字段始终取当前定义，只从检查点恢复可变运行状态。
    return def.nodes.map((expected) => {
      const restored = restoredById.get(expected.id)!;
      return {
        ...expected,
        status: restored.status,
        attempts: restored.attempts,
        result: restored.result,
        block_reason: restored.block_reason,
        created_at: restored.created_at,
        updated_at: restored.updated_at,
      };
    });
  }

  /** 持久化检查点 */
  private persistCheckpoint(instanceId: string, def: WorkflowDefinition, nodes: WorkflowNode[]): void {
    if (!this.checkpoint) return;
    const state = computeWorkflowState(nodes);
    const record = buildCheckpointRecord({
      workflowInstanceId: instanceId,
      workflowId: def.id,
      workflowVersion: def.version,
      nodes,
      state,
    });
    this.checkpoint.save(record);
  }

  /**
   * 找到下一个就绪节点。
   * 就绪条件：状态为 pending 或 failed（可重试），且所有依赖都已 completed。
   */
  private findReadyNode(nodes: WorkflowNode[]): WorkflowNode | null {
    for (const node of nodes) {
      if (node.status === 'running') {
        // 有正在执行的节点，不应该出现（单线程执行），跳过
        continue;
      }
      if (node.status === 'completed' || node.status === 'cancelled') continue;

      if (node.status === 'pending' || (node.status === 'failed' && this.stateMachine.canRetry(node))) {
        // 检查所有依赖是否 completed
        const depsMet = node.dependencies.every((depId) => {
          const dep = nodes.find((n) => n.id === depId);
          return dep?.status === 'completed';
        });
        if (depsMet) return node;
      }
    }
    return null;
  }

  /** 执行单个节点 */
  private async executeNode(
    node: WorkflowNode,
    nodes: WorkflowNode[],
    ctx: WorkflowContext,
    def: WorkflowDefinition,
  ): Promise<void> {
    const nodeStarted = Date.now();

    // 推进到 running
    this.stateMachine.start(node);
    // 先记录 running，再触发任何外部副作用。崩溃恢复时会要求人工核对，不盲目重放。
    this.persistCheckpoint(ctx.workflowInstanceId, def, nodes);

    try {
      let result: WorkflowNodeResult;

      switch (node.type) {
        case 'task': {
          const execResult = await this.nodeExecutor.executeTask(node, ctx);
          result = { ...execResult, durationMs: Date.now() - nodeStarted };
          break;
        }
        case 'approval': {
          const approved = await this.nodeExecutor.executeApproval(node, ctx);
          result = {
            success: approved,
            toolCallCount: 0,
            durationMs: Date.now() - nodeStarted,
            summary: approved ? '审批通过' : '审批拒绝',
          };
          if (!approved) {
            // 审批拒绝：节点标记为 cancelled，工作流失败
            node.result = result;
            this.stateMachine.cancel(node);
            return;
          }
          break;
        }
        case 'verification': {
          const passed = await this.nodeExecutor.executeVerification(node, ctx);
          result = {
            success: passed,
            toolCallCount: 0,
            durationMs: Date.now() - nodeStarted,
            verificationPassed: passed,
            summary: passed ? '验证通过' : '验证失败',
          };
          if (!passed) {
            node.result = result;
            this.stateMachine.fail(node, '验证未通过');
            return;
          }
          break;
        }
        case 'condition': {
          const branch = await this.nodeExecutor.executeCondition(node, ctx);
          result = {
            success: true,
            toolCallCount: 0,
            durationMs: Date.now() - nodeStarted,
            branch: branch ?? undefined,
            summary: branch ? `选择分支: ${branch}` : '无条件分支',
          };
          break;
        }
        default: {
          // 未知类型不应该到达这里（validator 已过滤）
          result = {
            success: false,
            toolCallCount: 0,
            durationMs: Date.now() - nodeStarted,
            failureReason: `未知节点类型: ${node.type}`,
          };
        }
      }

      node.result = result;
      ctx.nodeResults.set(node.id, result);

      if (result.success) {
        this.stateMachine.complete(node);
      } else {
        this.stateMachine.fail(node, result.failureReason ?? '执行失败');
      }
    } catch (err) {
      // 执行异常：标记失败
      const failureReason = err instanceof Error ? err.message : String(err);
      node.result = {
        success: false,
        toolCallCount: 0,
        durationMs: Date.now() - nodeStarted,
        failureReason,
      };
      this.stateMachine.fail(node, failureReason);
    }
  }

  /** 取消所有非终态节点 */
  private cancelAllPending(nodes: WorkflowNode[]): void {
    for (const node of nodes) {
      if (!isWorkflowTerminal(node.status) && node.status !== 'running') {
        try {
          this.stateMachine.cancel(node);
        } catch {
          // 忽略非法转移
        }
      } else if (node.status === 'running') {
        // running 态可以直接 cancel
        try {
          this.stateMachine.cancel(node);
        } catch {
          // 忽略
        }
      }
    }
  }

  /** 构建执行报告 */
  private buildReport(
    instanceId: string,
    def: WorkflowDefinition,
    nodes: WorkflowNode[],
    state: WorkflowState,
    durationMs: number,
    stepsExecuted: number,
  ): WorkflowExecutionReport {
    return {
      workflowInstanceId: instanceId,
      workflowId: def.id,
      version: def.version,
      state,
      totalNodes: nodes.length,
      completedNodes: nodes.filter((n) => n.status === 'completed').length,
      failedNodes: nodes.filter((n) => n.status === 'failed').length,
      cancelledNodes: nodes.filter((n) => n.status === 'cancelled').length,
      durationMs,
      nodeResults: nodes.map((n) => ({
        nodeId: n.id,
        nodeName: n.name,
        nodeType: n.type,
        status: n.status,
        attempts: n.attempts,
        durationMs: n.result?.durationMs,
        success: n.result?.success,
        failureReason: n.result?.failureReason ?? n.block_reason,
      })),
      ...(stepsExecuted >= this.maxSteps && nodes.some((node) => node.status === 'pending' || (node.status === 'failed' && this.stateMachine.canRetry(node)))
        ? { error: `达到最大步骤数 ${this.maxSteps}，工作流被截断` }
        : {}),
    };
  }
}
