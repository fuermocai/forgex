import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable, Readable } from 'node:stream';
import { ForgeError, redactText, redactValue, type ToolContext } from '@forgex/shared';
import { killTree, resolveLaunch } from '../execution/process-runner.js';

export interface BrowserAutomationConfig {
  command: string;
  args: readonly string[];
  allowedHosts: readonly string[];
  timeoutMs: number;
}

interface CdpPending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface CdpEventWaiter {
  sessionId?: string;
  resolve(params: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface BrowserSession {
  agentSessionId: string;
  config: BrowserAutomationConfig;
  profileDir: string;
  child: ChildProcess;
  cdp: CdpPipe;
  browserSessionId: string;
  targetId: string;
  pageSessionId: string;
  mainFrameId?: string;
  currentUrl?: string;
  targetSessions: Map<string, string>;
  targetWaiters: Map<string, { resolve(sessionId: string): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
  allowedHosts: ReadonlySet<string>;
  idleTimer?: NodeJS.Timeout;
  closing: boolean;
  cleanup?: Promise<void>;
}

const CDP_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CDP_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_TEXT_CHARS = 16_000;
const SESSION_IDLE_MS = 15 * 60 * 1000;

/** Owns isolated headless browser profiles and their DevTools pipe sessions. */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>();

  /** Opens a page after validating its exact host against the configured allowlist. */
  async navigate(ctx: ToolContext, config: BrowserAutomationConfig, rawUrl: string): Promise<unknown> {
    const url = validateBrowserUrl(rawUrl, config.allowedHosts);
    const session = await this.getOrCreateSession(ctx.sessionId, config, ctx.workspaceRoot);
    this.touch(session);
    const loaded = session.cdp.waitForEvent('Page.loadEventFired', session.pageSessionId, config.timeoutMs);
    const result = await session.cdp.request('Page.navigate', { url: url.href }, session.pageSessionId);
    if (isRecord(result) && typeof result.errorText === 'string') {
      throw new ForgeError('TOOL_FAILED', `浏览器导航失败: ${redactText(result.errorText)}`);
    }
    await loaded;
    return this.snapshot(ctx, config);
  }

  /** Returns title, current URL and visible page text without form values. */
  async snapshot(ctx: ToolContext, config: BrowserAutomationConfig, approvedUrl?: string): Promise<unknown> {
    const session = this.requireSession(ctx.sessionId);
    this.assertSameConfig(session, config);
    this.touch(session);
    const snapshotExpression = `({ url: location.href, title: document.title, text: document.body ? document.body.innerText.slice(0, ${MAX_PAGE_TEXT_CHARS}) : '' })`;
    const value = approvedUrl
      ? await this.evaluateAtApprovedUrl(session, approvedUrl, `return ${snapshotExpression};`)
      : await this.evaluate(session, snapshotExpression);
    await this.validateObservedUrl(session, typeof value.url === 'string' ? value.url : '');
    session.currentUrl = typeof value.url === 'string' ? value.url : undefined;
    return limitBrowserValue(redactValue(value));
  }

  /** Clicks one selector in the isolated page. */
  async click(ctx: ToolContext, config: BrowserAutomationConfig, selector: string, approvedUrl?: string): Promise<unknown> {
    const session = this.requireSession(ctx.sessionId);
    this.assertSameConfig(session, config);
    this.touch(session);
    const body = `const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return { error: 'selector not found' }; element.click(); return { clicked: true };`;
    const value = approvedUrl
      ? await this.evaluateAtApprovedUrl(session, approvedUrl, body)
      : await this.evaluate(session, `(() => { ${body} })()`);
    if (isRecord(value) && typeof value.error === 'string') throw new ForgeError('TOOL_FAILED', `浏览器 click 失败: ${value.error}`);
    return limitBrowserValue(redactValue(value));
  }

  /** Fills a non-password input or textarea without reading saved credentials. */
  async fill(ctx: ToolContext, config: BrowserAutomationConfig, selector: string, text: string, approvedUrl?: string): Promise<unknown> {
    const session = this.requireSession(ctx.sessionId);
    this.assertSameConfig(session, config);
    this.touch(session);
    const body = `const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return { error: 'selector not found' }; if (element instanceof HTMLInputElement && element.type.toLowerCase() === 'password') return { error: 'password inputs are blocked' }; if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return { error: 'only input and textarea are supported' }; element.focus(); element.value = ${JSON.stringify(text)}; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return { filled: true };`;
    const value = approvedUrl
      ? await this.evaluateAtApprovedUrl(session, approvedUrl, body)
      : await this.evaluate(session, `(() => { ${body} })()`);
    if (isRecord(value) && typeof value.error === 'string') throw new ForgeError('TOOL_FAILED', `浏览器 fill 失败: ${value.error}`);
    return limitBrowserValue(redactValue(value));
  }

  /** Closes one browser and removes its temporary profile. */
  async close(agentSessionId: string): Promise<void> {
    const session = this.sessions.get(agentSessionId);
    if (!session) return;
    try {
      await session.cdp.request('Browser.close', {}, session.browserSessionId || undefined);
    } catch {
      // Browser may already be gone or no longer accepting CDP commands.
    }
    await this.destroy(session);
  }

  /** Reports whether an Agent currently owns a browser session. */
  hasSession(agentSessionId: string): boolean {
    return this.sessions.has(agentSessionId);
  }

  /** Returns the last observed and allowlist-validated URL for approval previews. */
  getCurrentUrl(agentSessionId: string): string | undefined {
    return this.sessions.get(agentSessionId)?.currentUrl;
  }

  /** Terminates all browsers and removes temporary profiles when the CLI runtime closes. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.destroy(session)));
  }

  private async getOrCreateSession(agentSessionId: string, config: BrowserAutomationConfig, cwd: string): Promise<BrowserSession> {
    const current = this.sessions.get(agentSessionId);
    if (current) {
      this.assertSameConfig(current, config);
      return current;
    }
    const profileDir = await mkdtemp(join(tmpdir(), 'forgex-browser-'));
    const args = [
      ...config.args,
      '--headless=new',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-pipe',
      `--user-data-dir=${profileDir}`,
    ];
    const launch = resolveLaunch(config.command, args);
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd,
        env: browserEnv(process.env),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      await rm(profileDir, { recursive: true, force: true });
      throw new ForgeError('TOOL_FAILED', `无法启动浏览器: ${errorMessage(error)}`, { cause: error });
    }
    const outputPipe = child.stdio[4] as Readable | null;
    const inputPipe = child.stdio[3] as Writable | null;
    if (!inputPipe || !outputPipe) {
      killTree(child);
      await rm(profileDir, { recursive: true, force: true });
      throw new ForgeError('TOOL_FAILED', '浏览器 DevTools pipe 启动失败');
    }
    const allowedHosts = new Set(config.allowedHosts.map(normalizeAllowedHost));
    const cdp = new CdpPipe(inputPipe, outputPipe);
    const session: BrowserSession = {
      agentSessionId,
      config,
      profileDir,
      child,
      cdp,
      browserSessionId: '',
      targetId: '',
      pageSessionId: '',
      targetSessions: new Map(),
      targetWaiters: new Map(),
      allowedHosts,
      closing: false,
    };
    this.sessions.set(agentSessionId, session);
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', () => undefined);
    child.on('error', () => { void this.destroy(session); });
    child.on('close', () => { void this.destroy(session); });
    cdp.onEvent((event) => { void this.handleEvent(session, event); });
    try {
      const browser = await cdp.request('Target.attachToBrowserTarget');
      if (!isRecord(browser) || typeof browser.sessionId !== 'string') throw new ForgeError('TOOL_FAILED', '浏览器未返回 browser target session');
      session.browserSessionId = browser.sessionId;
      await cdp.request('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      }, session.browserSessionId);
      const target = await cdp.request('Target.createTarget', { url: 'about:blank' }, session.browserSessionId);
      if (!isRecord(target) || typeof target.targetId !== 'string') throw new ForgeError('TOOL_FAILED', '浏览器未返回 page target');
      session.targetId = target.targetId;
      session.pageSessionId = await this.waitForTargetPolicy(session, target.targetId, config.timeoutMs);
      await cdp.request('Page.enable', {}, session.pageSessionId);
      await cdp.request('Runtime.enable', {}, session.pageSessionId);
      this.touch(session);
      return session;
    } catch (error) {
      await this.destroy(session);
      throw error;
    }
  }

  private async handleEvent(session: BrowserSession, event: { method: string; params: unknown; sessionId?: string }): Promise<void> {
    if (event.method === 'Page.frameNavigated' && event.sessionId === session.pageSessionId && isRecord(event.params) && isRecord(event.params.frame)) {
      const frame = event.params.frame;
      if (!frame.parentId && typeof frame.url === 'string') {
        try {
          await this.validateObservedUrl(session, frame.url);
          session.mainFrameId = typeof frame.id === 'string' ? frame.id : undefined;
          session.currentUrl = frame.url;
        } catch {
          await this.destroy(session);
        }
      }
      return;
    }
    if (event.method === 'Page.navigatedWithinDocument' && event.sessionId === session.pageSessionId && isRecord(event.params)) {
      const frameId = event.params.frameId;
      const url = event.params.url;
      if (typeof url === 'string' && (!session.mainFrameId || frameId === session.mainFrameId)) {
        try {
          await this.validateObservedUrl(session, url);
          session.currentUrl = url;
        } catch {
          await this.destroy(session);
        }
      }
      return;
    }
    if (event.method === 'Target.attachedToTarget' && isRecord(event.params)) {
      await this.handleAttachedTarget(session, event.params);
      return;
    }
    if (event.method === 'Target.detachedFromTarget' && isRecord(event.params) && typeof event.params.sessionId === 'string') {
      for (const [targetId, targetSessionId] of session.targetSessions) {
        if (targetSessionId === event.params.sessionId) session.targetSessions.delete(targetId);
      }
      return;
    }
    if (event.method === 'Target.targetDestroyed' && isRecord(event.params) && typeof event.params.targetId === 'string') {
      session.targetSessions.delete(event.params.targetId);
      return;
    }
    if (event.method !== 'Fetch.requestPaused' || !isRecord(event.params) || typeof event.params.requestId !== 'string') return;
    const request = isRecord(event.params.request) ? event.params.request : {};
    const url = typeof request.url === 'string' ? request.url : '';
    try {
      await this.validateObservedUrl(session, url);
      await session.cdp.request('Fetch.continueRequest', { requestId: event.params.requestId }, event.sessionId);
    } catch {
      await session.cdp.request('Fetch.failRequest', { requestId: event.params.requestId, errorReason: 'BlockedByClient' }, event.sessionId).catch(() => undefined);
    }
  }

  private async handleAttachedTarget(session: BrowserSession, params: Record<string, unknown>): Promise<void> {
    const targetSessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : {};
    const targetId = typeof targetInfo.targetId === 'string' ? targetInfo.targetId : '';
    const targetType = typeof targetInfo.type === 'string' ? targetInfo.type : '';
    if (!targetSessionId || !targetId || !['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(targetType)) {
      if (targetId) await session.cdp.request('Target.closeTarget', { targetId }, session.browserSessionId).catch(() => undefined);
      if (targetSessionId) await session.cdp.request('Target.detachFromTarget', { sessionId: targetSessionId }, session.browserSessionId).catch(() => undefined);
      return;
    }

    try {
      if (typeof targetInfo.url === 'string') await this.validateObservedUrl(session, targetInfo.url);
      await session.cdp.request('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      }, targetSessionId);
      await session.cdp.request('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, targetSessionId);
      if (params.waitingForDebugger === true) await session.cdp.request('Runtime.runIfWaitingForDebugger', {}, targetSessionId);
      session.targetSessions.set(targetId, targetSessionId);
      const waiter = session.targetWaiters.get(targetId);
      if (waiter) {
        clearTimeout(waiter.timer);
        session.targetWaiters.delete(targetId);
        waiter.resolve(targetSessionId);
      }
    } catch {
      // Auto-attached targets remain paused until the host policy is installed; close on any failure.
      const waiter = session.targetWaiters.get(targetId);
      if (waiter) {
        clearTimeout(waiter.timer);
        session.targetWaiters.delete(targetId);
        waiter.reject(new ForgeError('TOOL_FAILED', `浏览器 target ${targetId} 未能安装网络边界`));
      }
      await session.cdp.request('Target.closeTarget', { targetId }, session.browserSessionId).catch(() => undefined);
      await session.cdp.request('Target.detachFromTarget', { sessionId: targetSessionId }, session.browserSessionId).catch(() => undefined);
    }
  }

  private waitForTargetPolicy(session: BrowserSession, targetId: string, timeoutMs: number): Promise<string> {
    const existing = session.targetSessions.get(targetId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.targetWaiters.delete(targetId);
        reject(new ForgeError('TOOL_TIMEOUT', '浏览器 page target 未能及时安装网络边界', { retryable: true }));
      }, timeoutMs);
      timer.unref?.();
      session.targetWaiters.set(targetId, { resolve, reject, timer });
    });
  }

  private async validateObservedUrl(session: BrowserSession, rawUrl: string): Promise<void> {
    if (rawUrl === 'about:blank' || rawUrl.startsWith('data:')) return;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      throw new ForgeError('TOOL_FAILED', '浏览器请求 URL 无效', { cause: error });
    }
    if (url.protocol === 'blob:') {
      const originUrl = new URL(url.pathname);
      await this.validateObservedUrl(session, originUrl.href);
      return;
    }
    if (url.username || url.password) throw new ForgeError('TOOL_FAILED', '浏览器 URL 不允许包含 credential');
    const host = url.host.toLowerCase();
    const loopbackHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname);
    if (url.protocol !== 'https:' && !loopbackHttp) throw new ForgeError('TOOL_FAILED', '浏览器只允许 HTTPS（本机 loopback 可用 HTTP）');
    if (!session.allowedHosts.has(host)) throw new ForgeError('TOOL_FAILED', `浏览器目标未列入 allowlist: ${host}`);
  }

  private async evaluate(session: BrowserSession, expression: string): Promise<Record<string, unknown>> {
    const response = await session.cdp.request('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, session.pageSessionId);
    if (!isRecord(response)) throw new ForgeError('TOOL_FAILED', '浏览器未返回脚本执行结果');
    if (isRecord(response.exceptionDetails)) {
      const exception = isRecord(response.exceptionDetails.exception) ? response.exceptionDetails.exception : {};
      throw new ForgeError('TOOL_FAILED', `浏览器页面读取失败: ${redactText(String(exception.description ?? 'JavaScript exception'))}`);
    }
    const result = isRecord(response.result) ? response.result : {};
    const value = result.value;
    return isRecord(value) ? value : { value: value ?? null };
  }

  /** Checks the approved URL and performs the page action in one JavaScript turn. */
  private async evaluateAtApprovedUrl(session: BrowserSession, approvedUrl: string, body: string): Promise<Record<string, unknown>> {
    const expression = `(() => { const currentUrl = location.href; if (currentUrl !== ${JSON.stringify(approvedUrl)}) return { error: 'approval page changed', currentUrl }; ${body} })()`;
    const value = await this.evaluate(session, expression);
    if (value.error === 'approval page changed') {
      const currentUrl = typeof value.currentUrl === 'string' ? value.currentUrl : '';
      try {
        await this.validateObservedUrl(session, currentUrl);
        session.currentUrl = currentUrl;
      } catch {
        await this.destroy(session);
      }
      throw new ForgeError('TOOL_FAILED', '审批期间浏览器页面 URL 已变化，操作未执行；请重新读取并审批');
    }
    return value;
  }

  private requireSession(agentSessionId: string): BrowserSession {
    const session = this.sessions.get(agentSessionId);
    if (!session || session.closing) throw new ForgeError('TOOL_FAILED', '浏览器会话不存在或已结束，请先 navigate');
    return session;
  }

  private assertSameConfig(session: BrowserSession, config: BrowserAutomationConfig): void {
    if (session.config.command !== config.command || session.config.args.join('\0') !== config.args.join('\0') || session.config.allowedHosts.join('\0') !== config.allowedHosts.join('\0')) {
      throw new ForgeError('TOOL_FAILED', '浏览器会话配置已变化，请先 close 后重新打开');
    }
  }

  private touch(session: BrowserSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => { void this.destroy(session); }, SESSION_IDLE_MS);
    session.idleTimer.unref?.();
  }

  private async destroy(session: BrowserSession): Promise<void> {
    if (session.cleanup) return session.cleanup;
    session.closing = true;
    session.cleanup = (async () => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      if (this.sessions.get(session.agentSessionId) === session) this.sessions.delete(session.agentSessionId);
      for (const waiter of session.targetWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new ForgeError('ABORTED', '浏览器会话已结束'));
      }
      session.targetWaiters.clear();
      if (session.child.exitCode === null && session.child.signalCode === null) killTree(session.child);
      await Promise.race([waitForClose(session.child), delay(1_000)]);
      await rm(session.profileDir, { recursive: true, force: true }).catch(() => undefined);
    })();
    await session.cleanup;
  }
}

