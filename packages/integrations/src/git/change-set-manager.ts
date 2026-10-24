/**
 * ChangeSetManager：变更集管理（v0.4.0 Phase 4）。
 *
 * 职责：
 *   - 变更集创建；
 *   - 文件影响分析；
 *   - 风险等级评估。
 */
import type { ChangedFile, ChangeSet } from '../types.js';
import { GitService } from './git-service.js';

export class ChangeSetManager {
  private readonly gitService: GitService;

  constructor(gitService: GitService) {
    this.gitService = gitService;
  }

  /** 创建当前变更集 */
  async createChangeSet(): Promise<ChangeSet> {
    const diff = await this.gitService.diff();
    const files = diff.files;
    const affectedModules = this.detectAffectedModules(files);
    const riskLevel = this.assessRisk(files);

    return {
      id: `changeset_${Date.now()}`,
      files,
      affectedModules,
      riskLevel,
    };
  }

  /** 从文件路径推断影响的模块 */
  private detectAffectedModules(files: ChangedFile[]): string[] {
    const modules = new Set<string>();
    for (const file of files) {
      // 取路径的第一级目录作为模块名
      const parts = file.path.split('/');
      if (parts.length > 1) {
        modules.add(parts[0]!);
      } else {
        modules.add('root');
      }
    }
    return [...modules];
  }

  /** 评估变更风险等级 */
  private assessRisk(files: ChangedFile[]): ChangeSet['riskLevel'] {
    if (files.length === 0) return 'low';

    // 有删除文件 → high
    if (files.some((f) => f.status === 'deleted')) return 'high';

    // 变更文件超过 10 个 → high
    if (files.length > 10) return 'high';

    // 变更文件 3-10 个 → medium
    if (files.length > 3) return 'medium';

    return 'low';
  }
}
