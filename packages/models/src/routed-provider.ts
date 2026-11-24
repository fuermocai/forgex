import { estimateMessagesTokens } from '@forgex/shared';
import { ModelRouter, ModelStreamInterruptedError } from './model-router.js';
import type { ModelCapability, ModelConfig, ModelProvider, ModelRole, ChatRequest, ChatResponse, StreamHandlers } from './types.js';

const ROLE_CAPABILITIES: Record<ModelRole, ModelCapability[]> = {
  default: ['chat'],
  cheap: ['chat', 'cheap'],
  reasoning: ['chat', 'reasoning'],
  coding: ['chat', 'coding'],
  vision: ['chat', 'vision'],
};

/** ModelProvider facade that applies role preferences and capability-safe fallback. */
export class RoutedModelProvider implements ModelProvider {
  private role: ModelRole = 'default';

  constructor(
    private readonly router: ModelRouter,
    private readonly roleModelIds: Partial<Record<ModelRole, string>>,
  ) {}

  get currentModelRole(): ModelRole {
    return this.role;
  }

  get currentModelId(): string | undefined {
    return this.roleModelIds[this.role] ?? this.roleModelIds.default;
  }

  get name(): string {
    return this.currentDescriptor()?.provider.name ?? 'Routed model';
  }

  get config(): Readonly<ModelConfig> {
    return this.currentDescriptor()?.provider.config ?? EMPTY_CONFIG;
  }

  setModelRole(role: ModelRole): void {
    this.role = role;
  }

  setRoleModel(role: ModelRole, modelId: string): void {
    const model = this.router.getModel(modelId);
    if (!model) throw new Error(`Unknown model ID: ${modelId}`);
    if (!ROLE_CAPABILITIES[role].every((capability) => model.capabilities.includes(capability))) {
      throw new Error(`Model ${modelId} does not support role ${role}`);
    }
    this.roleModelIds[role] = modelId;
  }

  async chat(request: ChatRequest, handlers?: StreamHandlers): Promise<ChatResponse> {
    const primary = this.currentDescriptor();
    const requiredCapabilities = ROLE_CAPABILITIES[this.role] ?? ROLE_CAPABILITIES.default;
    const outputTokens = request.maxOutputTokens ?? primary?.provider.config.maxOutputTokens ?? 0;
    const minimumContextWindow = estimateMessagesTokens(request.messages) + outputTokens;
    const prefer = this.role === 'cheap' ? 'cost' : 'speed';
    const routed = await this.router.executeWithFallbackDetailed(
      {
        requiredCapabilities,
        ...(this.currentModelId ? { primaryModelId: this.currentModelId } : {}),
        minimumContextWindow,
        prefer,
      },
      async (provider) => {
        let emitted = false;
        try {
          return await provider.chat({
            ...request,
            maxOutputTokens: Math.min(outputTokens || provider.config.maxOutputTokens, provider.config.maxOutputTokens),
          }, handlers && {
            onDelta: (text) => {
              emitted = true;
              handlers.onDelta?.(text);
            },
            onFirstToken: () => handlers.onFirstToken?.(),
          });
        } catch (error) {
          if (!emitted) throw error;
          throw new ModelStreamInterruptedError(provider.config.model, { cause: error });
        }
      },
    );

    const fallbackReason = routed.fallbackReason
      ?? (this.currentModelId && routed.model.id !== this.currentModelId
        ? `Configured model ${this.currentModelId} was unavailable or incompatible with this request`
        : undefined);
    return {
      ...routed.result,
      modelId: routed.model.id,
      modelName: routed.model.provider.config.model,
      ...(fallbackReason ? { fallbackReason } : {}),
    };
  }

  private currentDescriptor() {
    const preferredId = this.currentModelId;
    const preferred = preferredId ? this.router.getModel(preferredId) : undefined;
    if (preferred) return preferred;
    const defaultId = this.roleModelIds.default;
    return defaultId ? this.router.getModel(defaultId) : undefined;
  }
}

const EMPTY_CONFIG: Readonly<ModelConfig> = {
  baseUrl: '', model: '', contextWindow: 1, maxOutputTokens: 1,
  temperature: 0, timeoutMs: 1, maxRetries: 0, stream: false,
};
