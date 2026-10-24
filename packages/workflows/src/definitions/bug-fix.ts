/**
 * Bug Fix Workflow（v0.4.0 Phase 1）。
 *
 * 流程：Analyze → Plan → Implement → Test → Review
 *
 * - Analyze: task — 分析 Bug 复现路径与根因
 * - Plan: task — 制定修复计划
 * - Implement: task — 修改代码
 * - Test: verification (mandatory) — 运行测试验证修复
 * - Review: verification (mandatory) — 代码审查
 */
import {
  type WorkflowDefinition,
  createWorkflowNode,
} from '../types.js';

export function createBugFixWorkflow(): WorkflowDefinition {
  const analyze = createWorkflowNode({
    name: 'Analyze',
    type: 'task',
    description: '分析 Bug 复现路径、堆栈信息和根因',
    required_tools: ['read_file', 'grep_search', 'correlate_code_runtime', 'hybrid_search'],
    risk_level: 'read',
    idempotent: true,
  });

  const plan = createWorkflowNode({
    name: 'Plan',
    type: 'task',
    description: '制定修复计划，列出需要修改的文件和方案',
    dependencies: [analyze.id],
    required_tools: ['read_file', 'grep_search'],
    risk_level: 'read',
    idempotent: true,
  });

  const implement = createWorkflowNode({
    name: 'Implement',
    type: 'task',
    description: '按计划修改代码',
    dependencies: [plan.id],
    required_tools: ['edit_file'],
    risk_level: 'modify',
    idempotent: false,
  });

  const test = createWorkflowNode({
    name: 'Test',
    type: 'verification',
    description: '运行测试验证修复有效且无回归',
    dependencies: [implement.id],
    required_tools: ['run_command'],
    risk_level: 'run',
    mandatory: true,
    idempotent: true,
  });

  const review = createWorkflowNode({
    name: 'Review',
    type: 'verification',
    description: '代码审查，确认修复质量和安全性',
    dependencies: [test.id],
    required_tools: ['git_diff', 'read_file'],
    risk_level: 'read',
    mandatory: true,
    idempotent: true,
  });

  return {
    id: 'bug-fix',
    name: 'Bug Fix Workflow',
    description: '自动修复 Bug 的标准流程：分析 → 计划 → 实现 → 测试 → 审查',
    version: 1,
    nodes: [analyze, plan, implement, test, review],
    metadata: {
      tags: ['bug', 'fix', 'coding'],
      maxSteps: 20,
    },
  };
}
