/**
 * 子进程执行器（Node 侧）。
 *
 * 安全约束（与 Security 层配合）：
 *  - 永远 `shell: false`，程序与参数分离，不存在命令字符串；
 *  - 环境变量由调用方显式传入（run_command 只传白名单）；
 *  - 超时/取消时杀掉整个进程树，避免遗留子进程；
 *  - 输出按字节上限截断，并继续 drain，防止管道阻塞。
 *
 * 说明：本模块是"能跑起来"的兜底实现；Phase 9 的 Rust executor 会提供
 * 更强的进程树管理与输出限制，届时优先调用 Rust，本模块作为离线降级路径。
 */
import { spawn, type ChildProcess } from 'node:child_process';
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
      child = spawn(spec.program, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        windowsHide: true,
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
