/**
 * Refactoring Workflow（v0.4.0 Phase 1）。
 *
 * 流程：Analyze → Plan → Refactor → Test → Review
 */
import {
  type WorkflowDefinition,
  createWorkflowNode,
} from '../types.js';

export function createRefactoringWorkflow(): WorkflowDefinition {
  const analyze = createWorkflowNode({
    name: 'Analyze',
    type: 'task',
    description: '分析需要重构的代码，识别坏味道和改进点',
    required_tools: ['read_file', 'grep_search', 'hybrid_search'],
    risk_level: 'read',
    idempotent: true,
  });

  const plan = createWorkflowNode({
    name: 'Plan',
    type: 'task',
    description: '制定重构计划，保持行为不变的前提下改善结构',
    dependencies: [analyze.id],
    required_tools: ['read_file'],
    risk_level: 'read',
    idempotent: true,
  });

  const refactor = createWorkflowNode({
    name: 'Refactor',
    type: 'task',
    description: '执行重构，修改代码结构',
    dependencies: [plan.id],
    required_tools: ['edit_file'],
    risk_level: 'modify',
    idempotent: false,
  });

  const test = createWorkflowNode({
    name: 'Test',
    type: 'verification',
    description: '运行测试确认重构未破坏现有行为',
    dependencies: [refactor.id],
    required_tools: ['run_command'],
    risk_level: 'run',
    mandatory: true,
    idempotent: true,
  });

  const review = createWorkflowNode({
    name: 'Review',
    type: 'verification',
    description: '审查重构结果，确认代码质量提升',
    dependencies: [test.id],
    required_tools: ['git_diff', 'read_file'],
    risk_level: 'read',
    mandatory: true,
    idempotent: true,
  });

  return {
    id: 'refactoring',
    name: 'Refactoring Workflow',
    description: '重构流程：分析 → 计划 → 重构 → 测试 → 审查',
    version: 1,
    nodes: [analyze, plan, refactor, test, review],
    metadata: {
      tags: ['refactoring', 'code-quality'],
      maxSteps: 20,
    },
  };
}
