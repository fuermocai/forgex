/**
 * EvidenceStore 单元测试（v0.3.0 Phase 5）。
 *
 * 覆盖：
 *   - put / get 往返一致（含字节数、预览、sessionId）
 *   - makePreview 截断规则
 *   - renderEvidencePlaceholder 输出模型可读引用
 *   - getRef 不读原文、listBySession 按时间升序
 *   - delete / purgeSession / count
 *   - 非法输入抛 EVIDENCE_STORE_ERROR
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  EvidenceStore,
  isEvidenceKind,
  makePreview,
  renderEvidencePlaceholder,
  newEvidenceId,
  PREVIEW_MAX_CHARS,
  EVIDENCE_KINDS,
} from '../src/context/evidence-store.js';

describe('EvidenceKind 守卫', () => {
  it('识别全部合法类别', () => {
    expect(EVIDENCE_KINDS).toHaveLength(5);
    for (const kind of EVIDENCE_KINDS) {
      expect(isEvidenceKind(kind)).toBe(true);
    }
  });

  it('拒绝非法类别', () => {
    expect(isEvidenceKind('secret')).toBe(false);
    expect(isEvidenceKind('')).toBe(false);
    expect(isEvidenceKind(null)).toBe(false);
  });
});

describe('makePreview', () => {
  it('短内容原样返回（去首尾空白）', () => {
    expect(makePreview('  hello  ')).toBe('hello');
  });

  it('超长内容截断并加省略号', () => {
    const long = 'x'.repeat(PREVIEW_MAX_CHARS + 50);
    const preview = makePreview(long);
    expect(preview.length).toBe(PREVIEW_MAX_CHARS + 1); // +1 是 …
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('newEvidenceId', () => {
  it('带 ev_ 前缀且唯一', () => {
    const a = newEvidenceId();
    const b = newEvidenceId();
    expect(a.startsWith('ev_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('renderEvidencePlaceholder', () => {
  it('包含 id、kind、字节数与预览', () => {
    const text = renderEvidencePlaceholder({
      id: 'ev_123',
      kind: 'tool_output',
      byteLen: 12345,
      preview: '前几行日志',
      createdAt: '2026-10-23T00:00:00.000Z',
    });
    expect(text).toContain('evidence_id=ev_123');
    expect(text).toContain('kind=tool_output');
    expect(text).toContain('12345');
    expect(text).toContain('前几行日志');
  });
});

describe('EvidenceStore', () => {
  let store: EvidenceStore;

  beforeEach(() => {
    store = new EvidenceStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('put 后可 get 完整记录', () => {
    const ref = store.put({
      kind: 'tool_output',
      content: 'a'.repeat(5000),
      sessionId: 'sess-1',
    });
    expect(ref.id.startsWith('ev_')).toBe(true);
    expect(ref.byteLen).toBe(5000);
    expect(ref.preview.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS + 1);
    expect(ref.sessionId).toBe('sess-1');

    const record = store.get(ref.id)!;
    expect(record.content).toBe('a'.repeat(5000));
    expect(record.kind).toBe('tool_output');
    expect(record.sessionId).toBe('sess-1');
  });

  it('中文内容字节数按 UTF-8 计', () => {
    const ref = store.put({ kind: 'log_excerpt', content: '汉字' });
    expect(ref.byteLen).toBe(6);
  });

  it('get 未命中返回 null', () => {
    expect(store.get('ev_ghost')).toBeNull();
  });

  it('空内容与非法类别被拒绝', () => {
    for (const bad of [
      () => store.put({ kind: 'tool_output', content: '' }),
      () => store.put({ kind: 'bad_kind' as never, content: 'x' }),
    ]) {
      let code = '';
      try {
        bad();
      } catch (err) {
        code = (err as { code?: string }).code ?? '';
      }
      expect(code).toBe('EVIDENCE_STORE_ERROR');
    }
  });

  it('getRef 返回引用且不含原文', () => {
    const ref = store.put({ kind: 'diff', content: 'x'.repeat(10000), sessionId: 's' });
    const loaded = store.getRef(ref.id)!;
    expect(loaded.id).toBe(ref.id);
    expect(loaded.byteLen).toBe(10000);
    expect('content' in loaded).toBe(false);
  });

  it('listBySession 按创建时间升序', () => {
    const r1 = store.put({ kind: 'other', content: 'first', sessionId: 's1' });
    const r2 = store.put({ kind: 'other', content: 'second', sessionId: 's1' });
    store.put({ kind: 'other', content: 'other session', sessionId: 's2' });

    const list = store.listBySession('s1');
    expect(list.map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(list.every((r) => r.sessionId === 's1')).toBe(true);
  });

  it('delete 删除单条，重复删除返回 false', () => {
    const ref = store.put({ kind: 'other', content: 'x' });
    expect(store.delete(ref.id)).toBe(true);
    expect(store.delete(ref.id)).toBe(false);
    expect(store.get(ref.id)).toBeNull();
  });

  it('purgeSession 只清理指定 session', () => {
    store.put({ kind: 'other', content: 'a', sessionId: 's1' });
    store.put({ kind: 'other', content: 'b', sessionId: 's1' });
    store.put({ kind: 'other', content: 'c', sessionId: 's2' });
    store.put({ kind: 'other', content: 'no session' });

    expect(store.purgeSession('s1')).toBe(2);
    expect(store.count('s1')).toBe(0);
    expect(store.count()).toBe(2);
  });

  it('count 支持全量与按 session', () => {
    expect(store.count()).toBe(0);
    store.put({ kind: 'other', content: 'a', sessionId: 's1' });
    store.put({ kind: 'other', content: 'b' });
    expect(store.count()).toBe(2);
    expect(store.count('s1')).toBe(1);
    expect(store.count('nope')).toBe(0);
  });
});
