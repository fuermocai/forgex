/**
 * AgentLoop：单 Agent 的推理循环。
 *
 * 一轮 turn 的固定流程：
 *   用户消息 -> 构建上下文 -> 模型请求（流式） -> 若含 tool_calls 则统一调度执行
 *   -> 回填 tool 消息 -> 再次请求 -> ... -> 无 tool_calls 时结束。
 *
 * 关键保证：
 *  - 每个 assistant.tool_calls[].id 都会得到一条 tool 消息（成功/失败/取消/超时/循环中止）；
 *  - 请求前做一次协议自检与本地修复，避免把非法序列发给服务端；
 *  - 重复调用检测用于阻止模型陷入"相同工具相同参数"的死循环；
 *  - 取消与模型异常都通过"return 结果"表达，不抛异常给上层。
 */
import {
  describeError,
  estimateMessagesTokens,
  isAbortError,
  stringifyJson,
  ForgeError,
  type ChatMessage,
  type JsonValue,
  type Logger,
  type ToolCall,
  type ToolErrorInfo,
  type ToolResult,
  type TurnEndReason,
} from '@forgex/shared';
import type { ModelProvider } from '@forgex/models';
import type { ToolRegistry } from '@forgex/tools';
import type { ContextManager } from '../context/context-manager.js';
import type { EventBus } from '../events/event-bus.js';
import type { MetricsCollector } from '../runtime/metrics.js';
import type { ToolDispatcher } from '../runtime/tool-dispatcher.js';

export interface AgentLoopOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  context: ContextManager;
  events: EventBus;
  sessionId: string;
  /** 单轮最大迭代次数（模型请求次数），默认 12 */
  maxIterations?: number;
  /** 连续相同工具调用的次数阈值，达到即判定循环，默认 3 */
  repeatThreshold?: number;
  logger?: Logger;
  /** 每条新消息的持久化回调（Agent 注入 SessionStore） */
  persistMessage?: (message: ChatMessage) => void;
  /** 子代理预算钩子：每次模型请求前调用 */
  onModelRequest?: (iteration: number) => void;
  /** 子代理预算钩子：模型用量返回后调用 */
  onModelUsage?: (totalTokens: number) => void;
  /** 可在工具执行前拒绝整批调用，避免越过子代理工具预算 */
  beforeToolCalls?: (count: number) => boolean;
}

export interface LoopRunOptions {
  signal: AbortSignal;
  metrics: MetricsCollector;
}

export interface LoopResult {
  /** 本轮最终可展示给用户的文本 */
  text: string;
  reason: TurnEndReason;
  /** 实际模型请求次数 */
  iterations: number;
  /** 本轮执行的工具调用总数 */
  toolCalls: number;
  /** 已执行工具的结构化结果，供计划验证和子代理汇总使用 */
  toolResults?: Array<{ toolName: string; result: ToolResult }>;
  error?: ToolErrorInfo;
}

const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_REPEAT_THRESHOLD = 3;

export class AgentLoop {
  private provider: ModelProvider;
  private readonly registry: ToolRegistry;
  private readonly dispatcher: ToolDispatcher;
  private readonly context: ContextManager;
  private readonly events: EventBus;
  private readonly sessionId: string;
  private readonly maxIterations: number;
  private readonly repeatThreshold: number;
  private readonly logger: Logger | undefined;
  private readonly persistMessage: ((message: ChatMessage) => void) | undefined;
  private readonly onModelRequest: ((iteration: number) => void) | undefined;
  private readonly onModelUsage: ((totalTokens: number) => void) | undefined;
  private readonly beforeToolCalls: ((count: number) => boolean) | undefined;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.dispatcher = options.dispatcher;
    this.context = options.context;
    this.events = options.events;
    this.sessionId = options.sessionId;
    this.maxIterations = Math.max(1, options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    this.repeatThreshold = Math.max(2, options.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD);
    this.logger = options.logger;
    this.persistMessage = options.persistMessage;
    this.onModelRequest = options.onModelRequest;
    this.onModelUsage = options.onModelUsage;
    this.beforeToolCalls = options.beforeToolCalls;
  }

  /** 运行时切换模型（Provider 实例整体替换，下一轮请求生效） */
  setProvider(provider: ModelProvider): void {
    this.provider = provider;
  }

