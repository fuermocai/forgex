/**
 * SpanRecorder：Span 记录器（v0.4.0 Phase 5）。
 *
 * 负责将 Span 写入存储（内存或文件）。
 * 支持敏感数据脱敏。
 */
import { redactValue } from '@forgex/shared';
import type { SpanRecord } from '../types.js';

export class SpanRecorder {
  private readonly records: SpanRecord[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords = 10000) {
    this.maxRecords = maxRecords;
  }

  /** 记录 span（自动脱敏） */
  record(span: SpanRecord): void {
    const sanitized = this.sanitize(span);
    this.records.push(sanitized);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  /** 获取所有记录 */
  getAll(): SpanRecord[] {
    return [...this.records];
  }

  /** 按 traceId 查询 */
  getByTrace(traceId: string): SpanRecord[] {
    return this.records.filter((s) => s.traceId === traceId);
  }

  /** 清空 */
  clear(): void {
    this.records.length = 0;
  }

  /** 脱敏敏感属性 */
  private sanitize(span: SpanRecord): SpanRecord {
    // redactValue 对整个对象做结构化脱敏：
    // 敏感 key 的 value 替换为 ***，字符串内容按模式替换
    const sanitizedAttrs = redactValue(span.attributes) as Record<string, unknown>;
    return { ...span, attributes: sanitizedAttrs };
  }
}
