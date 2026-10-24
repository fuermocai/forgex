/**
 * 日志文件尾部读取（跨平台）。
 *
 * 设计：
 *  - 只读文件末尾 maxBytes，避免几个 GB 的日志把内存打满；
 *  - 若从文件中间开始读，丢弃第一行（可能是半行）；
 *  - 支持 UTF-8 与 UTF-16LE BOM（Windows PowerShell 常见）；
 *  - 返回 truncated 标记，Agent 必须据此说明"日志被截断"。
 */
import { open, stat } from 'node:fs/promises';
import { ForgeError } from '@forgex/shared';
import type { LogTailResult } from './types.js';

export interface ReadLogTailOptions {
  /** 返回最后多少行，默认 200 */
  lines?: number;
  /** 最多读取多少字节，默认 128KB */
  maxBytes?: number;
}

export async function readLogTail(filePath: string, options: ReadLogTailOptions = {}): Promise<LogTailResult> {
  const linesLimit = Math.max(1, options.lines ?? 200);
  const maxBytes = Math.max(1024, options.maxBytes ?? 128 * 1024);

  const info = await stat(filePath).catch((err: unknown) => {
    throw new ForgeError('PATH_NOT_FOUND', `日志文件不存在或不可访问: ${filePath}`, {
      details: { path: filePath },
      cause: err,
    });
  });
  if (!info.isFile()) {
    throw new ForgeError('TOOL_FAILED', `不是普通文件: ${filePath}`, { details: { path: filePath } });
  }
  if (info.size === 0) {
    return { path: filePath, content: '', lines: 0, truncated: false, sizeBytes: 0 };
  }

  const start = Math.max(0, info.size - maxBytes);
  const length = info.size - start;
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, 'r');
  try {
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }

  let text = decodeBuffer(buffer);
  let truncated = start > 0;

  if (truncated) {
    // 丢弃可能被截断的首行
    const firstNewline = text.indexOf('\n');
    text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  }

  const allLines = text.split(/\r?\n/);
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
  const selected = allLines.length > linesLimit ? allLines.slice(allLines.length - linesLimit) : allLines;
  if (selected.length < allLines.length) truncated = true;

  return {
    path: filePath,
    content: selected.join('\n'),
    lines: selected.length,
    truncated,
    sizeBytes: info.size,
  };
}

/** 根据 BOM 解码；默认按 UTF-8 */
function decodeBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  return buffer.toString('utf8');
}
