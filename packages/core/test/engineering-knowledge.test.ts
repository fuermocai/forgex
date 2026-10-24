/**
 * Engineering Knowledge 测试（v0.5.0 Phase 6）。
 */
import { describe, it, expect } from 'vitest';
import { EngineeringKnowledgeStore } from '../src/memory/engineering-knowledge-store.js';

describe('EngineeringKnowledgeStore', () => {
  it('创建知识 → active 状态（非 draft）', () => {
    const store = new EngineeringKnowledgeStore();
    const k = store.create({
      title: 'pnpm install 必须带 --no-frozen-lockfile',
      type: 'best-practice',
      content: '在 lockfile 与 package.json 不同步时使用',
      scope: ['all'],
      evidenceRefs: ['docs/build.md:12', 'pnpm-workspace.yaml'],
      source: 'user',
    });
    expect(k.status).toBe('active');
    expect(k.draft).toBe(false);
    expect(store.size()).toBe(1);
  });

  it('LLM 推断知识默认 draft=true', () => {
    const store = new EngineeringKnowledgeStore();
    const k = store.create({
      title: 'vite 构建缓存路径问题',
      type: 'pitfall',
      content: 'Windows 下 node_modules/.cache/vite 可能导致旧产物残留',
      scope: ['devops'],
      evidenceRefs: ['src/vite.config.ts', 'tools/build.js:45'],
      source: 'agent',
      draft: true,
    });
    expect(k.status).toBe('draft');
    expect(k.draft).toBe(true);
  });

  it('无证据引用 → 抛错', () => {
    const store = new EngineeringKnowledgeStore();
    let err: any = null;
    try {
      store.create({
        title: '凭空的知识',
        type: 'best-practice',
        content: 'blah',
        scope: ['all'],
        evidenceRefs: [],
        source: 'user',
      });
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
  });

  it('verify 从 draft → active', () => {
    const store = new EngineeringKnowledgeStore();
    const k = store.create({
      title: 'draft', type: 'pitfall', content: 'c', scope: ['x'], evidenceRefs: ['e'], source: 'agent', draft: true,
    });
    const verified = store.verify(k.id);
    expect(verified.status).toBe('active');
    expect(verified.draft).toBe(false);
  });

  it('deprecate / archive', () => {
    const store = new EngineeringKnowledgeStore();
    const k = store.create({
      title: 'old', type: 'architecture-decision', content: 'c', scope: ['all'], evidenceRefs: ['e'], source: 'user',
    });
    const dep = store.deprecate(k.id);
    expect(dep.status).toBe('deprecated');
    const arc = store.archive(k.id);
    expect(arc.status).toBe('archived');
  });

  it('search 不返回 archived', () => {
    const store = new EngineeringKnowledgeStore();
    const a = store.create({ title: 'React 最佳实践', type: 'best-practice', content: 'useState', scope: ['frontend'], evidenceRefs: ['e1'], source: 'user' });
    store.create({ title: 'Vue 最佳实践', type: 'best-practice', content: 'composition', scope: ['frontend'], evidenceRefs: ['e2'], source: 'user' });
    store.archive(a.id);

    const r = store.search('react');
    expect(r).toHaveLength(0); // archived 被排除
  });

  it('query 按 status 过滤', () => {
    const store = new EngineeringKnowledgeStore();
    store.create({ title: 't1', type: 'best-practice', content: 'c', scope: ['a'], evidenceRefs: ['e1'], source: 'user' });
    store.create({ title: 't2', type: 'pitfall', content: 'c', scope: ['b'], evidenceRefs: ['e2'], source: 'agent', draft: true });

    expect(store.active()).toHaveLength(1);
    expect(store.drafts()).toHaveLength(1);
    expect(store.query({ type: ['pitfall'] })).toHaveLength(1);
  });

  it('get 不存在的知识抛错', () => {
    const store = new EngineeringKnowledgeStore();
    let err: any = null;
    try { store.get('nonexistent'); } catch (e) { err = e; }
    expect(err).not.toBeNull();
  });
});
