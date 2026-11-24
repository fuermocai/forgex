import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Agent, SessionStore, type ForgeExtension } from '@forgex/core';
import type { AgentEvent, ChatMessage, Logger, PolicySettings, ToolContext, WorkerUsage } from '@forgex/shared';
import { uuid } from '@forgex/shared';
import type { ModelProvider } from '@forgex/models';
import type { RunCommandToolOptions } from '@forgex/tools';
import {
  ApprovalManager,
  AuditLogger,
  WorkspaceGuard,
} from '@forgex/security';
import {
  createBuiltinTools,
  ToolRegistry,
  type DelegateTaskBatchResult,
  type DelegateTaskExecutor,
  type DelegateTaskInput,
  type DelegateTaskResult,
} from '@forgex/tools';
import type { ResolvedConfig } from '../config/load-config.js';
import {
  captureSubagentChanges,
  cleanupSubagentSnapshot,
  cleanupSubagentWorktree,
  createSubagentSnapshot,
  createSubagentWorktree,
  type SubagentWorktree,
} from '../task-run/subagent-worktree.js';

const PATCH_PREVIEW_CHARS = 4_000;
const SUMMARY_CHARS = 4_000;

export interface SubagentManagerOptions {
  config: ResolvedConfig;
  settings: PolicySettings;
  getProvider: () => ModelProvider;
  approvals: ApprovalManager;
  audit: AuditLogger;
  store: SessionStore;
  logger: Logger;
  onEvent?: (event: AgentEvent) => void;
  extensions?: ReadonlyArray<ForgeExtension>;
  createIsolatedExecutor?: (workspaceRoot: string, protectedPaths?: PolicySettings['protectedPaths']) => RunCommandToolOptions['executeIsolated'];
}

export type WorkerStatus = 'queued' | 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface WorkerSnapshot {
  id: string;
  batchId: string;
  parentSessionId: string;
  name: string;
  attempt: number;
  status: WorkerStatus;
  progress: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  changedPaths: string[];
  artifactPath?: string;
  worktreePath?: string;
  cleanupWarning?: string;
  usage?: WorkerUsage;
  transcript?: ChatMessage[];
}

interface ManagedWorker extends Omit<WorkerSnapshot, 'transcript'> {
  task: DelegateTaskInput['tasks'][number];
  sharedContext: string;
  parentContext: ToolContext;
  controller: AbortController;
  completion: Promise<void>;
  resolveCompletion: () => void;
  promise?: Promise<DelegateTaskResult>;
  agent?: Agent;
  inFlight: boolean;
}

export class SubagentManager {
  private readonly options: SubagentManagerOptions;
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly shutdownController = new AbortController();
  private closing = false;

  constructor(options: SubagentManagerOptions) {
    this.options = options;
  }

  readonly execute: DelegateTaskExecutor = async (input, context) => this.runBatch(input, context);

