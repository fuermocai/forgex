/**
 * SSH 远程执行客户端（ssh2 协议实现）。
 *
 * 安全边界：
 *   - 本类只负责"连接并执行 Guard 产出的命令"，不做任何安全判定；
 *   - Host Key 指纹必须匹配（SHA256: 前缀严格比对）；
 *   - 连接/命令双重超时；stdout/stderr 分别限流；
 *   - AbortSignal 可在任何阶段中断；
 *   - 私钥路径不在本层校验——Guard 已在 validateHost 里做过，这里假设已解析到安全路径。
 */
import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';
import type { Channel, ConnectConfig, ExecOptions } from 'ssh2';
import { ForgeError, byteLength, type JsonValue } from '@forgex/shared';
import type { GuardedSpec, SshCommand } from './ssh-guard.js';
import type { SshExecuteResult, SshExecSpec } from './types.js';

/** 默认连接超时 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** 默认命令超时 */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** 默认输出上限（ssh-guard 层已强制截断这里再兜底） */
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export class SshClient {
  /**
   * 执行一条 Guard 校验后的 SSH 规格。
   * Guard 必须先被调用，本类不绕过 Guard。
   */
  async execute(spec: SshExecSpec, guard: GuardedSpec, signal?: AbortSignal): Promise<SshExecuteResult> {
    const { host, command } = guard;
    const connectTimeoutMs = spec.options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const commandTimeoutMs = Math.min(command.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
    const maxOutputBytes = Math.min(command.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);

    const client = new Client();
    const started = Date.now();

    let aborted = false;
    let hostKeyMismatch = false;
    let connectionError: string | undefined;
    let execChannel: Channel | null = null;
    let cmdTimer: NodeJS.Timeout | null = null;

    const teardown = (): void => {
      if (cmdTimer) { clearTimeout(cmdTimer); cmdTimer = null; }
      try { execChannel?.close(); } catch { /* noop */ }
      try { client.end(); } catch { /* noop */ }
      try { client.destroy(); } catch { /* noop */ }
    };

    const onAbort = (): void => {
      aborted = true;
      teardown();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const privateKeyData = readFileSync(host.privateKeyPath);

    // Host Key 校验：Guard 已强制 hostKeyFingerprint 必填
    // ssh2 用 SyncHostFingerprintVerifier 自动计算指纹后传给我们比对
    const expectedFingerprint = host.hostKeyFingerprint!;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: unknown): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };

      const connectTimeout = setTimeout(() => {
        finish(new ForgeError('SSH_CONNECTION_FAILED', `连接 ${host.host}:${host.port ?? 22} 超时`));
      }, connectTimeoutMs);

      client
        .on('ready', () => {
          clearTimeout(connectTimeout);
          finish();
        })
        .on('error', (err: Error & { code?: string }) => {
          clearTimeout(connectTimeout);
          if (signal?.aborted) {
            finish(new ForgeError('ABORTED', 'SSH 连接被取消'));
            return;
          }
          if (hostKeyMismatch) {
            finish(new ForgeError('SSH_HOSTKEY_MISMATCH', connectionError ?? 'Host Key 指纹不匹配'));
            return;
          }
          connectionError = err.message;
          finish(new ForgeError('SSH_CONNECTION_FAILED', `SSH 连接失败: ${err.message}`));
        })
        .connect({
          host: host.host,
          port: host.port ?? 22,
          username: host.username,
          privateKey: privateKeyData,
          readyTimeout: connectTimeoutMs,
          // ssh2 会自动计算 SHA256 指纹并传给 SyncHostFingerprintVerifier
          hostHash: 'sha256',
          hostVerifier: (fingerprint: string): boolean => {
            if (fingerprint !== expectedFingerprint) {
              hostKeyMismatch = true;
              connectionError = `Host Key 指纹不匹配: 期望 ${expectedFingerprint}, 实际 ${fingerprint}`;
              return false;
            }
            return true;
          },
        } satisfies ConnectConfig);
    });

    if (aborted) {
      teardown();
      return this.abortedResult(command, spec, started, 'SSH 连接被取消');
    }

    // 命令执行
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let exitCode: number | null = null;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (err?: unknown): void => {
          if (settled) return;
          settled = true;
          if (err) reject(err); else resolve();
        };

        const execOpts: ExecOptions = {};
        client.exec(command.shellCommand, execOpts, (err, channel) => {
          if (err) {
            finish(new ForgeError('SSH_EXEC_FAILED', `远程命令启动失败: ${err.message}`));
            return;
          }
          execChannel = channel;

          cmdTimer = setTimeout(() => {
            timedOut = true;
            channel.close();
          }, commandTimeoutMs);

          channel
            .on('close', (code: number | null) => {
              if (cmdTimer) { clearTimeout(cmdTimer); cmdTimer = null; }
              exitCode = code;
              finish();
            })
            .on('data', (data: Buffer) => {
              const chunk = data.toString('utf8');
              if (byteLength(stdout) < maxOutputBytes) {
                stdout += chunk;
                if (byteLength(stdout) >= maxOutputBytes) truncated = true;
              } else {
                truncated = true;
              }
            })
            .stderr
            .on('data', (data: Buffer) => {
              const chunk = data.toString('utf8');
              const stderrLimit = Math.floor(maxOutputBytes * 0.5);
              if (byteLength(stderr) < stderrLimit) {
                stderr += chunk;
                if (byteLength(stderr) >= stderrLimit) truncated = true;
              } else {
                truncated = true;
              }
            });
        });
      });
    } catch (err) {
      teardown();
      if (signal?.aborted) {
        return this.abortedResult(command, spec, started, '远程命令已取消');
      }
      if (err instanceof ForgeError) throw err;
      throw new ForgeError('SSH_EXEC_FAILED', err instanceof Error ? err.message : String(err));
    }

    teardown();

    const input = spec.action as unknown as Record<string, unknown>;
    return {
      exitCode,
      stdout: truncated ? truncateWithNote(stdout, maxOutputBytes, 0.9) : stdout,
      stderr: truncated ? truncateWithNote(stderr, Math.floor(maxOutputBytes * 0.5), 0.9) : stderr,
      truncated,
      timedOut,
      durationMs: Date.now() - started,
      action: command.action,
      input: input as unknown as JsonValue,
    };
  }

  private abortedResult(command: SshCommand, spec: SshExecSpec, started: number, reason: string): SshExecuteResult {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: Date.now() - started,
      action: command.action,
      input: (spec.action as unknown as Record<string, unknown>) as unknown as JsonValue,
      connectionError: reason,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                              */
/* ------------------------------------------------------------------ */

/**
 * SSH Host Key 指纹现在由 ssh2 的 SyncHostFingerprintVerifier 自动计算
 * 并直接传给 hostVerifier 回调，不需要我们自己实现。
 */

function truncateWithNote(text: string, limitBytes: number, keepRatio: number): string {
  const maxChars = Math.max(64, Math.floor(limitBytes * keepRatio));
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return text;
  return text.slice(0, maxChars) + '\n...[truncated]';
}
