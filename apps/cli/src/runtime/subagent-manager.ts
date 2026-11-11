import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Agent, SessionStore, type ForgeExtension } from '@forgex/core';
import type { Logger, PolicySettings, ToolContext } from '@forgex/shared';
import { uuid } from '@forgex/shared';
import type { ModelProvider } from '@forgex/models';
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
  extensions?: ReadonlyArray<ForgeExtension>;
}

export class SubagentManager {
  private readonly options: SubagentManagerOptions;

  constructor(options: SubagentManagerOptions) {
    this.options = options;
  }

  readonly execute: DelegateTaskExecutor = async (input, context) => this.runBatch(input, context);

  async runBatch(input: DelegateTaskInput, context: ToolContext): Promise<DelegateTaskBatchResult> {
    const started = Date.now();
    const batchId = uuid();
    const snapshot = await createSubagentSnapshot(context.cwd, context.signal);
    const artifactsDir = join(dirname(this.options.config.session.dbPath), 'subagents', batchId);
    const limit = this.options.config.agent.subagentMaxConcurrency;
    const concurrency = limit === 0 ? input.tasks.length : Math.min(limit, input.tasks.length);
    const results: DelegateTaskResult[] = new Array(input.tasks.length);
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
          const task = input.tasks[index];
          if (!task) return;
          try {
            results[index] = await this.runTask(task, input.context, context, snapshot, artifactsDir, batchId);
          } catch (error) {
            results[index] = {
              name: task.name,
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

  private async runTask(
    task: DelegateTaskInput['tasks'][number],
    sharedContext: string,
    parentContext: ToolContext,
    snapshot: Awaited<ReturnType<typeof createSubagentSnapshot>>,
    artifactsDir: string,
    batchId: string,
  ): Promise<DelegateTaskResult> {
    const controller = new AbortController();
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

    try {
      worktree = await createSubagentWorktree(snapshot, task.name, controller.signal);
      const settings: PolicySettings = {
        ...this.options.settings,
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
        systemPromptSuffix: `You are a ForgeX child coding agent working only on the task assigned by the parent. The workspace is an isolated Git worktree. Do not attempt to delegate or claim changes were merged into the parent workspace. Follow the configured security policy and report concrete changed paths.`,
        logger: this.options.logger,
        ...(this.options.extensions ? { extensions: this.options.extensions } : {}),
      });
      sessionId = agent.sessionId;
      this.options.store.appendEvent('subagent.task.started', {
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
    try {
      this.options.store.appendEvent('subagent.task.finished', {
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
