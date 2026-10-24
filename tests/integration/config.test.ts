/**
 * CLI 集成测试：参数解析与配置加载。
 *
 * 这些行为决定"部署时配置是否真的生效"，属于上线前必须验证的路径，
 * 因此不 mock 文件系统，直接使用临时目录与真实 JSON 文件。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ForgeError } from '@forgex/shared';
import { flagBool, flagNumber, flagString, parseArgs } from '../../apps/cli/src/args.js';
import { loadConfig } from '../../apps/cli/src/config/load-config.js';

const tracked: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forgex-cli-'));
  tracked.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tracked.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('参数解析', () => {
  it('识别子命令、位置参数与取值 flag', () => {
    const args = parseArgs(['run', '检查端口', '--config', 'a.json', '--json', '--session=s_1']);
    expect(args.command).toBe('run');
    expect(args.positionals).toEqual(['检查端口']);
    expect(flagString(args.flags, 'config')).toBe('a.json');
    expect(flagString(args.flags, 'session')).toBe('s_1');
    expect(flagBool(args.flags, 'json')).toBe(true);
  });

  it('无子命令时默认 chat，并支持数字 flag', () => {
    const args = parseArgs(['--limit', '5', '--plain']);
    expect(args.command).toBe('chat');
    expect(flagNumber(args.flags, 'limit')).toBe(5);
    expect(flagBool(args.flags, 'plain')).toBe(true);
  });
});

describe('配置加载', () => {
  it('无配置文件时使用默认值并标记模型未配置', async () => {
    const cwd = await tempDir();
    const loaded = loadConfig({ cwd, env: {}, skipGlobal: true });
    expect(loaded.modelConfigured).toBe(false);
    expect(loaded.configPath).toBeNull();
    expect(loaded.config.security.workspaceRoots).toEqual([resolve(cwd)]);
    expect(loaded.config.session.dbPath).toBe(resolve(cwd, '.forgex', 'sessions.db'));
  });

  it('配置文件与环境变量合并，环境变量优先', async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, 'forgex.config.json'),
      JSON.stringify({
        model: { baseUrl: 'http://file.local/v1', model: 'file-model', contextWindow: 8192 },
        security: { mode: 'readonly', workspaceRoots: ['./repo'] },
      }),
      'utf8',
    );

    const loaded = loadConfig({
      cwd,
      env: {
        FORGEX_BASE_URL: 'http://env.local/v1/',
        FORGEX_MODEL: 'env-model',
        FORGEX_API_KEY: 'env-key',
        FORGEX_PERMISSION_MODE: 'standard',
      },
    });

    expect(loaded.modelConfigured).toBe(true);
    expect(loaded.config.model.baseUrl).toBe('http://env.local/v1');
    expect(loaded.config.model.model).toBe('env-model');
    expect(loaded.config.model.apiKey).toBe('env-key');
    expect(loaded.config.model.contextWindow).toBe(8192);
    expect(loaded.config.security.mode).toBe('standard');
    expect(loaded.config.security.workspaceRoots).toEqual([resolve(cwd, 'repo')]);
  });

  it('apiKeyEnv 从环境变量读取 Key，而不是写进配置文件', async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, 'forgex.config.json'),
      JSON.stringify({
        model: { baseUrl: 'http://internal/v1', model: 'qwen', apiKeyEnv: 'INTERNAL_KEY' },
      }),
      'utf8',
    );

    const loaded = loadConfig({ cwd, env: { INTERNAL_KEY: 'from-env' } });
    expect(loaded.config.model.apiKey).toBe('from-env');
  });

  it('非法配置抛出 CONFIG_INVALID 并带字段信息', async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, 'forgex.config.json'),
      JSON.stringify({ security: { mode: 'superuser' } }),
      'utf8',
    );

    try {
      loadConfig({ cwd, env: {} });
      expect.unreachable('应当抛出配置错误');
    } catch (err) {
      expect(err).toBeInstanceOf(ForgeError);
      expect((err as ForgeError).code).toBe('CONFIG_INVALID');
      expect((err as ForgeError).message).toContain('security.mode');
    }
  });

  it('配置文件不是合法 JSON 时立即失败', async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, 'forgex.config.json'), '{ broken', 'utf8');
    expect(() => loadConfig({ cwd, env: {} })).toThrow(/JSON/);
  });
});
