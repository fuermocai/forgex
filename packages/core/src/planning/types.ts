/**
 * Task Planning 类型定义（v0.3.0 Phase 1）。
 *
 * 本文件是 Phase 1 的基石——所有 planning 子模块（PlanManager /
 * CheckpointManager / DependencyScheduler / StepExecutor / TaskVerifier /
 * TaskPlanner）都 import 这里的类型。
 *
 * 设计原则：
 *   1. 纯类型文件，零外部运行时依赖（只 import @forgex/shared 的 uuid 工具）；
 *   2. 所有字段可 JSON 序列化（无 Date 对象、无 Map、无 undefined），
 *      便于 CheckpointManager 用 node:sqlite 直接持久化；
 *   3. TaskStatus 提供显式状态机转移表 + 验证函数，后续模块统一调用，
 *      避免各处手写 if/switch 产生不一致；
 *   4. 不引入 zod schema——本层是领域模型，校验留给 PlanManager / StepExecutor
 *      的运行时逻辑。
 */
import { uuid } from '@forgex/shared';

/* ------------------------------------------------------------------ */
/* TaskStatus 状态机                                                    */
/* ------------------------------------------------------------------ */

/**
 * 任务 / 步骤的生命周期状态。
 *
 * 合法转换（箭头表示 from → to）：
 *
 *   pending ──→ ready ──→ running ──→ completed
 *      │          │          │   │
 *      │          │          │   └──→ failed ──→ ready（重试预算内）
 *      │          │          │
 *      │          │          └──→ blocked ──→ ready（阻塞解除）
 *      │          │
 *      │          └──→ blocked / cancelled
 *      │
 *      └──→ cancelled
 *
 * 终态：completed、cancelled（不可再转出）。
 */
export const TASK_STATUSES = [
  'pending',
  'ready',
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 状态是否属于终态 */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'cancelled']);

/**
 * 合法状态转移表。
 * key = 当前状态，value = 可以转移到的目标状态集合。
 */
const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set<TaskStatus>(['ready', 'cancelled', 'blocked']),
  ready: new Set<TaskStatus>(['running', 'cancelled', 'blocked']),
  running: new Set<TaskStatus>(['completed', 'failed', 'blocked', 'cancelled']),
  completed: new Set<TaskStatus>([]),
  failed: new Set<TaskStatus>(['ready', 'cancelled']),
  blocked: new Set<TaskStatus>(['ready', 'cancelled']),
  cancelled: new Set<TaskStatus>([]),
};

/**
 * 判断 from → to 是否为合法转移。
 * 纯函数，无副作用，可直接测试。
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true; // 允许原地不变（幂等）
  return TRANSITIONS[from].has(to);
}

/** 获取一个状态允许的所有目标状态（调试 / UI 展示用） */
export function allowedTransitions(from: TaskStatus): ReadonlyArray<TaskStatus> {
  return [...TRANSITIONS[from]];
}

/** 状态是否已进入终态（执行器和恢复逻辑都需要） */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 重试是否还可能（只有 failed 态才有资格重试，且需要外部重试预算） */
export function canRetry(status: TaskStatus): boolean {
  return status === 'failed';
}

/* ------------------------------------------------------------------ */
/* RiskLevel / StepVerification / ExecutionResult                      */
/* ------------------------------------------------------------------ */

/**
 * 步骤风险等级（决定审批策略、超时预算、是否并行）。
 *   read     — 只读操作（读文件、grep、查看日志、Docker ps）
 *   modify   — 修改操作但影响范围有限（改代码、写配置）
 *   run      — 执行命令（npm test、cargo build）
 *   deploy   — 部署 / 生产相关（重启容器、发布）
 *   critical — 高风险 / 不可逆（生产 DB 操作、权限变更）
 */
export type RiskLevel = 'read' | 'modify' | 'run' | 'deploy' | 'critical';

/** 步骤完成条件验证定义（结构化，不是纯字符串） */
export interface StepVerification {
  /** 验证类型——每种类型 StepExecutor 有对应判定逻辑 */
  type:
    | 'tool_return_ok'              // 执行的最后一个工具返回 ok=true
    | 'file_exists'                 // 指定文件存在
    | 'command_exit_zero'           // run_command 返回 code=0
    | 'git_no_conflict'             // git merge/rebase 无冲突
    | 'custom'                      // 自定义（交给 TaskVerifier 处理）
    | 'auto';                       // 默认：StepExecutor.run() 不抛异常且最后一个工具 ok

