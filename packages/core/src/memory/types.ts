/**
 * Project Memory 类型定义（v0.3.0 Phase 4）。
 *
 * 设计原则：
 *   1. 纯类型 + 纯函数文件，零外部运行时依赖（只 import @forgex/shared 的 uuid）；
 *   2. 所有字段可 JSON 序列化，便于审计与测试断言；
 *   3. 记忆是"有出处的知识"——每条 entry 必须带 kind / source / scope，
 *      并记录 evidence_refs（来源证据），不允许凭空生成"事实"；
 *   4. 敏感内容（API Key、密码、token）绝不允许入库——由 validator 在写入前拦截，
 *      本文件只定义类型与边界常量；
 *   5. 软删除：被取代的旧 entry 不物理删除，而是置 superseded_by 指向新 entry，
 *      保证审计可追溯"某个时间点系统相信什么"。
 */
import { uuid } from '@forgex/shared';

/* ------------------------------------------------------------------ */
/* MemoryKind：记忆的种类                                                */
/* ------------------------------------------------------------------ */

/**
 * - fact：已确认的事实（来自用户明确陈述、工具运行结果、代码证据）
 * - hypothesis：未验证的假设（来自 Agent 推断），confidence 通常 < 0.8，
 *   被后续证据确认后可升级为 fact（见 consolidator.ts）
 */
