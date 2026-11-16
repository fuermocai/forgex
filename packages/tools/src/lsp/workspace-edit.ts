import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative, sep } from 'node:path';
import { ForgeError, createUnifiedDiff, type JsonValue, type ToolContext } from '@forgex/shared';
import { atomicWriteText, readWholeText } from '../coding/fs-utils.js';

const MAX_FILES = 128;
const MAX_EDITS_PER_FILE = 4096;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_APPROVAL_PREVIEW_CHARS = 64_000;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PREVIEWS = 50;

interface LspPosition {
  line: number;
  character: number;
}

interface TextEdit {
  range: { start: LspPosition; end: LspPosition };
  newText: string;
}

interface TextDocumentEdit {
  uri: string;
  version: number | null;
  edits: TextEdit[];
}

interface StoredFileEdit {
  uri: string;
  path: string;
  relativePath: string;
  original: string;
  originalHash: string;
  updated: string;
  version: number | null;
  diff: string;
  added: number;
  removed: number;
  changed: boolean;
}

interface StoredPreview {
  id: string;
  sessionId: string;
  expiresAt: number;
  files: StoredFileEdit[];
}

export interface WorkspaceEditFilePreview {
  path: string;
  version: number | null;
  changed: boolean;
  diff: string;
  added: number;
  removed: number;
}

export interface WorkspaceEditPreview {
  previewId: string;
  files: WorkspaceEditFilePreview[];
}

export interface WorkspaceEditSnapshot {
  text: string;
  version: number;
}

export interface WorkspaceEditPreviewStoreOptions {
  writeText?: typeof atomicWriteText;
}

/** Holds short-lived, session-scoped previews before an approved edit is applied. */
export class WorkspaceEditPreviewStore {
  private readonly previews = new Map<string, StoredPreview>();
  private readonly writeText: typeof atomicWriteText;

  constructor(options: WorkspaceEditPreviewStoreOptions = {}) {
    this.writeText = options.writeText ?? atomicWriteText;
  }

  /** Validates an LSP WorkspaceEdit and stores a diff-only preview. */
  async createPreview(
    value: unknown,
    ctx: ToolContext,
    snapshots: ReadonlyMap<string, WorkspaceEditSnapshot> = new Map(),
  ): Promise<WorkspaceEditPreview> {
    this.cleanExpired();
    const documents = parseWorkspaceEdit(value);
    if (documents.length === 0) throw new ForgeError('TOOL_FAILED', 'WorkspaceEdit 不包含可应用的文本编辑');
    if (documents.length > MAX_FILES) throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 文件数超过上限 ${MAX_FILES}`);

    const files: StoredFileEdit[] = [];
    let previewChars = 0;
    const seen = new Set<string>();
    for (const document of documents) {
      const path = await resolveLocalFileUri(document.uri, ctx);
      const pathKey = process.platform === 'win32' ? path.toLowerCase() : path;
      if (seen.has(pathKey)) throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 含重复文件 URI: ${document.uri}`);
      seen.add(pathKey);

