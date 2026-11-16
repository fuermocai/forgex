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
import type { ChatResponse, ModelProvider } from '@forgex/models';
import type { ToolRegistry } from '@forgex/tools';
import type { ContextManager } from '../context/context-manager.js';
import type { EventBus } from '../events/event-bus.js';
import type { MetricsCollector } from '../runtime/metrics.js';
import type { ToolDispatcher } from '../runtime/tool-dispatcher.js';
import { Advisor, type AdvisorStage, type AdvisorReview } from './advisor.js';

export interface AgentLoopOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  context: ContextManager;
  events: EventBus;
  sessionId: string;
  /** 单轮最大迭代次数（模型请求次数）；未设置时持续运行，直到模型结束或用户取消 */
  maxIterations?: number;
  /** 连续相同工具调用的次数阈值，达到即判定循环，默认 3 */
  repeatThreshold?: number;
  logger?: Logger;
  /** 每条新消息的持久化回调（Agent 注入 SessionStore） */
  persistMessage?: (message: ChatMessage) => void;
  /** Ephemeral per-request context that is never appended to or persisted in session history. */
  getContextMessages?: (userText: string) => ReadonlyArray<ChatMessage>;
  /** 子代理预算钩子：每次模型请求前调用 */
  onModelRequest?: (iteration: number) => void;
  /** 子代理预算钩子：模型用量返回后调用 */
  onModelUsage?: (totalTokens: number) => void;
  /** Persist and expose the model that actually answered each request. */
  onModelResponse?: (response: ChatResponse) => void;
  /** 可在工具执行前拒绝整批调用，避免越过子代理工具预算 */
  beforeToolCalls?: (count: number) => boolean;
  /** 取出已排队的 steering 指令；只在一批工具执行完成后消费 */
  takeSteering?: () => Array<{ id: string; text: string }>;
  onContextCompacted?: (summary: string, sourceMessages: number) => void;
  onContextCompactionFailed?: (reason: string, sourceMessages: number) => void;
  advisor?: Advisor;
}

export interface LoopRunOptions {
  signal: AbortSignal;
  metrics: MetricsCollector;
  /**
   * 本轮运行的严格工具白名单（v0.5.0 P3 加固）。
   * ToolDispatcher.execute 收到不在白名单里的工具名会事前拒绝。
   * 不传 = 不做过滤（默认行为）。
   */
  allowedTools?: ReadonlySet<string>;
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

const DEFAULT_REPEAT_THRESHOLD = 3;

export class AgentLoop {
  private provider: ModelProvider;
  private readonly registry: ToolRegistry;
  private readonly dispatcher: ToolDispatcher;
  private readonly context: ContextManager;
  private readonly events: EventBus;
  private readonly sessionId: string;
  private readonly maxIterations: number | undefined;
  private readonly repeatThreshold: number;
  private readonly logger: Logger | undefined;
  private readonly persistMessage: ((message: ChatMessage) => void) | undefined;
  private readonly getContextMessages: ((userText: string) => ReadonlyArray<ChatMessage>) | undefined;
  private readonly onModelRequest: ((iteration: number) => void) | undefined;
  private readonly onModelUsage: ((totalTokens: number) => void) | undefined;
  private readonly onModelResponse: ((response: ChatResponse) => void) | undefined;
  private readonly beforeToolCalls: ((count: number) => boolean) | undefined;
  private readonly takeSteering: (() => Array<{ id: string; text: string }>) | undefined;
  private readonly onContextCompacted: ((summary: string, sourceMessages: number) => void) | undefined;
  private readonly onContextCompactionFailed: ((reason: string, sourceMessages: number) => void) | undefined;
  private readonly advisor: Advisor | undefined;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.dispatcher = options.dispatcher;
    this.context = options.context;
    this.events = options.events;
    this.sessionId = options.sessionId;
    this.maxIterations = options.maxIterations === undefined
      ? undefined
      : Math.max(1, Math.floor(options.maxIterations));
    this.repeatThreshold = Math.max(2, options.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD);
    this.logger = options.logger;
    this.persistMessage = options.persistMessage;
    this.getContextMessages = options.getContextMessages;
    this.onModelRequest = options.onModelRequest;
    this.onModelUsage = options.onModelUsage;
    this.onModelResponse = options.onModelResponse;
    this.beforeToolCalls = options.beforeToolCalls;
    this.takeSteering = options.takeSteering;
    this.onContextCompacted = options.onContextCompacted;
    this.onContextCompactionFailed = options.onContextCompactionFailed;
    this.advisor = options.advisor;
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
    let compactionAttempted = false;