export const MEMORY_KINDS = ['fact', 'hypothesis'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* MemorySource：记忆的来源                                              */
/* ------------------------------------------------------------------ */

/**
 * - user：用户明确告知（"记住：我们用 pnpm"）
 * - agent：Agent 在运行中提炼（"该仓库测试命令是 pnpm test"）
 * - tool_run：工具运行结果沉淀（诊断发现的端口占用、配置值等）
 */
export const MEMORY_SOURCES = ['user', 'agent', 'tool_run'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export function isMemorySource(value: unknown): value is MemorySource {
  return typeof value === 'string' && (MEMORY_SOURCES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* MemoryScope：记忆的可见范围                                           */
/* ------------------------------------------------------------------ */

/**
 * - project：跨会话长期有效（绑定 workspace），如构建命令、架构约定
 * - session：仅当前会话有效，会话结束即过期，如"本次任务目标"
 * - task：绑定某个 task_id，任务完成即失效，如中间推断
 *
 * 检索时按 scope 分层过滤：task > session > project（见 retriever.ts）。
 */
export const MEMORY_SCOPES = ['project', 'session', 'task'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* 边界常量                                                              */
/* ------------------------------------------------------------------ */

/** key 允许的字面格式：小写字母/数字/点/下划线/连字符，长度 1~128 */
export const MEMORY_KEY_PATTERN = /^[a-z0-9_.-]{1,128}$/;

/** 单条 content 上限（4KB）——记忆是摘要不是文件存储 */
export const MAX_CONTENT_BYTES = 4 * 1024;

/** confidence 合法区间 [0, 1]；hypothesis 超过该阈值可被 consolidator 升级 */
export const HYPOTHESIS_PROMOTE_THRESHOLD = 0.8;

/** 单次 recall 默认返回条数 */
export const DEFAULT_RECALL_LIMIT = 20;

/** recall 返回条数硬上限 */
export const MAX_RECALL_LIMIT = 100;

/* ------------------------------------------------------------------ */
/* MemoryEntry                                                          */
/* ------------------------------------------------------------------ */

/**
 * 一条记忆条目。
 *
 * 时间字段统一 ISO 8601 字符串（与 SessionStore 一致，方便 SQLite 排序）。
 */
export interface MemoryEntry {
  /** 记忆唯一 ID */
  id: string;
  /** fact / hypothesis */
  kind: MemoryKind;
  /** user / agent / tool_run */
  source: MemorySource;
  /** project / session / task */
  scope: MemoryScope;
  /**
   * 检索键（同一 scope+workspace+key 视为"同一个知识点"）：
   * 新 entry 写入同 key 时会 supersede 旧 entry（见 consolidator.ts）。
   */
  key: string;
  /** 记忆正文（已确认不含敏感信息） */
  content: string;
  /** 标签，便于召回时过滤（如 ['build', 'test']） */
  tags: string[];
  /** 置信度 0~1：user 陈述的事实通常 1.0，agent 推断通常 < 0.8 */
  confidence: number;
  /** 创建时间 ISO 8601 */
  created_at: string;
  /** 最后更新时间 ISO 8601 */
  updated_at: string;
  /** 过期时间 ISO 8601（可选）；到期后 recall 不再返回，但不物理删除 */
  expires_at?: string;
  /** scope=session/task 时关联的会话 ID */
  session_id?: string;
  /** scope=task 时关联的任务 ID */
  task_id?: string;
  /** 所属工作区绝对路径（project scope 必填；session/task 也记录便于审计） */
  workspace: string;
  /**
   * 证据引用列表：指向产生该记忆的消息/工具结果/文件位置。
   * 不允许写入"无出处的事实"——agent 来源的 entry 至少应有 1 条引用。
   */
  evidence_refs: string[];
  /** 软删除标记：被哪条新 entry 取代（未取代为 undefined） */
  superseded_by?: string;
}

/* ------------------------------------------------------------------ */
/* 工厂函数                                                              */
/* ------------------------------------------------------------------ */

/** 创建新记忆的入参（id / 时间戳由工厂生成） */
export interface CreateMemoryInput {
  kind: MemoryKind;
  source: MemorySource;
  scope: MemoryScope;
  key: string;
  content: string;
  workspace: string;
  tags?: string[];
  confidence?: number;
  expires_at?: string;
  session_id?: string;
  task_id?: string;
  evidence_refs?: string[];
}

/**
 * 构造 MemoryEntry。
 *
 * 注意：本函数只做"成形"，不做合法性校验——
 * key 格式 / 敏感内容 / scope 与 session_id/task_id 的一致性由 validator.ts 负责。
 */
export function createMemoryEntry(input: CreateMemoryInput): MemoryEntry {
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: uuid(),
    kind: input.kind,
    source: input.source,
    scope: input.scope,
    key: input.key,
    content: input.content,
    tags: [...(input.tags ?? [])],
    confidence: clampConfidence(input.confidence ?? defaultConfidence(input.source, input.kind)),
    created_at: now,
    updated_at: now,
    workspace: input.workspace,
    evidence_refs: [...(input.evidence_refs ?? [])],
  };
  if (input.expires_at !== undefined) entry.expires_at = input.expires_at;
  if (input.session_id !== undefined) entry.session_id = input.session_id;
  if (input.task_id !== undefined) entry.task_id = input.task_id;
  return entry;
}

/** 默认置信度：用户陈述的事实最可信，agent 推断保守给 0.6 */
export function defaultConfidence(source: MemorySource, kind: MemoryKind): number {
  if (kind === 'hypothesis') return 0.5;
  switch (source) {
    case 'user':
      return 1.0;
    case 'tool_run':
      return 0.9;
    case 'agent':
      return 0.6;
  }
}

/** 将 confidence 收敛到 [0, 1]（防御性，正常路径 validator 已校验） */
export function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* ------------------------------------------------------------------ */
/* 守卫与状态判断                                                        */
/* ------------------------------------------------------------------ */

/** 是否为有效（未被取代且未过期）的记忆 */
export function isActive(entry: MemoryEntry, now: Date = new Date()): boolean {
  if (entry.superseded_by !== undefined) return false;
  if (entry.expires_at !== undefined && new Date(entry.expires_at).getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

/** 判断 scope 与关联字段的一致性（validator 复用） */
export function scopeFieldsConsistent(entry: Pick<MemoryEntry, 'scope' | 'session_id' | 'task_id'>): boolean {
  switch (entry.scope) {
    case 'project':
      // project 级不应绑定具体 task；session_id 允许记录（表示在哪次会话写入）
      return entry.task_id === undefined;
    case 'session':
      return entry.session_id !== undefined && entry.task_id === undefined;
    case 'task':
      return entry.session_id !== undefined && entry.task_id !== undefined;
  }
}
