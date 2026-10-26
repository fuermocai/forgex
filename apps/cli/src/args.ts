/**
 * CLI 参数解析。
 *
 * 不引入 commander/yargs 的原因：
 *  - 第一版只有少量子命令，自实现约 60 行即可；
 *  - 减少依赖面，便于离线部署与供应链审计；
 *  - 参数形态明确：`--key=value`、`--key value`（仅限已知取值参数）、布尔开关。
 */

/** 需要取值的参数名（其余 `--xxx` 视为布尔开关） */
const VALUE_FLAGS = new Set([
  'config',
  'session',
  'limit',
  'mode',
  'workspace',
  'model',
  'base-url',
  'api-key',
  'provider',
  'env-name',
  'db',
  'prompt',
]);

/** 布尔开关（无需取值） */
const BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'version',
  'v',
  'plain',
  'json',
  'yes',
  'full',
  'connect',
  // `--plan`：一次性任务也走计划模式（只读分析 + 只输出计划），供 CI / 管道做 dry-run
  'plan',
]);

/** 全部已知参数，用于拼写错误校验（避免 `--doctor` 被静默当成 chat） */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

export interface ParsedArgs {
  /** 子命令；无子命令时为 'chat' */
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** 返回无法识别的参数名（不含前缀），由入口统一报错 */
export function unknownFlags(flags: ParsedArgs['flags']): string[] {
  return Object.keys(flags).filter((name) => !KNOWN_FLAGS.has(name));
}

/** 返回需要取值但只给了开关的参数名（如 `forgex sessions --limit`） */
export function flagsMissingValue(flags: ParsedArgs['flags']): string[] {
  return Object.keys(flags).filter((name) => VALUE_FLAGS.has(name) && flags[name] === true);
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = '';

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next;
          i += 1;
          continue;
        }
      }
      flags[body] = true;
      continue;
    }
    if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      // 短参数（-h / -v）统一转成布尔 flag
      flags[token.slice(1)] = true;
      continue;
    }
    if (!command) {
      command = token;
      continue;
    }
    positionals.push(token);
  }

  return { command: command || 'chat', positionals, flags };
}

/** 读取字符串 flag（布尔 true 视为未提供） */
export function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** 读取布尔 flag */
export function flagBool(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true || flags[name] === 'true' || flags[name] === '1';
}

/** 读取数字 flag，非法值返回 undefined */
export function flagNumber(flags: ParsedArgs['flags'], name: string): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
