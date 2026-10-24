/**
 * WorkflowRegistry：工作流定义注册表（v0.4.0 Phase 1）。
 *
 * 职责：
 *   - 注册工作流定义（register）
 *   - 按 ID 查找（get）
 *   - 列出所有（list）
 *   - 注册前自动调用 WorkflowValidator 校验
 *
 * 内置 6 个工作流在 definitions/ 目录定义，通过 registerBuiltin() 注册。
 */
import { ForgeError } from '@forgex/shared';
import type { WorkflowDefinition } from '../types.js';
import { WorkflowValidator } from '../validation/workflow-validator.js';

export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly validator = new WorkflowValidator();

  /**
   * 注册工作流定义。
   * 注册前自动校验，校验失败抛 ForgeError(WORKFLOW_INVALID)。
   * 重复 ID 注册抛错。
   */
  register(def: WorkflowDefinition): void {
    const result = this.validator.validate(def);
    if (!result.ok) {
      throw new ForgeError(
        'WORKFLOW_INVALID',
        `工作流定义校验失败: ${result.errors.map((e) => e.message).join('; ')}`,
        { details: { errors: result.errors } },
      );
    }
    if (this.definitions.has(def.id)) {
      throw new ForgeError(
        'WORKFLOW_INVALID',
        `工作流 ID 重复: ${def.id}`,
        { details: { workflowId: def.id } },
      );
    }
    this.definitions.set(def.id, def);
  }

  /** 按 ID 查找工作流定义，不存在返回 undefined */
  get(id: string): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  /** 列出所有已注册的工作流定义 */
  list(): WorkflowDefinition[] {
    return [...this.definitions.values()];
  }

  /** 是否已注册 */
  has(id: string): boolean {
    return this.definitions.has(id);
  }

  /** 注销工作流定义 */
  unregister(id: string): boolean {
    return this.definitions.delete(id);
  }
}
