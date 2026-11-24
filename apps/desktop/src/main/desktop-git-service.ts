import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_ENV_ALLOWLIST } from '../../../../packages/security/src/policy/defaults.js';
import { redactText } from '../../../../packages/shared/src/utils/redact.js';
import type { GitFileEntry, GitSnapshot, GitStatusResult } from '../shared/desktop-api.js';
import { previewUntrackedFile } from './git-file-preview.js';

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const GIT_PATH_QUERY_BYTES = 64 * 1024;
const FILE_DIRECTORY_CONFLICT = '所选 Git 路径与其他文件存在文件和目录冲突，无法单独更新暂存状态';
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
    return withPrivateIndex(root, false, async (git) => {
      const headRef = await readHeadRef(git);
      const head = await readHead(git);
      const status = await readStatus(git, root);
      if (status.entries.some((entry) => entry.indexStatus !== ' ' && entry.indexStatus !== '?')
        && !status.entries.some((entry) => entry.conflicted)) {
        status.snapshot = { head, headRef, tree: (await git(['write-tree'])).trim() };
      }
      if (head !== await readHead(git) || headRef !== await readHeadRef(git)) throw new Error('Git HEAD 已变更，请刷新后重试');
      return status;
    });
  }

  /** Returns the selected file's index or working tree diff. */
  async diff(root: string, path: string, staged: boolean): Promise<string> {
    const file = toRelativeGitPath(path);
    const git = await openRepository(root);
    const head = staged ? await readHead(git) : '';
    await inspectFilePath(root, file, git, head);
    const status = await readStatus(git, root);
    const entry = status.entries.find((candidate) => candidate.path === file && (staged
      ? candidate.indexStatus !== ' ' && candidate.indexStatus !== '?'
      : candidate.worktreeStatus !== ' '));
    if (!entry) throw new Error('Git 文件状态已变更，请刷新后重试');
    const options = ['--no-ext-diff', '--no-color', '--no-textconv'];
    if (!staged && entry?.worktreeStatus === '?') {
      return previewUntrackedFile(root, file);
    }

    const side = staged ? entry?.indexStatus : entry?.worktreeStatus;
    const paths = [file];
    if ((side === 'R' || side === 'C') && entry?.originalPath) {
      const original = toRelativeGitPath(entry.originalPath);
      await inspectFilePath(root, original, git, head);
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
  async commit(root: string, message: string, snapshot: GitSnapshot): Promise<{ commit: string }> {
    if (!isGitCommitMessage(message)) {
      throw new Error('提交说明不能为空、包含空字符或超出长度限制');
    }
    return this.mutate(() => withPrivateIndex(root, false, async (git) => {
      const { head, headRef, tree } = snapshot;
      if (head !== await readHead(git) || headRef !== await readHeadRef(git) || tree !== (await git(['write-tree'])).trim()) {
        throw new Error('暂存内容或 HEAD 已变更，请刷新并重新确认');
      }
      const parentTree = head ? (await git(['rev-parse', `${head}^{tree}`])).trim()
        : createHash(tree.length === 64 ? 'sha256' : 'sha1').update('tree 0\0').digest('hex');
      if (tree === parentTree) throw new Error('没有可提交的暂存内容');
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        if (await lstat(await gitPath(git, marker)).catch(ignoreMissing)) {
          throw new Error('请先在 Git 中完成正在进行的仓库操作');
        }
      }
      const commit = (await git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message])).trim();
      // Preparing a HEAD update locks HEAD and its referent, and checks the old OID.
      // Only acknowledge the prepared update while HEAD still names the reviewed branch.
      await git(['update-ref', '-m', `commit: ${message.split('\n')[0]}`, '--stdin'], {
        commit, parent: head || '0'.repeat(tree.length),
        verifyPrepared: async () => {
          if (headRef !== await readHeadRef(git)) throw new Error('Git HEAD 已变更，请刷新并重新确认');
          if (headRef && await git(['symbolic-ref', '--quiet', '--no-recurse', headRef], 'head-missing')) {
            throw new Error('请在 Git 中提交到间接符号引用');
          }
        },
      });
      return { commit };
    }));
  }

  private async updateIndex(root: string, paths: string[], action: 'stage' | 'unstage'): Promise<void> {
    if (!isGitPathList(paths)) {
      throw new Error('Git 文件列表为空、格式无效或超出长度限制');
    }
    const files = paths.map((path) => toRelativeGitPath(path));
    await this.mutate(() => withPrivateIndex(root, true, async (git) => {
      const head = action === 'unstage' ? await readHead(git) : '';
      const restoringGitlinks = new Set<string>();
      for (const file of files) {
        if (await inspectFilePath(root, file, git, head) === 'gitlink' && head) restoringGitlinks.add(file);
      }
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
      if (hasFileDirectoryConflict(files, changedPaths, restoringGitlinks)) {
        throw new Error(FILE_DIRECTORY_CONFLICT);
      }
      const pathspecs = literalPathspecs(files);
      await checkIndexAndTreePaths(git, files, head);
      const otherEntries = ['ls-files', '--stage', '-v', '-z', '--', ...files.map((file) => `:(top,exclude,literal)${file}`)];
      const before = await git(otherEntries, 'index-digest');
      if (action === 'stage') {
        await git(['add', '--', ...pathspecs]);
      } else if (head) {
        await git(['restore', `--source=${head}`, '--staged', '--', ...pathspecs]);
      } else {
        // Without HEAD, remove only the selected index entries, even when
        // their staged content differs from the current working tree files.
        await git(['rm', '--cached', '--force', '--', ...pathspecs]);
      }
      if (before !== await git(otherEntries, 'index-digest')) throw new Error(FILE_DIRECTORY_CONFLICT);
      await checkIndexAndTreePaths(git, files, head);
    }));
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

interface RefTransaction {
  commit: string;
  parent: string;
  verifyPrepared(): Promise<void>;
}
type GitCommandMode = 'head-missing' | 'path-query' | 'index-digest' | RefTransaction;
type GitCommand = (args: string[], mode?: GitCommandMode, indexPath?: string) => Promise<string>;

function ignoreMissing(error: unknown): undefined {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
  throw error;
}

async function readHead(git: GitCommand): Promise<string> {
  return (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], 'head-missing')).trim();
}

