/** Task execution records are persisted as events in the shared JSONL log. */
import { JsonlEventStore, CheckpointManager, type CheckpointRecord, SessionStore } from '@forgex/core';
import { uuid } from '@forgex/shared';
import type { ForgeRuntime } from '../runtime/create-runtime.js';

export type TaskRunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'blocked' | 'unverified' | 'aborted' | 'invalid_plan';
export interface StepResultRecord {
  step_id: string;
  final_status: 'completed' | 'failed' | 'cancelled' | 'running' | 'needs_reconciliation' | 'pending';
  attempts_used: number;
  duration_ms: number;
  verification_passed: boolean;
  verification_reason?: string;
  tool_call_count: number;
  failure_reason?: string;
  evidence_count: number;
  summary?: string;
  verified_by?: string;
}
export interface GateResultRecord { passed: boolean; stages_completed: string[]; stages_failed: string[]; details_json?: string; final_message: string; }
export interface CreateTaskRunInput {
  user_prompt: string; plan_id?: string; session_id?: string; workspace: string; model: string;
  isolation?: 'in_place' | 'worktree'; metrics?: { toolCalls: number; modelCalls: number; totalTokens: number };
}
export interface TaskRunSummary {
  runId: string; createdAt: string; updatedAt: string; prompt: string; status: TaskRunStatus; workspace: string; model: string;
  exitCode: number | null; finalMessage: string | null; durationMs: number | null; toolCalls: number; modelCalls: number;
  totalTokens: number; metricsSource: 'recorded' | 'partial' | 'backfilled_estimate' | 'unavailable';
  isolation: 'in_place' | 'worktree'; worktreeRoot: string | null; worktreePath: string | null; worktreeBranch: string | null; baseCommit: string | null;
}
export interface WorktreeBinding { root: string; path: string; branch: string; baseCommit: string; }
type Row = Record<string, unknown>;

export class TaskRunStore {
  private readonly log: JsonlEventStore;

  constructor(path: string) {
    // All task-run records are appended to the shared JSONL event stream.
    const bootstrap = new SessionStore(path);
    bootstrap.close();
    this.log = new JsonlEventStore(path);
  }

  createCheckpointManager(): CheckpointManager { return new CheckpointManager(this.log); }
  loadCheckpoint(planId: string): CheckpointRecord | null { return this.createCheckpointManager().load(planId); }
  saveCheckpoint(record: CheckpointRecord): void { this.createCheckpointManager().save(record); }

  static fromRuntime(runtime: ForgeRuntime): TaskRunStore { return new TaskRunStore(runtime.config.session.dbPath); }

  createRun(input: CreateTaskRunInput): string {
    const now = new Date().toISOString();
    const runId = `run_${uuid()}`;
    this.log.append('task.run.created', {
      run_id: runId, created_at: now, updated_at: now, user_prompt: input.user_prompt, status: 'planned',
      plan_id: input.plan_id ?? null, session_id: input.session_id ?? null, workspace: input.workspace, model: input.model,
      exit_code: null, final_message: null, duration_ms: null,
      tool_calls: input.metrics?.toolCalls ?? 0, model_calls: input.metrics?.modelCalls ?? 0, total_tokens: input.metrics?.totalTokens ?? 0,
      metrics_source: input.metrics ? 'recorded' : 'unknown', isolation: input.isolation ?? 'in_place',
      worktree_root: null, worktree_path: null, worktree_branch: null, base_commit: null,
    }, this.lastFor('task.run.created', 'run_id', runId)?.id ?? null);
    return runId;
  }

  setWorktree(runId: string, binding: WorktreeBinding): void {
    this.updateRun(runId, { isolation: 'worktree', worktree_root: binding.root, worktree_path: binding.path, worktree_branch: binding.branch, base_commit: binding.baseCommit });
  }

