/**
 * /models 运行时切换测试：真实 Runtime + 临时配置 + SQLite。
 *
 * 不发起网络请求：只验证 Provider 替换、上下文预算、会话保留与配置落盘。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load-config.js';
import { createRuntime, type ForgeRuntime } from '../src/runtime/create-runtime.js';
import { switchModel } from '../src/runtime/model-switch.js';

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
        security: { mode: 'standard', workspaceRoots: ['.'] },
        session: { dbPath: '.forgex/sessions.db' },
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
    env: { DEEPSEEK_API_KEY: 'sk-test' },
  });
  runtime = createRuntime({ cwd: dir, loaded });
});

afterEach(async () => {
  runtime?.close();
  runtime = null;
  await rm(dir, { recursive: true, force: true });
});

describe('/models 切换模型', () => {
  it('替换 Provider 与上下文预算，保留会话并写回配置文件', async () => {
    const beforeSession = runtime!.agent.sessionId;
    const result = switchModel(runtime!, 'deepseek-v4-pro');

    expect(result).toMatchObject({
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      saved: true,
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

  it('未知模型名只替换名称，沿用当前 baseUrl', () => {
    const result = switchModel(runtime!, 'my-local-model');

    expect(result.model).toBe('my-local-model');
    expect(result.baseUrl).toBe('https://api.deepseek.com');
    expect(runtime!.agent.modelName).toBe('my-local-model');
  });
});
