/**
 * JenkinsAdapter：Jenkins CI 适配器（v0.4.0 Phase 4）。
 *
 * 支持私有化部署（自定义 baseURL + username/apiToken）。
 */
import { ForgeError } from '@forgex/shared';
import type { FailureDiagnosis, PipelineInfo, PipelineStatus } from '../types.js';
import type { PipelineAdapter } from '../ci/pipeline-adapter.js';

export interface JenkinsConfig {
  /** Jenkins 实例 URL */
  baseUrl: string;
  /** 用户名 */
  username: string;
  /** API Token */
  apiToken: string;
  /** Job 名称 */
  jobName: string;
}

export class JenkinsAdapter implements PipelineAdapter {
  private readonly config: JenkinsConfig;

  constructor(config: JenkinsConfig) {
    if (!config.baseUrl || !config.username || !config.apiToken || !config.jobName) {
      throw new ForgeError('CONFIG_INVALID', 'Jenkins 配置不完整：需要 baseUrl、username、apiToken、jobName');
    }
    this.config = config;
  }

  async getStatus(buildId: string): Promise<PipelineInfo> {
    try {
      const data = await this.request(`/job/${encodeURIComponent(this.config.jobName)}/${buildId}/api/json`);
      const record = data as { result?: string; building?: boolean; timestamp?: number; duration?: number; actions?: Array<{ lastBuiltRevision?: { branch?: Array<{ name: string }> } }> };
      return {
        id: buildId,
        status: record.building ? 'running' : this.mapStatus(record.result),
        branch: record.actions?.[0]?.lastBuiltRevision?.branch?.[0]?.name ?? 'unknown',
        startedAt: record.timestamp ? new Date(record.timestamp).toISOString() : undefined,
        finishedAt: record.timestamp && record.duration ? new Date(record.timestamp + record.duration).toISOString() : undefined,
      };
    } catch (err) {
      throw new ForgeError('TOOL_FAILED', `获取 Jenkins 构建状态失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getLogs(buildId: string): Promise<string> {
    try {
      const log = await this.request(`/job/${encodeURIComponent(this.config.jobName)}/${buildId}/consoleText`, true);
      return typeof log === 'string' ? log : String(log);
    } catch (err) {
      throw new ForgeError('TOOL_FAILED', `获取 Jenkins 构建日志失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async diagnoseFailure(buildId: string): Promise<FailureDiagnosis> {
    const logs = await this.getLogs(buildId);
    const failedItems = this.extractFailedTests(logs);
    const errorSummary = this.extractErrorSummary(logs);

    return {
      failedItems,
      errorSummary,
      suggestedFix: failedItems.length > 0 ? '检查失败的测试用例，修复断言或实现' : undefined,
    };
  }

  private mapStatus(result: string | undefined): PipelineStatus {
    switch (result) {
      case 'SUCCESS':
        return 'success';
      case 'FAILURE':
      case 'UNSTABLE':
        return 'failed';
      case 'ABORTED':
        return 'failed';
      default:
        return 'unknown';
    }
  }

  private extractFailedTests(logs: string): string[] {
    const failed: string[] = [];
    for (const line of logs.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.includes('FAILED') || trimmed.includes('Tests run:') && trimmed.includes('Failures: ')) {
        failed.push(trimmed.slice(0, 200));
      }
    }
    return failed.slice(0, 20);
  }

  private extractErrorSummary(logs: string): string {
    const errorLines = logs.split('\n').filter((l) => l.includes('ERROR') || l.includes('Exception'));
    return errorLines.slice(0, 5).join('\n');
  }

  private async request(path: string, isText = false): Promise<unknown> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
    const auth = Buffer.from(`${this.config.username}:${this.config.apiToken}`).toString('base64');
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
    };

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (isText) {
      return response.text();
    }
    return response.json();
  }
}
