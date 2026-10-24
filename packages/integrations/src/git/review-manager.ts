/**
 * ReviewManager：代码审查辅助（v0.4.0 Phase 4）。
 *
 * 职责：
 *   - Commit Message 建议；
 *   - PR/MR 描述生成（基于 diff 内容）。
 */
import type { GitDiffResult } from '../types.js';
import { ChangeSetManager } from './change-set-manager.js';

export class ReviewManager {
  private readonly changeSetManager: ChangeSetManager;

  constructor(changeSetManager: ChangeSetManager) {
    this.changeSetManager = changeSetManager;
  }

  /** 生成 Commit Message 建议（conventional commits 格式） */
  async suggestCommitMessage(): Promise<string> {
    const changeSet = await this.changeSetManager.createChangeSet();
    const type = this.determineCommitType(changeSet.files);
    const scope = changeSet.affectedModules[0] ?? '';
    const filesSummary = changeSet.files.slice(0, 3).map((f) => f.path).join(', ');
    const more = changeSet.files.length > 3 ? ` 等 ${changeSet.files.length} 个文件` : '';

    const scopePart = scope ? `(${scope})` : '';
    return `${type}${scopePart}: 更新 ${filesSummary}${more}`;
  }

  /** 生成 PR/MR 描述 */
  async generatePullRequestDescription(): Promise<string> {
    const changeSet = await this.changeSetManager.createChangeSet();
    const lines: string[] = [];

    lines.push('## 变更概述');
    lines.push(`本次变更涉及 ${changeSet.files.length} 个文件，影响模块：${changeSet.affectedModules.join(', ')}`);
    lines.push(`风险等级：${changeSet.riskLevel}`);
    lines.push('');

    lines.push('## 变更文件');
    for (const file of changeSet.files) {
      lines.push(`- [${file.status}] ${file.path}`);
    }
    lines.push('');

    lines.push('## 测试');
    lines.push('- [ ] 单元测试通过');
    lines.push('- [ ] 集成测试通过');
    lines.push('- [ ] 手动验证');

    return lines.join('\n');
  }

  /** 根据变更文件判断 commit 类型 */
  private determineCommitType(files: { status: string; path: string }[]): string {
    const hasTest = files.some((f) => f.path.includes('test') || f.path.includes('spec'));
    const hasConfig = files.some((f) => f.path.endsWith('.json') || f.path.endsWith('.yaml') || f.path.endsWith('.yml'));
    const hasDeleted = files.some((f) => f.status === 'deleted');

    if (hasDeleted) return 'refactor';
    if (hasTest) return 'test';
    if (hasConfig) return 'chore';
    return 'feat';
  }
}
