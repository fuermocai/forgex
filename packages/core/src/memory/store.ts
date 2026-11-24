/** JSONL persistence for project memory entries. */
import { createHash } from 'node:crypto';
import { ForgeError, JsonlEventStore } from '@forgex/shared';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { MemoryCandidate, MemoryCandidateStatus, MemoryEntry, MemoryScope } from './types.js';

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
  private readonly path: string;
  private entryCache: { version: string; entries: MemoryEntry[] } | null = null;
  private candidateCache: { version: string; candidates: MemoryCandidate[] } | null = null;

  constructor(path: string) {
    this.path = path;
    recoverFinalCorruptRecord(path);
    this.events = new JsonlEventStore(path, { createIfMissing: false });
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
    this.invalidateCache();
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
    this.invalidateCache();
    return true;
  }

  /** Counts entries for a workspace, optionally including superseded history. */
  count(workspace: string, includeSuperseded = false): number {
    return this.readEntries(includeSuperseded).filter((entry) => entry.workspace === workspace).length;
  }

  insertCandidate(candidate: MemoryCandidate): void {
    if (this.getCandidate(candidate.id)) {
      throw new ForgeError('MEMORY_STORE_ERROR', `记忆候选 ID 已存在: ${candidate.id}`);
    }
    this.events.append('memory.candidate.proposed', { candidate });
    this.invalidateCache();
  }

  getCandidate(id: string): MemoryCandidate | null {
    return this.readCandidates().find((candidate) => candidate.id === id) ?? null;
  }

  listCandidates(filter: { workspace: string; session_id?: string; status?: MemoryCandidateStatus }): MemoryCandidate[] {
    return this.readCandidates().filter((candidate) =>
      candidate.workspace === filter.workspace
      && (filter.session_id === undefined || candidate.session_id === filter.session_id)
      && (filter.status === undefined || candidate.status === filter.status))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  setCandidateStatus(id: string, status: MemoryCandidateStatus, memoryId?: string): boolean {
    const current = this.getCandidate(id);
    if (!current || current.status !== 'pending') return false;
    this.events.append('memory.candidate.updated', {
      candidateId: id,
      status,
      updatedAt: new Date().toISOString(),
      ...(memoryId ? { memoryId } : {}),
    });
    this.invalidateCache();
    return true;
  }

  close(): void { /* JSONL appends are synchronous and require no flush. */ }

  private readEntries(includeSuperseded: boolean): MemoryEntry[] {
    const version = this.version();
    if (this.entryCache?.version === version) {
      const entries = this.entryCache.entries;
      return (includeSuperseded ? entries : entries.filter((entry) => entry.superseded_by === undefined))
        .map((entry) => JSON.parse(JSON.stringify(entry)) as MemoryEntry);
    }
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
    this.entryCache = { version, entries };
    return (includeSuperseded ? entries : entries.filter((entry) => entry.superseded_by === undefined))
      .map((entry) => JSON.parse(JSON.stringify(entry)) as MemoryEntry);
  }

  private readCandidates(): MemoryCandidate[] {
    const version = this.version();
    if (this.candidateCache?.version === version) {
      return this.candidateCache.candidates.map((candidate) => JSON.parse(JSON.stringify(candidate)) as MemoryCandidate);
    }
    const records = new Map<string, MemoryCandidate>();
    for (const event of this.events.readAll()) {
      if (event.type === 'memory.candidate.proposed') {
        const candidate = event.data.candidate;
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          const value = JSON.parse(JSON.stringify(candidate)) as MemoryCandidate;
          records.set(value.id, value);
        }
      }
      if (event.type === 'memory.candidate.updated' && typeof event.data.candidateId === 'string') {
        const current = records.get(event.data.candidateId);
        if (current && isCandidateStatus(event.data.status) && typeof event.data.updatedAt === 'string') {
          current.status = event.data.status;
          current.updated_at = event.data.updatedAt;
          if (typeof event.data.memoryId === 'string') current.memory_id = event.data.memoryId;
        }
      }
    }
    const candidates = [...records.values()];
    this.candidateCache = { version, candidates };
    return candidates.map((candidate) => JSON.parse(JSON.stringify(candidate)) as MemoryCandidate);
  }

  private version(): string {
    if (this.path === ':memory:') return `memory:${this.entryCache?.version ?? this.candidateCache?.version ?? 'initial'}`;
    if (!existsSync(this.path)) return 'missing';
    const stat = statSync(this.path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }

  private invalidateCache(): void {
    this.entryCache = null;
    this.candidateCache = null;
  }
}

function isCandidateStatus(value: unknown): value is MemoryCandidateStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected';
}

/** Keep the shared event log strict; memory alone may quarantine one corrupt trailing record. */
function recoverFinalCorruptRecord(path: string): void {
  if (path === ':memory:' || !existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ForgeError('MEMORY_STORE_ERROR', '无法读取项目记忆存储', { cause: error, details: { path } });
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isJsonlEvent(value)) throw new TypeError('invalid event record');
    } catch (error) {
      if (lines.slice(index + 1).some((tail) => tail.trim().length > 0)) {
        throw new ForgeError('MEMORY_STORE_ERROR', `项目记忆文件第 ${index + 1} 行损坏`, {
          cause: error, details: { path, line: index + 1 },
        });
      }
      try {
        const digest = createHash('sha256').update(line).digest('hex');
        appendFileSync(`${path}.corrupt`, `line=${index + 1} bytes=${Buffer.byteLength(line, 'utf8')} sha256=${digest}\n`, 'utf8');
        const validPrefix = lines.slice(0, index).join('\n').trimEnd();
        writeFileSync(path, validPrefix ? `${validPrefix}\n` : '', 'utf8');
      } catch (repairError) {
        throw new ForgeError('MEMORY_STORE_ERROR', '无法隔离损坏的项目记忆末行', {
          cause: repairError, details: { path, line: index + 1 },
        });
      }
      return;
    }
  }
}

function isJsonlEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === 'string'
    && (typeof event.parentId === 'string' || event.parentId === null)
    && typeof event.ts === 'string'
    && typeof event.type === 'string'
    && Boolean(event.data && typeof event.data === 'object' && !Array.isArray(event.data));
}
