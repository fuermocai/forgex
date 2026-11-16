import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ForgeError, uuid } from '@forgex/shared';

const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const MAX_PATCH_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 60_000;

export interface SubagentSnapshot {
  repoRoot: string;
  gitCommonDir: string;
  baseline: string;
  root: string;
  hooksPath: string;
}

export interface SubagentWorktree {
  id: string;
  repoRoot: string;
  gitCommonDir: string;
  root: string;
  path: string;
  baseline: string;
}

export interface SubagentChanges {
  changedPaths: string[];
  patch: string;
  patchTruncated: boolean;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export async function createSubagentSnapshot(cwd: string, signal?: AbortSignal): Promise<SubagentSnapshot> {
  const repoRoot = await gitText(['rev-parse', '--show-toplevel'], cwd, signal);
  const canonicalRepo = await realpath(repoRoot.trim());
  const commonDir = (await gitText(['rev-parse', '--git-common-dir'], canonicalRepo, signal)).trim();
  const gitCommonDir = await realpath(resolve(canonicalRepo, commonDir));
  const head = (await gitText(['rev-parse', 'HEAD'], canonicalRepo, signal)).trim();
  await ensureNoExternalFilters(canonicalRepo, signal);
  const entries = (await gitText(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], canonicalRepo, signal))
    .split('\0').filter(Boolean);
  let totalBytes = 0;
  for (const entry of entries) {
    checkAborted(signal);
    try {
      const stat = await lstat(join(canonicalRepo, entry));
      if (stat.isFile() || stat.isSymbolicLink()) totalBytes += stat.size;
      if (totalBytes > MAX_SNAPSHOT_BYTES) {
        throw new ForgeError('SUBAGENT_BUDGET_EXCEEDED', `父工作区快照超过 ${MAX_SNAPSHOT_BYTES} 字节`, {
          details: { maxBytes: MAX_SNAPSHOT_BYTES, measuredBytes: totalBytes },
        });
      }
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const indexEntries = await gitText(['ls-files', '--stage', '-z'], canonicalRepo, signal);
  if (indexEntries.split('\0').some((entry) => entry.startsWith('160000 '))) {
    throw new ForgeError('WORKTREE_CREATE_FAILED', '当前工作区包含 Git 子模块；为避免快照内容失真，拒绝派发子 Agent');
  }

  const root = await mkdtemp(join(tmpdir(), 'forgex-subagents-'));
  const hooksPath = join(root, 'hooks-disabled');
  const indexDir = await mkdtemp(join(tmpdir(), 'forgex-subagent-index-'));
  const indexPath = join(indexDir, 'index');
  try {
    await mkdir(hooksPath);
    const env = { GIT_INDEX_FILE: indexPath };
    await gitText(['read-tree', head], canonicalRepo, signal, env);
    await gitText(['add', '--all', '--', '.'], canonicalRepo, signal, env);
    const tree = (await gitText(['write-tree'], canonicalRepo, signal, env)).trim();
    const blobs = await gitText(['ls-tree', '-r', '-l', tree], canonicalRepo, signal);
    const objectBytes = blobs.split(/\r?\n/).reduce((total, line) => {
      const match = /^\d+ blob [a-f\d]+\s+(\d+)\t/.exec(line);
      return total + (match ? Number(match[1]) : 0);
    }, 0);
    if (objectBytes > MAX_SNAPSHOT_BYTES) {
      throw new ForgeError('SUBAGENT_BUDGET_EXCEEDED', `Git 快照超过 ${MAX_SNAPSHOT_BYTES} 字节`, {
        details: { maxBytes: MAX_SNAPSHOT_BYTES, measuredBytes: objectBytes },
      });
    }
    const commit = (await gitText([
      '-c', 'user.name=ForgeX', '-c', 'user.email=forgex@localhost', '-c', 'commit.gpgsign=false',
      'commit-tree', tree, '-p', head, '-m', `ForgeX subagent snapshot ${uuid()}`,
    ], canonicalRepo, signal)).trim();
    return { repoRoot: canonicalRepo, gitCommonDir, baseline: commit, root: await realpath(root), hooksPath: await realpath(hooksPath) };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createSubagentWorktree(snapshot: SubagentSnapshot, name: string, signal?: AbortSignal): Promise<SubagentWorktree> {
  await ensureNoExternalFilters(snapshot.repoRoot, signal);
  const safeName = sanitizeName(name);
  const id = `${safeName}-${uuid()}`;
  const path = resolve(snapshot.root, id);
  assertInside(snapshot.root, path);
  await gitText(['-c', `core.hooksPath=${snapshot.hooksPath}`, 'worktree', 'add', '--detach', path, snapshot.baseline], snapshot.repoRoot, signal);
  try {
    const actualPath = await realpath(path);
    assertInside(await realpath(snapshot.root), actualPath);
    const worktreeRoot = (await gitText(['rev-parse', '--show-toplevel'], actualPath, signal)).trim();
    if (normalizePath(await realpath(worktreeRoot)) !== normalizePath(actualPath)) {
      throw new ForgeError('WORKTREE_PATH_INVALID', 'Git worktree 根目录与请求路径不一致', {
        details: { expectedWorktreePath: actualPath, actualWorktreeRoot: worktreeRoot },
      });
    }
    const commonDir = (await gitText(['rev-parse', '--git-common-dir'], actualPath, signal)).trim();
    const actualCommonDir = await realpath(resolve(actualPath, commonDir));
    if (normalizePath(actualCommonDir) !== normalizePath(snapshot.gitCommonDir)) {
      throw new ForgeError('WORKTREE_PATH_INVALID', 'Git worktree 所属仓库与父仓库不一致', {
        details: { expectedGitCommonDir: snapshot.gitCommonDir, actualGitCommonDir: actualCommonDir, worktreePath: actualPath },
      });
    }
    const head = (await gitText(['rev-parse', 'HEAD'], actualPath, signal)).trim();
    if (head !== snapshot.baseline) throw new ForgeError('WORKTREE_PATH_INVALID', 'Git worktree 未从派发快照基线创建');
    return { id, repoRoot: snapshot.repoRoot, gitCommonDir: snapshot.gitCommonDir, root: snapshot.root, path: actualPath, baseline: snapshot.baseline };
  } catch (error) {
    await gitText(['-c', `core.hooksPath=${snapshot.hooksPath}`, 'worktree', 'remove', '--force', path], snapshot.repoRoot).catch(() => undefined);
    throw error;
  }
}

export async function captureSubagentChanges(worktree: SubagentWorktree, signal?: AbortSignal): Promise<SubagentChanges> {
  const indexDir = await mkdtemp(join(tmpdir(), 'forgex-subagent-result-'));
  const indexPath = join(indexDir, 'index');
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await ensureNoExternalFilters(worktree.repoRoot, signal);
    await gitText(['read-tree', worktree.baseline], worktree.path, signal, env);
    await gitText(['add', '--all', '--', '.'], worktree.path, signal, env);
    const paths = await gitText(['diff', '--cached', '--name-only', '-z', worktree.baseline], worktree.path, signal, env);
    const diff = await git(['diff', '--cached', '--binary', '--no-ext-diff', worktree.baseline], worktree.path, signal, env, MAX_PATCH_BYTES);
    return {
      changedPaths: paths.split('\0').filter(Boolean),
      patch: diff.stdout,
      patchTruncated: diff.truncated,
    };
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function cleanupSubagentWorktree(worktree: SubagentWorktree): Promise<void> {
  const root = await realpath(worktree.root);
  const target = await realpath(worktree.path);
  assertInside(root, target);
  if (basename(target) !== worktree.id) throw new ForgeError('WORKTREE_PATH_INVALID', 'worktree 路径与保存的任务标识不一致');
  const registered = await gitText(['worktree', 'list', '--porcelain'], worktree.repoRoot);
  const registeredPaths = registered.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => normalizePath(resolve(line.slice('worktree '.length))));
  if (!registeredPaths.includes(normalizePath(target))) {
    throw new ForgeError('WORKTREE_PATH_INVALID', '目标目录不是父仓库登记的 Git worktree');
  }
  const actualRoot = (await gitText(['rev-parse', '--show-toplevel'], target)).trim();
  if (normalizePath(await realpath(actualRoot)) !== normalizePath(target)) {
    throw new ForgeError('WORKTREE_PATH_INVALID', 'worktree 根目录不匹配，拒绝清理');
  }
  const commonDir = (await gitText(['rev-parse', '--git-common-dir'], target)).trim();
  const actualCommonDir = await realpath(resolve(target, commonDir));
  if (normalizePath(actualCommonDir) !== normalizePath(worktree.gitCommonDir)) {
    throw new ForgeError('WORKTREE_PATH_INVALID', 'worktree 所属仓库不匹配，拒绝清理');
  }
  const baselineCheck = await git(['merge-base', '--is-ancestor', worktree.baseline, 'HEAD'], target);
  if (baselineCheck.code !== 0) {
    throw new ForgeError('WORKTREE_PATH_INVALID', 'worktree HEAD 不再基于派发快照基线，拒绝自动清理');
  }
  await gitText(['-c', `core.hooksPath=${join(root, 'hooks-disabled')}`, 'worktree', 'remove', '--force', target], worktree.repoRoot);
  await git(['worktree', 'prune'], worktree.repoRoot).catch(() => undefined);
}

export async function cleanupSubagentSnapshot(snapshot: SubagentSnapshot): Promise<void> {
  const root = await realpath(snapshot.root);
  if (basename(root).startsWith('forgex-subagents-')) await rm(root, { recursive: true, force: true });
}

export function snapshotRootContains(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function assertInside(root: string, target: string): void {
  if (!snapshotRootContains(root, target)) {
    throw new ForgeError('WORKTREE_PATH_INVALID', `worktree 路径越出管理目录: ${target}`, { details: { root, target } });
  }
}

function sanitizeName(name: string): string {
  return name.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'worker';
}

function normalizePath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ForgeError('ABORTED', '子 Agent 派发已取消');
}

async function ensureNoExternalFilters(repoRoot: string, signal?: AbortSignal): Promise<void> {
  const filters = await git(['config', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], repoRoot, signal);
  if (filters.code === 0) {
    throw new ForgeError('WORKTREE_CREATE_FAILED', '检测到 Git clean/smudge filter 或 process filter；为避免运行仓库配置的外部程序，拒绝继续处理子 Agent 快照');
  }
  if (filters.code !== 1) {
    throw new ForgeError('WORKTREE_CREATE_FAILED', `检查 Git filter 配置失败: ${filters.stderr.slice(0, 300)}`);
  }
}

async function gitText(args: readonly string[], cwd: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await git(args, cwd, signal, env);
  if (result.truncated) {
    throw new ForgeError('WORKTREE_CREATE_FAILED', `git ${args[0] ?? ''} 输出超过安全读取上限`);
  }
  if (result.code !== 0) {
    throw new ForgeError('WORKTREE_CREATE_FAILED', `git ${args[0] ?? ''} 失败: ${result.stderr.slice(0, 500)}`, {
      details: { args: [...args], cwd, exitCode: result.code },
    });
  }
  return result.stdout;
}

function git(
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  extraEnv?: NodeJS.ProcessEnv,
  maxOutputBytes = 8 * 1024 * 1024,
): Promise<GitResult> {
  checkAborted(signal);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.platform === 'win32' ? 'git.exe' : 'git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      // Keep machine-wide Git filters (for example Git for Windows' system LFS
      // registration) out of snapshots. Repository/global filters remain visible
      // to ensureNoExternalFilters and are rejected before any add/worktree runs.
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;
    const timer = setTimeout(() => { child.kill(); }, GIT_TIMEOUT_MS);
    const onAbort = (): void => { child.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = maxOutputBytes - outputBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        stdout.push(retained);
        outputBytes += retained.length;
      }
      if (chunk.length > remaining) truncated = true;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 1024 * 1024) stderr.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new ForgeError('WORKTREE_CREATE_FAILED', `无法启动 Git: ${error.message}`, { cause: error }));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new ForgeError('ABORTED', '子 Agent 派发已取消'));
        return;
      }
      resolvePromise({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated });
    });
  });
}
