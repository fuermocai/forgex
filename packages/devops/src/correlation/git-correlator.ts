/**
 * Git 关联器（git-correlator）。
 *
 * 输入：堆栈帧里的用户代码文件路径 + Git 仓库根目录。
 * 输出：最近 Git 变更（commit hash / 时间 / 作者 / diff 统计）。
 *
 * 安全边界：只跑 git log/diff/show 只读命令；强制 cwd=repoRoot；
 * 不返回完整 diff，只返回统计 + 元数据。
 */
import { execFile } from 'node:child_process';
import { isAbsolute, normalize, relative } from 'node:path';
import { promisify } from 'node:util';
import type { GitChange, StackFrame } from './types.js';

const execFileAsync = promisify(execFile);

interface GitCorrelateOptions {
  repoRoot: string;
  timeWindowMs?: number;
  maxFiles?: number;
  execTimeoutMs?: number;
}

const DEFAULT_TIME_WINDOW_MS = 3_600_000;
const DEFAULT_MAX_FILES = 15;
const DEFAULT_EXEC_TIMEOUT_MS = 15_000;

export async function correlateWithGit(
  frames: ReadonlyArray<StackFrame>,
  options: GitCorrelateOptions,
): Promise<GitChange[]> {
  if (!frames.length || !options.repoRoot) return [];

  const timeWindowMs = options.timeWindowMs ?? DEFAULT_TIME_WINDOW_MS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const sinceIso = new Date(Date.now() - timeWindowMs).toISOString();

  const uniqueFiles = new Set<string>();
  for (const f of frames) {
    if (!f.filePath || f.isFramework) continue;
    const gitPath = toGitRelativePath(f.filePath, options.repoRoot);
    if (gitPath) uniqueFiles.add(gitPath);
  }

  if (uniqueFiles.size === 0) return [];

  const results: GitChange[] = [];
  for (const filePath of uniqueFiles) {
    try {
      const change = await gitLogOneFile(options.repoRoot, filePath, sinceIso, options.execTimeoutMs);
      if (change) results.push(change);
    } catch {
      continue;
    }
    if (results.length >= maxFiles) break;
  }

  results.sort((a, b) => new Date(b.lastCommitDate).getTime() - new Date(a.lastCommitDate).getTime());
  return results;
}

/* ------------------------------------------------------------------ */
/* 内部                                                                */
/* ------------------------------------------------------------------ */

function toGitRelativePath(filePath: string, repoRoot: string): string | undefined {
  try {
    const abs = isAbsolute(filePath) ? normalize(filePath) : normalize(repoRoot + '/' + filePath);
    const rel = relative(repoRoot, abs);
    if (rel.startsWith('..') || rel.startsWith('\\')) return undefined;
    return rel.replace(/\\/g, '/');
  } catch {
    return undefined;
  }
}

async function gitLogOneFile(
  repoRoot: string,
  filePath: string,
  sinceIso: string,
  timeoutMs?: number,
): Promise<GitChange | null> {
  const args = [
    'log', '--since', sinceIso, '-1',
    '--pretty=format:%H\t%an\t%ad\t%s',
    '--numstat', '--date=iso-strict', '--', filePath,
  ];

  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    timeout: timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
  });

  const lines = stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  const headerLine = lines[0];
  if (!headerLine) return null;
  const numstatLine = lines[1] ?? '';

  const headerMatch = headerLine.match(/^(\S+)\t([^\t]*)\t([^\t]*)\t?(.*)$/);
  if (!headerMatch) return null;

  const hash = headerMatch[1] ?? '';
  const author = (headerMatch[2] ?? '').trim();
  const date = headerMatch[3] ?? '';
  const message = (headerMatch[4] ?? '').trim();

  if (!hash) return null;

  let additions = 0;
  let deletions = 0;
  if (numstatLine) {
    const parts = numstatLine.split('\t');
    if (parts.length >= 3) {
      additions = parseInt(parts[0] ?? '0', 10) || 0;
      deletions = parseInt(parts[1] ?? '0', 10) || 0;
    }
  }

  let status: GitChange['status'] = 'M';
  try {
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain', '--', filePath], {
      cwd: repoRoot, timeout: 5000, maxBuffer: 64 * 1024,
    });
    const m = statusOut.trim().match(/^(.)/);
    const c = m?.[1];
    if (c && 'ADMRU?'.includes(c)) status = c as GitChange['status'];
  } catch { /* 忽略 */ }

  return {
    filePath,
    additions,
    deletions,
    lastCommitHash: hash,
    lastCommitDate: date,
    lastCommitMessage: message,
    author,
    status,
  };
}
