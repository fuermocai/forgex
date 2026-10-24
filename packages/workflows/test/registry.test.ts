/**
 * WorkflowRegistry 测试（v0.4.0 Phase 1）。
 */
import { describe, it, expect } from 'vitest';
import { WorkflowRegistry } from '../src/registry/workflow-registry.js';
import { registerBuiltinWorkflows } from '../src/definitions/index.js';
import {
  type WorkflowDefinition,
  createWorkflowNode,
} from '../src/types.js';
import { ForgeError } from '@forgex/shared';

function makeValidWorkflow(id: string): WorkflowDefinition {
  const a = createWorkflowNode({ name: 'A', type: 'task', description: 'A' });
  const b = createWorkflowNode({
    name: 'B',
    type: 'verification',
    description: 'B',
    dependencies: [a.id],
    mandatory: true,
  });
  return {
    id,
    name: id,
    description: id,
    version: 1,
    nodes: [a, b],
  };
}

describe('WorkflowRegistry', () => {
  it('register 成功后可 get', () => {
    const registry = new WorkflowRegistry();
    const def = makeValidWorkflow('wf-1');
    registry.register(def);
    expect(registry.get('wf-1')).toEqual(def);
  });

  it('register 校验失败抛 ForgeError', () => {
    const registry = new WorkflowRegistry();
    const invalidDef: WorkflowDefinition = {
      id: 'invalid',
      name: 'invalid',
      description: 'no verification',
      version: 1,
      nodes: [createWorkflowNode({ name: 'A', type: 'task', description: 'A' })],
    };
    expect(() => registry.register(invalidDef)).toThrow(ForgeError);
  });

  it('重复 ID 注册抛错', () => {
    const registry = new WorkflowRegistry();
    registry.register(makeValidWorkflow('wf-1'));
    expect(() => registry.register(makeValidWorkflow('wf-1'))).toThrow(ForgeError);
  });

  it('get 不存在返回 undefined', () => {
    const registry = new WorkflowRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('list 返回所有已注册工作流', () => {
    const registry = new WorkflowRegistry();
    registry.register(makeValidWorkflow('wf-1'));
    registry.register(makeValidWorkflow('wf-2'));
    expect(registry.list()).toHaveLength(2);
  });

  it('has 正确判断', () => {
    const registry = new WorkflowRegistry();
    registry.register(makeValidWorkflow('wf-1'));
    expect(registry.has('wf-1')).toBe(true);
    expect(registry.has('wf-2')).toBe(false);
  });

  it('unregister 注销工作流', () => {
    const registry = new WorkflowRegistry();
    registry.register(makeValidWorkflow('wf-1'));
    expect(registry.unregister('wf-1')).toBe(true);
    expect(registry.has('wf-1')).toBe(false);
  });

  it('registerBuiltinWorkflows 注册 6 个内置工作流', () => {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);
    const ids = registry.list().map((w) => w.id);
    expect(ids).toContain('bug-fix');
    expect(ids).toContain('feature-dev');
    expect(ids).toContain('code-review');
    expect(ids).toContain('refactoring');
    expect(ids).toContain('devops-diagnosis');
    expect(ids).toContain('deployment-prep');
  });
});

describe('内置工作流定义', () => {
  it('Bug Fix 工作流包含 Analyze/Plan/Implement/Test/Review', () => {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);
    const wf = registry.get('bug-fix')!;
    const names = wf.nodes.map((n) => n.name);
    expect(names).toContain('Analyze');
    expect(names).toContain('Plan');
    expect(names).toContain('Implement');
    expect(names).toContain('Test');
    expect(names).toContain('Review');
  });

  it('每个内置工作流至少有一个 verification 节点', () => {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);
    for (const wf of registry.list()) {
      const hasVerification = wf.nodes.some((n) => n.type === 'verification');
      expect(hasVerification, `${wf.id} 缺少 verification 节点`).toBe(true);
    }
  });

  it('每个内置工作流通过校验', () => {
    const registry = new WorkflowRegistry();
    // register 内部会校验，能注册成功说明通过
    registerBuiltinWorkflows(registry);
    expect(registry.list()).toHaveLength(6);
  });

  it('Deployment Prep 包含 approval 节点', () => {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);
    const wf = registry.get('deployment-prep')!;
    const hasApproval = wf.nodes.some((n) => n.type === 'approval');
    expect(hasApproval).toBe(true);
  });
});
