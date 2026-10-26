/**
 * forgex config：打印最终生效配置（API Key 已脱敏）。
 *
 * 用于排查"配置到底从哪来、有没有生效"这类部署问题。
 */
import { stdout } from 'node:process';
import { flagString, type ParsedArgs } from '../args.js';
import { loadConfig } from '../config/load-config.js';

export function configCommand(args: ParsedArgs, options: { cwd: string }): number {
  const loaded = loadConfig({
    cwd: options.cwd,
    ...(flagString(args.flags, 'config') ? { configPath: flagString(args.flags, 'config')! } : {}),
    ...(flagString(args.flags, 'mode') ? { permissionMode: flagString(args.flags, 'mode')! } : {}),
  });
  const { apiKey, ...safeModel } = loaded.config.model;

  stdout.write(
    `${JSON.stringify(
      {
        configPath: loaded.configPath,
        sources: loaded.sources,
        modelConfigured: loaded.modelConfigured,
        model: { ...safeModel, ...(apiKey ? { apiKey: '***已配置***' } : {}) },
        security: loaded.config.security,
        session: loaded.config.session,
        agent: loaded.config.agent,
      },
      null,
      2,
    )}\n`,
  );

  if (!loaded.modelConfigured) {
    stdout.write('\n[warn] 尚未配置模型：请设置 forgex.config.json 或 FORGEX_BASE_URL / FORGEX_MODEL。\n');
  }
  return 0;
}
