/**
 * MemoryConsolidator 单元测试（v0.3.0 Phase 4）。
 *
 * 覆盖：
 *   - 首次写入（无既有 entry）
 *   - 同 key 更新取代旧 entry
 *   - hypothesis 被 fact 证实升级（promoted）
 *   - user 高置信 fact 不被 agent 覆盖（conflict）
 *   - user 自己更新同 key 不算冲突
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';
import { MemoryConsolidator } from '../src/memory/consolidator.js';
import type { CreateMemoryInput } from '../src/memory/types.js';

const WS = '/repo/test';

function makeInput(patch: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    kind: 'fact',
    source: 'agent',
    scope: 'project',
    key: 'build.command',
    content: 'pnpm build',
    workspace: WS,
    ...patch,
  };
}

describe('MemoryConsolidator', () => {
  let store: MemoryStore;
  let consolidator: MemoryConsolidator;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
    consolidator = new MemoryConsolidator(store);
  });

  afterEach(() => {
    store.close();
  });

  it('首次写入直接入库，无取代', () => {
    const result = consolidator.consolidate(makeInput());
    expect(result.conflict).toBe(false);
    expect(result.promoted).toBe(false);
    expect(result.superseded).toBeUndefined();
    expect(store.getById(result.entry.id)).not.toBeNull();
  });

  it('同 key 更新：旧 entry 被取代，新 entry 成为当前版本', () => {
    const first = consolidator.consolidate(makeInput({ content: 'v1' }));
    const second = consolidator.consolidate(makeInput({ content: 'v2' }));

    expect(second.conflict).toBe(false);
    expect(second.superseded?.id).toBe(first.entry.id);

    const oldRow = store.getById(first.entry.id)!;
    expect(oldRow.superseded_by).toBe(second.entry.id);

    const current = store.getCurrent(WS, 'project', 'build.command')!;
    expect(current.id).toBe(second.entry.id);
    expect(current.content).toBe('v2');
  });

  it('hypothesis 被同 key fact 证实：promoted=true', () => {
    consolidator.consolidate(
      makeInput({ kind: 'hypothesis', content: '可能用 pnpm', confidence: 0.5 }),
    );
    const confirmed = consolidator.consolidate(
      makeInput({ kind: 'fact', content: '确认用 pnpm', confidence: 0.95, source: 'tool_run' }),
    );
    expect(confirmed.promoted).toBe(true);
    expect(confirmed.conflict).toBe(false);
  });

  it('fact 覆盖 hypothesis 但置信度未提升不算 promoted', () => {
    consolidator.consolidate(
      makeInput({ kind: 'hypothesis', content: 'h', confidence: 0.7 }),
    );
    const result = consolidator.consolidate(
      makeInput({ kind: 'fact', content: 'f', confidence: 0.6 }),
    );
    expect(result.promoted).toBe(false);
  });

  it('user 高置信 fact 不被 agent 覆盖：conflict=true 且不写入', () => {
    consolidator.consolidate(
      makeInput({ source: 'user', content: 'production 分支是 main', confidence: 1.0 }),
    );
    const countBefore = store.count(WS);
    const attempt = consolidator.consolidate(
      makeInput({ source: 'agent', content: 'production 分支是 master', confidence: 0.6 }),
    );
    expect(attempt.conflict).toBe(true);
    // 冲突不写入新数据
    expect(store.count(WS)).toBe(countBefore);
    // 旧 entry 未被取代
    const current = store.getCurrent(WS, 'project', 'build.command')!;
    expect(current.content).toBe('production 分支是 main');
  });

  it('user 自己更新同 key 事实：正常取代不算冲突', () => {
    consolidator.consolidate(
      makeInput({ source: 'user', content: '分支是 main', confidence: 1.0 }),
    );
    const update = consolidator.consolidate(
      makeInput({ source: 'user', content: '分支改成 trunk', confidence: 1.0 }),
    );
    expect(update.conflict).toBe(false);
    expect(update.superseded).toBeDefined();
    expect(store.getCurrent(WS, 'project', 'build.command')!.content).toBe('分支改成 trunk');
  });

  it('agent 同内容重复写入 user 事实不算冲突', () => {
    consolidator.consolidate(
      makeInput({ source: 'user', content: '相同内容', confidence: 1.0 }),
    );
    const dup = consolidator.consolidate(makeInput({ source: 'agent', content: '相同内容' }));
    expect(dup.conflict).toBe(false);
  });

  it('不同 scope 的同 key 互不影响', () => {
    consolidator.consolidate(makeInput({ key: 'shared.key', content: 'project 级' }));
    const sessionVersion = consolidator.consolidate(
      makeInput({
        key: 'shared.key',
        content: 'session 级',
        scope: 'session',
        session_id: 's1',
      }),
    );
    expect(sessionVersion.conflict).toBe(false);
    expect(sessionVersion.superseded).toBeUndefined();
    expect(store.getCurrent(WS, 'project', 'shared.key')!.content).toBe('project 级');
  });

  it('不同 task_id 的同 key 互不影响', () => {
    consolidator.consolidate(
      makeInput({ scope: 'task', session_id: 's1', task_id: 't1', key: 'note', content: 't1 笔记' }),
    );
    const other = consolidator.consolidate(
      makeInput({ scope: 'task', session_id: 's1', task_id: 't2', key: 'note', content: 't2 笔记' }),
    );
    expect(other.superseded).toBeUndefined();
    expect(store.query({ workspace: WS })).toHaveLength(2);
  });
});
