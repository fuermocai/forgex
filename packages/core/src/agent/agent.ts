/**
 * Agent：对外门面（Facade）。
 *
 * 职责：
 *  - 组装 Runtime 各组件（EventBus / ContextManager / ToolDispatcher / AgentLoop）；
 *  - 管理会话生命周期（创建、恢复、持久化）；
 *  - 每轮运行结束后产出性能指标并落库；
 *  - 对上层（CLI/TUI）只暴露 run() / events / sessionId。
 *
 * 依赖注入：所有协作者均由调用方传入，不使用全局单例，
 * 便于测试（可注入假模型、临时数据库、只读策略）。
 */
import {
  ForgeError,
  sessionId as newSessionId,
  takeChars,
  type ChatMessage,
  type Logger,
  type PermissionMode,
  type PolicySettings,
  type RunMetrics,
} from '@forgex/shared';
import type { ModelProvider } from '@forgex/models';
import type { ToolRegistry } from '@forgex/tools';
import type { ApprovalManager, AuditLogger, WorkspaceGuard } from '@forgex/security';
import { AgentLoop, type LoopResult } from './agent-loop.js';
import { buildSystemPrompt } from './system-prompt.js';
import { ContextManager } from '../context/context-manager.js';
import { EventBus } from '../events/event-bus.js';
import { MetricsCollector } from '../runtime/metrics.js';
import { ToolDispatcher } from '../runtime/tool-dispatcher.js';
import type { SessionStore } from '../session/session-store.js';

/** 计划模式追加在系统提示词末尾的约束（安全边界，不可由模型改写） */
const PLAN_MODE_PROMPT = [
  '# 当前模式：计划模式（只读）',
  '你处于计划模式，必须先规划再动手，本轮禁止任何写操作：',
  '- 允许：read_file / list_directory / grep_search / git_status / git_diff 等只读工具；',
  '- 禁止：edit_file、run_command 以及任何会修改文件或执行命令的工具（调用会被策略拒绝）；',
  '- 输出结构：先给出「现状判断」，再给出编号的分步计划（每步说明改哪个文件、改什么、如何验证），',
  '  最后给出「风险与待确认项」。',
  '- 计划完成后停下来等待用户确认，不要假装已经执行。',
].join('\n');


export interface AgentOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  settings: PolicySettings;
  workspace: WorkspaceGuard;
  approvals: ApprovalManager;
  audit: AuditLogger;
  /** 会话持久化；缺省时为纯内存模式（测试/一次性任务） */
  store?: SessionStore;
  /** 指定会话 id 时尝试恢复该会话 */
  sessionId?: string;
  /** 相对路径基准与工具默认 cwd */
  cwd?: string;
  /** 覆盖默认系统提示词（一般不需要） */
  systemPrompt?: string;
  maxIterations?: number;
  maxConcurrency?: number;
  logger?: Logger;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  /**
   * 本轮运行的严格工具白名单（v0.5.0 P3 加固）。
   * 让模型只能在这个工具集合里选择，不在集合里的工具连调用尝试都会被事前拒绝。
   * 不传 = 不做过滤（默认行为，全 registry 可见）。
   */
  allowedTools?: ReadonlySet<string>;
}
export interface AgentRunResult extends LoopResult {
  sessionId: string;
  metrics: RunMetrics;
}

export class Agent {
  readonly sessionId: string;
  readonly events: EventBus;

  private provider: ModelProvider;
  private readonly settings: PolicySettings;
  /** 未叠加计划模式提示词的基础系统提示（切换计划模式时用于还原） */
  private readonly baseSystemPrompt: string;
  private readonly context: ContextManager;
  private readonly loop: AgentLoop;
  /** 公共只读：CLI 层质量门禁等需要直接走 ToolDispatcher 执行工具（绕开 AgentLoop，保持确定性） */
  readonly dispatcher: ToolDispatcher;
  private readonly store: SessionStore | undefined;
  private readonly logger: Logger | undefined;
  /** 当前轮次的指标收集器（审批回调需要） */
  private activeMetrics: MetricsCollector | null = null;
  private firstRun = true;
  private planMode = false;
  /** 进入计划模式前的权限模式，退出时还原 */
  private modeBeforePlan: PermissionMode | null = null;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.settings = options.settings;
    this.logger = options.logger;
    this.store = options.store;
    this.events = new EventBus(options.logger);

