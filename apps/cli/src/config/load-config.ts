/**
 * 配置加载与校验。
 *
 * 优先级（后者覆盖前者）：
 *   内置默认值 < 配置文件 < 环境变量 < 命令行参数（由命令自行覆盖）
 *
 * 安全约束：
 *  - API Key 只允许来自配置文件或环境变量（`apiKeyEnv` 间接引用），
 *    不会出现在任何日志/会话/审计输出中；
 *  - 路径统一解析为绝对路径，避免相对路径在工具执行时随 cwd 漂移；
 *  - 配置非法时直接抛 CONFIG_INVALID，并给出字段级错误，不做"静默降级"。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ForgeError, createLogger, type Logger, type RemoteHostConfig } from '@forgex/shared';
import type { ModelConfig } from '@forgex/models';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';
const DEFAULT_MODEL = 'local-model';

const ModelSchema = z.object({
  baseUrl: z.string().min(1).default(DEFAULT_BASE_URL),
  apiKey: z.string().optional(),
  /** 从环境变量读取 API Key 的变量名（推荐，避免明文写入配置） */
  apiKeyEnv: z.string().optional(),
  model: z.string().min(1).default(DEFAULT_MODEL),
  contextWindow: z.number().int().min(1024).default(32768),
  maxOutputTokens: z.number().int().min(256).default(4096),
  temperature: z.number().min(0).max(2).default(0.2),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  stream: z.boolean().default(true),
  headers: z.record(z.string()).optional(),
  name: z.string().optional(),
});

const RemoteHostSchema = z.object({
  host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9._:-]+$/),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  privateKeyPath: z.string().min(1).max(4096),
  hostKeyFingerprint: z.string().min(16).max(128),
  aliases: z.array(z.string().min(1).max(253)).default([]),
  allowedPaths: z.array(z.string().min(1)).default([]),
});

const SecuritySchema = z.object({
  mode: z.enum(['readonly', 'standard', 'trusted', 'yolo']).default('standard'),
  workspaceRoots: z.array(z.string().min(1)).min(1).default(['.']),
  writableRoots: z.array(z.string().min(1)).optional(),
  requireApprovalForWrite: z.boolean().default(true),
  requireApprovalForExecute: z.boolean().default(true),
  commandTimeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  allowedPrograms: z.array(z.string()).default([]),
  approvalTimeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000),
  auditLogPath: z.string().optional(),
  /** v0.2.0：SSH 远程诊断授权主机（默认空 = 禁用） */
  remoteHosts: z.array(RemoteHostSchema).default([]),
});

const SessionSchema = z.object({
  dbPath: z.string().default(join('.forgex', 'sessions.db')),
});

const AgentSchema = z.object({
  maxIterations: z.number().int().min(1).max(50).default(12),
  maxConcurrency: z.number().int().min(1).max(8).default(3),
});

const ConfigSchema = z.object({
  model: ModelSchema.default({}),
  security: SecuritySchema.default({}),
  session: SessionSchema.default({}),
  agent: AgentSchema.default({}),
});

export type FileConfig = z.input<typeof ConfigSchema>;

export interface ResolvedConfig {
  model: ModelConfig;
  security: {
    mode: 'readonly' | 'standard' | 'trusted' | 'yolo';
    workspaceRoots: string[];
    writableRoots: string[];
    requireApprovalForWrite: boolean;
    requireApprovalForExecute: boolean;
    commandTimeoutMs: number;
    allowedPrograms: string[];
    approvalTimeoutMs: number;
    auditLogPath: string;
    /** v0.2.0：SSH 远程授权主机（privateKeyPath 已解析为绝对路径） */
    remoteHosts: RemoteHostConfig[];
  };
  session: { dbPath: string };
  agent: { maxIterations: number; maxConcurrency: number };
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** 实际读取的配置文件路径；未找到为 null */
  configPath: string | null;
  /** 配置来源说明（用于 doctor / config 命令展示） */
  sources: string[];
  /** 是否已显式配置模型（baseUrl/model 至少来自文件或环境变量） */
  modelConfigured: boolean;
}

export interface LoadConfigOptions {
  cwd?: string;
  /** 显式指定的配置文件（--config） */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** 跳过 ~/.forgex/config.json（测试隔离用，生产默认 false） */
  skipGlobal?: boolean;
}

