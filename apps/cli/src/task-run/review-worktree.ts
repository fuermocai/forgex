/**
 * 可审阅 Git worktree 隔离（v0.5.6）。
 *
 * ## 能力边界（必须和能力报告保持一致）
 *
 * 这里提供的是**工作区/改动隔离**：任务在独立目录 + 独立分支里跑，产物可审阅、可丢弃。
 * 它**不是** OS 沙箱：
 *   - 进程仍以当前用户身份运行，能读到 worktree 之外的文件与网络；
 *   - 没有 namespace / seccomp / 资源配额；
 *   - 隔离只体现在"改哪个目录、提交到哪个分支"。
 * 需要文件系统/网络/进程级隔离请走 `packages/sandbox` 的 bwrap 路径（见 `forgex sandbox`）。
 *
 * ## 安全约束
 *
 *   - 工作树必须干净（含未跟踪文件）才允许创建：本模块**绝不** stash / reset / 移动用户改动；
 *   - 只有从基线 commit 出发生成的 worktree 才是安全的，否则宁可拒绝；
 *   - 所有 worktree 都创建在 ForgeX 管理的根目录下，目录名由 runId 推导，创建前做路径包含校验；
 *   - 创建失败、分支冲突、目录已存在 → 一律抛错（fail closed），**不**回退到原目录执行；
 *   - 删除前重新核对：路径在管理根目录内、目录名对应该 runId、git 确认它是本仓库的 worktree；
 *   - 删除失败不吞异常（与 sandbox 里的 GitWorktreeProvider 不同，那里是尽力而为）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ForgeError } from '@forgex/shared';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface ReviewWorktreeRecord {
  runId: string;
  /** 主仓库根目录（`git rev-parse --show-toplevel` 的规范路径） */
  repoRoot: string;
  /** ForgeX 管理的 worktree 根目录 */
  root: string;
  /** 本任务独占的工作树目录 */
  path: string;
  /** 本任务独占的分支 */
  branch: string;
  /** 创建时的基线提交 */
  baseCommit: string;
}

export interface ChangedFile {
  path: string;
  /** modified / added / deleted / renamed / untracked / copied / typechange */
  status: string;
  /** git 原始状态码，如 " M" / "??" */
  code: string;
}

