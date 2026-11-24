import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, readlink, realpath, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_ENV_ALLOWLIST } from '../../../../packages/security/src/policy/defaults.js';
import { redactText } from '../../../../packages/shared/src/utils/redact.js';
import type { GitFileEntry, GitStatusResult } from '../shared/desktop-api.js';

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_GIT_PATH_LENGTH = 4096;
const MAX_GIT_BATCH_LENGTH = 16_000;
const MAX_GIT_PATH_COUNT = 256;
const MAX_COMMIT_MESSAGE_LENGTH = 4096;
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const IS_WINDOWS = process.platform === 'win32';
const GIT_ENV_ALLOWLIST = new Set([
  ...DEFAULT_ENV_ALLOWLIST,
  'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'WINDIR',
  'XDG_CONFIG_HOME', 'TMPDIR', 'SHELL', 'EMAIL', 'GNUPGHOME', 'GPG_TTY', 'SSH_AUTH_SOCK',
].map((key) => key.toUpperCase()));

/** Checks whether a value can be an IPC Git path argument. */
export function isGitPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_GIT_PATH_LENGTH && !value.includes('\0');
}

/** Checks that a path batch is nonempty and fits within the argument budget. */
export function isGitPathList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GIT_PATH_COUNT) {
    return false;
  }
  let length = 0;
  for (const path of value) {
    if (!isGitPath(path)) {
      return false;
    }
    // Account for the literal prefix, Windows quoting, and the separator.
    length += 2 * path.length + 13;
  }
  return length <= MAX_GIT_BATCH_LENGTH;
}

/** Checks that a commit message fits in one Git argument. */
export function isGitCommitMessage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_COMMIT_MESSAGE_LENGTH
    && !value.includes('\0') && value.trim().length > 0;
}

/** Handles Git operations for the active, authorized desktop project. */
export class DesktopGitService {
  private mutationActive = false;

  /** Reports branch information and all changed paths. */
  async status(root: string): Promise<GitStatusResult> {
    const git = await openRepository(root);
    return readStatus(git, root);
  }

  /** Returns the selected file's index or working tree diff. */
  async diff(root: string, path: string, staged: boolean): Promise<string> {
    const file = toRelativeGitPath(path);
    await inspectFilePath(root, file);
    const git = await openRepository(root);
    const status = await readStatus(git, root);
    const entry = status.entries.find((candidate) => candidate.path === file);
    const options = ['--no-ext-diff', '--no-color', '--no-textconv'];
    if (!staged && entry?.worktreeStatus === '?') {
      const kind = await inspectFilePath(root, file);
      if (kind === 'symlink') {
        const target = await readlink(resolve(root, file)).catch(() => {
          throw new Error('无法读取 Git 符号链接');
        });
        return `符号链接目标：${JSON.stringify(target)}\n`;
      }
      if (kind !== 'file') {
        throw new Error('未跟踪的 Git 文件已不存在');
      }
      return git(['diff', '--no-index', ...options, '--', '/dev/null', `./${file}`], 'diff-found');
    }

    const side = staged ? entry?.indexStatus : entry?.worktreeStatus;
    const paths = [file];
    if ((side === 'R' || side === 'C') && entry?.originalPath) {
      const original = toRelativeGitPath(entry.originalPath);
      await inspectFilePath(root, original);
      paths.push(original);
    }
    return git(['diff', ...options, ...(staged ? ['--cached'] : []), '--', ...literalPathspecs(paths)]);
  }

  /** Adds the selected file paths to the index. */
  async stage(root: string, paths: string[]): Promise<void> {
    await this.updateIndex(root, paths, 'stage');
  }

  /** Unstages selected entries while preserving their working tree files. */
  async unstage(root: string, paths: string[]): Promise<void> {
    await this.updateIndex(root, paths, 'unstage');
  }

