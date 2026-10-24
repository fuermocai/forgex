/**
 * Workflow Engine 类型定义（v0.4.0 Phase 1）。
 *
 * 设计原则：
 *   1. 纯类型文件，零外部运行时依赖（只 import @forgex/shared 的 uuid 工具）；
 *   2. 所有字段可 JSON 序列化（无 Date 对象、无 Map、无 undefined），
 *      便于 WorkflowCheckpoint 用 node:sqlite 直接持久化；
 *   3. WorkflowNodeStatus 提供显式状态机转移表 + 验证函数，
 *      后续模块统一调用，避免各处手写 if/switch 产生不一致；
 *   4. 复用 v0.3.0 TaskStep 的设计思路，但不直接继承——工作流节点是
 *      更上层的编排单元，task 节点执行时才映射到 TaskStep。
 *
 * 与 v0.3.0 Task Planner 的关系：
 *   - WorkflowNode.type === 'task' 的节点会被 WorkflowRunner 转为
 *     TaskStep 并交给 TaskPlanner 执行；
 *   - 其他节点类型（approval / condition / verification）由
 *     WorkflowRunner 直接处理，不经过 TaskPlanner。
 */
import { uuid } from '@forgex/shared';

/* ------------------------------------------------------------------ */
/* 节点类型                                                             */
/* ------------------------------------------------------------------ */

/**
 * 工作流节点类型。
 *   task         — 普通任务节点，执行时映射到 TaskPlanner.TaskStep
 *   approval     — 人工审批节点，执行时调用 ApprovalManager.request 阻塞
 *   condition    — 条件分支节点，根据上一节点结果选择后续分支
 *   verification — 验证节点，必须执行且通过后工作流才能 completed
 */
export type WorkflowNodeType = 'task' | 'approval' | 'condition' | 'verification';

export const WORKFLOW_NODE_TYPES: readonly WorkflowNodeType[] = [
  'task',
  'approval',
  'condition',
  'verification',
];

/* ------------------------------------------------------------------ */
/* WorkflowNodeStatus 状态机                                            */
/* ------------------------------------------------------------------ */

/**
 * 工作流节点的生命周期状态。
 *
 * 合法转换（箭头表示 from → to）：
 *
 *   pending ──→ running ──→ completed
 *      │          │   │
 *      │          │   └──→ failed ──→ running（重试预算内）
 *      │          │
 *      │          └──→ blocked ──→ running（阻塞解除）
 *      │          │
 *      │          └──→ cancelled
 *      │
 *      └──→ cancelled
 *
 * 终态：completed、cancelled（不可再转出）。
 *
 * 注意：复用 v0.3.0 StepExecutor 修复经验——禁止 running → ready 直跳。
 * 工作流节点没有 ready 态，pending 直接到 running。
 */
export const WORKFLOW_NODE_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled',
] as const;

export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

/** 终态集合 */
export const WORKFLOW_TERMINAL_STATUSES: ReadonlySet<WorkflowNodeStatus> = new Set([
  'completed',
  'cancelled',
]);

/**
 * 合法状态转移表。
 * key = 当前状态，value = 可以转移到的目标状态集合。
 */
const WORKFLOW_TRANSITIONS: Record<WorkflowNodeStatus, ReadonlySet<WorkflowNodeStatus>> = {
  pending: new Set<WorkflowNodeStatus>(['running', 'cancelled', 'blocked']),
  running: new Set<WorkflowNodeStatus>(['completed', 'failed', 'blocked', 'cancelled']),
  completed: new Set<WorkflowNodeStatus>([]),
  failed: new Set<WorkflowNodeStatus>(['running', 'cancelled']),
  blocked: new Set<WorkflowNodeStatus>(['running', 'cancelled']),
  cancelled: new Set<WorkflowNodeStatus>([]),
};

/**
 * 判断 from → to 是否为合法转移。
 * 纯函数，无副作用，可直接测试。
 */
export function isValidWorkflowTransition(from: WorkflowNodeStatus, to: WorkflowNodeStatus): boolean {
  if (from === to) return true; // 允许原地不变（幂等）
  return WORKFLOW_TRANSITIONS[from].has(to);
}

/** 获取一个状态允许的所有目标状态（调试 / UI 展示用） */
export function allowedWorkflowTransitions(from: WorkflowNodeStatus): ReadonlyArray<WorkflowNodeStatus> {
  return [...WORKFLOW_TRANSITIONS[from]];
}

/** 状态是否已进入终态 */
export function isWorkflowTerminal(status: WorkflowNodeStatus): boolean {
  return WORKFLOW_TERMINAL_STATUSES.has(status);
}

