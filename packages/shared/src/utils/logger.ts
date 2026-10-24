/**
 * 结构化 JSON 日志。
 *
 * 设计取舍：
 *  - 默认写 stderr，避免污染 CLI 的 stdout（TUI 需要独占 stdout）。
 *  - 每行一条 JSON，便于 ELK / Loki 采集。
 *  - 所有字段先经过脱敏，杜绝 API Key 落盘。
 *  - 不使用全局单例：调用方通过 createLogger 注入，方便测试。
 */
import { redactValue, redactText } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** 派生带固定字段的子 logger */
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 自定义输出目标，默认 process.stderr.write */
  sink?: (line: string) => void;
  /** 固定字段，例如 { app: 'forgex', sessionId } */
  base?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const base = options.base ?? {};

  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_WEIGHT[lvl] < LEVEL_WEIGHT[level]) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redactText(message),
      ...(redactValue(base) as Record<string, unknown>),
      ...(fields ? (redactValue(fields) as Record<string, unknown>) : {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: lvl, msg: record.msg, logError: 'serialize_failed' });
    }
    sink(line);
  };

  const logger: Logger = {
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) =>
      createLogger({
        level,
        sink,
        base: { ...base, ...(redactValue(fields) as Record<string, unknown>) },
      }),
  };
  return logger;
}

/** 静默 logger（测试用） */
export function createNullLogger(): Logger {
  return createLogger({ level: 'silent', sink: () => {} });
}