  /** Commits the existing index and returns the resulting commit ID. */
  async commit(root: string, message: string): Promise<{ commit: string }> {
    if (!isGitCommitMessage(message)) {
      throw new Error('提交说明不能为空、包含空字符或超出长度限制');
    }
    return this.mutate(async () => {
      const git = await openRepository(root);
      const hooksPath = await mkdtemp(join(tmpdir(), 'forgex-git-hooks-')).catch(() => {
        throw new Error('无法创建用于提交的空 Git 钩子目录');
      });
      try {
        await git(['-c', `core.hooksPath=${hooksPath}`, 'commit', '-m', message]);
      } finally {
        await rmdir(hooksPath).catch(() => {
          // A cleanup error must not mask whether Git created the commit.
        });
      }
      return { commit: (await git(['rev-parse', 'HEAD'])).trim() };
    });
  }

  private async updateIndex(root: string, paths: string[], action: 'stage' | 'unstage'): Promise<void> {
    if (!isGitPathList(paths)) {
      throw new Error('Git 文件列表为空、格式无效或超出长度限制');
    }
    const files = paths.map((path) => toRelativeGitPath(path));
    await this.mutate(async () => {
      for (const file of files) {
        await inspectFilePath(root, file);
      }
      const git = await openRepository(root);
      const status = await readStatus(git, root);
      const changedPaths = new Set<string>();
      for (const entry of status.entries) {
        changedPaths.add(entry.path);
        if (entry.originalPath !== undefined) {
          changedPaths.add(entry.originalPath);
        }
      }
      if (files.some((file) => !changedPaths.has(file))) {
        throw new Error('Git 文件状态已变更，请刷新后重试');
      }
      const pathspecs = literalPathspecs(files);
      if (action === 'stage') {
        await git(['add', '--', ...pathspecs]);
      } else if (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], 'head-missing')) {
        await git(['restore', '--staged', '--', ...pathspecs]);
      } else {
        // Without HEAD, remove only the selected index entries, even when
        // their staged content differs from the current working tree files.
        await git(['rm', '--cached', '--force', '--', ...pathspecs]);
      }
    });
  }

  private async mutate<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.mutationActive) {
      throw new Error('正在更新 Git 仓库，请稍后重试');
    }
    this.mutationActive = true;
    try {
      return await operation();
    } finally {
      this.mutationActive = false;
    }
  }
}

type ExpectedGitExit = 'diff-found' | 'head-missing';
type GitCommand = (args: string[], expectedExit?: ExpectedGitExit) => Promise<string>;

async function openRepository(root: string): Promise<GitCommand> {
  const canonicalRoot = await realpath(root).catch(() => {
    throw new Error('无法访问当前项目的 Git 工作区');
  });
  if (root !== canonicalRoot) {
    throw new Error('当前项目的 Git 工作区路径已变更');
  }
  const executable = await findGitExecutable();
  const git: GitCommand = (args, expectedExit) => runGit(executable, root, args, expectedExit);
  const output = await git(['rev-parse', '--show-toplevel']);
  const topLevel = output.replace(IS_WINDOWS ? /\r?\n$/ : /\n$/, '');
  if (!isAbsolute(topLevel)) {
    throw new Error('无法解析 Git 仓库根目录');
  }
  const repositoryRoot = await realpath(topLevel).catch(() => {
    throw new Error('无法解析 Git 仓库根目录');
  });
  if (repositoryRoot !== canonicalRoot) {
    throw new Error('Git 仓库根目录必须是当前已授权的项目目录');
  }
  return git;
}

async function findGitExecutable(): Promise<string> {
  const path = process.env.PATH ?? process.env.Path ?? '';
  const name = IS_WINDOWS ? 'git.exe' : 'git';
  // Resolve from absolute PATH entries so a project-local executable is never
  // picked through implicit current-directory lookup.
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) {
      continue;
    }
    const candidate = resolve(directory, name);
    try {
      if ((await stat(candidate)).isFile()) {
        await access(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue to the next configured executable directory.
    }
  }
  throw new Error('找不到 Git 可执行程序，请安装 Git 并将其加入 PATH');
}