    for (let iteration = 1; ; iteration += 1) {
      if (this.maxIterations !== undefined && iteration > this.maxIterations) {
        this.events.emit({
          type: 'notice',
          level: 'warn',
          message: `已达到显式设置的最大迭代次数 ${this.maxIterations}，本轮未完成`,
          ts: Date.now(),
        });
        return { text: lastText, reason: 'max_iterations', iterations, toolCalls: totalToolCalls, toolResults: allToolResults };
      }
      iterations = iteration;

      if (signal.aborted) {
        return { text: lastText, reason: 'aborted', iterations: iteration - 1, toolCalls: totalToolCalls, toolResults: allToolResults };
      }
      this.onModelRequest?.(iteration);
      if (signal.aborted) {
        return { text: lastText, reason: 'aborted', iterations: iteration - 1, toolCalls: totalToolCalls, toolResults: allToolResults };
      }

      // 2. Prefer a reviewable summary while preserving the original session log.
      if (!compactionAttempted && this.context.needsCompaction) {
        compactionAttempted = true;
        const source = this.context.compactionSource(Math.min(48_000, this.context.budgetTokens() * 2));
        if (source) {
          const compactionStarted = Date.now();
          try {
            const compacted = await this.provider.chat({
              messages: [
                { role: 'system', content: '压缩编码任务会话历史。只保留可确认的信息，不要推测。按固定标题输出：当前目标、约束、已确认事实、已完成工作、未完成工作、证据引用。' },
                { role: 'user', content: source.text },
              ],
              tools: [],
              signal,
            });
            metrics.recordModelCall({ durationMs: Date.now() - compactionStarted, firstTokenMs: null, ...compacted.usage });
            this.onModelUsage?.(compacted.usage.totalTokens);
            this.recordModelResponse(compacted);
            const summary = compacted.message.content?.trim() ?? '';
            if (isStructuredSummary(summary) && this.context.compactWithSummary(summary)) {
              this.onContextCompacted?.(summary, source.messageCount);
              this.events.emit({ type: 'context:compacted', summary, sourceMessages: source.messageCount, ts: Date.now() });
            } else {
              const reason = summary ? '摘要缺少必需字段' : '模型返回空摘要';
              this.onContextCompactionFailed?.(reason, source.messageCount);
              this.logger?.warn('摘要压缩失败，回退到确定性压缩', { reason });
              this.events.emit({ type: 'notice', level: 'warn', message: '上下文摘要格式无效，已回退到确定性压缩', ts: Date.now() });
            }
          } catch (err) {
            const reason = describeError(err);
            this.onContextCompactionFailed?.(reason, source.messageCount);
            this.logger?.warn('摘要压缩失败，回退到确定性压缩', { error: reason });
            this.events.emit({ type: 'notice', level: 'warn', message: '上下文摘要失败，已回退到确定性压缩', ts: Date.now() });
          }
        }
      }

      // 3. 构建上下文（必要时确定性兜底压缩）并做协议修复
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
      const requestMessages = insertContextMessages(repaired.messages, this.getContextMessages?.(userText) ?? []);

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
      const streamedDeltas: string[] = [];
      const bufferDeltas = Boolean(
        this.advisor && (
          this.advisor.isEnabledFor('tools')
          || this.advisor.isEnabledFor('final')
          || (iteration === 1 && this.advisor.isEnabledFor('plan'))
        ),
      );
      try {
        response = await this.provider.chat(
          { messages: requestMessages, tools: toolSpecs, signal },
          {
            onDelta: (text) => {
              if (bufferDeltas) streamedDeltas.push(text);
              else this.events.emit({ type: 'assistant:delta', text, ts: Date.now() });
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
      this.recordModelResponse(response);

      const content = response.message.content ?? '';
      if (content.length > 0) lastText = content;
      const toolCalls = response.message.tool_calls ?? [];

      const planReview = iteration === 1
        ? await this.reviewAdvisor('plan', {
            userInput: userText,
            proposedApproach: content,
            proposedTools: toolCalls.map((call) => ({ name: call.function.name, arguments: call.function.arguments })),
          }, signal)
        : undefined;
      if (planReview?.verdict === 'block') {
        const error = new ForgeError('ADVISOR_BLOCKED', `Advisor blocked the plan: ${planReview.reason}`);
        return { text: '', reason: 'error', iterations, toolCalls: totalToolCalls, toolResults: allToolResults, error: toToolErrorInfo(error) };
      }

      const finalReview = toolCalls.length === 0 && (response.finishReason === 'stop' || response.finishReason === 'length')
        ? await this.reviewAdvisor('final', { answer: content, userInput: userText }, signal)
        : undefined;
      const toolReview = toolCalls.length > 0
        ? await this.reviewAdvisor('tools', {
            calls: toolCalls.map((call) => ({ name: call.function.name, arguments: call.function.arguments })),
            assistantText: content,
          }, signal)
        : undefined;

      if (finalReview?.verdict === 'block') {
        const error = new ForgeError('ADVISOR_BLOCKED', `Advisor blocked the final response: ${finalReview.reason}`);
        return { text: '', reason: 'error', iterations, toolCalls: totalToolCalls, toolResults: allToolResults, error: toToolErrorInfo(error) };
      }

      if (bufferDeltas) this.emitBufferedDeltas(streamedDeltas);

      // 4. 记录 assistant 消息（无论是否含工具调用都要入历史，保证下一轮上下文完整）
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: content.length > 0 ? content : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      this.append([assistantMessage]);
      this.events.emit({ type: 'assistant:message', text: content, toolCalls, ts: Date.now() });

      if (toolReview?.verdict === 'block') {
        const blocked = synthesizeResults(toolCalls, 'ADVISOR_BLOCKED', toolReview.reason);
        this.appendToolMessages(toolCalls, blocked);
        allToolResults.push(...toolCalls.map((call, index) => ({ toolName: call.function.name, result: blocked[index]! })));
        totalToolCalls += toolCalls.length;
        const error = new ForgeError('ADVISOR_BLOCKED', `Advisor blocked the tool calls: ${toolReview.reason}`);
        return { text: content, reason: 'error', iterations, toolCalls: totalToolCalls, toolResults: allToolResults, error: toToolErrorInfo(error) };
      }

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
      const results = await this.dispatcher.executeMany(toolCalls, { sessionId: this.sessionId, signal, allowedTools: options.allowedTools });
      for (const result of results) metrics.recordTool(result);
      allToolResults.push(...toolCalls.map((call, index) => ({ toolName: call.function.name, result: results[index]! })));
      this.appendToolMessages(toolCalls, results);
      totalToolCalls += toolCalls.length;

      const resultsReview = await this.reviewAdvisor('results', {
        results: toolCalls.map((call, index) => ({ name: call.function.name, result: results[index] })),
      }, signal);
      if (resultsReview?.verdict === 'block') {
        const error = new ForgeError('ADVISOR_BLOCKED', `Advisor blocked follow-up after tool results: ${resultsReview.reason}`);
        return { text: lastText, reason: 'error', iterations, toolCalls: totalToolCalls, toolResults: allToolResults, error: toToolErrorInfo(error) };
      }

      for (const queued of this.takeSteering?.() ?? []) {
        this.append([{ role: 'user', content: queued.text }]);
        this.events.emit({ type: 'input:dequeued', id: queued.id, mode: 'steer', ts: Date.now() });
        this.events.emit({ type: 'user:message', text: queued.text, ts: Date.now() });
      }

      if (signal.aborted) {
        return { text: lastText, reason: 'aborted', iterations, toolCalls: totalToolCalls, toolResults: allToolResults };
      }
    }

  }

  private async reviewAdvisor(stage: AdvisorStage, payload: unknown, signal: AbortSignal): Promise<AdvisorReview | undefined> {
    if (!this.advisor) return undefined;
    const review = await this.advisor.review(stage, payload, signal);
    this.events.emit({ type: 'advisor:review', stage, verdict: review.verdict, reason: review.reason, ts: Date.now() });
    return review;
  }

  private emitBufferedDeltas(deltas: ReadonlyArray<string>): void {
    for (const text of deltas) {
      this.events.emit({ type: 'assistant:delta', text, ts: Date.now() });
    }
  }

  /** 追加消息并持久化 */
  private append(messages: ChatMessage[]): void {
    for (const message of messages) {
      this.context.append(message);
      this.persistMessage?.(message);
    }
  }

  private recordModelResponse(response: ChatResponse): void {
    this.onModelResponse?.(response);
    const event = {
      type: 'model:response' as const,
      modelId: response.modelId ?? this.provider.currentModelId ?? this.provider.config.model,
      modelName: response.modelName ?? this.provider.config.model,
      ...(this.provider.currentModelRole ? { role: this.provider.currentModelRole } : {}),
      ...(response.fallbackReason ? { fallbackReason: response.fallbackReason } : {}),
      ts: Date.now(),
    };
    this.events.emit(event);
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

function insertContextMessages(messages: ChatMessage[], contextMessages: ReadonlyArray<ChatMessage>): ChatMessage[] {
  if (contextMessages.length === 0) return messages;
  const currentUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (currentUserIndex < 0) return messages;
  return [
    ...messages.slice(0, currentUserIndex + 1),
    ...contextMessages,
    ...messages.slice(currentUserIndex + 1),
  ];
}

function isStructuredSummary(summary: string): boolean {
  const required = ['当前目标', '约束', '已确认事实', '已完成工作', '未完成工作', '证据引用'];
  return required.every((heading) => new RegExp(`(?:^|\\n)\\s*[#* -]*${heading}\\s*[:：]?`, 'm').test(summary));
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
