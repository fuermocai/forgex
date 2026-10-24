/**
 * AuditEventStore：审计事件存储（v0.4.0 Phase 5）。
 *
 * 基于 SQLite 持久化审计事件。
 * 敏感数据已在写入前脱敏。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '../types.js';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    summary TEXT NOT NULL,
    target TEXT,
    result TEXT NOT NULL,
    trace_id TEXT,
    session_id TEXT
  )
`;

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id)`;

export class AuditEventStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(CREATE_TABLE);
    db.exec(CREATE_INDEX);
  }

  /** 记录审计事件 */
  record(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    const full: AuditEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    this.db
      .prepare(
        `INSERT INTO audit_events (id, timestamp, action, actor, risk_level, summary, target, result, trace_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.timestamp,
        full.action,
        full.actor,
        full.riskLevel,
        full.summary,
        full.target ?? null,
        full.result,
        full.traceId ?? null,
        full.sessionId ?? null,
      );

    return full;
  }

  /** 按 traceId 查询 */
  getByTrace(traceId: string): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events WHERE trace_id = ? ORDER BY timestamp ASC')
      .all(traceId) as Array<Record<string, unknown>>;
    return rows.map(this.mapRow);
  }

  /** 按 actor 查询 */
  getByActor(actor: string): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events WHERE actor = ? ORDER BY timestamp DESC LIMIT 100')
      .all(actor) as Array<Record<string, unknown>>;
    return rows.map(this.mapRow);
  }

  /** 获取最近 N 条 */
  getRecent(limit = 100): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(this.mapRow);
  }

  private mapRow(row: Record<string, unknown>): AuditEvent {
    return {
      id: String(row.id),
      timestamp: String(row.timestamp),
      action: String(row.action),
      actor: String(row.actor),
      riskLevel: String(row.risk_level),
      summary: String(row.summary),
      target: row.target ? String(row.target) : undefined,
      result: row.result as AuditEvent['result'],
      traceId: row.trace_id ? String(row.trace_id) : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
    };
  }
}
