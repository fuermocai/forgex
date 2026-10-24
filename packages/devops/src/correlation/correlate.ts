/**
 * 关联分析主入口。
 *
 * 串起流程：
 *   1. aggregateLogEvents(logText) → 异常事件块列表
 *   2. 每个事件调 parseStack(raw) → 堆栈帧
 *   3. 过滤出用户代码帧（isFramework=false）
 *   4. correlateWithGit(userFrames, { repoRoot, timeWindowMs }) → Git 变更
 *   5. 计算 confidence、errors、输出 CorrelationReport
 *
 * 确定性：除了 git 命令执行，其余全是纯函数（正则匹配 + 字符串分割）。
 * 不调 LLM。
 */
import { aggregateLogEvents } from './log-aggregator.js';
import type { CorrelateOptions, CorrelationReport, LogAggregateInput } from './types.js';
import { correlateWithGit } from './git-correlator.js';

export async function correlate(options: CorrelateOptions): Promise<CorrelationReport> {
  const errors: string[] = [];
  const analyzedAt = new Date().toISOString();

  // 1. 获取日志文本
  let logText = options.logText ?? '';
  if (!logText && options.logPath) {
    try {
      // correlation 不直接 import fs（循环依赖风险），调用方应该先把文件内容传进来
      // 但这里给一个兜底的 sync read
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readFileSync } = await import('node:fs');
      logText = readFileSync(options.logPath, 'utf8');
    } catch (err) {
      errors.push(`日志文件读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!logText) {
    return {
      source: { logFile: options.logPath },
      events: [],
      userFrames: [],
      relatedChanges: [],
      confidence: 0,
      analyzedAt,
      errors: errors.concat(['未提供日志文本']),
    };
  }

  // 2. 聚合事件
  const events = aggregateLogEvents({
    text: logText,
    hintLanguage: options.hintLanguage,
    options: { maxEvents: 20, contextLinesAfter: 30 },
  } satisfies LogAggregateInput);

  // 3. 提取用户代码帧（排除框架/系统）
  const allUserFrames = events
    .flatMap((ev) => ev.stack)
    .filter((frame) => !frame.isFramework && !!frame.filePath);

  // 去重（同一文件同一行只留第一个）
  const seen = new Set<string>();
  const userFrames = allUserFrames.filter((f) => {
    const key = `${f.filePath}:${f.line ?? '?'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 4. Git 关联（没有 repoRoot 则跳过）
  let relatedChanges: Awaited<ReturnType<typeof correlateWithGit>> = [];
  if (options.repoRoot) {
    try {
      relatedChanges = await correlateWithGit(userFrames, {
        repoRoot: options.repoRoot,
        timeWindowMs: options.gitTimeWindowMs ?? 3_600_000,
        maxFiles: 15,
      });
    } catch (err) {
      errors.push(`Git 关联失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5. 计算 confidence
  //    置信度 = 用户代码帧数量 × 0.4 + Git 关联命中数 × 0.5 + 事件数 × 0.1
  //    封顶 1.0，下限 0
  const frameScore = Math.min(userFrames.length / 5, 1) * 0.4;
  const gitScore = options.repoRoot
    ? Math.min(relatedChanges.length / 3, 1) * 0.5
    : 0.2; // 无 Git 关联时给一个较低基础分
  const eventScore = Math.min(events.length / 3, 1) * 0.1;
  const confidence = Math.max(0, Math.min(1, frameScore + gitScore + eventScore));

  return {
    source: {
      logFile: options.logPath,
      since: options.repoRoot ? new Date(Date.now() - (options.gitTimeWindowMs ?? 3_600_000)).toISOString() : undefined,
      until: new Date().toISOString(),
    },
    events,
    userFrames,
    relatedChanges,
    confidence,
    analyzedAt,
    errors,
  };
}
