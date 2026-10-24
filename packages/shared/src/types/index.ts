/**
 * ForgeX 共享类型定义。
 *
 * 约束：
 *  - 本文件不依赖任何业务模块，只依赖 zod 的 `ZodType` 类型，用于工具参数 schema 的类型约束。
 *  - 所有跨包传递的数据结构都集中在这里，避免各包各自定义导致协议漂移。
 */
import type { ZodType } from 'zod';

/** JSON 原始值 */
export type JsonPrimitive = string | number | boolean | null;

/** 可安全序列化（并可落盘/进审计）的 JSON 值 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/* ------------------------------------------------------------------ */
/* 对话协议（严格遵循 OpenAI Chat Completions 语义）                    */
/* ------------------------------------------------------------------ */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 模型发起的工具调用。
 * 注意：`id` 必须与后续 tool 消息的 `tool_call_id` 一一对应，
 * 否则下一轮请求会被 OpenAI-compatible 服务端拒绝。
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    /** 工具名 */
    name: string;
    /** 原始 JSON 字符串，必须由工具注册表用 Zod 二次校验 */
    arguments: string;
  };
}

/** 会话中的一条消息 */
export interface ChatMessage {
  role: Role;
  content: string | null;
  /** 仅 assistant 消息可能携带 */
  tool_calls?: ToolCall[];
  /** 仅 tool 消息携带，对应 assistant.tool_calls[].id */
  tool_call_id?: string;
  /** 仅 tool 消息携带，冗余记录工具名，便于压缩与审计 */
  name?: string;
}

/* ------------------------------------------------------------------ */
/* 工具与风险                                                          */
/* ------------------------------------------------------------------ */

/**
 * 风险等级，同时作为权限判定的输入：
 *  - read       读取文件 / 只读系统探测
 *  - write      修改工作区内容
 *  - execute    执行外部程序
 *  - privileged 高风险系统操作（重启、安装、改配置、删除等）
 */
export type RiskLevel = 'read' | 'write' | 'execute' | 'privileged';

/** 权限模式（由用户配置决定，模型无权修改） */
export type PermissionMode = 'readonly' | 'standard' | 'trusted' | 'yolo';

/** 策略判定结果 */
export type PolicyDecision = 'allow' | 'ask' | 'deny';

/** 统一的工具错误结构（不抛出到 Agent 外层） */
export interface ToolErrorInfo {
  /** 稳定的机器可读错误码，例如 WORKSPACE_ESCAPE / TIMEOUT / POLICY_DENIED */
  code: string;
  message: string;
  /** 是否允许 Agent 在受限次数内重试 */
  retryable?: boolean;
  /** 结构化补充信息 */
  details?: JsonValue;
}

/**
 * 工具执行结果（工具自身返回，不含调度耗时与审计 id）。
 * 使用可辨识联合，保证 ok=true 时没有 error、ok=false 时必有 error。
 */
export type ToolOutcome<T = JsonValue> =
  | {
      ok: true;
      /** 给模型看的一句话摘要 */
      summary: string;
      /** 结构化数据（给模型和 UI 看） */
      data?: T;
      /** 是否因为大小限制被截断 */
      truncated?: boolean;
    }
  | {
      ok: false;
      summary: string;
      error: ToolErrorInfo;
    };

/** 调度器补全后的完整工具结果（进入审计与事件流） */
export interface ToolResult<T = JsonValue> {
  ok: boolean;
  summary: string;
  data?: T;
  error?: ToolErrorInfo;
  truncated: boolean;
  /** 工具调用发生的实际耗时（毫秒） */
  durationMs: number;
  /** 序列化后的字节数（用于上下文预算） */
  bytes: number;
  /** 审计事件 id */
  auditId: string;
}

/** 工具执行上下文（由调度器注入，工具不得自行创建） */
export interface ToolContext {
  /** 已解析（realpath）的授权工作区根目录 */
  workspaceRoot: string;
  /** 当前工作目录，必须在 workspaceRoot 之内 */
  cwd: string;
  /** 统一取消信号 */
  signal: AbortSignal;
  /** 本次执行的审计 id，工具内部子事件可复用 */
  auditId: string;
  /**
   * 工作区路径解析器（由 Security 层注入）。
   * 工具必须通过它解析所有路径，禁止自行拼接后直接 IO，
   * 否则会绕过路径穿越与符号链接防护。
   */
  workspace: WorkspaceResolver;
  /**
   * 当前生效的安全策略（只读）。
   * 工具只能读取，例如 run_command 用它做环境变量白名单与超时上限；
   * 任何工具都不得修改策略对象。
   */
  policy: Readonly<PolicySettings>;
}

/**
 * 工作区路径解析接口。
 * 定义在 shared 中（而不是 import WorkspaceGuard），避免 shared 反向依赖 security。
 */
export interface WorkspaceResolver {
  resolve(target: string, mode: 'read' | 'write', cwd?: string): Promise<string>;
}

/** 工具定义。所有工具都必须实现该接口后才能注册。 */
export interface ToolDefinition<Input = unknown, Output = JsonValue> {
  readonly name: string;
  readonly description: string;
  /** Zod schema —— 既用于运行时校验，也用于生成 JSON Schema 给模型 */
  readonly parameters: ZodType<Input>;
  readonly riskLevel: RiskLevel;
  /** 单次执行超时（毫秒） */
  readonly timeoutMs: number;
  /** 输出字节上限，超限必须截断而不是抛错 */
  readonly maxOutputBytes: number;
  readonly tags?: readonly string[];
  /**
   * 执行体。
   * 约定：不要在这里抛异常给 Agent；调度器会兜底捕获，但工具应尽量返回结构化错误。
   */
  execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<Output>>;
}

