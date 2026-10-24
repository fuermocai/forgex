/**
 * Code Review Workflow（v0.4.0 Phase 1）。
 *
 * 流程：Fetch → Analyze → Review → Report
 */
import {
  type WorkflowDefinition,
  createWorkflowNode,
} from '../types.js';

export function createCodeReviewWorkflow(): WorkflowDefinition {
  const fetch = createWorkflowNode({
    name: 'Fetch',
    type: 'task',
    description: '获取待审查的变更内容（diff、修改文件列表）',
    required_tools: ['git_diff', 'git_status'],
    risk_level: 'read',
    idempotent: true,
  });

  const analyze = createWorkflowNode({
    name: 'Analyze',
    type: 'task',
    description: '分析变更影响范围和潜在风险',
    dependencies: [fetch.id],
    required_tools: ['read_file', 'grep_search', 'hybrid_search'],
    risk_level: 'read',
    idempotent: true,
  });

  const review = createWorkflowNode({
    name: 'Review',
    type: 'verification',
    description: '逐文件审查代码质量、安全性和规范符合性',
    dependencies: [analyze.id],
    required_tools: ['read_file', 'git_diff'],
    risk_level: 'read',
    mandatory: true,
    idempotent: true,
  });

  const report = createWorkflowNode({
    name: 'Report',
    type: 'task',
    description: '生成审查报告，列出问题和建议',
    dependencies: [review.id],
    required_tools: [],
    risk_level: 'read',
    idempotent: true,
  });

  return {
    id: 'code-review',
    name: 'Code Review Workflow',
    description: '代码审查流程：获取变更 → 分析影响 → 审查代码 → 生成报告',
    version: 1,
    nodes: [fetch, analyze, review, report],
    metadata: {
      tags: ['review', 'code-quality'],
      maxSteps: 15,
    },
  };
}
