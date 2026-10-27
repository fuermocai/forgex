/**
 * QualityGate：质量门禁聚合器（v0.5.0 Phase 3）。
 *
 * 核心：按优先级串联 TestRunner → StaticAnalyzer → SecurityScanner，
 * 任一失败立即阻断。
 */
import { ForgeError } from '@forgex/shared';
import type { TestRunner } from './testing/test-runner.js';
import type { StaticAnalyzer } from './static/static-analyzer.js';
import type { SecurityScanner } from './security/security-scanner.js';

export interface QualityGateOptions {
  testRunner?: TestRunner;
  staticAnalyzer?: StaticAnalyzer;
  securityScanner?: SecurityScanner;
}

export interface QualityGateResult {
  passed: boolean;
  stagesCompleted: string[];
  stagesFailed: string[];
  results: Record<string, unknown>;
  finalMessage: string;
}

export class QualityGate {
  private readonly testRunner?: TestRunner;
  private readonly staticAnalyzer?: StaticAnalyzer;
  private readonly securityScanner?: SecurityScanner;

  constructor(options: QualityGateOptions) {
    if (!options.testRunner && !options.staticAnalyzer && !options.securityScanner) {
      throw new ForgeError('CONFIG_INVALID', '质量门禁至少需要配置一个检查阶段');
    }
    this.testRunner = options.testRunner;
    this.staticAnalyzer = options.staticAnalyzer;
    this.securityScanner = options.securityScanner;
  }

  async run(cwd: string, testPattern?: string): Promise<QualityGateResult> {
    const results: Record<string, unknown> = {};
    const completed: string[] = [];
    const failed: string[] = [];
    let stopped = false;

    // Stage 1: Tests
    if (!stopped && this.testRunner) {
      try {
        const r = await this.testRunner.run(testPattern ?? '**/*.test.ts', cwd);
        results.tests = r;
        completed.push('tests');
      } catch (err) {
        failed.push('tests');
        results.tests = { error: err instanceof Error ? err.message : String(err) };
        stopped = true;
      }
    }

    // Stage 2: Static Analysis
    if (!stopped && this.staticAnalyzer) {
      try {
        const r = await this.staticAnalyzer.analyze(cwd);
        results.static = r;
        completed.push('static');
      } catch (err) {
        failed.push('static');
        results.static = { error: err instanceof Error ? err.message : String(err) };
        stopped = true;
      }
    }

    // Stage 3: Security
    if (!stopped && this.securityScanner) {
      try {
        const r = await this.securityScanner.scan(cwd);
        results.security = r;
        completed.push('security');
      } catch (err) {
        failed.push('security');
        results.security = { error: err instanceof Error ? err.message : String(err) };
        stopped = true;
      }
    }

    const passed = failed.length === 0;
    return {
      passed,
      stagesCompleted: completed,
      stagesFailed: failed,
      results,
      finalMessage: passed
        ? `质量门禁全部通过：${completed.join(' → ')}`
        : `质量门禁未通过：${failed.join(' + ')} 失败`,
    };
  }
}
