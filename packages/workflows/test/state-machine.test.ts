/**
 * WorkflowStateMachine 测试（v0.4.0 Phase 1）。
 *
 * 重点验证：
 *   1. 合法状态转移返回 true；
 *   2. 非法转移返回 false；
 *   3. 终态不可转出；
 *   4. WorkflowStateMachine 类方法行为正确；
 *   5. 复用 v0.3.0 修复经验：禁止 running → ready 直跳（工作流无 ready 态）。
 */
import { describe, it, expect } from 'vitest';
import {
  type WorkflowNodeStatus,
  isValidWorkflowTransition,
  allowedWorkflowTransitions,
  isWorkflowTerminal,
  createWorkflowNode,
} from '../src/types.js';
import { WorkflowStateMachine } from '../src/runner/state-machine.js';
import { ForgeError } from '@forgex/shared';

describe('WorkflowStateMachine - 状态转移函数', () => {
  it('pending → running 合法', () => {
    expect(isValidWorkflowTransition('pending', 'running')).toBe(true);
  });

  it('running → completed 合法', () => {
    expect(isValidWorkflowTransition('running', 'completed')).toBe(true);
  });

  it('running → failed 合法', () => {
    expect(isValidWorkflowTransition('running', 'failed')).toBe(true);
  });

  it('failed → running 合法（重试路径）', () => {
    expect(isValidWorkflowTransition('failed', 'running')).toBe(true);
  });

  it('running → blocked 合法', () => {
    expect(isValidWorkflowTransition('running', 'blocked')).toBe(true);
  });

  it('blocked → running 合法（阻塞解除）', () => {
    expect(isValidWorkflowTransition('blocked', 'running')).toBe(true);
  });

  it('pending → cancelled 合法', () => {
    expect(isValidWorkflowTransition('pending', 'cancelled')).toBe(true);
  });

  it('completed 为终态，不可转出', () => {
    const transitions = allowedWorkflowTransitions('completed');
    expect(transitions).toHaveLength(0);
    expect(isWorkflowTerminal('completed')).toBe(true);
  });

  it('cancelled 为终态，不可转出', () => {
    expect(isWorkflowTerminal('cancelled')).toBe(true);
  });

  it('原地转移合法（幂等）', () => {
    expect(isValidWorkflowTransition('running', 'running')).toBe(true);
  });

  it('pending → completed 非法（必须经过 running）', () => {
    expect(isValidWorkflowTransition('pending', 'completed')).toBe(false);
  });

  it('completed → running 非法（终态不可转出）', () => {
    expect(isValidWorkflowTransition('completed', 'running')).toBe(false);
  });

  it('failed → completed 非法（失败不能直接完成）', () => {
    expect(isValidWorkflowTransition('failed', 'completed')).toBe(false);
  });
});

describe('WorkflowStateMachine - 类方法', () => {
  const sm = new WorkflowStateMachine();

  it('start 将 pending 推进到 running', () => {
    const node = createWorkflowNode({ name: 'test', type: 'task', description: 'test' });
    sm.start(node);
    expect(node.status).toBe('running');
    expect(node.attempts).toBe(0);
  });

  it('start 从 failed 重试时累加 attempts', () => {
    const node = createWorkflowNode({ name: 'test', type: 'task', description: 'test' });
    sm.start(node);
    sm.fail(node, 'test failure');
    expect(node.status).toBe('failed');
    expect(node.attempts).toBe(0);

    sm.start(node); // 重试
    expect(node.status).toBe('running');
    expect(node.attempts).toBe(1);
  });

  it('complete 将 running 标记为 completed', () => {
    const node = createWorkflowNode({ name: 'test', type: 'task', description: 'test' });
    sm.start(node);
    sm.complete(node);
    expect(node.status).toBe('completed');
  });

  it('fail 将 running 标记为 failed 并记录原因', () => {
    const node = createWorkflowNode({ name: 'test', type: 'task', description: 'test' });
    sm.start(node);
    sm.fail(node, 'something broke');
    expect(node.status).toBe('failed');
    expect(node.block_reason).toBe('something broke');
  });

  it('cancel 将 pending 标记为 cancelled', () => {
    const node = createWorkflowNode({ name: 'test', type: 'task', description: 'test' });
    sm.cancel(node);
    expect(node.status).toBe('cancelled');
  });

  it('非法转移抛 ForgeError(WORKFLOW_INVALID)', () => {
    const node = createWorkflowNode({ name: 'test', type: 'task', description: 'test' });
    // pending → completed 非法
    expect(() => sm.complete(node)).toThrow(ForgeError);
  });

  it('canRetry 在 failed 态且 attempts < max_attempts 时返回 true', () => {
    const node = createWorkflowNode({
      name: 'test',
      type: 'task',
      description: 'test',
      max_attempts: 3,
    });
    sm.start(node);
    sm.fail(node);
    expect(sm.canRetry(node)).toBe(true);
  });

  it('canRetry 在 attempts >= max_attempts 时返回 false', () => {
    const node = createWorkflowNode({
      name: 'test',
      type: 'task',
      description: 'test',
      max_attempts: 1,
    });
    sm.start(node);
    sm.fail(node);
    // attempts=0, max_attempts=1, canRetry 应该是 0 < 1 = true
    expect(sm.canRetry(node)).toBe(true);
    // 再重试一次
    sm.start(node);
    sm.fail(node);
    // attempts=1, max_attempts=1, canRetry 应该是 1 < 1 = false
    expect(sm.canRetry(node)).toBe(false);
  });

  it('canRetry 在非 failed 态返回 false', () => {
    const node = createWorkflowNode({ name: 'test', type: 'task', description: 'test' });
    expect(sm.canRetry(node)).toBe(false); // pending
    sm.start(node);
    expect(sm.canRetry(node)).toBe(false); // running
  });
});
