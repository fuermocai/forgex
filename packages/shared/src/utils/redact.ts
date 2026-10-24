/**
 * 敏感信息脱敏。
 *
 * 使用场景：
 *  - 结构化日志 / 审计事件
 *  - 工具输入输出进入模型上下文前
 *  - 会话持久化
 *
 * 注意：脱敏是"降低泄露概率"，不是强保证。API Key 本身只允许存在于
 * Provider 的认证头中，任何日志路径都不应传入原始 key。
 */

// session id 不属于凭证：审计需要它做会话关联，因此不在此处脱敏
const SECRET_KEY = /(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|bearer|cookie|credential|private[-_]?key)/i;

/** 常见凭证字面量模式 */
const VALUE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***'],
  [/\b(sk|pk|ak|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, '$1-***'],
  [/(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, '$1***'],
  [/((?:api[-_]?key|token|secret|password|passwd)\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi, '$1***'],
  [/(\/\/[^:/@\s]+:)[^@\s]+(@)/g, '$1***$2'],
];

/** 对任意文本做凭证替换 */
export function redactText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 判断一个字段名是否属于敏感字段 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/**
 * 结构化脱敏。
 *  - 深度上限 8 层，超出直接标记，避免循环引用/超深对象拖垮日志。
 *  - 敏感 key 的 value 一律替换为 ***。
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[truncated:depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((v) => redactValue(v, depth + 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = isSecretKey(k) ? '***' : redactValue(v, depth + 1, seen);
  }
  return result;
}

/** 生成脱敏后的 JSON 字符串（用于日志） */
export function safeStringify(value: unknown, maxLength = 4000): string {
  let json: string;
  try {
    json = JSON.stringify(redactValue(value));
  } catch {
    json = String(value);
  }
  if (json.length > maxLength) {
    return `${json.slice(0, maxLength)}…[+${json.length - maxLength} chars]`;
  }
  return json;
}
