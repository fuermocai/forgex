/**
 * ToolDispatcher：所有工具调用的唯一入口。
 *
 * 任何模型发起的 tool_call 都必须经过本类，顺序固定：
 *   参数解析 -> Zod 校验 -> 审计(tool_call) -> 策略判定 -> 审批 -> 执行 -> 限流截断 -> 审计(tool_result)
 *
 * 关键保证：
 *  - 无论成功、失败、拒绝、超时、取消，都会返回一个 ToolResult，
 *    保证每个 tool_call_id 都有对应的 tool 消息（协议不破坏）；
 *  - 工具内部异常不会冒泡到 Agent Loop；
 *  - 输出超过 maxOutputBytes 时截断而不是抛错；
 *  - 审批失败/超时一律按拒绝处理。
 */
import {
  ForgeError,
  byteLength,
  ellipsis,
  redactText,
  redactValue,
  stringifyJson,
  takeChars,
  truncateUtf8,
  uuid,
  type JsonValue,
  type Logger,
  type PolicySettings,
  type ToolCall,
  type ToolContext,
  type ToolErrorInfo,
  type ToolOutcome,
  type ToolResult,
} from '@forgex/shared';
import {
  ApprovalManager,
  AuditLogger,
  CommandGuard,
  PolicyEngine,
  WorkspaceGuard,
  type PolicyFacts,
  type PolicyEvaluation,
} from '@forgex/security';
import type { RegisteredTool, ToolRegistry } from '@forgex/tools';
import type { EventBus } from '../events/event-bus.js';

export interface ToolDispatcherOptions {
  registry: ToolRegistry;
  settings: PolicySettings;
  workspace: WorkspaceGuard;
  approvals: ApprovalManager;
  audit: AuditLogger;
  events: EventBus;
  /** 相对路径基准；必须在 workspace 内 */
  cwd?: string;
  /** 同一批工具调用的最大并发，默认 3 */
  maxConcurrency?: number;
  logger?: Logger;
  /** 每次审批回调（用于指标统计） */
  onApproval?: () => void;
}

interface ExecuteOptions {
  sessionId: string;
  signal: AbortSignal;
}

const MAX_ARGUMENTS_BYTES = 64 * 1024;
const AUDIT_PREVIEW_CHARS = 2000;

export class ToolDispatcher {
  private readonly registry: ToolRegistry;
  private readonly settings: PolicySettings;
  private readonly workspace: WorkspaceGuard;
  private readonly approvals: ApprovalManager;
  private readonly audit: AuditLogger;
  private readonly events: EventBus;
  private readonly cwd: string;
  private readonly maxConcurrency: number;
  private readonly logger: Logger | undefined;
  private readonly onApproval: (() => void) | undefined;
  private readonly policy = new PolicyEngine();
  private readonly commandGuard = new CommandGuard();

  constructor(options: ToolDispatcherOptions) {
    this.registry = options.registry;
    this.settings = options.settings;
    this.workspace = options.workspace;
    this.approvals = options.approvals;
    this.audit = options.audit;
    this.events = options.events;
    this.cwd = options.cwd ?? options.settings.workspaceRoots[0] ?? process.cwd();
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
    this.logger = options.logger;
    this.onApproval = options.onApproval;
  }

