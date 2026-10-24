/**
 * MemoryManager 单元测试（v0.3.0 Phase 4）。
 *
 * 覆盖：
 *   - remember 全链路：校验 + 合并 + 入库
 *   - 敏感内容与非法输入被 API 层拒绝
 *   - recall / get / count / forget
 *   - rememberUserFact 绕过 conflict
 *   - purgeSession 只清理 session/task 级记忆
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MemoryManager, createMemoryManager } from '../src/memory/memory-manager.js';

const WS = '/repo/test';

describe('MemoryManager', () => {
  let manager: MemoryManager;

  beforeEach(() => {
    manager = createMemoryManager(':memory:');
  });

  afterEach(() => {
    manager.close();
  });

  it('remember 写入合法记忆并可 recall', () => {
    const result = manager.remember({
      kind: 'fact',
      source: 'user',
      scope: 'project',
      key: 'build.command',
      content: 'pnpm build && pnpm test',
      workspace: WS,
      tags: ['build'],
    });
    expect(result.conflict).toBe(false);

    const hits = manager.recall({ workspace: WS, text: 'pnpm build' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.key).toBe('build.command');
  });

  it('敏感内容在 API 层被拒绝', () => {
    let code = '';
    try {
      manager.remember({
        kind: 'fact',
        source: 'agent',
        scope: 'project',
        key: 'db.config',
        content: 'password= supersecret123',
        workspace: WS,
      });
    } catch (err) {
      code = (err as { code?: string }).code ?? '';
    }
    expect(code).toBe('MEMORY_SENSITIVE_CONTENT');
    expect(manager.count(WS)).toBe(0);
  });

  it('非法 key 在 API 层被拒绝', () => {
    let code = '';
    try {
      manager.remember({
        kind: 'fact',
        source: 'agent',
        scope: 'project',
        key: 'BAD KEY',
        content: 'x',
        workspace: WS,
      });
    } catch (err) {
      code = (err as { code?: string }).code ?? '';
    }
    expect(code).toBe('MEMORY_INVALID');
  });

  it('forget 软删除后 recall 不再返回', () => {
    const { entry } = manager.remember({
      kind: 'fact',
      source: 'user',
      scope: 'project',
      key: 'k',
      content: 'to be forgotten',
      workspace: WS,
    });
    expect(manager.forget(entry.id)).toBe(true);
    expect(manager.forget(entry.id)).toBe(false); // 幂等
    expect(manager.recall({ workspace: WS })).toHaveLength(0);
    // 历史版本仍可 get（审计）
    expect(manager.get(entry.id)!.superseded_by).toBe(entry.id);
  });

  it('forget 不存在的 id 返回 false', () => {
    expect(manager.forget('ghost')).toBe(false);
  });

  it('rememberUserFact 绕过 conflict 直接覆盖', () => {
    manager.rememberUserFact({
      scope: 'project',
      key: 'prod.branch',
      content: 'main',
      workspace: WS,
      confidence: 1.0,
    });
    const update = manager.rememberUserFact({
      scope: 'project',
      key: 'prod.branch',
      content: 'trunk',
      workspace: WS,
      confidence: 1.0,
    });
    expect(update.conflict).toBe(false);
    const current = manager.recall({ workspace: WS, text: 'trunk' });
    expect(current[0]!.entry.content).toBe('trunk');
  });

  it('agent 来源写入与 user 冲突时 conflict=true', () => {
    manager.rememberUserFact({
      scope: 'project',
      key: 'prod.branch',
      content: 'main',
      workspace: WS,
      confidence: 1.0,
    });
    const attempt = manager.remember({
      kind: 'fact',
      source: 'agent',
      scope: 'project',
      key: 'prod.branch',
      content: 'master',
      workspace: WS,
      confidence: 0.6,
    });
    expect(attempt.conflict).toBe(true);
    expect(manager.count(WS)).toBe(1);
  });

  it('purgeSession 清理 session/task 级记忆，保留 project 级', () => {
    manager.remember({
      kind: 'fact',
      source: 'user',
      scope: 'project',
      key: 'keep',
      content: 'project level',
      workspace: WS,
    });
    manager.remember({
      kind: 'fact',
      source: 'agent',
      scope: 'session',
      key: 'sess-note',
      content: 'session level',
      workspace: WS,
      session_id: 's1',
    });
    manager.remember({
      kind: 'hypothesis',
      source: 'agent',
      scope: 'task',
      key: 'task-note',
      content: 'task level',
      workspace: WS,
      session_id: 's1',
      task_id: 't1',
    });

    const purged = manager.purgeSession('s1', WS);
    expect(purged).toBe(2);
    expect(manager.count(WS)).toBe(1);

    const remaining = manager.recall({ workspace: WS });
    expect(remaining[0]!.entry.key).toBe('keep');
  });

  it('createMemoryManager 拒绝空 dbPath', () => {
    let code = '';
    try {
      createMemoryManager('');
    } catch (err) {
      code = (err as { code?: string }).code ?? '';
    }
    expect(code).toBe('MEMORY_INVALID');
  });
});