/* ------------------------------------------------------------------ */
/* 工作流整体状态                                                        */
/* ------------------------------------------------------------------ */

/**
 * 工作流整体状态（所有节点状态的折叠结果）。
 *   running     — 有节点在执行
 *   blocked     — 有节点被阻塞
 *   pending     — 还没开始或进行中
 *   completed   — 全部完成
 *   failed      — 有节点失败且无法继续
 *   cancelled   — 被取消
 */
export type WorkflowState = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

/* ------------------------------------------------------------------ */
/* WorkflowNode                                                         */
/* ------------------------------------------------------------------ */

/**
 * 工作流节点。
 *
 * 一个 WorkflowDefinition 包含多个 WorkflowNode，节点之间通过
 * dependencies 形成 DAG。
 */
export interface WorkflowNode {
  /** 节点唯一 ID */
  id: string;
  /** 节点名称（给人看） */
  name: string;
  /** 节点类型 */
  type: WorkflowNodeType;
  /** 节点描述（给模型当 prompt 的） */
  description: string;
  /** 依赖的其他节点 ID 列表（空数组表示无依赖，就绪即可执行） */
  dependencies: string[];
  /** 是否为强制节点（不可跳过，如 Test、Review） */
  mandatory: boolean;
  /**
   * 是否幂等（恢复时是否可安全重跑）。
   * true  = 重跑不会产生额外副作用（如读文件、跑测试）
   * false = 重跑可能产生副作用（如写数据库、发通知），恢复时需人工确认
   */
  idempotent: boolean;
  /** 该节点需要的工具名（task 类型节点映射到 TaskStep.required_tools） */
  required_tools?: string[];
  /** 节点风险等级（影响审批策略） */
  risk_level?: 'read' | 'modify' | 'run' | 'deploy' | 'critical';
  /** 重试预算上限（默认 2） */
  max_attempts?: number;
  /** 条件分支节点的条件表达式（condition 类型节点使用） */
  condition?: string;
  /** 当前状态 */
  status: WorkflowNodeStatus;
  /** 执行尝试次数 */
  attempts: number;
  /** 执行结果（完成后由 WorkflowRunner 填充） */
  result?: WorkflowNodeResult;
  /** 阻塞原因（status=blocked 时必填） */
  block_reason?: string;
  /** 创建时间 ISO */
  created_at: string;
  /** 最后更新时间 ISO */
  updated_at: string;
}

/** 节点执行结果（可 JSON 序列化） */
export interface WorkflowNodeResult {
  /** 执行是否成功 */
  success: boolean;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 总 token 消耗（估算） */
  tokenUsage?: number;
  /** 实际耗时毫秒 */
  durationMs: number;
  /** 验证结果（verification 节点） */
  verificationPassed?: boolean;
  /** 失败原因 */
  failureReason?: string;
  /** 最终摘要（给用户看） */
  summary?: string;
  /** 条件分支结果（condition 节点：选择的分支节点 ID） */
  branch?: string;
}

/* ------------------------------------------------------------------ */
/* WorkflowDefinition                                                   */
/* ------------------------------------------------------------------ */

/**
 * 工作流定义——静态结构，不含运行时状态。
 *
 * 一个 WorkflowDefinition = 一组 WorkflowNode + 元数据。
 * 节点之间通过 dependencies 形成 DAG。
 */
export interface WorkflowDefinition {
  /** 工作流唯一 ID */
  id: string;
  /** 工作流名称 */
  name: string;
  /** 工作流描述 */
  description: string;
  /** 版本号（用于检查点兼容性校验） */
  version: number;
  /** 全部节点 */
  nodes: WorkflowNode[];
  /** 工作流级别元数据 */
  metadata?: {
    /** 适用场景标签 */
    tags?: string[];
    /** 最大步骤数（防止无限循环） */
    maxSteps?: number;
    [key: string]: unknown;
  };
}

/* ------------------------------------------------------------------ */
/* WorkflowExecutionReport（执行报告）                                  */
/* ------------------------------------------------------------------ */

