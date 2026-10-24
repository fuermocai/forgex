/**
 * Rust 执行器客户端。
 *
 * 通过 stdin 传入 JSON 规格，从 stdout 读取 JSON 结果。
 * 该路径与 Node 侧 runProcess 行为对齐，但具备独立的进程树管理，
 * 便于未来演进为独立沙箱（降权用户、cgroup、namespaces）。
 *
 * 安全约束：
 *  - 仍只传递 program + args[]，不经过 shell；
 *  - 环境变量必须由调用方按白名单筛选后传入；
 *  - Rust 侧 `env_clear` 后只注入这些变量。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from '@forgex/shared';

export interface ExecutorSpec {
  program: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ExecutorResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  spawnError?: string;
}

/** stdout 协议上限，防止异常二进制输出撑爆内存 */
const MAX_PROTOCOL_BYTES = 1024 * 1024;

/**
 * 查找可用的 Rust 执行器。
 * 优先 FORGEX_EXECUTOR；其次工作区内的 .forgex/bin/forgex-executor。
 * 找不到返回 null，调用方降级到 Node 执行器。
 */
export function resolveExecutorBinary(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.FORGEX_EXECUTOR;
  if (explicit) return existsSync(explicit) ? explicit : null;

  const name = process.platform === 'win32' ? 'forgex-executor.exe' : 'forgex-executor';
  const candidate = join(workspaceRoot, '.forgex', 'bin', name);
  return existsSync(candidate) ? candidate : null;
}

export function runViaExecutor(
  binary: string,
  spec: ExecutorSpec,
  signal?: AbortSignal,
): Promise<ExecutorResult> {
  return new Promise<ExecutorResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const child = spawn(binary, [], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outChunks: Buffer[] = [];
    let outBytes = 0;
    const errChunks: Buffer[] = [];
    let errBytes = 0;

    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes >= MAX_PROTOCOL_BYTES) return;
      const take = Math.min(chunk.length, MAX_PROTOCOL_BYTES - outBytes);
      outChunks.push(chunk.subarray(0, take));
      outBytes += take;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes >= 8192) return;
      const take = Math.min(chunk.length, 8192 - errBytes);
      errChunks.push(chunk.subarray(0, take));
      errBytes += take;
    });

    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
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
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          // 忽略
        }
      }
    };

    const onAbort = () => {
      kill();
      finish(() => reject(new ForgeError('ABORTED', '命令已被取消')));
    };
    if (signal) {
      if (signal.aborted) {
        kill();
        finish(() => reject(new ForgeError('ABORTED', '命令已被取消')));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // 客户端兜底超时：Rust 自身会按时终止，这里防止执行器本身卡死
    const guard = setTimeout(() => {
      kill();
      finish(() =>
        reject(new ForgeError('TOOL_TIMEOUT', `执行器在 ${spec.timeoutMs + 5000}ms 内未返回`)),
      );
    }, spec.timeoutMs + 5000);
    guard.unref?.();

    const cleanup = () => {
      clearTimeout(guard);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      finish(() =>
        reject(
          new ForgeError(
            'TOOL_FAILED',
            err.code === 'ENOENT' ? `找不到执行器: ${binary}` : `启动执行器失败: ${err.message}`,
            { cause: err },
          ),
        ),
      );
    });

    child.on('close', () => {
      cleanup();
      const raw = Buffer.concat(outChunks).toString('utf8').trim();
      if (!raw) {
        const stderr = Buffer.concat(errChunks).toString('utf8').trim();
        finish(() =>
          reject(
            new ForgeError('TOOL_FAILED', `执行器未返回结果${stderr ? `: ${stderr}` : ''}`),
          ),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        finish(() => reject(new ForgeError('TOOL_FAILED', '执行器返回了非法 JSON')));
        return;
      }
      const result = normalizeResult(parsed);
      if (!result) {
        finish(() => reject(new ForgeError('TOOL_FAILED', '执行器返回结构不完整')));
        return;
      }
      finish(() => resolve(result));
    });

    child.stdin.on('error', () => {
      // 执行器提前退出时写入 stdin 会失败，close 事件会给出最终结论
    });
    child.stdin.end(JSON.stringify(spec));
  });
}

function normalizeResult(value: unknown): ExecutorResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.stdout !== 'string' || typeof record.stderr !== 'string') return null;
  return {
    code: typeof record.code === 'number' ? record.code : null,
    stdout: record.stdout,
    stderr: record.stderr,
    truncated: record.truncated === true,
    timedOut: record.timedOut === true,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    ...(typeof record.spawnError === 'string' ? { spawnError: record.spawnError } : {}),
  };
}
