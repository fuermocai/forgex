/**
 * ModelRouter：模型路由器（v0.5.0 Phase 5）。
 *
 * 职责：
 *   - 根据任务能力需求（coding/vision/reasoning/cheap/fast）选择合适的模型；
 *   - 主模型不可用时自动回退到备用模型；
 *   - 不引入密钥，配置由上层注入；
 *   - 回退耗尽抛 MODEL_FALLBACK_EXHAUSTED。
 */
import { ForgeError, isAbortError, redactText } from '@forgex/shared';
import type { ModelCapability, ModelProvider } from './types.js';

export interface ModelDescriptor {
  /** 模型唯一 ID */
  id: string;
  /** provider 实例 */
  provider: ModelProvider;
  /** 该模型具备的能力标签 */
  capabilities: ModelCapability[];
  /** 成本/延迟等级：1=最低 5=最高 */
  tier: 1 | 2 | 3 | 4 | 5;
  /** Configured-catalog readiness; omitted descriptors remain available for compatibility. */
  available?: boolean;
  contextWindow?: number;
  costTier?: 1 | 2 | 3 | 4 | 5;
  speedTier?: 1 | 2 | 3 | 4 | 5;
}

export interface RoutingRequest {
  /** Every requested capability must be present on a candidate model. */
  requiredCapabilities?: ModelCapability[];
  /** 优先 tier（越小越便宜快） */
  preferTier?: number;
  /** 最大容忍 tier */
  maxTier?: number;
  /** Preferred candidate, with capability-compatible fallbacks behind it. */
  primaryModelId?: string;
  /** Reject models whose context window cannot fit the prepared request. */
  minimumContextWindow?: number;
  /** Which configured quality axis should order fallbacks. */
  prefer?: 'cost' | 'speed';
}

export interface RoutedExecution<T> {
  result: T;
  model: ModelDescriptor;
  fallbackReason?: string;
}

export class ModelRouter {
  private readonly models = new Map<string, ModelDescriptor>();
  private readonly health = new Map<string, { lastFailAt: number; consecutiveFails: number }>();
  private readonly failCooldownMs = 30_000; // 失败 30s 后再试

  register(desc: ModelDescriptor): void {
    this.models.set(desc.id, desc);
    this.health.set(desc.id, { lastFailAt: 0, consecutiveFails: 0 });
  }

  /** 标记模型调用失败（触发回退时由上层调用） */
  markFailed(modelId: string): void {
    const h = this.health.get(modelId);
    if (h) {
      h.lastFailAt = Date.now();
      h.consecutiveFails += 1;
    }
  }

  /** 标记成功（清除失败计数） */
  markSucceeded(modelId: string): void {
    const h = this.health.get(modelId);
    if (h) h.consecutiveFails = 0;
  }

  /** 选择最合适的模型 provider */
  select(request: RoutingRequest): ModelProvider {
    const matching = this.filterCandidates(request);

    if (matching.length === 0) {
      throw new ForgeError(
        'MODEL_CAPABILITY_MISMATCH',
        `没有匹配能力的模型：${request.requiredCapabilities?.join(',') ?? '无约束'}`,
        { details: { available: [...this.models.keys()] } },
      );
    }

    // 冷却中的模型不参与本次选择；全部不可用时明确失败。
    const candidates = this.sortCandidates(matching.filter((model) => model.available !== false), request);
    if (candidates.length === 0) {
      throw new ForgeError('MODEL_UNAVAILABLE', '匹配的模型缺少可用凭据', { details: { available: matching.map((c) => c.id) } });
    }
    const now = Date.now();
    const pick = candidates.find((c) => {
      const h = this.health.get(c.id)!;
      return h.consecutiveFails === 0 || now - h.lastFailAt >= this.failCooldownMs;
    });

    if (!pick) {
      throw new ForgeError(
        'MODEL_UNAVAILABLE',
        '所有模型都在冷却中，暂时无法选择',
      { details: { available: candidates.map((c) => c.id) } },
      );
    }

    return pick.provider;
  }

  /**
   * 带回退的执行：主模型失败自动尝试下一个。
   */
  async executeWithFallback<T>(
    request: RoutingRequest,
    fn: (provider: ModelProvider) => Promise<T>,
  ): Promise<T> {
    return (await this.executeWithFallbackDetailed(request, (provider) => fn(provider))).result;
  }