/** 候选配置文件路径（按优先级） */
export function candidateConfigPaths(cwd: string, env: NodeJS.ProcessEnv, options?: { skipGlobal?: boolean }): string[] {
  const paths: string[] = [];
  if (env.FORGEX_CONFIG) paths.push(expandHome(env.FORGEX_CONFIG));
  paths.push(join(cwd, 'forgex.config.json'));
  if (!options?.skipGlobal) paths.push(join(homedir(), '.forgex', 'config.json'));
  return paths;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const logger = options.logger ?? createLogger({ level: 'warn' });
  const sources: string[] = ['默认值'];

  let configPath: string | null = null;
  let fileData: Record<string, unknown> = {};
  if (options.configPath) {
    const explicit = expandHome(options.configPath);
    if (!existsSync(explicit)) {
      throw new ForgeError('CONFIG_INVALID', `配置文件不存在: ${explicit}`);
    }
    configPath = explicit;
  } else {
    configPath = candidateConfigPaths(cwd, env, { skipGlobal: options.skipGlobal }).find((candidate) => existsSync(candidate)) ?? null;
  }

  if (configPath) {
    fileData = readConfigFile(configPath, logger);
    sources.push(`配置文件 ${configPath}`);
  }

  const envData = readEnvConfig(env);
  if (Object.keys(envData).length > 0) sources.push('环境变量');

  const merged = deepMerge(fileData, envData);
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ForgeError('CONFIG_INVALID', `配置校验失败: ${issues}`);
  }
  const value = parsed.data;

  // API Key：优先 apiKeyEnv 指向的环境变量，其次配置文件明文
  const envKeyName = value.model.apiKeyEnv;
  const apiKey = envKeyName ? env[envKeyName] : value.model.apiKey;
  if (envKeyName && !apiKey) {
    logger.warn('配置引用的 API Key 环境变量为空', { env: envKeyName });
  }

  const modelConfigured = determineModelConfigured(fileData, env, value);

  const model: ModelConfig = {
    baseUrl: normalizeBaseUrl(value.model.baseUrl),
    model: value.model.model,
    contextWindow: value.model.contextWindow,
    maxOutputTokens: value.model.maxOutputTokens,
    temperature: value.model.temperature,
    timeoutMs: value.model.timeoutMs,
    maxRetries: value.model.maxRetries,
    stream: value.model.stream,
    ...(apiKey ? { apiKey } : {}),
    ...(value.model.headers ? { headers: value.model.headers } : {}),
    ...(value.model.name ? { name: value.model.name } : {}),
  };

  const workspaceRoots = value.security.workspaceRoots.map((root) => resolveFrom(cwd, root));
  const writableRoots = (value.security.writableRoots ?? value.security.workspaceRoots).map((root) =>
    resolveFrom(cwd, root),
  );
  const auditLogPath = resolveFrom(cwd, value.security.auditLogPath ?? join('.forgex', 'audit.jsonl'));
  const dbPath = resolveFrom(cwd, value.session.dbPath);

  // v0.2.0：解析 remoteHosts（privateKeyPath 统一为绝对路径）
  const remoteHosts: RemoteHostConfig[] = value.security.remoteHosts.map((host) => ({
    ...host,
    privateKeyPath: resolveFrom(cwd, host.privateKeyPath),
  }));

  return {
    config: {
      model,
      security: {
        mode: value.security.mode,
        workspaceRoots,
        writableRoots,
        requireApprovalForWrite: value.security.requireApprovalForWrite,
        requireApprovalForExecute: value.security.requireApprovalForExecute,
        commandTimeoutMs: value.security.commandTimeoutMs,
        allowedPrograms: value.security.allowedPrograms,
        approvalTimeoutMs: value.security.approvalTimeoutMs,
        auditLogPath,
        remoteHosts,
      },
      session: { dbPath },
      agent: { maxIterations: value.agent.maxIterations, maxConcurrency: value.agent.maxConcurrency },
    },
    configPath,
    sources,
    modelConfigured,
  };
}

/* ------------------------------------------------------------------ */
/* 内部辅助                                                            */
/* ------------------------------------------------------------------ */