export interface WorktreeDiff {
  runId: string;
  path: string;
  branch: string;
  baseCommit: string;
  /** 当前 HEAD；agent 在 worktree 内提交过时会与 baseCommit 不同 */
  head: string;
  files: ChangedFile[];
  stat: string;
  patch: string;
  patchTruncated: boolean;
  /** 未跟踪文件不进 `git diff`，单独提示，避免"看着没改" */
  untrackedCount: number;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 可注入的 git 执行器（测试可替换；生产用真实 git） */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

export interface RepoState {
  repoRoot: string;
  head: string;
  /** `git status --porcelain` 的原始行（已跟踪改动 + 未跟踪文件） */
  dirtyEntries: string[];
}

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

export const BRANCH_PREFIX = 'forgex/run-';
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_MAX_PATCH_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------------ */
/* git 执行                                                            */
/* ------------------------------------------------------------------ */

const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise<GitResult>((resolvePromise, reject) => {
    const git = process.platform === 'win32' ? 'git.exe' : 'git';
    let child;
    try {
      child = spawn(git, [...args], {
        shell: false,
        windowsHide: true,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // 避免用户全局配置改变输出格式（status/diff 解析依赖稳定格式）
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM ?? '0',
        },
      });
    } catch (err) {
      reject(
        new ForgeError('WORKTREE_CREATE_FAILED', `无法启动 git: ${errorMessage(err)}`, { cause: err }),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child!.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ForgeError('WORKTREE_CREATE_FAILED', `git 执行失败: ${errorMessage(err)}`, { cause: err }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });

/* ------------------------------------------------------------------ */
/* 仓库状态                                                            */
/* ------------------------------------------------------------------ */

/**
 * 读取仓库状态。**只读**：不 stash、不 checkout、不 reset。
 *
 * @throws WORKTREE_CREATE_FAILED 当前目录不是 Git 工作树
 */
export async function inspectRepo(repoDir: string, run: GitRunner = defaultGitRunner): Promise<RepoState> {
  const inside = await run(['rev-parse', '--is-inside-work-tree'], repoDir);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new ForgeError(
      'WORKTREE_CREATE_FAILED',
      `--worktree 需要在一个 Git 仓库内运行，但 ${repoDir} 不是 Git 工作树`,
      { details: { cwd: repoDir, stderr: inside.stderr.trim().slice(0, 500) } },
    );
  }

  const top = await run(['rev-parse', '--show-toplevel'], repoDir);
  if (top.code !== 0) {
    throw new ForgeError('WORKTREE_CREATE_FAILED', `无法确定仓库根目录: ${top.stderr.trim()}`, {
      details: { cwd: repoDir },
    });
  }
  const repoRoot = canonicalPath(top.stdout.trim());

  const head = await run(['rev-parse', 'HEAD'], repoRoot);
  if (head.code !== 0) {
    throw new ForgeError(
      'WORKTREE_CREATE_FAILED',
      '仓库还没有任何提交，无法确定 worktree 的基线 commit；请先提交一次再使用 --worktree',
      { details: { repoRoot, stderr: head.stderr.trim().slice(0, 500) } },
    );
  }

  // --untracked-files=all：未跟踪文件同样算"未提交改动"——它们不会被带进 worktree，
  // 放行会让任务在一个缺文件的环境里跑，属于静默失真。
  const status = await run(['status', '--porcelain=v1', '--untracked-files=all'], repoRoot);
  if (status.code !== 0) {
    throw new ForgeError('WORKTREE_CREATE_FAILED', `git status 失败: ${status.stderr.trim()}`, {
      details: { repoRoot },
    });
  }
  const dirtyEntries = status.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0);

  return { repoRoot, head: head.stdout.trim(), dirtyEntries };
}

/**
 * 要求仓库干净，否则拒绝（**不**替用户 stash / reset）。
 *
 * @throws WORKTREE_DIRTY_TREE
 */
export async function assertCleanRepo(repoDir: string, run: GitRunner = defaultGitRunner): Promise<RepoState> {
  const state = await inspectRepo(repoDir, run);
  if (state.dirtyEntries.length === 0) return state;

  const sample = state.dirtyEntries.slice(0, 10);
  throw new ForgeError(
    'WORKTREE_DIRTY_TREE',
    [
      `仓库存在 ${state.dirtyEntries.length} 处未提交改动，拒绝创建隔离 worktree。`,
      'ForgeX 不会 stash / reset / 移动你的改动；请先自行提交或妥善处理后再试。',
      `如需在当前工作区直接执行（接受改动混在一起），去掉 --worktree 重跑。`,
      '未提交改动（最多显示 10 条）：',
      ...sample.map((line) => `  ${line}`),
    ].join('\n'),
    {
      details: {
        repoRoot: state.repoRoot,
        dirtyCount: state.dirtyEntries.length,
        dirty: state.dirtyEntries.slice(0, 50),
      },
    },
  );
}

/* ------------------------------------------------------------------ */
/* 路径校验                                                            */
/* ------------------------------------------------------------------ */

/** 把路径规范化为真实绝对路径（不存在时回退到 resolve，避免 ENOENT） */
export function canonicalPath(target: string): string {
  const abs = resolve(target);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** runId → 目录名（同时是"路径属于该任务"的判据） */
export function worktreeDirName(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ForgeError('WORKTREE_PATH_INVALID', `非法 runId: ${JSON.stringify(runId)}`, {
      details: { runId },
    });
  }
  return `run-${runId}`;
}

/**
 * 校验 target 确实在 root 内（且不等于 root）。
 *
 * 用 realpath 比较，防止 `root/link -> /etc` 这种软链接逃逸；
 * Windows 下大小写不敏感，统一做 case-fold 比较。
 */
export async function assertPathInsideRoot(root: string, target: string): Promise<string> {
  if (!root || !isAbsolute(root) || !isAbsolute(target)) {
    throw new ForgeError('WORKTREE_PATH_INVALID', 'worktree 根目录与目标路径都必须是绝对路径', {
      details: { root, target },
    });
  }
  const realRoot = canonicalPath(root);
  // 目标可能尚未创建：先规范化其父目录，再拼回文件名，避免 realpath 失败
  const targetParent = canonicalPath(join(target, '..'));
  const realTarget = canonicalPath(join(targetParent, basename(target)));

  const rel = relative(realRoot, realTarget);
  const escapes =
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    (process.platform === 'win32' && rel.toLowerCase() === '..');
  if (escapes) {
    throw new ForgeError(
      'WORKTREE_PATH_INVALID',
      `worktree 路径越界：${realTarget} 不在 ForgeX 管理目录 ${realRoot} 内`,
      { details: { root: realRoot, target: realTarget, relative: rel } },
    );
  }
  return realTarget;
}

/* ------------------------------------------------------------------ */
/* 创建                                                                */
/* ------------------------------------------------------------------ */

export interface CreateWorktreeOptions {
  repoRoot: string;
  runId: string;
  root: string;
  git?: GitRunner;
}

/**
 * 创建本任务独占的 worktree 与分支。
 *
 * 失败语义：任何一步失败都清理本次残留并抛 `WORKTREE_*` 错误，调用方必须终止任务，
 * **不得**退回原目录继续执行。
 */
export async function createReviewWorktree(options: CreateWorktreeOptions): Promise<ReviewWorktreeRecord> {
  const run = options.git ?? defaultGitRunner;
  const dirName = worktreeDirName(options.runId);

  // 1. 干净性 + 基线（创建前再查一次：规划阶段可能有人动了工作区）
  const state = await assertCleanRepo(options.repoRoot, run);

  const branch = `${BRANCH_PREFIX}${options.runId}`;
  const root = canonicalPath(options.root);
  mkdirSync(root, { recursive: true });
  const path = await assertPathInsideRoot(root, join(root, dirName));

  // 2. 分支冲突：同名分支已存在 → 拒绝（不 -B 强覆盖，那会丢掉别人的分支）
  const branchExists = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], state.repoRoot);
  if (branchExists.code === 0) {
    throw new ForgeError('WORKTREE_BRANCH_EXISTS', `分支已存在: ${branch}；请换一个 runId 或先删除该分支`, {
      details: { branch, repoRoot: state.repoRoot },
    });
  }

  // 3. 目录已存在 → 拒绝（可能是上次失败的残留，需要人工确认）
  if (existsSync(path)) {
    throw new ForgeError('WORKTREE_EXISTS', `worktree 目录已存在: ${path}；请先清理残留目录`, {
      details: { path, runId: options.runId },
    });
  }

  // 4. git worktree add -b <branch> <path> <baseCommit>
  const added = await run(['worktree', 'add', '-b', branch, path, state.head], state.repoRoot);
  if (added.code !== 0) {
    await cleanupPartial({ repoRoot: state.repoRoot, path, branch, git: run });
    throw new ForgeError('WORKTREE_CREATE_FAILED', `git worktree add 失败: ${added.stderr.trim() || added.stdout.trim()}`, {
      details: { branch, path, baseCommit: state.head, exitCode: added.code },
    });
  }

  // 5. 校验产物真的落在基线 commit 上（防止 git 配置把 worktree 指到别处）
  const headAtPath = await run(['rev-parse', 'HEAD'], path);
  if (headAtPath.code !== 0 || headAtPath.stdout.trim() !== state.head) {
    await cleanupPartial({ repoRoot: state.repoRoot, path, branch, git: run });
    throw new ForgeError('WORKTREE_CREATE_FAILED', 'worktree 创建后 HEAD 与基线 commit 不一致，已回滚', {
      details: {
        branch,
        path,
        expected: state.head,
        actual: headAtPath.stdout.trim(),
        stderr: headAtPath.stderr.trim().slice(0, 500),
      },
    });
  }

  // 6. 创建后再校验一次：realpath 必须仍在管理根目录内（防软链接/挂载点逃逸）
  await assertPathInsideRoot(root, path);

  return {
    runId: options.runId,
    repoRoot: state.repoRoot,
    root,
    path,
    branch,
    baseCommit: state.head,
  };
}