function runGit(executable: string, cwd: string, args: string[], expectedExit?: ExpectedGitExit): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    // Avoid passing app credentials or Git variables that could redirect the
    // selected repository. Preserve Git identity and common signing settings.
    if (GIT_ENV_ALLOWLIST.has(name) || /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(name)) {
      env[key] = value;
    }
  }
  env.LC_ALL = 'C';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_LAZY_FETCH = '1';

  return new Promise((fulfill, reject) => {
    execFile(executable, ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const expectedFailure = error?.code === 1 && (
        (expectedExit === 'diff-found' && stdout.length > 0)
        || (expectedExit === 'head-missing' && stdout.length === 0 && stderr.length === 0)
      );
      if (!error || expectedFailure) {
        fulfill(stdout);
        return;
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        reject(new Error('Git 输出超出大小限制'));
      } else if (error.killed) {
        reject(new Error('Git 操作超时'));
      } else {
        const detail = redactText(stderr.trim()).slice(0, 600);
        reject(new Error(detail ? `Git 操作失败：${detail}` : 'Git 操作失败，无法完成当前请求'));
      }
    });
  });
}

function toRelativeGitPath(path: string): string {
  if (!isGitPath(path) || isAbsolute(path) || /^[a-z]:[\\/]/i.test(path) || (IS_WINDOWS && path.includes(':'))) {
    throw new Error('Git 文件路径必须是工作区内的相对路径');
  }
  const segments = path.split(IS_WINDOWS ? /[\\/]/ : '/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
    throw new Error('Git 文件路径包含无效的目录段');
  }
  return segments.join('/');
}

function literalPathspecs(paths: string[]): string[] {
  return paths.map((path) => `:(literal)${path}`);
}

async function inspectFilePath(root: string, path: string): Promise<'file' | 'symlink' | undefined> {
  const segments = path.split('/');
  let target = root;
  for (const [index, segment] of segments.entries()) {
    target = resolve(target, segment);
    const info = await lstat(target).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // Deleted files (including deleted parent directories) remain valid
        // index paths.
        return undefined;
      }
      throw new Error('无法访问工作区内指定的 Git 文件');
    });
    if (!info) {
      return undefined;
    }
    if (index === segments.length - 1) {
      // Git stores a terminal symlink as a file without reading its target.
      if (info.isSymbolicLink()) {
        return 'symlink';
      }
      if (info.isFile()) {
        return 'file';
      }
      throw new Error('指定路径不是工作区内的文件');
    } else {
      if (!info.isDirectory()) {
        throw new Error('Git 文件路径不能经过符号链接或非目录路径');
      }
      const canonicalTarget = await realpath(target).catch(() => {
        throw new Error('无法访问工作区内指定的 Git 目录');
      });
      const fromRoot = relative(root, canonicalTarget);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new Error('Git 文件路径越出工作区');
      }
    }
  }
  return undefined;
}

async function readStatus(git: GitCommand, root: string): Promise<GitStatusResult> {
  const records = (await git(['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])).split('\0');
  const header = records.shift();
  if (!header?.startsWith('## ') || records.pop() !== '') {
    throw new Error('无法解析 Git 仓库状态');
  }
  const branchHeader = header.slice(3).replace(/^(?:No commits yet on|Initial commit on) /, '');
  const [branch = '', tracking = ''] = branchHeader.split('...');
  const ahead = Number(tracking.match(/\[ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(tracking.match(/(?:\[|, )behind (\d+)/)?.[1] ?? 0);
  const entries: GitFileEntry[] = [];
  const remaining = records.values();
  for (const record of remaining) {
    const path = record.slice(3);
    const indexStatus = record.charAt(0);
    const worktreeStatus = record.charAt(1);
    if (record.charAt(2) !== ' ' || !path) {
      throw new Error('无法解析 Git 文件状态');
    }
    const entry: GitFileEntry = {
      path,
      indexStatus,
      worktreeStatus,
      conflicted: CONFLICT_CODES.has(record.slice(0, 2)),
    };
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      const original = remaining.next();
      if (original.done || !original.value) {
        throw new Error('无法解析 Git 文件的原始路径');
      }
      entry.originalPath = original.value;
    }
    entries.push(entry);
  }
  return { root, branch, ahead, behind, entries };
}
