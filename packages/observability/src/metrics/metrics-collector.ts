/**
 * MetricsCollector：指标收集器（v0.4.0 Phase 5）。
 *
 * 支持：
 *   - 指标记录；
 *   - P50/P95 延迟计算；
 *   - 计数、求和、平均。
 */
import type { MetricRecord } from '../types.js';

export class MetricsCollector {
  private readonly records: MetricRecord[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords = 100000) {
    this.maxRecords = maxRecords;
  }

  /** 记录指标 */
  record(name: string, value: number, tags: Record<string, string> = {}): void {
    this.records.push({
      name,
      value,
      timestamp: new Date().toISOString(),
      tags,
    });
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  /** 获取指定指标的所有值 */
  getValues(name: string, tags?: Record<string, string>): number[] {
    return this.records
      .filter((r) => {
        if (r.name !== name) return false;
        if (tags) {
          return Object.entries(tags).every(([k, v]) => r.tags[k] === v);
        }
        return true;
      })
      .map((r) => r.value);
  }

  /** 计算 P50 */
  p50(name: string, tags?: Record<string, string>): number {
    return this.percentile(name, 50, tags);
  }

  /** 计算 P95 */
  p95(name: string, tags?: Record<string, string>): number {
    return this.percentile(name, 95, tags);
  }

  /** 计算 P99 */
  p99(name: string, tags?: Record<string, string>): number {
    return this.percentile(name, 99, tags);
  }

  /** 计数 */
  count(name: string, tags?: Record<string, string>): number {
    return this.getValues(name, tags).length;
  }

  /** 求和 */
  sum(name: string, tags?: Record<string, string>): number {
    return this.getValues(name, tags).reduce((a, b) => a + b, 0);
  }

  /** 平均 */
  average(name: string, tags?: Record<string, string>): number {
    const values = this.getValues(name, tags);
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /** 获取所有记录 */
  getAll(): MetricRecord[] {
    return [...this.records];
  }

  /** 清空 */
  clear(): void {
    this.records.length = 0;
  }

  private percentile(name: string, p: number, tags?: Record<string, string>): number {
    const values = this.getValues(name, tags).sort((a, b) => a - b);
    if (values.length === 0) return 0;
    const idx = Math.ceil((p / 100) * values.length) - 1;
    return values[Math.max(0, Math.min(idx, values.length - 1))] ?? 0;
  }
}
