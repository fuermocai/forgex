/**
 * grep 的纯 Node 降级实现。
 *
 * 仅在系统未安装 ripgrep 时使用。策略：
 *  - 跳过 .git / node_modules / dist 等目录；
 *  - 单文件上限 1MB，扫描文件数上限 2000；
 *  - 逐行正则匹配，命中数达到上限立即停止。
 *
 * 明确说明：降级实现的性能与 .gitignore 支持都弱于 ripgrep，
 * 因此结果里会带 engine 字段，便于用户判断。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ForgeError } from '@forgex/shared';

const SKIP_DIRS = new Set(['.git', '.forgex', 'node_modules', 'dist', 'build', 'target', '.venv', '__pycache__']);

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface FallbackGrepOptions {
  root: string;
  pattern: string;
  caseSensitive: boolean;
  glob?: string;
  maxResults: number;
  signal?: AbortSignal;
}

export interface FallbackGrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  scannedFiles: number;
}

export async function fallbackGrep(options: FallbackGrepOptions): Promise<FallbackGrepResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, options.caseSensitive ? '' : 'i');
  } catch (err) {
    throw new ForgeError('TOOL_INVALID_INPUT', `无效的正则表达式: ${options.pattern}`, { cause: err });
  }
  const globRegex = options.glob ? globToRegExp(options.glob) : null;

  const info = await stat(options.root).catch((err: unknown) => {
    throw new ForgeError('PATH_NOT_FOUND', `搜索路径不存在: ${options.root}`, { cause: err });
  });

  const matches: GrepMatch[] = [];
  let scannedFiles = 0;
  let truncated = false;

  const considerFile = async (filePath: string): Promise<void> => {
    if (truncated) return;
    if (scannedFiles >= 2000) {
      truncated = true;
      return;
    }
    const fileInfo = await stat(filePath).catch(() => null);
    if (!fileInfo || !fileInfo.isFile() || fileInfo.size > 1024 * 1024) return;
    const rel = relative(options.root, filePath);
    if (globRegex && !globRegex.test(rel.split(sep).join('/'))) return;

    scannedFiles += 1;
    const buffer = await readFile(filePath).catch(() => null);
    if (!buffer) return;
    if (buffer.subarray(0, 4096).includes(0)) return; // 二进制跳过
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (options.signal?.aborted) return;
      const text = lines[i] ?? '';
      if (!regex.test(text)) continue;
      matches.push({ path: rel.split(sep).join('/'), line: i + 1, text: text.slice(0, 500) });
      if (matches.length >= options.maxResults) {
        truncated = true;
        return;
      }
    }
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > 12) return;
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (truncated || options.signal?.aborted) return;
      if (item.isSymbolicLink()) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) continue;
        await walk(full, depth + 1);
      } else if (item.isFile()) {
        await considerFile(full);
      }
    }
  };

  if (info.isFile()) {
    // 直接指定文件时忽略 glob（glob 仅用于目录遍历过滤）
    await considerFile(options.root);
  } else {
    await walk(options.root, 0);
  }

  return { matches, truncated, scannedFiles };
}

/** 简化版 glob -> RegExp：支持 *、**、?，其余字符转义 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}
