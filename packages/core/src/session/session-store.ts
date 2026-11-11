/** JSONL-backed session, audit, metric, task and checkpoint event store. */
import {
  ForgeError,
  sessionId as newSessionId,
  type ChatMessage,
  type RunMetrics,
} from '@forgex/shared';
import type { AuditEvent, AuditSink } from '@forgex/security';
import { JsonlEventStore, type JsonlEvent } from './jsonl-event-store.js';

export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  model: string;
  title: string | null;
  status: string;
  parentSessionId?: string;
  parentMessageId?: string;
}
export interface CreateSessionInput { workspace: string; model: string; title?: string; id?: string; parentSessionId?: string; parentMessageId?: string; }
export interface UpdateSessionPatch { title?: string; status?: string; model?: string; }
type Row = Record<string, unknown>;

export class SessionStore implements AuditSink {
  private readonly log: JsonlEventStore;
  private events: JsonlEvent[];

  constructor(path: string) {
    this.log = new JsonlEventStore(path);
    this.events = this.log.readAll();
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: input.id ?? newSessionId(), createdAt: now, updatedAt: now,
      workspace: input.workspace, model: input.model, title: input.title ?? null, status: 'active',
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    };
    this.push('session.created', record as unknown as Row, input.parentMessageId ?? null);
    return record;
  }

  getSession(id: string): SessionRecord | null {
    let session: SessionRecord | null = null;
    for (const event of this.latestEvents()) {
      if (event.type === 'session.created' && event.data.id === id) session = event.data as unknown as SessionRecord;
      else if (event.type === 'session.updated' && event.data.id === id && session) {
        const patch = isRecord(event.data.patch) ? event.data.patch : {};
        session = Object.assign({}, session, patch, { updatedAt: event.ts }) as SessionRecord;
      }
    }
    return session;
  }

  listSessions(limit = 20): SessionRecord[] {
    const ids = new Set(this.latestEvents().filter((event) => event.type === 'session.created').map((event) => String(event.data.id)));
    return [...ids].map((id) => this.getSession(id)).filter((item): item is SessionRecord => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(1, limit));
  }

  updateSession(id: string, patch: UpdateSessionPatch): void {
    if (!this.getSession(id)) return;
    const parent = this.latestEvents().findLast((event) => event.data.id === id && (event.type === 'session.created' || event.type === 'session.updated'));
    this.push('session.updated', { id, patch }, parent?.id ?? null);
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    if (!this.getSession(sessionId)) throw new ForgeError('SESSION_ERROR', `会话不存在: ${sessionId}`);
    const parent = this.listMessageEntries(sessionId).at(-1)?.id
      ?? this.latestEvents().find((event) => event.type === 'session.created' && event.data.id === sessionId)?.id
      ?? null;
    this.push('message.appended', { sessionId, message }, parent);
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.latestEvents().filter((event) => event.type === 'message.appended' && event.data.sessionId === sessionId)
      .map((event) => event.data.message as ChatMessage);
  }

  listMessageEntries(sessionId: string): Array<{ id: string; message: ChatMessage }> {
    return this.latestEvents().filter((event) => event.type === 'message.appended' && event.data.sessionId === sessionId)
      .map((event) => ({ id: event.id, message: event.data.message as ChatMessage }));
  }

  forkSession(sessionId: string, messageId?: string, newId?: string): SessionRecord {
    const source = this.getSession(sessionId);
    if (!source) throw new ForgeError('SESSION_ERROR', `源会话不存在: ${sessionId}`);
    const entries = this.listMessageEntries(sessionId);
    const index = messageId === undefined ? entries.length - 1 : entries.findIndex((entry) => entry.id === messageId);
    if (messageId !== undefined && index < 0) throw new ForgeError('SESSION_ERROR', `分支起点不存在: ${messageId}`);
    const forkPoint = index >= 0 ? entries[index]!.id : undefined;
    const branch = this.createSession({ workspace: source.workspace, model: source.model, title: source.title ? `${source.title} (branch)` : undefined,
      ...(newId ? { id: newId } : {}), parentSessionId: sessionId, ...(forkPoint ? { parentMessageId: forkPoint } : {}) });
    for (const entry of entries.slice(0, index + 1)) this.appendMessage(branch.id, entry.message);
    return branch;
  }

  write(event: AuditEvent): void { this.appendEvent('audit.recorded', { event, sessionId: event.sessionId ?? null }); }

  getAuditEvents(sessionId: string, limit = 200): AuditEvent[] {
    return this.latestEvents().filter((event) => event.type === 'audit.recorded' && event.data.sessionId === sessionId)
      .slice(-Math.max(1, limit)).map((event) => event.data.event as AuditEvent);
  }

  recordMetrics(sessionId: string, metrics: RunMetrics): void { this.appendEvent('metrics.recorded', { sessionId, metrics }); }

  getLatestMetrics(sessionId: string): RunMetrics | null {
    const event = this.latestEvents().findLast((item) => item.type === 'metrics.recorded' && item.data.sessionId === sessionId);
    return (event?.data.metrics as RunMetrics | undefined) ?? null;
  }

  /** Used by the task/checkpoint JSONL adapters to share this same event stream. */
  appendEvent(type: string, data: Row, parentId: string | null = null): JsonlEvent {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
    const parent = parentId ?? (sessionId
      ? this.latestEvents().findLast((event) => event.type === 'message.appended' && event.data.sessionId === sessionId)?.id ?? null
      : null);
    return this.push(type, data, parent);
  }
  readEvents(type?: string): JsonlEvent[] { return this.latestEvents().filter((event) => !type || event.type === type); }
  get filePath(): string { return this.log.filePath; }
  close(): void { /* synchronous append-only file; nothing to flush */ }

  private push(type: string, data: Row, parentId: string | null = null): JsonlEvent {
    const event = this.log.append(type, data, parentId);
    this.events.push(event);
    return event;
  }
  private latestEvents(): JsonlEvent[] {
    this.events = this.log.readAll();
    return this.events;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
