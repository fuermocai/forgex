/**
 * 运行时模型切换（TUI /models 与纯文本模式共用）。
 *
 * 只替换 Provider 与上下文预算，不重建会话：历史消息、工具注册、权限策略全部保留。
 */
import { createProvider, type ModelConfig } from '@forgex/models';
import { PROVIDERS } from '../config/providers.js';
import type { ForgeRuntime } from './create-runtime.js';
import { defaultConfigPath, findModelPreset, writeModelSelection } from './connect-core.js';

export interface SwitchModelResult {
  model: string;
  baseUrl: string;
  /** 是否已写入配置文件（false = 仅本次会话生效） */
  saved: boolean;
  /** 实际写入的配置文件路径（saved 为 false 时为空） */
  savedPath?: string;
  /** 该模型使用的 Key 环境变量名 */
  apiKeyEnv?: string;
  /** 切换后是否仍有可用的 Key（false 表示需要 /key 重新填） */
  keyReady: boolean;
}

/** baseUrl → 该端点约定的 Key 环境变量名 */
function envNameFor(baseUrl: string): string | undefined {
  const normalized = baseUrl.replace(/\/+$/, '');
  return Object.values(PROVIDERS).find((preset) => preset.defaultBaseUrl.replace(/\/+$/, '') === normalized)?.apiKeyEnv;
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

  // Key 跟着提供方走：跨提供方切换时旧 Key 不通用，不清理的话会把 DeepSeek 的 Key
  // 打到 Qwen 端点上，只得到一个 401，看起来像"Key 配错了"。这里改从目标端点的
  // 环境变量重新取；取不到就明确清空，让上层提示去 /key 补一个。
  const previousEnv = current.apiKeyEnv;
  const nextEnv = envNameFor(next.baseUrl);
  if (nextEnv) next.apiKeyEnv = nextEnv;
  if (nextEnv && previousEnv && nextEnv !== previousEnv) {
    const fromEnv = process.env[nextEnv];
    if (fromEnv) next.apiKey = fromEnv;
    else delete next.apiKey;
  }

  // 先构造 Provider 再改状态：构造失败时保持原模型不变
  const provider = createProvider(next, { logger: runtime.logger });
  runtime.agent.setProvider(provider);
  runtime.config.model = next;

  // 没有配置文件时写到默认路径（~/.forgex/config.json）并创建它，
  // 否则每次启动都要重选模型
  const targetPath = runtime.configPath ?? defaultConfigPath();
  const saved = writeModelSelection(targetPath, {
    model: trimmed,
    baseUrl: next.baseUrl,
    contextWindow: next.contextWindow,
    maxOutputTokens: next.maxOutputTokens,
  });

  return {
    model: trimmed,
    baseUrl: next.baseUrl,
    saved,
    ...(saved ? { savedPath: targetPath } : {}),
    ...(next.apiKeyEnv ? { apiKeyEnv: next.apiKeyEnv } : {}),
    keyReady: Boolean(next.apiKey),
  };
}
