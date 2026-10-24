/**
 * 日志异常聚合器（log-aggregator）。
 *
 * 按行扫描，识别异常事件边界，提取 Severity/Kind/Context，
 * 对每个事件块调 stack-parser 解析堆栈帧。
 */
import type { LogAggregateInput, LogEvent, Severity } from './types.js';
import { detectLanguage, parseStack } from './stack-parser.js';

/* ------------------------------------------------------------------ */
/* 事件起始关键字                                                       */
/* ------------------------------------------------------------------ */

interface EventStartPattern {
  re: RegExp;
  severity: 'error' | 'fatal' | 'warn';
  kind?: string;
}

const EVENT_START_PATTERNS: readonly EventStartPattern[] = [
  // 1. 最具体：Exception / Traceback / RangeError 等命名异常
  { re: /Traceback\s*\(most recent call last\)/, severity: 'error', kind: 'PythonTraceback' },
  { re: /(?:Caused\s+by:\s*)?([\w.$]+(?:Exception|Error|Throwable))/, severity: 'error' },
  { re: /\b(TypeError|ReferenceError|SyntaxError|RangeError|NullPointerException|IllegalArgumentException|OutOfMemoryError):/, severity: 'error' },
  // 2. HTTP 5xx
  { re: /\b5\d{2}\b\s+(?:Internal Server Error|Service Unavailable|...|Bad Gateway)/, severity: 'error', kind: 'HTTP5xx' },
  { re: /(?:HTTP|Status)\s*[:=]\s*5\d{2}\b/, severity: 'error', kind: 'HTTP5xx' },
  // 3. 严重级别关键字（通用，放最后）
  { re: /(?:^|\s)(FATAL|SEVERE|CRITICAL)\b/i, severity: 'fatal' },
  { re: /(?:^|\s)ERROR\b/i, severity: 'error' },
  { re: /(?:^|\s)(ERR|E)\b/i, severity: 'error' },
  { re: /(?:^|\s)(WARN|WARNING|W)\b/i, severity: 'warn' },
  // 4. 常见错误短语
  { re: /(?:connection refused|connection reset by peer|timed?\s*out|no such file|permission denied)\b/i, severity: 'warn', kind: 'IOError' },
];

/* ------------------------------------------------------------------ */
/* 聚合函数                                                              */
/* ------------------------------------------------------------------ */

export function aggregateLogEvents(input: LogAggregateInput): LogEvent[] {
  const text = input.text;
  const hintLang = input.hintLanguage;
  if (!text || text.length === 0) return [];

  const lines = text.split('\n');
  const events: LogEvent[] = [];
  const maxEvents = input.options?.maxEvents ?? 20;
  const contextAfter = input.options?.contextLinesAfter ?? 30;

  let i = 0;
  while (i < lines.length && events.length < maxEvents) {
    const line = lines[i] ?? '';
    const match = detectEventStart(line);
    if (!match) { i++; continue; }

    const startLine = i;
    const blockLines = [line];

    for (let j = i + 1; j < lines.length && j - i < contextAfter; j++) {
      const next = lines[j];
      if (next === undefined) break;
      const trimmedNext = next.trimStart();
      if (trimmedNext.length === 0) {
        if (j + 1 < lines.length && !isStackTraceContinuing(lines[j + 1] ?? '', line)) break;
        blockLines.push(next);
        continue;
      }
      if (trimmedNext === next && detectEventStart(next)) break;
      blockLines.push(next);
    }

    const raw = blockLines.join('\n');
    const language = hintLang ?? detectLanguage(raw);
    const frames = parseStack(raw, language);
    const context = extractContext(raw);

    events.push({
      lineStart: startLine,
      lineEnd: startLine + blockLines.length,
      severity: match.severity as Severity,
      kind: match.kind ?? inferKindFromException(match.capture ?? raw),
      raw,
      language,
      stack: frames,
      context,
    });

    i += blockLines.length;
  }

  return events;
}

/* ------------------------------------------------------------------ */
/* 内部辅助                                                              */
/* ------------------------------------------------------------------ */

interface EventMatch {
  severity: 'error' | 'fatal' | 'warn';
  kind?: string;
  capture?: string;
}

function detectEventStart(line: string): EventMatch | null {
  for (const p of EVENT_START_PATTERNS) {
    const m = line.match(p.re);
    if (m) {
      return {
        severity: p.severity,
        kind: p.kind,
        capture: m[1],
      };
    }
  }
  return null;
}

function isStackTraceContinuing(next: string, _currentStart: string): boolean {
  if (!next.trim()) return false;
  const leadingWs = next.match(/^[ \t]+/);
  const indent = leadingWs ? leadingWs[0].length : 0;
  if (indent < 4) {
    if (/^\s*at\s+/.test(next) || /^\s*File\s+"/.test(next) || /^\s+Caused\s+by:/.test(next)) return true;
    return false;
  }
  return true;
}

function inferKindFromException(text: string): string {
  const m = text.match(/(\w+(?:Exception|Error|Throwable))/);
  if (m && m[1]) return m[1];
  return 'Exception';
}

function extractContext(raw: string): Record<string, string> {
  const ctx: Record<string, string> = {};
  const patterns: Array<[RegExp, string]> = [
    [/request[_-]?id\s*[:=]\s*([\w-]+)/i, 'requestId'],
    [/trace[_-]?id\s*[:=]\s*([\w-]+)/i, 'traceId'],
    [/span[_-]?id\s*[:=]\s*([\w-]+)/i, 'spanId'],
    [/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)/, 'httpPath'],
    [/HTTP\s+(\d{3})\b/, 'httpStatus'],
    [/thread\s*[:=]\s*"([^"]+)"/i, 'thread'],
    [/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/, 'timestamp'],
  ];
  for (const [re, key] of patterns) {
    const m = raw.match(re);
    if (m && m[1]) ctx[key] = m[1];
  }
  // logger 名：第一个 [...] 内容
  const loggerMatch = raw.match(/\[([\w.-]+)\]/);
  if (loggerMatch && loggerMatch[1] && !ctx.logger) ctx.logger = loggerMatch[1];
  return ctx;
}
