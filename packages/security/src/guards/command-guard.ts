/**
 * CommandGuard：命令结构防线。
 *
 * 前提：ForgeX 从不使用 `shell: true`，`run_command` 只接受
 * `{ program, args[], cwd, env }`，不存在"命令字符串"这种输入形态。
 * 因此本模块的目标不是过滤 shell 字符串，而是：
 *  1. 拒绝把命令塞进解释器（`bash -c`、`python -c`、`node -e`）；
 *  2. 拒绝空程序名、控制字符、换行注入；
 *  3. 拒绝交互式 shell 与已知的"命令包装器"；
 *  4. 把程序/参数交给 PolicyEngine 做黑白名单与模式判定。
 *
 * 注意：允许执行某个程序 ≠ 安全沙箱。任何构建/测试脚本仍可能执行任意代码，
 * 企业环境必须只在隔离机器上开启 EXECUTE 权限。
 */
import type { PolicySettings } from '@forgex/shared';
import { programBasename } from '../policy/defaults.js';
import { PolicyEngine, type PolicyEvaluation } from '../policy/policy-engine.js';

export interface CommandSpec {
  /** 可执行文件名或绝对路径 */
  program: string;
  /** 参数数组（不做 shell 展开） */
  args: string[];
  /** 工作目录，由调用方经 WorkspaceGuard 解析后传入 */
  cwd?: string;
  /** 显式环境变量白名单（不会继承完整父进程环境） */
  env?: Record<string, string>;
}

/** 交互式 shell：第一版直接拒绝，避免绕过参数分析 */
const SHELL_PROGRAMS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'cmd',
  'powershell',
  'pwsh',
  'cscript',
  'wscript',
]);

/** 解释器的"内联代码"开关 */
const INTERPRETER_PROGRAMS = new Set([
  'python',
  'python2',
  'python3',
  'py',
  'node',
  'nodejs',
  'deno',
  'bun',
  'perl',
  'ruby',
  'php',
  'lua',
]);

const INLINE_EXEC_FLAGS = new Set(['-c', '-e', '--eval', '-p', '--print']);

/** 命令包装器：它们会二次解析参数，容易绕过黑名单 */
const WRAPPER_PROGRAMS = new Set(['env', 'xargs', 'eval', 'exec', 'nice', 'nohup', 'timeout', 'start', 'call']);