  /** 执行一批工具调用；返回顺序与入参 calls 一致 */
  async executeMany(calls: ReadonlyArray<ToolCall>, options: ExecuteOptions): Promise<ToolResult[]> {
    const results = new Array<ToolResult>(calls.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= calls.length) return;
        results[index] = await this.execute(calls[index]!, options);
      }
    };
    const workers = Array.from({ length: Math.min(this.maxConcurrency, calls.length) }, () => worker());
    await Promise.all(workers);
    // 所有 index 都会被填充；若 workers 为空（calls 为空）直接返回空数组
    return results;
  }

  async execute(call: ToolCall, options: ExecuteOptions): Promise<ToolResult> {
    const started = Date.now();
    const { sessionId, signal } = options;
    const toolName = call.function.name;
    const tool = this.registry.get(toolName);

    // 1. 解析参数（失败也必须有 tool_result）
    let parsedInput: unknown = {};
    let parseError: ForgeError | null = null;
    try {
      parsedInput = parseArguments(call.function.arguments);
    } catch (err) {
      parseError = new ForgeError('TOOL_INVALID_INPUT', err instanceof Error ? err.message : String(err));
    }

    const safeInput = redactValue(parsedInput) as JsonValue;

    // 2. 审计 tool_call，拿到本次调用的 auditId
    const auditId = await this.audit.record({
      type: 'tool_call',
      sessionId,
      callId: call.id,
      tool: toolName,
      riskLevel: tool?.riskLevel,
      input: safeInput,
      actor: 'agent',
    });

    this.events.emit({
      type: 'tool:start',
      callId: call.id,
      name: toolName,
      input: safeInput,
      ts: Date.now(),
    });

    if (parseError) {
      return this.finalize({
        call,
        sessionId,
        auditId,
        started,
        tool,
        outcome: {
          ok: false,
          summary: `工具 ${toolName} 参数不是合法 JSON: ${parseError.message}`,
          error: { code: 'TOOL_INVALID_INPUT', message: parseError.message },
        },
      });
    }

    if (!tool) {
      return this.finalize({
        call,
        sessionId,
        auditId,
        started,
        outcome: {
          ok: false,
          summary: `模型请求了未注册的工具: ${toolName}`,
          error: { code: 'TOOL_NOT_FOUND', message: `未注册的工具: ${toolName}`, details: { tool: toolName } },
        },
      });
    }

    // 3. Zod 校验
    const parsed = this.registry.parseInput(tool, parsedInput);
    if (!parsed.ok) {
      return this.finalize({
        call,
        sessionId,
        auditId,
        started,
        tool,
        outcome: { ok: false, summary: parsed.error.message, error: parsed.error },
      });
    }

    try {
      // 4. 预解析路径：写操作在审批前就暴露越界问题
      const facts = collectFacts(tool.name, parsed.data);
      const precheck = await this.precheckPaths(tool, facts);
      if (precheck) return await this.finalize({ call, sessionId, auditId, started, tool, outcome: precheck });

      // 5. 策略判定（run_command 额外做结构校验）
      const evaluation = this.evaluate(tool, parsed.data, facts);
      await this.audit.record({
        type: 'policy_decision',
        sessionId,
        callId: call.id,
        tool: tool.name,
        riskLevel: tool.riskLevel,
        decision: evaluation.decision,
        reason: evaluation.reason,
        meta: { rule: evaluation.rule },
        actor: 'system',
      });

      if (evaluation.decision === 'deny') {
        return await this.finalize({
          call,
          sessionId,
          auditId,
          started,
          tool,
          outcome: {
            ok: false,
            summary: `策略拒绝执行 ${tool.name}: ${evaluation.reason}`,
            error: {
              code: 'POLICY_DENIED',
              message: evaluation.reason,
              details: { rule: evaluation.rule },
            },
          },
        });
      }

      // 6. 审批
      if (evaluation.decision === 'ask') {
        const decision = await this.requestApproval(tool, evaluation, safeInput, call, sessionId, signal);
        this.onApproval?.();
        if (decision !== 'approved') {
          const message = decision === 'timeout' ? '审批超时，已按拒绝处理' : '用户拒绝了该操作';
          return await this.finalize({
            call,
            sessionId,
            auditId,
            started,
            tool,
            outcome: {
              ok: false,
              summary: `未获得审批，${tool.name} 未执行：${message}`,
              error: { code: 'APPROVAL_DENIED', message },
            },
          });
        }
      }

      if (signal.aborted) {
        return await this.finalize({
          call,
          sessionId,
          auditId,
          started,
          tool,
          outcome: {
            ok: false,
            summary: `${tool.name} 未执行：操作已取消`,
            error: { code: 'ABORTED', message: '用户取消了操作' },
          },
        });
      }

      // 7. 执行（超时/取消都会终止等待）
      const ctx: ToolContext = {
        workspaceRoot: this.settings.workspaceRoots[0] ?? this.cwd,
        cwd: this.cwd,
        signal,
        auditId,
        workspace: this.workspace,
        policy: this.settings,
      };
      const outcome = await this.runWithDeadline(tool, parsed.data, ctx, signal);

      return await this.finalize({ call, sessionId, auditId, started, tool, outcome });
    } catch (err) {
      // 兜底：工具层未捕获的异常也不能让 Agent 崩溃
      this.logger?.error('工具调用异常', {
        tool: tool.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return await this.finalize({
        call,
        sessionId,
        auditId,
        started,
        tool,
        outcome: {
          ok: false,
          summary: `工具 ${tool.name} 执行异常: ${err instanceof Error ? err.message : String(err)}`,
          error: { code: 'TOOL_FAILED', message: err instanceof Error ? err.message : String(err) },
        },
      });
    }
  }

  /** 写操作与命令 cwd 的提前边界检查 */
  private async precheckPaths(
    tool: RegisteredTool,
    facts: PolicyFacts,
  ): Promise<ToolOutcome<JsonValue> | null> {
    const paths = facts.paths ?? [];
    if (paths.length === 0) return null;
    const mode = tool.riskLevel === 'write' ? 'write' : 'read';
    for (const target of paths) {
      try {
        await this.workspace.resolve(target, mode, this.cwd);
      } catch (err) {
        const code = err instanceof ForgeError ? err.code : 'WORKSPACE_ESCAPE';
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, summary: message, error: { code, message } };
      }
    }
    return null;
  }

  private evaluate(tool: RegisteredTool, input: unknown, facts: PolicyFacts): PolicyEvaluation {
    if (tool.name === 'run_command') {
      const record = isRecord(input) ? input : {};
      const program = typeof record.program === 'string' ? record.program : '';
      const args = Array.isArray(record.args) ? record.args.filter((item): item is string => typeof item === 'string') : [];
      return this.commandGuard.check(
        { program, args, ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}) },
        this.settings,
      );
    }
    return this.policy.evaluate({
      tool: tool.name,
      riskLevel: tool.riskLevel,
      facts,
      settings: this.settings,
    });
  }

  private async requestApproval(
    tool: RegisteredTool,
    evaluation: PolicyEvaluation,
    safeInput: JsonValue,
    call: ToolCall,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<'approved' | 'denied' | 'timeout'> {
    const request = {
      id: uuid(),
      tool: tool.name,
      riskLevel: tool.riskLevel,
      reason: evaluation.reason,
      input: safeInput,
      preview: buildPreview(tool.name, safeInput),
    };
    this.events.emit({ type: 'approval:required', request, ts: Date.now() });
    const decision = await this.approvals.request(request, signal);
    this.events.emit({
      type: 'approval:resolved',
      id: request.id,
      decision: decision === 'approved' ? 'approved' : decision === 'timeout' ? 'timeout' : 'denied',
      ts: Date.now(),
    });
    await this.audit.record({
      type: 'approval',
      sessionId,
      callId: call.id,
      tool: tool.name,
      riskLevel: tool.riskLevel,
      decision: decision === 'approved' ? 'approved' : decision === 'timeout' ? 'timeout' : 'denied',
      reason: evaluation.reason,
      actor: 'user',
    });
    return decision;
  }

  /** 执行工具并强制超时/取消上限 */
  private async runWithDeadline(
    tool: RegisteredTool,
    input: unknown,
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolOutcome<JsonValue>> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ForgeError('TOOL_TIMEOUT', `工具 ${tool.name} 执行超过 ${tool.timeoutMs}ms`, { retryable: true }));
      }, tool.timeoutMs);
      timer.unref?.();
    });

    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ForgeError('ABORTED', '工具执行已被取消'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });

    const execution = Promise.resolve().then(() => tool.execute(input, ctx));
    // 防止超时/取消后工具仍 reject 造成 unhandledRejection
    execution.catch(() => undefined);

    try {
      return await Promise.race([execution, timeoutPromise, abortPromise]);
    } catch (err) {
      const code = err instanceof ForgeError ? err.code : 'TOOL_FAILED';
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `${tool.name} 执行失败: ${message}`,
        error: { code, message, ...(code === 'TOOL_TIMEOUT' ? { retryable: true } : {}) },
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** 统一出口：限流截断、审计、事件、结果封装 */
  private async finalize(params: {
    call: ToolCall;
    sessionId: string;
    auditId: string;
    started: number;
    tool?: RegisteredTool;
    outcome: ToolOutcome<JsonValue>;
  }): Promise<ToolResult> {
    const { call, sessionId, auditId, started, tool, outcome } = params;
    const limited = limitOutcome(outcome, tool?.maxOutputBytes ?? 64 * 1024);
    const durationMs = Date.now() - started;
    const bytes = byteLength(
      stringifyJson({ summary: limited.summary, data: limited.data, error: limited.error }),
    );

    const result: ToolResult = {
      ok: limited.ok,
      summary: limited.summary,
      ...(limited.ok && limited.data !== undefined ? { data: limited.data } : {}),
      ...(!limited.ok ? { error: limited.error } : {}),
      truncated: limited.truncated,
      durationMs,
      bytes,
      auditId,
    };

    await this.audit.record({
      type: 'tool_result',
      sessionId,
      callId: call.id,
      tool: limited.ok ? call.function.name : tool?.name ?? call.function.name,
      riskLevel: tool?.riskLevel,
      ok: limited.ok,
      durationMs,
      reason: redactText(takeChars(limited.summary, 500)),
      output: {
        summary: redactText(takeChars(limited.summary, 500)),
        truncated: limited.truncated,
        bytes,
        ...(limited.ok && limited.data !== undefined
          ? { preview: takeChars(stringifyJson(redactValue(limited.data)), AUDIT_PREVIEW_CHARS) }
          : {}),
        ...(!limited.ok ? { error: redactValue(limited.error) } : {}),
      } as unknown as JsonValue,
      meta: { bytes, truncated: limited.truncated },
    });

    this.events.emit({ type: 'tool:end', callId: call.id, name: call.function.name, result, ts: Date.now() });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                            */
/* ------------------------------------------------------------------ */

function parseArguments(raw: string | undefined): unknown {
  const text = raw ?? '';
  if (byteLength(text) > MAX_ARGUMENTS_BYTES) {
    throw new ForgeError('TOOL_INVALID_INPUT', `工具参数超过 ${MAX_ARGUMENTS_BYTES} 字节`);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (err) {
    throw new ForgeError('TOOL_INVALID_INPUT', `参数不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从工具入参中提取策略判定所需的路径/程序信息 */
function collectFacts(toolName: string, input: unknown): PolicyFacts {
  const record = isRecord(input) ? input : {};
  const paths: string[] = [];
  for (const key of ['path', 'file', 'filePath', 'target']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) paths.push(value);
  }
  if (Array.isArray(record.paths)) {
    for (const value of record.paths) {
      if (typeof value === 'string' && value.trim().length > 0) paths.push(value);
    }
  }
  if (paths.length > 0) return { paths };
  return {};
}

function buildPreview(toolName: string, input: JsonValue): string {
  const record = isRecord(input) ? input : {};
  if (toolName === 'run_command') {
    const program = typeof record.program === 'string' ? record.program : '';
    const args = Array.isArray(record.args) ? record.args.map(String) : [];
    return `${program} ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`.trim();
  }
  if (toolName === 'edit_file' || toolName === 'read_file') {
    const path = typeof record.path === 'string' ? record.path : '(unknown)';
    return toolName === 'edit_file' ? `将修改文件: ${path}` : `将读取文件: ${path}`;
  }
  if (typeof record.path === 'string') return `目标: ${record.path}`;
  return '';
}

/** limitOutcome 的返回结构：可辨识字段被"拍平"，便于 finalize 统一组装 */
interface LimitedOutcome {
  ok: boolean;
  summary: string;
  data?: JsonValue;
  error?: ToolErrorInfo;
  truncated: boolean;
}

/**
 * 输出限流：整体序列化超过 maxBytes 时，把 data 替换为截断预览。
 * 这样既保住"结构合法"，也让模型知道内容被截断。
 */
function limitOutcome(outcome: ToolOutcome<JsonValue>, maxBytes: number): LimitedOutcome {
  const raw = outcome.ok
    ? stringifyJson({ summary: outcome.summary, data: outcome.data })
    : stringifyJson({ summary: outcome.summary, error: outcome.error });

  if (byteLength(raw) <= maxBytes) {
    return outcome.ok
      ? {
          ok: true,
          summary: outcome.summary,
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
          truncated: outcome.truncated === true,
        }
      : {
          ok: false,
          summary: outcome.summary,
          error: outcome.error,
          truncated: false,
        };
  }

  if (outcome.ok) {
    const preview = truncateUtf8(stringifyJson(outcome.data ?? null), Math.floor(maxBytes * 0.7)).text;
    return {
      ok: true,
      summary: ellipsis(`${outcome.summary}（输出超过 ${maxBytes} 字节已截断）`, 400),
      data: { note: '输出被截断', preview } as JsonValue,
      truncated: true,
    };
  }

  const detailPreview = truncateUtf8(stringifyJson(outcome.error.details ?? null), Math.floor(maxBytes * 0.5)).text;
  return {
    ok: false,
    summary: ellipsis(outcome.summary, 400),
    error: {
      code: outcome.error.code,
      message: ellipsis(outcome.error.message, 1000),
      retryable: outcome.error.retryable,
      details: { preview: detailPreview, truncated: true } as JsonValue,
    },
    truncated: true,
  };
}
