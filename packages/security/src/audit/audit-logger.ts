/**
 * AuditLogger：不可静默失败的操作审计。
 *
 * 设计取舍：
 *  - 审计写失败不能让 Agent 崩溃，但必须记录错误（AUDIT_ERROR），否则等于丢失证据链；
 *  - 事件在进入 sink 前统一脱敏，API Key / 密码不会落盘；
 *  - 支持多 sink（JSONL 文件 + 会话数据库内存队列），便于后续接入企业 SIEM；
 *  - 事件 id 使用 UUID，ts 使用 ISO 字符串，便于跨时区检索。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactValue, type Logger, type PolicyDecision, type RiskLevel } from '@forgex/shared';
import type { ApprovalDecision } from '../approval/approval-manager.js';

export type AuditEventType =
  | 'session'
  | 'policy_decision'
  | 'approval'
  | 'tool_call'
  | 'tool_result'
  | 'file_write'
  | 'command'
  | 'error';

export interface AuditEvent {
  id: string;
  ts: string;
  type: AuditEventType;
  sessionId?: string;
  callId?: string;
  tool?: string;
  riskLevel?: RiskLevel;
  decision?: PolicyDecision | ApprovalDecision;
  ok?: boolean;
  durationMs?: number;
  reason?: string;
  actor?: 'agent' | 'user' | 'system';
  input?: unknown;
  output?: unknown;
  meta?: Record<string, unknown>;
}

export type AuditEventInput = Omit<AuditEvent, 'id' | 'ts'> & { ts?: string };

export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>;
}

export interface AuditLoggerOptions {
  sinks?: AuditSink[];
  filePath?: string;
  logger?: Logger;
}

export class AuditLogger {
  private readonly sinks: AuditSink[] = [];
  private readonly logger: Logger | undefined;

  constructor(options: AuditLoggerOptions = {}) {
    this.sinks.push(...(options.sinks ?? []));
    if (options.filePath) this.sinks.push(new JsonlFileSink(options.filePath));
    this.logger = options.logger;
  }

  /** 追加一条审计事件，返回事件 id；本方法不会抛异常 */
  async record(input: AuditEventInput): Promise<string> {
    const event: AuditEvent = {
      ...input,
      id: randomUUID(),
      ts: input.ts ?? new Date().toISOString(),
    };
    const safe = redactValue(event) as AuditEvent;

    // 用 Promise.resolve().then 包裹，保证同步抛错也进入 allSettled 的 rejected 分支
    const results = await Promise.allSettled(
      this.sinks.map((sink) => Promise.resolve().then(() => sink.write(safe))),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger?.error('审计写入失败', {
          code: 'AUDIT_ERROR',
          sink: index,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          eventId: event.id,
        });
      }
    });
    return event.id;
  }
}

/** JSONL 文件 sink：每行一个事件，便于 Loki / Filebeat 采集 */
export class JsonlFileSink implements AuditSink {
  private readonly filePath: string;
  private dirReady: Promise<void> | null = null;

  constructor(filePath: string) {
    if (!filePath) throw new Error('JsonlFileSink 需要文件路径');
    this.filePath = filePath;
  }

  async write(event: AuditEvent): Promise<void> {
    this.dirReady ??= mkdir(dirname(this.filePath), { recursive: true }).then(() => undefined);
    await this.dirReady;
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

/** 内存 sink：测试与"审计事件同步写入会话库"场景使用 */
export class MemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 1000) {
    this.maxEvents = Math.max(1, maxEvents);
  }

  write(event: AuditEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
  }

  get all(): ReadonlyArray<AuditEvent> {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
  }
}
