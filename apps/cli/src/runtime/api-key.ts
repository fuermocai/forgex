/**
 * API Key 就地更新（TUI `/key` 与纯文本模式共用）。
 *
 * 与 `/connect` 的区别：不重选 provider/baseUrl/model，只替换 Key，
 * 适合「配置都在，只差换个 Key」这种最常见的场景。
 *
 * 落盘策略沿用 connect-core：Windows 写用户环境变量，其余平台写
 * `~/.forgex/credentials.json`（0600），下次启动由 loadConfig 兜底注入。
 */
import { createProvider, type ModelConfig } from '@forgex/models';
import { PROVIDERS } from '../config/providers.js';
import { defaultConfigPath, maskKey, persistApiKey, writeModelSelection } from './connect-core.js';
import type { ForgeRuntime } from './create-runtime.js';

/** 从 baseUrl 反查 Provider 预设，拿到该 Provider 约定的 Key 环境变量名 */
export function apiKeyEnvFor(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  for (const preset of Object.values(PROVIDERS)) {
    if (preset.defaultBaseUrl.replace(/\/+$/, '') === normalized) return preset.apiKeyEnv;
  }
  return 'FORGEX_API_KEY';
}

/** 当前生效的 Key 环境变量名：配置里声明优先，其次按 baseUrl 反查预设 */
export function currentApiKeyEnv(runtime: ForgeRuntime): string {
  return runtime.config.model.apiKeyEnv ?? apiKeyEnvFor(runtime.config.model.baseUrl);
}

export interface ApplyApiKeyResult {
  envName: string;
  masked: string;
  /** 是否已持久化（false 时 hint 给出让用户自行设置的方式） */
  saved: boolean;
  hint: string;
  /** 是否把「当前模型」写进了配置文件（重启后 baseUrl/model/apiKeyEnv 才不会丢） */
  configSaved: boolean;
  /** 实际写入的配置文件路径（configSaved 为 false 时为空） */
  configPath?: string;
}

/**
 * 更新当前模型的 API Key。
 *
 * 顺序很重要：先构造 Provider 再改运行时状态与配置，构造失败时保持原 Key 不变，
 * 避免「提示已更新但实际不可用」。
 *
 * 落盘分两份：
 *  1. Key 本身 → 凭据文件（0600）或 Windows 用户环境变量；
 *  2. 当前模型身份（baseUrl / model / apiKeyEnv）→ 配置文件。
 * 只做第 1 步是不够的：没有配置文件时下次启动会退回 `127.0.0.1:8000` + `local-model`，
 * Key 读到了却发往错误端点，用户感受同样是「Key 不记得了」。
 */
export function applyApiKey(runtime: ForgeRuntime, key: string): ApplyApiKeyResult {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API Key 不能为空');

  // 优先沿用配置里声明的环境变量名：否则「配置写 DEEPSEEK_API_KEY、这里存 FORGEX_API_KEY」
  // 会导致下次启动两边对不上，Key 等于白填
  const envName = currentApiKeyEnv(runtime);
  const next: ModelConfig = { ...runtime.config.model, apiKey: trimmed, apiKeyEnv: envName };

  const provider = createProvider(next, { logger: runtime.logger });
  runtime.agent.setProvider(provider);
  runtime.config.model = next;

  // 当前进程立即可用；持久化失败也不影响本次会话
  process.env[envName] = trimmed;
  const persisted = persistApiKey(envName, trimmed);

  // 写回时显式带上 envName：不能让它按 baseUrl 再猜一次，
  // 否则「存到 A 变量、配置里指向 B 变量」这种错位会让 Key 下次启动直接失效
  const targetPath = runtime.configPath ?? defaultConfigPath();
  const configSaved = writeModelSelection(targetPath, {
    model: next.model,
    baseUrl: next.baseUrl,
    contextWindow: next.contextWindow,
    maxOutputTokens: next.maxOutputTokens,
    apiKeyEnv: envName,
  });

  return {
    envName,
    masked: maskKey(trimmed),
    saved: persisted.ok,
    hint: persisted.hint,
    configSaved,
    ...(configSaved ? { configPath: targetPath } : {}),
  };
}
