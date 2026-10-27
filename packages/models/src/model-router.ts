/**
 * ModelRouter：模型路由器（v0.5.0 Phase 5）。
 *
 * 职责：
 *   - 根据任务能力需求（coding/vision/reasoning/cheap/fast）选择合适的模型；
 *   - 主模型不可用时自动回退到备用模型；
 *   - 不引入密钥，配置由上层注入；
 *   - 回退耗尽抛 MODEL_FALLBACK_EXHAUSTED。
 */
import { ForgeError } from '@forgex/shared';
import type { ModelProvider } from './types.js';

export type ModelCapability = 'coding' | 'vision' | 'reasoning' | 'chat' | 'fast' | 'cheap' | 'large-context';

export interface ModelDescriptor {
  /** 模型唯一 ID */
  id: string;
  /** provider 实例 */
  provider: ModelProvider;
  /** 该模型具备的能力标签 */
  capabilities: ModelCapability[];
  /** 成本/延迟等级：1=最低 5=最高 */
  tier: 1 | 2 | 3 | 4 | 5;
}

export interface RoutingRequest {
  /** 需要的能力（任一匹配即可） */
  requiredCapabilities?: ModelCapability[];
  /** 优先 tier（越小越便宜快） */
  preferTier?: number;
  /** 最大容忍 tier */
  maxTier?: number;
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
    const candidates = this.sortCandidates(this.filterCandidates(request), request);

    if (candidates.length === 0) {
      throw new ForgeError(
        'MODEL_CAPABILITY_MISMATCH',
        `没有匹配能力的模型：${request.requiredCapabilities?.join(',') ?? '无约束'}`,
        { details: { available: [...this.models.keys()] } },
      );
    }

    // 冷却中的模型不参与本次选择；全部不可用时明确失败。
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
    const matching = this.filterCandidates(request);
    if (matching.length === 0) {
      throw new ForgeError(
        'MODEL_CAPABILITY_MISMATCH',
        `没有匹配能力的模型：${request.requiredCapabilities?.join(',') ?? '无约束'}`,
        { details: { available: [...this.models.keys()] } },
      );
    }
    const now = Date.now();
    const candidates = this.sortCandidates(matching.filter((c) => {
      const h = this.health.get(c.id)!;
      return h.consecutiveFails === 0 || now - h.lastFailAt >= this.failCooldownMs;
    }), request);
    if (candidates.length === 0) {
      throw new ForgeError('MODEL_UNAVAILABLE', '没有当前可用的模型', { details: { available: [...this.models.keys()] } });
    }
    const errors: string[] = [];

    for (const c of candidates) {
      try {
        const result = await fn(c.provider);
        this.markSucceeded(c.id);
        return result;
      } catch (err) {
        this.markFailed(c.id);
        errors.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new ForgeError(
      'MODEL_FALLBACK_EXHAUSTED',
      `所有匹配模型都失败：${errors.join('；')}`,
      { details: { errors, request } },
    );
  }

  private filterCandidates(request: RoutingRequest): ModelDescriptor[] {
    let result = [...this.models.values()];

    if (request.requiredCapabilities && request.requiredCapabilities.length > 0) {
      result = result.filter((m) =>
        request.requiredCapabilities!.some((cap) => m.capabilities.includes(cap)),
      );
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
}
