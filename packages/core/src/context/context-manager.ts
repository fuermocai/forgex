/**
 * ContextManager：上下文窗口预算与确定性压缩。
 *
 * 为什么不用 LLM 做摘要：
 *  - 摘要会引入额外模型调用（成本、延迟、不确定性）；
 *  - 在内网/离线场景下，摘要模型可能与主模型不同，增加部署复杂度；
 *  - 确定性压缩可测试、可审计、不会"编造"历史内容。
 *
 * 压缩顺序（从破坏性最小到最大）：
 *  1. 截断历史工具输出（最占空间的通常是日志/diff）；
 *  2. 按"用户消息"边界删除最旧的完整轮次；
 *  3. 进一步强截断工具与助手消息；
 *  4. 最后按需截断当前轮次内容，保证请求一定不超限。
 *
 * 协议安全：只从 user 消息处切割，因此不会产生"孤立 tool_result"或
 * "缺失 tool_result"的非法序列；调用方仍需在发送前做一次协议校验。
 */
import type { ChatMessage } from '@forgex/shared';
import { estimateMessagesTokens, estimateTokens, truncateUtf8 } from '@forgex/shared';
import { renderEvidencePlaceholder, type EvidenceStore } from './evidence-store.js';

export interface ContextManagerOptions {
  systemPrompt: string;
  /** 模型上下文窗口（token） */
  contextWindow: number;
  /** 预留给模型输出的 token */
  maxOutputTokens: number;
  /** 额外安全边距（token），默认 512 */
  safetyMarginTokens?: number;
  /** 单条工具结果在第一次压缩时的 token 上限，默认 900 */
  toolResultMaxTokens?: number;
  /**
   * 证据外置存储（可选）。
   * 提供后，压缩流程会多一个"第 0 步"：超限场景下先把超长工具输出
   * 整体搬入证据库，消息里只留引用——比直接截断更可恢复。
   */
  evidenceStore?: EvidenceStore;
  /** 证据归属的会话 ID（外置时记录，便于会话结束清理） */
  evidenceSessionId?: string;
  /** 触发证据外置的单条工具输出 token 阈值，默认 600 */
  evidenceMinTokens?: number;
}

export interface BuildResult {
  messages: ChatMessage[];
  /** 本次构建是否发生了压缩（截断或删除或外置） */
  compressed: boolean;
  /** 被删除的消息条数 */
  dropped: number;
  /** 本次外置为证据的工具输出条数 */
  externalized: number;
  /** 当前估算 token */
  estimatedTokens: number;
}

const DEFAULT_SAFETY_MARGIN = 512;
const DEFAULT_TOOL_RESULT_TOKENS = 900;
const DEFAULT_EVIDENCE_MIN_TOKENS = 600;

export class ContextManager {
  private systemMessage: ChatMessage;
  private contextWindow: number;
  private maxOutputTokens: number;
  private readonly safetyMargin: number;
  private readonly toolResultMaxTokens: number;
  private readonly evidenceStore?: EvidenceStore;
  private readonly evidenceSessionId?: string;
  private readonly evidenceMinTokens: number;
  private history: ChatMessage[] = [];
  private compressionCount = 0;

  constructor(options: ContextManagerOptions) {
    if (!options.systemPrompt.trim()) {
      throw new Error('ContextManager 需要非空的 systemPrompt');
    }
    if (options.contextWindow < 1024) {
      throw new Error('contextWindow 必须 >= 1024');
    }
    this.systemMessage = { role: 'system', content: options.systemPrompt };
    this.contextWindow = options.contextWindow;
    this.maxOutputTokens = Math.max(256, options.maxOutputTokens);
    this.safetyMargin = Math.max(0, options.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN);
    this.toolResultMaxTokens = Math.max(128, options.toolResultMaxTokens ?? DEFAULT_TOOL_RESULT_TOKENS);
    if (options.evidenceStore !== undefined) this.evidenceStore = options.evidenceStore;
    if (options.evidenceSessionId !== undefined) this.evidenceSessionId = options.evidenceSessionId;
    this.evidenceMinTokens = Math.max(128, options.evidenceMinTokens ?? DEFAULT_EVIDENCE_MIN_TOKENS);
  }

  /** 追加消息（调用方负责保证 tool 消息与 tool_call 的配对） */
  append(message: ChatMessage): void {
    this.history.push(message);
  }

  /**
   * 替换系统提示词（运行时切换计划模式等场景）。
   * 历史消息不受影响，下一次 build() 即生效。
   */
  setSystemPrompt(prompt: string): void {
    if (!prompt.trim()) throw new Error('systemPrompt 不能为空');
    this.systemMessage = { role: 'system', content: prompt };
  }

  /** 运行时切换模型后同步上下文预算 */
  setLimits(contextWindow: number, maxOutputTokens: number): void {
    if (contextWindow < 1024) throw new Error('contextWindow 必须 >= 1024');
    this.contextWindow = contextWindow;
    this.maxOutputTokens = Math.max(256, maxOutputTokens);
  }

