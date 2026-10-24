/**
 * 固定命令执行辅助（DevOps 内部使用）。
 *
 * 与 tools 的 runProcess 的区别：
 *  - 这里的命令全部是硬编码的只读诊断命令，参数不接受模型输入；
 *  - 使用 execFile（无 shell），带超时与 maxBuffer；
 *  - 不封装进程树杀灭（tasklist/netstat/df 都是短命进程）。
 */
import { execFile } from 'node:child_process';
import { ForgeError } from '@forgex/shared';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function execFileText(
  program: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    execFile(
      program,
      [...args],
      {
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const errCode = (error as NodeJS.ErrnoException).code;
          if (errCode === 'ENOENT') {
            reject(
              new ForgeError('TOOL_FAILED', `系统诊断命令不可用: ${program}`, {
                details: { program, code: 'ENOENT' },
                cause: error,
              }),
            );
            return;
          }
          // 命令存在但返回非 0（如权限不足）：交给调用方展示 stderr
          resolve({
            code: typeof errCode === 'number' ? errCode : -1,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? error.message),
          });
          return;
        }
        resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}
