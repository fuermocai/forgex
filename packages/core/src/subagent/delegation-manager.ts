/**
 * DelegationManager：子代理分派与并发控制（v0.3.0 Phase 2）。
 *
 * 职责：
 *   1. 接收父任务的 SubAgentSpec 列表，做权限收敛校验（findOutOfScopeTools）；
 *   2. 用信号量限制并发（默认 ≤3），排队任务按 FIFO 启动；
 *   3. 父任务取消时传播 AbortSignal 到所有运行中的子代理；
 *   4. 收集所有 SubAgentResult 并返回给调用方。
 *
 * 关键约束：
 *   - 权限收敛：spec.allowed_tools 必须是 parentTools 的子集，否则直接拒绝；
 *   - 不允许递归：子代理不能再分派新的子代理（由 SubAgentRunner 的
 *      scopedRegistry 不包含 delegation 工具来物理保证）；
 *   - 并发上限：默认 3，可通过 options.maxConcurrency 调整（上限 10）；
 *   - 失败隔离：一个子代理失败不影响其他子代理；
 *   - 不抛异常：所有错误都转换为 SubAgentResult.success=false。
 */
import { ForgeError, type Logger } from '@forgex/shared';
import { findOutOfScopeTools, type SubAgentResult, type SubAgentSpec } from './types.js';
import { SubAgentRunner } from './sub-agent-runner.js';

export interface DelegationOptions {
  /** 父任务的完整工具白名单（用于收敛子代理权限） */
  parentTools: ReadonlyArray<string>;
  /** 最大并发子代理数（默认 3，上限 10） */
  maxConcurrency?: number;
  /** 父任务的 AbortSignal（取消时传播到所有子代理） */
  signal?: AbortSignal;
  logger?: Logger;
}

export interface DelegationSummary {
  /** 总任务数 */
  total: number;
  /** 成功数 */
  succeeded: number;
  /** 失败数 */
  failed: number;
  /** 被取消数 */
  cancelled: number;
  /** 超预算数 */
  budgetExceeded: number;
  /** 总耗时毫秒 */
  durationMs: number;
  /** 所有结果（顺序与输入 specs 一致） */
  results: SubAgentResult[];
}

const DEFAULT_MAX_CONCURRENCY = 3;
const HARD_MAX_CONCURRENCY = 10;

export class DelegationManager {
  private readonly runner: SubAgentRunner;
  private readonly logger: Logger | undefined;

  constructor(runner: SubAgentRunner, logger?: Logger) {
    this.runner = runner;
    this.logger = logger;
  }

  /**
   * 分派一组子代理任务。
   *
   * 返回：所有 SubAgentResult（顺序与输入 specs 一致）+ 汇总统计。
   * 不抛异常——即使所有子代理都失败也正常返回。
   */
  async delegate(specs: ReadonlyArray<SubAgentSpec>, options: DelegationOptions): Promise<DelegationSummary> {
    const started = Date.now();
    const maxConcurrency = Math.min(
      Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
      HARD_MAX_CONCURRENCY,
    );

    // 1. 权限收敛校验：任何 spec 越权都直接转换为失败结果
    const results: Array<SubAgentResult | null> = new Array(specs.length).fill(null);
    const runnableIndexes: number[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const outOfScope = findOutOfScopeTools(spec.allowed_tools, options.parentTools);
      if (outOfScope.length > 0) {
        results[i] = buildDeniedResult(spec, outOfScope);
        this.logger?.warn('子代理权限越权，已拒绝', {
          subagentId: spec.subagent_id,
          role: spec.role,
          outOfScope,
        });
      } else {
        runnableIndexes.push(i);
      }
    }

    // 2. 用信号量跑可执行的任务
    const semaphore = new Semaphore(maxConcurrency);
    const tasks = runnableIndexes.map(async (index) => {
      const spec = specs[index]!;
      await semaphore.acquire();
      try {
        // 检查父任务取消
        if (options.signal?.aborted) {
          results[index] = buildCancelledResult(spec);
          return;
        }
        const result = await this.runner.run(spec, {
          ...(options.signal ? { signal: options.signal } : {}),
        });
        results[index] = result;
      } catch (err) {
        // 兜底：SubAgentRunner 已经保证不抛，但防御性捕获
        results[index] = buildErrorResult(spec, err instanceof Error ? err.message : String(err));
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(tasks);

    // 3. 构造汇总（此时所有 results 都应该非空）
    const finalResults = results.map((r, i) => {
      if (r) return r;
      // 防御：理论上不应该到这里
      return buildErrorResult(specs[i]!, '内部错误：结果未填充');
    });

    return {
      total: specs.length,
      succeeded: finalResults.filter((r) => r.success).length,
      failed: finalResults.filter((r) => r.status === 'failed').length,
      cancelled: finalResults.filter((r) => r.status === 'cancelled').length,
      budgetExceeded: finalResults.filter((r) => r.status === 'budget_exceeded').length,
      durationMs: Date.now() - started,
      results: finalResults,
    };
  }

  /** 分派单个任务（便捷 API） */
  async delegateOne(spec: SubAgentSpec, options: DelegationOptions): Promise<SubAgentResult> {
    const summary = await this.delegate([spec], options);
    return summary.results[0]!;
  }
}

/* ------------------------------------------------------------------ */
/* 私有：信号量（简易实现）                                                */
/* ------------------------------------------------------------------ */

class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits += 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 私有：构造各类失败结果                                                */
/* ------------------------------------------------------------------ */

function buildDeniedResult(spec: SubAgentSpec, outOfScope: ReadonlyArray<string>): SubAgentResult {
  const reason = `子代理请求的工具超出父任务白名单：${outOfScope.join(', ')}`;
  return {
    subagent_id: spec.subagent_id,
    role: spec.role,
    success: false,
    status: 'failed',
    summary: reason,
    failureReason: reason,
    evidence_refs: [],
    usage: { tokens: 0, toolCalls: 0, durationMs: 0, iterations: 0 },
  };
}

function buildCancelledResult(spec: SubAgentSpec): SubAgentResult {
  return {
    subagent_id: spec.subagent_id,
    role: spec.role,
    success: false,
    status: 'cancelled',
    summary: '父任务已取消',
    failureReason: '父任务 AbortSignal 触发',
    evidence_refs: [],
    usage: { tokens: 0, toolCalls: 0, durationMs: 0, iterations: 0 },
  };
}

function buildErrorResult(spec: SubAgentSpec, message: string): SubAgentResult {
  return {
    subagent_id: spec.subagent_id,
    role: spec.role,
    success: false,
    status: 'failed',
    summary: `子代理异常：${message}`,
    failureReason: message,
    evidence_refs: [],
    usage: { tokens: 0, toolCalls: 0, durationMs: 0, iterations: 0 },
  };
}

/* 重导出 ForgeError 便于测试断言 */
export { ForgeError };
