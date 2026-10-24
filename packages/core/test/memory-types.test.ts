/**
 * Project Memory 类型定义单元测试（v0.3.0 Phase 4）。
 *
 * 覆盖：
 *   - MemoryKind / MemorySource / MemoryScope 枚举与 is 守卫
 *   - createMemoryEntry 的 ID 生成、时间戳、默认值填充
 *   - defaultConfidence / clampConfidence 的取值规则
 *   - isActive 的 superseded / 过期判断
 *   - scopeFieldsConsistent 的 scope 与关联字段一致性校验
 */
import { describe, expect, it } from 'vitest';
import {
  MEMORY_KINDS,
  MEMORY_SOURCES,
  MEMORY_SCOPES,
  MEMORY_KEY_PATTERN,
  MAX_CONTENT_BYTES,
  HYPOTHESIS_PROMOTE_THRESHOLD,
  createMemoryEntry,
  defaultConfidence,
  clampConfidence,
  isActive,
  isMemoryKind,
  isMemorySource,
  isMemoryScope,
  scopeFieldsConsistent,
} from '../src/memory/types.js';

describe('MemoryKind 枚举', () => {
  it('包含 fact 与 hypothesis', () => {
    expect(MEMORY_KINDS).toHaveLength(2);
    expect(MEMORY_KINDS).toContain('fact');
    expect(MEMORY_KINDS).toContain('hypothesis');
  });

  it('isMemoryKind 正确识别', () => {
    expect(isMemoryKind('fact')).toBe(true);
    expect(isMemoryKind('hypothesis')).toBe(true);
    expect(isMemoryKind('guess')).toBe(false);
    expect(isMemoryKind('')).toBe(false);
    expect(isMemoryKind(null)).toBe(false);
    expect(isMemoryKind(42)).toBe(false);
  });
});

describe('MemorySource 枚举', () => {
  it('包含 user / agent / tool_run', () => {
    expect(MEMORY_SOURCES).toHaveLength(3);
    expect(MEMORY_SOURCES).toContain('user');
    expect(MEMORY_SOURCES).toContain('agent');
    expect(MEMORY_SOURCES).toContain('tool_run');
  });

  it('isMemorySource 正确识别', () => {
    expect(isMemorySource('user')).toBe(true);
    expect(isMemorySource('agent')).toBe(true);
    expect(isMemorySource('tool_run')).toBe(true);
    expect(isMemorySource('system')).toBe(false);
    expect(isMemorySource(undefined)).toBe(false);
  });
});

describe('MemoryScope 枚举', () => {
  it('包含 project / session / task', () => {
    expect(MEMORY_SCOPES).toHaveLength(3);
    expect(MEMORY_SCOPES).toContain('project');
    expect(MEMORY_SCOPES).toContain('session');
    expect(MEMORY_SCOPES).toContain('task');
  });

  it('isMemoryScope 正确识别', () => {
    expect(isMemoryScope('project')).toBe(true);
    expect(isMemoryScope('session')).toBe(true);
    expect(isMemoryScope('task')).toBe(true);
    expect(isMemoryScope('global')).toBe(false);
    expect(isMemoryScope({})).toBe(false);
  });
});