    const workspaceRoot = options.settings.workspaceRoots[0] ?? options.cwd ?? process.cwd();
    this.sessionId = options.sessionId ?? newSessionId();

    // 会话：存在则恢复，不存在则创建（指定 id 也允许用于固定会话）
    let restored: ChatMessage[] = [];
    if (this.store) {
      const existing = this.store.getSession(this.sessionId);
      if (!existing) {
        this.store.createSession({
          id: this.sessionId,
          workspace: workspaceRoot,
          model: options.provider.config.model,
        });
      } else {
        restored = this.store.getMessages(this.sessionId);
      }
    }

    const systemPrompt =
      options.systemPrompt ??
      buildSystemPrompt({
        workspaceRoot,
        permissionMode: options.settings.mode,
        toolNames: options.registry.names(),
        platform: process.platform,
      });
    this.baseSystemPrompt = systemPrompt;

    this.context = new ContextManager({
      systemPrompt,
      contextWindow: options.provider.config.contextWindow,
      maxOutputTokens: options.provider.config.maxOutputTokens,
    });
    if (restored.length > 0) {
      this.context.replace(restored);
      this.logger?.info('恢复会话', { sessionId: this.sessionId, messages: restored.length });
    }

    this.dispatcher = new ToolDispatcher({
      registry: options.registry,
      settings: options.settings,
      workspace: options.workspace,
      approvals: options.approvals,
      audit: options.audit,
      events: this.events,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.maxConcurrency ? { maxConcurrency: options.maxConcurrency } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      onApproval: () => this.activeMetrics?.recordApproval(),
    });

    this.loop = new AgentLoop({
      provider: options.provider,
      registry: options.registry,
      dispatcher: this.dispatcher,
      context: this.context,
      events: this.events,
      sessionId: this.sessionId,
      ...(options.maxIterations ? { maxIterations: options.maxIterations } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      persistMessage: (message) => this.persist(message),
    });
  }

  /**
   * 执行一轮对话。
   * 不会抛异常：模型失败、取消、工具异常都会转换为 LoopResult.reason。
   */
  async run(userText: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    if (!userText.trim()) {
      throw new ForgeError('CONFIG_INVALID', '用户输入不能为空');
    }

    const started = Date.now();
    const metrics = new MetricsCollector(this.sessionId);
    this.activeMetrics = metrics;

    if (this.firstRun) {
      this.firstRun = false;
      this.events.emit({ type: 'session:start', sessionId: this.sessionId, ts: Date.now() });
    }

    // 用第一个用户输入生成会话标题，便于 sessions 列表识别
    if (this.store) {
      const session = this.store.getSession(this.sessionId);
      if (session && !session.title) {
        this.store.updateSession(this.sessionId, { title: takeChars(userText.replace(/\s+/g, ' ').trim(), 60) });
      }
    }

    const signal = options.signal ?? new AbortController().signal;
    const result = await this.loop.run(userText, { signal, metrics, allowedTools: options.allowedTools });

    const snapshot = metrics.finish(started, result.iterations);
    this.activeMetrics = null;

    this.events.emit({ type: 'turn:end', reason: result.reason, ts: Date.now() });
    this.events.emit({ type: 'metrics', metrics: snapshot, ts: Date.now() });

    try {
      this.store?.recordMetrics(this.sessionId, snapshot);
    } catch (err) {
      // 指标落库失败不影响本轮结果，但必须留下日志
      this.logger?.error('指标写入失败', { error: err instanceof Error ? err.message : String(err) });
    }

    return { ...result, sessionId: this.sessionId, metrics: snapshot };
  }

  /** 当前上下文估算（供 CLI 状态栏使用） */
  contextTokens(): number {
    return this.context.estimatedTokens();
  }

