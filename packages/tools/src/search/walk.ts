/**
 * 混合检索共享的文件遍历器（v0.3.0 Phase 3）。
 *
 * 三个检索层（keyword / structure / semantic）需要完全一致的文件选择策略，
 * 否则会出现"关键词层搜到的文件语义层没索引"的覆盖偏差。
 * 因此把遍历收敛到这里：
 *   - 跳过 SEARCH_SKIP_DIRS 与符号链接（防逃逸）；
 *   - 单文件 ≤ MAX_FILE_BYTES，扫描数 ≤ MAX_SCAN_FILES，深度 ≤ MAX_WALK_DEPTH；
 *   - 二进制探测（前 4KB 含 NUL 即跳过）；
 *   - 产出工作区相对路径 + UTF-8 行数组。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { globToRegExp } from '../coding/grep-fallback.js';
import { MAX_SCAN_FILES, MAX_WALK_DEPTH, SEARCH_SKIP_DIRS, MAX_FILE_BYTES } from './types.js';

export interface WalkedFile {
  /** 绝对路径 */
  absPath: string;
  /** 相对搜索根的路径（/ 分隔） */
  relPath: string;
  /** UTF-8 行数组（不含行尾换行） */
  lines: string[];
}

export interface WalkOptions {
  root: string;
  glob?: string;
  maxFiles?: number;
  signal?: AbortSignal;
}

export interface WalkOutcome {
  files: WalkedFile[];
  /** 是否因达到上限而提前停止 */
  truncated: boolean;
}

/**
 * 遍历 root 下所有候选文本文件并读入行数组。
 * root 可以是文件也可以是目录。
 */
export async function walkTextFiles(options: WalkOptions): Promise<WalkOutcome> {
  const maxFiles = options.maxFiles ?? MAX_SCAN_FILES;
  const globRegex = options.glob ? globToRegExp(options.glob) : null;
  // 与 ripgrep glob 语义对齐：glob 不含 / 时只匹配文件名（basename），
  // 含 / 时匹配完整相对路径（如 **\/*.go、src/*.ts）
  const globHasSlash = (options.glob ?? '').includes('/');
  const files: WalkedFile[] = [];
  let truncated = false;

  const considerFile = async (absPath: string): Promise<void> => {
    if (truncated) return;
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    const info = await stat(absPath).catch(() => null);
    if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) return;
    const rel = relative(options.root, absPath).split(sep).join('/');
    if (globRegex) {
      const target = globHasSlash ? rel : (rel.split('/').pop() ?? rel);
      if (!globRegex.test(target)) return;
    }

    const buffer = await readFile(absPath).catch(() => null);
    if (!buffer) return;
    if (buffer.subarray(0, 4096).includes(0)) return; // 二进制
    files.push({
      absPath,
      relPath: rel === '' ? absPath.split(sep).join('/') : rel,
      lines: buffer.toString('utf8').split(/\r?\n/),
    });
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > MAX_WALK_DEPTH) return;
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (truncated || options.signal?.aborted) return;
      if (item.isSymbolicLink()) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(item.name)) continue;
        await walk(full, depth + 1);
      } else if (item.isFile()) {
        await considerFile(full);
      }
    }
  };

  const info = await stat(options.root).catch(() => null);
  if (!info) return { files, truncated };
  if (info.isFile()) {
    await considerFile(options.root);
  } else {
    await walk(options.root, 0);
  }
  return { files, truncated };
}