  async run(userText: string, options: LoopRunOptions): Promise<LoopResult> {
    const { signal, metrics } = options;

    // 1. 记录用户消息
    this.append([{ role: 'user', content: userText }]);
    this.events.emit({ type: 'user:message', text: userText, ts: Date.now() });

    // 注册表的 parameters 是 Record<string, unknown>（由 zodToJsonSchema 生成），
    // 运行时就是合法 JSON，这里收敛为 JsonValue 供模型层使用。
    const toolSpecs = this.registry.specs().map((spec) => ({
      type: 'function' as const,
      function: {
        name: spec.function.name,
        description: spec.function.description,
        parameters: spec.function.parameters as unknown as JsonValue,
      },
    }));
    const signatures: string[] = [];
    let lastText = '';
    let iterations = 0;
    let totalToolCalls = 0;
    const allToolResults: Array<{ toolName: string; result: ToolResult }> = [];

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      iterations = iteration;

      if (signal.aborted) {
        return { text: lastText, reason: 'aborted', iterations: iteration - 1, toolCalls: totalToolCalls, toolResults: allToolResults };
      }
      this.onModelRequest?.(iteration);
      if (signal.aborted) {
        return { text: lastText, reason: 'aborted', iterations: iteration - 1, toolCalls: totalToolCalls, toolResults: allToolResults };
      }

      // 2. 构建上下文（必要时压缩）并做协议修复
      const built = this.context.build();
      if (built.compressed) {
        this.events.emit({
          type: 'notice',
          level: 'info',
          message: `上下文已压缩：移除 ${built.dropped} 条旧消息，估算 ${built.estimatedTokens} tokens`,
          ts: Date.now(),
        });
      }
      const repaired = repairProtocol(built.messages);
      if (repaired.changed) {
        this.logger?.warn('上下文协议不合法，已本地修复', { repaired: repaired.repaired, dropped: repaired.dropped });
        this.events.emit({
          type: 'notice',
          level: 'warn',
          message: '检测到历史消息协议不完整，已自动补齐/清理',
          ts: Date.now(),
        });
        this.context.replace(repaired.messages.filter((message) => message.role !== 'system'));
      }
      const requestMessages = repaired.messages;

      this.events.emit({
        type: 'model:request',
        attempt: 1,
        messageCount: requestMessages.length,
        estimatedTokens: estimateMessagesTokens(requestMessages),
        ts: Date.now(),
      });

      // 3. 请求模型
      const requestStarted = Date.now();
      let firstTokenAt: number | null = null;
      let response;
      try {
        response = await this.provider.chat(
          { messages: requestMessages, tools: toolSpecs, signal },
          {
            onDelta: (text) => {
              this.events.emit({ type: 'assistant:delta', text, ts: Date.now() });
            },
            onFirstToken: () => {
              firstTokenAt ??= Date.now();
            },
          },
        );
      } catch (err) {
        const error = toToolErrorInfo(err);
        const aborted = signal.aborted || isAbortError(err);
        this.events.emit({
          type: 'notice',
          level: aborted ? 'info' : 'error',
          message: aborted ? '模型请求已取消' : `模型请求失败: ${describeError(err)}`,
          ts: Date.now(),
        });
        return {
          text: lastText,
          reason: aborted ? 'aborted' : 'error',
          iterations,
          toolCalls: totalToolCalls,
          toolResults: allToolResults,
          error,
        };
      }

      const responseMs = Date.now() - requestStarted;
      metrics.recordModelCall({
        durationMs: responseMs,
        firstTokenMs: firstTokenAt === null ? null : firstTokenAt - requestStarted,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      });
      this.onModelUsage?.(response.usage.totalTokens);

      const content = response.message.content ?? '';
      if (content.length > 0) lastText = content;
      const toolCalls = response.message.tool_calls ?? [];

      // 4. 记录 assistant 消息（无论是否含工具调用都要入历史，保证下一轮上下文完整）
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: content.length > 0 ? content : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      this.append([assistantMessage]);
      this.events.emit({ type: 'assistant:message', text: content, toolCalls, ts: Date.now() });

      // 预算或用户取消可能在模型请求期间触发。为模型已发出的调用补齐协议，
      // 但不要在预算超限后继续执行工具。
      if (signal.aborted) {
        if (toolCalls.length > 0) {
          const skipped = synthesizeResults(toolCalls, 'ABORTED', '模型请求期间任务被取消或预算耗尽');
          this.appendToolMessages(toolCalls, skipped);
          allToolResults.push(...toolCalls.map((call, index) => ({ toolName: call.function.name, result: skipped[index]! })));
        }
        return { text: content || lastText, reason: 'aborted', iterations, toolCalls: totalToolCalls, toolResults: allToolResults };
      }

      if (response.finishReason === 'length') {
        this.events.emit({
          type: 'notice',
          level: 'warn',
          message: '模型输出达到长度上限，内容可能被截断',
          ts: Date.now(),
        });
        if (toolCalls.length > 0) {
          // 被截断的参数可能不是完整 JSON，也不能因为部分调用看起来有效就产生副作用。
          const skipped = synthesizeResults(toolCalls, 'OUTPUT_TRUNCATED', '模型输出达到长度上限，工具调用未执行');
          this.appendToolMessages(toolCalls, skipped);
          allToolResults.push(...toolCalls.map((call, index) => ({ toolName: call.function.name, result: skipped[index]! })));
          return { text: content || lastText, reason: 'output_truncated', iterations, toolCalls: totalToolCalls, toolResults: allToolResults };
        }
      }

      if (response.finishReason === 'content_filter') {
        if (toolCalls.length > 0) {
          const skipped = synthesizeResults(toolCalls, 'CONTENT_FILTERED', '模型响应被内容策略拦截，工具调用未执行');
          this.appendToolMessages(toolCalls, skipped);
          allToolResults.push(...toolCalls.map((call, index) => ({ toolName: call.function.name, result: skipped[index]! })));
        }
        return { text: content || lastText, reason: 'content_filtered', iterations, toolCalls: totalToolCalls, toolResults: allToolResults };
      }

      // 5. 无工具调用：本轮结束
      if (toolCalls.length === 0) {
        const truncated = response.finishReason === 'length';
        if (!truncated && response.finishReason !== 'stop') {
          const error = toToolErrorInfo(new ForgeError('PROVIDER_ERROR', `模型返回了未知结束原因: ${response.finishReason}`));
          return { text: content || lastText, reason: 'error', iterations, toolCalls: totalToolCalls, toolResults: allToolResults, error };
        }
        return {
          text: content,
          reason: truncated ? 'output_truncated' : 'completed',
          iterations,
          toolCalls: totalToolCalls,
          toolResults: allToolResults,
        };
      }

      if (response.finishReason !== 'tool_calls' && response.finishReason !== 'stop') {
        const skipped = synthesizeResults(toolCalls, 'INVALID_FINISH_REASON', `工具调用响应的结束原因无效: ${response.finishReason}`);
        this.appendToolMessages(toolCalls, skipped);
        allToolResults.push(...toolCalls.map((call, index) => ({ toolName: call.function.name, result: skipped[index]! })));
        const error = toToolErrorInfo(new ForgeError('PROVIDER_ERROR', `工具调用响应的结束原因无效: ${response.finishReason}`));
        return { text: content || lastText, reason: 'error', iterations, toolCalls: totalToolCalls, toolResults: allToolResults, error };
      }

      // 6. 重复调用检测：连续 repeatThreshold 次完全相同的调用集合
      signatures.push(toolCalls.map(callSignature).join('|'));
      if (signatures.length > this.repeatThreshold) signatures.shift();
      if (
        signatures.length >= this.repeatThreshold &&
        signatures.every((signature) => signature === signatures[0])
      ) {
        this.logger?.warn('检测到重复工具调用，终止本轮', { tool: toolCalls[0]?.function.name });
        this.events.emit({
          type: 'notice',
          level: 'warn',
          message: `连续 ${this.repeatThreshold} 次相同的工具调用，已终止以避免死循环`,
          ts: Date.now(),
        });
        const skipped = synthesizeResults(toolCalls, 'LOOP_DETECTED', '检测到重复工具调用，已中止执行');
        this.appendToolMessages(toolCalls, skipped);
        allToolResults.push(...toolCalls.map((call, index) => ({ toolName: call.function.name, result: skipped[index]! })));
        totalToolCalls += toolCalls.length;
        return { text: lastText, reason: 'loop_detected', iterations, toolCalls: totalToolCalls, toolResults: allToolResults };
      }

      if (this.beforeToolCalls && !this.beforeToolCalls(toolCalls.length)) {
        const skipped = synthesizeResults(toolCalls, 'SUBAGENT_BUDGET_EXCEEDED', '工具调用预算不足，未执行');
        this.appendToolMessages(toolCalls, skipped);
        allToolResults.push(...toolCalls.map((call, index) => ({ toolName: call.function.name, result: skipped[index]! })));
        return { text: lastText, reason: 'aborted', iterations, toolCalls: totalToolCalls, toolResults: allToolResults };
      }

      // 7. 统一调度执行（并发、语义校验、策略、审批、审计都在 Dispatcher 内）
      const results = await this.dispatcher.executeMany(toolCalls, { sessionId: this.sessionId, signal });
      for (const result of results) metrics.recordTool(result);
      allToolResults.push(...toolCalls.map((call, index) => ({ toolName: call.function.name, result: results[index]! })));
      this.appendToolMessages(toolCalls, results);
      totalToolCalls += toolCalls.length;

      if (signal.aborted) {
        return { text: lastText, reason: 'aborted', iterations, toolCalls: totalToolCalls, toolResults: allToolResults };
      }
    }

