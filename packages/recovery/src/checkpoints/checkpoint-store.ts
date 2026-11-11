/** Append-only JSONL persistence for recovery checkpoints. */
import { JsonlEventStore, uuid } from '@forgex/shared';
import type { EnvironmentSnapshot, RecoveryCheckpoint } from '../types.js';

export class CheckpointStore {
  private readonly events: JsonlEventStore;

  constructor(events: JsonlEventStore) {
    this.events = events;
  }

  /** Creates a new recovery checkpoint. */
  create(params: {
    workflowRunId: string;
    workflowId: string;
    currentStepId: string;
    completedSteps: string[];
    environmentSnapshot: EnvironmentSnapshot;
    policyVersion: string;
    idempotencyKeys: string[];
  }): RecoveryCheckpoint {
    const now = new Date().toISOString();
    const checkpoint: RecoveryCheckpoint = {
      id: uuid(),
      workflowRunId: params.workflowRunId,
      workflowId: params.workflowId,
      currentStepId: params.currentStepId,
      completedSteps: params.completedSteps,
      environmentSnapshot: params.environmentSnapshot,
      policyVersion: params.policyVersion,
      idempotencyKeys: params.idempotencyKeys,
      createdAt: now,
      updatedAt: now,
    };
    this.append('recovery.checkpoint.saved', checkpoint);
    return checkpoint;
  }

  /** Updates the mutable progress fields of an existing checkpoint. */
  update(id: string, updates: Partial<Pick<RecoveryCheckpoint, 'currentStepId' | 'completedSteps' | 'idempotencyKeys'>>): void {
    const existing = this.get(id);
    if (!existing) return;
    this.append('recovery.checkpoint.updated', {
      ...existing,
      currentStepId: updates.currentStepId ?? existing.currentStepId,
      completedSteps: updates.completedSteps ?? existing.completedSteps,
      idempotencyKeys: updates.idempotencyKeys ?? existing.idempotencyKeys,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Returns a checkpoint by ID, if present. */
  get(id: string): RecoveryCheckpoint | null { return this.latest().get(id) ?? null; }

  /** Returns the most recently updated checkpoint for a workflow run. */
  getLatestByRun(workflowRunId: string): RecoveryCheckpoint | null {
    return [...this.latest().values()].filter((item) => item.workflowRunId === workflowRunId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }

  /** Returns all current checkpoints, newest first. */
  list(): RecoveryCheckpoint[] {
    return [...this.latest().values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** Marks a checkpoint as deleted without removing its history. */
  delete(id: string): void {
    const parent = this.events.readAll().findLast((event) => event.data.checkpointId === id);
    this.events.append('recovery.checkpoint.deleted', { checkpointId: id }, parent?.id ?? null);
  }

  private append(type: string, checkpoint: RecoveryCheckpoint): void {
    const parent = this.events.readAll().findLast((event) => event.data.checkpointId === checkpoint.id);
    this.events.append(type, { checkpointId: checkpoint.id, checkpoint }, parent?.id ?? null);
  }

  private latest(): Map<string, RecoveryCheckpoint> {
    const records = new Map<string, RecoveryCheckpoint>();
    for (const event of this.events.readAll()) {
      if (typeof event.data.checkpointId !== 'string') continue;
      if (event.type === 'recovery.checkpoint.deleted') records.delete(event.data.checkpointId);
      if (event.type === 'recovery.checkpoint.saved' || event.type === 'recovery.checkpoint.updated') {
        const checkpoint = event.data.checkpoint;
        if (checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint)) {
          records.set(event.data.checkpointId, JSON.parse(JSON.stringify(checkpoint)) as RecoveryCheckpoint);
        }
      }
    }
    return records;
  }
}
