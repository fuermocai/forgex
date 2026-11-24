import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ForgeError } from '../errors/index.js';
import { uuid } from './id.js';

/** Append-only JSONL event record. */
export interface JsonlEvent {
  id: string;
  parentId: string | null;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

export interface JsonlEventStoreOptions {
  /** Avoid creating an empty log during read-only access; append creates it on demand. */
  createIfMissing?: boolean;
}

/** Append-only event log shared by all persistent ForgeX subsystems. */
export class JsonlEventStore {
  private readonly path: string;
  private readonly memoryEvents: JsonlEvent[] | null;
  private readonly createIfMissing: boolean;
  private cache: JsonlEvent[] | null = null;
  private cacheSize = -1;

  constructor(path: string, options: JsonlEventStoreOptions = {}) {
    this.path = path;
    this.memoryEvents = path === ':memory:' ? [] : null;
    this.createIfMissing = options.createIfMissing ?? true;
    if (path !== ':memory:') {
      if (this.createIfMissing) {
        mkdirSync(dirname(path), { recursive: true });
        if (!existsSync(path)) closeSync(openSync(path, 'a'));
      }
    }
  }

  readAll(): JsonlEvent[] {
    if (this.memoryEvents) return this.memoryEvents.map(cloneEvent);
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (this.cache && size === this.cacheSize) return this.cache.map(cloneEvent);
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new ForgeError('SESSION_ERROR', `无法读取事件文件: ${this.path}`, { cause: err });
    }
    const events: JsonlEvent[] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!isJsonlEvent(value)) throw new TypeError('事件字段无效');
        events.push(value);
      } catch (err) {
        throw new ForgeError('SESSION_ERROR', `事件文件第 ${index + 1} 行损坏，拒绝忽略`, {
          cause: err,
          details: { path: this.path, line: index + 1 },
        });
      }
    }
    this.cache = events;
    this.cacheSize = size;
    return events.map(cloneEvent);
  }

  append(type: string, data: Record<string, unknown>, parentId: string | null = null): JsonlEvent {
    const event: JsonlEvent = { id: uuid(), parentId, ts: new Date().toISOString(), type, data };
    const line = `${JSON.stringify(event)}\n`;
    try {
      if (this.memoryEvents) this.memoryEvents.push(event);
      else {
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, line, { encoding: 'utf8', flag: 'a' });
        this.cache?.push(event);
        this.cacheSize = statSync(this.path).size;
      }
    } catch (err) {
      throw new ForgeError('SESSION_ERROR', `写入事件失败: ${type}`, { cause: err, details: { path: this.path } });
    }
    return cloneEvent(event);
  }

  get filePath(): string { return this.path; }

  close(): void { /* Appends are synchronous; there is no open descriptor to flush. */ }
}

function isJsonlEvent(value: unknown): value is JsonlEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === 'string'
    && (typeof event.parentId === 'string' || event.parentId === null)
    && typeof event.ts === 'string'
    && typeof event.type === 'string'
    && Boolean(event.data && typeof event.data === 'object' && !Array.isArray(event.data));
}

function cloneEvent(event: JsonlEvent): JsonlEvent {
  return { ...event, data: { ...event.data } };
}
