/**
 * Deployment Preparation Workflow（v0.4.0 Phase 1）。
 *
 * 流程：Validate → Build → Test → Package → Approve → Deliver
 *
 * 注意：Approve 节点是人工审批（L3），Deliver 节点在审批通过后才执行。
 * 禁止自动部署到生产环境。
 */
import {
  type WorkflowDefinition,
  createWorkflowNode,
} from '../types.js';

export function createDeploymentPrepWorkflow(): WorkflowDefinition {
  const validate = createWorkflowNode({
    name: 'Validate',
    type: 'task',
    description: '校验部署配置和环境准备',
    required_tools: ['read_file'],
    risk_level: 'read',
    idempotent: true,
  });

  const build = createWorkflowNode({
    name: 'Build',
    type: 'task',
    description: '构建部署产物',
    dependencies: [validate.id],
    required_tools: ['run_command'],
    risk_level: 'run',
    idempotent: true,
  });

  const test = createWorkflowNode({
    name: 'Test',
    type: 'verification',
    description: '运行测试确认产物可用',
    dependencies: [build.id],
    required_tools: ['run_command'],
    risk_level: 'run',
    mandatory: true,
    idempotent: true,
  });

  const package_ = createWorkflowNode({
    name: 'Package',
    type: 'task',
    description: '打包部署产物，生成版本标签',
    dependencies: [test.id],
    required_tools: ['run_command'],
    risk_level: 'run',
    idempotent: false,
  });

  const approve = createWorkflowNode({
    name: 'Approve',
    type: 'approval',
    description: '人工审批：确认部署到目标环境（L3 高风险）',
    dependencies: [package_.id],
    risk_level: 'critical',
    mandatory: true,
    idempotent: false,
  });

  const deliver = createWorkflowNode({
    name: 'Deliver',
    type: 'task',
    description: '交付部署产物（不自动部署，等待人工执行部署）',
    dependencies: [approve.id],
    required_tools: [],
    risk_level: 'deploy',
    idempotent: false,
  });

  return {
    id: 'deployment-prep',
    name: 'Deployment Preparation Workflow',
    description: '部署准备流程：校验 → 构建 → 测试 → 打包 → 人工审批 → 交付',
    version: 1,
    nodes: [validate, build, test, package_, approve, deliver],
    metadata: {
      tags: ['deployment', 'delivery'],
      maxSteps: 20,
    },
  };
}
