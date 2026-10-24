/**
 * Quality Gate 测试（v0.5.0 Phase 3）。
 */
import { describe, it, expect } from 'vitest';
import { TestRunner, type TestExecutor } from '../src/testing/test-runner.js';
import { StaticAnalyzer, type StaticAnalysisExecutor } from '../src/static/static-analyzer.js';
import { SecurityScanner, type SecurityScanExecutor } from '../src/security/security-scanner.js';
import { QualityGate } from '../src/quality-gate.js';

describe('TestRunner', () => {
  it('全部通过 → 返回结果', async () => {
    const exec: TestExecutor = {
      async runTests() {
        return { total: 10, passed: 10, failed: 0, skipped: 0, durationMs: 100, rawFailures: [] };
      },
    };
    const runner = new TestRunner(exec);
    const result = await runner.run('*.test.ts', '/tmp');
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(0);
  });

  it('有失败 → 抛 QUALITY_GATE_FAILED', async () => {
    const exec: TestExecutor = {
      async runTests() {
        return {
          total: 10,
          passed: 8,
          failed: 2,
          skipped: 0,
          durationMs: 100,
          rawFailures: [{ name: 'testX', suite: 'A', message: 'assert fail' }],
        };
      },
    };
    const runner = new TestRunner(exec);
    let err: any = null;
    try {
      await runner.run('*.test.ts', '/tmp');
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe('QUALITY_GATE_FAILED');
  });
});

describe('StaticAnalyzer', () => {
  it('errorCount=0 → 通过', async () => {
    const exec: StaticAnalysisExecutor = {
      async analyze() { return []; },
    };
    const a = new StaticAnalyzer(exec);
    const r = await a.analyze('/tmp');
    expect(r.errorCount).toBe(0);
  });

  it('有 error → 抛 STATIC_ANALYSIS_FAILED', async () => {
    const exec: StaticAnalysisExecutor = {
      async analyze() {
        return [{ file: 'a.ts', line: 5, severity: 'error', rule: 'no-any', message: '禁止 any' }];
      },
    };
    const a = new StaticAnalyzer(exec);
    let err: any = null;
    try { await a.analyze('/tmp'); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('STATIC_ANALYSIS_FAILED');
  });

  it('只有 warning → 通过', async () => {
    const exec: StaticAnalysisExecutor = {
      async analyze() {
        return [{ file: 'a.ts', line: 5, severity: 'warning', rule: 'unused', message: '未使用' }];
      },
    };
    const a = new StaticAnalyzer(exec);
    const r = await a.analyze('/tmp');
    expect(r.errorCount).toBe(0);
    expect(r.warningCount).toBe(1);
  });
});

describe('SecurityScanner', () => {
  it('无 critical/high → 通过', async () => {
    const exec: SecurityScanExecutor = {
      async scan() {
        return [{
          id: 'f1', severity: 'low', category: 'dependency', file: 'p.json', title: '低危',
          description: 'd',
        }];
      },
    };
    const s = new SecurityScanner(exec);
    const r = await s.scan('/tmp');
    expect(r.criticalCount).toBe(0);
    expect(r.highCount).toBe(0);
  });

  it('critical → 抛 DELIVERY_VALIDATION_FAILED', async () => {
    const exec: SecurityScanExecutor = {
      async scan() {
        return [{
          id: 'f1', severity: 'critical', category: 'secret', file: '.env', line: 3,
          title: '发现 API Key', description: '硬编码密钥',
        }];
      },
    };
    const s = new SecurityScanner(exec);
    let err: any = null;
    try { await s.scan('/tmp'); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('DELIVERY_VALIDATION_FAILED');
  });

  it('high → 同样阻断', async () => {
    const exec: SecurityScanExecutor = {
      async scan() {
        return [{
          id: 'f1', severity: 'high', category: 'vulnerability', file: 'p.json',
          title: '高危依赖', description: 'CVE-2024-xxx',
        }];
      },
    };
    const s = new SecurityScanner(exec);
    await expect(s.scan('/tmp')).rejects.toThrow();
  });
});

describe('QualityGate 聚合', () => {
  function makeAllPassing() {
    const testExec: TestExecutor = { async runTests() { return { total: 5, passed: 5, failed: 0, skipped: 0, durationMs: 50, rawFailures: [] }; } };
    const statExec: StaticAnalysisExecutor = { async analyze() { return []; } };
    const secExec: SecurityScanExecutor = { async scan() { return []; } };
    return {
      testRunner: new TestRunner(testExec),
      staticAnalyzer: new StaticAnalyzer(statExec),
      securityScanner: new SecurityScanner(secExec),
    };
  }

  it('全通过 → passed=true，stages 全完成', async () => {
    const qg = new QualityGate(makeAllPassing());
    const r = await qg.run('/tmp');
    expect(r.passed).toBe(true);
    expect(r.stagesCompleted).toEqual(['tests', 'static', 'security']);
    expect(r.stagesFailed).toEqual([]);
  });

  it('tests 失败 → static/security 被跳过', async () => {
    const testExec: TestExecutor = {
      async runTests() {
        return { total: 5, passed: 4, failed: 1, skipped: 0, durationMs: 50, rawFailures: [{ name: 'x', suite: 'y', message: 'm' }] };
      },
    };
    const qg = new QualityGate({
      ...makeAllPassing(),
      testRunner: new TestRunner(testExec),
    });
    const r = await qg.run('/tmp');
    expect(r.passed).toBe(false);
    expect(r.stagesFailed).toContain('tests');
    expect(r.stagesCompleted).not.toContain('static');
    expect(r.stagesCompleted).not.toContain('security');
  });

  it('仅开启 tests', async () => {
    const { testRunner } = makeAllPassing();
    const qg = new QualityGate({ testRunner });
    const r = await qg.run('/tmp');
    expect(r.passed).toBe(true);
    expect(r.stagesCompleted).toEqual(['tests']);
  });
});
