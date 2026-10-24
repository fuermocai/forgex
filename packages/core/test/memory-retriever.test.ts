/**
 * MemoryRetriever 单元测试（v0.3.0 Phase 4）。
 *
 * 覆盖：
 *   - extractTerms 分词规则
 *   - scoreEntry 的 key/content/tags 加权
 *   - computeFreshness 的指数衰减
 *   - recall 的 scope 过滤、标签过滤、0 相关剔除、排序与 limit
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';
import {
  MemoryRetriever,
  extractTerms,
  scoreEntry,
  computeFreshness,
} from '../src/memory/retriever.js';
import { createMemoryEntry, type MemoryEntry } from '../src/memory/types.js';

const WS = '/repo/test';

function insert(
  store: MemoryStore,
  patch: Partial<Parameters<typeof createMemoryEntry>[0]> = {},
): MemoryEntry {
  const entry = createMemoryEntry({
    kind: 'fact',
    source: 'agent',
    scope: 'project',
    key: 'some.key',
    content: 'some content',
    workspace: WS,
    ...patch,
  });
  store.insert(entry);
  return entry;
}

describe('extractTerms', () => {
  it('按空白与标点切分并转小写', () => {
    expect(extractTerms('Build Command, TEST!')).toEqual(['build', 'command', 'test']);
  });

  it('过滤长度 < 2 的词并去重', () => {
    expect(extractTerms('a b cd cd efg')).toEqual(['cd', 'efg']);
  });

  it('中文整段保留', () => {
    expect(extractTerms('构建命令 是什么')).toEqual(['构建命令', '是什么']);
  });

  it('空串返回空数组', () => {
    expect(extractTerms('')).toEqual([]);
    expect(extractTerms('  ,. ')).toEqual([]);
  });
});

describe('scoreEntry', () => {
  const entry = createMemoryEntry({
    kind: 'fact',
    source: 'agent',
    scope: 'project',
    key: 'build.command',
    content: 'use pnpm build',
    workspace: WS,
    tags: ['ci'],
  });

  it('key 命中权重高于 content', () => {
    const keyScore = scoreEntry(entry, ['command']);
    const contentScore = scoreEntry(entry, ['pnpm']);
    expect(keyScore).toBeGreaterThan(contentScore);
  });

  it('tag 命中单独计分', () => {
    expect(scoreEntry(entry, ['ci'])).toBeGreaterThan(0);
  });

  it('多词命中累计', () => {
    const single = scoreEntry(entry, ['build']);
    const multi = scoreEntry(entry, ['build', 'command']);
    expect(multi).toBeGreaterThan(single);
  });

  it('无命中为 0', () => {
    expect(scoreEntry(entry, ['nonexistent'])).toBe(0);
  });
});

describe('computeFreshness', () => {
  const now = new Date('2026-10-23T00:00:00.000Z');

  it('刚更新的记忆新鲜度为 1', () => {
    const entry = createMemoryEntry({
      kind: 'fact',
      source: 'agent',
      scope: 'project',
      key: 'k',
      content: 'c',
      workspace: WS,
    });
    expect(computeFreshness(entry, new Date(entry.updated_at))).toBe(1);
  });

  it('30 天前约衰减一半', () => {
    const entry = createMemoryEntry({
      kind: 'fact',
      source: 'agent',
      scope: 'project',
      key: 'k',
      content: 'c',
      workspace: WS,
    });
    const old = { ...entry, updated_at: '2026-09-23T00:00:00.000Z' };
    const f = computeFreshness(old, now);
    expect(f).toBeGreaterThan(0.45);
    expect(f).toBeLessThan(0.55);
  });

  it('未来时间按 1 处理', () => {
    const entry = createMemoryEntry({
      kind: 'fact',
      source: 'agent',
      scope: 'project',
      key: 'k',
      content: 'c',
      workspace: WS,
    });
    const future = { ...entry, updated_at: '2030-01-01T00:00:00.000Z' };
    expect(computeFreshness(future, now)).toBe(1);
  });
});

describe('MemoryRetriever.recall', () => {
  let store: MemoryStore;
  let retriever: MemoryRetriever;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
    retriever = new MemoryRetriever(store);
  });

  afterEach(() => {
    store.close();
  });

  it('按 workspace 隔离', () => {
    insert(store, { key: 'a', content: 'from test ws' });
    insert(store, { key: 'a', content: 'from other ws', workspace: '/other' });
    const hits = retriever.recall({ workspace: WS });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.content).toBe('from test ws');
  });

  it('scopes 限定生效', () => {
    insert(store, { key: 'p', content: 'project note' });
    insert(store, { key: 's', content: 'session note', scope: 'session', session_id: 's1' });
    const hits = retriever.recall({ workspace: WS, scopes: ['session'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.key).toBe('s');
  });

  it('session 级记忆按 session_id 过滤，project 级不受 session_id 影响', () => {
    insert(store, { key: 'p', content: 'project note' });
    insert(store, { key: 's', content: 'session note', scope: 'session', session_id: 's1' });
    const hits = retriever.recall({ workspace: WS, session_id: 's2' });
    expect(hits.map((h) => h.entry.key).sort()).toEqual(['p']);
  });

  it('text 查询剔除 0 相关项', () => {
    insert(store, { key: 'build.command', content: 'pnpm build', tags: ['build'] });
    insert(store, { key: 'deploy.target', content: 'k8s prod cluster' });
    const hits = retriever.recall({ workspace: WS, text: 'pnpm build' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.key).toBe('build.command');
    expect(hits[0]!.relevance).toBeGreaterThan(0);
  });

  it('tags 过滤为 AND 语义', () => {
    insert(store, { key: 'a', content: 'x', tags: ['build', 'ci'] });
    insert(store, { key: 'b', content: 'y', tags: ['build'] });
    const hits = retriever.recall({ workspace: WS, tags: ['build', 'ci'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.key).toBe('a');
  });

  it('过期与被取代的记忆不返回', () => {
    insert(store, {
      key: 'expired',
      content: 'old note',
      expires_at: '2000-01-01T00:00:00.000Z',
    });
    const old = insert(store, { key: 'k', content: 'v1' });
    const newer = insert(store, { key: 'k', content: 'v2' });
    store.markSuperseded(old.id, newer.id);

    const hits = retriever.recall({ workspace: WS });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.content).toBe('v2');
  });

  it('高置信度排在低置信度前（无查询词时）', () => {
    insert(store, { key: 'low', content: 'a', confidence: 0.3 });
    insert(store, { key: 'high', content: 'b', confidence: 0.95 });
    const hits = retriever.recall({ workspace: WS });
    expect(hits[0]!.entry.key).toBe('high');
  });

  it('limit 生效且有硬上限保护', () => {
    for (let i = 0; i < 10; i++) {
      insert(store, { key: `k${i}`, content: `note ${i}` });
    }
    expect(retriever.recall({ workspace: WS, limit: 3 })).toHaveLength(3);
  });

  it('kind 过滤生效', () => {
    insert(store, { key: 'f', content: 'fact note', kind: 'fact' });
    insert(store, { key: 'h', content: 'hypothesis note', kind: 'hypothesis' });
    const hits = retriever.recall({ workspace: WS, kind: 'hypothesis' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.kind).toBe('hypothesis');
  });

  it('rankScore 分解字段完整', () => {
    insert(store, { key: 'k', content: 'c', confidence: 0.8 });
    const [hit] = retriever.recall({ workspace: WS, text: 'k' });
    expect(hit).toBeDefined();
    expect(typeof hit!.relevance).toBe('number');
    expect(typeof hit!.freshness).toBe('number');
    expect(typeof hit!.rankScore).toBe('number');
  });
});
