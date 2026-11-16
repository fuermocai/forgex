import { spawn, type ChildProcess } from 'node:child_process';
import { ForgeError, redactText } from '@forgex/shared';
import { killTree, resolveLaunch } from './process-runner.js';

export type CodeLanguage = 'javascript' | 'python';

export interface CodeSessionManagerOptions {
  nodeCommand?: string;
  pythonCommand?: string;
  maxSessions?: number;
}

export interface CodeSessionExecutionInput {
  sessionId: string;
  language: CodeLanguage;
  code: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CodeSessionExecutionResult {
  language: CodeLanguage;
  stdout: string;
  stderr: string;
  result: unknown;
  error: { message: string; stack?: string } | null;
}

interface ProtocolResponse {
  id: number;
  stdout: string;
  stderr: string;
  outputExceeded?: boolean;
  result?: unknown;
  error?: { message: string; stack?: string } | null;
}

interface PendingRequest {
  id: number;
  resolve(result: CodeSessionExecutionResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
  maxOutputBytes: number;
}

interface SessionProcess {
  key: string;
  child: ChildProcess;
  protocolBuffer: Buffer;
  pending?: PendingRequest;
}

const MAX_CODE_BYTES = 64 * 1024;
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const NODE_SESSION_RUNNER = `
const fs = require('node:fs');
const util = require('node:util');
const vm = require('node:vm');
const repl = require('node:repl');
const readline = require('node:readline');
const { PassThrough, Writable } = require('node:stream');
let stdout = '';
let stderr = '';
let maxOutputBytes = 32768;
let capturedOutputBytes = 0;
let outputExceeded = false;
const writeProtocol = (value) => fs.writeSync(3, JSON.stringify(value) + '\\n');
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const capture = (channel, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const accepted = bytes.subarray(0, Math.max(0, maxOutputBytes - capturedOutputBytes));
  let text = accepted.toString('utf8');
  if (accepted.length < bytes.length && text.endsWith('�')) text = text.slice(0, -1);
  const acceptedBytes = Buffer.byteLength(text, 'utf8');
  if (channel === 'stdout') stdout += text; else stderr += text;
  capturedOutputBytes += acceptedBytes;
  if (acceptedBytes < bytes.length) outputExceeded = true;
};
const limitedResult = (value, depth = 0, budget = { nodes: 500 }) => {
  if (budget.nodes-- <= 0 || depth > 5) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 1024);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => limitedResult(item, depth + 1, budget));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key.slice(0, 100), limitedResult(item, depth + 1, budget)]));
  return value;
};
process.stdout.write = (chunk, encoding, callback) => { capture('stdout', Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8')); if (typeof encoding === 'function') encoding(); else if (typeof callback === 'function') callback(); return true; };
process.stderr.write = (chunk, encoding, callback) => { capture('stderr', Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8')); if (typeof encoding === 'function') encoding(); else if (typeof callback === 'function') callback(); return true; };
const input = new PassThrough();
const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const server = repl.start({ prompt: '', input, output, terminal: false, useGlobal: true, ignoreUndefined: true });
globalThis.require = require;
const evaluate = (code, context, filename, callback) => {
  try {
    const value = vm.runInThisContext(code, { filename });
    if (value && typeof value.then === 'function') value.then((result) => callback(null, result), callback);
    else callback(null, value);
  } catch (error) {
    if (error instanceof SyntaxError && /\\bawait\\b/.test(code)) {
      const trimmed = code.trim();
      const expression = /^await\\b/.test(trimmed) && !/[;\\n]/.test(trimmed) ? 'return (' + trimmed + ')' : trimmed;
      try {
        const promise = vm.runInThisContext('(async () => { ' + expression + ' })()', { filename });
        Promise.resolve(promise).then((result) => callback(null, result), callback);
      } catch (asyncError) {
        callback(asyncError);
      }
      return;
    }
    callback(error);
  }
};
server.context.console = {
  log(...values) { capture('stdout', util.format(...values) + '\\n'); },
  info(...values) { capture('stdout', util.format(...values) + '\\n'); },
  warn(...values) { capture('stderr', util.format(...values) + '\\n'); },
  error(...values) { capture('stderr', util.format(...values) + '\\n'); },
  dir(value) { capture('stdout', util.inspect(limitedResult(value), { depth: 5, maxArrayLength: 50, maxStringLength: 1024 }) + '\\n'); },
};
const requests = readline.createInterface({ input: process.stdin });
requests.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch (error) { writeProtocol({ id: -1, stdout: '', stderr: '', error: { message: String(error) } }); return; }
  stdout = '';
  stderr = '';
  maxOutputBytes = Number.isInteger(request.maxOutputBytes) ? Math.max(0, request.maxOutputBytes) : 32768;
  capturedOutputBytes = 0;
  outputExceeded = false;
  evaluate(request.code, server.context, '<forgex-session>', (error, value) => {
    let result = error ? null : util.inspect(limitedResult(value), { depth: 5, maxArrayLength: 50, maxStringLength: 1024 });
    const resultBytes = Buffer.from(result === null ? '' : String(result));
    if (resultBytes.length > Math.max(0, maxOutputBytes - capturedOutputBytes)) {
      outputExceeded = true;
      result = null;
    } else {
      capturedOutputBytes += resultBytes.length;
    }
    writeProtocol({
      id: request.id,
      stdout,
      stderr,
      result,
      outputExceeded,
      error: error ? { message: String(error.message).slice(0, 2_000), stack: String(error.stack ?? '').slice(0, 8_000) } : null,
    });
  });
});
process.on('exit', () => { process.stdout.write = originalStdoutWrite; process.stderr.write = originalStderrWrite; });
`;

const PYTHON_SESSION_RUNNER = `
import ast
import contextlib
import io
import json
import os
import sys
import traceback

scope = {'__name__': '__main__'}
class BoundedOutput(io.StringIO):
    def write(self, value):
        global captured_output_bytes, output_exceeded
        text = str(value)
        encoded = text.encode('utf-8')
        remaining = max(0, max_output_bytes - captured_output_bytes)
        accepted = encoded[:remaining].decode('utf-8', errors='ignore')
        stored = super().write(accepted)
        accepted_bytes = len(accepted.encode('utf-8'))
        captured_output_bytes += accepted_bytes
        if accepted_bytes < len(encoded):
            output_exceeded = True
        return len(text)

def limit_result(value, depth=0, budget=None):
    if budget is None:
        budget = [500]
    budget[0] -= 1
    if budget[0] < 0 or depth > 5:
        return '[truncated]'
    if isinstance(value, str):
        return value[:1024]
    if isinstance(value, list):
        return [limit_result(item, depth + 1, budget) for item in value[:50]]
    if isinstance(value, tuple):
        return [limit_result(item, depth + 1, budget) for item in value[:50]]
    if isinstance(value, dict):
        return {str(key)[:100]: limit_result(item, depth + 1, budget) for key, item in list(value.items())[:50]}
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return repr(value)[:1024]

for line in sys.stdin:
    try:
        request = json.loads(line)
        max_output_bytes = max(0, int(request.get('maxOutputBytes', 32768)))
        captured_output_bytes = 0
        output_exceeded = False
        stdout = BoundedOutput()
        stderr = BoundedOutput()
        result = None
        error = None
        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                tree = ast.parse(request['code'], '<forgex-session>', 'exec')
                if tree.body and isinstance(tree.body[-1], ast.Expr):
                    last = tree.body.pop()
                    exec(compile(ast.fix_missing_locations(tree), '<forgex-session>', 'exec'), scope)
                    result = eval(compile(ast.Expression(last.value), '<forgex-session>', 'eval'), scope)
                else:
                    exec(compile(tree, '<forgex-session>', 'exec'), scope)
        except BaseException as caught:
            error = {'message': str(caught)[:2000], 'stack': traceback.format_exc()[:8000]}
        try:
            safe_result = limit_result(result)
            encoded_result = json.dumps(safe_result, ensure_ascii=False, default=repr).encode('utf-8')
            if len(encoded_result) > max(0, max_output_bytes - captured_output_bytes):
                output_exceeded = True
                safe_result = None
            else:
                captured_output_bytes += len(encoded_result)
        except BaseException:
            safe_result = repr(result)[:1024]
        response = {'id': request['id'], 'stdout': stdout.getvalue(), 'stderr': stderr.getvalue(), 'result': safe_result, 'outputExceeded': output_exceeded, 'error': error}
        os.write(3, (json.dumps(response, ensure_ascii=False, default=repr) + '\\n').encode('utf-8'))
    except BaseException as caught:
        response = {'id': -1, 'stdout': '', 'stderr': '', 'error': {'message': str(caught)}}
        os.write(3, (json.dumps(response, ensure_ascii=False) + '\\n').encode('utf-8'))
`;

/** Owns persistent interpreter processes with explicit per-request lifecycle limits. */
export class CodeExecutionSessionManager {
  private readonly sessions = new Map<string, SessionProcess>();
  private readonly nodeCommand: string;
  private readonly pythonCommand: string;
  private readonly maxSessions: number;
  private nextRequestId = 1;

