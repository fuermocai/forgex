/**
 * 模型连接核心逻辑（`forgex connect` 命令与 TUI `/connect` 共用）。
 *
 * 设计：
 *  - 配置里只写 `apiKeyEnv` 引用，**API Key 从不明文落盘到配置文件**；
 *  - Key 统一存 `~/.forgex/credentials.json`（0600），三平台行为一致，重开即生效；
 *  - 连通性测试发最小请求（max_tokens=1，5s 超时），失败只回显状态码 + 前 200 字符；
 *  - 所有 Key 在输出前必须经过 maskKey 脱敏。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/* ------------------------------------------------------------------ */
/* Provider 预设（定义在 config/providers，这里保留 re-export）          */
/* ------------------------------------------------------------------ */

import { PROVIDERS, PROVIDERS_KEYS, type ProviderPreset } from '../config/providers.js';

export { PROVIDERS, PROVIDERS_KEYS };
export type { ProviderPreset };

/** 把用户输入（编号 / 名称 / 空）解析为 provider key */
export function resolveProvider(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return 'deepseek';
  const num = Number(trimmed);
  if (Number.isInteger(num) && num >= 1 && num <= PROVIDERS_KEYS.length) {
    return PROVIDERS_KEYS[num - 1]!;
  }
  const lower = trimmed.toLowerCase();
  if (PROVIDERS[lower]) return lower;
  return 'custom';
}

/* ------------------------------------------------------------------ */
/* 常用模型目录（TUI /models 用）                                       */
/* ------------------------------------------------------------------ */

export interface ModelPreset {
  model: string;
  label: string;
  baseUrl: string;
  contextWindow: number;
  maxOutputTokens: number;
  apiKeyEnv: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    model: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash · 1M 上下文 · 便宜',
    baseUrl: PROVIDERS.deepseek!.defaultBaseUrl,
    contextWindow: PROVIDERS.deepseek!.contextWindow,
    maxOutputTokens: PROVIDERS.deepseek!.maxOutputTokens,
    apiKeyEnv: PROVIDERS.deepseek!.apiKeyEnv,
  },
  {
    model: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro · 1M 上下文 · 强推理',
    baseUrl: PROVIDERS.deepseek!.defaultBaseUrl,
    contextWindow: PROVIDERS.deepseek!.contextWindow,
    maxOutputTokens: PROVIDERS.deepseek!.maxOutputTokens,
    apiKeyEnv: PROVIDERS.deepseek!.apiKeyEnv,
  },
];

export function findModelPreset(model: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.model === model);
}

/* ------------------------------------------------------------------ */
/* 连通性测试                                                          */
/* ------------------------------------------------------------------ */

export interface ConnectivityResult {
  ok: boolean;
  reason: string;
  detail?: string;
  latencyMs?: number;
}

export async function testConnectivity(cfg: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): Promise<ConnectivityResult> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({
    model: cfg.model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    temperature: 0,
    stream: false,
  });

  const start = Date.now();
  const controller = new AbortController();
  const timeout = cfg.timeoutMs ?? 5000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body,
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;
    const text = await res.text();

    if (!res.ok) {
      let detail = '';
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        const error = json.error as Record<string, unknown> | undefined;
        detail = typeof error?.message === 'string' ? error.message : typeof json.message === 'string' ? json.message : text.slice(0, 200);
      } catch {
        detail = text.slice(0, 200);
      }
      return { ok: false, reason: `HTTP ${res.status}`, detail, latencyMs };
    }

    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (Array.isArray(json.choices) && json.choices.length > 0) {
        return { ok: true, reason: 'ok', latencyMs };
      }
      return { ok: false, reason: '响应格式异常', detail: text.slice(0, 200), latencyMs };
    } catch {
      return { ok: false, reason: '响应无法解析', detail: text.slice(0, 200), latencyMs };
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { ok: false, reason: `${timeout / 1000}s 超时`, detail: '请检查 baseUrl 或网络' };
    }
    return { ok: false, reason: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 配置读写                                                            */
/* ------------------------------------------------------------------ */

export function defaultConfigPath(): string {
  return resolve(homedir(), '.forgex', 'config.json');
}

export interface ExistingConfig {
  model: {
    baseUrl: string;
    model: string;
    contextWindow: number;
    maxOutputTokens: number;
    stream: boolean;
    [key: string]: unknown;
  };
  security: Record<string, unknown>;
  session: Record<string, unknown>;
  agent: Record<string, unknown>;
}

export function readExistingConfig(path: string): ExistingConfig {
  const defaults: ExistingConfig = {
    model: {
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'local-model',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      stream: true,
    },
    security: {
      mode: 'standard',
      workspaceRoots: ['.'],
      requireApprovalForWrite: true,
      requireApprovalForExecute: true,
    },
    session: { dbPath: join('.forgex', 'sessions.db') },
    agent: { maxIterations: 12, maxConcurrency: 3 },
  };
  if (!existsSync(path)) return defaults;
  try {
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...defaults,
      ...parsed,
      model: { ...defaults.model, ...(parsed.model as Record<string, unknown>) },
      security: { ...defaults.security, ...(parsed.security as Record<string, unknown>) },
      session: { ...defaults.session, ...(parsed.session as Record<string, unknown>) },
      agent: { ...defaults.agent, ...(parsed.agent as Record<string, unknown>) },
    } as ExistingConfig;
  } catch {
    return defaults;
  }
}