      const canonicalUri = pathToFileURL(path).href;
      const snapshot = snapshots.get(canonicalUri) ?? snapshots.get(document.uri);
      const original = snapshot?.text ?? await readWholeText(path, MAX_FILE_BYTES);
      if (Buffer.byteLength(original, 'utf8') > MAX_FILE_BYTES) {
        throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 文件超过 ${MAX_FILE_BYTES} 字节上限: ${document.uri}`);
      }
      if (document.version !== null) {
        if (!snapshot) {
          throw new ForgeError('TOOL_FAILED', `无法核对 WorkspaceEdit 文档版本，拒绝预览: ${document.uri}`);
        }
        if (document.version !== snapshot.version) {
          throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 文档版本已过期: ${document.uri}（语言服务器 ${document.version}，当前快照 ${snapshot.version}）`);
        }
      }
      const diskText = await readWholeText(path, MAX_FILE_BYTES);
      if (hashText(diskText) !== hashText(original)) {
        throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 源文件在 LSP 请求期间已变化，拒绝创建陈旧预览: ${document.uri}`);
      }

      const updated = applyTextEdits(original, document.edits, document.uri);
      const relativePath = relative(ctx.workspaceRoot, path).split(sep).join('/');
      const diff = createUnifiedDiff(original, updated, relativePath);
      previewChars += relativePath.length + diff.patch.length + 16;
      if (previewChars > MAX_APPROVAL_PREVIEW_CHARS) {
        throw new ForgeError('TOOL_FAILED', `WorkspaceEdit diff 超过 ${MAX_APPROVAL_PREVIEW_CHARS} 字符，无法完整审批，已拒绝预览`);
      }
      files.push({
        uri: canonicalUri,
        path,
        relativePath,
        original,
        originalHash: hashText(original),
        updated,
        version: document.version,
        diff: diff.patch,
        added: diff.stat.added,
        removed: diff.stat.removed,
        changed: original !== updated,
      });
    }

    const id = randomBytes(12).toString('hex');
    const stored: StoredPreview = { id, sessionId: ctx.sessionId, expiresAt: Date.now() + PREVIEW_TTL_MS, files };
    this.previews.set(id, stored);
    this.trimPreviews();
    return toPreview(stored);
  }

  /** Returns the exact diff that the dispatcher should show in the approval request. */
  approvalPreview(previewId: string, sessionId: string): string {
    const preview = this.get(previewId, sessionId);
    return preview.files.map((file) => `--- ${file.relativePath} ---\n${file.diff || '(无内容变化)'}`).join('\n');
  }

  /** Returns workspace paths used for dispatcher preflight checks. */
  approvalPaths(previewId: string, sessionId: string): string[] {
    return this.get(previewId, sessionId).files.map((file) => file.path);
  }

  /** Applies all files after revalidating snapshots, rolling back if a write fails. */
  async apply(previewId: string, ctx: ToolContext): Promise<{ changed: boolean; files: string[] }> {
    const preview = this.get(previewId, ctx.sessionId);
    const resolvedPaths: string[] = [];
    for (const file of preview.files) {
      const path = await ctx.workspace.resolve(file.path, 'write', ctx.cwd);
      if (path !== file.path) throw new ForgeError('WORKSPACE_ESCAPE', `WorkspaceEdit 路径解析发生变化: ${file.relativePath}`);
      const current = await readWholeText(path, MAX_FILE_BYTES);
      if (hashText(current) !== file.originalHash) {
        this.previews.delete(previewId);
        throw new ForgeError('TOOL_FAILED', `文件在审批后已变化，拒绝应用陈旧 WorkspaceEdit: ${file.relativePath}`);
      }
      resolvedPaths.push(path);
    }

    const written: StoredFileEdit[] = [];
    let failedFile = '未知文件';
    try {
      for (let index = 0; index < preview.files.length; index += 1) {
        const file = preview.files[index]!;
        if (!file.changed) continue;
        failedFile = file.relativePath;
        await this.writeText(resolvedPaths[index]!, file.updated);
        written.push(file);
      }
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const file of written.reverse()) {
        try {
          await this.writeText(file.path, file.original);
        } catch (rollbackError) {
          rollbackFailures.push(`${file.relativePath}: ${errorMessage(rollbackError)}`);
        }
      }
      this.previews.delete(previewId);
      const rollbackInfo = rollbackFailures.length > 0 ? `；回滚失败：${rollbackFailures.join('；')}` : '；已回滚此前写入';
      throw new ForgeError('TOOL_FAILED', `应用 WorkspaceEdit 失败（${failedFile}）：${errorMessage(error)}${rollbackInfo}`, {
        details: { file: failedFile, rollbackFailures },
        cause: error,
      });
    }

    this.previews.delete(previewId);
    return { changed: written.length > 0, files: preview.files.map((file) => file.relativePath) };
  }

  private get(id: string, sessionId: string): StoredPreview {
    this.cleanExpired();
    const preview = this.previews.get(id);
    if (!preview || preview.sessionId !== sessionId) {
      throw new ForgeError('TOOL_FAILED', 'WorkspaceEdit 预览不存在或已过期');
    }
    return preview;
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id);
    }
  }

  private trimPreviews(): void {
    while (this.previews.size > MAX_PREVIEWS) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) return;
      this.previews.delete(oldest);
    }
  }
}

function parseWorkspaceEdit(value: unknown): TextDocumentEdit[] {
  if (!isRecord(value)) throw new ForgeError('TOOL_FAILED', 'LSP 返回的 WorkspaceEdit 格式无效');
  const documents: TextDocumentEdit[] = [];
  if (isRecord(value.changes)) {
    for (const [uri, edits] of Object.entries(value.changes)) {
      documents.push({ uri, version: null, edits: parseTextEdits(edits, uri) });
    }
  }
  if (Array.isArray(value.documentChanges)) {
    for (const change of value.documentChanges) {
      if (!isRecord(change) || !isRecord(change.textDocument) || typeof change.textDocument.uri !== 'string') {
        throw new ForgeError('TOOL_FAILED', 'WorkspaceEdit 的资源操作不受支持，只接受 TextDocumentEdit');
      }
      const version = change.textDocument.version;
      if (version !== null && version !== undefined && (!Number.isInteger(version) || typeof version !== 'number')) {
        throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 文档版本无效: ${change.textDocument.uri}`);
      }
      documents.push({ uri: change.textDocument.uri, version: typeof version === 'number' ? version : null, edits: parseTextEdits(change.edits, change.textDocument.uri) });
    }
  }
  return documents;
}

