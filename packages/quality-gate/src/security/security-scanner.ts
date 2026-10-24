/**
 * SecurityScanner：安全扫描器（v0.5.0 Phase 3）。
 *
 * 职责：
 *   - 封装生产 SAST（semgrep/gitleaks）；
 *   - 发现硬编码密钥、危险 API、依赖漏洞；
 *   - 扫描结果区分严重级别，critical/high 必须阻断。
 */
import { ForgeError } from '@forgex/shared';

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low';

export interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  category: 'secret' | 'vulnerability' | 'danger-api' | 'dependency';
  file: string;
  line?: number;
  title: string;
  description: string;
  remediation?: string;
}

export interface SecurityScanResult {
  findings: SecurityFinding[];
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  durationMs: number;
}

export interface SecurityScanExecutor {
  scan(cwd: string): Promise<SecurityFinding[]>;
}

export class SecurityScanner {
  constructor(private readonly executor: SecurityScanExecutor) {}

  async scan(cwd: string): Promise<SecurityScanResult> {
    const start = Date.now();
    const findings = await this.executor.scan(cwd);
    const durationMs = Date.now() - start;

    const result: SecurityScanResult = {
      findings,
      criticalCount: findings.filter((f) => f.severity === 'critical').length,
      highCount: findings.filter((f) => f.severity === 'high').length,
      mediumCount: findings.filter((f) => f.severity === 'medium').length,
      lowCount: findings.filter((f) => f.severity === 'low').length,
      durationMs,
    };

    if (result.criticalCount > 0 || result.highCount > 0) {
      const top = findings
        .filter((f) => f.severity === 'critical' || f.severity === 'high')
        .slice(0, 3)
        .map((f) => `[${f.severity.toUpperCase()}] ${f.file}:${f.line ?? '?'} ${f.title}`)
        .join('；');
      throw new ForgeError(
        'DELIVERY_VALIDATION_FAILED',
        `安全扫描发现 ${result.criticalCount} critical + ${result.highCount} high 漏洞：${top}`,
        { details: { result } },
      );
    }

    return result;
  }
}
