/**
 * Git / CI-CD Integration 类型定义（v0.4.0 Phase 4）。
 */

/** 变更文件状态 */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

/** 变更文件 */
export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** 新增行数 */
  additions?: number;
  /** 删除行数 */
  deletions?: number;
}

/** Git diff 结果 */
export interface GitDiffResult {
  files: ChangedFile[];
  /** 完整 diff 文本 */
  patch: string;
  totalAdditions: number;
  totalDeletions: number;
}

/** 分支信息 */
export interface BranchInfo {
  name: string;
  /** 是否当前分支 */
  current: boolean;
  /** 是否受保护 */
  protected: boolean;
  /** 最后 commit hash */
  commit?: string;
}

/** Worktree 信息 */
export interface WorktreeInfo {
  path: string;
  branch: string;
  /** 是否主 worktree */
  isMain: boolean;
}

/** Commit 信息 */
export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/** 提交规格 */
export interface CommitSpec {
  message: string;
  /** 要提交的文件路径（空表示全部已暂存） */
  files?: string[];
}

/** 变更集 */
export interface ChangeSet {
  id: string;
  files: ChangedFile[];
  /** 影响的模块（从文件路径推断） */
  affectedModules: string[];
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high';
}

/** CI 状态 */
export type PipelineStatus = 'success' | 'failed' | 'running' | 'pending' | 'unknown';

/** Pipeline 信息 */
export interface PipelineInfo {
  id: string;
  status: PipelineStatus;
  /** 分支名 */
  branch: string;
  /** 触发者 */
  triggeredBy?: string;
  /** 开始时间 ISO */
  startedAt?: string;
  /** 结束时间 ISO */
  finishedAt?: string;
  /** 构建日志 URL */
  logUrl?: string;
}

/** 失败诊断 */
export interface FailureDiagnosis {
  /** 失败的测试用例/任务名 */
  failedItems: string[];
  /** 错误信息摘要 */
  errorSummary: string;
  /** 建议的修复方向 */
  suggestedFix?: string;
}

/** 受保护分支名（精确匹配） */
export const PROTECTED_BRANCH_NAMES = ['main', 'master', 'production', 'staging'];

/** 受保护分支模式（正则匹配） */
export const PROTECTED_BRANCH_REGEXES = [/^release\/.+/, /^hotfix\/.+/];