function parseTextEdits(value: unknown, uri: string): TextEdit[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDITS_PER_FILE) {
    throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 文本编辑列表无效: ${uri}`);
  }
  return value.map((raw) => {
    if (!isRecord(raw) || !isRecord(raw.range) || !isRecord(raw.range.start) || !isRecord(raw.range.end) || typeof raw.newText !== 'string') {
      throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 文本编辑格式无效: ${uri}`);
    }
    const start = parsePosition(raw.range.start);
    const end = parsePosition(raw.range.end);
    return { range: { start, end }, newText: raw.newText };
  });
}

function parsePosition(value: Record<string, unknown>): LspPosition {
  if (!Number.isInteger(value.line) || typeof value.line !== 'number' || value.line < 0 || !Number.isInteger(value.character) || typeof value.character !== 'number' || value.character < 0) {
    throw new ForgeError('TOOL_FAILED', 'WorkspaceEdit 行列范围无效');
  }
  return { line: value.line, character: value.character };
}

async function resolveLocalFileUri(uriValue: string, ctx: ToolContext): Promise<string> {
  let url: URL;
  try {
    url = new URL(uriValue);
  } catch (error) {
    throw new ForgeError('TOOL_FAILED', `WorkspaceEdit URI 无效: ${uriValue}`, { cause: error });
  }
  if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname.toLowerCase() !== 'localhost') || url.username || url.password || url.search || url.hash) {
    throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 只接受本地 file URI: ${uriValue}`);
  }
  if (url.hostname.toLowerCase() === 'localhost') url.hostname = '';
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch (error) {
    throw new ForgeError('TOOL_FAILED', `WorkspaceEdit file URI 无法解码: ${uriValue}`, { cause: error });
  }
  return ctx.workspace.resolve(path, 'write', ctx.cwd);
}

function applyTextEdits(original: string, edits: TextEdit[], uri: string): string {
  const offsets = edits.map((edit) => ({
    start: positionToOffset(original, edit.range.start, uri),
    end: positionToOffset(original, edit.range.end, uri),
    newText: edit.newText,
  }));
  offsets.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 0; index < offsets.length; index += 1) {
    const current = offsets[index]!;
    if (current.end < current.start) throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 范围结束早于开始: ${uri}`);
    const previous = offsets[index - 1];
    if (previous && (current.start < previous.end || (current.start === previous.start && current.end === previous.end))) {
      throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 含重叠范围: ${uri}`);
    }
  }
  let result = original;
  for (const edit of offsets.reverse()) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

function positionToOffset(text: string, position: LspPosition, uri: string): number {
  const lines = text.split('\n');
  if (position.line >= lines.length) throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 行号超出文件范围: ${uri}`);
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) offset += lines[line]!.length + 1;
  const rawLine = lines[position.line]!;
  const contentLength = rawLine.endsWith('\r') ? rawLine.length - 1 : rawLine.length;
  if (position.character > contentLength) throw new ForgeError('TOOL_FAILED', `WorkspaceEdit 列号超出行范围: ${uri}`);
  return offset + position.character;
}

function toPreview(preview: StoredPreview): WorkspaceEditPreview {
  return {
    previewId: preview.id,
    files: preview.files.map((file) => ({
      path: file.relativePath,
      version: file.version,
      changed: file.changed,
      diff: file.diff,
      added: file.added,
      removed: file.removed,
    })),
  };
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
