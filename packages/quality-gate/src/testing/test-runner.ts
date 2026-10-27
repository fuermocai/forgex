/**
 * TestRunner：独立测试执行器（v0.5.0 Phase 3）。
 *
 * 核心设计：
 *   - 不直接跑测试，通过注入的执行器接口执行；
 *   - 生产执行器封装 vitest/jest，测试用 mock；
 *   - 结果标准化：total/passed/failed/skipped + 每个失败的详细错误；
 *   - 失败 → 抛 QUALITY_GATE_FAILED 或 TEST_EXECUTION_FAILED。
 */
import { ForgeError } from '@forgex/shared';

export interface TestResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failures: TestFailure[];
}

export interface TestFailure {
  testName: string;
  suite: string;
  errorMessage: string;
  stack?: string;
}

export interface TestExecutor {
  /** 执行指定 pattern 的测试 */
  runTests(pattern: string, cwd: string): Promise<RawTestOutput>;
}

export interface RawTestOutput {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  rawFailures: Array<{ name: string; suite: string; message: string; stack?: string }>;
}

export class TestRunner {
  constructor(private readonly executor: TestExecutor) {}

  async run(pattern: string, cwd: string): Promise<TestResult> {
    const raw = await this.executor.runTests(pattern, cwd);
    const result: TestResult = {
      total: raw.total,
      passed: raw.passed,
      failed: raw.failed,
      skipped: raw.skipped,
      durationMs: raw.durationMs,
      failures: raw.rawFailures.map((f) => ({
        testName: f.name,
        suite: f.suite,
        errorMessage: f.message,
        stack: f.stack,
      })),
    };

    if (result.total === 0) {
      throw new ForgeError('QUALITY_GATE_FAILED', '没有发现任何测试，不能将测试阶段标记为通过', { details: { result } });
    }

    if (result.failed > 0) {
      const sampleFailures = result.failures
        .slice(0, 3)
        .map((f) => `${f.suite} > ${f.testName}: ${f.errorMessage}`)
        .join('；');
      throw new ForgeError(
        'QUALITY_GATE_FAILED',
        `测试失败 ${result.failed}/${result.total}：${sampleFailures}`,
        { details: { result } },
      );
    }

    return result;
  }
}
