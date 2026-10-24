/**
 * 统一错误体系。
 *
 * 原则：
 *  - 所有可预期错误都要有稳定 error code，便于上层分支处理与审计检索。
 *  - 不吞异常：捕获后要么转换为带 cause 的 ForgeError，要么继续抛出。
 *  - message 可以给人看，details 用于结构化诊断。
 */

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ABORTED'
  | 'PROVIDER_RATE_LIMIT'
  | 'CONTEXT_OVERFLOW'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_INVALID_INPUT'
  | 'TOOL_TIMEOUT'
  | 'TOOL_FAILED'
  | 'POLICY_DENIED'
  | 'APPROVAL_DENIED'
  | 'WORKSPACE_ESCAPE'
  | 'PATH_NOT_FOUND'
  | 'COMMAND_BLOCKED'
  | 'SESSION_ERROR'
  | 'AUDIT_ERROR'
  | 'ABORTED'
  /* SSH 远程诊断 */
  | 'SSH_HOST_INVALID'
  | 'SSH_HOST_DENIED'
  | 'SSH_HOSTKEY_MISSING'
  | 'SSH_HOSTKEY_MISMATCH'
  | 'SSH_ACTION_INVALID'
  | 'SSH_ACTION_UNKNOWN'
  | 'SSH_PATH_DENIED'
  | 'SSH_PATH_INVALID'
  | 'SSH_ARG_INVALID'
  | 'SSH_CONNECTION_FAILED'
  | 'SSH_AUTH_FAILED'
  | 'SSH_EXEC_FAILED'
  /* Skills */
  | 'SKILL_LOAD_FAILED'
  | 'SKILL_VALIDATION_FAILED'
  /* Correlation */
  | 'CORRELATION_INVALID'
  | 'CORRELATION_NO_EVIDENCE'
  /* Workflow */
  | 'WORKFLOW_INVALID'
  | 'WORKFLOW_STEP_FAILED'
  | 'WORKFLOW_ROLLBACK_FAILED'
  /* Planning (v0.3.0) */
  | 'PLANNING_CHECKPOINT_ERROR'
  | 'PLANNING_PLAN_INVALID'
  | 'PLANNING_DEPENDENCY_ERROR'
  | 'PLANNING_STEP_EXEC_ERROR'
  | 'PLANNING_VERIFICATION_FAILED'
  | 'PLANNING_RETRY_EXHAUSTED'
  /* Sub-Agent (v0.3.0) */
  | 'SUBAGENT_INVALID_SPEC'
  | 'SUBAGENT_ROLE_UNKNOWN'
  | 'SUBAGENT_BUDGET_EXCEEDED'
  | 'SUBAGENT_DELEGATION_DENIED'
  | 'SUBAGENT_CONCURRENCY_LIMIT'
  | 'SUBAGENT_RECURSION_DENIED'
  | 'SUBAGENT_TOOL_DENIED'
  /* Project Memory (v0.3.0) */
  | 'MEMORY_INVALID'
  | 'MEMORY_SENSITIVE_CONTENT'
  | 'MEMORY_STORE_ERROR'
  | 'MEMORY_NOT_FOUND'
  /* Context Engine / Evidence Store (v0.3.0) */
  | 'EVIDENCE_STORE_ERROR'
  | 'EVIDENCE_NOT_FOUND'
  /* Sandbox (v0.4.0) */
  | 'SANDBOX_UNAVAILABLE'
  | 'SANDBOX_CREATE_FAILED'
  | 'SANDBOX_DESTROY_FAILED'
  /* Approval (v0.4.0) */
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_SCOPE_MISMATCH'
  /* Recovery (v0.4.0) */
  | 'RECOVERY_CHECKPOINT_NOT_FOUND'
  | 'RECOVERY_ENV_INCOMPATIBLE'
  | 'RECOVERY_POLICY_MISMATCH'
  /* Requirement Engine (v0.5.0) */
  | 'REQUIREMENT_PARSE_FAILED'
  | 'REQUIREMENT_AMBIGUITY_UNRESOLVED'
  | 'REQUIREMENT_CRITERIA_UNAPPROVED'
  | 'REQUIREMENT_TRACE_NOT_FOUND'
  /* Autonomous Runner (v0.5.0) */
  | 'BUDGET_EXCEEDED'
  | 'BUDGET_APPROVAL_REQUIRED'
  | 'EXECUTION_CANCELLED'
  /* Quality Gate (v0.5.0) */
  | 'QUALITY_GATE_FAILED'
  | 'TEST_EXECUTION_FAILED'
  | 'STATIC_ANALYSIS_FAILED'
  | 'DELIVERY_VALIDATION_FAILED'
  /* Model Router (v0.5.0) */
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_CAPABILITY_MISMATCH'
  | 'MODEL_FALLBACK_EXHAUSTED'
  | 'INTERNAL';

export class ForgeError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ForgeError';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  /** 序列化成可审计 / 可返回给模型的结构 */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  /**
   * 从 ZodError 构造 ForgeError。
   * 优先取第一个 issue 的 message + path，details 里保留完整 issues 供审计。
   * 这是通用工厂，SSH Guard、Skill Validator、Config 都复用。
   */
  static fromZod(zodErr: { issues: ReadonlyArray<{ message: string; path: ReadonlyArray<unknown>; code?: string }> }, code: ErrorCode): ForgeError {
    const first = zodErr.issues[0];
    const pathText = first ? first.path.join('.') : '';
    const message = first
      ? `${first.message}${pathText ? ` (at ${pathText})` : ''}`
      : '参数校验失败';
    return new ForgeError(code, message, {
      details: {
        path: pathText,
        code: first?.code,
        issues: zodErr.issues.map((issue) => ({
          message: issue.message,
          path: Array.from(issue.path).map(String),
          code: issue.code,
        })),
      },
    });
  }
}

/** 面向用户的错误 -> 文本（不含堆栈，避免把内部路径泄露给模型） */
export function describeError(err: unknown): string {
  if (err instanceof ForgeError) return `[${err.code}] ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 判断是否为取消导致的错误 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof ForgeError) {
    return err.code === 'ABORTED' || err.code === 'PROVIDER_ABORTED';
  }
  return err instanceof Error && err.name === 'AbortError';
}
