/**
 * /connect 与 /models 共用的纯函数测试（不发网络请求）。
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_PRESETS,
  PROVIDERS,
  PROVIDERS_KEYS,
  buildConfig,
  findModelPreset,
  maskKey,
  readExistingConfig,
  resolveProvider,
  saveConnectionConfig,
  testConnectivity,
  writeModelSelection,
} from '../src/runtime/connect-core.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolveProvider', () => {
  it('空输入默认 deepseek', () => {
    expect(resolveProvider('')).toBe('deepseek');
    expect(resolveProvider('   ')).toBe('deepseek');
  });

  it('支持名称与编号', () => {
    expect(resolveProvider('deepseek')).toBe('deepseek');
    expect(resolveProvider('DeepSeek')).toBe('deepseek');
    expect(resolveProvider('1')).toBe(PROVIDERS_KEYS[0]);
    expect(resolveProvider(String(PROVIDERS_KEYS.length))).toBe(PROVIDERS_KEYS.at(-1));
  });

  it('未知名称落到 custom', () => {
    expect(resolveProvider('some-gateway')).toBe('custom');
    expect(resolveProvider('99')).toBe('custom');
  });
});

describe('模型预设', () => {
  it('包含 deepseek-flash 且上下文为 1M', () => {
    const preset = findModelPreset('deepseek-flash');
    expect(preset).toBeDefined();
    expect(preset!.contextWindow).toBe(1_000_000);
    expect(preset!.baseUrl).toBe(PROVIDERS.deepseek!.defaultBaseUrl);
  });

  it('未知模型返回 undefined', () => {
    expect(findModelPreset('gpt-4o')).toBeUndefined();
    expect(MODEL_PRESETS.length).toBeGreaterThan(0);
  });
});

describe('maskKey', () => {
  it('短 Key 全部隐藏', () => {
    expect(maskKey('12345678')).toBe('****');
  });

  it('长 Key 只保留首尾 3 位', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-****def');
  });
});

describe('配置读写', () => {
  it('buildConfig 保留 security/session/agent，只更新 model', () => {
    const existing = {
      model: { baseUrl: 'http://old', model: 'old', contextWindow: 1024, maxOutputTokens: 256, stream: true },
      security: { mode: 'readonly' },
      session: { dbPath: 'x.db' },
      agent: { maxIterations: 5, maxConcurrency: 2 },
    };
    const next = buildConfig(existing, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      envName: 'DEEPSEEK_API_KEY',
      contextWindow: 1_000_000,
      maxOutputTokens: 8192,
    });
    expect(next.model).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      contextWindow: 1_000_000,
    });
    expect(next.security).toEqual({ mode: 'readonly' });
    expect(next.session).toEqual({ dbPath: 'x.db' });
  });

  it('readExistingConfig 对缺失文件返回默认值', () => {
    const cfg = readExistingConfig(join(tmpdir(), 'forgex-does-not-exist', 'config.json'));
    expect(cfg.model.model).toBe('local-model');
    expect(cfg.security.mode).toBe('standard');
  });

  it('writeModelSelection 只改 model 段并保留其他字段', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-connect-'));
    try {
      const path = join(dir, 'config.json');
      await writeFile(
        path,
        JSON.stringify({ model: { model: 'old', baseUrl: 'http://old', temperature: 0.7 }, security: { mode: 'trusted' } }),
        'utf8',
      );

      const ok = writeModelSelection(path, {
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        contextWindow: 1_000_000,
        maxOutputTokens: 8192,
      });
      expect(ok).toBe(true);

      const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
      expect(written.model.model).toBe('deepseek-flash');
      expect(written.model.temperature).toBe(0.7);
      expect(written.security.mode).toBe('trusted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writeModelSelection 在没有配置文件时返回 false', () => {
    expect(
      writeModelSelection(null, {
        model: 'm',
        baseUrl: 'http://x',
        contextWindow: 1024,
        maxOutputTokens: 256,
      }),
    ).toBe(false);
  });
});

describe('testConnectivity', () => {
  async function withServer(
    handler: Parameters<typeof createServer>[1],
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await run(`http://127.0.0.1:${port}/v1`);
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
  }

  it('成功响应返回 ok 与延迟', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
      },
      async (baseUrl) => {
        const result = await testConnectivity({ baseUrl, apiKey: 'sk-test', model: 'fake-model' });
        expect(result.ok).toBe(true);
        expect(result.reason).toBe('ok');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      },
    );
  });

  it('401 返回 HTTP 状态与错误详情', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      },
      async (baseUrl) => {
        const result = await testConnectivity({ baseUrl, apiKey: 'sk-bad', model: 'fake-model' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('HTTP 401');
        expect(result.detail).toBe('invalid api key');
      },
    );
  });

  it('非 JSON 响应返回可读错误', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
        res.end('not-json');
      },
      async (baseUrl) => {
        const result = await testConnectivity({ baseUrl, apiKey: 'sk-test', model: 'fake-model' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('响应无法解析');
        expect(result.detail).toContain('not-json');
      },
    );
  });
});

describe('saveConnectionConfig', () => {
  it('创建目录并写入新配置，保留安全/会话/Agent 段', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-save-connect-'));
    try {
      const path = join(dir, 'nested', 'config.json');
      const existing = readExistingConfig(path);
      saveConnectionConfig(path, existing, {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        envName: 'DEEPSEEK_API_KEY',
        contextWindow: 1_000_000,
        maxOutputTokens: 8192,
      });

      const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
      expect(written.model).toMatchObject({
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        contextWindow: 1_000_000,
        maxOutputTokens: 8192,
      });
      expect(written.security.mode).toBe('standard');
      expect(written.session.dbPath).toBe(join('.forgex', 'sessions.db'));
      expect(written.agent.maxIterations).toBe(12);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
