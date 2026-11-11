/** Append-only JSONL persistence for scoped approval records. */
import { ForgeError, JsonlEventStore } from '@forgex/shared';
import type { ApprovalRecord, ApprovalStatus } from '../types.js';
import { approvalNowIso } from '../types.js';

export class ApprovalStore {
  private readonly events: JsonlEventStore;

  constructor(events: JsonlEventStore) {
    this.events = events;
  }

  /** Creates or replaces an approval record. */
  create(record: ApprovalRecord): void {
    this.append('approval.saved', record);
  }

  /** Returns one approval record, if present. */
  get(id: string): ApprovalRecord | null {
    return this.latestRecords().get(id) ?? null;
  }

  /** Returns records that share a scope hash, newest first. */
  listByScope(scopeHash: string): ApprovalRecord[] {
    return [...this.latestRecords().values()]
      .filter((record) => record.scope.paramHash === scopeHash)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Updates the state of an existing approval record. */
  updateStatus(id: string, status: ApprovalStatus, approver?: string, denialReason?: string): void {
    const record = this.get(id);
    if (!record) {
      throw new ForgeError('APPROVAL_REVOKED', `审批记录不存在: ${id}`, { details: { approvalId: id } });
    }
    record.status = status;
    record.decidedAt = approvalNowIso();
    if (approver) record.approver = approver;
    if (denialReason) record.denialReason = denialReason;
    this.append('approval.updated', record);
  }

  /** Marks pending and approved records past their expiry as expired. */
  expireOutdated(): number {
    const now = approvalNowIso();
    let expired = 0;
    for (const record of this.latestRecords().values()) {
      if ((record.status === 'pending' || record.status === 'approved') && record.scope.expiresAt < now) {
        this.updateStatus(record.id, 'expired');
        expired += 1;
      }
    }
    return expired;
  }

  /** Checks for an approved, unexpired record with the given scope hash. */
  hasValidApproval(scopeHash: string): boolean {
    const now = approvalNowIso();
    return this.listByScope(scopeHash).some((record) => record.status === 'approved' && record.scope.expiresAt > now);
  }

  private append(type: string, record: ApprovalRecord): void {
    const parent = this.events.readAll().findLast((event) => event.data.approvalId === record.id);
    this.events.append(type, { approvalId: record.id, record }, parent?.id ?? null);
  }

  private latestRecords(): Map<string, ApprovalRecord> {
    const records = new Map<string, ApprovalRecord>();
    for (const event of this.events.readAll()) {
      if ((event.type !== 'approval.saved' && event.type !== 'approval.updated') || typeof event.data.approvalId !== 'string') continue;
      const record = event.data.record;
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        records.set(event.data.approvalId, JSON.parse(JSON.stringify(record)) as ApprovalRecord);
      }
    }
    return records;
  }
}