  async runBatch(input: DelegateTaskInput, context: ToolContext): Promise<DelegateTaskBatchResult> {
    if (this.closing) throw new Error('worker manager is closed');
    const started = Date.now();
    const batchId = uuid();
    const snapshotSignal = AbortSignal.any([context.signal, this.shutdownController.signal]);
    const snapshot = await createSubagentSnapshot(context.cwd, snapshotSignal);
    if (this.closing || context.signal.aborted) {
      await cleanupSubagentSnapshot(snapshot);
      throw new Error('parent task or runtime was cancelled before workers started');
    }
    const artifactsDir = join(dirname(this.options.config.session.dbPath), 'subagents', batchId);
    const limit = this.options.config.agent.subagentMaxConcurrency;
    const concurrency = limit === 0 ? input.tasks.length : Math.min(limit, input.tasks.length);
    const results: DelegateTaskResult[] = new Array(input.tasks.length);
    const workers = input.tasks.map((task) => {
      const worker = this.createWorker(task, input.context, context, batchId);
      this.workers.set(worker.id, worker);
      this.publishWorkerState(worker);
      return worker;
    });
    let cursor = 0;
    let retainedWorktree = false;

    try {
      this.options.store.appendEvent('subagent.batch.started', {
        batchId,
        parentSessionId: context.sessionId,
        auditId: context.auditId,
        taskCount: input.tasks.length,
        baseline: snapshot.baseline,
      });
      await Promise.all(Array.from({ length: concurrency }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const worker = workers[index];
          if (!worker) return;
          try {
            worker.promise = this.launchWorker(worker, snapshot, artifactsDir);
            results[index] = await worker.promise;
          } catch (error) {
            results[index] = {
              workerId: worker.id,
              attempt: worker.attempt,
              name: worker.name,
              status: context.signal.aborted ? 'cancelled' : 'failed',
              summary: errorMessage(error).slice(0, SUMMARY_CHARS),
              changedPaths: [],
              patch: '',
              patchTruncated: false,
            };
          }
          if (results[index]?.worktreePath) retainedWorktree = true;
        }
      }));
    } finally {
      if (!retainedWorktree) {
        await cleanupSubagentSnapshot(snapshot).catch((error: unknown) => {
          this.options.logger.warn('清理子 Agent 快照目录失败', { path: snapshot.root, error: errorMessage(error) });
        });
      }
    }

    const complete: DelegateTaskBatchResult = {
      results,
      durationMs: Date.now() - started,
      concurrency,
    };
    try {
      this.options.store.appendEvent('subagent.batch.finished', {
        batchId,
        parentSessionId: context.sessionId,
        auditId: context.auditId,
        durationMs: complete.durationMs,
        results: results.map((result) => ({
          workerId: result.workerId ?? null,
          name: result.name,
          status: result.status,
          sessionId: result.sessionId ?? null,
          artifactPath: result.artifactPath ?? null,
          worktreePath: result.worktreePath ?? null,
        })),
      });
    } catch (error) {
      this.options.logger.warn('记录子 Agent 批次结束事件失败', { batchId, error: errorMessage(error) });
    }
    return complete;
  }

  listWorkers(parentSessionId: string): WorkerSnapshot[] {
    return [...this.workers.values()]
      .filter((worker) => worker.parentSessionId === parentSessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((worker) => this.snapshot(worker, false));
  }

  getWorker(parentSessionId: string, workerId: string, includeTranscript = true): WorkerSnapshot {
    return this.snapshot(this.requireWorker(parentSessionId, workerId), includeTranscript);
  }

  steerWorker(parentSessionId: string, workerId: string, text: string): string {
    const worker = this.requireWorker(parentSessionId, workerId);
    if (worker.status !== 'running' || !worker.agent) {
      throw new Error(`worker ${workerId} is not accepting steering while ${worker.status}`);
    }
    const queued = worker.agent.enqueueInput(text, 'steer');
    worker.progress = 'steering queued';
    this.publishWorkerProgress(worker);
    return queued.id;
  }

  cancelWorker(parentSessionId: string, workerId: string): boolean {
    const worker = this.requireWorker(parentSessionId, workerId);
    if (!isActive(worker.status)) return false;
    worker.controller.abort();
    worker.status = 'cancelling';
    worker.progress = 'cancellation requested';
    this.publishWorkerState(worker);
    return true;
  }

  async waitWorker(parentSessionId: string, workerId: string): Promise<WorkerSnapshot> {
    const worker = this.requireWorker(parentSessionId, workerId);
    await worker.completion;
    return this.getWorker(parentSessionId, workerId, false);
  }

  async retryWorker(parentSessionId: string, workerId: string): Promise<WorkerSnapshot> {
    if (this.closing) throw new Error('worker manager is closed');
    const previous = this.requireWorker(parentSessionId, workerId);
    if (previous.status === 'cancelling') await previous.completion;
    if (isActive(previous.status)) throw new Error(`worker ${workerId} is still running`);
    if (previous.parentContext.signal.aborted) throw new Error('parent task was cancelled; worker cannot be retried');
    await previous.completion;

    const limit = this.options.config.agent.subagentMaxConcurrency;
    const active = [...this.workers.values()].filter((worker) => isActive(worker.status)).length;
    if (limit > 0 && active >= limit) throw new Error(`worker concurrency limit reached (${limit})`);

    const batchId = uuid();
    const snapshotSignal = AbortSignal.any([previous.parentContext.signal, this.shutdownController.signal]);
    const snapshot = await createSubagentSnapshot(previous.parentContext.cwd, snapshotSignal);
    if (this.closing || previous.parentContext.signal.aborted) {
      await cleanupSubagentSnapshot(snapshot);
      throw new Error('parent task or runtime was cancelled before worker retry started');
    }
    const artifactsDir = join(dirname(this.options.config.session.dbPath), 'subagents', batchId);
    const worker = this.createWorker(previous.task, previous.sharedContext, previous.parentContext, batchId, previous.id, previous.attempt + 1);
    this.workers.set(worker.id, worker);
    this.publishWorkerState(worker);
    worker.promise = this.launchWorker(worker, snapshot, artifactsDir);
    void worker.promise.then(async (result) => {
      if (!result.worktreePath) await cleanupSubagentSnapshot(snapshot).catch((error: unknown) => {
        this.options.logger.warn('清理重试 worker 快照目录失败', { path: snapshot.root, error: errorMessage(error) });
      });
    });
    return this.snapshot(worker, false);
  }

  /** Cancel active process-local workers when the CLI runtime is closed. */
  async close(): Promise<void> {
    this.closing = true;
    this.shutdownController.abort();
    for (const worker of this.workers.values()) {
      if (isActive(worker.status)) this.cancelWorker(worker.parentSessionId, worker.id);
    }
    await Promise.all([...this.workers.values()].map((worker) => worker.completion));
  }

  private async runTask(
    worker: ManagedWorker,
    snapshot: Awaited<ReturnType<typeof createSubagentSnapshot>>,
    artifactsDir: string,
  ): Promise<DelegateTaskResult> {
    const { task, sharedContext, parentContext, controller, batchId } = {
      task: worker.task,
      sharedContext: worker.sharedContext,
      parentContext: worker.parentContext,
      controller: worker.controller,
      batchId: worker.batchId,
    };
    const relayAbort = (): void => controller.abort();
    if (parentContext.signal.aborted) controller.abort();
    else parentContext.signal.addEventListener('abort', relayAbort, { once: true });

    let worktree: SubagentWorktree | undefined;
    let sessionId: string | undefined;
    let status: DelegateTaskResult['status'] = 'failed';
    let summary = '子 Agent 未能启动';
    let changedPaths: string[] = [];
    let patch = '';
    let patchTruncated = false;
    let artifactPath: string | undefined;
    let cleanupWarning: string | undefined;
    let preserveWorktree = false;
    let usage: DelegateTaskResult['usage'];
    worker.status = controller.signal.aborted ? 'cancelling' : 'starting';
    worker.startedAt = new Date().toISOString();
    worker.progress = 'creating isolated worktree';
    this.publishWorkerState(worker);
    let detachAgentEvents: (() => void) | undefined;

    try {
      worktree = await createSubagentWorktree(snapshot, task.name, controller.signal);
      worker.worktreePath = worktree.path;
      const settings: PolicySettings = {
        ...this.options.settings,
        mode: 'yolo',
        requireApprovalForWrite: false,
        requireApprovalForExecute: false,
        allowedPrograms: [],
        workspaceRoots: [worktree.path],
        writableRoots: [worktree.path],
      };
      const workspace = new WorkspaceGuard({
        roots: settings.workspaceRoots,
        writableRoots: settings.writableRoots,
        protectedPaths: settings.protectedPaths,
      });
      const registry = new ToolRegistry(createBuiltinTools({
        remoteHosts: settings.remoteHosts,
        languageServers: this.options.config.tools.languageServers,
        ...(this.options.createIsolatedExecutor ? { runCommand: { executeIsolated: this.options.createIsolatedExecutor(worktree.path, settings.protectedPaths) } } : {}),
      }));
      const agent = new Agent({
        provider: this.options.getProvider(),
        registry,
        settings,
        workspace,
        approvals: this.options.approvals,
        audit: this.options.audit,
        store: this.options.store,
        cwd: worktree.path,
        ...(this.options.config.agent.maxIterations !== undefined
          ? { maxIterations: this.options.config.agent.maxIterations }
          : {}),
        maxConcurrency: this.options.config.agent.maxConcurrency,
        parentSessionId: parentContext.sessionId,
        systemPromptSuffix: `You are a ForgeX child coding agent working only on the task assigned by the parent. The workspace is an isolated Git worktree. The parent already authorized this delegation, so do not expect per-action approval prompts. CommandGuard and PolicyEngine hard-deny rules still apply; file tools still enforce protected paths and WorkspaceGuard checks. Do not attempt to delegate or claim changes were merged into the parent workspace. Report concrete changed paths.`,
        logger: this.options.logger,
        ...(this.options.extensions ? { extensions: this.options.extensions } : {}),
      });
      worker.agent = agent;
      sessionId = agent.sessionId;
      worker.sessionId = sessionId;
      worker.status = controller.signal.aborted ? 'cancelling' : 'running';
      worker.progress = 'agent running';
      detachAgentEvents = agent.events.on((event) => this.captureAgentEvent(worker, event));
      this.publishWorkerState(worker);
      this.options.store.appendEvent('subagent.task.started', {
        workerId: worker.id,
        attempt: worker.attempt,
        batchId,
        name: task.name,
        sessionId,
        parentSessionId: parentContext.sessionId,
        worktree: worktree.path,
        baseline: snapshot.baseline,
      });

      const prompt = [
        'Shared context:', sharedContext,
        `Task (${task.name}):`, task.task,
        ...(task.expectedOutput ? ['Expected output:', task.expectedOutput] : []),
      ].join('\n\n');
      const run = await agent.run(prompt, { signal: controller.signal });
      summary = run.text.slice(0, SUMMARY_CHARS);
      status = run.reason === 'completed' ? 'completed' : run.reason === 'aborted' || controller.signal.aborted ? 'cancelled' : 'failed';
      usage = {
        modelCalls: run.metrics.modelCalls,
        totalTokens: run.metrics.totalTokens,
        toolCalls: run.metrics.toolCalls,
        iterations: run.metrics.iterations,
        durationMs: run.metrics.totalMs,
      };

      const changes = await captureSubagentChanges(worktree, controller.signal.aborted ? undefined : controller.signal);
      changedPaths = changes.changedPaths;
      patch = changes.patch;
      patchTruncated = changes.patchTruncated;
      if (patchTruncated) {
        preserveWorktree = true;
        cleanupWarning = 'patch 超过采集上限，已保留 worker worktree';
      }
      await mkdir(artifactsDir, { recursive: true });
      const fileName = `${sanitizeFileName(task.name)}-${worktree.id}.patch`;
      artifactPath = join(artifactsDir, fileName);
      await writeFile(artifactPath, formatPatchArtifact(patch, patchTruncated), 'utf8');
      if (!patch && status === 'completed') summary = `${summary}\n\n无文件改动。`;
    } catch (error) {
      summary = errorMessage(error);
      status = parentContext.signal.aborted || controller.signal.aborted ? 'cancelled' : 'failed';
      if (worktree) {
        try {
          const changes = await captureSubagentChanges(worktree);
          changedPaths = changes.changedPaths;
          patch = changes.patch;
          patchTruncated = changes.patchTruncated;
          if (patchTruncated) {
            preserveWorktree = true;
            cleanupWarning = 'patch 超过采集上限，已保留 worker worktree';
          }
          await mkdir(artifactsDir, { recursive: true });
          artifactPath = join(artifactsDir, `${sanitizeFileName(task.name)}-${worktree.id}.patch`);
          await writeFile(artifactPath, formatPatchArtifact(patch, patchTruncated), 'utf8');
        } catch (captureError) {
          cleanupWarning = `无法捕获或保存 worker 改动：${errorMessage(captureError)}`;
          preserveWorktree = true;
        }
      }
    } finally {
      detachAgentEvents?.();
      worker.agent = undefined;
      parentContext.signal.removeEventListener('abort', relayAbort);
      if (worktree && !preserveWorktree) {
        try {
          await cleanupSubagentWorktree(worktree);
        } catch (error) {
          cleanupWarning = [cleanupWarning, `worktree 已保留以便恢复：${errorMessage(error)}`].filter(Boolean).join('；');
          preserveWorktree = true;
        }
      }
    }

    const result: DelegateTaskResult = {
      workerId: worker.id,
      attempt: worker.attempt,
      name: task.name,
      status,
      summary,
      changedPaths,
      patch: patch.slice(0, PATCH_PREVIEW_CHARS),
      patchTruncated: patchTruncated || patch.length > PATCH_PREVIEW_CHARS,
      ...(sessionId ? { sessionId } : {}),
      ...(artifactPath ? { artifactPath } : {}),
      ...(usage ? { usage } : {}),
      ...(cleanupWarning ? { cleanupWarning } : {}),
      ...(worktree && preserveWorktree ? { worktreePath: worktree.path } : {}),
    };
    worker.status = status;
    worker.finishedAt = new Date().toISOString();
    worker.progress = status;
    worker.summary = summary;
    worker.changedPaths = [...changedPaths];
    worker.sessionId = sessionId ?? worker.sessionId;
    if (artifactPath) worker.artifactPath = artifactPath;
    else delete worker.artifactPath;
    worker.cleanupWarning = cleanupWarning;
    worker.usage = usage ? {
      modelCalls: usage.modelCalls,
      totalTokens: usage.totalTokens,
      toolCalls: usage.toolCalls,
      iterations: usage.iterations,
      durationMs: usage.durationMs,
    } : worker.usage;
    if (!result.worktreePath) delete worker.worktreePath;
    this.publishWorkerState(worker);
    try {
      this.options.store.appendEvent('subagent.task.finished', {
        workerId: worker.id,
        attempt: worker.attempt,
        batchId,
        name: task.name,
        sessionId: sessionId ?? null,
        parentSessionId: parentContext.sessionId,
        status,
        changedPaths,
        usage: usage ?? null,
        artifactPath: artifactPath ?? null,
        worktreePath: result.worktreePath ?? null,
        cleanupWarning: cleanupWarning ?? null,
      });
    } catch (error) {
      this.options.logger.warn('记录子 Agent 结束事件失败', { task: task.name, error: errorMessage(error) });
    }
    return result;
  }

  private createWorker(
    task: DelegateTaskInput['tasks'][number],
    sharedContext: string,
    parentContext: ToolContext,
    batchId: string,
    id = uuid(),
    attempt = 1,
  ): ManagedWorker {
    const now = new Date().toISOString();
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    return {
      id,
      batchId,
      parentSessionId: parentContext.sessionId,
      name: task.name,
      attempt,
      status: 'queued',
      progress: 'queued',
      summary: '',
      createdAt: now,
      updatedAt: now,
      changedPaths: [],
      task,
      sharedContext,
      parentContext,
      controller: new AbortController(),
      completion,
      resolveCompletion,
      inFlight: false,
    };
  }

  private launchWorker(
    worker: ManagedWorker,
    snapshot: Awaited<ReturnType<typeof createSubagentSnapshot>>,
    artifactsDir: string,
  ): Promise<DelegateTaskResult> {
    worker.inFlight = true;
    return this.runTask(worker, snapshot, artifactsDir).catch((error: unknown) => {
      const status: DelegateTaskResult['status'] = worker.controller.signal.aborted ? 'cancelled' : 'failed';
      const summary = errorMessage(error).slice(0, SUMMARY_CHARS);
      worker.status = status;
      worker.summary = summary;
      worker.progress = status;
      worker.finishedAt = new Date().toISOString();
      this.publishWorkerState(worker);
      return {
        workerId: worker.id,
        attempt: worker.attempt,
        name: worker.name,
        status,
        summary,
        changedPaths: [],
        patch: '',
        patchTruncated: false,
      };
    }).finally(() => {
      worker.inFlight = false;
      worker.resolveCompletion();
    });
  }

  private snapshot(worker: ManagedWorker, includeTranscript: boolean): WorkerSnapshot {
    const { task: _task, sharedContext: _context, parentContext: _parent, controller: _controller,
      completion: _completion, resolveCompletion: _resolve, promise: _promise, agent: _agent,
      inFlight: _inFlight, ...publicState } = worker;
    return {
      ...publicState,
      changedPaths: [...worker.changedPaths],
      ...(worker.usage ? { usage: { ...worker.usage } } : {}),
      ...(includeTranscript ? { transcript: worker.sessionId ? this.options.store.getMessages(worker.sessionId) : [] } : {}),
    };
  }

  private requireWorker(parentSessionId: string, workerId: string): ManagedWorker {
    const worker = this.workers.get(workerId);
    if (!worker || worker.parentSessionId !== parentSessionId) {
      throw new Error(`worker not found for parent session: ${workerId}`);
    }
    return worker;
  }

  private captureAgentEvent(worker: ManagedWorker, event: AgentEvent): void {
    if (this.workers.get(worker.id) !== worker) return;
    if (event.type === 'tool:start') {
      worker.progress = `tool: ${event.name}`;
      worker.usage = { ...(worker.usage ?? emptyUsage()), toolCalls: (worker.usage?.toolCalls ?? 0) + 1 };
      this.publishWorkerProgress(worker);
    } else if (event.type === 'model:response') {
      worker.progress = `model: ${event.modelName}`;
      worker.usage = { ...(worker.usage ?? emptyUsage()), modelCalls: (worker.usage?.modelCalls ?? 0) + 1 };
      this.publishWorkerProgress(worker);
    } else if (event.type === 'assistant:message') {
      worker.summary = event.text.slice(0, SUMMARY_CHARS);
      worker.progress = 'assistant responded';
      this.publishWorkerProgress(worker);
    } else if (event.type === 'metrics') {
      worker.usage = {
        modelCalls: event.metrics.modelCalls,
        totalTokens: event.metrics.totalTokens,
        toolCalls: event.metrics.toolCalls,
        iterations: event.metrics.iterations,
        durationMs: event.metrics.totalMs,
      };
      this.publishWorkerProgress(worker);
    }
  }

  private publishWorkerState(worker: ManagedWorker): void {
    if (this.workers.get(worker.id) !== worker) return;
    worker.updatedAt = new Date().toISOString();
    const data = {
      batchId: worker.batchId,
      name: worker.name,
      attempt: worker.attempt,
      status: worker.status,
      progress: worker.progress,
      sessionId: worker.sessionId ?? null,
      artifactPath: worker.artifactPath ?? null,
      worktreePath: worker.worktreePath ?? null,
      usage: worker.usage ?? null,
      updatedAt: worker.updatedAt,
    };
    try {
      this.options.store.recordWorkerEvent(worker.parentSessionId, worker.id, 'state', data);
    } catch (error) {
      this.options.logger.warn('记录 worker 状态事件失败', { workerId: worker.id, error: errorMessage(error) });
    }
    try {
      this.options.onEvent?.({
        type: 'worker:state',
        parentSessionId: worker.parentSessionId,
        workerId: worker.id,
        name: worker.name,
        status: worker.status,
        attempt: worker.attempt,
        progress: worker.progress,
        ts: Date.now(),
      });
    } catch (error) {
      this.options.logger.warn('worker 状态监听器失败', { workerId: worker.id, error: errorMessage(error) });
    }
  }

  private publishWorkerProgress(worker: ManagedWorker): void {
    if (this.workers.get(worker.id) !== worker) return;
    worker.updatedAt = new Date().toISOString();
    const usage = worker.usage ? { ...worker.usage } : undefined;
    try {
      this.options.store.recordWorkerEvent(worker.parentSessionId, worker.id, 'progress', {
        batchId: worker.batchId,
        progress: worker.progress,
        ...(usage ? { usage } : {}),
        updatedAt: worker.updatedAt,
      });
    } catch (error) {
      this.options.logger.warn('记录 worker 进度事件失败', { workerId: worker.id, error: errorMessage(error) });
    }
    try {
      this.options.onEvent?.({
        type: 'worker:progress',
        parentSessionId: worker.parentSessionId,
        workerId: worker.id,
        progress: worker.progress,
        ...(usage ? { usage } : {}),
        ts: Date.now(),
      });
    } catch (error) {
      this.options.logger.warn('worker 进度监听器失败', { workerId: worker.id, error: errorMessage(error) });
    }
  }
}

function sanitizeFileName(value: string): string {
  return value.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'worker';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPatchArtifact(patch: string, truncated: boolean): string {
  return truncated ? `${patch}\n\n[patch 已达到采集上限，差异内容不完整]\n` : patch;
}

function isActive(status: WorkerStatus): boolean {
  return status === 'queued' || status === 'starting' || status === 'running' || status === 'cancelling';
}

function emptyUsage(): WorkerUsage {
  return { modelCalls: 0, totalTokens: 0, toolCalls: 0, iterations: 0, durationMs: 0 };
}
