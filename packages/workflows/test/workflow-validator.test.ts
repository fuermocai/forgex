/**
 * WorkflowValidator 测试（v0.4.0 Phase 1）。
 *
 * 重点验证：
 *   1. 含环 DAG 被拒绝；
 *   2. 缺少 mandatory verification 节点被拒绝；
 *   3. 未知节点类型被拒绝；
 *   4. 依赖引用不存在被拒绝；
 *   5. 合法工作流通过校验。
 */
import { describe, it, expect } from 'vitest';
import { WorkflowValidator } from '../src/validation/workflow-validator.js';
import {
  type WorkflowDefinition,
  createWorkflowNode,
} from '../src/types.js';

function makeLinearWorkflow(): WorkflowDefinition {
  const a = createWorkflowNode({ name: 'A', type: 'task', description: 'A' });
  const b = createWorkflowNode({
    name: 'B',
    type: 'verification',
    description: 'B',
    dependencies: [a.id],
    mandatory: true,
  });
  return {
    id: 'test',
    name: 'test',
    description: 'test',
    version: 1,
    nodes: [a, b],
  };
}

describe('WorkflowValidator', () => {
  const validator = new WorkflowValidator();

  it('合法线性工作流通过校验', () => {
    const def = makeLinearWorkflow();
    const result = validator.validate(def);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('空节点工作流被拒绝', () => {
    const def: WorkflowDefinition = {
      id: 'empty',
      name: 'empty',
      description: 'empty',
      version: 1,
      nodes: [],
    };
    const result = validator.validate(def);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('EMPTY_NODES');
  });

  it('缺少 mandatory verification 节点被拒绝', () => {
    const a = createWorkflowNode({ name: 'A', type: 'task', description: 'A' });
    const b = createWorkflowNode({
      name: 'B',
      type: 'task',
      description: 'B',
      dependencies: [a.id],
    });
    const def: WorkflowDefinition = {
      id: 'no-verify',
      name: 'no-verify',
      description: 'no verification',
      version: 1,
      nodes: [a, b],
    };
    const result = validator.validate(def);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'MISSING_MANDATORY_VERIFICATION');
    expect(err).toBeDefined();
  });

  it('verification 节点但非 mandatory 时仍需至少一个 mandatory', () => {
    const a = createWorkflowNode({ name: 'A', type: 'task', description: 'A' });
    const b = createWorkflowNode({
      name: 'B',
      type: 'verification',
      description: 'B',
      dependencies: [a.id],
      mandatory: false,
    });
    const def: WorkflowDefinition = {
      id: 'no-mandatory',
      name: 'no-mandatory',
      description: 'no mandatory verification',
      version: 1,
      nodes: [a, b],
    };
    const result = validator.validate(def);
    expect(result.ok).toBe(false);
  });

  it('未知节点类型被拒绝', () => {
    const a = createWorkflowNode({
      name: 'A',
      type: 'task',
      description: 'A',
    });
    // 强制设置未知类型
    const b = createWorkflowNode({
      name: 'B',
      type: 'verification',
      description: 'B',
      dependencies: [a.id],
      mandatory: true,
    });
    (b as { type: string }).type = 'unknown_type';
    const def: WorkflowDefinition = {
      id: 'unknown-type',
      name: 'unknown-type',
      description: 'unknown type',
      version: 1,
      nodes: [a, b],
    };
    const result = validator.validate(def);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'UNKNOWN_NODE_TYPE');
    expect(err).toBeDefined();
  });

  it('依赖引用不存在的节点被拒绝', () => {
    const a = createWorkflowNode({ name: 'A', type: 'task', description: 'A' });
    const b = createWorkflowNode({
      name: 'B',
      type: 'verification',
      description: 'B',
      dependencies: ['nonexistent'],
      mandatory: true,
    });
    const def: WorkflowDefinition = {
      id: 'missing-dep',
      name: 'missing-dep',
      description: 'missing dep',
      version: 1,
      nodes: [a, b],
    };
    const result = validator.validate(def);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'MISSING_DEPENDENCY');
    expect(err).toBeDefined();
  });

  it('含环 DAG 被拒绝', () => {
    // A → B → A 形成环
    const a = createWorkflowNode({
      name: 'A',
      type: 'task',
      description: 'A',
    });
    const b = createWorkflowNode({
      name: 'B',
      type: 'task',
      description: 'B',
      dependencies: [a.id],
    });
    // 给 A 添加对 B 的依赖，形成环
    a.dependencies = [b.id];
    const v = createWorkflowNode({
      name: 'V',
      type: 'verification',
      description: 'V',
      dependencies: [b.id],
      mandatory: true,
    });
    const def: WorkflowDefinition = {
      id: 'cycle',
      name: 'cycle',
      description: 'cycle',
      version: 1,
      nodes: [a, b, v],
    };
    const result = validator.validate(def);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'CYCLE_DETECTED');
    expect(err).toBeDefined();
    expect(err?.nodeIds?.length).toBeGreaterThan(0);
  });

  it('重复节点 ID 被拒绝', () => {
    const a = createWorkflowNode({
      id: 'dup',
      name: 'A',
      type: 'task',
      description: 'A',
    });
    const b = createWorkflowNode({
      id: 'dup',
      name: 'B',
      type: 'verification',
      description: 'B',
      mandatory: true,
    });
    const def: WorkflowDefinition = {
      id: 'dup-id',
      name: 'dup-id',
      description: 'dup id',
      version: 1,
      nodes: [a, b],
    };
    const result = validator.validate(def);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'DUPLICATE_NODE_ID');
    expect(err).toBeDefined();
  });
});