/** 程序名中不允许出现的字符（含 shell 元字符与控制字符） */
const ILLEGAL_PROGRAM_CHARS = /[;&|`$<>(){}\[\]\n\r\0]/;

export class CommandGuard {
  private readonly policy = new PolicyEngine();

  /**
   * 对一次命令执行做完整判定。
   * deny 时调用方不得 spawn；ask 时进入审批流程。
   */
  check(spec: CommandSpec, settings: PolicySettings): PolicyEvaluation {
    const structural = this.validateStructure(spec);
    if (structural) return structural;

    return this.policy.evaluate({
      tool: 'run_command',
      riskLevel: 'execute',
      facts: { program: spec.program, args: spec.args, ...(spec.cwd ? { paths: [spec.cwd] } : {}) },
      settings,
    });
  }

  /** 纯结构校验，不依赖策略配置；供工具内部做纵深防御 */
  validateStructure(spec: CommandSpec): PolicyEvaluation | null {
    if (typeof spec.program !== 'string' || spec.program.trim().length === 0) {
      return { decision: 'deny', reason: '程序名为空', rule: 'empty_program' };
    }
    if (ILLEGAL_PROGRAM_CHARS.test(spec.program)) {
      return {
        decision: 'deny',
        reason: `程序名包含非法字符，疑似命令注入: ${spec.program}`,
        rule: 'illegal_program_chars',
      };
    }
    if (!Array.isArray(spec.args)) {
      return { decision: 'deny', reason: 'args 必须是字符串数组', rule: 'invalid_args' };
    }
    for (const arg of spec.args) {
      if (typeof arg !== 'string') {
        return { decision: 'deny', reason: 'args 中存在非字符串参数', rule: 'invalid_args' };
      }
      if (/[\u0000\r\n]/.test(arg)) {
        return {
          decision: 'deny',
          reason: '参数包含控制字符或换行，拒绝执行',
          rule: 'control_chars_in_args',
        };
      }
    }

    const base = programBasename(spec.program);

    if (SHELL_PROGRAMS.has(base)) {
      return {
        decision: 'deny',
        reason: `禁止执行交互式 shell（${base}）；请使用明确的程序与参数`,
        rule: 'shell_interpreter',
      };
    }

    if (WRAPPER_PROGRAMS.has(base)) {
      return {
        decision: 'deny',
        reason: `禁止通过命令包装器（${base}）间接执行命令`,
        rule: 'command_wrapper',
      };
    }

    if (INTERPRETER_PROGRAMS.has(base)) {
      const hit = spec.args.find((arg) => INLINE_EXEC_FLAGS.has(flagKey(arg)));
      if (hit) {
        return {
          decision: 'deny',
          reason: `禁止解释器内联代码执行（${base} ${hit}）；请把脚本写入工作区后按文件执行`,
          rule: 'inline_code_execution',
        };
      }
    }

    // find -exec / -execdir 会派生新进程，等价于间接执行任意命令
    if (base === 'find' && spec.args.some((arg) => arg === '-exec' || arg === '-execdir' || arg === '-ok')) {
      return {
        decision: 'deny',
        reason: '禁止 find -exec 派生命令',
        rule: 'find_exec',
      };
    }

    const destructive = checkDestructiveCommand(base, spec.args);
    if (destructive) return destructive;

    return null;
  }
}

/** 统一 flag 大小写与 `--flag=value` 形式 */
function flagKey(arg: string): string {
  const plain = arg.split('=')[0] ?? arg;
  return plain.toLowerCase();
}

/**
 * 把 `-Rf` 这类组合短参数拆成 `-r`、`-f`。
 * 只用于删除类命令，避免对 `find -delete` 这类单词参数误拆。
 */
function splitShortFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    const key = flagKey(arg);
    if (key.startsWith('-') && !key.startsWith('--') && key.length > 2 && !/^-\d/.test(key)) {
      for (const ch of key.slice(1)) out.push(`-${ch}`);
    } else {
      out.push(key);
    }
  }
  return out;
}

/**
 * 破坏性命令的结构化判定。
 *
 * 仅靠 `deniedArgPatterns` 的 `-rf` 正则会漏掉 `-r -f`、`-Rf`、`--recursive --force`
 * 等等价写法，因此在结构层按程序语义再做一次判定。
 */
function checkDestructiveCommand(base: string, args: readonly string[]): PolicyEvaluation | null {
  if (base === 'rm') {
    const flags = splitShortFlags(args);
    const recursive = flags.includes('-r') || flags.includes('--recursive');
    const force = flags.includes('-f') || flags.includes('--force');
    if (recursive && force) {
      return {
        decision: 'deny',
        reason: '禁止递归强制删除（rm -r -f / -Rf / --recursive --force 等写法等价）',
        rule: 'destructive_recursive_delete',
      };
    }
  }

  if (base === 'rmdir' || base === 'rd' || base === 'del' || base === 'erase') {
    const flags = splitShortFlags(args);
    if (flags.includes('/s') || flags.includes('--recursive') || flags.includes('-r')) {
      return {
        decision: 'deny',
        reason: `禁止递归删除（${base} /s 会删除整个目录树）`,
        rule: 'destructive_recursive_delete',
      };
    }
  }

  if (base === 'find' && args.some((arg) => flagKey(arg) === '-delete')) {
    return {
      decision: 'deny',
      reason: '禁止 find -delete 批量删除文件',
      rule: 'destructive_find_delete',
    };
  }

  if (base === 'git' && (args[0] ?? '').toLowerCase() === 'clean') {
    const flags = splitShortFlags(args.slice(1));
    const force = flags.includes('-f') || flags.includes('--force');
    const broad = flags.includes('-d') || flags.includes('-x');
    if (force && broad) {
      return {
        decision: 'deny',
        reason: '禁止 git clean -fdx 批量删除未跟踪文件；请先确认范围并手动执行',
        rule: 'destructive_git_clean',
      };
    }
  }

  return null;
}