/** 回滚本次创建留下的残留；回滚本身失败只记录，不掩盖原始错误 */
async function cleanupPartial(args: {
  repoRoot: string;
  path: string;
  branch: string;
  git: GitRunner;
}): Promise<void> {
  await args.git(['worktree', 'remove', '--force', args.path], args.repoRoot).catch(() => undefined);
  await args.git(['branch', '-D', args.branch], args.repoRoot).catch(() => undefined);
  await args.git(['worktree', 'prune'], args.repoRoot).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* 差异                                                                */
/* ------------------------------------------------------------------ */

const STATUS_BY_CODE: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'unmerged',
  '?': 'untracked',
};

function normalizeStatus(code: string): string {
  const letters = code.replace(/\s/g, '');
  if (letters.length === 0) return 'unknown';
  if (letters.includes('?')) return 'untracked';
  // 取第一个非空状态位：`RM` 之类算 renamed
  for (const letter of letters) {
    const mapped = STATUS_BY_CODE[letter];
    if (mapped) return mapped;
  }
  return 'unknown';
}

export interface ReadDiffOptions {
  maxPatchBytes?: number;
  git?: GitRunner;
}

/**
 * 读取 worktree 相对基线 commit 的差异。
 *
 * 不做任何写操作：`git status` + `git diff`。
 */
