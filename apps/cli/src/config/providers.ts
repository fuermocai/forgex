/**
 * 模型 Provider 预设（连接向导、TUI `/connect`、配置自动识别共用）。
 *
 * 放在 config 目录而不是 connect-core，是为了让 load-config 能在「没有任何
 * 配置、只设置了 API Key 环境变量」时直接推断出 baseUrl / model，避免循环依赖。
 */
export interface ProviderPreset {
  name: string;
  defaultBaseUrl: string;
  defaultModel: string;
  apiKeyEnv: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  deepseek: {
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
  },
  qwen: {
    name: 'Qwen (DashScope compatible-mode)',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    contextWindow: 131_072,
    maxOutputTokens: 8192,
  },
  openai: {
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  },
  custom: {
    name: '自定义兼容端点（vLLM / Ollama / 内网网关）',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'local-model',
    apiKeyEnv: 'FORGEX_API_KEY',
    contextWindow: 32_768,
    maxOutputTokens: 4096,
  },
};

export const PROVIDERS_KEYS = Object.keys(PROVIDERS);
