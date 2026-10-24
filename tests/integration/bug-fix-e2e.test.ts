/**
 * 场景 A：自动修复 Bug — 端到端测试（v0.4.0 Phase 7）。
 *
 * 验证完整 Bug Fix Workflow 能运行完毕，各步骤状态正确。
 * 使用模拟 NodeExecutor 脱离真实 AgentLoop。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  WorkflowRegistry,
  WorkflowRunner,
  WorkflowCheckpoint,
  registerBuiltinWorkflows,
  computeWorkflowState,
  type NodeExecutor,
  type WorkflowNodeResult,
} from '@forgex/workflows';
import { AuditLogger, MemoryAuditSink } from '@forgex/security';

const successResult: WorkflowNodeResult = {
  success: true,
  toolCallCount: 0,
  durationMs: 0,
};

describe('场景 A：Bug Fix Workflow 端到端', () => {
  it('完整流程运行成功', async () => {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);

    const db = new DatabaseSync(':memory:');
    const checkpoint = new WorkflowCheckpoint(db);
    const auditSink = new MemoryAuditSink();
    const auditLogger = new AuditLogger({ sinks: [auditSink] });

    // 模拟执行器：所有节点成功
    const executor: NodeExecutor = {
      async executeTask(): Promise<WorkflowNodeResult> {
        return { ...successResult };
      },
      async executeApproval(): Promise<boolean> {
        return true;
      },
      async executeVerification(): Promise<boolean> {
        return true;
      },
      async executeCondition(): Promise<string | null> {
        return null;
      },
    };

    const runner = new WorkflowRunner({
      registry,
      checkpoint,
      auditLogger,
      nodeExecutor: executor,
    });

    const def = registry.get('bug-fix')!;
    const result = await runner.run(def);
    const state = computeWorkflowState(result.nodes);

    expect(state).toBe('completed');
    const allCompleted = result.nodes.every((n) => n.status === 'completed');
    expect(allCompleted).toBe(true);
  });

  it('分析失败时工作流进入 failed 状态', async () => {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);

    const db = new DatabaseSync(':memory:');
    const checkpoint = new WorkflowCheckpoint(db);
    const auditSink = new MemoryAuditSink();
    const auditLogger = new AuditLogger({ sinks: [auditSink] });

    const executor: NodeExecutor = {
      async executeTask(node): Promise<WorkflowNodeResult> {
        if (node.name === 'Analyze') {
          return {
            success: false,
            toolCallCount: 0,
            durationMs: 0,
            failureReason: '分析失败：无法复现 Bug',
          };
        }
        return { ...successResult };
      },
      async executeApproval(): Promise<boolean> {
        return true;
      },
      async executeVerification(): Promise<boolean> {
        return true;
      },
      async executeCondition(): Promise<string | null> {
        return null;
      },
    };

    const runner = new WorkflowRunner({
      registry,
      checkpoint,
      auditLogger,
      nodeExecutor: executor,
    });

    const def = registry.get('bug-fix')!;
    const result = await runner.run(def);
    const state = computeWorkflowState(result.nodes);

    expect(state).toBe('failed');
  });

  it('验证节点失败时工作流 failed，不跳过强制验证', async () => {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);

    const db = new DatabaseSync(':memory:');
    const checkpoint = new WorkflowCheckpoint(db);
    const auditSink = new MemoryAuditSink();
    const auditLogger = new AuditLogger({ sinks: [auditSink] });

    const executor: NodeExecutor = {
      async executeTask(): Promise<WorkflowNodeResult> {
        return { ...successResult };
      },
      async executeApproval(): Promise<boolean> {
        return true;
      },
      async executeVerification(): Promise<boolean> {
        // 让所有验证失败
        return false;
      },
      async executeCondition(): Promise<string | null> {
        return null;
      },
    };

    const runner = new WorkflowRunner({
      registry,
      checkpoint,
      auditLogger,
      nodeExecutor: executor,
    });

    const def = registry.get('bug-fix')!;
    const result = await runner.run(def);
    const state = computeWorkflowState(result.nodes);

    expect(state).toBe('failed');
  });
});