async function readHeadRef(git: GitCommand): Promise<string | null> {
  const ref = await git(['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'], 'head-missing');
  if (ref.includes('\uFFFD')) throw new Error('无法解码 Git 分支名称');
  return ref.replace(/\r?\n$/, '') || null;
}

async function gitPath(git: GitCommand, name: string): Promise<string> {
  const path = (await git(['rev-parse', '--path-format=absolute', '--git-path', name])).replace(/\r?\n$/, '');
  if (!isAbsolute(path)) throw new Error('无法定位 Git 元数据');
  return path;
}

/** Operates on one private index snapshot. Writers hold Git's real index lock
 * until their verified index is atomically installed. Readers copy an inode
 * published by Git's normal lock-and-rename protocol.
 */
async function withPrivateIndex<T>(root: string, publish: boolean, operation: (git: GitCommand) => Promise<T>): Promise<T> {
  const repo = await openRepository(root);
  const index = await gitPath(repo, 'index');
  const directory = await mkdtemp(join(tmpdir(), 'forgex-git-'));
  const work = join(directory, 'index');
  const hooks = join(directory, 'hooks');
  const lock = `${index}.lock`;
  let locked = false;
  try {
    await mkdir(hooks);
    if (publish) {
      const handle = await open(lock, 'wx').catch(() => { throw new Error('Git 索引已锁定或不可写，请稍后重试'); });
      locked = true;
      await handle.close();
    }
    await copyFile(index, work).catch(ignoreMissing);
    const git: GitCommand = (args, mode) => repo(['-c', `core.hooksPath=${hooks}`, ...args], mode, work);
    const result = await operation(git);
    if (publish) {
      await copyFile(work, lock);
      await rename(lock, index);
      locked = false;
    }
    return result;
  } finally {
    if (locked) await rm(lock, { force: true }).catch(() => console.warn('无法清理 Git 索引锁'));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => console.warn('无法清理临时 Git 目录'));
  }
}

