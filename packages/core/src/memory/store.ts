/**
 * MemoryStore：Project Memory 的 SQLite 持久化层（v0.3.0 Phase 4）。
 *
 * 为什么用 node:sqlite（与 SessionStore 一致）：
 *  - 零原生编译依赖，适合离线/内网部署；
 *  - 单文件数据库易于备份与审计；
 *  - 不引入任何网络服务。
 *
 * 职责边界：
 *  - 本层只做 CRUD + 索引查询 + 软删除，不做合法性校验（见 validator.ts）、
 *    不做合并/升级决策（见 consolidator.ts）、不做召回排序（见 retriever.ts）。
 *  - supersede 采用"标记旧行 + 插入新行"，历史版本保留在表内供审计回溯。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ForgeError } from '@forgex/shared';
import type { MemoryEntry, MemoryScope } from './types.js';

/** 按条件查询记忆（所有条件为 AND，未设置的字段不过滤） */
export interface MemoryQuery {
  workspace?: string;
  scope?: MemoryScope;
  session_id?: string;
  task_id?: string;
  key?: string;
  kind?: MemoryEntry['kind'];
  /** 是否包含已被取代的记录（默认 false，只查当前有效版本链） */
  includeSuperseded?: boolean;
  /** 返回上限（默认 100） */
  limit?: number;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  session_id TEXT,
  task_id TEXT,
  workspace TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_scope_key
  ON memory_entries(workspace, scope, key);
CREATE INDEX IF NOT EXISTS idx_memory_session
  ON memory_entries(session_id, scope);
CREATE INDEX IF NOT EXISTS idx_memory_task
  ON memory_entries(task_id);
`;

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    try {
      this.db = new DatabaseSync(dbPath);
    } catch (err) {
      throw new ForgeError('MEMORY_STORE_ERROR', `无法打开记忆数据库: ${dbPath}`, { cause: err });
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.db.exec(SCHEMA);
  }

  /** 插入新记忆（不做校验，调用方需先过 validator） */
  insert(entry: MemoryEntry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO memory_entries
            (id, kind, source, scope, key, content, tags, confidence,
             created_at, updated_at, expires_at, session_id, task_id,
             workspace, evidence_refs, superseded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.kind,
          entry.source,
          entry.scope,
          entry.key,
          entry.content,
          JSON.stringify(entry.tags),
          entry.confidence,
          entry.created_at,
          entry.updated_at,
          entry.expires_at ?? null,
          entry.session_id ?? null,
          entry.task_id ?? null,
          entry.workspace,
          JSON.stringify(entry.evidence_refs),
          entry.superseded_by ?? null,
        );
    } catch (err) {
      throw new ForgeError('MEMORY_STORE_ERROR', '写入记忆失败', {
        cause: err,
        details: { id: entry.id, key: entry.key },
      });
    }
  }

  /** 按 ID 取单条（含已被取代的历史版本） */
  getById(id: string): MemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 取某个知识点（workspace+scope+key，可加 session/task 限定）的当前有效版本。
   * "当前"= superseded_by 为 NULL 的最新一条。
   */
  getCurrent(
    workspace: string,
    scope: MemoryScope,
    key: string,
    extra: { session_id?: string; task_id?: string } = {},
  ): MemoryEntry | null {
    let sql =
      'SELECT * FROM memory_entries WHERE workspace = ? AND scope = ? AND key = ? AND superseded_by IS NULL';
    const params: unknown[] = [workspace, scope, key];
    if (extra.session_id !== undefined) {
      sql += ' AND session_id = ?';
      params.push(extra.session_id);
    }
    if (extra.task_id !== undefined) {
      sql += ' AND task_id = ?';
      params.push(extra.task_id);
    }
    sql += ' ORDER BY created_at DESC LIMIT 1';
    const row = this.db.prepare(sql).get(...(params as never[])) as Row | undefined;
    return row ? mapRow(row) : null;
  }

  /** 条件查询（用于 retriever 召回与测试断言） */
  query(filter: MemoryQuery): MemoryEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.workspace !== undefined) {
      conditions.push('workspace = ?');
      params.push(filter.workspace);
    }
    if (filter.scope !== undefined) {
      conditions.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter.session_id !== undefined) {
      conditions.push('session_id = ?');
      params.push(filter.session_id);
    }
    if (filter.task_id !== undefined) {
      conditions.push('task_id = ?');
      params.push(filter.task_id);
    }
    if (filter.key !== undefined) {
      conditions.push('key = ?');
      params.push(filter.key);
    }
    if (filter.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.includeSuperseded !== true) {
      conditions.push('superseded_by IS NULL');
    }

    let sql = 'SELECT * FROM memory_entries';
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(Math.max(1, filter.limit ?? 100));

    const rows = this.db.prepare(sql).all(...(params as never[])) as Row[];
    return rows.map(mapRow);
  }

  /**
   * 软删除：把旧 entry 标记为被 newEntryId 取代。
   * 返回 false 表示目标不存在或已被取代（幂等保护）。
   */
  markSuperseded(oldId: string, newEntryId: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE memory_entries SET superseded_by = ?, updated_at = ? WHERE id = ? AND superseded_by IS NULL',
      )
      .run(newEntryId, new Date().toISOString(), oldId);
    return Number(result.changes) > 0;
  }

  /** 统计某个 workspace 下的记忆条数（默认不含已取代） */
  count(workspace: string, includeSuperseded = false): number {
    const sql = includeSuperseded
      ? 'SELECT COUNT(*) AS n FROM memory_entries WHERE workspace = ?'
      : 'SELECT COUNT(*) AS n FROM memory_entries WHERE workspace = ? AND superseded_by IS NULL';
    const row = this.db.prepare(sql).get(workspace) as Row | undefined;
    return row ? Number(row.n) : 0;
  }

  close(): void {
    this.db.close();
  }
}

function mapRow(row: Row): MemoryEntry {
  const entry: MemoryEntry = {
    id: String(row.id),
    kind: String(row.kind) as MemoryEntry['kind'],
    source: String(row.source) as MemoryEntry['source'],
    scope: String(row.scope) as MemoryEntry['scope'],
    key: String(row.key),
    content: String(row.content),
    tags: parseJsonArray(row.tags),
    confidence: Number(row.confidence),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    workspace: String(row.workspace),
    evidence_refs: parseJsonArray(row.evidence_refs),
  };
  if (row.expires_at !== null) entry.expires_at = String(row.expires_at);
  if (row.session_id !== null) entry.session_id = String(row.session_id);
  if (row.task_id !== null) entry.task_id = String(row.task_id);
  if (row.superseded_by !== null) entry.superseded_by = String(row.superseded_by);
  return entry;
}

/** 解析 JSON 数组列；损坏数据降级为空数组，避免整个查询失败 */
function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
