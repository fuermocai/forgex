/**
 * StaticAnalyzer：静态分析器（v0.5.0 Phase 3）。
 *
 * 职责：
 *   - 封装生产 TS ESLint/TSC 检查；
 *   - 测试用确定性 mock；
 *   - 返回标准化的问题列表，区分 severity（error/warning/info）。
 */
import { ForgeError } from '@forgex/shared';

export interface StaticIssue {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
}

export interface StaticAnalysisResult {
  issues: StaticIssue[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  durationMs: number;
}

export interface StaticAnalysisExecutor {
  analyze(cwd: string): Promise<StaticIssue[]>;
}

export class StaticAnalyzer {
  constructor(private readonly executor: StaticAnalysisExecutor) {}

  async analyze(cwd: string): Promise<StaticAnalysisResult> {
    const start = Date.now();
    const issues = await this.executor.analyze(cwd);
    const durationMs = Date.now() - start;

    const result: StaticAnalysisResult = {
      issues,
      errorCount: issues.filter((i) => i.severity === 'error').length,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
      infoCount: issues.filter((i) => i.severity === 'info').length,
      durationMs,
    };

    if (result.errorCount > 0) {
      throw new ForgeError(
        'STATIC_ANALYSIS_FAILED',
        `静态分析发现 ${result.errorCount} 个错误`,
        { details: { result } },
      );
    }

    return result;
  }
}