  constructor(options: CodeSessionManagerOptions = {}) {
    this.nodeCommand = options.nodeCommand ?? process.execPath;
    this.pythonCommand = options.pythonCommand ?? 'python';
    this.maxSessions = Math.max(1, options.maxSessions ?? 16);
  }

  /** Executes one cell in the session owned by `sessionId` and `language`. */
  async execute(input: CodeSessionExecutionInput): Promise<CodeSessionExecutionResult> {
    if (Buffer.byteLength(input.code, 'utf8') > MAX_CODE_BYTES) {
      throw new ForgeError('TOOL_FAILED', `代码超过 ${MAX_CODE_BYTES} 字节上限`);
    }
    if (input.signal?.aborted) throw new ForgeError('ABORTED', '代码执行已取消');

    const key = `${input.sessionId}\0${input.language}`;
    let session = this.sessions.get(key);
    if (!session) session = this.startSession(key, input.language, input.cwd, input.env);
    if (session.pending) throw new ForgeError('TOOL_FAILED', '此代码会话已有单元正在执行，请等待其结束后重试');

    const id = this.nextRequestId++;
    return new Promise<CodeSessionExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroySession(session!, new ForgeError('TOOL_TIMEOUT', `代码执行超过 ${input.timeoutMs}ms`, { retryable: true }));
      }, Math.max(100, input.timeoutMs));
      timer.unref?.();
      const pending: PendingRequest = { id, resolve, reject, timer, maxOutputBytes: input.maxOutputBytes, signal: input.signal };
      session!.pending = pending;
      if (input.signal) {
        pending.abort = () => this.destroySession(session!, new ForgeError('ABORTED', '代码执行已取消'));
        input.signal.addEventListener('abort', pending.abort, { once: true });
        if (input.signal.aborted) {
          pending.abort();
          return;
        }
      }
      try {
        session!.child.stdin?.write(`${JSON.stringify({ id, code: input.code, maxOutputBytes: input.maxOutputBytes })}\n`);
      } catch (error) {
        this.destroySession(session!, toError(error));
      }
    });
  }

  /** Reports whether a language session currently exists. */
  hasSession(sessionId: string, language: CodeLanguage): boolean {
    return this.sessions.has(`${sessionId}\0${language}`);
  }

  /** Terminates one language session or all sessions owned by an agent session. */
  clear(sessionId: string, language?: CodeLanguage): void {
    for (const [key, session] of this.sessions) {
      if (session.key.startsWith(`${sessionId}\0`) && (!language || key === `${sessionId}\0${language}`)) {
        this.destroySession(session, new ForgeError('ABORTED', '代码会话已清理'));
      }
    }
  }

  /** Terminates all interpreter process trees when a runtime closes. */
  closeAll(): void {
    for (const session of this.sessions.values()) this.destroySession(session, new ForgeError('ABORTED', '代码执行运行时已关闭'));
  }

  private startSession(key: string, language: CodeLanguage, cwd: string, env: NodeJS.ProcessEnv): SessionProcess {
    if (this.sessions.size >= this.maxSessions) throw new ForgeError('TOOL_FAILED', `代码会话已达到上限 ${this.maxSessions}，请先清理空闲会话`);
    const command = language === 'javascript' ? this.nodeCommand : this.pythonCommand;
    const args = language === 'javascript' ? ['-e', NODE_SESSION_RUNNER] : ['-u', '-c', PYTHON_SESSION_RUNNER];
    const launch = resolveLaunch(command, args);
    const child = spawn(launch.command, launch.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const session: SessionProcess = { key, child, protocolBuffer: Buffer.alloc(0) };
    this.sessions.set(key, session);
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', () => undefined);
    child.stdio[3]?.on('data', (chunk: Buffer) => this.onProtocolData(session, chunk));
    child.on('error', (error) => this.destroySession(session, new ForgeError('TOOL_FAILED', `无法启动 ${language} 运行环境: ${error.message}`, { cause: error })));
    child.on('close', (code, signal) => {
      if (this.sessions.get(key) === session) {
        this.destroySession(session, new ForgeError('TOOL_FAILED', `${language} 运行环境已退出 (${code ?? signal ?? 'unknown'})`));
      }
    });
    return session;
  }

  private onProtocolData(session: SessionProcess, chunk: Buffer): void {
    session.protocolBuffer = Buffer.concat([session.protocolBuffer, chunk]);
    const pending = session.pending;
    const maxBytes = pending?.maxOutputBytes ?? 0;
    if (session.protocolBuffer.length > Math.min(MAX_PROTOCOL_BYTES, maxBytes * 8 + 64 * 1024)) {
      this.destroySession(session, new ForgeError('TOOL_FAILED', '代码执行输出超过限制，会话已终止'));
      return;
    }
    for (;;) {
      const newline = session.protocolBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = session.protocolBuffer.subarray(0, newline).toString('utf8');
      session.protocolBuffer = session.protocolBuffer.subarray(newline + 1);
      let response: ProtocolResponse;
      try {
        response = JSON.parse(line) as ProtocolResponse;
      } catch (error) {
        this.destroySession(session, new ForgeError('TOOL_FAILED', '代码运行环境返回了无效协议数据', { cause: error }));
        return;
      }
      if (!session.pending || response.id !== session.pending.id) continue;
      if (response.outputExceeded) {
        this.destroySession(session, new ForgeError('TOOL_FAILED', `代码执行输出超过 ${session.pending.maxOutputBytes} 字节限制，会话已终止`));
        return;
      }
      const resultText = typeof response.result === 'string' ? response.result : JSON.stringify(response.result ?? null);
      const outputBytes = Buffer.byteLength(response.stdout ?? '', 'utf8') + Buffer.byteLength(response.stderr ?? '', 'utf8') + Buffer.byteLength(resultText, 'utf8');
      if (outputBytes > session.pending.maxOutputBytes) {
        this.destroySession(session, new ForgeError('TOOL_FAILED', `代码执行输出超过 ${session.pending.maxOutputBytes} 字节限制，会话已终止`));
        return;
      }
      const result: CodeSessionExecutionResult = {
        language: session.key.endsWith('\0python') ? 'python' : 'javascript',
        stdout: redactText(response.stdout ?? ''),
        stderr: redactText(response.stderr ?? ''),
        result: response.error ? null : response.result ?? null,
        error: response.error
          ? { message: redactText(response.error.message), ...(response.error.stack ? { stack: redactText(response.error.stack) } : {}) }
          : null,
      };
      this.resolvePending(session, result);
      return;
    }
  }

  private resolvePending(session: SessionProcess, result: CodeSessionExecutionResult): void {
    const pending = session.pending;
    if (!pending) return;
    this.cleanPending(session, pending);
    pending.resolve(result);
  }

  private destroySession(session: SessionProcess, error: Error): void {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    const pending = session.pending;
    if (pending) {
      this.cleanPending(session, pending);
      pending.reject(error);
    }
    if (session.child.exitCode === null && session.child.signalCode === null) killTree(session.child);
  }

  private cleanPending(session: SessionProcess, pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort);
    session.pending = undefined;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
