import { describe, expect, it, vi } from 'vitest';
import { dispatchWorkerHubCommand, isWorkerHubCommand } from '../src/runtime/worker-hub.js';
import type { WorkerSnapshot } from '../src/runtime/subagent-manager.js';

const worker: WorkerSnapshot = {
  id: 'worker-1', batchId: 'batch-1', parentSessionId: 'parent-1', name: 'inspect', attempt: 1,
  status: 'running', progress: 'reading files', summary: 'Inspecting the codebase',
  createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:01.000Z',
  changedPaths: [], usage: { modelCalls: 1, totalTokens: 42, toolCalls: 0, iterations: 1, durationMs: 20 },
  transcript: [{ role: 'user', content: 'inspect this' }],
};

function runtime() {
  return {
    agent: { sessionId: 'parent-1' },
    workers: {
      listWorkers: vi.fn(() => [worker]),
      getWorker: vi.fn(() => worker),
      steerWorker: vi.fn(() => 'queue-1'),
      cancelWorker: vi.fn(() => true),
      retryWorker: vi.fn(async () => ({ ...worker, id: 'worker-2', attempt: 2 })),
      waitWorker: vi.fn(async () => ({ ...worker, status: 'completed' as const })),
    },
  } as never;
}

describe('Agent Hub commands', () => {
  it('routes hub commands while parent delegate call is pending', async () => {
    const rt = runtime();
    let finishParent!: () => void;
    let parentFinished = false;
    const parentDelegate = new Promise<void>((resolve) => { finishParent = resolve; }).then(() => { parentFinished = true; });

    const response = await dispatchWorkerHubCommand(rt, '/steer worker-1 check authentication');

    expect(response).toContain('queue-1');
    expect(rt.workers.steerWorker).toHaveBeenCalledWith('parent-1', 'worker-1', 'check authentication');
    expect(parentFinished).toBe(false);
    finishParent();
    await parentDelegate;
  });

  it('prints worker transcript only on request', async () => {
    const rt = runtime();

    expect(isWorkerHubCommand('/workers')).toBe(true);
    const list = await dispatchWorkerHubCommand(rt, '/workers');
    const detail = await dispatchWorkerHubCommand(rt, '/worker worker-1');
    const transcript = await dispatchWorkerHubCommand(rt, '/worker worker-1 transcript');

    expect(list).not.toContain('inspect this');
    expect(detail).not.toContain('inspect this');
    expect(transcript).toContain('inspect this');
    expect(rt.workers.getWorker).toHaveBeenNthCalledWith(1, 'parent-1', 'worker-1', false);
    expect(rt.workers.getWorker).toHaveBeenNthCalledWith(2, 'parent-1', 'worker-1', true);
  });
});
