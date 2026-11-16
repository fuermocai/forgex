/**
 * /connect 与 /models 共用的纯函数测试（不发网络请求）。
 */
import { describe, expect, it } from 'vitest';
import { createProvider } from '@forgex/models';
import {
  MODEL_PRESETS,
  PROVIDERS,
  PROVIDERS_KEYS,
  buildConfig,
  findModelPreset,
  maskKey,
  persistApiKey,
  readExistingConfig,
  resolveProvider,
  saveConnectionConfig,
  testConnectivity,
  writeCredential,
  writeModelSelection,
} from '../src/runtime/connect-core.js';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

describe('OpenAI-compatible provider catalog', () => {
  it('sends compatible requests to Groq and OpenRouter endpoints without labeling them native protocols', async () => {
    for (const providerKey of ['groq', 'openrouter'] as const) {
      const preset = PROVIDERS[providerKey];
      let requestUrl = '';
      let requestInit: RequestInit | undefined;
      const provider = createProvider({
        baseUrl: preset.defaultBaseUrl,
        apiKey: 'catalog-protocol-secret',
        model: preset.defaultModel,
        contextWindow: preset.contextWindow,
        maxOutputTokens: preset.maxOutputTokens,
        temperature: 0,
        timeoutMs: 1000,
        maxRetries: 0,
        stream: false,
        name: preset.name,
      }, {
        fetchImpl: async (input, init) => {
          requestUrl = String(input);
          requestInit = init;
          return new Response(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });

      await provider.chat({ messages: [{ role: 'user', content: 'ping' }] });

      expect(preset.protocol).toBe('openai-compatible');
      expect(requestUrl).toBe(`${preset.defaultBaseUrl}/chat/completions`);
      expect(requestInit?.headers).toMatchObject({ authorization: 'Bearer catalog-protocol-secret' });
      expect(JSON.parse(String(requestInit?.body))).toMatchObject({ model: preset.defaultModel, stream: false });
    }
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
      session: { dbPath: 'events.jsonl' },
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
    expect(next.session).toEqual({ dbPath: 'events.jsonl' });
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

  it('writeModelSelection 在配置文件不存在时创建它（含默认 security/session/agent）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-connect-'));
    try {
      const path = join(dir, 'nested', 'config.json');
      const ok = writeModelSelection(path, {
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        contextWindow: 1_000_000,
        maxOutputTokens: 8192,
      });
      expect(ok).toBe(true);

      const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
      expect(written.model.model).toBe('deepseek-flash');
      expect(written.model.contextWindow).toBe(1_000_000);
      // apiKeyEnv 跟随 baseUrl 反查预设：DeepSeek 端点就该是 DEEPSEEK_API_KEY，
      // 否则 /key 落盘位置和配置声明不一致，下次启动读不到
      expect(written.model.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
      expect(written.security.mode).toBe('standard');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writeModelSelection 优先使用调用方给的 apiKeyEnv（保证存哪读哪）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-connect-'));
    try {
      const path = join(dir, 'config.json');
      const ok = writeModelSelection(path, {
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        contextWindow: 1_000_000,
        maxOutputTokens: 8192,
        apiKeyEnv: 'FORGEX_API_KEY',
      });
      expect(ok).toBe(true);

      const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
      // 显式指定时不按 baseUrl 反查（否则 /key 存到 FORGEX_API_KEY、配置却指向
      // DEEPSEEK_API_KEY，重启后环境变量取不到，Key 就"消失"了）
      expect(written.model.apiKeyEnv).toBe('FORGEX_API_KEY');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('凭据文件（Linux/macOS 的 Key 持久化）', () => {
  it('writeCredential 追加多条并保持 600 权限', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-cred-'));
    try {
      const path = join(dir, '.forgex', 'credentials.json');
      expect(writeCredential('DEEPSEEK_API_KEY', 'sk-1', path)).toBe(true);
      expect(writeCredential('FORGEX_API_KEY', 'sk-2', path)).toBe(true);
      // 覆盖同名 Key 不应丢掉其他 Key
      expect(writeCredential('DEEPSEEK_API_KEY', 'sk-3', path)).toBe(true);

      const data = JSON.parse(await readFile(path, 'utf8')) as { keys: Record<string, string> };
      expect(data.keys).toEqual({ DEEPSEEK_API_KEY: 'sk-3', FORGEX_API_KEY: 'sk-2' });

      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('凭据文件是坏 JSON 时覆盖写入而不是抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-cred-'));
    try {
      const path = join(dir, 'credentials.json');
      await writeFile(path, '{ not json', 'utf8');
      expect(writeCredential('DEEPSEEK_API_KEY', 'sk-new', path)).toBe(true);
      const data = JSON.parse(await readFile(path, 'utf8')) as { keys: Record<string, string> };
      expect(data.keys.DEEPSEEK_API_KEY).toBe('sk-new');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persistApiKey 在所有平台都写同一份凭据文件（重开即生效）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-cred-'));
    try {
      const path = join(dir, '.forgex', 'credentials.json');
      const result = persistApiKey('DEEPSEEK_API_KEY', 'sk-persist', { path });

      expect(result.ok).toBe(true);
      expect(result.hint).toBe(path);
      const data = JSON.parse(await readFile(path, 'utf8')) as { keys: Record<string, string> };
      expect(data.keys.DEEPSEEK_API_KEY).toBe('sk-persist');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('支持无凭据的本地兼容端点诊断', async () => {
    await withServer((req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
    }, async (baseUrl) => {
      const result = await testConnectivity({ baseUrl, model: 'local-model' });
      expect(result).toMatchObject({ ok: true, reason: 'ok' });
    });
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

  it('redacts a key echoed by a connectivity failure', async () => {
    await withServer((req, res) => {
      const authorization = String(req.headers.authorization ?? '');
      res.writeHead(401, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: { message: `rejected ${authorization}` } }));
    }, async (baseUrl) => {
      const secret = 'sk-abcdefgh12345678';
      const result = await testConnectivity({ baseUrl, apiKey: secret, model: 'fake-model' });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.detail).toContain('***');
    });
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
      expect(written.session.dbPath).toBe(join('.forgex', 'events.jsonl'));
      expect(written.agent.maxIterations).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
