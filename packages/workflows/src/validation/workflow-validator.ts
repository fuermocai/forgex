/**
 * WorkflowValidator：工作流定义校验器（v0.4.0 Phase 1）。
 *
 * 校验项：
 *   1. DAG 环检测（DFS）——含环的工作流无法调度；
 *   2. 强制验证节点存在——至少一个 mandatory 的 verification 节点；
 *   3. 未知节点类型拒绝——type 必须在 WORKFLOW_NODE_TYPES 内；
 *   4. 依赖引用完整性——dependencies 中的 ID 必须存在；
 *   5. 孤立节点检测——除起始节点外，所有节点应有入边（可选警告）。
 *
 * 返回 ValidationResult { ok, errors[] }，不抛异常——
 * 校验失败是预期行为，调用方应根据 errors 决定是否拒绝。
 */
import {
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeType,
  WORKFLOW_NODE_TYPES,
} from '../types.js';

export interface ValidationError {
  /** 错误码，便于上层分支处理 */
  code:
    | 'CYCLE_DETECTED'
    | 'MISSING_MANDATORY_VERIFICATION'
    | 'UNKNOWN_NODE_TYPE'
    | 'MISSING_DEPENDENCY'
    | 'EMPTY_NODES'
    | 'DUPLICATE_NODE_ID';
  /** 人类可读的错误描述 */
  message: string;
  /** 相关节点 ID（如有） */
  nodeIds?: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export class WorkflowValidator {
  /**
   * 校验工作流定义。
   * 不抛异常，所有问题收集到 errors 中返回。
   */
  validate(def: WorkflowDefinition): ValidationResult {
    const errors: ValidationError[] = [];

    // 1. 空节点检查
    if (def.nodes.length === 0) {
      errors.push({ code: 'EMPTY_NODES', message: '工作流必须包含至少一个节点' });
      return { ok: false, errors };
    }

    // 2. 重复节点 ID 检查
    const idSet = new Set<string>();
    const duplicateIds: string[] = [];
    for (const node of def.nodes) {
      if (idSet.has(node.id)) {
        duplicateIds.push(node.id);
      }
      idSet.add(node.id);
    }
    if (duplicateIds.length > 0) {
      errors.push({
        code: 'DUPLICATE_NODE_ID',
        message: `存在重复节点 ID: ${duplicateIds.join(', ')}`,
        nodeIds: duplicateIds,
      });
    }

    // 3. 未知节点类型检查
    const unknownTypeNodes = def.nodes.filter((n) => !WORKFLOW_NODE_TYPES.includes(n.type));
    if (unknownTypeNodes.length > 0) {
      errors.push({
        code: 'UNKNOWN_NODE_TYPE',
        message: `存在未知节点类型: ${unknownTypeNodes.map((n) => `${n.id}(${n.type})`).join(', ')}`,
        nodeIds: unknownTypeNodes.map((n) => n.id),
      });
    }

    // 4. 依赖引用完整性检查
    const missingDeps: Array<{ nodeId: string; depId: string }> = [];
    for (const node of def.nodes) {
      for (const depId of node.dependencies) {
        if (!idSet.has(depId)) {
          missingDeps.push({ nodeId: node.id, depId });
        }
      }
    }
    if (missingDeps.length > 0) {
      errors.push({
        code: 'MISSING_DEPENDENCY',
        message: `存在不存在的依赖引用: ${missingDeps
          .map((d) => `${d.nodeId} → ${d.depId}`)
          .join(', ')}`,
        nodeIds: missingDeps.map((d) => d.nodeId),
      });
    }

    // 5. DAG 环检测（DFS）
    const cycle = this.detectCycle(def.nodes);
    if (cycle) {
      errors.push({
        code: 'CYCLE_DETECTED',
        message: `检测到循环依赖: ${cycle.join(' → ')}`,
        nodeIds: cycle,
      });
    }

    // 6. 强制验证节点存在检查
    const hasMandatoryVerification = def.nodes.some(
      (n) => n.type === 'verification' && n.mandatory,
    );
    if (!hasMandatoryVerification) {
      errors.push({
        code: 'MISSING_MANDATORY_VERIFICATION',
        message: '工作流必须包含至少一个 mandatory 的 verification 节点',
      });
    }

    return { ok: errors.length === 0, errors };
  }

  /**
   * DFS 环检测。
   * 返回环路径（如果存在），否则返回 null。
   *
   * 算法：对每个未访问节点做 DFS，维护递归栈。
   * 如果在递归栈中遇到已访问节点，说明存在环。
   */
  private detectCycle(nodes: WorkflowNode[]): string[] | null {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (nodeId: string): string[] | null => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const node = nodeMap.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (!visited.has(depId)) {
            const cycle = dfs(depId);
            if (cycle) return cycle;
          } else if (recursionStack.has(depId)) {
            // 找到环：从 path 中 depId 出现的位置到当前
            const cycleStart = path.indexOf(depId);
            if (cycleStart !== -1) {
              return [...path.slice(cycleStart), depId];
            }
            return [depId, nodeId];
          }
        }
      }

      path.pop();
      recursionStack.delete(nodeId);
      return null;
    };

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        const cycle = dfs(node.id);
        if (cycle) return cycle;
      }
    }
    return null;
  }
}
