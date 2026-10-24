/**
 * Sub-Agent 类型定义（v0.3.0 Phase 2）。
 *
 * 设计原则：
 *   1. 纯类型文件，零外部运行时依赖（只 import @forgex/shared 的 uuid）；
 *   2. 所有字段可 JSON 序列化，便于审计与测试断言；
 *   3. 子代理是"受限的执行单元"——只允许跑指定角色、用白名单工具、
 *      在预算内跑、产出结构化结果；
 *   4. 权限收敛规则：子代理的 allowed_tools 必须是父任务 allowed_tools 的子集，
 *      由 DelegationManager 在分派前强制检查；
 *   5. 不允许递归：子代理不能再分派新的子代理（Phase 2 硬约束）。
 */
import { uuid } from '@forgex/shared';
import type { EvidenceRef } from '../planning/types.js';

/* ------------------------------------------------------------------ */
/* SubAgentRole                                                        */
/* ------------------------------------------------------------------ */

/**
 * 子代理的预定义角色。
 *
 * 每个角色有固定的：
 *   - 系统提示词模板（强调职责边界）
 *   - 默认工具白名单（白名单之外的工具该角色拿不到）
 *   - 默认预算（可被 spec 覆盖，但不能超过硬上限）
 */
export const SUBAGENT_ROLES = ['explorer', 'debugger', 'reviewer', 'worker'] as const;
export type SubAgentRole = (typeof SUBAGENT_ROLES)[number];

/** 角色定位（描述给上层 / 审计看） */
export const ROLE_DESCRIPTIONS: Record<SubAgentRole, string> = {
  explorer: '代码探索与信息收集：只读扫描、grep、定位文件与符号，不修改任何文件',
  debugger: '运行时诊断：只读日志/进程/端口/容器检查，定位问题根因，不修改任何状态',
  reviewer: '变更审查：读取 diff 与代码、产出审查意见，不直接落盘修改',
  worker: '执行具体修改/命令：可读可写可跑命令，但仅在父任务白名单内',
};

/* ------------------------------------------------------------------ */
/* SubAgentBudget                                                      */
/* ------------------------------------------------------------------ */

/**
 * 子代理的资源预算（硬上限）。
 *
 * 所有预算字段都是可选的——不设置表示该项不限制（但仍受系统硬上限约束，
 * 见 resource-limiter.ts）。
 */
export interface SubAgentBudget {
  /** 最大 token 消耗（prompt + completion），缺省 50_000 */
  maxTokens?: number;
  /** 最大工具调用次数，缺省 30 */
  maxToolCalls?: number;
  /** 最长执行时间（毫秒），缺省 5 分钟 */
  maxDurationMs?: number;
  /** AgentLoop 最大迭代次数（模型请求轮数），缺省 8 */
  maxIterations?: number;
}

/** 系统硬上限（无论 spec 怎么配都不能超过） */
export const HARD_BUDGET_LIMITS: Required<SubAgentBudget> = {
  maxTokens: 200_000,
  maxToolCalls: 100,
  maxDurationMs: 15 * 60 * 1000, // 15 分钟
  maxIterations: 20,
};

/** 默认预算（spec 未指定时使用） */
export const DEFAULT_BUDGET: Required<SubAgentBudget> = {
  maxTokens: 50_000,
  maxToolCalls: 30,
  maxDurationMs: 5 * 60 * 1000, // 5 分钟
  maxIterations: 8,
};

/** 合并预算：spec 覆盖默认，但每项都不得超过硬上限 */
export function resolveBudget(spec?: SubAgentBudget): Required<SubAgentBudget> {
  const merged: Required<SubAgentBudget> = {
    maxTokens: spec?.maxTokens ?? DEFAULT_BUDGET.maxTokens,
    maxToolCalls: spec?.maxToolCalls ?? DEFAULT_BUDGET.maxToolCalls,
    maxDurationMs: spec?.maxDurationMs ?? DEFAULT_BUDGET.maxDurationMs,
    maxIterations: spec?.maxIterations ?? DEFAULT_BUDGET.maxIterations,
  };
  return {
    maxTokens: Math.min(merged.maxTokens, HARD_BUDGET_LIMITS.maxTokens),
    maxToolCalls: Math.min(merged.maxToolCalls, HARD_BUDGET_LIMITS.maxToolCalls),
    maxDurationMs: Math.min(merged.maxDurationMs, HARD_BUDGET_LIMITS.maxDurationMs),
    maxIterations: Math.min(merged.maxIterations, HARD_BUDGET_LIMITS.maxIterations),
  };
}

/* ------------------------------------------------------------------ */
/* SubAgentSpec                                                        */
/* ------------------------------------------------------------------ */

/**
 * 子代理的任务说明书。
 *
 * 由父任务（TaskPlanner / 主 Agent）在分派前构造。
 * 关键字段：
 *   - role / task 必填
 *   - allowed_tools 必填（可为空数组——表示不允许任何工具）
 *   - context 可选（父任务已收集的证据/路径，避免子代理重复搜索）
 */
