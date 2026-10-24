/**
 * ApprovalStore：审批记录持久化（v0.4.0 Phase 3）。
 *
 * 存储策略（复用 node:sqlite 模式）：
 *   - 整个 ApprovalRecord 存单个 JSON blob 列（payload TEXT）；
 *   - 表结构：approvals(id TEXT PK, status TEXT, scope_hash TEXT, payload TEXT, created_at TEXT)；
 *   - 额外索引 scope_hash 用于按范围查询。
 *
 * 支持：create、get、listByScope、updateStatus、expireOutdated。
 */
import { DatabaseSync } from 'node:sqlite';
import { ForgeError } from '@forgex/shared';
import type { ApprovalRecord, ApprovalStatus } from '../types.js';
import { approvalNowIso } from '../types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_scope_hash ON approvals(scope_hash);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
`;

export class ApprovalStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA busy_timeout = 3000');
    } catch {
      // WAL 设置失败不阻塞
    }
    try {
      this.db.exec(SCHEMA);
    } catch (err) {
      throw new ForgeError('INTERNAL', '无法初始化 approvals 表', { cause: err });
    }
  }

  /** 创建审批记录 */
  create(record: ApprovalRecord): void {
    try {
      const payload = JSON.stringify(record);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO approvals (id, status, scope_hash, operation, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.status,
          record.scope.paramHash,
          record.operation,
          payload,
          record.createdAt,
        );
    } catch (err) {
      throw new ForgeError('INTERNAL', `创建审批记录失败: ${record.id}`, {
        cause: err,
        details: { approvalId: record.id },
      });
    }
  }

  /** 获取审批记录 */
  get(id: string): ApprovalRecord | null {
    try {
      const row = this.db
        .prepare('SELECT payload FROM approvals WHERE id = ?')
        .get(id) as { payload: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.payload) as ApprovalRecord;
    } catch (err) {
      throw new ForgeError('INTERNAL', `读取审批记录失败: ${id}`, {
        cause: err,
        details: { approvalId: id },
      });
    }
  }

  /** 按 scope hash 查询审批记录 */
  listByScope(scopeHash: string): ApprovalRecord[] {
    try {
      const rows = this.db
        .prepare('SELECT payload FROM approvals WHERE scope_hash = ? ORDER BY created_at DESC')
        .all(scopeHash) as Array<{ payload: string }>;
      return rows.map((r) => JSON.parse(r.payload) as ApprovalRecord);
    } catch (err) {
      throw new ForgeError('INTERNAL', '按范围查询审批记录失败', {
        cause: err,
        details: { scopeHash },
      });
    }
  }

  /** 更新审批状态 */
  updateStatus(id: string, status: ApprovalStatus, approver?: string, denialReason?: string): void {
    const record = this.get(id);
    if (!record) {
      throw new ForgeError('APPROVAL_REVOKED', `审批记录不存在: ${id}`, {
        details: { approvalId: id },
      });
    }
    record.status = status;
    record.decidedAt = approvalNowIso();
    if (approver) record.approver = approver;
    if (denialReason) record.denialReason = denialReason;

    try {
      const payload = JSON.stringify(record);
      this.db
        .prepare('UPDATE approvals SET status = ?, payload = ? WHERE id = ?')
        .run(status, payload, id);
    } catch (err) {
      throw new ForgeError('INTERNAL', `更新审批状态失败: ${id}`, {
        cause: err,
        details: { approvalId: id },
      });
    }
  }

  /** 将过期的审批标记为 expired */
  expireOutdated(): number {
    const now = approvalNowIso();
    const rows = this.db
      .prepare("SELECT payload FROM approvals WHERE status IN ('pending', 'approved')")
      .all() as Array<{ payload: string }>;

    let expired = 0;
    for (const row of rows) {
      const record = JSON.parse(row.payload) as ApprovalRecord;
      if (record.scope.expiresAt < now) {
        this.updateStatus(record.id, 'expired');
        expired++;
      }
    }
    return expired;
  }

  /** 检查指定 scope 是否有有效的（approved 且未过期）审批 */
  hasValidApproval(scopeHash: string): boolean {
    const records = this.listByScope(scopeHash);
    const now = approvalNowIso();
    return records.some(
      (r) => r.status === 'approved' && r.scope.expiresAt > now,
    );
  }
}
