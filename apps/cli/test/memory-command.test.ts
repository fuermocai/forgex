import { describe, expect, it } from 'vitest';
import { createMemoryManager } from '@forgex/core';
import { dispatchMemoryCommand, isMemoryCommand } from '../src/runtime/memory-command.js';

const workspace = '/repo/memory-command-test';

function runtime(memory = createMemoryManager(':memory:')) {
  return {
    memory,
    settings: { workspaceRoots: [workspace] },
    agent: { sessionId: 'session-memory-command' },
  } as never;
}

describe('/memory commands', () => {
  it('lists, searches, shows, and exports the current workspace only', async () => {
    const memory = createMemoryManager(':memory:');
    memory.rememberUserFact({ scope: 'project', key: 'build.command', content: 'pnpm test', workspace, evidence_refs: ['user:build'] });
    memory.rememberUserFact({ scope: 'project', key: 'build.command', content: 'yarn test', workspace: '/repo/other', evidence_refs: ['user:other'] });
    memory.propose({
      kind: 'fact', source: 'user', scope: 'project', key: 'other.candidate',
      content: 'foreign candidate', workspace: '/repo/other', evidence_refs: ['user:1'],
    }, 'foreign-session');
    const rt = runtime(memory);
    try {
      expect(isMemoryCommand('/memory list')).toBe(true);
      expect(await dispatchMemoryCommand(rt, '/memory list')).toContain('pnpm test');
      expect(await dispatchMemoryCommand(rt, '/memory search pnpm')).toContain('pnpm test');
      const id = memory.list(workspace)[0]!.id;
      expect(await dispatchMemoryCommand(rt, `/memory show ${id}`)).toContain('来源：user');
      expect(await dispatchMemoryCommand(rt, `/memory show ${memory.list('/repo/other')[0]!.id}`)).toContain('找不到');
      expect(await dispatchMemoryCommand(rt, '/memory candidates')).not.toContain('foreign candidate');
      const exported = await dispatchMemoryCommand(rt, '/memory export');
      expect(exported).toContain('"workspace"');
      expect(exported).not.toContain('yarn test');
    } finally {
      memory.close();
    }
  });

  it('edits with superseding history and manages pending candidates', async () => {
    const memory = createMemoryManager(':memory:');
    const first = memory.rememberUserFact({ scope: 'project', key: 'deploy.branch', content: 'main', workspace, evidence_refs: ['user:branch'] }).entry;
    const candidate = memory.propose({
      kind: 'fact', source: 'user', scope: 'project', key: 'project.note.test',
      content: 'Run tests first', workspace, evidence_refs: ['user:1'],
    }, 'session-1');
    const rt = runtime(memory);
    try {
      expect(await dispatchMemoryCommand(rt, '/memory candidates')).toContain(candidate.id);
      expect(await dispatchMemoryCommand(rt, `/memory approve ${candidate.id}`)).toContain('已批准');
      expect(await dispatchMemoryCommand(rt, `/memory edit ${first.id} release`)).toContain('已更新');
      expect(memory.get(first.id)?.superseded_by).toBeDefined();
      expect(await dispatchMemoryCommand(rt, `/memory forget ${memory.list(workspace)[0]!.id}`)).toContain('已作废');
      expect(await dispatchMemoryCommand(rt, `/memory reject ${candidate.id}`)).toContain('待审核');
    } finally {
      memory.close();
    }
  });

  it('requires an explicit confirmation to clear only active entries in this workspace', async () => {
    const memory = createMemoryManager(':memory:');
    const own = memory.rememberUserFact({ scope: 'project', key: 'clear.own', content: 'own fact', workspace, evidence_refs: ['user:own'] }).entry;
    const foreign = memory.rememberUserFact({ scope: 'project', key: 'clear.foreign', content: 'foreign fact', workspace: '/repo/other', evidence_refs: ['user:foreign'] }).entry;
    const rt = runtime(memory);
    try {
      expect(await dispatchMemoryCommand(rt, '/memory clear')).toContain('确认');
      expect(memory.list(workspace)).toHaveLength(1);
      expect(await dispatchMemoryCommand(rt, '/memory clear confirm')).toContain('1 条');
      expect(memory.list(workspace)).toEqual([]);
      expect(memory.get(own.id)?.superseded_by).toBe(own.id);
      expect(memory.get(foreign.id)?.superseded_by).toBeUndefined();
    } finally {
      memory.close();
    }
  });
});
