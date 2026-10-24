/**
 * OpenAI-compatible Chat Completions Provider。
 *
 * 支持：OpenAI、DeepSeek、Qwen(DashScope compatible-mode)、vLLM、Ollama(/v1)、
 *      企业内网网关等任何兼容实现。
 *
 * 设计要点：
 *  - 只依赖全局 fetch，不引入 HTTP SDK，减少依赖与供应链风险；
 *  - 流式 SSE 分片解析 + tool_calls 按 index 累积拼接（易错点，单测覆盖）；
 *  - 统一超时 / 重试 / 取消：使用 AbortSignal.any 合并用户取消与超时；
 *  - 一旦已向 UI 输出增量，就禁止自动重试（否则会出现重复文本）；
 *  - API Key 仅出现在请求头，绝不进入日志、错误 details 或会话。
 */
import {
  ForgeError,
  estimateTokens,
  toolCallId,
  type ChatMessage,
  type Logger,
  type ToolCall,
} from '@forgex/shared';
import type {
  ChatRequest,
  ChatResponse,
  ModelConfig,
  ModelProvider,
  StreamHandlers,
  TokenUsage,
} from './types.js';

export interface OpenAICompatibleOptions {
  config: ModelConfig;
  logger?: Logger;
  /** 测试注入点；生产使用全局 fetch */
  fetchImpl?: typeof fetch;
}