/** 工作流执行报告 */
export interface WorkflowExecutionReport {
  /** 工作流实例 ID */
  workflowInstanceId: string;
  /** 工作流定义 ID */
  workflowId: string;
  /** 工作流定义版本 */
  version: number;
  /** 工作流整体状态 */
  state: WorkflowState;
  /** 总节点数 */
  totalNodes: number;
  /** 已完成节点数 */
  completedNodes: number;
  /** 失败节点数 */
  failedNodes: number;
  /** 被取消节点数 */
  cancelledNodes: number;
  /** 总耗时毫秒 */
  durationMs: number;
  /** 各节点执行结果摘要 */
  nodeResults: Array<{
    nodeId: string;
    nodeName: string;
    nodeType: WorkflowNodeType;
    status: WorkflowNodeStatus;
    attempts: number;
    durationMs?: number;
    success?: boolean;
    failureReason?: string;
  }>;
  /** 错误信息（如有） */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* WorkflowCheckpointRecord（可 JSON 序列化，直接落 SQLite）            */
/* ------------------------------------------------------------------ */

/**
 * 工作流检查点——崩溃恢复用。
 *
 * 每个 workflowInstanceId 对应唯一记录；WorkflowRunner 在每个节点
 * 状态变化时调用 save()，恢复时从 nodes 里找第一个未终态节点继续。
 */
export interface WorkflowCheckpointRecord {
  /** 工作流实例 ID */
  workflow_instance_id: string;
  /** 工作流定义 ID */
  workflow_id: string;
  /** 工作流定义版本（恢复时校验兼容性） */
  workflow_version: number;
  /** 快照生成时间 */
  snapshot_at: string;
  /** 全部节点（含状态） */
  nodes: WorkflowNode[];
  /** 工作流整体状态 */
  state: WorkflowState;
  /** 已完成节点 ID 集合（恢复时跳过） */
  completed_node_ids: string[];
  /** 当前正在执行的节点 ID（有且仅有一个 running 态） */
  running_node_id?: string;
  /** 失败节点 ID 集合（恢复时根据重试预算决定是否重跑） */
  failed_node_ids: string[];
}

/* ------------------------------------------------------------------ */
/* 工厂函数                                                             */
/* ------------------------------------------------------------------ */

/** 生成新的工作流实例 ID */
export function newWorkflowInstanceId(): string {
  return `wf_${uuid().replace(/-/g, '').slice(0, 8)}`;
}

/** 生成新的节点 ID */
export function newWorkflowNodeId(): string {
  return `node_${uuid().replace(/-/g, '').slice(0, 8)}`;
}

/** 当前 UTC 时间 ISO */
export function workflowNowIso(): string {
  return new Date().toISOString();
}

/**
 * 构造一个 pending 态的新节点（默认值填充）。
 * id / name / type / description 必须由调用方提供。
 */
export function createWorkflowNode(params: {
  id?: string;
  name: string;
  type: WorkflowNodeType;
  description: string;
  dependencies?: string[];
  mandatory?: boolean;
  idempotent?: boolean;
  required_tools?: string[];
  risk_level?: WorkflowNode['risk_level'];
  max_attempts?: number;
  condition?: string;
}): WorkflowNode {
  const now = workflowNowIso();
  return {
    id: params.id ?? newWorkflowNodeId(),
    name: params.name,
    type: params.type,
    description: params.description,
    dependencies: params.dependencies ?? [],
    mandatory: params.mandatory ?? (params.type === 'verification'),
    idempotent: params.idempotent ?? (params.type === 'task' || params.type === 'verification'),
    required_tools: params.required_tools,
    risk_level: params.risk_level,
    max_attempts: params.max_attempts ?? 2,
    condition: params.condition,
    status: 'pending',
    attempts: 0,
    created_at: now,
    updated_at: now,
  };
}

/**
 * 根据节点状态折叠整个工作流的整体状态。
 *   - 有 running  → running
 *   - 有 blocked  → blocked
 *   - 有 pending  → pending（还没开始或进行中）
 *   - 全部 completed → completed
 *   - 有 failed 且其他都终态 → failed
 *   - 全部 cancelled → cancelled
 *
 * 纯函数，WorkflowRunner 和恢复逻辑都调用它。
 */
export function computeWorkflowState(nodes: ReadonlyArray<WorkflowNode>): WorkflowState {
  if (nodes.length === 0) return 'completed';

  const counts: Record<WorkflowNodeStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const n of nodes) counts[n.status]++;
  const total = nodes.length;

  if (counts.running > 0) return 'running';
  if (counts.blocked > 0) return 'blocked';
  // 有失败节点 → 工作流失败
  if (counts.failed > 0) return 'failed';
  // 有取消节点且不是全部取消 → 工作流因取消而失败（如审批拒绝）
  if (counts.cancelled > 0 && counts.cancelled < total) return 'failed';
  // 全部取消 → 工作流被取消
  if (counts.cancelled === total) return 'cancelled';
  // 还有 pending 节点且无失败/取消 → 进行中
  if (counts.pending > 0) return 'pending';
  // 全部完成
  if (counts.completed === total) return 'completed';

  return 'pending'; // 兜底（极端混合态）
}