    // 达到最大迭代次数：本轮已把最后一次工具结果补齐，协议保持合法
    this.events.emit({
      type: 'notice',
      level: 'warn',
      message: `已达到最大迭代次数 ${this.maxIterations}，本轮结束`,
      ts: Date.now(),
    });
    return { text: lastText, reason: 'max_iterations', iterations, toolCalls: totalToolCalls, toolResults: allToolResults };
  }

  /** 追加消息并持久化 */
  private append(messages: ChatMessage[]): void {
    for (const message of messages) {
      this.context.append(message);
      this.persistMessage?.(message);
    }
  }

  /** 为每个 tool_call 生成严格配对、顺序一致的 tool 消息 */
  private appendToolMessages(calls: ReadonlyArray<ToolCall>, results: ReadonlyArray<ToolResult>): void {
    const messages: ChatMessage[] = calls.map((call, index) => {
      const result = results[index];
      const content = result
        ? toolResultContent(result)
        : toolResultContent({
            ok: false,
            summary: '工具结果缺失，已由本地补全',
            error: { code: 'TOOL_RESULT_MISSING', message: '调度器未返回结果' },
            truncated: false,
            durationMs: 0,
            bytes: 0,
            auditId: '',
          });
      return {
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content,
      };
    });
    this.append(messages);
  }
}