interface AccumulatedToolCall {
  id?: string;
  name?: string;
  args: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY = 2000;

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly config: Readonly<ModelConfig>;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: OpenAICompatibleOptions) {
    const cfg = options.config;
    if (!cfg.baseUrl || !/^https?:\/\//i.test(cfg.baseUrl)) {
      throw new ForgeError('CONFIG_INVALID', `模型 baseUrl 无效: ${cfg.baseUrl || '(空)'}`);
    }
    if (!cfg.model) {
      throw new ForgeError('CONFIG_INVALID', '模型名称不能为空');
    }
    if (!Number.isFinite(cfg.contextWindow) || cfg.contextWindow < 512) {
      throw new ForgeError('CONFIG_INVALID', 'contextWindow 必须 >= 512');
    }
    this.config = {
      ...cfg,
      temperature: cfg.temperature ?? 0.2,
      timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: Math.max(0, cfg.maxRetries ?? 1),
      stream: cfg.stream ?? true,
      maxOutputTokens: cfg.maxOutputTokens ?? 2048,
      name: cfg.name ?? 'openai-compatible',
    };
    this.name = this.config.name ?? 'openai-compatible';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
  }

  async chat(request: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResponse> {
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new ForgeError('CONFIG_INVALID', '请求 messages 不能为空');
    }
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= this.config.maxRetries) {
      try {
        return await this.requestOnce(request, handlers);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof ForgeError && err.retryable;
        const aborted = request.signal?.aborted === true;
        if (!retryable || aborted || attempt >= this.config.maxRetries) throw err;
        attempt += 1;
        const delay = Math.min(4000, 300 * 2 ** attempt) + Math.floor(Math.random() * 200);
        this.logger?.warn('模型请求失败，准备重试', {
          attempt,
          delayMs: delay,
          error: err instanceof ForgeError ? err.code : String(err),
        });
        await sleep(delay, request.signal);
      }
    }
    throw lastError;
  }

  private async requestOnce(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResponse> {
    const stream = this.config.stream;
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, this.config.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutController.signal])
      : timeoutController.signal;

    let emittedAny = false;

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        ...(this.config.headers ?? {}),
      };
      if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.buildBody(request, stream)),
        signal,
      }).catch((err: unknown) => {
        if (request.signal?.aborted) {
          throw new ForgeError('PROVIDER_ABORTED', '请求已被用户取消', { cause: err });
        }
        if (timedOut) {
          throw new ForgeError('PROVIDER_TIMEOUT', `模型请求超时（${this.config.timeoutMs}ms）`, {
            retryable: true,
            cause: err,
          });
        }
        throw new ForgeError('PROVIDER_ERROR', `无法连接模型服务: ${errorMessage(err)}`, {
          retryable: true,
          cause: err,
        });
      });

      if (!response.ok) {
        throw await this.httpError(response);
      }

      if (!stream) {
        const json = (await response.json()) as Record<string, unknown>;
        return this.parseCompletion(json);
      }

      // 部分企业网关会忽略 stream=true，直接返回普通 JSON；
      // 此时按非流式解析，避免把完整 JSON 当成 SSE 导致空回答。
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        const json = (await response.json()) as Record<string, unknown>;
        return this.parseCompletion(json);
      }

      const { content, toolCalls, finishReason, usage } = await this.consumeStream(response, () => {
        if (!emittedAny) {
          emittedAny = true;
          handlers.onFirstToken?.();
        }
      }, handlers);
      return {
        message: {
          role: 'assistant',
          content: content.length > 0 ? content : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finishReason,
        usage: usage ?? fallbackUsage(request.messages, content, toolCalls),
        streamed: true,
      };
    } catch (err) {
      if (err instanceof ForgeError) {
        // 已产生增量时禁止重试，避免客户端出现重复内容
        if (emittedAny && err.retryable) {
          throw new ForgeError(err.code, err.message, {
            retryable: false,
            details: { ...(err.details ?? {}), partialStream: true },
          });
        }
        throw err;
      }
      if (request.signal?.aborted) {
        throw new ForgeError('PROVIDER_ABORTED', '请求已被用户取消', { cause: err });
      }
      if (timedOut) {
        throw new ForgeError('PROVIDER_TIMEOUT', `模型请求超时（${this.config.timeoutMs}ms）`, {
          retryable: !emittedAny,
          cause: err,
        });
      }
      throw new ForgeError('PROVIDER_ERROR', `模型请求失败: ${errorMessage(err)}`, {
        retryable: !emittedAny,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages.map(toWireMessage),
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
      stream,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  private async httpError(response: Response): Promise<ForgeError> {
    const text = await response.text().catch(() => '');
    const body = text.slice(0, MAX_ERROR_BODY);
    const status = response.status;
    const retryable = status === 429 || status >= 500;
    const code =
      status === 429 ? 'PROVIDER_RATE_LIMIT' : status === 401 || status === 403 ? 'PROVIDER_ERROR' : 'PROVIDER_ERROR';
    const hint =
      status === 401 || status === 403
        ? '（模型服务认证失败，请检查 API Key 或网关授权）'
        : status === 404
          ? '（请检查 baseUrl 是否包含正确路径，如 /v1）'
          : '';
    return new ForgeError(code, `模型服务返回 HTTP ${status}${hint}: ${body}`, {
      retryable,
      details: { status },
    });
  }

  /** 解析非流式响应 */
  private parseCompletion(json: Record<string, unknown>): ChatResponse {
    const choices = json.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ForgeError('PROVIDER_ERROR', `模型响应缺少 choices: ${JSON.stringify(json).slice(0, 500)}`, {
        retryable: true,
      });
    }
    const choice = choices[0] as Record<string, unknown>;
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCalls = normalizeToolCalls(message.tool_calls);
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop';
    const usage = normalizeUsage(json.usage);
    return {
      message: {
        role: 'assistant',
        content: content.length > 0 ? content : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finishReason,
      usage: usage ?? fallbackUsage([], content, toolCalls),
      streamed: false,
    };
  }

  /** 消费 SSE 流并把增量回传给调用方 */
  private async consumeStream(
    response: Response,
    onFirstToken: () => void,
    handlers: StreamHandlers,
  ): Promise<{ content: string; toolCalls: ToolCall[]; finishReason: string; usage?: TokenUsage }> {
    if (!response.body) {
      throw new ForgeError('PROVIDER_ERROR', '模型服务返回了空流式响应体', { retryable: true });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let finishReason = 'stop';
    let usage: TokenUsage | undefined;
    const accs = new Map<number, AccumulatedToolCall>();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          const line = rawLine.trim();
          if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            continue;
          }
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            // 个别网关会发送心跳 JSON 片段，忽略解析失败的行而不是中断整个流
            continue;
          }
          if (chunk.usage) usage = normalizeUsage(chunk.usage) ?? usage;
          const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
          const first = choices[0] as Record<string, unknown> | undefined;
          if (!first) continue;
          if (typeof first.finish_reason === 'string') finishReason = first.finish_reason;
          const delta = (first.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            onFirstToken();
            content += delta.content;
            handlers.onDelta?.(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            onFirstToken();
            mergeToolCallDeltas(accs, delta.tool_calls);
          }
        }
      }
      // 处理最后一行没有换行符的情况
      if (buffer.trim().startsWith('data:')) {
        const payload = buffer.trim().slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try {
            const chunk = JSON.parse(payload) as Record<string, unknown>;
            if (chunk.usage) usage = normalizeUsage(chunk.usage) ?? usage;
          } catch {
            /* 同上，忽略 */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { content, toolCalls: flushToolCalls(accs), finishReason, usage };
  }
}

/* ------------------------------------------------------------------ */
/* 纯函数辅助（便于单测）                                              */
/* ------------------------------------------------------------------ */

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
    base.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
  }
  if (message.role === 'tool') {
    base.tool_call_id = message.tool_call_id;
    if (message.name) base.name = message.name;
  }
  return base;
}