export interface SubAgentSpec {
  /** 任务唯一 ID */
  subagent_id: string;
  /** 角色 */
  role: SubAgentRole;
  /** 自然语言任务描述（作为用户消息发给子代理） */
  task: string;
  /** 允许使用的工具名白名单（必须 ⊆ 父任务的 allowed_tools） */
  allowed_tools: string[];
  /** 资源预算（可选，超出硬上限会被 clip） */
  budget?: SubAgentBudget;
  /** 父任务提供的上下文摘要（代码片段、路径、错误日志等） */
  context?: string;
  /** 父任务 ID（审计溯源用） */
  parent_task_id?: string;
  /** 父任务中的 step_id（审计溯源用） */
  parent_step_id?: string;
  /** 父 Agent 的 sessionId（同一逻辑会话，审计便于关联） */
  parent_session_id?: string;
  /** 创建时间 ISO */
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* SubAgentResult                                                      */
/* ------------------------------------------------------------------ */

/**
 * 子代理执行结束后的结构化结果。
 *
 * 必须满足：
 *   - 无论成功失败都返回（不抛异常给父任务）
 *   - evidence_refs 至少包含支撑结论的最小证据集合
 *   - 预算消耗完整记录，供父任务做成本归因
 */
export interface SubAgentResult {
  /** 对应 SubAgentSpec.subagent_id */
  subagent_id: string;
  /** 角色（冗余存储，便于聚合时按角色分组） */
  role: SubAgentRole;
  /** 执行是否成功 */
  success: boolean;
  /** 最终状态 */
  status: 'completed' | 'failed' | 'cancelled' | 'budget_exceeded';
  /** 给父任务看的结论摘要（必填，即使失败也要写失败原因） */
  summary: string;
  /** 详细产出（角色相关：explorer 是文件列表、debugger 是诊断报告、reviewer 是意见） */
  findings?: string;
  /** 支撑结论的证据引用 */
  evidence_refs: EvidenceRef[];
  /** 实际资源消耗 */
  usage: {
    tokens: number;
    toolCalls: number;
    durationMs: number;
    iterations: number;
  };
  /** 失败原因（success=false 时必填） */
  failureReason?: string;
  /** 父 AgentLoop 的终止原因（透传，便于上层诊断） */
  loop_reason?: string;
}

/* ------------------------------------------------------------------ */
/* DelegationTask / DelegationState                                    */
/* ------------------------------------------------------------------ */

/** 一次分派的内部状态（DelegationManager 用） */
export interface DelegationState {
  spec: SubAgentSpec;
  /** 当前状态 */
  status: 'queued' | 'running' | 'finished';
  /** 完成后的结果（status=finished 时填充） */
  result?: SubAgentResult;
  /** 内部 AbortController（父任务取消时传播） */
  controller: AbortController;
  /** 排队时间 */
  queued_at: number;
  /** 开始执行时间 */
  started_at?: number;
  /** 结束时间 */
  finished_at?: number;
}

/* ------------------------------------------------------------------ */
/* 工厂函数                                                            */
/* ------------------------------------------------------------------ */

/** 生成新的 subagent_id（格式：sub_ + 8 位 hex） */
export function newSubAgentId(): string {
  return `sub_${uuid().replace(/-/g, '').slice(0, 8)}`;
}

/** 当前 UTC ISO */
export function nowIsoSub(): string {
  return new Date().toISOString();
}

/**
 * 构造 SubAgentSpec。
 * 调用方必须提供 role / task / allowed_tools；其他字段可选。
 */
export function createSubAgentSpec(params: {
  role: SubAgentRole;
  task: string;
  allowed_tools: string[];
  budget?: SubAgentBudget;
  context?: string;
  parent_task_id?: string;
  parent_step_id?: string;
  parent_session_id?: string;
}): SubAgentSpec {
  return {
    subagent_id: newSubAgentId(),
    role: params.role,
    task: params.task,
    allowed_tools: [...params.allowed_tools],
    ...(params.budget ? { budget: params.budget } : {}),
    ...(params.context ? { context: params.context } : {}),
    ...(params.parent_task_id ? { parent_task_id: params.parent_task_id } : {}),
    ...(params.parent_step_id ? { parent_step_id: params.parent_step_id } : {}),
    ...(params.parent_session_id ? { parent_session_id: params.parent_session_id } : {}),
    created_at: nowIsoSub(),
  };
}

/**
 * 判断 role 是否合法（运行时守卫，防止 LLM 生成的字符串注入）。
 */
export function isSubAgentRole(value: unknown): value is SubAgentRole {
  return typeof value === 'string' && (SUBAGENT_ROLES as readonly string[]).includes(value);
}

/**
 * 权限收敛校验：子代理的工具白名单必须是父任务白名单的子集。
 * 返回越权的工具列表（空数组表示合法）。
 */
export function findOutOfScopeTools(childTools: ReadonlyArray<string>, parentTools: ReadonlyArray<string>): string[] {
  const parentSet = new Set(parentTools);
  return childTools.filter((tool) => !parentSet.has(tool));
}
