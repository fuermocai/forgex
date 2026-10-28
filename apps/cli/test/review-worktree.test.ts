/**
 * 可审阅 Git worktree 隔离测试（v0.5.6）。
 *
 * 这里**真的调用 git**：每个用例建一个临时仓库，跑 `git init` / `commit` / `worktree add`，
 * 断言落在磁盘与 `git` 输出上，不使用 mock 结果冒充"已验证"。
 *
 * 未覆盖（环境边界）：
 *   - 软链接逃逸：只在支持 symlink 的平台有实际意义（Windows 需开发者模式），已单独跳过；
 *   - 子模块 / sparse-checkout / 非默认 `core.worktree` 配置：未覆盖；
 *   - 网络文件系统下的 realpath 语义：未覆盖。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ForgeError } from '@forgex/shared';
import {
  assertCleanRepo,
  assertPathInsideRoot,
  createReviewWorktree,
  readWorktreeDiff,
  removeReviewWorktree,
  worktreeDirName,
  type ReviewWorktreeRecord,
} from '../src/task-run/review-worktree.js';

/* ------------------------------------------------------------------ */
/* 环境与工具                                                          */
/* ------------------------------------------------------------------ */

const HAS_GIT = (() => {
  const r = spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
})();

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上 git 句柄可能短暂占用，忽略 */
    }
  }
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function tmp(prefix = 'forgex-wt-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 建一个已提交一次的临时仓库：app.js + 一个 passthrough 测试脚本 */
function makeRepo(): string {
  const repo = tmp('forgex-wt-repo-');
  writeFileSync(join(repo, 'app.js'), "module.exports = 'hello';\n", 'utf8');
  writeFileSync(join(repo, 'test.js'), '// noop\n', 'utf8');
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@forgex.local', '-c', 'user.name=T', 'commit', '-q', '-m', 'init']);
  return repo;
}

function makeRoot(): string {
  // 模拟 ForgeX 管理的根目录：独立于仓库
  return tmp('forgex-wt-root-');
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<ForgeError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ForgeError);
    const forgeError = err as ForgeError;
    expect(forgeError.code).toBe(code);
    return forgeError;
  }
  throw new Error(`期望抛出 ${code}，但调用成功了`);
}

/* ------------------------------------------------------------------ */
/* 正常路径                                                            */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_GIT)('createReviewWorktree（真实 git）', () => {
  it('在管理根目录下创建独立 worktree 与分支，基线为当前 HEAD，主仓库不受影响', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const base = git(repo, ['rev-parse', 'HEAD']);

    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_abc123', root });

    expect(record.branch).toBe('forgex/run-run_abc123');
    expect(record.baseCommit).toBe(base);
    expect(record.path).toBe(join(root, 'run-run_abc123'));
    expect(existsSync(record.path)).toBe(true);

    // 目录里确实有仓库内容，且分支名正确
    expect(readFileSync(join(record.path, 'app.js'), 'utf8')).toContain('hello');
    expect(git(record.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('forgex/run-run_abc123');
    expect(git(record.path, ['rev-parse', 'HEAD'])).toBe(base);

    // git 登记了这个 worktree（git 在 Windows 上输出正斜杠，比较前统一）
    const listed = git(repo, ['worktree', 'list', '--porcelain']).replace(/\\/g, '/');
    expect(listed).toContain(record.path.replace(/\\/g, '/'));

    // 主仓库工作区没被动过
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(repo, 'app.js'), 'utf8')).toContain('hello');
  });

  it('worktree 内改动不回流主仓库（不是自动合并）', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_iso1', root });

    writeFileSync(join(record.path, 'app.js'), "module.exports = 'changed';\n", 'utf8');

    expect(readFileSync(join(record.path, 'app.js'), 'utf8')).toContain('changed');
    expect(readFileSync(join(repo, 'app.js'), 'utf8')).toContain('hello');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* 脏工作区保护                                                        */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_GIT)('脏工作区保护', () => {
  it('已跟踪文件被修改 → 拒绝，且不 stash/reset（内容原样保留）', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'app.js'), "module.exports = 'dirty';\n", 'utf8');

    const err = await expectCode(() => assertCleanRepo(repo), 'WORKTREE_DIRTY_TREE');
    expect(err.message).toContain('不会 stash');
    expect(err.details?.dirtyCount).toBe(1);

    // 没有 stash 记录，文件也没被还原
    expect(git(repo, ['stash', 'list'])).toBe('');
    expect(readFileSync(join(repo, 'app.js'), 'utf8')).toContain('dirty');
  });

  it('未跟踪文件也算未提交改动 → 拒绝（否则任务会在缺文件的环境里跑）', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'extra.js'), '// untracked\n', 'utf8');

    await expectCode(() => assertCleanRepo(repo), 'WORKTREE_DIRTY_TREE');
    expect(existsSync(join(repo, 'extra.js'))).toBe(true);
  });

  it('创建流程遇脏工作区直接失败，且不留下目录/分支', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    writeFileSync(join(repo, 'app.js'), "module.exports = 'dirty';\n", 'utf8');

    await expectCode(() => createReviewWorktree({ repoRoot: repo, runId: 'run_dirty1', root }), 'WORKTREE_DIRTY_TREE');

    expect(existsSync(join(root, 'run-run_dirty1'))).toBe(false);
    expect(git(repo, ['branch', '--list', 'forgex/run-run_dirty1'])).toBe('');
    expect(readFileSync(join(repo, 'app.js'), 'utf8')).toContain('dirty');
  });
});