function normalizeToolCalls(input: unknown): ToolCall[] {
  if (!Array.isArray(input)) return [];
  const out: ToolCall[] = [];
  input.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const rec = item as Record<string, unknown>;
    const fn = (rec.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (!name) return;
    const args =
      typeof fn.arguments === 'string'
        ? fn.arguments
        : fn.arguments === undefined || fn.arguments === null
          ? '{}'
          : JSON.stringify(fn.arguments);
    out.push({
      id: typeof rec.id === 'string' && rec.id ? rec.id : toolCallId(),
      type: 'function',
      function: { name, arguments: args },
    });
    void index;
  });
  return out;
}

/** 合并流式 tool_calls 分片 */
export function mergeToolCallDeltas(
  accs: Map<number, AccumulatedToolCall>,
  deltas: unknown[],
): void {
  deltas.forEach((raw, position) => {
    if (!raw || typeof raw !== 'object') return;
    const delta = raw as Record<string, unknown>;
    const index = typeof delta.index === 'number' ? delta.index : position;
    const acc = accs.get(index) ?? { args: '' };
    if (typeof delta.id === 'string' && delta.id) acc.id = delta.id;
    const fn = (delta.function ?? {}) as Record<string, unknown>;
    if (typeof fn.name === 'string' && fn.name) acc.name = fn.name;
    if (typeof fn.arguments === 'string' && fn.arguments) acc.args += fn.arguments;
    accs.set(index, acc);
  });
}

/** 把累积的 tool_calls 转为协议消息；缺少 id 时兜底生成 */
export function flushToolCalls(accs: Map<number, AccumulatedToolCall>): ToolCall[] {
  return [...accs.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, acc]) => Boolean(acc.name))
    .map(([, acc]) => ({
      id: acc.id ?? toolCallId(),
      type: 'function' as const,
      function: { name: acc.name as string, arguments: acc.args.trim() || '{}' },
    }));
}

function normalizeUsage(input: unknown): TokenUsage | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const usage = input as Record<string, unknown>;
  const promptTokens = num(usage.prompt_tokens);
  const completionTokens = num(usage.completion_tokens);
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: num(usage.total_tokens) ?? (promptTokens ?? 0) + (completionTokens ?? 0),
  };
}

function fallbackUsage(messages: ChatMessage[], content: string, calls: ToolCall[]): TokenUsage {
  const promptTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
  const completionTokens =
    estimateTokens(content) + calls.reduce((sum, c) => sum + estimateTokens(c.function.arguments), 0);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
  }
  return String(err);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ForgeError('ABORTED', '已取消'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new ForgeError('ABORTED', '已取消'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}