  appendAll(messages: ReadonlyArray<ChatMessage>): void {
    for (const message of messages) this.history.push(message);
  }

  /** 用一组消息替换历史（不含 system），用于会话恢复或协议修复 */
  replace(messages: ReadonlyArray<ChatMessage>): void {
    this.history = messages.filter((message) => message.role !== 'system').map((message) => ({ ...message }));
  }

  reset(): void {
    this.history = [];
  }

  get raw(): ReadonlyArray<ChatMessage> {
    return this.history;
  }

  get compressedTimes(): number {
    return this.compressionCount;
  }

  /** 可用输入预算（token） */
  budgetTokens(): number {
    return Math.max(512, this.contextWindow - this.maxOutputTokens - this.safetyMargin);
  }

  estimatedTokens(): number {
    return estimateMessagesTokens([this.systemMessage, ...this.history]);
  }

  /**
   * 构建一次请求的 messages。
   * 注意：本方法会就地压缩内部历史，避免上下文无限增长。
   */
  build(): BuildResult {
    const budget = this.budgetTokens();
    let working = this.history.map((message) => ({ ...message }));
    let compressed = false;
    let dropped = 0;
    let externalized = 0;

    // 历史必须以 user 开头（会话恢复或异常中断时可能出现 assistant/tool 开头）
    while (working.length > 0 && working[0]!.role !== 'user') {
      working.shift();
      dropped += 1;
      compressed = true;
    }

    const total = (): number => estimateMessagesTokens([this.systemMessage, ...working]);

    if (total() > budget && this.evidenceStore !== undefined) {
      // 第 0 步：证据外置——把超长工具输出整体搬进证据库，消息里留引用。
      // 与截断的区别：原文可凭 evidence_id 取回，信息不永久丢失。
      // 注意：最近一条工具输出不外置，保证当前轮模型能看到完整新结果。
      const lastToolIndex = findLastIndex(working, (m) => m.role === 'tool');
      for (let i = 0; i < working.length; i++) {
        if (total() <= budget) break;
        const message = working[i]!;
        if (message.role !== 'tool' || !message.content) continue;
        if (i === lastToolIndex) continue;
        // 已是占位符的不重复外置（压缩是就地更新历史，build 会多次触发）
        if (message.content.startsWith('[内容已外置为证据')) continue;
        if (estimateTokens(message.content) < this.evidenceMinTokens) continue;
        const ref = this.evidenceStore.put({
          kind: 'tool_output',
          content: message.content,
          ...(this.evidenceSessionId !== undefined ? { sessionId: this.evidenceSessionId } : {}),
          metadata: { toolName: message.name, toolCallId: message.tool_call_id },
        });
        message.content = renderEvidencePlaceholder(ref);
        externalized += 1;
        compressed = true;
      }
    }

    if (total() > budget) {
      // 第一步：截断历史工具输出
      for (const message of working) {
        if (message.role !== 'tool' || !message.content) continue;
        const truncated = truncateToTokens(message.content, this.toolResultMaxTokens);
        if (truncated.truncated) {
          message.content = truncated.text;
          compressed = true;
        }
      }
    }

    if (total() > budget) {
      // 第二步：按 user 边界删除最旧完整轮次
      for (;;) {
        if (total() <= budget) break;
        const nextUser = working.findIndex((message, index) => index > 0 && message.role === 'user');
        if (nextUser <= 0) break;
        dropped += nextUser;
        working = working.slice(nextUser);
        compressed = true;
      }
    }

    if (total() > budget) {
      // 第三步：强截断（工具 400 token，助手 1200 token）
      for (const message of working) {
        if (!message.content) continue;
        const limit = message.role === 'tool' ? 400 : 1200;
        const truncated = truncateToTokens(message.content, limit);
        if (truncated.truncated) {
          message.content = truncated.text;
          compressed = true;
        }
      }
    }

    if (total() > budget) {
      // 第四步：逐步把最旧消息内容减半，直到落入预算
      for (const message of working) {
        if (total() <= budget) break;
        if (!message.content) continue;
        while (total() > budget && message.content.length > 16) {
          const keep = Math.max(8, Math.floor(message.content.length / 2));
          message.content = `${message.content.slice(0, keep)}\n…[truncated]`;
          compressed = true;
        }
      }
    }

    if (compressed) {
      this.compressionCount += 1;
      this.history = working;
    }

    return {
      messages: [this.systemMessage, ...working],
      compressed,
      dropped,
      externalized,
      estimatedTokens: total(),
    };
  }
}

/** 从后往前找第一个满足条件的下标（Node 18 无 Array.findLastIndex 时兜底） */
function findLastIndex<T>(arr: readonly T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
}

/** 按 token 估算截断文本（内部换算为 UTF-8 字节后用安全截断） */
function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return { text, truncated: false };
  const bytes = Buffer.byteLength(text, 'utf8');
  const ratio = maxTokens / tokens;
  // 0.9 系数用于抵消估算误差，宁短勿超
  return truncateUtf8(text, Math.max(64, Math.floor(bytes * ratio * 0.9)));
}