async function openRepository(root: string): Promise<GitCommand> {
  const canonicalRoot = await realpath(root).catch(() => {
    throw new Error('无法访问当前项目的 Git 工作区');
  });
  if (root !== canonicalRoot) {
    throw new Error('当前项目的 Git 工作区路径已变更');
  }
  const executable = await findGitExecutable();
  const git: GitCommand = (args, mode, index) => runGit(executable, root, args, mode, index);
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

function runGit(executable: string, cwd: string, args: string[], mode?: GitCommandMode, index?: string): Promise<string> {
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
  if (index) env.GIT_INDEX_FILE = index;

  const options = { cwd, env, shell: false, windowsHide: true, timeout: GIT_TIMEOUT_MS };
  const argv = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args];
  // Hash raw NUL records in bounded memory, including non-UTF-8 names.
  if (mode === 'index-digest') return new Promise((fulfill, reject) => {
    const hash = createHash('sha256');
    const child = spawn(executable, argv, { ...options, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (data: Buffer) => hash.update(data));
    child.on('error', () => reject(new Error('无法验证 Git 索引')));
    child.on('close', (code) => {
      if (code === 0) fulfill(hash.digest('hex'));
      else reject(new Error('无法验证 Git 索引'));
    });
  });
  return new Promise((fulfill, reject) => {
    let verificationFailure: Error | undefined;
    const child = execFile(executable, argv, {
      ...options,
      maxBuffer: mode === 'path-query' ? GIT_PATH_QUERY_BYTES : GIT_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (verificationFailure) {
        reject(verificationFailure);
        return;
      }
      if (typeof mode === 'object' && !error && !stdout.endsWith('commit: ok\n')) {
        reject(new Error('Git 引用事务未完成'));
        return;
      }
      const expectedFailure = error?.code === 1 && mode === 'head-missing' && stdout.length === 0 && stderr.length === 0;
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
    if (typeof mode === 'object') {
      const input = child.stdin;
      if (!input || !child.stdout) {
        child.kill();
        reject(new Error('无法启动 Git 引用事务'));
        return;
      }
      input.on('error', (error) => reject(error));
      let response = '';
      const onPrepare = (chunk: string) => {
        response += chunk;
        if (!response.endsWith('prepare: ok\n')) return;
        child.stdout?.off('data', onPrepare);
        void mode.verifyPrepared().then(
          () => input.end('commit\n'),
          (error: unknown) => {
            verificationFailure = error instanceof Error ? error : new Error('无法验证 Git HEAD');
            input.end('abort\n');
          },
        );
      };
      child.stdout.on('data', onPrepare);
      input.write(`start\nupdate HEAD ${mode.commit} ${mode.parent}\nprepare\n`);
    }
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

async function checkIndexAndTreePaths(git: GitCommand, files: string[], head: string): Promise<void> {
  const selected = new Set(files);
  const parentsByDepth: Array<Set<string>> = [];
  for (const file of selected) {
    let depth = 0;
    for (const parent of parentGitPaths(file)) {
      (parentsByDepth[depth] ??= new Set<string>()).add(parent);
      depth++;
    }
  }

  // A literal index pathspec also matches its descendants, including entries
  // hidden from porcelain by assume-unchanged or skip-worktree.
  const indexed = await readGitPathRecords(git, ['ls-files', '--cached', '-z', '--', ...literalPathspecs(files)]);
  if (indexed.some((path) => !selected.has(path))) {
    throw new Error(FILE_DIRECTORY_CONFLICT);
  }
  if (head) {
    await checkTreePathTypes(git, head, files, false);
  }
  for (const [depth, parents] of parentsByDepth.entries()) {
    const paths = [...parents];
    // Only a file at an ancestor itself conflicts. Exclude everything below
    // this depth so a populated parent directory never lists its children.
    const belowParents = `:(top,exclude,glob)${'*/'.repeat(depth + 1)}**`;
    const indexedParents = await readGitPathRecords(git,
      ['ls-files', '--cached', '-z', '--', ...literalPathspecs(paths), belowParents]);
    if (indexedParents.length > 0) {
      throw new Error(FILE_DIRECTORY_CONFLICT);
    }
    if (head) {
      await checkTreePathTypes(git, head, paths, true);
    }
  }
}

async function checkTreePathTypes(git: GitCommand, head: string, paths: string[], directories: boolean): Promise<void> {
  const entries = await readGitPathRecords(git, ['--literal-pathspecs', 'ls-tree', '-z', head, '--', ...paths]);
  for (const entry of entries) {
    const type = /^\d{6} (blob|tree|commit) [0-9a-f]+\t/.exec(entry)?.[1];
    if (!type || (type === 'tree') !== directories) {
      throw new Error(FILE_DIRECTORY_CONFLICT);
    }
  }
}

async function readGitPathRecords(git: GitCommand, args: string[]): Promise<string[]> {
  const records = (await git(args, 'path-query')).split('\0');
  if (records.pop() !== '' || records.includes('')) {
    throw new Error('无法解析 Git 路径检查结果');
  }
  return records;
}

function hasFileDirectoryConflict(files: string[], candidatePaths: ReadonlySet<string>, restoringGitlinks: ReadonlySet<string>): boolean {
  const selected = new Set(files);
  const selectedParents = new Set<string>();
  for (const file of files) {
    for (const parent of parentGitPaths(file)) {
      selectedParents.add(parent);
    }
  }
  for (const candidate of candidatePaths) {
    if (selectedParents.has(candidate)) {
      return true;
    }
    for (const parent of parentGitPaths(candidate)) {
      // Porcelain also reports "module/" as untracked after rm --cached.
      // A staged restore touches only the index. Its index/tree boundary
      // checks below independently reject real descendants in either source.
      if (selected.has(parent) && !restoringGitlinks.has(parent)) {
        return true;
      }
    }
  }
  return false;
}

function* parentGitPaths(path: string): Iterable<string> {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    yield path.slice(0, slash);
  }
}

async function inspectFilePath(root: string, path: string, git: GitCommand, head: string): Promise<'file' | 'symlink' | 'gitlink' | undefined> {
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
      if (info.isDirectory()) {
        const entries = await readGitPathRecords(git, ['ls-files', '--stage', '-z', '--', ...literalPathspecs([path])]);
        const isExactGitlink = (entry: string) =>
          entry.startsWith('160000 ') && entry.slice(entry.indexOf('\t') + 1) === path;
        if (entries.some(isExactGitlink)) return 'gitlink';
        if (entries.length === 0 && head) {
          const previous = await readGitPathRecords(git, ['--literal-pathspecs', 'ls-tree', '-z', head, '--', path]);
          if (previous.some(isExactGitlink)) return 'gitlink';
        }
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
