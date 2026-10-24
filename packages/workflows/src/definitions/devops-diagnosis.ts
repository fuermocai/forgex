/**
 * DevOps Diagnosis Workflow（v0.4.0 Phase 1）。
 *
 * 流程：Check → Collect → Analyze → Correlate → Verify → Report
 *
 * 注意：此工作流只读，不执行生产重启或修改。
 */
import {
  type WorkflowDefinition,
  createWorkflowNode,
} from '../types.js';

export function createDevopsDiagnosisWorkflow(): WorkflowDefinition {
  const check = createWorkflowNode({
    name: 'Check',
    type: 'task',
    description: '检查网络连通性、容器状态、服务健康度',
    required_tools: ['inspect_port', 'inspect_process'],
    risk_level: 'read',
    idempotent: true,
  });

  const collect = createWorkflowNode({
    name: 'Collect',
    type: 'task',
    description: '收集日志、容器信息、系统指标',
    dependencies: [check.id],
    required_tools: ['read_logs', 'inspect_memory', 'inspect_disk'],
    risk_level: 'read',
    idempotent: true,
  });

  const analyze = createWorkflowNode({
    name: 'Analyze',
    type: 'task',
    description: '分析异常，定位故障点',
    dependencies: [collect.id],
    required_tools: ['grep_search'],
    risk_level: 'read',
    idempotent: true,
  });

  const correlate = createWorkflowNode({
    name: 'Correlate',
    type: 'task',
    description: '关联代码与运行时，找到根因',
    dependencies: [analyze.id],
    required_tools: ['correlate_code_runtime', 'hybrid_search'],
    risk_level: 'read',
    idempotent: true,
  });

  const verify = createWorkflowNode({
    name: 'Verify',
    type: 'verification',
    description: '验证根因假设，确认诊断准确',
    dependencies: [correlate.id],
    required_tools: ['read_file', 'grep_search'],
    risk_level: 'read',
    mandatory: true,
    idempotent: true,
  });

  const report = createWorkflowNode({
    name: 'Report',
    type: 'task',
    description: '生成诊断报告，提供修复方案（不直接执行生产重启）',
    dependencies: [verify.id],
    required_tools: [],
    risk_level: 'read',
    idempotent: true,
  });

  return {
    id: 'devops-diagnosis',
    name: 'DevOps Diagnosis Workflow',
    description: 'DevOps 故障诊断流程（只读，不执行生产变更）：检查 → 收集 → 分析 → 关联 → 验证 → 报告',
    version: 1,
    nodes: [check, collect, analyze, correlate, verify, report],
    metadata: {
      tags: ['devops', 'diagnosis', 'readonly'],
      maxSteps: 20,
    },
  };
}
