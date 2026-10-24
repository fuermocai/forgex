/**
 * Feature Development Workflow（v0.4.0 Phase 1）。
 *
 * 流程：Requirement → Analyze → Plan → Implement → Test → Review → Build
 */
import {
  type WorkflowDefinition,
  createWorkflowNode,
} from '../types.js';

export function createFeatureDevWorkflow(): WorkflowDefinition {
  const requirement = createWorkflowNode({
    name: 'Requirement',
    type: 'task',
    description: '理解需求，明确功能范围和验收标准',
    required_tools: ['read_file', 'hybrid_search'],
    risk_level: 'read',
    idempotent: true,
  });

  const analyze = createWorkflowNode({
    name: 'Analyze',
    type: 'task',
    description: '分析现有代码结构，确定改动点',
    dependencies: [requirement.id],
    required_tools: ['read_file', 'grep_search', 'hybrid_search'],
    risk_level: 'read',
    idempotent: true,
  });

  const plan = createWorkflowNode({
    name: 'Plan',
    type: 'task',
    description: '制定实现计划，拆解任务步骤',
    dependencies: [analyze.id],
    required_tools: ['read_file'],
    risk_level: 'read',
    idempotent: true,
  });

  const implement = createWorkflowNode({
    name: 'Implement',
    type: 'task',
    description: '按计划实现功能',
    dependencies: [plan.id],
    required_tools: ['edit_file'],
    risk_level: 'modify',
    idempotent: false,
  });

  const test = createWorkflowNode({
    name: 'Test',
    type: 'verification',
    description: '运行单元测试和集成测试',
    dependencies: [implement.id],
    required_tools: ['run_command'],
    risk_level: 'run',
    mandatory: true,
    idempotent: true,
  });

  const review = createWorkflowNode({
    name: 'Review',
    type: 'verification',
    description: '代码审查，确认代码质量和安全性',
    dependencies: [test.id],
    required_tools: ['git_diff', 'read_file'],
    risk_level: 'read',
    mandatory: true,
    idempotent: true,
  });

  const build = createWorkflowNode({
    name: 'Build',
    type: 'task',
    description: '构建项目，确认编译通过',
    dependencies: [review.id],
    required_tools: ['run_command'],
    risk_level: 'run',
    idempotent: true,
  });

  return {
    id: 'feature-dev',
    name: 'Feature Development Workflow',
    description: '功能开发标准流程：需求 → 分析 → 计划 → 实现 → 测试 → 审查 → 构建',
    version: 1,
    nodes: [requirement, analyze, plan, implement, test, review, build],
    metadata: {
      tags: ['feature', 'development', 'coding'],
      maxSteps: 30,
    },
  };
}
