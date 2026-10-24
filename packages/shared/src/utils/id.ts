/** 标识符与时间工具 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** 完整 UUID */
export function uuid(): string {
  return randomUUID();
}

/**
 * 生成会话 id：短、可读、可按时间排序。
 * 格式：s_<base36 时间戳>_<随机 6 位>
 */
export function sessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `s_${ts}_${rand}`;
}

/**
 * 生成 tool_call_id。
 * 正常情况下应使用模型返回的 id；仅在模型未提供时兜底，
 * 确保 tool_call 与 tool_result 始终成对。
 */
export function toolCallId(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** 单调时钟（毫秒），用于性能指标，不受系统时间调整影响 */
export function monotonicNow(): number {
  return performance.now();
}