/* ------------------------------------------------------------------ */
/* 协议修复                                                            */
/* ------------------------------------------------------------------ */

export interface RepairResult {
  messages: ChatMessage[];
  changed: boolean;
  repaired: number;
  dropped: number;
}

/**
 * 本地协议修复：
 *  - 丢弃没有对应 tool_call 的 tool 消息（恢复会话时可能出现）；
 *  - 为缺失结果的 tool_call 补一条说明性 tool 消息；
 *  - 丢弃空 id / 重复 id 的 tool_call。
 *
 * 该函数只处理"已存在序列"的合法性，不改变正常流程产生的消息。
 */
export function repairProtocol(messages: ReadonlyArray<ChatMessage>): RepairResult {
  const out: ChatMessage[] = [];
  let pending = new Map<string, ToolCall>();
  let changed = false;
  let repaired = 0;
  let dropped = 0;

  const flush = (): void => {
    for (const [id, call] of pending) {
      out.push({
        role: 'tool',
        tool_call_id: id,
        name: call.function.name,
        content: stringifyJson({
          ok: false,
          summary: '历史记录缺少该工具的执行结果，已本地补全',
          error: { code: 'TOOL_RESULT_MISSING', message: '会话恢复时发现未配对的 tool_call' },
        }),
      });
      repaired += 1;
      changed = true;
    }
    pending.clear();
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.has(message.tool_call_id)) {
        dropped += 1;
        changed = true;
        continue;
      }
      pending.delete(message.tool_call_id);
      out.push(message);
      continue;
    }

    flush();

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const seen = new Set<string>();
      const calls: ToolCall[] = [];
      for (const call of message.tool_calls) {
        if (!call.id || seen.has(call.id)) {
          dropped += 1;
          changed = true;
          continue;
        }
        seen.add(call.id);
        calls.push(call);
      }
      if (calls.length === 0) {
        out.push({ role: 'assistant', content: message.content ?? '' });
        continue;
      }
      out.push({ ...message, tool_calls: calls });
      for (const call of calls) pending.set(call.id, call);
      continue;
    }

    out.push(message);
  }

  flush();
  return { messages: out, changed, repaired, dropped };
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                            */
/* ------------------------------------------------------------------ */

/** tool 消息内容：给模型看的结构化 JSON（体积已由 Dispatcher 限制） */
function toolResultContent(result: ToolResult): string {
  const payload: Record<string, JsonValue> = {
    ok: result.ok,
    summary: result.summary,
  };
  if (result.ok && result.data !== undefined) payload.data = result.data;
  if (!result.ok && result.error) payload.error = result.error as unknown as JsonValue;
  if (result.truncated) payload.truncated = true;
  return stringifyJson(payload);
}

/** 为未执行的调用合成失败结果（循环中止时使用） */
function synthesizeResults(
  calls: ReadonlyArray<ToolCall>,
  code: string,
  message: string,
): ToolResult[] {
  return calls.map((call) => ({
    ok: false,
    summary: `${call.function.name} 未执行：${message}`,
    error: { code, message },
    truncated: false,
    durationMs: 0,
    bytes: 0,
    auditId: '',
  }));
}

/** 工具调用的稳定签名（参数按键排序，避免仅键序不同被误判为新调用） */
function callSignature(call: ToolCall): string {
  return `${call.function.name}:${stableStringify(safeParse(call.function.arguments))}`;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function toToolErrorInfo(err: unknown): ToolErrorInfo {
  if (err instanceof ForgeError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof Error) {
    return { code: 'PROVIDER_ERROR', message: err.message };
  }
  return { code: 'INTERNAL', message: String(err) };
}
