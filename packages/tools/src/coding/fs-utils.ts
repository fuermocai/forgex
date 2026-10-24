/**
 * 文件读写辅助函数（编码工具专用）。
 *
 * 关键点：
 *  - 二进制检测：避免把图片/可执行文件读进模型上下文；
 *  - 按行读取：大文件不整体载入内存，达到行数/字节上限即停止；
 *  - 原子写入：先写同目录临时文件再 rename，避免中途失败留下半截文件。
 */
import { createReadStream } from 'node:fs';
import { chmod, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ForgeError } from '@forgex/shared';

export interface LineRangeResult {
  text: string;
  startLine: number;
  endLine: number;
  /** 文件总行数；因截断提前停止时为 null */
  totalLines: number | null;
  truncated: boolean;
  sizeBytes: number;
}

export interface LineRangeOptions {
  /** 起始行，1 开始 */
  startLine?: number;
  /** 最多读取多少行 */
  limit?: number;
  /** 最多读取多少字节（UTF-8） */
  maxBytes: number;
}

/** 读取文件指定行范围；文件必须是文本 */
export async function readFileLines(absPath: string, options: LineRangeOptions): Promise<LineRangeResult> {
  const info = await stat(absPath).catch((err: unknown) => {
    throw new ForgeError('PATH_NOT_FOUND', `文件不存在或不可访问: ${absPath}`, {
      details: { path: absPath },
      cause: err,
    });
  });
  if (!info.isFile()) {
    throw new ForgeError('TOOL_FAILED', `不是普通文件: ${absPath}`, { details: { path: absPath } });
  }
  await assertTextFile(absPath, info.size);

  const startLine = Math.max(1, options.startLine ?? 1);
  const limit = Math.max(1, options.limit ?? Number.MAX_SAFE_INTEGER);
  const maxBytes = Math.max(1024, options.maxBytes);

  const collected: string[] = [];
  let lineNo = 0;
  let bytes = 0;
  let truncated = false;
  let totalLines: number | null = null;

  const stream = createReadStream(absPath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const rawLine of rl) {
      lineNo += 1;
      if (lineNo < startLine) continue;
      if (collected.length >= limit) {
        truncated = true;
        break;
      }
      const line = typeof rawLine === 'string' ? rawLine : String(rawLine);
      const cost = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + cost > maxBytes) {
        truncated = true;
        break;
      }
      collected.push(line);
      bytes += cost;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!truncated) totalLines = lineNo;

  return {
    text: collected.join('\n'),
    startLine,
    endLine: startLine + collected.length - 1,
    totalLines,
    truncated,
    sizeBytes: info.size,
  };
}

/** 读取完整文本文件（有大小上限），用于 edit_file */
export async function readWholeText(absPath: string, maxBytes: number): Promise<string> {
  const info = await stat(absPath).catch((err: unknown) => {
    throw new ForgeError('PATH_NOT_FOUND', `文件不存在或不可访问: ${absPath}`, {
      details: { path: absPath },
      cause: err,
    });
  });
  if (!info.isFile()) {
    throw new ForgeError('TOOL_FAILED', `不是普通文件: ${absPath}`, { details: { path: absPath } });
  }
  if (info.size > maxBytes) {
    throw new ForgeError('TOOL_FAILED', `文件过大（${info.size} 字节），超过编辑上限 ${maxBytes} 字节`, {
      details: { path: absPath, size: info.size, limit: maxBytes },
    });
  }
  await assertTextFile(absPath, info.size);
  return readFile(absPath, 'utf8');
}

/** 原子写入文本：临时文件 -> rename */
export async function atomicWriteText(absPath: string, content: string): Promise<number> {
  const dir = dirname(absPath);
  const temp = join(dir, `.${basename(absPath)}.forgex-${randomBytes(6).toString('hex')}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(absPath)).mode;
  } catch {
    mode = undefined;
  }
  try {
    await writeFile(temp, content, 'utf8');
    if (mode !== undefined && process.platform !== 'win32') {
      await chmod(temp, mode).catch(() => undefined);
    }
    await rename(temp, absPath);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw new ForgeError('TOOL_FAILED', `写入文件失败: ${absPath}`, {
      details: { path: absPath },
      cause: err,
    });
  }
  return Buffer.byteLength(content, 'utf8');
}

/**
 * 判断是否文本文件。
 * 仅检查前 4KB 是否含 NUL，避免误判中文/emoji；PEM 等无 NUL 文本仍可读。
 */
async function assertTextFile(absPath: string, size: number): Promise<void> {
  if (size === 0) return;
  const handle = await open(absPath, 'r');
  try {
    const probe = Buffer.alloc(Math.min(4096, size));
    await handle.read(probe, 0, probe.length, 0);
    if (probe.includes(0)) {
      throw new ForgeError('TOOL_FAILED', `文件疑似二进制，拒绝读取: ${absPath}`, {
        details: { path: absPath, reason: 'BINARY_FILE' },
      });
    }
  } finally {
    await handle.close();
  }
}

/** 转为工作区内相对路径（统一使用 / 分隔，便于模型理解与跨平台展示） */
export function toWorkspaceRelative(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  return rel === '' ? '.' : rel.split(sep).join('/');
}