class CdpPipe {
  private readonly pending = new Map<number, CdpPending>();
  private readonly eventHandlers = new Set<(event: { method: string; params: unknown; sessionId?: string }) => void>();
  private readonly eventWaiters = new Map<string, CdpEventWaiter[]>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;

  constructor(private readonly input: Writable, output: Readable) {
    output.on('data', (chunk: Buffer) => this.onData(chunk));
    output.on('error', (error) => this.failAll(error));
    output.on('close', () => this.failAll(new ForgeError('TOOL_FAILED', '浏览器 DevTools pipe 已关闭')));
    input.on('error', (error) => this.failAll(error));
  }

  request(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ForgeError('TOOL_TIMEOUT', `浏览器 DevTools ${method} 请求超时`, { retryable: true }));
      }, CDP_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.input.write(Buffer.concat([Buffer.from(JSON.stringify(message), 'utf8'), Buffer.from([0])]));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent(handler: (event: { method: string; params: unknown; sessionId?: string }) => void): void {
    this.eventHandlers.add(handler);
  }

  waitForEvent(method: string, sessionId?: string, timeoutMs = CDP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const key = `${sessionId ?? ''}\0${method}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.eventWaiters.get(key) ?? [];
        this.eventWaiters.set(key, waiters.filter((waiter) => waiter.resolve !== resolve));
        reject(new ForgeError('TOOL_TIMEOUT', `浏览器事件 ${method} 超时`, { retryable: true }));
      }, timeoutMs);
      timer.unref?.();
      const waiters = this.eventWaiters.get(key) ?? [];
      waiters.push({ ...(sessionId ? { sessionId } : {}), resolve, reject, timer });
      this.eventWaiters.set(key, waiters);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_CDP_MESSAGE_BYTES + 8) {
      this.failAll(new ForgeError('TOOL_FAILED', '浏览器 DevTools 消息超过大小上限'));
      this.buffer = Buffer.alloc(0);
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf(0);
      if (end < 0) return;
      const text = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(text) as unknown;
      } catch (error) {
        this.failAll(new ForgeError('TOOL_FAILED', '浏览器 DevTools 返回了无效 JSON', { cause: error }));
        return;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(value: unknown): void {
    if (!isRecord(value)) return;
    if (typeof value.id === 'number') {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (isRecord(value.error)) pending.reject(new ForgeError('TOOL_FAILED', `浏览器 DevTools 请求失败: ${redactText(String(value.error.message ?? 'unknown error'))}`));
      else pending.resolve(value.result ?? null);
      return;
    }
    if (typeof value.method !== 'string') return;
    const event = { method: value.method, params: value.params ?? null, ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}) };
    const key = `${event.sessionId ?? ''}\0${event.method}`;
    const waiters = this.eventWaiters.get(key) ?? [];
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(event.params);
      this.eventWaiters.set(key, waiters);
    }
    for (const handler of this.eventHandlers) handler(event);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const [key, waiters] of this.eventWaiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.eventWaiters.delete(key);
    }
  }
}

function validateBrowserUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new ForgeError('TOOL_FAILED', '浏览器 URL 无效', { cause: error });
  }
  if (url.username || url.password) throw new ForgeError('TOOL_FAILED', 'browser URL 不允许包含 credential');
  const loopbackHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) throw new ForgeError('TOOL_FAILED', '浏览器只允许 HTTPS（本机 loopback 可用 HTTP）');
  const hosts = new Set(allowedHosts.map(normalizeAllowedHost));
  if (!hosts.has(url.host.toLowerCase())) throw new ForgeError('TOOL_FAILED', `浏览器目标未列入 allowlist: ${url.host}`);
  return url;
}

function normalizeAllowedHost(value: string): string {
  if (value.includes('*') || value.includes('/') || value.includes('@')) throw new ForgeError('CONFIG_INVALID', `浏览器 allowlist 必须是精确主机名: ${value}`);
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch (error) {
    throw new ForgeError('CONFIG_INVALID', `浏览器 allowlist 主机名无效: ${value}`, { cause: error });
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname) {
    throw new ForgeError('CONFIG_INVALID', `浏览器 allowlist 必须是精确主机名: ${value}`);
  }
  return url.host.toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function browserEnv(envSource: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'Path', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME']);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(envSource)) {
    if (value !== undefined && allowed.has(process.platform === 'win32' ? name.toUpperCase() : name)) env[name] = value;
  }
  return env;
}

function limitBrowserValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[key] = typeof item === 'string' ? redactText(item.slice(0, MAX_PAGE_TEXT_CHARS)) : item;
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
