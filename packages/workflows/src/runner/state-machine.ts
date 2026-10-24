/**
 * WorkflowStateMachine：工作流节点状态机（v0.4.0 Phase 1）。
 *
 * 本文件的状态转移逻辑已在 types.ts 中定义（isValidWorkflowTransition 等），
 * 这里提供面向对象的包装，便于 WorkflowRunner 操作单个节点的状态。
 *
 * 关键安全约束（复用 v0.3.0 StepExecutor 修复经验）：
 *   - 禁止 running → ready 直跳——工作流节点没有 ready 态，
 *     pending 直接到 running；
 *   - failed → running 是重试路径，必须检查重试预算；
 *   - 终态（completed/cancelled）不可转出。
 */
import { ForgeError } from '@forgex/shared';
import {
  type WorkflowNode,
  type WorkflowNodeStatus,
  isValidWorkflowTransition,
  isWorkflowTerminal,
  workflowNowIso,
} from '../types.js';

export class WorkflowStateMachine {
  /**
   * 将节点从当前状态转移到目标状态。
   * 非法转移抛出 ForgeError（WORKFLOW_INVALID）。
   *
   * @param node 要转移的节点（会被修改）
   * @param to 目标状态
   * @returns 修改后的节点
   */
  transition(node: WorkflowNode, to: WorkflowNodeStatus): WorkflowNode {
    const from = node.status;
    if (!isValidWorkflowTransition(from, to)) {
      throw new ForgeError(
        'WORKFLOW_INVALID',
        `非法状态转移: ${from} → ${to}（节点 ${node.id}）`,
        { details: { nodeId: node.id, from, to } },
      );
    }
    node.status = to;
    node.updated_at = workflowNowIso();
    return node;
  }

  /**
   * 标记节点为 running。
   * 只有 pending / failed / blocked 态可以转到 running。
   */
  start(node: WorkflowNode): WorkflowNode {
    if (node.status === 'failed') {
      // 重试路径：failed → running，需要累加 attempts
      node.attempts += 1;
    }
    return this.transition(node, 'running');
  }

  /** 标记节点为 completed */
  complete(node: WorkflowNode): WorkflowNode {
    return this.transition(node, 'completed');
  }

  /** 标记节点为 failed */
  fail(node: WorkflowNode, reason?: string): WorkflowNode {
    const result = this.transition(node, 'failed');
    if (reason) result.block_reason = reason;
    return result;
  }

  /** 标记节点为 blocked */
  block(node: WorkflowNode, reason: string): WorkflowNode {
    const result = this.transition(node, 'blocked');
    result.block_reason = reason;
    return result;
  }

  /** 标记节点为 cancelled */
  cancel(node: WorkflowNode): WorkflowNode {
    return this.transition(node, 'cancelled');
  }

  /** 节点是否处于终态 */
  isTerminal(node: WorkflowNode): boolean {
    return isWorkflowTerminal(node.status);
  }

  /**
   * 检查节点是否可以重试（failed 态且 attempts < max_attempts）。
   */
  canRetry(node: WorkflowNode): boolean {
    if (node.status !== 'failed') return false;
    const maxAttempts = node.max_attempts ?? 2;
    return node.attempts < maxAttempts;
  }
}