  /** 当前上下文的只读快照（供 CLI / 测试断言） */
  messages(): ReadonlyArray<ChatMessage> {
    return this.context.raw;
  }

  /** 模型名称（供 UI 展示） */
  get modelName(): string {
    return this.provider.config.model;
  }

  /** 当前权限模式（计划模式开启时为 readonly） */
  get permissionMode(): PermissionMode {
    return this.settings.mode;
  }

  /** 是否处于计划模式 */
  get isPlanMode(): boolean {
    return this.planMode;
  }

  /**
   * 运行时切换模型。
   * 只替换 Provider 与上下文预算，不重建会话，历史消息全部保留。
   */
  setProvider(provider: ModelProvider): void {
    this.provider = provider;
    this.loop.setProvider(provider);
    this.context.setLimits(provider.config.contextWindow, provider.config.maxOutputTokens);
    this.store?.updateSession(this.sessionId, { model: provider.config.model });
    this.logger?.info('切换模型', { sessionId: this.sessionId, model: provider.config.model });
  }

  /**
   * 计划模式开关。
   *
   * 开启时同时做两件事（缺一不可）：
   *  1. 权限模式强制为 readonly —— 即使模型执意调用 edit_file/run_command 也会被策略拒绝；
   *  2. 系统提示词追加"只输出计划、不执行修改"的约束 —— 让模型主动先规划。
   * 关闭时还原进入前的权限模式。
   */
  setPlanMode(enabled: boolean): void {
    if (enabled === this.planMode) return;
    this.planMode = enabled;

    if (enabled) {
      this.modeBeforePlan = this.settings.mode;
      this.settings.mode = 'readonly';
    } else if (this.modeBeforePlan !== null) {
      this.settings.mode = this.modeBeforePlan;
      this.modeBeforePlan = null;
    }

    this.context.setSystemPrompt(enabled ? `${this.baseSystemPrompt}\n\n${PLAN_MODE_PROMPT}` : this.baseSystemPrompt);
    this.events.emit({
      type: 'notice',
      level: 'info',
      message: enabled
        ? '已进入计划模式：只读分析并输出计划，修改文件/执行命令会被策略拒绝'
        : `已退出计划模式：权限恢复为 ${this.settings.mode}`,
      ts: Date.now(),
    });
  }

  /**
   * 运行时直接设置权限模式（TUI 的 Shift+Tab 与 `/mode`、纯文本模式的 `/mode` 都走这里）。
   *
   * 关键点：如果当前处于计划模式，先真正退出计划模式再落目标权限。
   * 否则 `settings.mode` 会被计划模式的 readonly 残留覆盖，用户以为切到了 trusted
   * 实际仍然只读——这类"看起来切了但没生效"的安全配置差异必须避免。
   * 与 setPlanMode 一样发 notice，TUI / 纯文本两种渲染都能立刻看到结果。
   */
  setPermissionMode(mode: PermissionMode): void {
    const wasPlan = this.planMode;
    if (wasPlan) {
      this.planMode = false;
      this.modeBeforePlan = null;
      this.context.setSystemPrompt(this.baseSystemPrompt);
    }

    const previous = this.settings.mode;
    this.settings.mode = mode;
    if (!wasPlan && previous === mode) return;

    this.events.emit({
      type: 'notice',
      level: mode === 'yolo' ? 'warn' : 'info',
      message: wasPlan
        ? `已退出计划模式，权限模式切换为 ${mode}`
        : `权限模式已切换：${previous} → ${mode}`,
      ts: Date.now(),
    });
  }

  private persist(message: ChatMessage): void {
    if (!this.store) return;
    try {
      this.store.appendMessage(this.sessionId, message);
    } catch (err) {
      // 持久化失败不能中断推理，否则用户会丢失已完成的工具结果
      this.logger?.error('会话消息写入失败', {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.events.emit({
        type: 'notice',
        level: 'error',
        message: '会话消息持久化失败，本次对话可能无法完整恢复',
        ts: Date.now(),
      });
    }
  }
}
