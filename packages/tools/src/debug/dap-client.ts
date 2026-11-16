import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForgeError, redactText, redactValue, type ToolContext } from '@forgex/shared';
import { killTree, resolveLaunch } from '../execution/process-runner.js';

export interface DebugAdapterConfig {
  id: string;
  extensions: readonly string[];
  command: string;
  args: readonly string[];
  launchArgs: Readonly<Record<string, unknown>>;
  attachArgs: Readonly<Record<string, unknown>>;
}

export interface DebugBreakpoint {
  line: number;
  condition?: string;
}

interface PendingResponse {
  command: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface DapSession {
  sessionId: string;
  adapterId: string;
  child: ChildProcess;
  buffer: Buffer;
  nextSequence: number;
  pending: Map<number, PendingResponse>;
  initialized: boolean;
  initializedWaiters: Array<{ resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
  closed: boolean;
}

const REQUEST_TIMEOUT_MS = 15_000;
const INITIALIZED_TIMEOUT_MS = 20_000;
const MAX_DAP_MESSAGE_BYTES = 1024 * 1024;

/** Owns one DAP adapter process per Agent session and closes it as a process tree. */
export class DapSessionManager {
  private readonly sessions = new Map<string, DapSession>();

  /** Launches a configured adapter and debuggee, then configures initial breakpoints. */
  async start(
    ctx: ToolContext,
    adapter: DebugAdapterConfig,
    program: string,
    args: readonly string[],
    breakpoints: readonly DebugBreakpoint[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ adapterId: string; program: string; breakpoints: unknown }> {
    const programPath = await ctx.workspace.resolve(program, 'read', ctx.cwd);
    const info = await stat(programPath);
    if (!info.isFile()) throw new ForgeError('TOOL_FAILED', `调试目标不是文件: ${program}`);
    const extension = extname(programPath).toLowerCase();
    if (!adapter.extensions.some((item) => item.toLowerCase() === extension)) {
      throw new ForgeError('TOOL_FAILED', `Adapter ${adapter.id} 未声明支持 ${extension || '无扩展名'} 文件`);
    }
    if (this.sessions.has(ctx.sessionId)) throw new ForgeError('TOOL_FAILED', '当前 Agent session 已有活动调试会话，请先关闭它');
    if (ctx.signal.aborted) throw new ForgeError('ABORTED', '调试会话启动已取消');

    const session = this.spawnAdapter(ctx.sessionId, adapter, ctx.workspaceRoot, env);
    const abort = () => this.destroy(session, new ForgeError('ABORTED', '调试会话已取消'));
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      await this.requestWithSession(session, 'initialize', {
        clientID: 'forgex',
        clientName: 'ForgeX',
        adapterID: adapter.id,
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsRunInTerminalRequest: false,
      });
      const initialized = this.waitForInitialized(session);
      await this.requestWithSession(session, 'launch', {
        ...adapter.launchArgs,
        program: programPath,
        args: [...args],
        cwd: ctx.workspaceRoot,
        stopOnEntry: true,
        noDebug: false,
      });
      await initialized;
      let breakpointResult: unknown = { breakpoints: [] };
      if (breakpoints.length > 0) {
        breakpointResult = await this.requestWithSession(session, 'setBreakpoints', {
          source: { path: programPath },
          breakpoints: breakpoints.map((breakpoint) => ({
            line: breakpoint.line,
            ...(breakpoint.condition ? { condition: breakpoint.condition } : {}),
          })),
          sourceModified: false,
        });
      }
      await this.requestWithSession(session, 'configurationDone', {});
      return {
        adapterId: adapter.id,
        program: relative(ctx.workspaceRoot, programPath).split(sep).join('/'),
        breakpoints: limitDapValue(redactValue(breakpointResult)),
      };
    } catch (error) {
      this.destroy(session, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      ctx.signal.removeEventListener('abort', abort);
    }
  }

  /** Attaches a configured adapter to an existing process. */
  async attach(
    ctx: ToolContext,
    adapter: DebugAdapterConfig,
    processId: number,
    env: NodeJS.ProcessEnv,
  ): Promise<{ adapterId: string; processId: number }> {
    if (this.sessions.has(ctx.sessionId)) throw new ForgeError('TOOL_FAILED', '当前 Agent session 已有活动调试会话，请先关闭它');
    if (ctx.signal.aborted) throw new ForgeError('ABORTED', '调试附加已取消');
    const session = this.spawnAdapter(ctx.sessionId, adapter, ctx.workspaceRoot, env);
    const abort = () => this.destroy(session, new ForgeError('ABORTED', '调试附加已取消'));
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      await this.requestWithSession(session, 'initialize', {
        clientID: 'forgex', clientName: 'ForgeX', adapterID: adapter.id, pathFormat: 'path',
        linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true,
      });
      const initialized = this.waitForInitialized(session);
      await this.requestWithSession(session, 'attach', { ...adapter.attachArgs, processId });
      await initialized;
      await this.requestWithSession(session, 'configurationDone', {});
      return { adapterId: adapter.id, processId };
    } catch (error) {
      this.destroy(session, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      ctx.signal.removeEventListener('abort', abort);
    }
  }

  /** Sends one DAP request to the session owned by an Agent. */
  async request(sessionId: string, command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new ForgeError('TOOL_FAILED', '调试会话不存在或已结束');
    return limitDapValue(redactValue(await this.requestWithSession(session, command, args)));
  }

  /** Validates every mapped source path in a DAP response against the workspace. */
  async validateSources(value: unknown, ctx: ToolContext): Promise<void> {
    for (const path of findSourcePaths(value)) {
      const target = path.startsWith('file:') ? fileURLToPath(new URL(path)) : path;
      await ctx.workspace.resolve(target, 'read', ctx.cwd);
    }
  }

  /** Gracefully disconnects a session and then terminates the adapter process tree. */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      await this.requestWithSession(session, 'disconnect', { restart: false, terminateDebuggee: true });
      session.child.stdin?.end();
      await Promise.race([waitForClose(session.child), delay(500)]);
    } catch {
      // The adapter can already be gone or may not implement disconnect.
    }
    this.destroy(session, new ForgeError('ABORTED', '调试会话已结束'));
    await Promise.race([waitForClose(session.child), delay(1_000)]);
  }

  /** Reports whether an Agent currently owns a live adapter. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Terminates all adapter process trees when the CLI runtime closes. */
  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) this.destroy(session, new ForgeError('ABORTED', '调试运行时已关闭'));
    await Promise.all(sessions.map(async (session) => Promise.race([waitForClose(session.child), delay(1_000)])));
  }

  private spawnAdapter(sessionId: string, adapter: DebugAdapterConfig, cwd: string, env: NodeJS.ProcessEnv): DapSession {
    const launch = resolveLaunch(adapter.command, adapter.args);
    const child = spawn(launch.command, launch.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session: DapSession = {
      sessionId,
      adapterId: adapter.id,
      child,
      buffer: Buffer.alloc(0),
      nextSequence: 1,
      pending: new Map(),
      initialized: false,
      initializedWaiters: [],
      closed: false,
    };
    this.sessions.set(sessionId, session);
    child.stdout?.on('data', (chunk: Buffer) => this.onData(session, chunk));
    child.stderr?.on('data', () => undefined);
    child.on('error', (error) => this.destroy(session, new ForgeError('TOOL_FAILED', `无法启动 DAP adapter ${adapter.id}: ${error.message}`, { cause: error })));
    child.on('close', (code, signal) => this.destroy(session, new ForgeError('TOOL_FAILED', `DAP adapter ${adapter.id} 已退出 (${code ?? signal ?? 'unknown'})`)));
    return session;
  }

  private requestWithSession(session: DapSession, command: string, args: Record<string, unknown>): Promise<unknown> {
    if (session.closed || !session.child.stdin?.writable) return Promise.reject(new ForgeError('TOOL_FAILED', `DAP adapter ${session.adapterId} 未运行`));
    const seq = session.nextSequence++;
    const message = { seq, type: 'request', command, arguments: args };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroy(session, new ForgeError('TOOL_TIMEOUT', `DAP ${command} 请求超时，会话已终止`, { retryable: true }));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      session.pending.set(seq, { command, resolve, reject, timer });
      try {
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        session.child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
        session.child.stdin!.write(body);
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(seq);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private waitForInitialized(session: DapSession): Promise<void> {
    if (session.initialized) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.initializedWaiters = session.initializedWaiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new ForgeError('TOOL_TIMEOUT', `DAP adapter ${session.adapterId} 未发送 initialized 事件`, { retryable: true }));
      }, INITIALIZED_TIMEOUT_MS);
      timer.unref?.();
      session.initializedWaiters.push({ resolve, reject, timer });
    });
  }

  private onData(session: DapSession, chunk: Buffer): void {
    session.buffer = Buffer.concat([session.buffer, chunk]);
    if (session.buffer.length > MAX_DAP_MESSAGE_BYTES + 8_192) {
      this.destroy(session, new ForgeError('TOOL_FAILED', `DAP adapter ${session.adapterId} 输出超过消息上限`));
      return;
    }
    for (;;) {
      const headerEnd = session.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = session.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.destroy(session, new ForgeError('TOOL_FAILED', `DAP adapter ${session.adapterId} 返回了无效消息头`));
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DAP_MESSAGE_BYTES) {
        this.destroy(session, new ForgeError('TOOL_FAILED', `DAP adapter ${session.adapterId} 返回了无效消息长度`));
        return;
      }
      const messageStart = headerEnd + 4;
      if (session.buffer.length < messageStart + length) return;
      const body = session.buffer.subarray(messageStart, messageStart + length).toString('utf8');
      session.buffer = session.buffer.subarray(messageStart + length);
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.destroy(session, new ForgeError('TOOL_FAILED', `DAP adapter ${session.adapterId} 返回了无效 JSON`, { cause: error }));
        return;
      }
      this.handleMessage(session, message);
    }
  }

  private handleMessage(session: DapSession, value: unknown): void {
    if (!isRecord(value)) return;
    if (value.type === 'event' && value.event === 'initialized') {
      session.initialized = true;
      for (const waiter of session.initializedWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      session.initializedWaiters = [];
      return;
    }
    if (value.type !== 'response' || typeof value.request_seq !== 'number') return;
    const pending = session.pending.get(value.request_seq);
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pending.delete(value.request_seq);
    if (value.success !== true) {
      const message = typeof value.message === 'string' ? redactText(value.message) : `请求 ${pending.command} 被 adapter 拒绝`;
      pending.reject(new ForgeError('TOOL_FAILED', `DAP ${pending.command} 失败: ${message}`));
      return;
    }
    pending.resolve(value.body ?? null);
  }

  private destroy(session: DapSession, error: Error): void {
    if (session.closed) return;
    session.closed = true;
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    for (const [seq, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      session.pending.delete(seq);
    }
    for (const waiter of session.initializedWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    session.initializedWaiters = [];
    if (session.child.exitCode === null && session.child.signalCode === null) killTree(session.child);
  }
}

function findSourcePaths(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (Array.isArray(value)) return value.flatMap((item) => findSourcePaths(item, depth + 1));
  if (!isRecord(value)) return [];
  const paths: string[] = [];
  if (isRecord(value.source) && typeof value.source.path === 'string') paths.push(value.source.path);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) paths.push(...findSourcePaths(item, depth + 1));
    } else if (isRecord(child)) {
      paths.push(...findSourcePaths(child, depth + 1));
    }
  }
  return [...new Set(paths)];
}

function limitDapValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[截断：嵌套过深]';
  if (typeof value === 'string') return redactText(value.slice(0, 2_000));
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => limitDapValue(item, depth + 1));
  if (!isRecord(value)) return value;
  const entries = Object.entries(value).slice(0, 100);
  return Object.fromEntries(entries.map(([key, item]) => [key, limitDapValue(item, depth + 1)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
