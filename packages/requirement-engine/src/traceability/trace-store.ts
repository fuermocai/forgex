/** Append-only JSONL persistence for requirement delivery traces. */
import { JsonlEventStore } from '@forgex/shared';
import type { RequirementTrace, StructuredRequirement } from '../types.js';

export class RequirementTraceStore {
  private readonly events: JsonlEventStore;

  constructor(events: JsonlEventStore) {
    this.events = events;
  }

  /** Creates the initial trace for a structured requirement. */
  init(requirement: StructuredRequirement): RequirementTrace {
    const existing = this.get(requirement.traceId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const trace: RequirementTrace = {
      traceId: requirement.traceId,
      requirementId: requirement.id,
      workflowNodeIds: [],
      codeChanges: [],
      tests: [],
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.save(trace);
    return trace;
  }

  /** Updates the delivery status. */
  updateStatus(traceId: string, status: RequirementTrace['status']): void {
    const trace = this.get(traceId);
    if (!trace) return;
    trace.status = status;
    this.save(trace);
  }

  /** Associates the trace with a workflow run. */
  bindWorkflowRun(traceId: string, workflowRunId: string): void {
    const trace = this.get(traceId);
    if (!trace) return;
    trace.workflowRunId = workflowRunId;
    this.save(trace);
  }

  /** Adds a unique code change reference. */
  addCodeChange(traceId: string, change: string): void {
    const trace = this.get(traceId);
    if (!trace || trace.codeChanges.includes(change)) return;
    trace.codeChanges.push(change);
    this.save(trace);
  }

  /** Adds a unique test reference. */
  addTest(traceId: string, test: string): void {
    const trace = this.get(traceId);
    if (!trace || trace.tests.includes(test)) return;
    trace.tests.push(test);
    this.save(trace);
  }

  /** Marks a trace as delivered with its final summary. */
  markDelivered(traceId: string, summary: string): void {
    const trace = this.get(traceId);
    if (!trace) return;
    trace.status = 'delivered';
    trace.deliverySummary = summary;
    this.save(trace);
  }

  /** Returns a trace by ID. */
  get(traceId: string): RequirementTrace | null { return this.latest().get(traceId) ?? null; }

  /** Returns the latest trace for a requirement ID. */
  getByRequirement(requirementId: string): RequirementTrace | null {
    return [...this.latest().values()].filter((trace) => trace.requirementId === requirementId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }

  /** Lists current traces, newest first. */
  list(): RequirementTrace[] {
    return [...this.latest().values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private save(trace: RequirementTrace): void {
    trace.updatedAt = new Date().toISOString();
    const parent = this.events.readAll().findLast((event) => event.data.traceId === trace.traceId);
    this.events.append('requirement.trace.saved', { traceId: trace.traceId, trace }, parent?.id ?? null);
  }

  private latest(): Map<string, RequirementTrace> {
    const records = new Map<string, RequirementTrace>();
    for (const event of this.events.readAll()) {
      if (event.type !== 'requirement.trace.saved' || typeof event.data.traceId !== 'string') continue;
      const trace = event.data.trace;
      if (trace && typeof trace === 'object' && !Array.isArray(trace)) {
        records.set(event.data.traceId, JSON.parse(JSON.stringify(trace)) as RequirementTrace);
      }
    }
    return records;
  }
}
