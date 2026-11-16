import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type AgentEvent, type ToolContext } from '@forgex/shared';
import { createProvider } from '@forgex/models';
import { ApprovalManager, AuditLogger, WorkspaceGuard, createDefaultPolicySettings } from '@forgex/security';
import { SessionStore } from '@forgex/core';
import { SubagentManager } from '../src/runtime/subagent-manager.js';
import type { ResolvedConfig } from '../src/config/load-config.js';

interface FakeModel {
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}

let root: string;
let store: SessionStore;
let manager: SubagentManager;
let fake: FakeModel;
let parentContext: ToolContext;
let parentController: AbortController;

async function startFakeModel(responder: (index: number, prompt: string) => Promise<{ status?: number; content?: string }>): Promise<FakeModel> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      void (async () => {
        const body = JSON.parse(raw || '{}') as { messages?: Array<{ content?: string }> };
        const prompt = body.messages?.map((message) => message.content ?? '').join('\n') ?? '';
        requests.push(prompt);
        const reply = await responder(requests.length - 1, prompt);
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.status && reply.status >= 400
          ? { error: { message: 'temporary model failure' } }
          : { choices: [{ message: { role: 'assistant', content: reply.content ?? 'worker complete' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function git(args: string[]): void {
  execFileSync('git.exe', args, { cwd: root, stdio: 'ignore' });
}

function createManager(onEvent?: (event: AgentEvent) => void): SubagentManager {
  const settings = createDefaultPolicySettings({ workspaceRoots: [root], mode: 'standard', requireApprovalForWrite: false, requireApprovalForExecute: false });
  const workspace = new WorkspaceGuard({ roots: settings.workspaceRoots, writableRoots: settings.writableRoots, protectedPaths: settings.protectedPaths });
  const provider = createProvider({ baseUrl: fake.baseUrl, model: 'worker-model', contextWindow: 8192, maxOutputTokens: 1024, temperature: 0, timeoutMs: 5000, maxRetries: 0, stream: false });
  const config = {
    session: { dbPath: join(root, '.forgex', 'events.jsonl') },
    agent: { maxConcurrency: 2, subagentMaxConcurrency: 2 },
    tools: { languageServers: [] },
  } as unknown as ResolvedConfig;
  return new SubagentManager({
    config, settings, getProvider: () => provider,
    approvals: new ApprovalManager({ handler: () => true, timeoutMs: 1000 }),
    audit: new AuditLogger({ sinks: [store] }), store,
    logger: createLogger({ level: 'error' }),
    ...(onEvent ? { onEvent } : {}),
  });
}

function input(names: string[]) {
  return { context: 'shared', tasks: names.map((name) => ({ name, task: `run ${name}` })) };
}

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for worker state: ${JSON.stringify(manager?.listWorkers('parent-one'))}`));
      setTimeout(check, 15);
    };
    check();
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forgex-worker-manager-'));
  await mkdir(join(root, '.forgex'), { recursive: true });
  await writeFile(join(root, 'tracked.txt'), 'baseline\n', 'utf8');
  git(['init', '--quiet']);
  git(['config', 'user.name', 'ForgeX test']);
  git(['config', 'user.email', 'forgex-test@localhost']);
  git(['add', '.']);
  git(['commit', '-m', 'baseline', '--quiet']);
  store = new SessionStore(join(root, '.forgex', 'events.jsonl'));
  fake = await startFakeModel(async () => ({ content: 'worker complete' }));
  manager = createManager();
  const settings = createDefaultPolicySettings({ workspaceRoots: [root], mode: 'standard' });
  const workspace = new WorkspaceGuard({ roots: settings.workspaceRoots, writableRoots: settings.writableRoots, protectedPaths: settings.protectedPaths });
  parentController = new AbortController();
  parentContext = {
    sessionId: 'parent-one', workspaceRoot: root, cwd: root, signal: parentController.signal,
    auditId: 'audit-parent', workspace, policy: settings,
  };
});

afterEach(async () => {
  await manager?.close();
  await fake?.close();
  store?.close();
  await rm(root, { recursive: true, force: true });
});

describe('SubagentManager worker lifecycle', () => {
  it('streams progress and final resource usage', async () => {
    const events: string[] = [];
    manager = createManager((event) => events.push(event.type));
    const batch = manager.runBatch(input(['alpha']), parentContext);
    await waitFor(() => manager.listWorkers('parent-one').some((worker) => worker.status === 'running'));
    const worker = manager.listWorkers('parent-one')[0]!;
    expect(worker.transcript).toBeUndefined();
    await batch;

    const finished = manager.getWorker('parent-one', worker.id);
    expect(finished).toMatchObject({ status: 'completed', usage: { modelCalls: 1, totalTokens: 13 }, summary: expect.stringContaining('worker complete') });
    expect(finished.transcript.some((message) => message.content?.includes('run alpha'))).toBe(true);
    expect(events).toContain('worker:state');
    expect(events).toContain('worker:progress');
    expect(store.getWorkerEvents('parent-one', worker.id).some((event) => event.type === 'subagent.worker.progress')).toBe(true);
  });

  it('routes steering only to the addressed worker', async () => {
    fake = await replaceFakeModel(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { content: 'worker complete' };
    });
    manager = createManager();
    const batch = manager.runBatch(input(['alpha', 'beta']), parentContext);
    await waitFor(() => manager.listWorkers('parent-one').filter((worker) => worker.status === 'running').length === 2);
    const workers = manager.listWorkers('parent-one');
    const alpha = workers.find((worker) => worker.name === 'alpha')!;
    const beta = workers.find((worker) => worker.name === 'beta')!;
    manager.steerWorker('parent-one', alpha.id, 'only-alpha-steer');
    await batch;

    expect(manager.getWorker('parent-one', alpha.id).transcript.some((message) => message.content === 'only-alpha-steer')).toBe(true);
    expect(manager.getWorker('parent-one', beta.id).transcript.some((message) => message.content === 'only-alpha-steer')).toBe(false);
  });

  it('cancels worker and removes its active worktree', async () => {
    fake = await replaceFakeModel(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { content: 'late result' };
    });
    manager = createManager();
    const batch = manager.runBatch(input(['slow']), parentContext);
    await waitFor(() => manager.listWorkers('parent-one').some((worker) => worker.status === 'running'));
    const worker = manager.listWorkers('parent-one')[0]!;
    expect(manager.cancelWorker('parent-one', worker.id)).toBe(true);
    await manager.waitWorker('parent-one', worker.id);
    await batch;

    expect(manager.getWorker('parent-one', worker.id).status).toBe('cancelled');
    const worktrees = execFileSync('git.exe', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
    expect(worktrees.trim().split(/\r?\n/).filter((line) => line.startsWith('worktree '))).toHaveLength(1);
  });

  it('cancels process-local workers when the runtime closes', async () => {
    fake = await replaceFakeModel(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { content: 'late result' };
    });
    manager = createManager();
    const batch = manager.runBatch(input(['closing']), parentContext);
    await waitFor(() => manager.listWorkers('parent-one').some((worker) => worker.status === 'running'));
    const worker = manager.listWorkers('parent-one')[0]!;
    await manager.close();

    expect(manager.getWorker('parent-one', worker.id).status).toBe('cancelled');
    const worktrees = execFileSync('git.exe', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
    expect(worktrees.trim().split(/\r?\n/).filter((line) => line.startsWith('worktree '))).toHaveLength(1);
    await batch;
  });

  it('cancels workers when the parent task is interrupted', async () => {
    fake = await replaceFakeModel(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { content: 'late result' };
    });
    manager = createManager();
    const batch = manager.runBatch(input(['parent-cancelled']), parentContext);
    await waitFor(() => manager.listWorkers('parent-one').some((worker) => worker.status === 'running'));
    parentController.abort();
    await batch;

    expect(manager.listWorkers('parent-one')[0]?.status).toBe('cancelled');
  });

  it('rejects controls from a different parent session', async () => {
    const batch = manager.runBatch(input(['owned']), parentContext);
    await waitFor(() => manager.listWorkers('parent-one').length === 1);
    const worker = manager.listWorkers('parent-one')[0]!;
    expect(manager.listWorkers('other-parent')).toEqual([]);
    expect(() => manager.getWorker('other-parent', worker.id)).toThrow();
    expect(() => manager.steerWorker('other-parent', worker.id, 'not mine')).toThrow();
    await batch;
  });

  it('does not let a completed old worker overwrite retried state', async () => {
    let calls = 0;
    fake = await replaceFakeModel(async () => {
      calls += 1;
      return calls === 1 ? { status: 503 } : { content: 'retry completed' };
    });
    manager = createManager();
    await manager.runBatch(input(['retryable']), parentContext);
    const first = manager.listWorkers('parent-one')[0]!;
    expect(first.status).toBe('failed');

    await manager.retryWorker('parent-one', first.id);
    const retried = await manager.waitWorker('parent-one', first.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(retried).toMatchObject({ id: first.id, attempt: 2, status: 'completed', summary: expect.stringContaining('retry completed') });
    expect(manager.getWorker('parent-one', first.id).attempt).toBe(2);
  });
});

async function replaceFakeModel(responder: (index: number, prompt: string) => Promise<{ status?: number; content?: string }>): Promise<FakeModel> {
  await fake.close();
  return startFakeModel(responder);
}