/* ------------------------------------------------------------------ */
/* 冲突与失败关闭                                                      */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_GIT)('冲突与失败关闭', () => {
  it('重复 runId：分支已存在 → 拒绝，不覆盖既有分支，也不建第二个目录', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const first = await createReviewWorktree({ repoRoot: repo, runId: 'run_dup1', root });
    writeFileSync(join(first.path, 'app.js'), "module.exports = 'first';\n", 'utf8');

    await expectCode(() => createReviewWorktree({ repoRoot: repo, runId: 'run_dup1', root }), 'WORKTREE_BRANCH_EXISTS');

    // 第一次的产物没被覆盖
    expect(readFileSync(join(first.path, 'app.js'), 'utf8')).toContain('first');
  });

  it('非 Git 仓库 → WORKTREE_CREATE_FAILED（不回退到原地执行）', async () => {
    const plain = tmp('forgex-wt-plain-');
    await expectCode(
      () => createReviewWorktree({ repoRoot: plain, runId: 'run_nogit', root: makeRoot() }),
      'WORKTREE_CREATE_FAILED',
    );
  });

  it('没有任何提交的仓库 → 明确拒绝（没有可用的基线 commit）', async () => {
    const repo = tmp('forgex-wt-empty-');
    git(repo, ['init', '-q']);
    const err = await expectCode(() => assertCleanRepo(repo), 'WORKTREE_CREATE_FAILED');
    expect(err.message).toContain('没有任何提交');
  });

  it('目标目录已被占用 → WORKTREE_EXISTS，不复用可疑目录', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    mkdirSync(join(root, worktreeDirName('run_taken1')), { recursive: true });

    await expectCode(() => createReviewWorktree({ repoRoot: repo, runId: 'run_taken1', root }), 'WORKTREE_EXISTS');
  });
});

/* ------------------------------------------------------------------ */
/* 路径校验                                                            */
/* ------------------------------------------------------------------ */

describe('路径校验', () => {
  it('runId 不能带路径分隔符（防目录穿越）', () => {
    expect(() => worktreeDirName('../../etc')).toThrowError(ForgeError);
    expect(() => worktreeDirName('run/../x')).toThrowError(ForgeError);
    expect(worktreeDirName('run_ok-1')).toBe('run-run_ok-1');
  });

  it('目标在管理根目录之外 → WORKTREE_PATH_INVALID', async () => {
    const root = makeRoot();
    await expectCode(() => assertPathInsideRoot(root, join(root, '..', 'escape')), 'WORKTREE_PATH_INVALID');
    await expectCode(() => assertPathInsideRoot(root, root), 'WORKTREE_PATH_INVALID');
  });

  it('非绝对路径 → WORKTREE_PATH_INVALID', async () => {
    await expectCode(() => assertPathInsideRoot('relative/root', '/abs/target'), 'WORKTREE_PATH_INVALID');
  });

  const symlinkIt = process.platform === 'win32' ? it.skip : it;
  symlinkIt('软链接指向根目录之外 → 拒绝', async () => {
    const root = makeRoot();
    const outside = tmp('forgex-wt-outside-');
    try {
      symlinkSync(outside, join(root, 'run_link1'), 'dir');
    } catch {
      return; // 平台不支持 symlink，跳过
    }
    await expectCode(() => assertPathInsideRoot(root, join(root, 'run_link1')), 'WORKTREE_PATH_INVALID');
  });
});