describe('边界常量', () => {
  it('key 格式正则匹配合法值', () => {
    expect(MEMORY_KEY_PATTERN.test('build.command')).toBe(true);
    expect(MEMORY_KEY_PATTERN.test('test_cmd')).toBe(true);
    expect(MEMORY_KEY_PATTERN.test('node-version')).toBe(true);
    expect(MEMORY_KEY_PATTERN.test('a')).toBe(true);
  });

  it('key 格式正则拒绝非法值', () => {
    expect(MEMORY_KEY_PATTERN.test('Build.Command')).toBe(false); // 大写
    expect(MEMORY_KEY_PATTERN.test('has space')).toBe(false);
    expect(MEMORY_KEY_PATTERN.test('中文键')).toBe(false);
    expect(MEMORY_KEY_PATTERN.test('')).toBe(false);
    expect(MEMORY_KEY_PATTERN.test('x'.repeat(129))).toBe(false); // 超长
  });

  it('常量取值合理', () => {
    expect(MAX_CONTENT_BYTES).toBe(4096);
    expect(HYPOTHESIS_PROMOTE_THRESHOLD).toBeGreaterThan(0);
    expect(HYPOTHESIS_PROMOTE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe('defaultConfidence', () => {
  it('user 事实为 1.0', () => {
    expect(defaultConfidence('user', 'fact')).toBe(1.0);
  });

  it('tool_run 事实为 0.9', () => {
    expect(defaultConfidence('tool_run', 'fact')).toBe(0.9);
  });

  it('agent 事实为 0.6', () => {
    expect(defaultConfidence('agent', 'fact')).toBe(0.6);
  });

  it('任何来源的 hypothesis 统一为 0.5', () => {
    expect(defaultConfidence('user', 'hypothesis')).toBe(0.5);
    expect(defaultConfidence('agent', 'hypothesis')).toBe(0.5);
    expect(defaultConfidence('tool_run', 'hypothesis')).toBe(0.5);
  });
});

describe('clampConfidence', () => {
  it('区间内的值原样返回', () => {
    expect(clampConfidence(0.5)).toBe(0.5);
    expect(clampConfidence(0)).toBe(0);
    expect(clampConfidence(1)).toBe(1);
  });

  it('越界值被截断到 [0, 1]', () => {
    expect(clampConfidence(-0.3)).toBe(0);
    expect(clampConfidence(1.7)).toBe(1);
  });

  it('NaN 归一为 0', () => {
    expect(clampConfidence(Number.NaN)).toBe(0);
  });
});

describe('createMemoryEntry', () => {
  it('生成 id 与时间戳', () => {
    const entry = createMemoryEntry({
      kind: 'fact',
      source: 'user',
      scope: 'project',
      key: 'build.command',
      content: 'pnpm build',
      workspace: '/repo',
    });
    expect(entry.id).toBeTruthy();
    expect(typeof entry.id).toBe('string');
    expect(entry.created_at).toBeTruthy();
    expect(entry.updated_at).toBe(entry.created_at);
    expect(entry.superseded_by).toBeUndefined();
  });

  it('默认 confidence 按 source/kind 推导', () => {
    const fromUser = createMemoryEntry({
      kind: 'fact',
      source: 'user',
      scope: 'project',
      key: 'k1',
      content: 'c',
      workspace: '/repo',
    });
    expect(fromUser.confidence).toBe(1.0);

    const hypothesis = createMemoryEntry({
      kind: 'hypothesis',
      source: 'agent',
      scope: 'session',
      key: 'k2',
      content: 'c',
      workspace: '/repo',
      session_id: 's1',
    });
    expect(hypothesis.confidence).toBe(0.5);
  });

  it('显式 confidence 越界时被 clamp', () => {
    const entry = createMemoryEntry({
      kind: 'fact',
      source: 'agent',
      scope: 'project',
      key: 'k',
      content: 'c',
      workspace: '/repo',
      confidence: 9.9,
    });
    expect(entry.confidence).toBe(1);
  });

  it('tags 与 evidence_refs 被拷贝而非引用', () => {
    const tags = ['build'];
    const refs = ['msg:1'];
    const entry = createMemoryEntry({
      kind: 'fact',
      source: 'agent',
      scope: 'project',
      key: 'k',
      content: 'c',
      workspace: '/repo',
      tags,
      evidence_refs: refs,
    });
    tags.push('mutated');
    refs.push('mutated');
    expect(entry.tags).toEqual(['build']);
    expect(entry.evidence_refs).toEqual(['msg:1']);
  });

  it('可选字段缺省时不出现在 entry 上', () => {
    const entry = createMemoryEntry({
      kind: 'fact',
      source: 'user',
      scope: 'project',
      key: 'k',
      content: 'c',
      workspace: '/repo',
    });
    expect('expires_at' in entry).toBe(false);
    expect('session_id' in entry).toBe(false);
    expect('task_id' in entry).toBe(false);
  });

  it('可选字段显式传入时被保留', () => {
    const entry = createMemoryEntry({
      kind: 'fact',
      source: 'tool_run',
      scope: 'task',
      key: 'k',
      content: 'c',
      workspace: '/repo',
      expires_at: '2030-01-01T00:00:00.000Z',
      session_id: 'sess-1',
      task_id: 'task-1',
    });
    expect(entry.expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(entry.session_id).toBe('sess-1');
    expect(entry.task_id).toBe('task-1');
  });
});

describe('isActive', () => {
  const base = createMemoryEntry({
    kind: 'fact',
    source: 'user',
    scope: 'project',
    key: 'k',
    content: 'c',
    workspace: '/repo',
  });

  it('普通 entry 有效', () => {
    expect(isActive(base)).toBe(true);
  });

  it('被 supersede 的 entry 无效', () => {
    expect(isActive({ ...base, superseded_by: 'new-id' })).toBe(false);
  });

  it('已过期 entry 无效', () => {
    const expired = {
      ...base,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    expect(isActive(expired)).toBe(false);
  });

  it('未来过期的 entry 仍有效', () => {
    const future = {
      ...base,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(isActive(future)).toBe(true);
  });

  it('可用指定 now 判定', () => {
    const entry = { ...base, expires_at: '2026-01-01T00:00:00.000Z' };
    expect(isActive(entry, new Date('2025-12-31T23:59:59.000Z'))).toBe(true);
    expect(isActive(entry, new Date('2026-01-01T00:00:01.000Z'))).toBe(false);
  });
});

describe('scopeFieldsConsistent', () => {
  it('project scope 不允许 task_id', () => {
    expect(scopeFieldsConsistent({ scope: 'project' })).toBe(true);
    expect(scopeFieldsConsistent({ scope: 'project', session_id: 's' })).toBe(true);
    expect(scopeFieldsConsistent({ scope: 'project', task_id: 't' })).toBe(false);
  });

  it('session scope 必须有 session_id 且无 task_id', () => {
    expect(scopeFieldsConsistent({ scope: 'session', session_id: 's' })).toBe(true);
    expect(scopeFieldsConsistent({ scope: 'session' })).toBe(false);
    expect(scopeFieldsConsistent({ scope: 'session', session_id: 's', task_id: 't' })).toBe(false);
  });

  it('task scope 必须同时有 session_id 与 task_id', () => {
    expect(scopeFieldsConsistent({ scope: 'task', session_id: 's', task_id: 't' })).toBe(true);
    expect(scopeFieldsConsistent({ scope: 'task', task_id: 't' })).toBe(false);
    expect(scopeFieldsConsistent({ scope: 'task', session_id: 's' })).toBe(false);
  });
});
