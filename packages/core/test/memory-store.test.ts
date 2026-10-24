/**
 * MemoryStore 单元测试（v0.3.0 Phase 4）。
 *
 * 使用 ':memory:' 内存数据库，验证：
 *   - insert / getById 往返一致
 *   - getCurrent 只返回未取代的最新版本
 *   - query 各过滤条件组合
 *   - markSuperseded 软删除与幂等保护
 *   - count 统计
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';
import { createMemoryEntry, type MemoryEntry } from '../src/memory/types.js';

const WS = '/repo/test';

function makeEntry(patch: Partial<Parameters<typeof createMemoryEntry>[0]> = {}): MemoryEntry {
  return createMemoryEntry({
    kind: 'fact',
    source: 'user',
    scope: 'project',
    key: 'build.command',
    content: 'pnpm build',
    workspace: WS,
    ...patch,
  });
}

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('insert / getById', () => {
    it('写入后可按 ID 读回，字段一致', () => {
      const entry = makeEntry({
        tags: ['build'],
        evidence_refs: ['msg:1'],
        confidence: 0.9,
      });
      store.insert(entry);

      const loaded = store.getById(entry.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(entry.id);
      expect(loaded!.key).toBe('build.command');
      expect(loaded!.content).toBe('pnpm build');
      expect(loaded!.tags).toEqual(['build']);
      expect(loaded!.evidence_refs).toEqual(['msg:1']);
      expect(loaded!.confidence).toBe(0.9);
      expect(loaded!.superseded_by).toBeUndefined();
    });

    it('可选字段往返保留', () => {
      const entry = makeEntry({
        scope: 'task',
        session_id: 'sess-1',
        task_id: 'task-1',
        expires_at: '2030-01-01T00:00:00.000Z',
      });
      store.insert(entry);
      const loaded = store.getById(entry.id)!;
      expect(loaded.session_id).toBe('sess-1');
      expect(loaded.task_id).toBe('task-1');
      expect(loaded.expires_at).toBe('2030-01-01T00:00:00.000Z');
    });

    it('getById 未命中返回 null', () => {
      expect(store.getById('not-exist')).toBeNull();
    });

    it('重复插入同 ID 抛 MEMORY_STORE_ERROR', () => {
      const entry = makeEntry();
      store.insert(entry);
      let code = '';
      try {
        store.insert(entry);
      } catch (err) {
        code = (err as { code?: string }).code ?? '';
      }
      expect(code).toBe('MEMORY_STORE_ERROR');
    });
  });

  describe('getCurrent', () => {
    it('返回未被取代的那一条', () => {
      const v1 = makeEntry({ content: 'v1' });
      store.insert(v1);
      const v2 = makeEntry({ content: 'v2' });
      store.insert(v2);
      store.markSuperseded(v1.id, v2.id);

      const current = store.getCurrent(WS, 'project', 'build.command');
      expect(current).not.toBeNull();
      expect(current!.id).toBe(v2.id);
      expect(current!.content).toBe('v2');
    });

    it('workspace / scope / key 任一不匹配都返回 null', () => {
      store.insert(makeEntry());
      expect(store.getCurrent('/other', 'project', 'build.command')).toBeNull();
      expect(store.getCurrent(WS, 'session', 'build.command')).toBeNull();
      expect(store.getCurrent(WS, 'project', 'other.key')).toBeNull();
    });

    it('extra 限定 session_id / task_id 生效', () => {
      const entry = makeEntry({
        scope: 'task',
        key: 'task.note',
        session_id: 's1',
        task_id: 't1',
      });
      store.insert(entry);
      expect(
        store.getCurrent(WS, 'task', 'task.note', { session_id: 's1', task_id: 't1' })?.id,
      ).toBe(entry.id);
      expect(
        store.getCurrent(WS, 'task', 'task.note', { session_id: 's2', task_id: 't1' }),
      ).toBeNull();
    });
  });

  describe('query', () => {
    it('按 scope 过滤', () => {
      store.insert(makeEntry({ key: 'a', scope: 'project' }));
      store.insert(
        makeEntry({ key: 'b', scope: 'session', session_id: 's1' }),
      );
      const result = store.query({ workspace: WS, scope: 'session' });
      expect(result).toHaveLength(1);
      expect(result[0]!.key).toBe('b');
    });

    it('默认不含已被取代的记录', () => {
      const v1 = makeEntry({ content: 'v1' });
      const v2 = makeEntry({ content: 'v2' });
      store.insert(v1);
      store.insert(v2);
      store.markSuperseded(v1.id, v2.id);

      expect(store.query({ workspace: WS })).toHaveLength(1);
      expect(store.query({ workspace: WS, includeSuperseded: true })).toHaveLength(2);
    });

    it('按 session_id / task_id / kind / key 过滤', () => {
      store.insert(
        makeEntry({ key: 'k1', scope: 'task', session_id: 's1', task_id: 't1', kind: 'fact' }),
      );
      store.insert(
        makeEntry({
          key: 'k2',
          scope: 'task',
          session_id: 's1',
          task_id: 't1',
          kind: 'hypothesis',
        }),
      );
      store.insert(
        makeEntry({ key: 'k3', scope: 'task', session_id: 's2', task_id: 't2' }),
      );

      expect(store.query({ workspace: WS, session_id: 's1' })).toHaveLength(2);
      expect(store.query({ workspace: WS, task_id: 't2' })).toHaveLength(1);
      expect(store.query({ workspace: WS, kind: 'hypothesis' })).toHaveLength(1);
      expect(store.query({ workspace: WS, key: 'k2' })).toHaveLength(1);
    });

    it('limit 生效', () => {
      for (let i = 0; i < 5; i++) {
        store.insert(makeEntry({ key: `k${i}` }));
      }
      expect(store.query({ workspace: WS, limit: 3 })).toHaveLength(3);
    });
  });

  describe('markSuperseded', () => {
    it('软删除后 getById 仍可读（含 superseded_by）', () => {
      const oldEntry = makeEntry({ content: 'old' });
      const newEntry = makeEntry({ content: 'new' });
      store.insert(oldEntry);
      store.insert(newEntry);

      expect(store.markSuperseded(oldEntry.id, newEntry.id)).toBe(true);
      const loaded = store.getById(oldEntry.id)!;
      expect(loaded.superseded_by).toBe(newEntry.id);
    });

    it('重复取代返回 false（幂等保护）', () => {
      const a = makeEntry({ key: 'a' });
      const b = makeEntry({ key: 'b' });
      const c = makeEntry({ key: 'c' });
      store.insert(a);
      store.insert(b);
      store.insert(c);

      expect(store.markSuperseded(a.id, b.id)).toBe(true);
      expect(store.markSuperseded(a.id, c.id)).toBe(false);
    });

    it('目标不存在返回 false', () => {
      expect(store.markSuperseded('ghost', 'whatever')).toBe(false);
    });
  });

  describe('count', () => {
    it('统计 workspace 下记忆条数', () => {
      expect(store.count(WS)).toBe(0);
      store.insert(makeEntry({ key: 'a' }));
      store.insert(makeEntry({ key: 'b' }));
      store.insert(makeEntry({ key: 'c', workspace: '/other' }));
      expect(store.count(WS)).toBe(2);
    });

    it('含已取代时需显式开启', () => {
      const a = makeEntry({ key: 'a' });
      const b = makeEntry({ key: 'a' });
      store.insert(a);
      store.insert(b);
      store.markSuperseded(a.id, b.id);
      expect(store.count(WS)).toBe(1);
      expect(store.count(WS, true)).toBe(2);
    });
  });
});