  getRunSummary(runId: string): TaskRunSummary | null { const row = this.getRun(runId); return row ? toSummary(row) : null; }
  listRuns(limit = 20): TaskRunSummary[] {
    return this.runIds().map((id) => this.getRun(id)).filter((row): row is Row => row !== null)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Math.max(1, Math.min(200, limit))).map(toSummary);
  }

  updateRun(runId: string, patch: Record<string, unknown>): void {
    const current = this.getRun(runId);
    if (!current) return;
    const metricsChanged = ['tool_calls', 'model_calls', 'total_tokens'].some((key) => patch[key] !== undefined);
    const metricsSource = metricsChanged && !['partial', 'backfilled_estimate'].includes(String(current.metrics_source)) ? 'recorded' : current.metrics_source;
    this.log.append('task.run.updated', { run_id: runId, patch: { ...patch, updated_at: new Date().toISOString(), ...(metricsChanged ? { metrics_source: metricsSource } : {}) } }, this.lastForRun(runId)?.id ?? null);
  }

  getRun(runId: string): Row | null {
    let row: Row | null = null;
    for (const event of this.log.readAll()) {
      if (event.type === 'task.run.created' && event.data.run_id === runId) row = { ...event.data };
      else if (event.type === 'legacy.task_runs' && event.data.run_id === runId) row = { ...event.data };
      else if (event.type === 'task.run.updated' && event.data.run_id === runId && row) {
        const patch = event.data.patch && typeof event.data.patch === 'object' ? event.data.patch as Row : {};
        row = Object.assign({}, row, patch, { updated_at: event.ts });
      }
      else if (event.type === 'task.metrics.partial' && event.data.run_id === runId && row) Object.assign(row, { metrics_source: 'partial', updated_at: event.ts });
      else if (event.type === 'task.step.execution' && event.data.run_id === runId && row) {
        const metrics = event.data.metrics as Row;
        Object.assign(row, {
          tool_calls: Number(row.tool_calls ?? 0) + Number(metrics.toolCalls ?? 0),
          model_calls: Number(row.model_calls ?? 0) + Number(metrics.modelCalls ?? 0),
          total_tokens: Number(row.total_tokens ?? 0) + Number(metrics.totalTokens ?? 0),
          metrics_source: ['partial', 'backfilled_estimate'].includes(String(row.metrics_source)) ? row.metrics_source : 'recorded',
          updated_at: event.ts,
        });
      }
    }
    return row;
  }

  upsertStepResult(runId: string, step: StepResultRecord): void { this.log.append('task.step.upserted', { run_id: runId, step: { ...step, verified_by: step.verified_by ?? 'executor' } }, this.lastForRun(runId)?.id ?? null); }
  recordStepExecution(runId: string, step: StepResultRecord, metrics: { toolCalls: number; modelCalls: number; totalTokens: number }): void {
    this.log.append('task.step.execution', { run_id: runId, step: { ...step, verified_by: step.verified_by ?? 'executor' }, metrics }, this.lastForRun(runId)?.id ?? null);
  }
  markMetricsPartial(runId: string): void { this.log.append('task.metrics.partial', { run_id: runId }, this.lastForRun(runId)?.id ?? null); }

  listStepResults(runId: string): StepResultRecord[] {
    const latest = new Map<string, StepResultRecord>();
    for (const event of this.log.readAll()) {
      if (event.data.run_id !== runId) continue;
      if (event.type === 'legacy.step_results') latest.set(String(event.data.step_id), fromLegacyStep(event.data));
      if (event.type === 'task.step.upserted' || event.type === 'task.step.execution') {
        latest.set(String((event.data.step as Row).step_id), (event.data.step as StepResultRecord));
      }
    }
    return [...latest.values()];
  }

  insertGateResult(runId: string, kind: string, result: GateResultRecord): void {
    this.log.append('task.gate.recorded', { run_id: runId, kind, result, created_at: new Date().toISOString() }, this.lastForRun(runId)?.id ?? null);
  }
  close(): void { /* appendFileSync requires no close */ }

  private runIds(): string[] {
    const ids = new Set<string>();
    for (const event of this.log.readAll()) {
      if (event.type === 'task.run.created' || event.type === 'legacy.task_runs') ids.add(String(event.data.run_id));
    }
    return [...ids];
  }

  private lastForRun(runId: string) { return this.log.readAll().findLast((event) => event.data.run_id === runId); }
  private lastFor(type: string, field: string, value: string) { return this.log.readAll().findLast((event) => event.type === type && event.data[field] === value); }
}

function fromLegacyStep(row: Row): StepResultRecord {
  return {
    step_id: String(row.step_id), final_status: String(row.final_status) as StepResultRecord['final_status'],
    attempts_used: Number(row.attempts_used), duration_ms: Number(row.duration_ms), verification_passed: Boolean(row.verification_passed),
    verification_reason: typeof row.verification_reason === 'string' ? row.verification_reason : undefined,
    tool_call_count: Number(row.tool_call_count), failure_reason: typeof row.failure_reason === 'string' ? row.failure_reason : undefined,
    evidence_count: Number(row.evidence_count), summary: typeof row.summary === 'string' ? row.summary : undefined,
    verified_by: typeof row.verified_by === 'string' ? row.verified_by : 'executor',
  };
}
function toSummary(row: Row): TaskRunSummary {
  const isolation = String(row.isolation ?? 'in_place') === 'worktree' ? 'worktree' : 'in_place';
  return {
    runId: String(row.run_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at), prompt: String(row.user_prompt),
    status: String(row.status) as TaskRunStatus, workspace: String(row.workspace), model: String(row.model),
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    finalMessage: typeof row.final_message === 'string' ? row.final_message : null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    toolCalls: Number(row.tool_calls ?? 0), modelCalls: Number(row.model_calls ?? 0), totalTokens: Number(row.total_tokens ?? 0),
    metricsSource: String(row.metrics_source ?? 'unavailable') as TaskRunSummary['metricsSource'], isolation,
    worktreeRoot: typeof row.worktree_root === 'string' ? row.worktree_root : null,
    worktreePath: typeof row.worktree_path === 'string' ? row.worktree_path : null,
    worktreeBranch: typeof row.worktree_branch === 'string' ? row.worktree_branch : null,
    baseCommit: typeof row.base_commit === 'string' ? row.base_commit : null,
  };
}
