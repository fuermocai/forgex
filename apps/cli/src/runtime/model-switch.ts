/**
 * 运行时模型切换（TUI /models 与纯文本模式共用）。
 *
 * 只替换 Provider 与上下文预算，不重建会话：历史消息、工具注册、权限策略全部保留。
 */
import { createProvider, type ModelConfig } from '@forgex/models';
import type { ForgeRuntime } from './create-runtime.js';
import { findModelPreset, writeModelSelection } from './connect-core.js';

export interface SwitchModelResult {
  model: string;
  baseUrl: string;
  /** 是否已写入配置文件（false = 仅本次会话生效） */
  saved: boolean;
}

/** 切换模型；失败时抛错，由调用方转成用户可见提示 */
export function switchModel(runtime: ForgeRuntime, name: string): SwitchModelResult {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('模型名不能为空');

  const preset = findModelPreset(trimmed);
  const current = runtime.config.model;
  const next: ModelConfig = {
    ...current,
    model: trimmed,
    ...(preset
      ? {
          baseUrl: preset.baseUrl,
          contextWindow: preset.contextWindow,
          maxOutputTokens: preset.maxOutputTokens,
        }
      : {}),
  };

  // 先构造 Provider 再改状态：构造失败时保持原模型不变
  const provider = createProvider(next, { logger: runtime.logger });
  runtime.agent.setProvider(provider);
  runtime.config.model = next;

  const saved = writeModelSelection(runtime.configPath, {
    model: trimmed,
    baseUrl: next.baseUrl,
    contextWindow: next.contextWindow,
    maxOutputTokens: next.maxOutputTokens,
  });

  return { model: trimmed, baseUrl: next.baseUrl, saved };
}
