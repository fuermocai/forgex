/**
 * forgex connect — 交互式模型连接向导。
 *
 * 设计：
 *   · TTY 交互：逐步询问 provider / apiKey / model，带预设 baseUrl；
 *   · 非 TTY 管道模式：接受 --provider / --api-key / --base-url / --model；
 *   · 连通性测试：发最小 chat 请求 (max_tokens=1)，5s 超时，不记录审计；
 *   · 配置持久化：配置文件只写 apiKeyEnv 引用，**API Key 从不明文落盘**；
 *   · Key 持久化：Windows → [Environment]::SetEnvironmentVariable('User')；
 *                 其他平台 → 提示用户手动 export。
 *
 * 具体实现见 runtime/connect-core.ts（TUI `/connect` 复用同一套逻辑）。
 */
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { stderr, stdin, stdout } from 'node:process';
import { flagString, type ParsedArgs } from '../args.js';
import {
  PROVIDERS,
  PROVIDERS_KEYS,
  defaultConfigPath,
  maskKey,
  persistApiKey,
  readExistingConfig,
  resolveProvider,
  saveConnectionConfig,
  testConnectivity,
  type ExistingConfig,
} from '../runtime/connect-core.js';

export async function connectCommand(args: ParsedArgs, _options: { cwd: string }): Promise<number> {
  const isInteractive = Boolean(stdin.isTTY);
  const configPath = defaultConfigPath();
  const existing = readExistingConfig(configPath);

  // 非交互模式：从 flag 读
  if (!isInteractive) {
    const provider = flagString(args.flags, 'provider') ?? 'custom';
    const apiKey = flagString(args.flags, 'api-key') ?? '';
    const preset = PROVIDERS[provider.toLowerCase()];
    const baseUrl = flagString(args.flags, 'base-url') ?? preset?.defaultBaseUrl ?? '';
    const model = flagString(args.flags, 'model') ?? preset?.defaultModel ?? '';
    if (!apiKey) {
      stderr.write('[connect] --api-key 在非交互模式下必填\n');
      return 2;
    }
    return await doConnect({ provider, apiKey, baseUrl, model, configPath, existing });
  }

  // ---------- 交互式向导 ----------
  stdout.write('ForgeX Connect — 连接你的模型提供方\n\n');

  const rl = createInterface({ input: stdin, output: stderr });

  try {
    // 1. 选 provider
    stdout.write('选择模型提供方（输入编号或名称）：\n');
    PROVIDERS_KEYS.forEach((key, i) => {
      const p = PROVIDERS[key]!;
      stdout.write(`  ${i + 1}. ${p.name} (${p.defaultBaseUrl})\n`);
    });
    stdout.write('\n> ');
    const providerInput = (await rl.question('')).trim();
    const provider = resolveProvider(providerInput);
    const preset = PROVIDERS[provider];

    // 2. baseUrl
    const baseUrlDefault = preset?.defaultBaseUrl ?? existing.model.baseUrl;
    stdout.write(`baseUrl [${baseUrlDefault}]: `);
    const baseUrl = (await rl.question('')).trim() || baseUrlDefault;

    // 3. API Key（不回显——readline.question 本身无法隐藏，这里只提示用户避免粘贴到日志）
    stdout.write('\nAPI Key（输入不会被隐藏，粘贴后按回车）: ');
    const apiKey = (await rl.question('')).trim();
    if (!apiKey) {
      stderr.write('[connect] API Key 不能为空\n');
      return 2;
    }

    // 4. model
    const modelDefault = preset?.defaultModel ?? existing.model.model;
    stdout.write(`\n模型名 [${modelDefault}]: `);
    const model = (await rl.question('')).trim() || modelDefault;

    // 5. 保存位置
    const saveDefault = configPath;
    stdout.write(`\n保存配置到 [${saveDefault}]：`);
    const saveInput = (await rl.question('')).trim();
    const finalConfigPath = saveInput ? resolve(saveInput) : saveDefault;

    stdout.write('\n--------------------------------------------\n');
    stdout.write(`Provider   : ${provider}\n`);
    stdout.write(`Base URL   : ${baseUrl}\n`);
    stdout.write(`Model      : ${model}\n`);
    stdout.write(`API Key    : ${maskKey(apiKey)}\n`);
    stdout.write(`Config     : ${finalConfigPath}\n`);
    stdout.write('--------------------------------------------\n');
    stdout.write('连通性测试中（5s 超时）...\n');

    return await doConnect({ provider, apiKey, baseUrl, model, configPath: finalConfigPath, existing });
  } finally {
    rl.close();
  }
}

/* ========================================================================== */
/* 核心流程                                                                    */
/* ========================================================================== */

interface ConnectParams {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  configPath: string;
  existing: ExistingConfig;
}

async function doConnect(params: ConnectParams): Promise<number> {
  const { provider, apiKey, baseUrl, model, configPath, existing } = params;

  // 1. 连通性测试
  const testResult = await testConnectivity({ baseUrl, apiKey, model });
  if (!testResult.ok) {
    stderr.write(`\n[FAIL] 连通性测试失败：${testResult.reason}\n`);
    if (testResult.detail) stderr.write(`       ${testResult.detail}\n`);
    stderr.write('\n提示：\n');
    stderr.write('  · 确认 API Key 有效：去 provider 控制台新建一个\n');
    stderr.write('  · 确认 baseUrl 正确（DeepSeek: https://api.deepseek.com）\n');
    stderr.write('  · 确认模型名（DeepSeek: deepseek-flash / deepseek-v4-pro）\n');
    return 1;
  }

  // 2. 持久化 API Key 到用户级环境变量
  const preset = PROVIDERS[provider];
  const envName = preset?.apiKeyEnv ?? provider.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_API_KEY';
  const envPersisted = persistApiKey(envName, apiKey);
  // 同时写入当前进程，让用户立刻能用（不用重开终端）
  process.env[envName] = apiKey;

  // 3. 写入配置文件（**不写明文 Key**，只写 apiKeyEnv 引用）
  saveConnectionConfig(configPath, existing, {
    baseUrl,
    model,
    envName,
    ...(preset ? { contextWindow: preset.contextWindow, maxOutputTokens: preset.maxOutputTokens } : {}),
  });

  // 4. 输出结果
  stdout.write(`\n[OK] 连通性测试通过 ✅\n`);
  stdout.write(`      响应耗时: ${testResult.latencyMs}ms\n`);
  stdout.write(`\n配置已写入：${configPath}\n`);
  stdout.write(`API Key 持久化：`);
  if (envPersisted.ok) {
    stdout.write(`✅ ${envName}（用户级环境变量）\n`);
    stdout.write(`               当前会话已生效 ✅\n`);
  } else {
    stdout.write(`⚠️  需手动设置：\n`);
    stdout.write(`               ${envPersisted.hint}\n`);
  }
  stdout.write(`\n现在可以跑：\n`);
  stdout.write(`  forgex run "你好，介绍一下 ForgeX"\n`);
  stdout.write(`  forgex doctor\n`);
  return 0;
}