export async function readWorktreeDiff(
  record: ReviewWorktreeRecord,
  options: ReadDiffOptions = {},
): Promise<WorktreeDiff> {
  const run = options.git ?? defaultGitRunner;
  const maxBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;

  if (!existsSync(record.path)) {
    throw new ForgeError('WORKTREE_NOT_FOUND', `worktree 目录不存在: ${record.path}`, {
      details: { runId: record.runId, path: record.path },
    });
  }
  // 记录可能来自老化/被改过的数据库：以磁盘 + git 的事实为准
  await assertPathInsideRoot(record.root, record.path);

  const headResult = await run(['rev-parse', 'HEAD'], record.path);
  const head = headResult.code === 0 ? headResult.stdout.trim() : record.baseCommit;

  const statusResult = await run(['status', '--porcelain=v1', '--untracked-files=all'], record.path);
  if (statusResult.code !== 0) {
    throw new ForgeError('WORKTREE_DIFF_FAILED', `git status 失败: ${statusResult.stderr.trim()}`, {
      details: { path: record.path },
    });
  }

  const files = new Map<string, ChangedFile>();
  for (const rawLine of statusResult.stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim().length < 4) continue;
    const code = line.slice(0, 2);
    let filePath = line.slice(3);
    // rename 形式：`R  old -> new`
    const arrow = filePath.indexOf(' -> ');
    if (arrow >= 0) filePath = filePath.slice(arrow + 4);
    files.set(filePath, { path: filePath, status: normalizeStatus(code), code });
  }

  // 已提交但未 push 的改动：worktree 内可能有 commit，用 base..HEAD 补全
  const committed = await run(['diff', '--name-status', `${record.baseCommit}`, 'HEAD'], record.path);
  if (committed.code === 0) {
    for (const line of committed.stdout.split('\n')) {
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed) continue;
      const [code, ...rest] = trimmed.split('\t');
      if (!code || rest.length === 0) continue;
      const filePath = rest[rest.length - 1]!;
      if (files.has(filePath)) continue;
      files.set(filePath, { path: filePath, status: normalizeStatus(code), code });
    }
  }

  const statResult = await run(['diff', '--stat', record.baseCommit, '--'], record.path);
  const patchResult = await run(['diff', record.baseCommit, '--'], record.path);

  const fullPatch = patchResult.stdout;
  const patchTruncated = Buffer.byteLength(fullPatch, 'utf8') > maxBytes;
  const patch = patchTruncated ? truncateBytes(fullPatch, maxBytes) : fullPatch;

  const sorted = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));

  return {
    runId: record.runId,
    path: record.path,
    branch: record.branch,
    baseCommit: record.baseCommit,
    head,
    files: sorted,
    stat: statResult.code === 0 ? statResult.stdout.trimEnd() : '',
    patch,
    patchTruncated,
    untrackedCount: sorted.filter((f) => f.status === 'untracked').length,
  };
}

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

export interface RemoveWorktreeOptions {
  /** 重新解析当前生效的管理根目录（必须与记录一致，否则拒绝） */
  root: string;
  /** 允许删除带未提交改动的 worktree */
  force?: boolean;
  git?: GitRunner;
}

/**
 * 删除本任务的 worktree 与分支。**只由显式命令触发**（`forgex task clean`）。
 *
 * 删除前核对四件事，任一不满足即拒绝：
 *   1. 目录名 == `run-<runId>`；
 *   2. 记录路径 == 管理根目录 + 目录名；
 *   3. realpath 后仍在管理根目录内；
 *   4. `git worktree list` 确认该目录是本仓库登记的 worktree。
 */
