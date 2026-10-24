/**
 * WorkflowRunner 测试（v0.4.0 Phase 1）。
 *
 * 使用 mock NodeExecutor 测试编排逻辑，不依赖真实 AgentLoop。
 *
 * 重点验证：
 *   1. 线性工作流（task → verification）完整执行并返回 completed；
 *   2. verification 节点失败时工作流状态为 failed；
 *   3. maxSteps 超限后工作流停止，不无限循环；
 *   4. approval 节点被拒绝时工作流状态为 failed；
 *   5. 检查点恢复后从最后一个未终态节点继续。
 */
import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowRunner, type NodeExecutor, type WorkflowContext } from '../src/runner/workflow-runner.js';
import { WorkflowCheckpoint } from '../src/runner/checkpoint.js';
import {
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeResult,
  createWorkflowNode,
} from '../src/types.js';

/** 创建一个总是成功的 mock NodeExecutor */
function createSuccessExecutor(): NodeExecutor {
  return {
    executeTask: async (_node: WorkflowNode, _ctx: WorkflowContext): Promise<WorkflowNodeResult> => ({
      success: true,
      toolCallCount: 1,
      durationMs: 10,
      summary: 'task done',
    }),
    executeApproval: async (): Promise<boolean> => true,
    executeVerification: async (): Promise<boolean> => true,
    executeCondition: async (): Promise<string | null> => null,
  };
}

function makeLinearWorkflow(): WorkflowDefinition {
  const a = createWorkflowNode({ name: 'Task1', type: 'task', description: 'task 1' });
  const b = createWorkflowNode({
    name: 'Verify',
    type: 'verification',
    description: 'verify',
    dependencies: [a.id],
    mandatory: true,
  });
  return {
    id: 'linear',
    name: 'linear',
    description: 'linear test',
    version: 1,
    nodes: [a, b],
  };
}

describe('WorkflowRunner - 基础执行', () => {
  it('线性工作流完整执行并返回 completed', async () => {
    const runner = new WorkflowRunner({ nodeExecutor: createSuccessExecutor() });
    const { report } = await runner.run(makeLinearWorkflow());

    expect(report.state).toBe('completed');
    expect(report.completedNodes).toBe(2);
    expect(report.failedNodes).toBe(0);
  });

  it('verification 失败时工作流状态为 failed', async () => {
    const executor: NodeExecutor = {
      ...createSuccessExecutor(),
      executeVerification: async (): Promise<boolean> => false,
    };
    const runner = new WorkflowRunner({ nodeExecutor: executor });
    const { report } = await runner.run(makeLinearWorkflow());

    expect(report.state).toBe('failed');
    expect(report.failedNodes).toBe(1);
    expect(report.completedNodes).toBe(1); // task 成功，verification 失败
  });

  it('task 失败时工作流状态为 failed', async () => {
    const executor: NodeExecutor = {
      ...createSuccessExecutor(),
      executeTask: async (): Promise<WorkflowNodeResult> => ({
        success: false,
        toolCallCount: 1,
        durationMs: 10,
        failureReason: 'task failed',
      }),
    };
    const runner = new WorkflowRunner({ nodeExecutor: executor });
    const { report } = await runner.run(makeLinearWorkflow());

    expect(report.state).toBe('failed');
  });
});

describe('WorkflowRunner - 审批节点', () => {
  it('approval 通过时工作流继续', async () => {
    const a = createWorkflowNode({ name: 'Task1', type: 'task', description: 'task 1' });
    const approval = createWorkflowNode({
      name: 'Approve',
      type: 'approval',
      description: 'approve',
      dependencies: [a.id],
    });
    const verify = createWorkflowNode({
      name: 'Verify',
      type: 'verification',
      description: 'verify',
      dependencies: [approval.id],
      mandatory: true,
    });
    const def: WorkflowDefinition = {
      id: 'approval-pass',
      name: 'approval-pass',
      description: 'approval pass',
      version: 1,
      nodes: [a, approval, verify],
    };

    const runner = new WorkflowRunner({ nodeExecutor: createSuccessExecutor() });
    const { report } = await runner.run(def);

    expect(report.state).toBe('completed');
    expect(report.completedNodes).toBe(3);
  });

  it('approval 拒绝时工作流状态为 failed', async () => {
    const a = createWorkflowNode({ name: 'Task1', type: 'task', description: 'task 1' });
    const approval = createWorkflowNode({
      name: 'Approve',
      type: 'approval',
      description: 'approve',
      dependencies: [a.id],
    });
    const verify = createWorkflowNode({
      name: 'Verify',
      type: 'verification',
      description: 'verify',
      dependencies: [approval.id],
      mandatory: true,
    });
    const def: WorkflowDefinition = {
      id: 'approval-deny',
      name: 'approval-deny',
      description: 'approval deny',
      version: 1,
      nodes: [a, approval, verify],
    };

    const executor: NodeExecutor = {
      ...createSuccessExecutor(),
      executeApproval: async (): Promise<boolean> => false,
    };
    const runner = new WorkflowRunner({ nodeExecutor: executor });
    const { report, nodes } = await runner.run(def);

    expect(report.state).toBe('failed');
    // approval 节点被 cancelled
    const approvalNode = nodes.find((n) => n.name === 'Approve');
    expect(approvalNode?.status).toBe('cancelled');
  });
});

