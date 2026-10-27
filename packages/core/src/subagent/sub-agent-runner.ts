/**
 * SubAgentRunner：跑一个 Sub-Agent 的完整生命周期（v0.3.0 Phase 2）。
 *
 * 执行流程：
 *   1. 校验 spec（role 合法、allowed_tools 都在角色白名单内）；
 *   2. 构造受限 ToolRegistry（只含 spec.allowed_tools ∩ 角色白名单）；
 *   3. 构造受限 ToolDispatcher（共享父任务的 workspace/approvals/audit）；
 *   4. 构造独立的 ContextManager（角色系统提示词 + 模型 contextWindow）；
 *   5. 构造 AgentLoop，订阅事件以跟踪 ResourceLimiter；
 *   6. 运行 AgentLoop，把 LoopResult + 事件跟踪数据转成 SubAgentResult；
 *   7. 从工具调用历史提取证据引用（EvidenceRef）。
 *
 * 关键约束：
 *   - 子代理不能递归（不会再分派新的 SubAgent）；
 *   - 子代理共享父任务的 workspace / approvals / audit ——保证安全链不断；
 *   - 子代理有独立的 ContextManager——不会污染父任务的历史；
 *   - 所有工具调用都过 ToolDispatcher——审批、审计、策略、超时一致；
 *   - 资源超限立即终止（通过 AbortController 传播）。
 */
import {
  ForgeError,
  estimateMessagesTokens,
  type ChatMessage,
  type JsonValue,
  type Logger,
  type PolicySettings,
  type ToolResult,
} from '@forgex/shared';
import type { ModelProvider } from '@forgex/models';
import { ToolRegistry, type RegisteredTool } from '@forgex/tools';
import type { ApprovalManager, AuditLogger, WorkspaceGuard } from '@forgex/security';
import { AgentLoop } from '../agent/agent-loop.js';
import { ContextManager } from '../context/context-manager.js';
import { EventBus } from '../events/event-bus.js';
import { MetricsCollector } from '../runtime/metrics.js';
import { ToolDispatcher } from '../runtime/tool-dispatcher.js';
import type { EvidenceRef } from '../planning/types.js';
import { AgentRegistry } from './agent-registry.js';
import { ResourceLimiter } from './resource-limiter.js';
import { resolveBudget, type SubAgentResult, type SubAgentSpec } from './types.js';

export interface SubAgentRunnerOptions {
  provider: ModelProvider;
  /** 完整工具注册表（会按 spec.allowed_tools 过滤） */
  fullRegistry: ToolRegistry;
  /** 安全链路（与父任务共享） */
  workspace: WorkspaceGuard;
  approvals: ApprovalManager;
  audit: AuditLogger;
  settings: PolicySettings;
  /** 事件总线（可选——子代理事件会加上 subagentId 前缀，便于父任务区分） */
  parentEvents?: EventBus;
  /** 角色注册表（缺省时新建） */
  registry?: AgentRegistry;
  /** 相对路径基准 */
  cwd?: string;
  logger?: Logger;
}

export class SubAgentRunner {
  private readonly provider: ModelProvider;
  private readonly fullRegistry: ToolRegistry;
  private readonly workspace: WorkspaceGuard;
  private readonly approvals: ApprovalManager;
  private readonly audit: AuditLogger;
  private readonly settings: PolicySettings;
  private readonly parentEvents: EventBus | undefined;
  private readonly registry: AgentRegistry;
  private readonly cwd: string | undefined;
  private readonly logger: Logger | undefined;

  constructor(options: SubAgentRunnerOptions) {
    this.provider = options.provider;
    this.fullRegistry = options.fullRegistry;
    this.workspace = options.workspace;
    this.approvals = options.approvals;
    this.audit = options.audit;
    this.settings = options.settings;
    this.parentEvents = options.parentEvents;
    this.registry = options.registry ?? new AgentRegistry();
    this.cwd = options.cwd;
    this.logger = options.logger;
  }

