/**
 * RequirementParser：需求解析器（v0.5.0 Phase 1）。
 *
 * 职责：
 *   - 将自然语言需求转换为 StructuredRequirement；
 *   - 协调 RequirementModelInterface 的四个调用（intent/ambiguities/criteria/risks）；
 *   - 不直接 import @forgex/models，通过注入保持解耦；
 *   - 返回的 AcceptanceCriterion 全部 approved=false（draft 状态）。
 */
import { ForgeError } from '@forgex/shared';
import {
  makeStructuredRequirement,
  makeCriterion,
  type StructuredRequirement,
  type AcceptanceCriterion,
} from '../types.js';
import type {
  RequirementModelInterface,
  RequirementModelContext,
} from '../model/requirement-model-interface.js';

export interface RequirementParserOptions {
  /** 模型接口实例（必填，由上层注入） */
  model: RequirementModelInterface;
  /** 项目上下文提示 */
  context?: RequirementModelContext;
  /** 附加的确定性模块映射（不依赖 LLM 的简单规则） */
  deterministicModuleHints?: string[];
}

export class RequirementParser {
  private readonly model: RequirementModelInterface;
  private readonly context?: RequirementModelContext;
  private readonly deterministicHints: string[];

  constructor(options: RequirementParserOptions) {
    this.model = options.model;
    this.context = options.context;
    this.deterministicHints = options.deterministicModuleHints ?? [];
  }

  /**
   * 解析自然语言需求 → StructuredRequirement。
   *
   * 流程：
   *   1. parseIntent — 分类 + 摘要 + 功能/非功能需求点
   *   2. detectAmbiguities — 识别必须请求用户确认的歧义
   *   3. detectRisks — 识别兼容性/安全风险
   *   4. generateCriteria — 生成 draft 验收标准（全部 approved=false）
   *   5. 模块映射（LLM 辅助 + deterministic 规则）
   */
  async parse(input: string): Promise<StructuredRequirement> {
    if (!input.trim()) {
      throw new ForgeError(
        'REQUIREMENT_PARSE_FAILED',
        '需求输入为空，无法解析',
      );
    }

    // 1. Intent
    const parsed = await this.safeCall(
      () => this.model.parseIntent(input, this.context),
      '解析意图',
    );

    // 2. Ambiguities
    const ambiguities = await this.safeCall(
      () => this.model.detectAmbiguities(input, parsed),
      '识别歧义',
    );

    // 3. Risks
    const compatibilityRisks = await this.safeCall(
      () => this.model.detectRisks(input, parsed),
      '识别风险',
    );

    // 4. Criteria（全部强制 approved=false）
    const llmCriteria = await this.safeCall(
      () => this.model.generateCriteria(input, parsed),
      '生成验收标准',
    );
    const acceptanceCriteria = llmCriteria.map((c) =>
      makeCriterion({
        description: c.description,
        testable: c.testable,
        verificationMethod: c.verificationMethod,
        // 覆盖：不管 LLM 返回什么，都强制为 draft
        source: c.source ?? 'llm-generated',
        approved: false,
      }),
    );

    // 5. 模块映射
    const affectedModules = this.mergeModules(
      this.inferModulesFromInput(input),
      this.deterministicHints,
    );

    return makeStructuredRequirement({
      original: input,
      parsed,
      ambiguities,
      affectedModules,
      compatibilityRisks,
      acceptanceCriteria,
    });
  }

  /** 安全调用模型方法，统一错误处理 */
  private async safeCall<T>(
    fn: () => Promise<T>,
    stepName: string,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new ForgeError(
        'REQUIREMENT_PARSE_FAILED',
        `RequirementParser.${stepName} 失败：${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /** 从输入中简单推断模块（不依赖 LLM） */
  private inferModulesFromInput(input: string): string[] {
    const modules = new Set<string>();
    const lower = input.toLowerCase();

    const keywordMap: Array<[RegExp, string]> = [
      [/auth|login|user|权限|认证/, 'auth'],
      [/api|endpoint|router|接口/, 'api'],
      [/db|database|sql|数据库/, 'db'],
      [/ui|frontend|component|页面/, 'ui'],
      [/test|spec|jest|vitest/, 'test'],
      [/build|compile|typescript|tsc/, 'build'],
      [/docker|container|kubernetes|部署/, 'deploy'],
      [/config|env|环境变量/, 'config'],
    ];

    for (const [pattern, moduleName] of keywordMap) {
      if (pattern.test(lower)) {
        modules.add(moduleName);
      }
    }
    return [...modules];
  }

  private mergeModules(inferred: string[], hints: string[]): string[] {
    const merged = new Set<string>(inferred);
    for (const h of hints) merged.add(h);
    return [...merged];
  }
}
