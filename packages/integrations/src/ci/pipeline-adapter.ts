/**
 * PipelineAdapter：CI/CD 适配器接口（v0.4.0 Phase 4）。
 *
 * 支持读取 CI 状态、构建日志、测试失败诊断。
 * 实现：本地 CI、GitLab、Jenkins。
 */
import type { FailureDiagnosis, PipelineInfo, PipelineStatus } from '../types.js';

export interface PipelineAdapter {
  /** 获取 Pipeline 状态 */
  getStatus(buildId: string): Promise<PipelineInfo>;

  /** 获取构建日志 */
  getLogs(buildId: string): Promise<string>;

  /** 诊断测试失败 */
  diagnoseFailure(buildId: string): Promise<FailureDiagnosis>;
}

/** 本地 CI 适配器（读取本地脚本输出） */
export class LocalPipelineAdapter implements PipelineAdapter {
  async getStatus(_buildId: string): Promise<PipelineInfo> {
    // 第一版：返回 unknown，实际集成时读取本地 CI 配置
    return {
      id: _buildId,
      status: 'unknown',
      branch: 'unknown',
    };
  }

  async getLogs(_buildId: string): Promise<string> {
    return '';
  }

  async diagnoseFailure(_buildId: string): Promise<FailureDiagnosis> {
    return {
      failedItems: [],
      errorSummary: '本地 CI 诊断未配置',
    };
  }
}
