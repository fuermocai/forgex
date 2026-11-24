import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import ssh2, { type Client, type ConnectConfig } from 'ssh2';
import { ForgeError, type JsonValue } from '@forgex/shared';
import type { GuardedSpec } from './ssh-guard.js';
import type { SshExecuteResult, SshExecSpec, SshHostConfig } from './types.js';

const CONNECT_TIMEOUT_MS = 10_000;
type Endpoint = Pick<SshHostConfig, 'host' | 'port' | 'username'>;

function readPrivateKey(path: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024) throw new Error();
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const bytes = readSync(fd, data, offset, data.length - offset, null);
      if (!bytes) throw new Error();
      offset += bytes;
    }
    return data;
  } catch {
    throw new ForgeError('SSH_AUTH_FAILED', '无法读取私钥，请检查文件路径和读取权限');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Own the transport until the caller finishes, including failures before ready. */
async function withClient<T>(signal: AbortSignal | undefined, start: (
  client: Client, resolve: (value: T) => void, reject: (error: Error) => void,
) => void): Promise<T> {
  const client = new ssh2.Client();
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new ForgeError('ABORTED', 'SSH 操作已取消'));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      client.on('error', (error: Error & { level?: string }) => {
        if (error.level === 'client-timeout') reject(new ForgeError('TOOL_TIMEOUT', 'SSH 连接超时'));
        else if (error.level === 'client-authentication') reject(new ForgeError('SSH_AUTH_FAILED', 'SSH 私钥认证失败'));
        else reject(new ForgeError('SSH_CONNECTION_FAILED', 'SSH 连接失败，请检查主机、端口和网络'));
      });
      client.once('close', () => reject(new ForgeError('SSH_CONNECTION_FAILED', 'SSH 连接已关闭')));
      start(client, resolve, reject);
    });
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    client.destroy();
  }
}

function fingerprintOf(hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new ForgeError('SSH_HOSTKEY_MISMATCH', '无效的服务器主机指纹');
  return 'SHA256:' + Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
}

function endpointConfig(host: Endpoint, timeout = CONNECT_TIMEOUT_MS): ConnectConfig {
  return { host: host.host, port: host.port ?? 22, username: host.username, readyTimeout: timeout, hostHash: 'sha256' };
}

function authenticate(client: Client, host: SshHostConfig, reject: (err: Error) => void, timeout?: number): void {
  if (!host.hostKeyFingerprint) throw new ForgeError('SSH_HOSTKEY_MISSING', '请先核对并信任主机指纹');
  const privateKey = readPrivateKey(host.privateKeyPath);
  try {
    client.connect({
      ...endpointConfig(host, timeout),
      privateKey,
      authHandler: ['publickey'],
      hostVerifier: (hex: string) => {
        // Retain compatibility with existing configurations using ssh2's hex digest.
        if (host.hostKeyFingerprint === fingerprintOf(hex) || host.hostKeyFingerprint === hex) return true;
        reject(new ForgeError('SSH_HOSTKEY_MISMATCH', '主机指纹不匹配，已阻止连接。请重新核对指纹'));
        return false;
      },
    });
  } catch {
    throw new ForgeError('SSH_AUTH_FAILED', '私钥无效或已加密，请选择可读取的无口令私钥');
  } finally {
    privateKey.fill(0);
  }
}

export class SshClient {
  probeHostKey(host: Endpoint, signal: AbortSignal): Promise<string> {
    return withClient<string>(signal, (client, resolve) => {
      client.connect({ ...endpointConfig(host), authHandler: [], hostVerifier: (hex: string) => {
        resolve(fingerprintOf(hex));
        // Reject the handshake before ssh2 can start user authentication.
        return false;
      } });
    });
  }

  testConnection(host: SshHostConfig, signal: AbortSignal): Promise<void> {
    return withClient<void>(signal, (client, resolve, reject) => {
      client.once('ready', resolve);
      authenticate(client, host, reject);
    });
  }

  async execute(spec: SshExecSpec, guard: GuardedSpec, signal?: AbortSignal): Promise<SshExecuteResult> {
    const { host, command } = guard;
    const started = Date.now();
    const limit = Math.min(command.maxOutputBytes, 256 * 1024);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let timer: NodeJS.Timeout | undefined;
    let connectionError: string | undefined;
    try {
      exitCode = await withClient<number | null>(signal, (client, resolve, reject) => {
        client.once('ready', () => {
          timer = setTimeout(() => { timedOut = true; resolve(null); }, Math.min(command.timeoutMs, 30_000));
          client.exec(command.shellCommand, (err, channel) => {
            if (err) { reject(new ForgeError('SSH_EXEC_FAILED', '无法启动远程诊断')); return; }
            channel.on('error', () => reject(new ForgeError('SSH_EXEC_FAILED', '远程诊断通道失败')));
            channel.once('close', (code: number | undefined) => resolve(code ?? null));
            channel.on('data', (chunk: Buffer) => {
              const data = chunk.subarray(0, limit - stdoutBytes);
              if (data.length) stdout.push(data);
              stdoutBytes += data.length;
              if (data.length < chunk.length) truncated = true;
            });
            channel.stderr.on('data', (chunk: Buffer) => {
              const data = chunk.subarray(0, Math.floor(limit / 2) - stderrBytes);
              if (data.length) stderr.push(data);
              stderrBytes += data.length;
              if (data.length < chunk.length) truncated = true;
            });
          });
        });
        authenticate(client, host, reject, spec.options?.connectTimeoutMs);
      });
    } catch (err) {
      if (!signal?.aborted) throw err;
      connectionError = 'SSH 操作已取消';
    } finally {
      clearTimeout(timer);
    }
    return {
      exitCode, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
      truncated, timedOut, durationMs: Date.now() - started, action: command.action,
      input: spec.action as unknown as JsonValue, ...(connectionError ? { connectionError } : {}),
    };
  }
}