  /** Like executeWithFallback, with the selected model and sanitized fallback cause. */
  async executeWithFallbackDetailed<T>(
    request: RoutingRequest,
    fn: (provider: ModelProvider, descriptor: ModelDescriptor) => Promise<T>,
  ): Promise<RoutedExecution<T>> {
    const matching = this.filterCandidates(request);
    if (matching.length === 0) {
      throw new ForgeError(
        'MODEL_CAPABILITY_MISMATCH',
        `没有匹配能力的模型：${request.requiredCapabilities?.join(',') ?? '无约束'}`,
        { details: { available: [...this.models.keys()] } },
      );
    }
    const ready = matching.filter((model) => model.available !== false);
    if (ready.length === 0) {
      throw new ForgeError('MODEL_UNAVAILABLE', '匹配的模型缺少可用凭据', { details: { available: matching.map((c) => c.id) } });
    }
    const now = Date.now();
    const candidates = this.sortCandidates(ready.filter((c) => {
      const h = this.health.get(c.id)!;
      return h.consecutiveFails === 0 || now - h.lastFailAt >= this.failCooldownMs;
    }), request);
    if (candidates.length === 0) {
      throw new ForgeError('MODEL_UNAVAILABLE', '没有当前可用的模型', { details: { available: [...this.models.keys()] } });
    }
    const errors: string[] = [];

    for (const c of candidates) {
      try {
        const result = await fn(c.provider, c);
        this.markSucceeded(c.id);
        return {
          result,
          model: c,
          ...(errors.length > 0 ? { fallbackReason: errors.join('; ') } : {}),
        };
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.markFailed(c.id);
        errors.push(redactText(`${c.id}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    throw new ForgeError(
      'MODEL_FALLBACK_EXHAUSTED',
      `所有匹配模型都失败：${errors.join('；')}`,
      { details: { errors, request: { ...request, primaryModelId: request.primaryModelId } } },
    );
  }

  private filterCandidates(request: RoutingRequest): ModelDescriptor[] {
    let result = [...this.models.values()];

    if (request.requiredCapabilities && request.requiredCapabilities.length > 0) {
      result = result.filter((m) =>
        request.requiredCapabilities!.every((cap) => m.capabilities.includes(cap)),
      );
    }
    if (request.minimumContextWindow !== undefined) {
      result = result.filter((m) => m.contextWindow === undefined || m.contextWindow >= request.minimumContextWindow!);
    }
    if (request.maxTier !== undefined) {
      result = result.filter((m) => m.tier <= request.maxTier!);
    }
    if (request.preferTier !== undefined) {
      // 只是提示，不硬过滤
    }

    return result;
  }

  private sortCandidates(candidates: ModelDescriptor[], request: RoutingRequest): ModelDescriptor[] {
    return candidates.sort((a, b) => {
      if (request.primaryModelId) {
        const primaryA = a.id === request.primaryModelId ? 0 : 1;
        const primaryB = b.id === request.primaryModelId ? 0 : 1;
        if (primaryA !== primaryB) return primaryA - primaryB;
      }
      if (request.prefer === 'cost') {
        const costA = a.costTier ?? a.tier;
        const costB = b.costTier ?? b.tier;
        if (costA !== costB) return costA - costB;
      }
      if (request.prefer === 'speed') {
        const speedA = a.speedTier ?? a.tier;
        const speedB = b.speedTier ?? b.tier;
        if (speedA !== speedB) return speedA - speedB;
      }
      const tierA = request.preferTier === undefined ? a.tier : Math.abs(a.tier - request.preferTier);
      const tierB = request.preferTier === undefined ? b.tier : Math.abs(b.tier - request.preferTier);
      if (tierA !== tierB) return tierA - tierB;
      const healthA = this.health.get(a.id)?.consecutiveFails ?? 0;
      const healthB = this.health.get(b.id)?.consecutiveFails ?? 0;
      return healthA - healthB || a.tier - b.tier;
    });
  }

  listModels(): string[] {
    return [...this.models.keys()];
  }

  getModel(id: string): ModelDescriptor | undefined {
    return this.models.get(id);
  }
}