  /**
   * 运行一个 Sub-Agent。
   *
   * 不抛异常——所有错误（包括超预算、模型失败、AbortSignal）都转换为
   * SubAgentResult.success=false + failureReason。
   */
  async run(spec: SubAgentSpec, options: { signal?: AbortSignal } = {}): Promise<SubAgentResult> {
    const started = Date.now();
    const budget = resolveBudget(spec.budget);
    const limiter = new ResourceLimiter(budget);

    // 内嵌 AbortController——超预算时主动终止
    const controller = new AbortController();
    const parentSignal = options.signal;
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort();
      } else {
        parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    // 1. 校验 spec
    try {
      this.validateSpec(spec);
    } catch (err) {
      return this.buildFailureResult(spec, started, limiter, err instanceof Error ? err.message : String(err));
    }

    // 2. 构造受限 ToolRegistry
    const allowedTools = this.registry.intersectWithParent(spec.role, spec.allowed_tools);
    const scopedRegistry = new ToolRegistry();
    for (const name of allowedTools) {
      const tool = this.fullRegistry.get(name);
      if (tool) {
        try {
          scopedRegistry.register(tool);
        } catch (err) {
          this.logger?.warn('子代理工具注册失败', { tool: name, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // 3. 构造独立 ContextManager（角色系统提示词）
    const systemPrompt = this.registry.getSystemPrompt(spec.role);
    const context = new ContextManager({
      systemPrompt: this.buildFullSystemPrompt(systemPrompt, spec),
      contextWindow: this.provider.config.contextWindow,
      maxOutputTokens: this.provider.config.maxOutputTokens,
    });

    // 4. 构造子代理专用 EventBus（转发到父任务 + 本地跟踪）
    const localEvents = new EventBus(this.logger);
    const evidenceRefs: EvidenceRef[] = [];
    const toolCallHistory: Array<{ name: string; input: JsonValue; result: ToolResult }> = [];

    localEvents.on((event) => {
      // 跟踪资源消耗
      if (event.type === 'tool:end') {
        limiter.checkTimeBudget();
        toolCallHistory.push({ name: event.name, input: { path: '' } as JsonValue, result: event.result });
        const ref = extractEvidenceRef(event.name, event.result);
        if (ref) evidenceRefs.push(ref);
        // 超预算时立即终止
        if (limiter.isExceeded()) controller.abort();
      }
      // 转发给父任务（附加子代理 ID 便于区分）
      if (this.parentEvents) {
        this.parentEvents.emit({
          type: 'notice',
          level: 'info',
          message: `[${spec.subagent_id}:${spec.role}] ${event.type}`,
          ts: Date.now(),
        });
      }
    });

    // 5. 构造受限 ToolDispatcher（共享父任务的安全组件）
    const dispatcher = new ToolDispatcher({
      registry: scopedRegistry,
      settings: this.settings,
      workspace: this.workspace,
      approvals: this.approvals,
      audit: this.audit,
      events: localEvents,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      maxConcurrency: 1, // 子代理内部串行——避免并发失控
      ...(this.logger ? { logger: this.logger } : {}),
    });

    // 6. 构造 AgentLoop
    const loop = new AgentLoop({
      provider: this.provider,
      registry: scopedRegistry,
      dispatcher,
      context,
      events: localEvents,
      sessionId: spec.parent_session_id ?? spec.subagent_id,
      maxIterations: budget.maxIterations,
      onModelRequest: () => {
        limiter.recordIteration();
        if (limiter.isExceeded()) controller.abort();
      },
      onModelUsage: (tokens) => {
        limiter.recordTokens(tokens);
        if (limiter.isExceeded()) controller.abort();
      },
      beforeToolCalls: (count) => {
        const allowed = limiter.reserveToolCalls(count);
        if (!allowed) controller.abort();
        return allowed;
      },
      ...(this.logger ? { logger: this.logger } : {}),
    });

    const budgetTimer = setTimeout(() => {
      const elapsed = Math.round(limiter.snapshot().durationMs);
      limiter.forceExceeded(`执行时间超过预算 ${budget.maxDurationMs}ms（实际 ${elapsed}ms）`);
      controller.abort();
    }, Math.max(1, budget.maxDurationMs));
    budgetTimer.unref?.();

    // 7. 运行 AgentLoop
    const metrics = new MetricsCollector(spec.subagent_id);
    let loopResult;
    try {
      // 在跑之前先检查时间预算
      limiter.checkTimeBudget();
      limiter.assertWithinBudget();

      loopResult = await loop.run(spec.task, { signal: controller.signal, metrics });

      // 跑完后再检查一次（可能刚好超预算）
      limiter.checkTimeBudget();
    } catch (err) {
      clearTimeout(budgetTimer);
      return this.buildFailureResult(
        spec,
        started,
        limiter,
        err instanceof Error ? err.message : String(err),
        toolCallHistory.length,
        evidenceRefs,
      );
    }

    // 8. 检查是否因超预算被终止
    if (limiter.isExceeded()) {
      clearTimeout(budgetTimer);
      return {
        subagent_id: spec.subagent_id,
        role: spec.role,
        success: false,
        status: 'budget_exceeded',
        summary: `子代理超出资源预算：${limiter.getExceededReason()}`,
        failureReason: limiter.getExceededReason(),
        evidence_refs: evidenceRefs,
        usage: {
          tokens: limiter.snapshot().tokensUsed,
          toolCalls: limiter.snapshot().toolCallsUsed,
          durationMs: Date.now() - started,
          iterations: loopResult.iterations,
        },
        loop_reason: loopResult.reason,
      };
    }

    // 9. 构造成功结果
    const success = loopResult.reason === 'completed';
    const cancelled = loopResult.reason === 'aborted';
    clearTimeout(budgetTimer);
    return {
      subagent_id: spec.subagent_id,
      role: spec.role,
      success,
      status: cancelled ? 'cancelled' : success ? 'completed' : 'failed',
      summary: loopResult.text || '(子代理未产出文本结论)',
      failureReason: success ? undefined : `AgentLoop 终止原因: ${loopResult.reason}`,
      evidence_refs: dedupeEvidenceRefs(evidenceRefs),
      usage: {
        tokens: limiter.snapshot().tokensUsed,
        toolCalls: limiter.snapshot().toolCallsUsed,
        durationMs: Date.now() - started,
        iterations: loopResult.iterations,
      },
      loop_reason: loopResult.reason,
    };
  }

  /* ---------------------------------------------------------------- */
  /* 私有辅助                                                          */
  /* ---------------------------------------------------------------- */

  private validateSpec(spec: SubAgentSpec): void {
    if (!this.registry.hasRole(spec.role)) {
      throw new ForgeError('SUBAGENT_ROLE_UNKNOWN', `未注册的子代理角色: ${spec.role}`);
    }
    if (!spec.task || spec.task.trim().length === 0) {
      throw new ForgeError('SUBAGENT_INVALID_SPEC', '子代理任务描述不能为空');
    }
    if (!Array.isArray(spec.allowed_tools)) {
      throw new ForgeError('SUBAGENT_INVALID_SPEC', 'allowed_tools 必须是数组');
    }
  }

  private buildFullSystemPrompt(rolePrompt: string, spec: SubAgentSpec): string {
    const parts: string[] = [rolePrompt];
    if (spec.context) {
      parts.push(`\n\n父任务提供的上下文:\n${spec.context}`);
    }
    if (spec.allowed_tools.length > 0) {
      parts.push(`\n\n你被授予的工具白名单: ${spec.allowed_tools.join(', ')}`);
    } else {
      parts.push(`\n\n你没有被授予任何工具——只能输出文本结论。`);
    }
    return parts.join('');
  }

  private buildFailureResult(
    spec: SubAgentSpec,
    started: number,
    limiter: ResourceLimiter,
    reason: string,
    toolCalls: number = 0,
    evidenceRefs: EvidenceRef[] = [],
  ): SubAgentResult {
    return {
      subagent_id: spec.subagent_id,
      role: spec.role,
      success: false,
      status: limiter.isExceeded() ? 'budget_exceeded' : 'failed',
      summary: `子代理失败：${reason}`,
      failureReason: reason,
      evidence_refs: evidenceRefs,
      usage: {
        tokens: limiter.snapshot().tokensUsed,
        toolCalls,
        durationMs: Date.now() - started,
        iterations: limiter.snapshot().iterationsUsed,
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* 证据提取（工具调用历史 → EvidenceRef）                                */
/* ------------------------------------------------------------------ */

/**
 * 从工具调用结果提取证据引用。
 *
 * 规则：
 *   - read_file / edit_file → code_snippet（source=path）
 *   - grep_search → code_snippet（source=pattern）
 *   - git_diff → git_diff_hunk
 *   - git_status → git_commit
 *   - inspect_process → process_info
 *   - inspect_port → port_check
 *   - read_logs → log_line
 *   - ssh_inspect → custom
 *   - correlate_code_runtime → custom
 *
 * 注意：证据提取只看工具名+结果的"形状"，不解析返回的具体内容——
 * 内容解析是父任务/聚合器的事。
 */
function extractEvidenceRef(toolName: string, result: ToolResult): EvidenceRef | null {
  if (!result.ok) return null; // 失败的工具调用不产生证据

  // 从 result.data 中提取 path/pattern 等关键信息
  const data = result.data;
  if (!data || typeof data !== 'object') return null;

  const record = data as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path : undefined;
  const pattern = typeof record.pattern === 'string' ? record.pattern : undefined;

  switch (toolName) {
    case 'read_file':
    case 'edit_file':
      if (!path) return null;
      return {
        kind: 'code_snippet',
        source: path,
        description: `${toolName} 调用`,
      };
    case 'grep_search':
      if (!pattern) return null;
      return {
        kind: 'code_snippet',
        source: pattern,
        description: 'grep_search 模式匹配',
      };
    case 'git_diff':
      return {
        kind: 'git_diff_hunk',
        source: 'git_diff',
        description: 'Git diff 输出',
      };
    case 'git_status':
      return {
        kind: 'git_commit',
        source: 'git_status',
        description: 'Git status 状态',
      };
    case 'inspect_process':
      return {
        kind: 'process_info',
        source: 'inspect_process',
        description: '进程诊断',
      };
    case 'inspect_port':
      return {
        kind: 'port_check',
        source: 'inspect_port',
        description: '端口检查',
      };
    case 'inspect_disk':
    case 'inspect_memory':
      return {
        kind: 'process_info',
        source: toolName,
        description: '系统资源诊断',
      };
    case 'read_logs':
      return {
        kind: 'log_line',
        source: path ?? 'read_logs',
        description: '日志读取',
      };
    case 'ssh_inspect':
      return {
        kind: 'custom',
        source: 'ssh_inspect',
        description: 'SSH 远程诊断',
      };
    case 'correlate_code_runtime':
      return {
        kind: 'custom',
        source: 'correlate_code_runtime',
        description: '代码运行时关联分析',
      };
    default:
      return null;
  }
}

/** 去重证据引用（同 kind + source 视为重复） */
function dedupeEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 辅助：从 ContextManager 估算 token（备用，未来可被事件替代）            */
/* ------------------------------------------------------------------ */

/** 估算一组消息的 token 数（备用 API） */
export function estimateContextTokens(messages: ReadonlyArray<ChatMessage>): number {
  return estimateMessagesTokens([...messages]);
}

/* 类型守卫：RegisteredTool 重导出便于测试 */
export type { RegisteredTool };