function readConfigFile(path: string, logger: Logger): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ForgeError('CONFIG_INVALID', `无法读取配置文件: ${path}`, { cause: err });
  }
  // 去掉 UTF-8 BOM，Windows 编辑器常见
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('根节点必须是对象');
    }
    return data as Record<string, unknown>;
  } catch (err) {
    logger.error('配置文件不是合法 JSON', { path, error: err instanceof Error ? err.message : String(err) });
    throw new ForgeError('CONFIG_INVALID', `配置文件不是合法 JSON: ${path}`);
  }
}

function readEnvConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const model: Record<string, unknown> = {};
  const security: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const agent: Record<string, unknown> = {};

  if (env.FORGEX_BASE_URL) model.baseUrl = env.FORGEX_BASE_URL;
  if (env.FORGEX_API_KEY) model.apiKey = env.FORGEX_API_KEY;
  if (env.FORGEX_API_KEY_ENV) model.apiKeyEnv = env.FORGEX_API_KEY_ENV;
  if (env.FORGEX_MODEL) model.model = env.FORGEX_MODEL;
  const contextWindow = numberEnv(env.FORGEX_CONTEXT_WINDOW);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxOutputTokens = numberEnv(env.FORGEX_MAX_OUTPUT_TOKENS);
  if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;
  const temperature = numberEnv(env.FORGEX_TEMPERATURE);
  if (temperature !== undefined) model.temperature = temperature;
  const timeoutMs = numberEnv(env.FORGEX_TIMEOUT_MS);
  if (timeoutMs !== undefined) model.timeoutMs = timeoutMs;
  const maxRetries = numberEnv(env.FORGEX_MAX_RETRIES);
  if (maxRetries !== undefined) model.maxRetries = maxRetries;
  if (env.FORGEX_STREAM !== undefined) model.stream = env.FORGEX_STREAM !== '0' && env.FORGEX_STREAM !== 'false';

  if (env.FORGEX_PERMISSION_MODE) security.mode = env.FORGEX_PERMISSION_MODE;
  if (env.FORGEX_WORKSPACE) security.workspaceRoots = [env.FORGEX_WORKSPACE];
  if (env.FORGEX_ALLOWED_PROGRAMS) {
    security.allowedPrograms = env.FORGEX_ALLOWED_PROGRAMS.split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const commandTimeout = numberEnv(env.FORGEX_COMMAND_TIMEOUT_MS);
  if (commandTimeout !== undefined) security.commandTimeoutMs = commandTimeout;
  if (env.FORGEX_AUDIT_LOG) security.auditLogPath = env.FORGEX_AUDIT_LOG;

  if (env.FORGEX_DB_PATH) session.dbPath = env.FORGEX_DB_PATH;
  const maxIterations = numberEnv(env.FORGEX_MAX_ITERATIONS);
  if (maxIterations !== undefined) agent.maxIterations = maxIterations;

  const out: Record<string, unknown> = {};
  if (Object.keys(model).length > 0) out.model = model;
  if (Object.keys(security).length > 0) out.security = security;
  if (Object.keys(session).length > 0) out.session = session;
  if (Object.keys(agent).length > 0) out.agent = agent;
  return out;
}

/** 判断模型是否被显式配置（而不是落到默认占位值） */
function determineModelConfigured(
  fileData: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  parsed: z.output<typeof ConfigSchema>,
): boolean {
  if (env.FORGEX_BASE_URL || env.FORGEX_MODEL) return true;
  const model = fileData.model;
  if (model && typeof model === 'object') {
    const record = model as Record<string, unknown>;
    if (typeof record.baseUrl === 'string' || typeof record.model === 'string') return true;
  }
  // 配置了自定义端口或模型名（非默认占位值）也视为已配置
  return parsed.model.baseUrl !== DEFAULT_BASE_URL || parsed.model.model !== DEFAULT_MODEL;
}

function numberEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** 一层深合并（配置结构固定为两级，足够使用） */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    if (isRecord(current) && isRecord(value)) {
      out[key] = { ...current, ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveFrom(cwd: string, target: string): string {
  const expanded = expandHome(target);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function expandHome(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) return join(homedir(), target.slice(2));
  return target;
}

/** 去掉 baseUrl 末尾多余的斜杠（Provider 内部会拼接 /chat/completions） */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}
