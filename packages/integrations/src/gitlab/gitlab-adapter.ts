/**
 * GitLabAdapter：GitLab CI 适配器（v0.4.0 Phase 4）。
 *
 * 支持私有化部署（自定义 baseURL + private token）。
 *
 * 安全约束：
 *   - baseURL 和 token 从配置读取，不硬编码；
 *   - 禁止自动修改仓库权限或 CI 凭据。
 */
import { ForgeError } from '@forgex/shared';
import type { FailureDiagnosis, PipelineInfo, PipelineStatus } from '../types.js';
import type { PipelineAdapter } from '../ci/pipeline-adapter.js';

export interface GitLabConfig {
  /** GitLab 实例 URL（私有化部署） */
  baseUrl: string;
  /** Personal Access Token */
  token: string;
  /** 项目 ID 或路径 */
  projectId: string;
}

export class GitLabAdapter implements PipelineAdapter {
  private readonly config: GitLabConfig;

  constructor(config: GitLabConfig) {
    if (!config.baseUrl || !config.token || !config.projectId) {
      throw new ForgeError('CONFIG_INVALID', 'GitLab 配置不完整：需要 baseUrl、token、projectId');
    }
    this.config = config;
  }

  async getStatus(buildId: string): Promise<PipelineInfo> {
    try {
      const data = await this.request(`/projects/${encodeURIComponent(this.config.projectId)}/pipelines/${buildId}`) as {
        id: number;
        status: string;
        ref: string;
        user?: { name: string };
        started_at?: string;
        finished_at?: string;
      };
      return {
        id: String(data.id),
        status: this.mapStatus(data.status),
        branch: data.ref,
        triggeredBy: data.user?.name,
        startedAt: data.started_at,
        finishedAt: data.finished_at,
      };
    } catch (err) {
      throw new ForgeError('TOOL_FAILED', `获取 GitLab Pipeline 状态失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getLogs(buildId: string): Promise<string> {
    try {
      // 获取 pipeline 的 jobs，然后取第一个失败 job 的日志
      const jobs = await this.request(`/projects/${encodeURIComponent(this.config.projectId)}/pipelines/${buildId}/jobs`) as Array<{ id: number; status: string }>;
      const failedJob = jobs.find((j) => j.status === 'failed');
      if (!failedJob) return '';

      const log = await this.request(`/projects/${encodeURIComponent(this.config.projectId)}/jobs/${failedJob.id}/trace`, true);
      return typeof log === 'string' ? log : JSON.stringify(log);
    } catch (err) {
      throw new ForgeError('TOOL_FAILED', `获取 GitLab 构建日志失败: ${err instanceof Error ? err.message : String(err)}`);
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

  private mapStatus(status: string): PipelineStatus {
    switch (status) {
      case 'success':
        return 'success';
      case 'failed':
        return 'failed';
      case 'running':
      case 'pending':
        return 'running';
      default:
        return 'unknown';
    }
  }

  private extractFailedTests(logs: string): string[] {
    // 简单解析：匹配 "FAIL" 或 "✗" 开头的行
    const failed: string[] = [];
    for (const line of logs.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('FAIL') || trimmed.startsWith('✗') || trimmed.includes('FAILED')) {
        failed.push(trimmed.slice(0, 200));
      }
    }
    return failed.slice(0, 20);
  }

  private extractErrorSummary(logs: string): string {
    const errorLines = logs.split('\n').filter((l) => l.includes('Error') || l.includes('error'));
    return errorLines.slice(0, 5).join('\n');
  }

  private async request(path: string, isText = false): Promise<unknown> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/api/v4${path}`;
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.config.token,
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