  /** 验证目标（tool_return_ok 不需要；custom 时可为任意描述） */
  target?: string;
  /** 验证失败时的补救提示（给模型看的） */
  hintOnFail?: string;
}

/** 步骤执行结果（StepExecutor 填充，可 JSON 序列化） */
export interface ExecutionResult {
  /** 执行是否成功（不一定等于 status=completed——允许完成但验证失败） */
  success: boolean;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 总 token 消耗（估算） */
  tokenUsage?: number;
  /** 实际耗时毫秒 */
  durationMs: number;
  /** 验证结果（StepExecutor 调用 StepVerification 后写入） */
  verificationPassed: boolean;
  /** 失败原因（success=false 时必填） */
  failureReason?: string;
  /** 最终模型摘要（供用户看） */
  summary?: string;
}

/** 证据引用（代码片段、日志行、Git commit、Docker 容器 ID 等） */
export interface EvidenceRef {
  /** 证据类型 */
  kind: 'code_snippet' | 'log_line' | 'git_commit' | 'git_diff_hunk' | 'docker_container' | 'k8s_event' | 'port_check' | 'process_info' | 'custom';
  /** 来源文件 / 路径 / ID */
  source: string;
  /** 起始行号（可选） */
  startLine?: number;
  /** 结束行号（可选） */
  endLine?: number;
  /** 简短描述（给模型或用户看） */
  description?: string;
}

/* ------------------------------------------------------------------ */
/* TaskStep                                                             */
/* ------------------------------------------------------------------ */

/**
 * 任务拆解后的单个步骤。
 *
 * prompt 要求的全部 11 个字段都在这里：
 *   step_id / task_id / description / dependencies / required_tools /
 *   risk_level / status / verification / result / evidence_refs
 */
export interface TaskStep {
  /** 步骤唯一 ID（格式：step_xxxxx，由 newId 生成） */
  step_id: string;
  /** 所属任务 ID */
  task_id: string;
  /** 步骤描述（给模型当 prompt 的） */
  description: string;
  /** 依赖的其他步骤 step_id 列表（空数组表示无依赖，就绪即可执行） */
  dependencies: string[];
  /** 本步骤需要的工具名（影响 ToolDispatcher 白名单检查） */
  required_tools: string[];
  /** 风险等级（影响审批和超时） */
  risk_level: RiskLevel;
  /** 当前状态 */
  status: TaskStatus;
  /** 完成条件验证（默认 auto） */
  verification: StepVerification;
  /** 执行结果（完成后由 StepExecutor 填充） */
  result?: ExecutionResult;
  /** 证据引用（执行完成后由 StepExecutor 或 TaskVerifier 填充） */
  evidence_refs: EvidenceRef[];
  /** 执行尝试次数（重试用，默认 0） */
  attempts: number;
  /** 重试预算上限（默认 2） */
  max_attempts: number;
  /** 阻塞原因（status=blocked 时必填） */
  block_reason?: string;
  /** 创建时间 ISO */
  created_at: string;
  /** 最后更新时间 ISO */
  updated_at: string;
  /** 并发提示：是否可以并行执行（同一计划内） */
  parallelizable: boolean;
}

/* ------------------------------------------------------------------ */
/* TaskPlan                                                             */
/* ------------------------------------------------------------------ */

/**
 * 完整执行计划——一个 TaskPlan = 一次 Agent 拆解出的全部步骤集合。
 *
 * 一个计划包含 N 个 TaskStep，步骤之间通过 dependencies 形成 DAG。
 * PlanManager 负责 CRUD；CheckpointManager 负责持久化与恢复；
 * DependencyScheduler 负责计算哪些步骤已就绪可以执行。
 */
export interface TaskPlan {
  /** 计划唯一 ID（格式：plan_xxxxx） */
  plan_id: string;
  /** 用户原始请求（给模型看的） */
  user_request: string;
  /** 计划生成时间 */
  created_at: string;
  /** 最后更新时间 */
  updated_at: string;
  /** 全部步骤（无序——DAG 关系在每个 step.dependencies 里） */
  steps: TaskStep[];
  /** 整体计划状态（等于所有 step 状态的折叠结果） */
  status: TaskStatus;
  /** 计划级别元数据（模型名、策略版本、预算等） */
  metadata: {
    model?: string;
    max_attempts_default?: number;
    auto_verify?: boolean;
    [key: string]: unknown;
  };
}

