/**
 * SessionStore：会话、消息、审计与指标的本地持久化（SQLite）。
 *
 * 为什么用 node:sqlite：
 *  - 零原生编译依赖，适合离线/内网部署（better-sqlite3 需要构建工具链）；
 *  - 单文件数据库易于备份与审计；
 *  - 不引入任何网络服务。
 *
 * 注意：Node 22 将 node:sqlite 标记为 experimental，会打印一次警告；
 * 功能可用，且数据格式是标准 SQLite 文件，后续可平滑迁移。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ForgeError,
  sessionId as newSessionId,
  type ChatMessage,
  type RunMetrics,
} from '@forgex/shared';
import type { AuditEvent, AuditSink } from '@forgex/security';

export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  model: string;
  title: string | null;
  status: string;
}

export interface CreateSessionInput {
  workspace: string;
  model: string;
  title?: string;
  id?: string;
}

export interface UpdateSessionPatch {
  title?: string;
  status?: string;
  /** 运行时切换模型后同步会话记录 */
  model?: string;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  workspace TEXT NOT NULL,
  model TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id, ts);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_session ON metrics(session_id, id);
`;

export class SessionStore implements AuditSink {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    try {
      this.db = new DatabaseSync(dbPath);
    } catch (err) {
      throw new ForgeError('SESSION_ERROR', `无法打开会话数据库: ${dbPath}`, { cause: err });
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.db.exec(SCHEMA);
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const id = input.id ?? newSessionId();
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO sessions (id, created_at, updated_at, workspace, model, title, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, now, now, input.workspace, input.model, input.title ?? null, 'active');
    return {
      id,
      createdAt: now,
      updatedAt: now,
      workspace: input.workspace,
      model: input.model,
      title: input.title ?? null,
      status: 'active',
    };
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? mapSession(row) : null;
  }

  listSessions(limit = 20): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, limit)) as Row[];
    return rows.map(mapSession);
  }

  updateSession(id: string, patch: UpdateSessionPatch): void {
    const current = this.getSession(id);
    if (!current) return;
    this.db
      .prepare('UPDATE sessions SET title = ?, status = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.title ?? current.title,
        patch.status ?? current.status,
        patch.model ?? current.model,
        new Date().toISOString(),
        id,
      );
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          'INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          sessionId,
          message.role,
          message.content,
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          message.tool_call_id ?? null,
          message.name ?? null,
          now,
        );
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    } catch (err) {
      throw new ForgeError('SESSION_ERROR', '写入会话消息失败', { cause: err, details: { sessionId } });
    }
  }

  getMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as Row[];
    return rows.map((row) => {
      const role = String(row.role);
      if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
        throw new ForgeError('SESSION_ERROR', `会话消息 ${String(row.id)} 的 role 无效`, {
          details: { sessionId, messageId: row.id, role },
        });
      }
      const message: ChatMessage = {
        role: role as ChatMessage['role'],
        content: row.content === null ? null : String(row.content),
      };
      if (typeof row.tool_calls === 'string' && row.tool_calls.length > 0) {
        try {
          const parsed: unknown = JSON.parse(row.tool_calls);
          if (!Array.isArray(parsed) || !parsed.every(isStoredToolCall)) throw new TypeError('tool_calls 结构无效');
          message.tool_calls = parsed as ChatMessage['tool_calls'];
        } catch (err) {
          throw new ForgeError('SESSION_ERROR', `会话消息 ${String(row.id)} 的工具调用历史损坏，拒绝静默丢弃`, {
            details: { sessionId, messageId: row.id },
            cause: err,
          });
        }
      }
      if (typeof row.tool_call_id === 'string') message.tool_call_id = row.tool_call_id;
      if (typeof row.name === 'string') message.name = row.name;
      return message;
    });
  }

  /** 实现 AuditSink：审计事件直接落库 */
  write(event: AuditEvent): void {
    try {
      this.db
        .prepare('INSERT OR REPLACE INTO audit_events (id, session_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
        .run(event.id, event.sessionId ?? null, event.ts, event.type, JSON.stringify(event));
    } catch (err) {
      throw new ForgeError('AUDIT_ERROR', '写入审计事件失败', { cause: err, details: { eventId: event.id } });
    }
  }

  getAuditEvents(sessionId: string, limit = 200): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT payload FROM audit_events WHERE session_id = ? ORDER BY ts DESC LIMIT ?')
      .all(sessionId, Math.max(1, limit)) as Row[];
    const events: AuditEvent[] = [];
    for (const row of rows) {
      try {
        events.push(JSON.parse(String(row.payload)) as AuditEvent);
      } catch {
        // 跳过损坏记录
      }
    }
    return events.reverse();
  }

  recordMetrics(sessionId: string, metrics: RunMetrics): void {
    this.db
      .prepare('INSERT INTO metrics (session_id, ts, payload) VALUES (?, ?, ?)')
      .run(sessionId, new Date().toISOString(), JSON.stringify(metrics));
  }

  getLatestMetrics(sessionId: string): RunMetrics | null {
    const row = this.db
      .prepare('SELECT payload FROM metrics WHERE session_id = ? ORDER BY id DESC LIMIT 1')
      .get(sessionId) as Row | undefined;
    if (!row) return null;
    try {
      return JSON.parse(String(row.payload)) as RunMetrics;
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}

function mapSession(row: Row): SessionRecord {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    workspace: String(row.workspace),
    model: String(row.model),
    title: row.title === null ? null : String(row.title),
    status: String(row.status),
  };
}

function isStoredToolCall(value: unknown): value is NonNullable<ChatMessage['tool_calls']>[number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const call = value as Record<string, unknown>;
  if (typeof call.id !== 'string' || call.id.length === 0 || call.type !== 'function') return false;
  if (!call.function || typeof call.function !== 'object' || Array.isArray(call.function)) return false;
  const fn = call.function as Record<string, unknown>;
  return typeof fn.name === 'string' && fn.name.length > 0 && typeof fn.arguments === 'string';
}
