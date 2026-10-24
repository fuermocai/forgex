/**
 * RequirementModelInterface：需求理解 LLM 接口（v0.5.0 Phase 1）。
 *
 * 设计模式：复用 v0.4.0 NodeExecutor 解耦经验。
 *   - 生产环境：RequirementEngine 通过 createProvider() 注入真实 LLM；
 *   - 测试：注入 DeterministicMockModel，完全不依赖外部模型；
 *   - 接口极窄，只暴露需求理解所需方法。
 *
 * 安全约束：
 *   - 生产 RequirementParser 绝不直接 import @forgex/models 的 createProvider；
 *   - createProvider() 由上层组装器（未来 Orchestrator）注入；
 *   - RequirementModelInterface 的所有方法输入输出都不包含密钥或凭据。
 */
import type { ParsedIntent, AmbiguityItem, AcceptanceCriterion, RiskItem } from '../types.js';

export interface RequirementModelInterface {
  /**
   * 解析自然语言需求 → ParsedIntent。
   * @param input 用户原始输入
   * @param context 可选上下文（如项目技术栈提示）
   */
  parseIntent(input: string, context?: RequirementModelContext): Promise<ParsedIntent>;

  /**
   * 识别需求中的歧义项。
   * 返回的 AmbiguityItem 必须带有 suggestedOptions 供用户选择。
   */
  detectAmbiguities(input: string, parsed: ParsedIntent): Promise<AmbiguityItem[]>;

  /**
   * 生成验收标准（draft，调用方必须显式批准才生效）。
   * 返回的 AcceptanceCriterion.approved 必须全部为 false（draft 状态）。
   */
  generateCriteria(input: string, parsed: ParsedIntent): Promise<AcceptanceCriterion[]>;

  /**
   * 识别兼容性/安全风险。
   */
  detectRisks(input: string, parsed: ParsedIntent): Promise<RiskItem[]>;
}

/** 模型上下文提示 */
export interface RequirementModelContext {
  /** 项目技术栈（如 ['TypeScript', 'React', 'Node.js']） */
  techStack?: string[];
  /** 项目结构提示（顶层目录列表） */
  topLevelDirs?: string[];
  /** 项目类型提示 */
  projectType?: 'library' | 'web-app' | 'cli' | 'service' | 'unknown';
}

/** DeterministicMockModel：用于测试的确定性模型 */
export class DeterministicMockModel implements RequirementModelInterface {
  private readonly _intent?: ParsedIntent;
  private readonly _ambiguities?: AmbiguityItem[];
  private readonly _criteria?: AcceptanceCriterion[];
  private readonly _risks?: RiskItem[];

  constructor(overrides?: {
    intent?: ParsedIntent;
    ambiguities?: AmbiguityItem[];
    criteria?: AcceptanceCriterion[];
    risks?: RiskItem[];
  }) {
    this._intent = overrides?.intent;
    this._ambiguities = overrides?.ambiguities;
    this._criteria = overrides?.criteria;
    this._risks = overrides?.risks;
  }

  async parseIntent(input: string, _ctx?: RequirementModelContext): Promise<ParsedIntent> {
    if (this._intent) return this._intent;
    // 简单规则 fallback：按关键词分类
    const lower = input.toLowerCase();
    const category: ParsedIntent['category'] =
      lower.includes('bug') || lower.includes('修复') || lower.includes('fix')
        ? 'bug-fix'
        : lower.includes('重构') || lower.includes('refactor')
        ? 'refactor'
        : lower.includes('部署') || lower.includes('deploy') || lower.includes('docker')
        ? 'devops'
        : 'feature';
    return {
      category,
      summary: input.length > 100 ? input.slice(0, 100) + '...' : input,
      functionalReqs: [input],
      nonFunctionalReqs: [],
    };
  }

  async detectAmbiguities(_input: string, _parsed: ParsedIntent): Promise<AmbiguityItem[]> {
    return this._ambiguities ?? [];
  }

  async generateCriteria(_input: string, _parsed: ParsedIntent): Promise<AcceptanceCriterion[]> {
    if (this._criteria) return this._criteria.map((c) => ({ ...c, approved: false }));
    return [];
  }

  async detectRisks(_input: string, _parsed: ParsedIntent): Promise<RiskItem[]> {
    return this._risks ?? [];
  }
}

/**
 * ProductionRequirementModel：适配器，将 @forgex/models 的 ModelProvider
 * 包装成 RequirementModelInterface。
 *
 * 实际实现需要调用 createProvider() 并发送 prompt。
 * 此处定义接口，具体实现留在 Phase 2 生产组装时完成。
 */
export interface ProductionRequirementModelConfig {
  /** 模型名称（如 'qwen-max' / 'deepseek-chat'） */
  model: string;
  /** 可选：自定义 system prompt 模板 */
  systemPromptTemplate?: string;
}
