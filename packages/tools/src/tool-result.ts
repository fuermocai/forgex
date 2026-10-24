/**
 * 工具结果构造辅助函数。
 *
 * 统一出口可以避免每个工具手写结构，减少"ok=false 却忘记带 error"这类缺陷。
 */
import type { JsonValue, ToolErrorInfo, ToolOutcome } from '@forgex/shared';

/**
 * 成功结果。
 * 泛型不约束为 JsonValue：工具内部常用带明确字段的 interface（没有索引签名），
 * 它们运行时都是可 JSON 序列化的，这里统一转换，避免每个工具写 as 断言。
 */
export function toolOk<T>(
  summary: string,
  data?: T,
  truncated?: boolean,
): ToolOutcome<JsonValue> {
  return {
    ok: true,
    summary,
    ...(data !== undefined ? { data: data as unknown as JsonValue } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

export function toolError(
  code: string,
  message: string,
  options: { retryable?: boolean; details?: JsonValue; summary?: string } = {},
): ToolOutcome<JsonValue> {
  const error: ToolErrorInfo = {
    code,
    message,
    ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
    ...(options.details !== undefined ? { details: options.details } : {}),
  };
  return {
    ok: false,
    summary: options.summary ?? `${code}: ${message}`,
    error,
  };
}

/** 把异常转换为工具错误（工具内部兜底使用） */
export function errorToOutcome(err: unknown, fallbackCode = 'TOOL_FAILED'): ToolOutcome<JsonValue> {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: unknown; message: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      return toolError(e.code, e.message);
    }
  }
  return toolError(fallbackCode, err instanceof Error ? err.message : String(err));
}
