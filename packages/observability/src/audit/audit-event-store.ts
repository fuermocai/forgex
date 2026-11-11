/** Append-only JSONL query adapter for redacted observability audit events. */
import { JsonlEventStore, uuid } from '@forgex/shared';
import type { AuditEvent } from '../types.js';

export class AuditEventStore {
  private readonly events: JsonlEventStore;

  constructor(events: JsonlEventStore) {
    this.events = events;
  }

  /** Records an audit event and returns the persisted event. */
  record(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    const full: AuditEvent = { id: uuid(), timestamp: new Date().toISOString(), ...event };
    const parent = this.events.readAll().findLast((item) => item.type === 'observability.audit');
    this.events.append('observability.audit', { event: full }, parent?.id ?? null);
    return full;
  }

  /** Returns events matching a trace identifier in chronological order. */
  getByTrace(traceId: string): AuditEvent[] {
    return this.readEvents().filter((event) => event.traceId === traceId).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  /** Returns the latest events for an actor. */
  getByActor(actor: string): AuditEvent[] {
    return this.readEvents().filter((event) => event.actor === actor).sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, 100);
  }

  /** Returns the most recent events. */
  getRecent(limit = 100): AuditEvent[] {
    return this.readEvents().sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, Math.max(0, limit));
  }

  private readEvents(): AuditEvent[] {
    return this.events.readAll().filter((event) => event.type === 'observability.audit')
      .map((event) => event.data.event as AuditEvent);
  }
}
