/**
 * 模型连接核心逻辑（`forgex connect` 命令与 TUI `/connect` 共用）。
 *
 * 设计：
 *  - 配置里只写 `apiKeyEnv` 引用，**API Key 从不明文落盘**；
 *  - Windows 用 .NET Environment 写用户级环境变量，其他平台只给 export 提示；
 *  - 连通性测试发最小请求（max_tokens=1，5s 超时），失败只回显状态码 + 前 200 字符；
 *  - 所有 Key 在输出前必须经过 maskKey 脱敏。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
 * 返回 false 表示没有可写的配置文件（本次切换仅内存生效）。
 */
export function writeModelSelection(
  path: string | null,
  patch: { model: string; baseUrl: string; contextWindow: number; maxOutputTokens: number },
): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const model = (parsed.model ?? {}) as Record<string, unknown>;
    parsed.model = {
      ...model,
      model: patch.model,
      baseUrl: patch.baseUrl,
      contextWindow: patch.contextWindow,
      maxOutputTokens: patch.maxOutputTokens,
    };
    writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* API Key 持久化                                                      */
/* ------------------------------------------------------------------ */

/** 跨平台持久化 API Key。返回 { ok, hint }。 */
export function persistApiKey(name: string, value: string): { ok: boolean; hint: string } {
  try {
    if (process.platform === 'win32') {
      // Windows：写用户级环境变量，跨终端持久
      const script = `[Environment]::SetEnvironmentVariable('${name}', '${escapeSingleQuote(value)}', 'User')`;
      execFileSync('powershell', ['-NoProfile', '-Command', script], {
        windowsHide: true,
        timeout: 10_000,
      });
      return { ok: true, hint: '' };
    }
    return {
      ok: false,
      hint: `在 ~/.zshrc 或 ~/.bashrc 添加：export ${name}='${escapeSingleQuote(value)}'`,
    };
  } catch {
    return { ok: false, hint: `手动设置 ${name}` };
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

function escapeSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}
