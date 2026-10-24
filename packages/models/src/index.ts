export * from './types.js';
export * from './openai-compatible.js';
export * from './model-router.js';

import type { Logger } from '@forgex/shared';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ModelConfig, ModelProvider } from './types.js';

/**
 * Provider 工厂。
 * 后续接入其他协议（如 Anthropic Messages、企业内部私有协议）时在此扩展，
 * 业务代码无需改动。
 */
export function createProvider(
  config: ModelConfig,
  options: { logger?: Logger; fetchImpl?: typeof fetch } = {},
): ModelProvider {
  return new OpenAICompatibleProvider({
    config,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
