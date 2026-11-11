import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ForgeError } from '@forgex/shared';
import { killTree, resolveLaunch } from '../execution/process-runner.js';

export interface LspServerConfig {
  id: string;
  extensions: readonly string[];
  languageId: string;
  command: string;
  args: readonly string[];
}

export interface LspPosition {
  line: number;
  character: number;
}

type JsonRpcMessage = Record<string, unknown>;
type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

/** Starts one configured language server for a single request and closes it afterward. */
export class LspClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly diagnostics = new Map<string, unknown>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(
    private readonly server: LspServerConfig,
    private readonly workspaceRoot: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly timeoutMs: number,
  ) {
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    const launch = resolveLaunch(server.command, server.args);
    this.child = spawn(launch.command, launch.args, {
      cwd: workspaceRoot,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on('data', () => { /* Drain diagnostics so a verbose server cannot block on stderr. */ });
    this.child.on('error', (error) => this.failPending(error));
    this.child.on('exit', (code, signal) => {
      this.failPending(new ForgeError('TOOL_FAILED', `LSP server ${server.id} exited (${code ?? signal ?? 'unknown'})`));
      this.resolveExit();
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.workspaceRoot).href,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false, linkSupport: true },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          references: { dynamicRegistration: false },
        },
        workspace: { workspaceFolders: true, symbol: { dynamicRegistration: false } },
      },
      workspaceFolders: [{ uri: pathToFileURL(this.workspaceRoot).href, name: this.server.id }],
    });
    this.notify('initialized', {});
  }

  async openDocument(uri: string, languageId: string, text: string): Promise<void> {
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, this.timeoutMs)));
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ForgeError('TOOL_TIMEOUT', `LSP request ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return result;
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  getDiagnostics(uri: string): unknown {
    return this.diagnostics.get(uri) ?? null;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return;
    try {
      await Promise.race([this.request('shutdown', null), delay(500)]);
      this.notify('exit', null);
      await Promise.race([this.exitPromise, delay(500)]);
    } catch {
      // Cleanup below still terminates a server that does not complete shutdown.
    }
    if (this.child.exitCode === null) killTree(this.child);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.failPending(new ForgeError('TOOL_FAILED', `LSP server ${this.server.id} sent an invalid header`));
        return;
      }
      const bodyStart = headerEnd + 4;
      const bodyLength = Number(lengthMatch[1]);
      if (this.buffer.length < bodyStart + bodyLength) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + bodyLength).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + bodyLength);
      try {
        this.onMessage(JSON.parse(body) as JsonRpcMessage);
      } catch (error) {
        this.failPending(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private onMessage(message: JsonRpcMessage): void {
    if (typeof message.method === 'string') {
      if (message.method === 'textDocument/publishDiagnostics' && isRecord(message.params) && typeof message.params.uri === 'string') {
        this.diagnostics.set(message.params.uri, message.params.diagnostics ?? []);
      }
      if (typeof message.id === 'number' || typeof message.id === 'string') {
        this.write({ jsonrpc: '2.0', id: message.id, result: null });
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error && isRecord(message.error)) pending.reject(new ForgeError('TOOL_FAILED', String(message.error.message ?? 'LSP request failed')));
    else pending.resolve(message.result);
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child.stdin?.writable) throw new ForgeError('TOOL_FAILED', `LSP server ${this.server.id} is not running`);
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
