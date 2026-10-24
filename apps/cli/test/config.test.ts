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
    const loaded = loadConfig({ cwd: dir, env: {}, skipGlobal: true, logger: silent });

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
      skipGlobal: true,
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
      skipGlobal: true,
      logger: silent,
    });

    expect(loaded.config.model.baseUrl).toBe('https://b.example');
    expect(loaded.config.model.model).toBe('b');
    expect(loaded.config.security.mode).toBe('trusted');
    expect(loaded.sources).toContain('环境变量');
  });

  it('支持 FORGEX_API_KEY 直接提供 Key', () => {
    const loaded = loadConfig({
      cwd: dir,
      env: { FORGEX_BASE_URL: 'https://x.example', FORGEX_MODEL: 'x', FORGEX_API_KEY: 'sk-direct' },
      skipGlobal: true,
      logger: silent,
    });
    expect(loaded.config.model.apiKey).toBe('sk-direct');
    expect(loaded.modelConfigured).toBe(true);
  });

  it('展开 ~ 路径', async () => {
    await writeFile(
      join(dir, 'forgex.config.json'),
      JSON.stringify({ session: { dbPath: '~/.forgex/test-sessions.db' } }),
      'utf8',
    );
    const loaded = loadConfig({ cwd: dir, env: {}, skipGlobal: true, logger: silent });
    expect(loaded.config.session.dbPath).toBe(join(homedir(), '.forgex', 'test-sessions.db'));
  });

  it('显式配置文件不存在时报 CONFIG_INVALID', () => {
    expect(() =>
      loadConfig({ cwd: dir, configPath: join(dir, 'missing.json'), env: {}, logger: silent }),
    ).toThrowError(/配置文件不存在/);
  });

  it('配置文件 JSON 非法时报 CONFIG_INVALID', async () => {
    await writeFile(join(dir, 'forgex.config.json'), '{ not json', 'utf8');
    expect(() => loadConfig({ cwd: dir, env: {}, skipGlobal: true, logger: silent })).toThrowError(
      /不是合法 JSON/,
    );
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
