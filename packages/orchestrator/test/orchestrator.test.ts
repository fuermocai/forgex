/**
 * Project Orchestrator 测试（v0.5.0 Phase 4）。
 */
import { describe, it, expect } from 'vitest';
import { DependencyGraph } from '../src/dependency-graph.js';
import { ProjectOrchestrator } from '../src/project-orchestrator.js';

describe('DependencyGraph', () => {
  it('简单图拓扑排序', () => {
    const g = new DependencyGraph();
    g.addEdge('app', 'core');
    g.addEdge('core', 'shared');
    g.addEdge('app', 'shared');
    const order = g.topologicalOrder();
    // shared 必须在最前，app 在最后
    expect(order.indexOf('shared')).toBeLessThan(order.indexOf('core'));
    expect(order.indexOf('core')).toBeLessThan(order.indexOf('app'));
  });

  it('循环依赖抛错', () => {
    const g = new DependencyGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'a'); // 环
    let err: any = null;
    try { g.topologicalOrder(); } catch (e) { err = e; }
    expect(err).not.toBeNull();
  });

  it('下游影响面分析', () => {
    const g = new DependencyGraph();
    g.addEdge('app', 'core');
    g.addEdge('core', 'shared');
    g.addEdge('cli', 'core');
    const downstream = g.downstream('shared');
    expect(downstream).toContain('core');
    expect(downstream).toContain('app');
    expect(downstream).toContain('cli');
  });

  it('直接上游', () => {
    const g = new DependencyGraph();
    g.addEdge('app', 'core');
    g.addEdge('app', 'shared');
    expect(g.directUpstream('app').sort()).toEqual(['core', 'shared']);
  });

  it('混合 runtime/dev 边', () => {
    const g = new DependencyGraph();
    g.addEdge('app', 'core', 'runtime');
    g.addEdge('app', 'vitest', 'dev');
    const order = g.topologicalOrder();
    expect(order).toContain('vitest');
    expect(order.indexOf('core')).toBeLessThan(order.indexOf('app'));
  });
});

describe('ProjectOrchestrator', () => {
  it('分层计划：shared(0) → core/models(1) → app/cli(2)', () => {
    const o = new ProjectOrchestrator();
    o.register({ name: 'shared', dir: 'p/shared', dependencies: [] });
    o.register({ name: 'core', dir: 'p/core', dependencies: ['shared'] });
    o.register({ name: 'models', dir: 'p/models', dependencies: ['shared'] });
    o.register({ name: 'app', dir: 'p/app', dependencies: ['core', 'models'] });
    o.register({ name: 'cli', dir: 'p/cli', dependencies: ['core'] });

    const plan = o.plan();
    expect(plan.groups[0]).toEqual(['shared']);
    expect(plan.groups[1]!.sort()).toEqual(['core', 'models']);
    expect(plan.groups[2]!.sort()).toEqual(['app', 'cli']);
  });

  it('空项目 → 空计划', () => {
    const o = new ProjectOrchestrator();
    const plan = o.plan();
    expect(plan.executionOrder).toEqual([]);
    expect(plan.groups).toEqual([]);
  });

  it('单模块', () => {
    const o = new ProjectOrchestrator();
    o.register({ name: 'only', dir: 'p/only', dependencies: [] });
    const plan = o.plan();
    expect(plan.executionOrder).toEqual(['only']);
    expect(plan.groups).toEqual([['only']]);
  });
});
