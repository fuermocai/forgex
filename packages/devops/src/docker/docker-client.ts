/**
 * Docker Engine API HTTP 客户端。
 *
 * 特性：
 *   - unix socket：node:http 的 socketPath 选项
 *   - TCP：node:http/https 的 host+port（从 tcpUrl 解析）
 *   - 只发 GET，不跟随重定向（Docker API 不需要）
 *   - 支持 AbortSignal + 超时双重取消
 *   - 响应体限制：默认 4MB，logs 响应默认 20MB（防止 OOM）
 *   - 错误统一返回结构化 DockerApiError
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { Readable } from 'node:stream';
import type { GuardedDockerRequest } from './docker-guard.js';

export interface DockerApiError extends Error {
  readonly dockerError: true;
  readonly kind: 'connection' | 'timeout' | 'http' | 'parse';
  readonly statusCode?: number;
  readonly endpoint: string;
  readonly underlying?: unknown;
}

export interface DockerExecuteResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: DockerApiError;
  durationMs: number;
  /** 响应体是否被截断（超过 maxBodyBytes） */
  truncated?: boolean;
}

export interface DockerExecuteOptions {
  signal?: AbortSignal;
  /** 响应体大小上限（字节），默认 4_194_304（4MB） */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 4 * 1024 * 1024;
const LOGS_MAX_BODY = 20 * 1024 * 1024;

export class DockerClient {
  async execute(
    req: GuardedDockerRequest,
    options: DockerExecuteOptions = {},
  ): Promise<DockerExecuteResult> {
    const start = performance.now();
    const maxBody = options.maxBodyBytes ?? (req.action.action === 'container_logs' ? LOGS_MAX_BODY : DEFAULT_MAX_BODY);

    return new Promise((resolve) => {
      // 构建请求选项
      const opts: http.RequestOptions = {
        method: req.method,
        path: req.path,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ForgeX-Docker-Diag/0.2.0',
        },
      };

      if ('socketPath' in req.connection) {
        opts.socketPath = req.connection.socketPath;
      } else {
        const url = new URL(req.connection.tcpUrl!);
        opts.host = url.hostname;
        opts.port = url.port || (url.protocol === 'https:' ? 2376 : 2375);
      }

      const signal = options.signal;
      const timeoutMs = req.timeoutMs;

      let reqObj: http.ClientRequest;
      try {
        const lib = 'socketPath' in req.connection ? http : ((opts.host?.startsWith('localhost') || 'tcpUrl' in req.connection) ? http : https);
        // 简化判断：tcpUrl 以 https:// 开头或端口 2376 用 https
        const useHttps = 'tcpUrl' in req.connection && req.connection.tcpUrl!.startsWith('https://');
        reqObj = (useHttps ? https : http).request(opts, (res) => {
          const chunks: Buffer[] = [];
          let totalSize = 0;
          let truncated = false;

          res.on('data', (chunk: Buffer) => {
            if (totalSize + chunk.length > maxBody) {
              truncated = true;
              const remaining = maxBody - totalSize;
              if (remaining > 0) {
                chunks.push(chunk.slice(0, remaining));
                totalSize += remaining;
              }
              res.destroy();
              return;
            }
            chunks.push(chunk);
            totalSize += chunk.length;
          });

          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const durationMs = Math.round(performance.now() - start);

            if (res.statusCode && res.statusCode >= 400) {
              resolve({
                ok: false,
                durationMs,
                error: this.makeError('http', req.path, `HTTP ${res.statusCode}: ${body.slice(0, 500)}`, res.statusCode),
              });
              return;
            }

            // Docker logs 端点返回纯文本（不是 JSON），其他都是 JSON
            const isLogs = req.action.action === 'container_logs';
            const data = isLogs ? body : this.tryParseJson(body);

            resolve({
              ok: true,
              data,
              durationMs,
              truncated,
            });
          });

          res.on('error', (err) => {
            resolve({
              ok: false,
              durationMs: Math.round(performance.now() - start),
              error: this.makeError('parse', req.path, err.message, undefined, err),
            });
          });
        });
      } catch (err) {
        resolve({
          ok: false,
          durationMs: Math.round(performance.now() - start),
          error: this.makeError('connection', req.path, err instanceof Error ? err.message : String(err), undefined, err),
        });
        return;
      }

      // 超时
      const timer = setTimeout(() => {
        reqObj.destroy();
        resolve({
          ok: false,
          durationMs: Math.round(performance.now() - start),
          error: this.makeError('timeout', req.path, `Docker API 请求超时 (${timeoutMs}ms)`),
        });
      }, timeoutMs);

      // AbortSignal
      const onAbort = () => {
        clearTimeout(timer);
        reqObj.destroy();
        resolve({
          ok: false,
          durationMs: Math.round(performance.now() - start),
          error: this.makeError('connection', req.path, '请求被取消'),
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      reqObj.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          ok: false,
          durationMs: Math.round(performance.now() - start),
          error: this.makeError('connection', req.path, err.message, undefined, err),
        });
      });

      reqObj.end();
    });
  }

  private tryParseJson(body: string): unknown {
    if (!body) return null;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  private makeError(kind: DockerApiError['kind'], endpoint: string, message: string, statusCode?: number, underlying?: unknown): DockerApiError {
    const err = new Error(message) as DockerApiError;
    (err as any).dockerError = true;
    (err as any).kind = kind;
    (err as any).endpoint = endpoint;
    if (statusCode !== undefined) (err as any).statusCode = statusCode;
    if (underlying !== undefined) (err as any).underlying = underlying;
    return err;
  }
}
