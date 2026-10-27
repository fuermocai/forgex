/**
 * 配置加载测试。
 *
 * 使用 `skipGlobal` + 显式 `env` 隔离，避免读到开发机上的 ~/.forgex/config.json。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLogger } from '@forgex/shared';
import { candidateConfigPaths, loadConfig } from '../src/config/load-config.js';

const silent = createLogger({ level: 'silent' });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgex-cli-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('无配置文件时使用默认值，且标记模型未配置', () => {
    const loaded = loadConfig({ cwd: dir, env: {}, skipGlobal: true, skipCredentials: true, logger: silent });

    expect(loaded.configPath).toBeNull();
    expect(loaded.modelConfigured).toBe(false);
    expect(loaded.config.model.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(loaded.config.model.model).toBe('local-model');
    expect(loaded.config.security.mode).toBe('standard');
    expect(loaded.config.security.workspaceRoots).toEqual([resolve(dir)]);
    expect(loaded.config.session.dbPath).toBe(resolve(dir, '.forgex', 'sessions.db'));
    expect(loaded.config.security.auditLogPath).toBe(resolve(dir, '.forgex', 'audit.jsonl'));
  });

  it('读取项目配置文件并通过 apiKeyEnv 解析 API Key', async () => {
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({
        model: {
          baseUrl: 'https://api.deepseek.com/',
          model: 'deepseek-flash',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          contextWindow: 1_000_000,
          maxOutputTokens: 8192,
        },
        security: { mode: 'readonly' },
      }),
      'utf8',
    );

    const loaded = loadConfig({
      cwd: dir,
      env: { DEEPSEEK_API_KEY: 'sk-test-key' },
      skipGlobal: true, skipCredentials: true,
      logger: silent,
    });

    expect(loaded.configPath).toBe(join(dir, 'forgex.config.json'));
    expect(loaded.modelConfigured).toBe(true);
    expect(loaded.config.model.baseUrl).toBe('https://api.deepseek.com');
    expect(loaded.config.model.apiKey).toBe('sk-test-key');
    expect(loaded.config.model.contextWindow).toBe(1_000_000);
    expect(loaded.config.security.mode).toBe('readonly');
  });

  it('环境变量覆盖配置文件', async () => {
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({ model: { baseUrl: 'https://a.example', model: 'a' }, security: { mode: 'standard' } }),
      'utf8',
    );

    const loaded = loadConfig({
      cwd: dir,
      env: { FORGEX_BASE_URL: 'https://b.example', FORGEX_MODEL: 'b', FORGEX_PERMISSION_MODE: 'trusted' },
      skipGlobal: true, skipCredentials: true,
      logger: silent,
    });

    expect(loaded.config.model.baseUrl).toBe('https://b.example');
    expect(loaded.config.model.model).toBe('b');
    expect(loaded.config.security.mode).toBe('trusted');
    expect(loaded.sources).toContain('环境变量');
  });

  it('命令行 --mode 覆盖配置文件与环境变量', async () => {
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({ model: { baseUrl: 'https://a.example', model: 'a' }, security: { mode: 'readonly' } }),
      'utf8',
    );

    const loaded = loadConfig({
      cwd: dir,
      permissionMode: 'trusted',
      env: { FORGEX_PERMISSION_MODE: 'standard' },
      skipGlobal: true, skipCredentials: true,
      logger: silent,
    });

    expect(loaded.config.security.mode).toBe('trusted');
    expect(loaded.sources).toContain('命令行参数（--mode）');
  });

  it('命令行 --mode 支持别名与大小写', () => {
    const loaded = loadConfig({
      cwd: dir,
      permissionMode: 'Read-Only',
      env: {},
      skipGlobal: true, skipCredentials: true,
      logger: silent,
    });
    expect(loaded.config.security.mode).toBe('readonly');
  });

  it('命令行 --mode 非法时报 CONFIG_INVALID 并回显可选值', () => {
    expect(() =>
      loadConfig({ cwd: dir, permissionMode: 'root', env: {}, skipGlobal: true, skipCredentials: true, logger: silent }),
    ).toThrowError(/--mode 取值非法: root.*readonly \/ standard \/ trusted \/ yolo/);
  });

  it('支持 FORGEX_API_KEY 直接提供 Key', () => {    const loaded = loadConfig({
      cwd: dir,
      env: { FORGEX_BASE_URL: 'https://x.example', FORGEX_MODEL: 'x', FORGEX_API_KEY: 'sk-direct' },
      skipGlobal: true, skipCredentials: true,
      logger: silent,
    });
    expect(loaded.config.model.apiKey).toBe('sk-direct');
    expect(loaded.modelConfigured).toBe(true);
  });

  it('只设置 DEEPSEEK_API_KEY 时自动识别 DeepSeek 预设', () => {
    const loaded = loadConfig({
      cwd: dir,
      env: { DEEPSEEK_API_KEY: 'sk-deepseek' },
      skipGlobal: true, skipCredentials: true,
      logger: silent,
    });

    expect(loaded.modelConfigured).toBe(true);
    expect(loaded.config.model.baseUrl).toBe('https://api.deepseek.com');
    expect(loaded.config.model.model).toBe('deepseek-flash');
    expect(loaded.config.model.apiKey).toBe('sk-deepseek');
    expect(loaded.config.model.contextWindow).toBe(1_000_000);
    expect(loaded.sources).toContain('环境变量（自动识别 Provider）');
  });

  it('自动识别不会覆盖显式环境变量配置', () => {
    const loaded = loadConfig({
      cwd: dir,
      env: { OPENAI_API_KEY: 'sk-openai', FORGEX_MODEL: 'my-model', FORGEX_BASE_URL: 'https://custom.example' },
      skipGlobal: true, skipCredentials: true,
      logger: silent,
    });

    expect(loaded.config.model.baseUrl).toBe('https://custom.example');
    expect(loaded.config.model.model).toBe('my-model');
    expect(loaded.config.model.apiKey).toBeUndefined();
    expect(loaded.sources).not.toContain('环境变量（自动识别 Provider）');
  });

  it('配置文件已指定模型时不做环境变量推断', async () => {
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({ model: { baseUrl: 'https://a.example', model: 'a', apiKeyEnv: 'DEEPSEEK_API_KEY' } }),
      'utf8',
    );

    const loaded = loadConfig({
      cwd: dir,
      env: { OPENAI_API_KEY: 'sk-openai', DEEPSEEK_API_KEY: 'sk-deepseek' },
      skipGlobal: true, skipCredentials: true,
      logger: silent,
    });

    expect(loaded.config.model.baseUrl).toBe('https://a.example');
    expect(loaded.config.model.model).toBe('a');
    expect(loaded.sources).not.toContain('环境变量（自动识别 Provider）');
  });

  it('API Key 环境变量为空字符串时不算已配置', () => {
    const loaded = loadConfig({
      cwd: dir,
      env: { DEEPSEEK_API_KEY: '   ' },
      skipGlobal: true, skipCredentials: true,
      logger: silent,
    });
    expect(loaded.modelConfigured).toBe(false);
  });

  it('展开 ~ 路径', async () => {
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({ session: { dbPath: '~/.forgex/test-sessions.db' } }),
      'utf8',
    );
    const loaded = loadConfig({ cwd: dir, env: {}, skipGlobal: true, skipCredentials: true, logger: silent });
    expect(loaded.config.session.dbPath).toBe(join(homedir(), '.forgex', 'test-sessions.db'));
  });

  it('显式配置文件不存在时报 CONFIG_INVALID', () => {
    expect(() =>
      loadConfig({ cwd: dir, configPath: join(dir, 'missing.json'), env: {}, logger: silent }),
    ).toThrowError(/配置文件不存在/);
  });

  it('配置文件 JSON 非法时报 CONFIG_INVALID', async () => {
    await writeFile(join(dir, 'forgex.config.json'), '{ not json', 'utf8');
    expect(() => loadConfig({ cwd: dir, env: {}, skipGlobal: true, skipCredentials: true, logger: silent })).toThrowError(
      /不是合法 JSON/,
    );
  });
});

describe('凭据文件兜底', () => {
  it('环境变量缺失时从 credentials.json 注入 API Key', async () => {
    const credentialsPath = join(dir, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ keys: { DEEPSEEK_API_KEY: 'sk-from-file' } }), 'utf8');
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({
        model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      }),
      'utf8',
    );

    const loaded = loadConfig({
      cwd: dir,
      env: {},
      skipGlobal: true,
      credentialsPath,
      logger: silent,
    });

    expect(loaded.config.model.apiKey).toBe('sk-from-file');
    expect(loaded.sources.some((source) => source.startsWith('凭据文件'))).toBe(true);
    // doctor / config 靠这个字段回答"重启后 Key 从哪读的"
    expect(loaded.apiKeySource).toBe('credentials');
    expect(loaded.credentialsPath).toBe(credentialsPath);
  });

  it('真实环境变量优先于凭据文件', async () => {
    const credentialsPath = join(dir, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ keys: { DEEPSEEK_API_KEY: 'sk-from-file' } }), 'utf8');
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({
        model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      }),
      'utf8',
    );

    const loaded = loadConfig({
      cwd: dir,
      env: { DEEPSEEK_API_KEY: 'sk-from-env' },
      skipGlobal: true,
      credentialsPath,
      logger: silent,
    });

    expect(loaded.config.model.apiKey).toBe('sk-from-env');
    expect(loaded.sources.some((source) => source.startsWith('凭据文件'))).toBe(false);
    expect(loaded.apiKeySource).toBe('env');
  });

  it('Key 只写在配置文件里时来源标记为 file（应提示改用 /key）', async () => {
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({
        model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-in-config' },
      }),
      'utf8',
    );

    const loaded = loadConfig({ cwd: dir, env: {}, skipGlobal: true, skipCredentials: true, logger: silent });

    expect(loaded.config.model.apiKey).toBe('sk-in-config');
    expect(loaded.apiKeySource).toBe('file');
  });

  it('没有任何 Key 时来源为 null', () => {
    const loaded = loadConfig({ cwd: dir, env: {}, skipGlobal: true, skipCredentials: true, logger: silent });

    expect(loaded.config.model.apiKey).toBeUndefined();
    expect(loaded.apiKeySource).toBeNull();
  });

  it('apiKeyEnv 指向的变量缺失时退回 FORGEX_API_KEY（否则表现为"Key 又没了"）', async () => {
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({
        model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      }),
      'utf8',
    );

    const loaded = loadConfig({
      cwd: dir,
      env: { FORGEX_API_KEY: 'sk-from-forgex-env' },
      skipGlobal: true,
      skipCredentials: true,
      logger: silent,
    });

    expect(loaded.config.model.apiKey).toBe('sk-from-forgex-env');
    // 配置里声明的变量名保持不变，运行时换 Key 时仍会写到这个位置
    expect(loaded.config.model.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
  });

  it('凭据文件损坏时忽略而不阻断启动', async () => {
    const credentialsPath = join(dir, 'credentials.json');
    await writeFile(credentialsPath, '{ not json', 'utf8');

    const loaded = loadConfig({
      cwd: dir,
      env: {},
      skipGlobal: true,
      credentialsPath,
      logger: silent,
    });

    expect(loaded.config.model.apiKey).toBeUndefined();
    expect(loaded.sources.some((source) => source.startsWith('凭据文件'))).toBe(false);
  });
});

describe('candidateConfigPaths', () => {
  it('按 FORGEX_CONFIG、项目目录、全局目录排序', () => {
    const paths = candidateConfigPaths(dir, { FORGEX_CONFIG: join(dir, 'custom.json') });
    expect(paths[0]).toBe(join(dir, 'custom.json'));
    expect(paths[1]).toBe(join(dir, 'forgex.config.json'));
    expect(paths[2]).toBe(join(homedir(), '.forgex', 'config.json'));
  });

  it('skipGlobal 时不含全局配置', () => {
    const paths = candidateConfigPaths(dir, {}, { skipGlobal: true });
    expect(paths).toEqual([join(dir, 'forgex.config.json')]);
  });
});
