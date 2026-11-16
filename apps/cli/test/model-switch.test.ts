/**
 * /models 运行时切换测试：真实 Runtime + 临时配置 + JSONL 持久化。
 *
 * 不发起网络请求：只验证 Provider 替换、上下文预算、会话保留与配置落盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load-config.js';
import { createRuntime, type ForgeRuntime } from '../src/runtime/create-runtime.js';
import { checkModelConnectivity, listConfiguredModels, switchModel, switchModelRole } from '../src/runtime/model-switch.js';

let dir: string;
let configPath: string;
let runtime: ForgeRuntime | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgex-model-switch-'));
  await mkdir(join(dir, '.forgex'), { recursive: true });
  configPath = join(dir, 'forgex.config.json');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        model: {
          baseUrl: 'https://api.deepseek.com',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          model: 'deepseek-flash',
          contextWindow: 1_000_000,
          maxOutputTokens: 8192,
          temperature: 0.2,
          stream: true,
        },
        models: [
          {
            id: 'fast', protocol: 'openai-compatible', baseUrl: 'https://fast.example/v1', apiKeyEnv: 'FAST_API_KEY',
            model: 'fast-model', contextWindow: 8192, maxOutputTokens: 1024, capabilities: ['chat', 'cheap'], costTier: 1, speedTier: 1,
          },
          {
            id: 'code', protocol: 'openai-compatible', baseUrl: 'https://code.example/v1', apiKeyEnv: 'CODE_API_KEY',
            model: 'code-model', contextWindow: 32768, maxOutputTokens: 4096, capabilities: ['chat', 'coding', 'reasoning'], costTier: 3, speedTier: 2,
          },
        ],
        modelRoles: { default: 'code', coding: 'code', cheap: 'fast' },
        security: { mode: 'standard', workspaceRoots: ['.'] },
        session: { dbPath: '.forgex/events.jsonl' },
        agent: { maxIterations: 12, maxConcurrency: 3 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const loaded = loadConfig({
    cwd: dir,
    configPath,
    skipGlobal: true,
    skipCredentials: true,
    env: { DEEPSEEK_API_KEY: 'sk-test', FAST_API_KEY: 'sk-fast-test', CODE_API_KEY: 'sk-code-test' },
  });
  runtime = createRuntime({ cwd: dir, loaded });
});

afterEach(async () => {
  await runtime?.close();
  runtime = null;
  await rm(dir, { recursive: true, force: true });
});

describe('/models 切换模型', () => {
  it('lists configured models and role targets without exposing credentials', () => {
    expect(listConfiguredModels(runtime!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'fast', model: 'fast-model', available: true, roles: ['cheap'] }),
      expect.objectContaining({ id: 'code', model: 'code-model', available: true, roles: ['default', 'coding'] }),
    ]));
    expect(JSON.stringify(listConfiguredModels(runtime!))).not.toContain('sk-code-test');
  });

  it('switches a role without replacing session history', async () => {
    const sessionId = runtime!.agent.sessionId;
    runtime!.store.appendMessage(sessionId, { role: 'user', content: 'history stays' });

    const result = switchModelRole(runtime!, 'cheap');

    expect(result).toMatchObject({ role: 'cheap', modelId: 'fast', saved: true });
    expect(runtime!.agent.sessionId).toBe(sessionId);
    expect(runtime!.store.getMessages(sessionId)).toEqual([{ role: 'user', content: 'history stays' }]);
    expect(runtime!.agent.modelRole).toBe('cheap');
  });

  it('persists role for session recovery', async () => {
    const sessionId = runtime!.agent.sessionId;
    const result = switchModelRole(runtime!, 'cheap', 'fast');
    expect(result.saved).toBe(true);

    const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    expect(written.models).toHaveLength(2);
    expect(written.modelRoles.cheap).toBe('fast');

    await runtime!.close();
    runtime = createRuntime({
      cwd: dir,
      loaded: loadConfig({
        cwd: dir, configPath, skipGlobal: true, skipCredentials: true,
        env: { DEEPSEEK_API_KEY: 'sk-test', FAST_API_KEY: 'sk-fast-test', CODE_API_KEY: 'sk-code-test' },
      }),
      sessionId,
    });
    expect(runtime!.agent.modelRole).toBe('cheap');
  });

  it('reports connectivity failures without returning model key text', async () => {
    const secret = 'sk-fast-test';
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ error: { message: `rejected ${authorization ?? secret}` } }), { status: 401 });
    });
    try {
      const result = await checkModelConnectivity(runtime!, 'fast');
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.detail).toContain('***');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('替换 Provider 与上下文预算，保留会话并写回配置文件', async () => {
    const beforeSession = runtime!.agent.sessionId;
    const result = switchModel(runtime!, 'deepseek-v4-pro');

    expect(result).toMatchObject({
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      saved: true,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      keyReady: true,
    });
    expect(runtime!.agent.modelName).toBe('deepseek-v4-pro');
    expect(runtime!.config.model.model).toBe('deepseek-v4-pro');
    expect(runtime!.config.model.contextWindow).toBe(1_000_000);
    expect(runtime!.config.model.maxOutputTokens).toBe(8192);
    // 切换模型不重建会话
    expect(runtime!.agent.sessionId).toBe(beforeSession);

    const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    expect(written.model.model).toBe('deepseek-v4-pro');
    expect(written.model.baseUrl).toBe('https://api.deepseek.com');
    // 其余字段保持不变
    expect(written.model.temperature).toBe(0.2);
    expect(written.security.mode).toBe('standard');
  });

  it('旧式模型切换保留完整配置目录并继续使用角色路由', async () => {
    const current = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    current.advisor = { enabled: true, modelId: 'code' };
    current.memory = { enabled: true, autoRecall: false, autoSave: false };
    current.futureFeature = { preserved: true };
    await writeFile(configPath, JSON.stringify(current), 'utf8');

    switchModel(runtime!, 'deepseek-v4-pro');

    const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    expect(written.advisor).toEqual({ enabled: true, modelId: 'code' });
    expect(written.memory).toEqual({ enabled: true, autoRecall: false, autoSave: false });
    expect(written.futureFeature).toEqual({ preserved: true });
    expect(written.models).toContainEqual(expect.objectContaining({ id: 'legacy-default', capabilities: ['chat'] }));
    expect(written.modelRoles.default).toBe('legacy-default');

    const withoutCredentials = loadConfig({ cwd: dir, configPath, skipGlobal: true, skipCredentials: true, env: {} });
    expect(withoutCredentials.config.models.find((model) => model.id === 'legacy-default')?.available).toBe(true);

    expect(switchModelRole(runtime!, 'coding', 'code').modelId).toBe('code');
    expect(runtime!.agent.modelRole).toBe('coding');
  });

  it('未知模型名只替换名称，沿用当前 baseUrl', () => {
    const result = switchModel(runtime!, 'my-local-model');

    expect(result.model).toBe('my-local-model');
    expect(result.baseUrl).toBe('https://api.deepseek.com');
    expect(runtime!.agent.modelName).toBe('my-local-model');
  });

  it('跨提供方切换时清掉旧 Key，提示重新填写', () => {
    const savedEnv = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      // 模拟"上一个提供方用的是别的 Key 变量"
      runtime!.config.model.apiKeyEnv = 'OPENAI_API_KEY';
      const result = switchModel(runtime!, 'deepseek-v4-pro');

      expect(result.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
      expect(result.keyReady).toBe(false);
      expect(runtime!.config.model.apiKey).toBeUndefined();
    } finally {
      if (savedEnv !== undefined) process.env.DEEPSEEK_API_KEY = savedEnv;
    }
  });
});