describe('WorkflowRunner - maxSteps 防无限循环', () => {
  it('maxSteps 超限后工作流被截断', async () => {
    // 创建一个会"永远"有就绪节点的工作流（两个 task 互相不依赖，独立完成）
    // 实际上两个独立 task 都会执行完成，不会无限循环
    // 改用一个 task + verification，但让 verification 总是失败且可重试
    const a = createWorkflowNode({
      name: 'Task1',
      type: 'task',
      description: 'task 1',
      max_attempts: 100,
    });
    const verify = createWorkflowNode({
      name: 'Verify',
      type: 'verification',
      description: 'verify',
      dependencies: [a.id],
      mandatory: true,
      max_attempts: 100,
    });
    const def: WorkflowDefinition = {
      id: 'infinite',
      name: 'infinite',
      description: 'infinite',
      version: 1,
      nodes: [a, verify],
    };

    const executor: NodeExecutor = {
      ...createSuccessExecutor(),
      executeVerification: async (): Promise<boolean> => false,
    };
    const runner = new WorkflowRunner({ nodeExecutor: executor, maxSteps: 3 });
    const { report } = await runner.run(def);

    // maxSteps=3, 但 verification 会一直失败重试，达到 maxSteps 后截断
    expect(report.error).toBeDefined();
    expect(report.error).toContain('最大步骤数');
  });
});

describe('WorkflowRunner - 检查点恢复', () => {
  it('崩溃恢复后从检查点继续，已完成节点不重复执行', async () => {
    const db = new DatabaseSync(':memory:');
    const checkpoint = new WorkflowCheckpoint(db);

    let task1Executed = 0;
    let task2Executed = 0;

    const a = createWorkflowNode({ name: 'Task1', type: 'task', description: 'task 1' });
    const b = createWorkflowNode({
      name: 'Task2',
      type: 'task',
      description: 'task 2',
      dependencies: [a.id],
    });
    const verify = createWorkflowNode({
      name: 'Verify',
      type: 'verification',
      description: 'verify',
      dependencies: [b.id],
      mandatory: true,
    });
    const def: WorkflowDefinition = {
      id: 'recovery',
      name: 'recovery',
      description: 'recovery',
      version: 1,
      nodes: [a, b, verify],
    };

    // 模拟进程崩溃：手动创建一个检查点，Task1 已完成，Task2 仍 pending
    // （模拟在 Task2 执行前/中崩溃，检查点只保存了 Task1 的完成状态）
    a.status = 'completed';
    a.result = { success: true, toolCallCount: 1, durationMs: 10, summary: 'done' };
    b.status = 'pending';

    // 手动写入检查点
    const { buildCheckpointRecord } = await import('../src/runner/checkpoint.js');
    const record = buildCheckpointRecord({
      workflowInstanceId: 'wf-recovery-001',
      workflowId: def.id,
      workflowVersion: def.version,
      nodes: [a, b, verify],
      state: 'running',
    });
    checkpoint.save(record);

    // 恢复运行：Task1 不应重复执行，Task2 应执行
    const executor: NodeExecutor = {
      executeTask: async (node: WorkflowNode): Promise<WorkflowNodeResult> => {
        if (node.name === 'Task1') {
          task1Executed++;
          return { success: true, toolCallCount: 1, durationMs: 10, summary: 'done' };
        }
        task2Executed++;
        return { success: true, toolCallCount: 1, durationMs: 10, summary: 'done' };
      },
      executeApproval: async () => true,
      executeVerification: async () => true,
      executeCondition: async () => null,
    };

    const runner = new WorkflowRunner({
      nodeExecutor: executor,
      checkpoint,
    });

    const result = await runner.run(def, 'wf-recovery-001');
    expect(result.report.state).toBe('completed');
    // Task1 已完成，不应重复执行
    expect(task1Executed).toBe(0);
    // Task2 和 Verify 执行
    expect(task2Executed).toBe(1);
  });

  it('版本不兼容时抛错', async () => {
    const db = new DatabaseSync(':memory:');
    const checkpoint = new WorkflowCheckpoint(db);

    const def = makeLinearWorkflow();
    const runner1 = new WorkflowRunner({
      nodeExecutor: createSuccessExecutor(),
      checkpoint,
    });
    await runner1.run(def, 'wf-version-test');

    // 修改版本号
    const defV2: WorkflowDefinition = { ...def, version: 2 };
    const runner2 = new WorkflowRunner({
      nodeExecutor: createSuccessExecutor(),
      checkpoint,
    });

    await expect(runner2.run(defV2, 'wf-version-test')).rejects.toThrow();
  });
});

describe('WorkflowRunner - 取消', () => {
  it('AbortSignal 触发后取消所有非终态节点', async () => {
    const controller = new AbortController();
    const runner = new WorkflowRunner({
      nodeExecutor: createSuccessExecutor(),
      signal: controller.signal,
    });

    // 立即取消
    controller.abort();

    const { report } = await runner.run(makeLinearWorkflow());
    expect(report.state).toBe('cancelled');
    expect(report.cancelledNodes).toBeGreaterThan(0);
  });
});