/* ------------------------------------------------------------------ */
/* 审批                                                                */
/* ------------------------------------------------------------------ */

export interface ApprovalRequest {
  id: string;
  tool: string;
  riskLevel: RiskLevel;
  /** 为什么需要审批（给人看） */
  reason: string;
  /** 将要执行的参数（已脱敏） */
  input: JsonValue;
  /** 额外预览，例如 diff 或命令行 */
  preview?: string;
}

/* ------------------------------------------------------------------ */
/* 事件（EventBus）                                                    */
/* ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: 'session:start'; sessionId: string; ts: number }
  | { type: 'user:message'; text: string; ts: number }
  | { type: 'model:request'; attempt: number; messageCount: number; estimatedTokens: number; ts: number }
  | { type: 'assistant:delta'; text: string; ts: number }
  | { type: 'assistant:message'; text: string; toolCalls: ToolCall[]; ts: number }
  | { type: 'tool:start'; callId: string; name: string; input: JsonValue; ts: number }
  | { type: 'tool:end'; callId: string; name: string; result: ToolResult; ts: number }
  | { type: 'approval:required'; request: ApprovalRequest; ts: number }
  | { type: 'approval:resolved'; id: string; decision: 'approved' | 'denied' | 'timeout'; ts: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string; ts: number }
  | { type: 'turn:end'; reason: TurnEndReason; ts: number }
  | { type: 'metrics'; metrics: RunMetrics; ts: number };

export type TurnEndReason =
  | 'completed'
  | 'max_iterations'
  | 'aborted'
  | 'error'
  | 'loop_detected';

/* ------------------------------------------------------------------ */
/* 指标                                                                */
/* ------------------------------------------------------------------ */

export interface RunMetrics {
  sessionId: string;
  /** 模型请求次数（含重试） */
  modelCalls: number;
  retries: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 首 Token 延迟（毫秒），无流式或未收到则为 null */
  firstTokenMs: number | null;
  /** 模型累计耗时 */
  modelMs: number;
  /** 工具累计耗时 */
  toolMs: number;
  /** 整轮总耗时 */
  totalMs: number;
  toolCalls: number;
  toolFailures: number;
  approvals: number;
  iterations: number;
}

/* ------------------------------------------------------------------ */
/* 安全策略配置                                                        */
/* ------------------------------------------------------------------ */

export interface PolicySettings {
  mode: PermissionMode;
  /** 授权工作区根目录（绝对路径） */
  workspaceRoots: string[];
  /** 额外允许写入的根目录（默认等于 workspaceRoots） */
  writableRoots: string[];
  /** 即使在可写目录内也禁止写入的路径（如 .git、node_modules） */
  protectedPaths: string[];
  /** 允许直接执行的程序名白名单；为空表示全部需要审批 */
  allowedPrograms: string[];
  /** 始终拒绝的程序名 */
  deniedPrograms: string[];
  /** 始终拒绝的 argv 模式（正则字符串），用于拦截危险参数组合 */
  deniedArgPatterns: string[];
  /**
   * 传递给子进程的环境变量白名单。
   * run_command 只注入这些变量，其余一律丢弃，避免把无关密钥泄露给命令。
   */
  envAllowlist: string[];
  /** 单条命令最大执行时长（毫秒） */
  commandTimeoutMs: number;
  /** 文件写入前是否必须人工审批 */
  requireApprovalForWrite: boolean;
  /** 命令执行前是否必须人工审批 */
  requireApprovalForExecute: boolean;
  /** 审计日志文件路径（JSONL）；为空则只写会话库 */
  auditLogPath?: string;
  /**
   * SSH 远程诊断：授权主机白名单。
   * 为空数组表示 SSH 远程诊断**整体禁用**（默认）。
   * 每个条目包含 host + 连接配置 + Host Key 指纹（强校验）。
   */
  remoteHosts?: RemoteHostConfig[];
}

/**
 * 远程主机授权条目（用于 SSH / 后续 Docker / K8s 远程诊断）。
 *
 * 安全约束：
 *   - hostKeyFingerprint 必须填——Guard 在运行时会校验连接指纹是否匹配；
 *   - privateKeyPath 只接受密钥文件路径，禁止内联私钥文本（密钥本身已敏感，
 *     不应出现在 JSON 配置中）；
 *   - 权限模式里的 riskLevel 仍是"读/写/执行"四档，但远程工具默认只暴露 read 级。
 */
export interface RemoteHostConfig {
  /** 主机名或 IP（精确匹配） */
  host: string;
  /** SSH 端口，默认 22 */
  port?: number;
  /** 登录用户 */
  username: string;
  /** 私钥文件路径（绝对路径或相对于工作区） */
  privateKeyPath: string;
  /** 期望的 Host Key SHA256 指纹，连接时强制校验 */
  hostKeyFingerprint: string;
  /** 可选的别名列表（agent 可以用别名指代） */
  aliases?: string[];
  /** 只允许读这些目录（SSH 工具的路径白名单基础），默认 ['/var/log', '/tmp', '/home'] */
  allowedPaths?: string[];
}
