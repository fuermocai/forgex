import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/session-store.js';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgex-jsonl-'));
  dirs.push(dir);
  return dir;
}

describe('JSONL session event store', () => {
  it('forks from a message event without altering the parent history', () => {
    const store = new SessionStore(':memory:');
    const session = store.createSession({ workspace: 'repo', model: 'model' });
    store.appendMessage(session.id, { role: 'user', content: 'first' });
    store.appendMessage(session.id, { role: 'assistant', content: 'answer' });
    const forkPoint = store.listMessageEntries(session.id)[0]!.id;

    const branch = store.forkSession(session.id, forkPoint);
    expect(branch.parentSessionId).toBe(session.id);
    expect(branch.parentMessageId).toBe(forkPoint);
    expect(store.getMessages(branch.id).map((message) => message.content)).toEqual(['first']);
    expect(store.getMessages(session.id).map((message) => message.content)).toEqual(['first', 'answer']);
    expect(store.readEvents().filter((event) => event.type === 'message.appended').every((event) => event.parentId !== null)).toBe(true);
  });

  it('不同 store 实例追加到同一日志后可立即读到对方的事件', () => {
    const path = join(tempDir(), 'events.jsonl');
    const first = new SessionStore(path);
    const second = new SessionStore(path);
    const a = first.createSession({ workspace: 'repo', model: 'm' });
    const b = second.createSession({ workspace: 'repo', model: 'm' });
    second.appendMessage(b.id, { role: 'user', content: 'from second' });

    expect(first.listSessions()).toHaveLength(2);
    expect(first.getMessages(b.id)).toEqual([{ role: 'user', content: 'from second' }]);
    expect(second.getMessages(a.id)).toEqual([]);
  });

  it('reopens an append-only event log without losing messages or parent links', () => {
    const dir = tempDir();
    const path = join(dir, 'events.jsonl');
    const store = new SessionStore(path);
    const session = store.createSession({ workspace: 'repo', model: 'm', title: 'persisted' });
    store.appendMessage(session.id, { role: 'user', content: 'hello' });
    const reopened = new SessionStore(path);
    expect(reopened.getSession(session.id)?.title).toBe('persisted');
    expect(reopened.getMessages(session.id)).toEqual([{ role: 'user', content: 'hello' }]);
    expect(reopened.readEvents().every((event) => event.id.length > 0 && typeof event.ts === 'string')).toBe(true);
  });

  it('fails closed on malformed JSONL instead of silently dropping corrupted events', () => {
    const dir = tempDir();
    const path = join(dir, 'events.jsonl');
    writeFileSync(path, '{broken\n', 'utf8');
    expect(() => new SessionStore(path)).toThrow(/损坏/);
    expect(readFileSync(path, 'utf8')).toBe('{broken\n');
  });

  it('does not rewrite a malformed log when opening fails', () => {
    const dir = tempDir();
    const path = join(dir, 'events.jsonl');
    writeFileSync(path, '{broken\n', 'utf8');
    expect(() => new SessionStore(path)).toThrow(/损坏/);
    expect(readFileSync(path, 'utf8')).toBe('{broken\n');
  });
});
