/**
 * 子进程执行器（Node 侧）。
 *
 * 安全约束（与 Security 层配合）：
 *  - 默认 `shell: false`，程序与参数分离，不存在命令字符串；
 *  - 唯一例外：Windows 的 `.cmd`/`.bat` 包装器（npm/pnpm）必须经 `%ComSpec%`
 *    启动（Node >= 18.20 禁止直接 spawn），此时逐参数校验并拒绝 cmd 元字符，
 *    不会把用户可控内容拼进 shell 片段；
 *  - 环境变量由调用方显式传入（run_command 只传白名单）；
 *  - 超时/取消时杀掉整个进程树，避免遗留子进程；
 *  - 输出按字节上限截断，并继续 drain，防止管道阻塞。
 *
 * 说明：本模块是"能跑起来"的兜底实现；Phase 9 的 Rust executor 会提供
 * 更强的进程树管理与输出限制，届时优先调用 Rust，本模块作为离线降级路径。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { ForgeError } from '@forgex/shared';

export interface ProcessSpec {
  program: string;
  args: readonly string[];
  cwd?: string;
  /** 显式环境变量；不传则继承父进程（仅用于只读工具，如 git status） */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** stdout / stderr 各自的最大字节数 */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;

/** Windows 批处理/命令包装器（npm.cmd / pnpm.cmd / yarn.cmd 等） */
const WINDOWS_SHIM = /\.(cmd|bat)$/i;

/**
 * 会被 cmd.exe 重新解释的字符。
 * 走 `cmd /c` 启动 .cmd 时，参数最终仍由 cmd 解析，因此这里**拒绝**而不是转义：
 * 与其依赖易错的转义规则，不如让带元字符的调用直接失败（fail closed）。
 */
const CMD_UNSAFE_CHARS = /[&|<>^%"!\r\n\t]/;

interface Launch {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  /** 为 true 时表示经过 cmd.exe 中转（调用方据此给出更精确的错误信息） */
  viaWindowsShim: boolean;
}

/**
 * 计算真正要 spawn 的 program/args。
 *
 * 为什么需要这一层：Node >= 18.20 起（CVE-2024-27980 缓解）不再允许直接
 * spawn `.cmd`/`.bat`，`shell: false` 会直接抛 EINVAL。但 Windows 上 npm/pnpm
 * 只有 `.cmd` 包装器，质量门禁与 run_command 都必须能跑它们。
 *
 * 做法：显式启动 `%ComSpec% /d /s /c "<program>" "<arg>"...`
 *   - 仍然 `shell: false`：只启动一个已知的解释器，不拼接用户可控的 shell 片段；
 *   - 参数逐个加双引号并由 `windowsVerbatimArguments` 原样传递；
 *   - 含 cmd 元字符（& | < > ^ % " ! 等）的参数直接拒绝，避免二次解析注入。
 */
function resolveLaunch(program: string, args: readonly string[]): Launch {
  if (process.platform !== 'win32' || !WINDOWS_SHIM.test(program)) {
    return { command: program, args: [...args], windowsVerbatimArguments: false, viaWindowsShim: false };
  }
  for (const arg of args) {
    if (CMD_UNSAFE_CHARS.test(arg)) {
      throw new ForgeError(
        'TOOL_FAILED',
        `参数包含 cmd 元字符，拒绝通过命令解释器执行: ${arg}`,
        { details: { program, arg } },
      );
    }
  }
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const shimPath = resolveWindowsShim(program);
  // 只在必要时加引号：给所有参数都套引号会让 `%1` 把引号一起带进脚本
  const line = [`"${shimPath}"`, ...args.map(quoteCmdArg)].join(' ');
  return {
    command: comspec,
    // /d 关闭 AutoRun，/s 让 cmd 只剥掉最外层引号，/c 执行后退出
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
    viaWindowsShim: true,
  };
}

/** 空参数或含空白才加引号；元字符已在前面被拒绝 */
function quoteCmdArg(arg: string): string {
  return arg.length === 0 || /[\s]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * 把 `npm.cmd` 这类裸名字解析成绝对路径。
 *
 * 不只是"为了好看"：npm/pnpm 的 shim 用 `%~dp0` 定位自己的 node_modules，
 * 当 cmd 通过 PATH 以裸名字调用时 `%~dp0` 会退化成当前目录，
 * 导致 `Cannot find module '<cwd>\node_modules\npm\...'`。
 * 传绝对路径能让 shim 正确自定位。
 */
function resolveWindowsShim(program: string): string {
  if (isAbsolute(program)) return program;
  if (program.includes('\\') || program.includes('/')) return resolvePath(program);

  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(';').filter(Boolean);
  // `npm.cmd` 已带后缀，不能再拼 PATHEXT（否则变成 npm.cmd.cmd）
  const names = /\.[^\\/.]+$/.test(program) ? [program] : exts.map((ext) => `${program}${ext}`);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new ForgeError('TOOL_FAILED', `找不到可执行程序: ${program}`, { details: { program } });
}

export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const started = Date.now();
    const maxOutput = Math.max(1024, spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT);
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let settled = false;

    let child: ChildProcess;
    try {
      const launch = resolveLaunch(spec.program, spec.args);
      child = spawn(launch.command, launch.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        // POSIX 下建立新进程组，便于 kill(-pid) 杀掉整个子进程树
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(
        new ForgeError('TOOL_FAILED', `无法启动程序 ${spec.program}: ${errorMessage(err)}`, {
          details: { program: spec.program },
          cause: err,
        }),
      );
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;

    const collect = (chunk: Buffer, target: 'out' | 'err') => {
      const used = target === 'out' ? outBytes : errBytes;
      if (used >= maxOutput) {
        truncated = true;
        return;
      }
      const remaining = maxOutput - used;
      if (chunk.length > remaining) {
        truncated = true;
        if (target === 'out') {
          outChunks.push(chunk.subarray(0, remaining));
          outBytes += remaining;
        } else {
          errChunks.push(chunk.subarray(0, remaining));
          errBytes += remaining;
        }
        return;
      }
      if (target === 'out') {
        outChunks.push(chunk);
        outBytes += chunk.length;
      } else {
        errChunks.push(chunk);
        errBytes += chunk.length;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'));

    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (spec.signal) {
      if (spec.signal.aborted) {
        aborted = true;
        killTree(child);
      } else {
        spec.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(100, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    timer.unref?.();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      const notFound = err.code === 'ENOENT';
      reject(
        new ForgeError(
          'TOOL_FAILED',
          notFound ? `找不到可执行程序: ${spec.program}` : `执行 ${spec.program} 失败: ${errorMessage(err)}`,
          {
            details: { program: spec.program, code: err.code ?? 'UNKNOWN' },
            cause: err,
          },
        ),
      );
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        signal: signal ?? null,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        truncated,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * 杀掉整个进程树。
 * Windows 使用 taskkill /T；POSIX 使用进程组负 pid。
 */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程可能已退出
        }
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // 忽略
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 忽略
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
