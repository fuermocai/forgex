/**
 * 文本与字节处理工具。
 *
 * 重点保证：按 UTF-8 字节截断时不会切坏多字节字符（中文/emoji），
 * 否则会污染模型上下文并让后续 JSON 序列化出现替换符。
 */

const TRUNCATE_MARKER = '\n…[truncated]';

/** 计算字符串的 UTF-8 字节数 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 按字节安全截断字符串（保留头部与尾部，中间用标记代替） */
export function truncateUtf8(text: string, maxBytes: number, headRatio = 0.6): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  const total = byteLength(text);
  if (total <= maxBytes) return { text, truncated: false };

  const markerBytes = byteLength(TRUNCATE_MARKER);
  const budget = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.floor(budget * headRatio);
  const tailBytes = budget - headBytes;

  const head = sliceUtf8(text, 0, headBytes);
  const tail = sliceUtf8(text, byteLength(text) - tailBytes, tailBytes);
  return { text: `${head}${TRUNCATE_MARKER}${tail}`, truncated: true };
}

/** 从文本的指定字节偏移开始截取不超过 maxBytes 的完整字符片段 */
function sliceUtf8(text: string, startByte: number, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  let safeStart = Math.max(0, Math.min(startByte, buf.length));
  // 起点若落在续字节上，向后推进到下一个字符起始字节
  while (safeStart < buf.length && (buf[safeStart]! & 0xc0) === 0x80) {
    safeStart += 1;
  }
  let end = Math.min(buf.length, safeStart + maxBytes);
  // 终点若落在续字节上，回退到字符起始字节（10xxxxxx 为续字节）
  while (end > safeStart && end < buf.length && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(safeStart, end).toString('utf8');
}

/** 取字符串前 N 个字符（按码点，不会切坏代理对） */
export function takeChars(text: string, n: number): string {
  const arr = Array.from(text);
  if (arr.length <= n) return text;
  return arr.slice(0, n).join('');
}

/** 安全 JSON 序列化：不可序列化时降级为 String(value) */
export function stringifyJson(value: unknown): string {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? 'null' : out;
  } catch {
    return JSON.stringify(String(value));
  }
}

/** 人类可读字节数 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** 毫秒格式化 */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 截断单行文本，用于表格/UI */
export function ellipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