/* ------------------------------------------------------------------ */
/* CheckpointRecord（可 JSON 序列化，CheckpointManager 直接落 SQLite）  */
/* ------------------------------------------------------------------ */

/**
 * 计划快照 + 可恢复状态。
 *
 * 每个 plan_id 对应唯一 CheckpointRecord；StepExecutor 在每个步骤
 * 状态变化时调用 CheckpointManager.save()，恢复时从 steps 里找
 * 第一个未终态步骤继续。
 */
export interface CheckpointRecord {
  /** 对应 TaskPlan.plan_id */
  plan_id: string;
  /** 快照生成时间 */
  snapshot_at: string;
  /** 完整计划（含所有步骤状态） */
  plan: TaskPlan;
  /** 计划是否被取消（恢复时检查 abort_requested） */
  abort_requested: boolean;
  /** 当前正在执行的 step_id（有且仅有一个 running 态） */
  running_step_id?: string;
  /** 已完成步骤的 step_id 集合（恢复时跳过） */
  completed_step_ids: string[];
  /** 失败步骤的 step_id 集合（恢复时根据重试预算决定是否重跑） */
  failed_step_ids: string[];
}

/* ------------------------------------------------------------------ */
/* 工厂函数（零依赖，让调用方不用自己拼 ISO 时间）                       */
/* ------------------------------------------------------------------ */

/** 生成新的 plan_id（格式：plan_ + 8 位 hex 后缀） */
export function newPlanId(): string {
  return `plan_${uuid().replace(/-/g, '').slice(0, 8)}`;
}

/** 生成新的 step_id（格式：step_ + 8 位 hex 后缀） */
export function newStepId(): string {
  return `step_${uuid().replace(/-/g, '').slice(0, 8)}`;
}

/** 当前 UTC 时间 ISO */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 构造一个 pending 态的新步骤（默认值填充）。
 * description / dependencies / required_tools 必须由调用方提供。
 */
export function createStep(params: {
  task_id: string;
  description: string;
  dependencies?: string[];
  required_tools?: string[];
  risk_level?: RiskLevel;
  parallelizable?: boolean;
  max_attempts?: number;
  verification?: Partial<StepVerification>;
}): TaskStep {
  const now = nowIso();
  return {
    step_id: newStepId(),
    task_id: params.task_id,
    description: params.description,
    dependencies: params.dependencies ?? [],
    required_tools: params.required_tools ?? [],
    risk_level: params.risk_level ?? 'read',
    status: 'pending',
    verification: { type: 'auto', ...(params.verification ?? {}) },
    evidence_refs: [],
    attempts: 0,
    max_attempts: params.max_attempts ?? 2,
    created_at: now,
    updated_at: now,
    parallelizable: params.parallelizable ?? false,
  };
}

/**
 * 根据步骤状态折叠整个计划的整体状态：
 *   - 有 running  → running
 *   - 有 pending/ready（且无 failed）→ pending（整体还没开始或进行中）
 *   - 全部 completed → completed
 *   - 有 failed 且其他都 completed → failed
 *   - 全部 cancelled → cancelled
 *   - 有 blocked → blocked
 *
 * 纯函数，DependencyScheduler 和 PlanManager 都调用它。
 */
export function computePlanStatus(steps: ReadonlyArray<TaskStep>): TaskStatus {
  if (steps.length === 0) return 'completed';

  const counts: Record<TaskStatus, number> = {
    pending: 0,
    ready: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const s of steps) counts[s.status]++;
  const total = steps.length;

  if (counts.running > 0) return 'running';
  if (counts.blocked > 0) return 'blocked';
  if (counts.pending + counts.ready > 0) return 'pending';

  // 全部终态区域
  if (counts.completed === total) return 'completed';
  if (counts.cancelled === total) return 'cancelled';
  if (counts.failed > 0 && counts.completed + counts.cancelled + counts.failed === total) return 'failed';
  // 有 cancelled 且剩余都是 completed（用户取消了剩余步骤）→ cancelled
  if (counts.cancelled > 0) return 'cancelled';
  if (counts.failed > 0) return 'failed';

  return 'pending'; // 兜底（极端混合态）
}
