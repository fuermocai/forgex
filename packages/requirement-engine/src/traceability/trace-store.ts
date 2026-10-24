/**
 * RequirementTraceStore：追溯链持久化（v0.5.0 Phase 1）。
 *
 * 基于 SQLite，需求→代码→测试 关联的唯一持久化层。
 * 预留 workflowRunId 字段供 Phase 2 关联 AutonomousRunner。
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  RequirementTrace,
  StructuredRequirement,
} from '../types.js';

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS requirement_traces (
  trace_id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  workflow_run_id TEXT,
  workflow_node_ids TEXT NOT NULL,
  code_changes TEXT NOT NULL,
  tests TEXT NOT NULL,
  status TEXT NOT NULL,
  delivery_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_trace_requirement ON requirement_traces(requirement_id)`;

export class RequirementTraceStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(CREATE_TABLE);
    db.exec(CREATE_INDEX);
  }

  /** 从 StructuredRequirement 初始化追溯链 */
  init(requirement: StructuredRequirement): RequirementTrace {
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
    this.db
      .prepare(
        `INSERT OR IGNORE INTO requirement_traces
         (trace_id, requirement_id, workflow_run_id, workflow_node_ids, code_changes, tests,
          status, delivery_summary, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        trace.traceId,
        trace.requirementId,
        JSON.stringify(trace.workflowNodeIds),
        JSON.stringify(trace.codeChanges),
        JSON.stringify(trace.tests),
        trace.status,
        trace.createdAt,
        trace.updatedAt,
      );
    return trace;
  }

  /** 更新状态 */
  updateStatus(traceId: string, status: RequirementTrace['status']): void {
    this.db
      .prepare(
        `UPDATE requirement_traces SET status = ?, updated_at = ? WHERE trace_id = ?`,
      )
      .run(status, new Date().toISOString(), traceId);
  }

  /** 更新 workflowRunId（Phase 2 关联） */
  bindWorkflowRun(traceId: string, workflowRunId: string): void {
    this.db
      .prepare(
        `UPDATE requirement_traces SET workflow_run_id = ?, updated_at = ? WHERE trace_id = ?`,
      )
      .run(workflowRunId, new Date().toISOString(), traceId);
  }

  /** 添加代码变更 */
  addCodeChange(traceId: string, change: string): void {
    const trace = this.get(traceId);
    if (!trace) return;
    if (!trace.codeChanges.includes(change)) {
      trace.codeChanges.push(change);
      this.save(trace);
    }
  }

  /** 添加测试关联 */
  addTest(traceId: string, test: string): void {
    const trace = this.get(traceId);
    if (!trace) return;
    if (!trace.tests.includes(test)) {
      trace.tests.push(test);
      this.save(trace);
    }
  }

  /** 完成交付 */
  markDelivered(traceId: string, summary: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE requirement_traces SET status = 'delivered', delivery_summary = ?, updated_at = ? WHERE trace_id = ?`,
      )
      .run(summary, now, traceId);
  }

  /** 查询 */
  get(traceId: string): RequirementTrace | null {
    const row = this.db
      .prepare('SELECT * FROM requirement_traces WHERE trace_id = ?')
      .get(traceId) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapRow(row);
  }

  /** 按需求 ID 查询 */
  getByRequirement(requirementId: string): RequirementTrace | null {
    const row = this.db
      .prepare('SELECT * FROM requirement_traces WHERE requirement_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(requirementId) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapRow(row);
  }

  /** 列出所有 */
  list(): RequirementTrace[] {
    const rows = this.db
      .prepare('SELECT * FROM requirement_traces ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  private save(trace: RequirementTrace): void {
    trace.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE requirement_traces
         SET workflow_node_ids = ?, code_changes = ?, tests = ?, status = ?, updated_at = ?
         WHERE trace_id = ?`,
      )
      .run(
        JSON.stringify(trace.workflowNodeIds),
        JSON.stringify(trace.codeChanges),
        JSON.stringify(trace.tests),
        trace.status,
        trace.updatedAt,
        trace.traceId,
      );
  }

  private mapRow(row: Record<string, unknown>): RequirementTrace {
    return {
      traceId: String(row.trace_id),
      requirementId: String(row.requirement_id),
      workflowRunId: row.workflow_run_id ? String(row.workflow_run_id) : undefined,
      workflowNodeIds: JSON.parse(String(row.workflow_node_ids)) as string[],
      codeChanges: JSON.parse(String(row.code_changes)) as string[],
      tests: JSON.parse(String(row.tests)) as string[],
      status: row.status as RequirementTrace['status'],
      deliverySummary: row.delivery_summary ? String(row.delivery_summary) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