export function buildConfig(
  existing: ExistingConfig,
  patch: { baseUrl: string; model: string; envName: string; contextWindow?: number; maxOutputTokens?: number },
): Record<string, unknown> {
  return {
    model: {
      ...existing.model,
      baseUrl: patch.baseUrl,
      model: patch.model,
      apiKeyEnv: patch.envName,
      ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
      ...(patch.maxOutputTokens !== undefined ? { maxOutputTokens: patch.maxOutputTokens } : {}),
    },
    security: existing.security,
    session: existing.session,
    agent: existing.agent,
  };
}

export function writeJsonConfig(path: string, config: Record<string, unknown>): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/** `/connect` 落盘：保留其余字段，只更新 model 段 */
export function saveConnectionConfig(
  path: string,
  existing: ExistingConfig,
  patch: { baseUrl: string; model: string; envName: string; contextWindow?: number; maxOutputTokens?: number },
): void {
  writeJsonConfig(path, buildConfig(existing, patch));
}

/**
 * `/models` 落盘：只改 model 段。
 *
 * 没有配置文件时**创建**默认配置再写入：以前这里遇到 path=null 直接返回 false，
 * 结果是「第一次装好、还没跑过 /connect」的用户每次选模型都提示「未找到配置文件，
 * 本次切换仅在当前会话生效」，下次启动又要重选一遍。
 */
export function writeModelSelection(
  path: string | null,
  patch: {
    model: string;
    baseUrl: string;
    contextWindow: number;
    maxOutputTokens: number;
    /** 显式指定 Key 的环境变量名（`/key` 用它保证「存哪读哪」） */
    apiKeyEnv?: string;
  },
): boolean {
  const target = path ?? defaultConfigPath();
  try {
    const existing = readExistingConfig(target);
    const model: Record<string, unknown> = {
      ...existing.model,
      model: patch.model,
      baseUrl: patch.baseUrl,
      contextWindow: patch.contextWindow,
      maxOutputTokens: patch.maxOutputTokens,
    };
    // Key 的环境变量名跟着 baseUrl 走：切到 DeepSeek 就该存 DEEPSEEK_API_KEY，
    // 否则 /key 落盘的位置和配置里声明的对不上，下次启动读不到。
    // 调用方显式给了 apiKeyEnv（`/key` 场景）时以它为准——写入方和读取方必须是同一个名字。
    const normalizedBaseUrl = patch.baseUrl.replace(/\/+$/, '');
    const matched = Object.values(PROVIDERS).find(
      (preset) => preset.defaultBaseUrl.replace(/\/+$/, '') === normalizedBaseUrl,
    );
    const existingEnv = typeof model.apiKeyEnv === 'string' ? model.apiKeyEnv : undefined;
    model.apiKeyEnv = patch.apiKeyEnv ?? matched?.apiKeyEnv ?? existingEnv ?? 'FORGEX_API_KEY';
    writeJsonConfig(target, {
      model,
      security: existing.security,
      session: existing.session,
      agent: existing.agent,
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* API Key 持久化                                                      */
/* ------------------------------------------------------------------ */

/**
 * 跨平台持久化 API Key。返回 { ok, hint }（hint 说明 Key 存到了哪里）。
 *
 * **所有平台都写一遍 credentials.json**，这是关键：
 *  - Linux / macOS 没有能跨终端持久的用户级环境变量，只能靠文件；
 *  - Windows 虽然可以写用户环境变量，但**已经在运行的终端不会继承新变量**——
 *    用户在同一个窗口里重开 forgex 依然读不到 Key，表现出来就是「填一次就没了」。
 *    所以文件是必做兜底，环境变量只是额外一层（新开的终端也能用）。
 */
/**
 * 跨平台持久化 API Key → `~/.forgex/credentials.json`（0600）。返回 { ok, hint }。
 *
 * 为什么不再写 Windows 用户环境变量：
 *  - 它**只对新开的终端生效**，同一个窗口里重开 forgex 依然读不到，
 *    表现出来就是「填一次就没了」——同一份配置在两处表现不一致最难排查；
 *  - 往注册表里写明文 Key 是额外的一份拷贝，凭据文件一样能覆盖需求。
 * 统一走凭据文件后，行为在三个平台一致：填一次，之后每次启动都能读到。
 * 真实环境变量仍然优先级更高，想用 export 的用户不受影响。
 */
export function persistApiKey(
  name: string,
  value: string,
  options: { path?: string } = {},
): { ok: boolean; hint: string } {
  const path = options.path ?? defaultCredentialsPath();
  if (writeCredential(name, value, path)) return { ok: true, hint: path };
  return { ok: false, hint: `无法写入凭据文件，请在 shell 中 export ${name}=...` };
}

/** 凭据文件路径（Linux/macOS 的主存储；Windows 作为兜底同样会写） */
export function defaultCredentialsPath(): string {
  return resolve(homedir(), '.forgex', 'credentials.json');
}

/**
 * 写入 / 更新凭据文件中的一项。
 *
 * 文件内含明文 Key，因此强制 0600：`writeFileSync` 的 mode 只在**新建**时生效，
 * 已存在的文件必须再 chmod 一次，否则老文件可能被同组用户读到。
 */
export function writeCredential(name: string, value: string, path = defaultCredentialsPath()): boolean {
  try {
    ensureDir(dirname(path));
    let data: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') data = parsed;
      } catch {
        data = {};
      }
    }
    const current = (typeof data.keys === 'object' && data.keys !== null ? data.keys : {}) as Record<string, unknown>;
    data.keys = { ...current, [name]: value };
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows 上无意义，忽略
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 3) + '****' + key.slice(-3);
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
