/**
 * EvidenceStore：证据外置存储（v0.3.0 Phase 5）。
 *
 * 解决什么问题：
 *   工具输出（长日志、大 diff、整文件内容）是上下文窗口的最大消耗者。
 *   传统做法是超限后直接截断——信息永久丢失，模型无法回溯。
 *   本模块把大文本从消息流中剥离，存入本地 JSONL 事件日志，
 *   消息里只留一个紧凑引用（evidence id + 预览），需要时可按 id 取回原文。
 *
 * 设计原则：
 *   1. 全离线：追加写入 JSONL，零网络依赖；
 *   2. 审计友好：证据落库后不可变（不提供 update），删除走显式 delete；
 *   3. 引用格式是"模型可读的文本"，不是魔法 ID——模型看到引用就知道
 *      原始内容曾经存在、有多大、预览是什么。
 */
import { ForgeError, JsonlEventStore, uuid } from '@forgex/shared';

/** 证据类别（影响保留策略与审计检索） */
export const EVIDENCE_KINDS = ['tool_output', 'file_content', 'log_excerpt', 'diff', 'other'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** 证据引用（嵌入消息内容中的紧凑描述） */
export interface EvidenceRef {
  /** 证据 ID（ev_ 前缀） */
  id: string;
  kind: EvidenceKind;
  /** 原始内容字节数（UTF-8） */
  byteLen: number;
  /** 预览文本（前几百字符，已截断） */
  preview: string;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  sessionId?: string;
}

/** 完整证据记录（引用 + 原文） */
export interface EvidenceRecord extends EvidenceRef {
  content: string;
}

/** 预览最大字符数（嵌入消息的部分必须足够小） */
export const PREVIEW_MAX_CHARS = 300;

/** 生成证据 ID */
export function newEvidenceId(): string {
  return `ev_${uuid()}`;
}

/** 生成预览：取前 N 个字符，去掉首尾空白 */
export function makePreview(content: string, maxChars: number = PREVIEW_MAX_CHARS): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
}

/**
 * 把证据引用渲染成"可嵌回消息"的文本。
 * 模型读到这段文本就知道：原文曾经存在、属于什么类别、多大、怎么引用。
 */
export function renderEvidencePlaceholder(ref: EvidenceRef): string {
  return (
    `[内容已外置为证据 evidence_id=${ref.id} kind=${ref.kind} 原始字节=${ref.byteLen}；` +
    `需要原文时可按 evidence_id 取回]\n预览:\n${ref.preview}`
  );
}

export interface PutEvidenceInput {
  kind: EvidenceKind;
  content: string;
  sessionId?: string;
  /** 附加元数据（工具名、路径等），仅存 JSON，不参与索引 */
  metadata?: Record<string, unknown>;
}

export class EvidenceStore {
  private readonly events: JsonlEventStore;

  constructor(dbPath: string) {
    this.events = new JsonlEventStore(dbPath);
  }

  /** 存入证据，返回引用（内容不可变，重复 put 生成新 id） */
  put(input: PutEvidenceInput): EvidenceRef {
    if (!isEvidenceKind(input.kind)) {
      throw new ForgeError('EVIDENCE_STORE_ERROR', `非法证据类别: ${String(input.kind)}`);
    }
    if (input.content.length === 0) {
      throw new ForgeError('EVIDENCE_STORE_ERROR', '证据内容不能为空');
    }
    const id = newEvidenceId();
    const byteLen = Buffer.byteLength(input.content, 'utf8');
    const now = new Date().toISOString();
    const parent = this.events.readAll().findLast((event) => event.type === 'evidence.put');
    this.events.append('evidence.put', { id, sessionId: input.sessionId ?? null, kind: input.kind, content: input.content, byteLen, createdAt: now, metadata: input.metadata ?? null }, parent?.id ?? null);
    const ref: EvidenceRef = {
      id,
      kind: input.kind,
      byteLen,
      preview: makePreview(input.content),
      createdAt: now,
    };
    if (input.sessionId !== undefined) ref.sessionId = input.sessionId;
    return ref;
  }

  /** 按 ID 取完整记录；不存在返回 null */
  get(id: string): EvidenceRecord | null {
    const row = this.readRecords().get(id);
    if (!row) return null;
    const record: EvidenceRecord = {
      id,
      kind: row.kind,
      byteLen: row.byteLen,
      preview: makePreview(row.content),
      createdAt: row.createdAt,
      content: row.content,
    };
    if (row.sessionId !== null) record.sessionId = row.sessionId;
    return record;
  }

  /** 按 ID 取引用（不读原文，校验存在性用） */
  getRef(id: string): EvidenceRef | null {
    const row = this.readRecords().get(id);
    if (!row) return null;
    const ref: EvidenceRef = {
      id,
      kind: row.kind,
      byteLen: row.byteLen,
      preview: makePreview(row.content.slice(0, PREVIEW_MAX_CHARS + 8)),
      createdAt: row.createdAt,
    };
    if (row.sessionId !== null) ref.sessionId = row.sessionId;
    return ref;
  }

  /** 列出某个 session 的证据引用（按时间升序） */
  listBySession(sessionId: string, limit = 200): EvidenceRef[] {
    return [...this.readRecords().values()].filter((row) => row.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(0, Math.max(1, limit))
      .map((row) => ({ id: row.id, kind: row.kind, byteLen: row.byteLen, preview: makePreview(row.content.slice(0, PREVIEW_MAX_CHARS + 8)), createdAt: row.createdAt, sessionId }));
  }

  /** 删除证据（会话清理用）；返回是否实际删除 */
  delete(id: string): boolean {
    if (!this.readRecords().has(id)) return false;
    const parent = this.events.readAll().findLast((event) => event.data.evidenceId === id);
    this.events.append('evidence.delete', { evidenceId: id }, parent?.id ?? null);
    return true;
  }

  /** 清理某个 session 的全部证据；返回删除条数 */
  purgeSession(sessionId: string): number {
    const ids = [...this.readRecords().values()].filter((record) => record.sessionId === sessionId).map((record) => record.id);
    for (const id of ids) this.delete(id);
    return ids.length;
  }

  /** 统计（监控/测试用） */
  count(sessionId?: string): number {
    if (sessionId !== undefined) {
      return [...this.readRecords().values()].filter((record) => record.sessionId === sessionId).length;
    }
    return this.readRecords().size;
  }

  close(): void { /* JSONL appends are synchronous and require no flush. */ }

  private readRecords(): Map<string, { id: string; sessionId: string | null; kind: EvidenceKind; content: string; byteLen: number; createdAt: string }> {
    const records = new Map<string, { id: string; sessionId: string | null; kind: EvidenceKind; content: string; byteLen: number; createdAt: string }>();
    for (const event of this.events.readAll()) {
      if (event.type === 'evidence.delete' && typeof event.data.evidenceId === 'string') records.delete(event.data.evidenceId);
      if (event.type === 'evidence.put' && typeof event.data.id === 'string' && typeof event.data.content === 'string') {
        records.set(event.data.id, event.data as unknown as { id: string; sessionId: string | null; kind: EvidenceKind; content: string; byteLen: number; createdAt: string });
      }
    }
    return records;
  }
}
