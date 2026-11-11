/** JSONL persistence for project memory entries. */
import { ForgeError, JsonlEventStore } from '@forgex/shared';
import type { MemoryEntry, MemoryScope } from './types.js';

/** Optional filters for memory lookup. */
export interface MemoryQuery {
  workspace?: string;
  scope?: MemoryScope;
  session_id?: string;
  task_id?: string;
  key?: string;
  kind?: MemoryEntry['kind'];
  includeSuperseded?: boolean;
  limit?: number;
}

export class MemoryStore {
  private readonly events: JsonlEventStore;

  constructor(path: string) {
    this.events = new JsonlEventStore(path);
  }

  /** Appends a memory entry after validation by the caller. */
  insert(entry: MemoryEntry): void {
    if (this.getById(entry.id)) {
      throw new ForgeError('MEMORY_STORE_ERROR', `记忆 ID 已存在: ${entry.id}`, {
        details: { memoryId: entry.id },
      });
    }
    const parent = this.events.readAll().findLast((event) => event.data.entryId === entry.id);
    this.events.append('memory.entry.saved', { entryId: entry.id, entry }, parent?.id ?? null);
  }

  /** Returns a memory entry by ID, including superseded entries. */
  getById(id: string): MemoryEntry | null {
    return this.readEntries(true).find((entry) => entry.id === id) ?? null;
  }

  /** Returns the latest unsuperseded entry for a workspace, scope and key. */
  getCurrent(workspace: string, scope: MemoryScope, key: string, extra: { session_id?: string; task_id?: string } = {}): MemoryEntry | null {
    return this.readEntries(false).filter((entry) => entry.workspace === workspace && entry.scope === scope && entry.key === key
      && (extra.session_id === undefined || entry.session_id === extra.session_id)
      && (extra.task_id === undefined || entry.task_id === extra.task_id))
      .sort((left, right) => right.created_at.localeCompare(left.created_at))[0] ?? null;
  }

  /** Queries memory entries using AND semantics for every supplied filter. */
  query(filter: MemoryQuery): MemoryEntry[] {
    return this.readEntries(filter.includeSuperseded === true).filter((entry) =>
      (filter.workspace === undefined || entry.workspace === filter.workspace)
      && (filter.scope === undefined || entry.scope === filter.scope)
      && (filter.session_id === undefined || entry.session_id === filter.session_id)
      && (filter.task_id === undefined || entry.task_id === filter.task_id)
      && (filter.key === undefined || entry.key === filter.key)
      && (filter.kind === undefined || entry.kind === filter.kind))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, Math.max(1, filter.limit ?? 100));
  }

  /** Marks an active entry as superseded; returns false when it is absent or already superseded. */
  markSuperseded(oldId: string, newEntryId: string): boolean {
    const entry = this.getById(oldId);
    if (!entry || entry.superseded_by !== undefined) return false;
    const updatedAt = new Date().toISOString();
    const parent = this.events.readAll().findLast((event) => event.data.entryId === oldId);
    this.events.append('memory.entry.superseded', { entryId: oldId, supersededBy: newEntryId, updatedAt }, parent?.id ?? null);
    return true;
  }

  /** Counts entries for a workspace, optionally including superseded history. */
  count(workspace: string, includeSuperseded = false): number {
    return this.readEntries(includeSuperseded).filter((entry) => entry.workspace === workspace).length;
  }

  close(): void { /* JSONL appends are synchronous and require no flush. */ }

  private readEntries(includeSuperseded: boolean): MemoryEntry[] {
    const records = new Map<string, MemoryEntry>();
    for (const event of this.events.readAll()) {
      if (event.type === 'memory.entry.saved' && typeof event.data.entryId === 'string') {
        const entry = event.data.entry;
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          records.set(event.data.entryId, JSON.parse(JSON.stringify(entry)) as MemoryEntry);
        }
      }
      if (event.type === 'memory.entry.superseded' && typeof event.data.entryId === 'string') {
        const current = records.get(event.data.entryId);
        if (current && typeof event.data.supersededBy === 'string' && typeof event.data.updatedAt === 'string') {
          current.superseded_by = event.data.supersededBy;
          current.updated_at = event.data.updatedAt;
        }
      }
    }
    const entries = [...records.values()];
    return includeSuperseded ? entries : entries.filter((entry) => entry.superseded_by === undefined);
  }
}
