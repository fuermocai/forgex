/**
 * 运行时模型切换（TUI /models 与纯文本模式共用）。
 *
 * 只替换 Provider 与上下文预算，不重建会话：历史消息、工具注册、权限策略全部保留。
 */
import { createProvider, MODEL_ROLES, type ConfiguredModel, type ModelCapability, type ModelConfig, type ModelRole } from '@forgex/models';
import { PROVIDERS } from '../config/providers.js';
import type { ForgeRuntime } from './create-runtime.js';
import { defaultConfigPath, findModelPreset, testConnectivity, writeModelRoleSelection, writeModelSelection } from './connect-core.js';

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

export interface ConfiguredModelSummary {
  id: string;
  protocol: string;
  model: string;
  capabilities: ModelCapability[];
  contextWindow: number;
  maxOutputTokens: number;
  costTier: number;
  speedTier: number;
  available: boolean;
  credentialEnv?: string;
  roles: ModelRole[];
}

export interface SwitchModelRoleResult {
  role: ModelRole;
  modelId: string;
  model: string;
  saved: boolean;
}

const ROLE_CAPABILITIES: Record<ModelRole, ModelCapability[]> = {
  default: ['chat'],
  cheap: ['chat', 'cheap'],
  reasoning: ['chat', 'reasoning'],
  coding: ['chat', 'coding'],
  vision: ['chat', 'vision'],
};

export function listConfiguredModels(runtime: ForgeRuntime): ConfiguredModelSummary[] {
  return runtime.config.models.map((model) => ({
    id: model.id,
    protocol: model.protocol,
    model: model.config.model,
    capabilities: [...model.capabilities],
    contextWindow: model.config.contextWindow,
    maxOutputTokens: model.config.maxOutputTokens,
    costTier: model.costTier,
    speedTier: model.speedTier,
    available: model.available,
    ...(model.config.apiKeyEnv ? { credentialEnv: model.config.apiKeyEnv } : {}),
    roles: MODEL_ROLES.filter((role) => runtime.config.modelRoles[role] === model.id),
  }));
}

export function formatConfiguredModels(runtime: ForgeRuntime): string {
  const models = listConfiguredModels(runtime);
  return [
    '已配置模型：',
    ...models.map((model) =>
      `  ${model.id} — ${model.model} [${model.protocol}] ${model.available ? '凭据就绪' : `缺少 ${model.credentialEnv ?? 'API Key'}`} ` +
      `能力=${model.capabilities.join(',')} 上下文=${model.contextWindow} roles=${model.roles.join(',') || '自动匹配'}`),
    `当前角色: ${runtime.agent.modelRole ?? 'default'}；当前模型: ${runtime.agent.modelName}`,
    '切换角色: /models role <default|cheap|reasoning|coding|vision> [model-id]',
    '检查连通性: /models check <model-id>',
    '旧式切换: /models <模型名>',
  ].join('\n');
}

export function switchModelRole(runtime: ForgeRuntime, roleInput: string, modelIdInput?: string): SwitchModelRoleResult {
  const role = roleInput.trim().toLowerCase() as ModelRole;
  if (!MODEL_ROLES.includes(role)) throw new Error(`未知模型角色: ${roleInput}（可选：${MODEL_ROLES.join(', ')}）`);

  const requestedId = modelIdInput?.trim() || runtime.config.modelRoles[role];
  const candidates = runtime.config.models.filter((model) => ROLE_CAPABILITIES[role].every((capability) => model.capabilities.includes(capability)));
  const selected = requestedId
    ? runtime.config.models.find((model) => model.id === requestedId)
    : [...candidates].sort((a, b) => (role === 'cheap' ? a.costTier - b.costTier : a.speedTier - b.speedTier))[0];
  if (!selected) {
    if (requestedId) throw new Error(`模型目录中没有 ID: ${requestedId}`);
    throw new Error(`没有支持 ${role} 角色所需能力 (${ROLE_CAPABILITIES[role].join(', ')}) 的模型`);
  }
  if (!ROLE_CAPABILITIES[role].every((capability) => selected.capabilities.includes(capability))) {
    throw new Error(`模型 ${selected.id} 不支持 ${role} 角色`);
  }

  runtime.agent.setModelRole(role, selected.id);
  runtime.config.modelRoles[role] = selected.id;
  const saved = writeModelRoleSelection(runtime.configPath, runtime.config.modelRoles);
  return { role, modelId: selected.id, model: selected.config.model, saved };
}

export async function checkModelConnectivity(runtime: ForgeRuntime, modelId: string) {
  const descriptor = runtime.modelRouter.getModel(modelId);
  if (!descriptor) throw new Error(`模型目录中没有 ID: ${modelId}`);
  const config = descriptor.provider.config;
  if (descriptor.available === false || (!config.apiKey && modelId !== 'legacy-default')) {
    return {
      ok: false,
      reason: '缺少可用凭据',
      detail: config.apiKeyEnv ? `配置环境变量 ${config.apiKeyEnv} 或凭据文件` : '请为该模型配置 apiKeyEnv 凭据来源',
    };
  }
  return testConnectivity({
    baseUrl: config.baseUrl,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    model: config.model,
    timeoutMs: Math.min(config.timeoutMs, 5000),
  });
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
  runtime.config.model = next;
  const legacyModel: ConfiguredModel = {
    id: 'legacy-default',
    protocol: 'openai-compatible',
    config: next,
    capabilities: ['chat'],
    costTier: 3,
    speedTier: 3,
    credentialSource: next.apiKey ? 'env' : null,
    available: true,
  };
  const existingLegacyIndex = runtime.config.models.findIndex((model) => model.id === 'legacy-default');
  if (existingLegacyIndex >= 0) runtime.config.models[existingLegacyIndex] = legacyModel;
  else runtime.config.models.push(legacyModel);
  runtime.modelRouter.register({
    id: 'legacy-default',
    provider,
    capabilities: ['chat'],
    tier: 3,
    costTier: 3,
    speedTier: 3,
    contextWindow: next.contextWindow,
    available: true,
  });
  runtime.config.modelRoles.default = 'legacy-default';
  runtime.agent.setModelRole('default', 'legacy-default');

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