export async function removeReviewWorktree(
  record: ReviewWorktreeRecord,
  options: RemoveWorktreeOptions,
): Promise<{ path: string; branch: string; branchDeleted: boolean }> {
  const run = options.git ?? defaultGitRunner;

  const expectedName = worktreeDirName(record.runId);
  const expectedBranch = `${BRANCH_PREFIX}${record.runId}`;
  if (record.branch !== expectedBranch) {
    throw new ForgeError(
      'WORKTREE_PATH_INVALID',
      `任务记录中的分支 ${record.branch} 与 runId 推导结果 ${expectedBranch} 不一致，拒绝删除`,
      { details: { runId: record.runId, branch: record.branch, expectedBranch } },
    );
  }
  if (basename(record.path) !== expectedName) {
    throw new ForgeError(
      'WORKTREE_PATH_INVALID',
      `路径 ${record.path} 不属于任务 ${record.runId}（期望目录名 ${expectedName}），拒绝删除`,
      { details: { runId: record.runId, path: record.path, expectedName } },
    );
  }

  const realRoot = canonicalPath(options.root);
  const recordRoot = canonicalPath(record.root);
  if (realRoot !== recordRoot) {
    throw new ForgeError(
      'WORKTREE_PATH_INVALID',
      `任务的 worktree 根目录（${recordRoot}）与当前配置（${realRoot}）不一致，拒绝删除；`
        + '如确实要清理，请把 worktree.root 配置改回创建时的值再试',
      { details: { runId: record.runId, recordedRoot: recordRoot, configuredRoot: realRoot } },
    );
  }

  const target = await assertPathInsideRoot(realRoot, record.path);
  if (canonicalPath(join(realRoot, expectedName)) !== target) {
    throw new ForgeError('WORKTREE_PATH_INVALID', `路径与 runId 推导结果不一致: ${target}`, {
      details: { runId: record.runId, target, expected: join(realRoot, expectedName) },
    });
  }

  if (!existsSync(target)) {
    throw new ForgeError('WORKTREE_NOT_FOUND', `worktree 目录不存在: ${target}`, {
      details: { runId: record.runId, path: target },
    });
  }

  // git 视角确认归属：防止有人把同名目录塞进管理根目录
  const list = await run(['worktree', 'list', '--porcelain'], record.repoRoot);
  if (list.code !== 0) {
    throw new ForgeError('WORKTREE_REMOVE_FAILED', `无法列出 worktree（仓库不可用？）: ${list.stderr.trim()}`, {
      details: { runId: record.runId, repoRoot: record.repoRoot },
    });
  }
  const registered = list.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => canonicalPath(line.slice('worktree '.length).trim()));
  if (!registered.includes(target)) {
    throw new ForgeError(
      'WORKTREE_REMOVE_FAILED',
      `${target} 不是仓库 ${record.repoRoot} 登记的 worktree，拒绝删除`,
      { details: { runId: record.runId, target, registered } },
    );
  }

  if (options.force !== true) {
    const status = await run(['status', '--porcelain=v1', '--untracked-files=all'], target);
    if (status.code !== 0) {
      throw new ForgeError(
        'WORKTREE_REMOVE_FAILED',
        `无法检查 worktree 是否有未提交改动，拒绝清理: ${status.stderr.trim() || `git status 退出码 ${status.code}`}`,
        { details: { runId: record.runId, path: target, exitCode: status.code } },
      );
    }
    if (status.stdout.trim().length > 0) {
      const count = status.stdout.split('\n').filter((l) => l.trim()).length;
      throw new ForgeError(
        'WORKTREE_REMOVE_FAILED',
        `${target} 还有 ${count} 处未提交改动，删除会丢失这些产物；确认要丢弃请加 --force`,
        { details: { runId: record.runId, path: target, dirtyCount: count } },
      );
    }
  }

  const removed = await run(['worktree', 'remove', '--force', target], record.repoRoot);
  if (removed.code !== 0) {
    throw new ForgeError('WORKTREE_REMOVE_FAILED', `git worktree remove 失败: ${removed.stderr.trim()}`, {
      details: { runId: record.runId, path: target, exitCode: removed.code },
    });
  }

  const branchDeleted = await run(['branch', '-D', '--', expectedBranch], record.repoRoot);
  if (branchDeleted.code !== 0) {
    throw new ForgeError(
      'WORKTREE_REMOVE_FAILED',
      `worktree 已删除，但分支 ${expectedBranch} 删除失败: ${branchDeleted.stderr.trim()}`,
      { details: { runId: record.runId, branch: expectedBranch } },
    );
  }

  await run(['worktree', 'prune'], record.repoRoot).catch(() => undefined);
  return { path: target, branch: expectedBranch, branchDeleted: true };
}

/* ------------------------------------------------------------------ */
/* 内部辅助                                                            */
/* ------------------------------------------------------------------ */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n…（已截断，共 ${buf.length} 字节）`;
}
