import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { CodeExecutionSessionManager } from '../src/execution/code-session.js';

const manager = new CodeExecutionSessionManager();

afterEach(() => {
  manager.closeAll();
});

describe('CodeExecutionSessionManager', () => {
  it('keeps JavaScript state between calls and isolates agent sessions', async () => {
    const first = await manager.execute({ sessionId: 'agent-a', language: 'javascript', code: 'globalThis.counter = (globalThis.counter || 0) + 1; globalThis.counter', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 4_000 });
    const second = await manager.execute({ sessionId: 'agent-a', language: 'javascript', code: 'globalThis.counter += 1; globalThis.counter', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 4_000 });
    const isolated = await manager.execute({ sessionId: 'agent-b', language: 'javascript', code: 'globalThis.counter = (globalThis.counter || 0) + 1; globalThis.counter', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 4_000 });

    expect(first.result).toBe('1');
    expect(second.result).toBe('2');
    expect(isolated.result).toBe('1');
  });

  it('retains a JavaScript session after a runtime exception', async () => {
    const failed = await manager.execute({ sessionId: 'agent-error', language: 'javascript', code: 'throw new Error("cell failed")', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 4_000 });
    expect(failed.error?.message).toBe('cell failed');
    const result = await manager.execute({ sessionId: 'agent-error', language: 'javascript', code: '40 + 2', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 4_000 });
    expect(result.result).toBe('42');
  });

  it('returns structured stdout and stderr for a successful cell', async () => {
    const result = await manager.execute({ sessionId: 'agent-output', language: 'javascript', code: 'console.log("hello"); console.error("warning"); 42', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 4_000 });
    expect(result).toMatchObject({ stdout: 'hello\n', stderr: 'warning\n', result: '42', error: null });
  });

  it('supports asynchronous JavaScript expressions', async () => {
    const result = await manager.execute({ sessionId: 'agent-async', language: 'javascript', code: 'await Promise.resolve(42)', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 4_000 });
    expect(result.result).toBe('42');
    expect(result.error).toBeNull();
  });

  it('kills and removes a JavaScript session that exceeds its timeout', async () => {
    await expect(manager.execute({ sessionId: 'agent-timeout', language: 'javascript', code: 'new Promise(() => {})', cwd: process.cwd(), env: process.env, timeoutMs: 150, maxOutputBytes: 4_000 })).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' });
    expect(manager.hasSession('agent-timeout', 'javascript')).toBe(false);
  });

  it('kills a running session when its abort signal fires', async () => {
    const controller = new AbortController();
    const pending = manager.execute({ sessionId: 'agent-cancel', language: 'javascript', code: 'new Promise(() => {})', cwd: process.cwd(), env: process.env, signal: controller.signal, timeoutMs: 5_000, maxOutputBytes: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(manager.hasSession('agent-cancel', 'javascript')).toBe(false);
  });

  it('kills a session that exceeds the output limit', async () => {
    await expect(manager.execute({ sessionId: 'agent-large-output', language: 'javascript', code: '"x".repeat(5000)', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 256 }))
      .rejects.toThrow(/输出超过/);
    expect(manager.hasSession('agent-large-output', 'javascript')).toBe(false);
  });

  it('caps captured stdout before returning a protocol response', async () => {
    await expect(manager.execute({ sessionId: 'agent-large-stdout', language: 'javascript', code: 'console.log("x".repeat(5000)); 1', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 256 }))
      .rejects.toThrow(/输出超过/);
    expect(manager.hasSession('agent-large-stdout', 'javascript')).toBe(false);
  });

  it('persists Python variables when an interpreter is available', async (context) => {
    const probe = spawnSync('python', ['--version'], { stdio: 'ignore', windowsHide: true });
    if (probe.error || probe.status !== 0) context.skip();
    const first = await manager.execute({ sessionId: 'python-agent', language: 'python', code: 'counter = 40\ncounter', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 4_000 });
    const second = await manager.execute({ sessionId: 'python-agent', language: 'python', code: 'counter += 2\ncounter', cwd: process.cwd(), env: process.env, timeoutMs: 5_000, maxOutputBytes: 4_000 });
    expect(first.result).toBe(40);
    expect(second.result).toBe(42);
  });
});
