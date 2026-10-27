/**
 * 模型层对外类型。
 *
 * 业务代码只依赖 `ModelProvider` 接口，不得直接 import 具体厂商实现。
 */

import type { ChatMessage, JsonValue, ToolCall } from '@forgex/shared';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 提供给模型的工具声明（OpenAI function calling 形态） */
export interface ModelToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonValue;
  };
}

export interface ModelConfig {
  /** OpenAI-compatible 服务的 base url，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  /** API Key。禁止写入日志、会话与审计。 */
  apiKey?: string;
  /** Key 所来自的环境变量名（仅用于 `/key` 落盘时对齐，不参与请求） */
  apiKeyEnv?: string;
  /** 模型名，例如 deepseek-chat / qwen2.5-coder-32b-instruct */
  model: string;
  /** 上下文窗口（token），用于预算管理 */
  contextWindow: number;
  /** 单次最大输出 token */
  maxOutputTokens: number;
  temperature: number;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 最大重试次数（不含首次） */
  maxRetries: number;
  /** 是否使用流式 */
  stream: boolean;
  /** 额外请求头（企业网关常见需求） */
  headers?: Record<string, string>;
  /** provider 展示名，仅用于日志 */
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ModelToolSpec[];
  /** 覆盖默认 temperature */
  temperature?: number;
  /** 覆盖默认 maxOutputTokens */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: ChatMessage;
  finishReason: string;
  usage: TokenUsage;
  /** 是否实际使用了流式（便于指标判断） */
  streamed: boolean;
}

/** 流式回调。所有回调都是可选的，失败不应影响主流程。 */
export interface StreamHandlers {
  onDelta?: (text: string) => void;
  /** 首个内容/工具增量到达 */
  onFirstToken?: () => void;
}

export interface ModelProvider {
  readonly name: string;
  readonly config: Readonly<ModelConfig>;
  chat(request: ChatRequest, handlers?: StreamHandlers): Promise<ChatResponse>;
}

/** 增量工具调用（OpenAI 流式分片） */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
  arguments?: string;
}

/** 归一化后的模型响应解析结果 */
export interface ParsedAssistantChunk {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: TokenUsage;
}