/* ------------------------------------------------------------------ */
/* 差异                                                                */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_GIT)('readWorktreeDiff', () => {
  it('识别修改与未跟踪文件，patch 只含已跟踪改动', async () => {
    const repo = makeRepo();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_diff1', root: makeRoot() });

    writeFileSync(join(record.path, 'app.js'), "module.exports = 'changed';\n", 'utf8');
    writeFileSync(join(record.path, 'brand-new.js'), '// new\n', 'utf8');

    const diff = await readWorktreeDiff(record);

    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f.status]));
    expect(byPath['app.js']).toBe('modified');
    expect(byPath['brand-new.js']).toBe('untracked');
    expect(diff.untrackedCount).toBe(1);
    expect(diff.patch).toContain("+module.exports = 'changed';");
    expect(diff.patch).not.toContain('brand-new');
    expect(diff.stat).toContain('app.js');
    expect(diff.baseCommit).toBe(record.baseCommit);

    // 读差异不能有副作用
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('超长 patch 被截断并标记', async () => {
    const repo = makeRepo();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_diff2', root: makeRoot() });
    writeFileSync(join(record.path, 'big.txt'), `${'x'.repeat(2000)}\n`, 'utf8');
    git(record.path, ['add', '-A']);
    git(record.path, ['-c', 'user.email=t@forgex.local', '-c', 'user.name=T', 'commit', '-q', '-m', 'big']);

    const diff = await readWorktreeDiff(record, { maxPatchBytes: 200 });
    expect(diff.patchTruncated).toBe(true);
    expect(diff.patch).toContain('已截断');
    // 已提交的改动也要算进变更列表
    expect(diff.files.map((f) => f.path)).toContain('big.txt');
  });

  it('worktree 目录消失 → WORKTREE_NOT_FOUND（不猜、不重建）', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_gone1', root });
    rmSync(record.path, { recursive: true, force: true });

    await expectCode(() => readWorktreeDiff(record), 'WORKTREE_NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_GIT)('removeReviewWorktree', () => {
  it('显式清理：删除 worktree 与分支，主仓库不变', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_clean1', root });

    const result = await removeReviewWorktree(record, { root });

    expect(result.branchDeleted).toBe(true);
    expect(existsSync(record.path)).toBe(false);
    expect(git(repo, ['branch', '--list', 'forgex/run-run_clean1'])).toBe('');
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(record.path);
    expect(readFileSync(join(repo, 'app.js'), 'utf8')).toContain('hello');
  });

  it('路径越界（记录指向管理根目录之外）→ 拒绝删除，目录仍在', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_esc1', root });
    const outside = tmp('forgex-wt-outside2-');
    mkdirSync(join(outside, 'run-run_esc1'), { recursive: true });
    const forged: ReviewWorktreeRecord = { ...record, path: join(outside, 'run-run_esc1') };

    await expectCode(() => removeReviewWorktree(forged, { root }), 'WORKTREE_PATH_INVALID');
    expect(existsSync(forged.path)).toBe(true);
    expect(existsSync(record.path)).toBe(true);
  });

  it('目录名与 runId 不匹配 → 拒绝删除', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_name1', root });
    const forged: ReviewWorktreeRecord = { ...record, path: join(root, 'run-other') };

    await expectCode(() => removeReviewWorktree(forged, { root }), 'WORKTREE_PATH_INVALID');
    expect(existsSync(record.path)).toBe(true);
  });

  it('记录的管理根目录与当前配置不一致 → 拒绝删除', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_root1', root });

    await expectCode(
      () => removeReviewWorktree(record, { root: makeRoot() }),
      'WORKTREE_PATH_INVALID',
    );
    expect(existsSync(record.path)).toBe(true);
  });

  it('有未提交产物时默认拒绝，--force 才删除', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_keep1', root });
    writeFileSync(join(record.path, 'app.js'), "module.exports = 'precious';\n", 'utf8');

    const err = await expectCode(() => removeReviewWorktree(record, { root }), 'WORKTREE_REMOVE_FAILED');
    expect(err.message).toContain('--force');
    expect(readFileSync(join(record.path, 'app.js'), 'utf8')).toContain('precious');

    const result = await removeReviewWorktree(record, { root, force: true });
    expect(result.branchDeleted).toBe(true);
    expect(existsSync(record.path)).toBe(false);
  });

  it('worktree 已被外部删除 → WORKTREE_NOT_FOUND', async () => {
    const repo = makeRepo();
    const root = makeRoot();
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_gone2', root });
    git(repo, ['worktree', 'remove', '--force', record.path]);

    await expectCode(() => removeReviewWorktree(record, { root, force: true }), 'WORKTREE_NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ */
/* 目录不存在时也不能乱建                                              */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_GIT)('createReviewWorktree 的根目录处理', () => {
  it('根目录不存在时自动创建（且创建后仍做包含校验）', async () => {
    const repo = makeRepo();
    const root = join(tmp('forgex-wt-parent-'), 'nested', 'worktrees');
    const record = await createReviewWorktree({ repoRoot: repo, runId: 'run_mk1', root });

    expect(dirname(record.path)).toBe(root);
    expect(existsSync(record.path)).toBe(true);
  });
});
