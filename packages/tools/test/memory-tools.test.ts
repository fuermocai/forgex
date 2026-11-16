import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@forgex/shared';
import { createMemoryTools } from '../src/memory/memory-tools.js';

function service() {
  return {
    search: vi.fn(() => []),
    propose: vi.fn(() => ({
      id: 'candidate-1', session_id: 'session-a', status: 'pending',
      input: { key: 'build', content: 'pnpm test', kind: 'fact', source: 'agent' },
    })),
    update: vi.fn(() => ({ conflict: false, entry: { id: 'updated', workspace: '/repo/a' } })),
    forget: vi.fn(() => true),
    get: vi.fn((id: string) => ({
      id, workspace: '/repo/a', key: 'build.command', content: 'old value', kind: 'fact', source: 'user', scope: 'project',
      tags: [], confidence: 1, updated_at: '2026-11-12T00:00:00.000Z', evidence_refs: ['user:1'],
    })),
  };
}

const context = { workspaceRoot: '/repo/a', sessionId: 'session-a' } as ToolContext;

describe('memory tools', () => {
  it('requires explicit approval before durable writes', () => {
    const tools = createMemoryTools(service());

    for (const name of ['memory_propose', 'memory_update', 'memory_forget']) {
      expect(tools.find((tool) => tool.name === name)?.alwaysRequireApproval).toBe(true);
      expect(tools.find((tool) => tool.name === name)?.riskLevel).toBe('write');
    }
    expect(tools.find((tool) => tool.name === 'memory_search')?.riskLevel).toBe('read');
  });

  it('scopes searches and updates to the current workspace', async () => {
    const memory = service();
    const tools = createMemoryTools(memory);
    const search = tools.find((tool) => tool.name === 'memory_search')!;
    await search.execute({ text: 'build' }, context);
    expect(memory.search).toHaveBeenCalledWith('/repo/a', 'build', expect.any(Object));

    memory.get.mockReturnValueOnce({ id: 'foreign', workspace: '/repo/b' });
    const update = tools.find((tool) => tool.name === 'memory_update')!;
    const outcome = await update.execute({ id: 'foreign', content: 'overwrite' }, context);
    expect(outcome.ok).toBe(false);
    expect(memory.update).not.toHaveBeenCalled();
  });

  it('creates a pending candidate instead of writing an active memory', async () => {
    const memory = service();
    const propose = createMemoryTools(memory).find((tool) => tool.name === 'memory_propose')!;
    const result = await propose.execute({ key: 'build', content: 'pnpm test', evidence_refs: ['session:1'] }, context);
    expect(memory.propose).toHaveBeenCalledWith(expect.objectContaining({ key: 'build' }), 'session-a');
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('待审核');
  });

  it('shows complete, reviewable previews for every durable memory mutation', () => {
    const tools = createMemoryTools(service());
    const cases = [
      ['memory_propose', { key: 'build.command', content: 'new value', evidence_refs: ['session:1'] }, ['new value', '/repo/a']],
      ['memory_update', { id: 'entry-1', content: 'new value', evidence_refs: ['session:1:message:2'] }, ['entry-1', 'old value', 'new value', '/repo/a']],
      ['memory_forget', { id: 'entry-1' }, ['entry-1', 'old value', '/repo/a']],
    ] as const;

    for (const [name, input, fragments] of cases) {
      const tool = tools.find((item) => item.name === name)!;
      expect(tool.requireCompleteApprovalPreview).toBe(true);
      expect(tool.maxApprovalPreviewChars).toBeGreaterThan(0);
      const preview = tool.getApprovalPreview?.(input, context) ?? '';
      for (const fragment of fragments) expect(preview).toContain(fragment);
    }
  });
});
