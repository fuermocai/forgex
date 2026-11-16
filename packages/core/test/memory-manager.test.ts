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
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  const rememberTestUserFact = (input: Parameters<MemoryManager['rememberUserFact']>[0]) =>
    manager.rememberUserFact({ ...input, evidence_refs: input.evidence_refs ?? ['test:user-fact'] });

  it('remember 写入合法记忆并可 recall', () => {
    const result = manager.remember({
      kind: 'fact',
      source: 'user',
      scope: 'project',
      key: 'build.command',
      content: 'pnpm build && pnpm test',
      workspace: WS,
      tags: ['build'],
      evidence_refs: ['user:build-command'],
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
        evidence_refs: ['tool:test'],
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
      evidence_refs: ['user:forget'],
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
    rememberTestUserFact({
      scope: 'project',
      key: 'prod.branch',
      content: 'main',
      workspace: WS,
      confidence: 1.0,
    });
    const update = rememberTestUserFact({
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
    rememberTestUserFact({
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
      evidence_refs: ['tool:conflict-test'],
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
      evidence_refs: ['user:project-level'],
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

  it('lists and searches only the selected workspace', () => {
    rememberTestUserFact({ scope: 'project', key: 'build.command', content: 'pnpm build', workspace: WS });
    rememberTestUserFact({ scope: 'project', key: 'build.command', content: 'npm run build', workspace: '/repo/other' });

    expect(manager.list(WS).map((entry) => entry.content)).toEqual(['pnpm build']);
    expect(manager.search(WS, 'pnpm').map((hit) => hit.entry.content)).toEqual(['pnpm build']);
    expect(manager.search(WS, 'yarn')).toEqual([]);
  });

  it('updates by superseding the previous entry', () => {
    const first = rememberTestUserFact({ scope: 'project', key: 'deploy.branch', content: 'main', workspace: WS }).entry;

    expect(() => manager.update(first.id, { content: 'release' })).toThrow(/新的证据引用/);
    const updated = manager.update(first.id, { content: 'release', evidence_refs: ['user:release-correction'] });

    expect(updated.entry.id).not.toBe(first.id);
    expect(manager.get(first.id)?.superseded_by).toBe(updated.entry.id);
    expect(manager.list(WS).find((entry) => entry.key === 'deploy.branch')?.content).toBe('release');
  });

  it('exports project memory history as JSON', () => {
    const first = rememberTestUserFact({ scope: 'project', key: 'tooling.package-manager', content: 'npm', workspace: WS }).entry;
    manager.update(first.id, { content: 'pnpm', evidence_refs: ['user:package-manager-correction'] });

    const exported = JSON.parse(manager.exportProject(WS)) as { workspace: string; entries: Array<{ content: string; superseded_by?: string }> };

    expect(exported.workspace).toBe(WS);
    expect(exported.entries).toHaveLength(2);
    expect(exported.entries.find((entry) => entry.content === 'npm')?.superseded_by).toBeDefined();
  });

  it('recovers after a corrupted final JSONL line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-memory-recover-'));
    const dbPath = join(dir, 'memory.jsonl');
    try {
      const initial = createMemoryManager(dbPath);
      initial.rememberUserFact({ scope: 'project', key: 'build.command', content: 'pnpm test', workspace: WS, evidence_refs: ['user:test-command'] });
      initial.close();
      const corruptRecord = '{"password":"supersecretvalue"} trailing-invalid-record';
      await appendFile(dbPath, corruptRecord, 'utf8');

      const recovered = createMemoryManager(dbPath);
      expect(recovered.list(WS).map((entry) => entry.content)).toEqual(['pnpm test']);
      recovered.close();
      const quarantined = await readFile(`${dbPath}.corrupt`, 'utf8');
      expect(quarantined).toContain('sha256=');
      expect(quarantined).not.toContain('supersecretvalue');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
