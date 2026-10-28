/**
 * 场景组 7：可审阅 Git worktree 隔离（T11 系列，v0.5.6）。
 *
 * 这一组验证的边界很明确：
 *   - `--worktree` 让任务在独立目录 + 独立分支里跑，**原工作区一个字节都不改**；
 *   - 任务结束后产物仍在（不自动合并、不自动删除），可用 `forgex task diff` 审阅、
 *     `forgex task clean` 清理；
 *   - 仓库有未提交改动时**拒绝**，不 stash / 不 reset、也不退化成原地执行。
 *
 * 不验证：OS 级隔离（那是 bwrap 路径，见 forgex sandbox）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI_ENTRY = join(REPO_ROOT, 'apps', 'cli', 'dist', 'main.js');

const MATH_BUGGY = `function add(a, b) {
  return a - b;
}

module.exports = { add };
`;

const MATH_FIXED = `function add(a, b) {
  return a + b;
}

module.exports = { add };
`;

const TEST_ADD = `const assert = require('node:assert');
const { add } = require('./src/math.js');
assert.strictEqual(add(2, 3), 5);
console.log('tests passed');
`;

const PLAN = {
  steps: [
    {
      step_id: 'step_001',
      description: '读取 src/math.js，确认 add 的实现',
      dependencies: [],
      required_tools: ['read_file'],
      risk_level: 'read',
      verification: { type: 'file_exists', target: 'src/math.js' },
    },
    {
      step_id: 'step_002',
      description: '修复 add 的运算错误',
      dependencies: ['step_001'],
      required_tools: ['edit_file'],
      risk_level: 'modify',
      verification: { type: 'tool_return_ok' },
    },
  ],
};

const TURNS = [
  { toolCalls: [{ name: 'read_file', arguments: { path: 'src/math.js' } }] },
  { text: '已读取 src/math.js。' },
  { toolCalls: [{ name: 'edit_file', arguments: { path: 'src/math.js', oldText: 'return a - b;', newText: 'return a + b;' } }] },
  { text: '已修改 add 的实现。' },
];

/** 在评测子进程里调用 CLI 子命令（与用户手动执行完全同一条路径） */
function cli(ctx, args) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^FORGEX_/i.test(key)) continue;
    env[key] = value;
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args, '--config', ctx.configPath], {
    cwd: ctx.ws,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function gitAt(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

export const worktreeScenarios = [
  {
    id: 'T11',
    name: 'worktree 隔离：任务完成、原工作区不变、产物可审阅可清理',
    tags: ['worktree', 'isolation'],
    critical: true,
    prompt: '修复 src/math.js 里 add 的实现，让测试通过',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    model: { plan: PLAN, turns: TURNS },
    cliArgs: ['--yes', '--worktree'],
    worktree: true,
    expect: {
      taskStatus: 'completed',
      exitCode: 0,
      dbStatus: 'completed',
      gateVerdict: 'passed',
      // 隔离运行不得改动原工作区（worktree 在仓库外）
      noSideEffects: true,
    },
    async verify(ctx) {
      const info = ctx.json?.worktree;
      if (!info) {
        return [{ name: '输出里带 worktree 信息', pass: false, actual: ctx.json }];
      }
      // 先取证再清理：clean 之后目录和分支都会消失，顺序不能颠倒
      const mainFile = readFileSync(join(ctx.ws, 'src/math.js'), 'utf8');
      const worktreeFile = readFileSync(join(info.path, 'src/math.js'), 'utf8');
      const runRow = ctx.db.runs[0];
      const repoRelative = relative(ctx.ws, info.path);
      const outsideWs = repoRelative.startsWith('..') || isAbsolute(repoRelative);
      const branchCommit = gitAt(ctx.ws, ['rev-parse', '--verify', `refs/heads/${info.branch}`]);
      const worktreeHead = gitAt(info.path, ['rev-parse', 'HEAD']).stdout;
      const existedBeforeClean = existsSync(info.path);

      // 产物审阅：diff 里能看到改动
      const diff = cli(ctx, ['task', 'diff', info.runId, '--json']);
      const diffFiles = (diff.json?.files ?? []).map((f) => `${f.path}:${f.status}`);
      // 产物里有未提交改动，clean 需要显式 --force（默认拒绝丢弃产物）
      const cleaned = cli(ctx, ['task', 'clean', info.runId, '--json', '--force']);
      const branchAfterClean = gitAt(ctx.ws, ['branch', '--list', info.branch]).stdout;

      return [
        {
          name: 'worktree 目录存在且在仓库之外',
          pass: existedBeforeClean && outsideWs,
          actual: { path: info.path, outsideWs, existed: existedBeforeClean },
        },
        {
          name: 'worktree 内已改成修复后的实现',
          // Windows 上 core.autocrlf 会把 checkout 转成 CRLF，比较前统一换行
          pass: worktreeFile.replace(/\r\n/g, '\n') === MATH_FIXED,
          actual: worktreeFile.slice(0, 60),
        },
        {
          name: '原工作区文件未被改动',
          pass: mainFile === MATH_BUGGY,
          actual: mainFile.slice(0, 60),
        },
        {
          name: '分支已创建且基于基线 commit',
          pass: branchCommit.code === 0 && worktreeHead === info.baseCommit,
          actual: { branch: info.branch, worktreeHead, base: info.baseCommit, verify: branchCommit.code },
        },
        {
          name: '持久化了 runId ↔ 路径/分支/基线的映射',
          pass:
            runRow?.isolation === 'worktree'
            && runRow?.worktree_path === info.path
            && runRow?.worktree_branch === info.branch
            && runRow?.base_commit === info.baseCommit,
          actual: {
            isolation: runRow?.isolation,
            path: runRow?.worktree_path,
            branch: runRow?.worktree_branch,
            base: runRow?.base_commit,
          },
        },
        {
          name: '审计记录了生效的 worktree 路径',
          pass: ctx.audit.some((e) => e.meta?.worktreePath === info.path && e.meta?.isOsSandbox === false),
          actual: ctx.audit.filter((e) => e.type === 'session').map((e) => e.meta ?? null).slice(0, 2),
        },
        {
          name: 'task diff 能看到变更文件与状态',
          pass: diff.code === 0 && diffFiles.includes('src/math.js:modified'),
          actual: { code: diff.code, files: diffFiles, stderr: diff.stderr?.slice(0, 200) },
        },
        {
          name: 'task diff 的 patch 含实际改动内容',
          pass: typeof diff.json?.patch === 'string' && diff.json.patch.includes('+  return a + b;'),
          actual: (diff.json?.patch ?? '').slice(0, 120),
        },
        {
          name: 'task clean 删除 worktree、分支，且不影响原工作区',
          pass:
            cleaned.code === 0
            && !existsSync(info.path)
            && branchAfterClean === ''
            && readFileSync(join(ctx.ws, 'src/math.js'), 'utf8') === MATH_BUGGY,
          actual: { code: cleaned.code, exists: existsSync(info.path), branch: branchAfterClean },
        },
      ];
    },
  },

  {
    id: 'T11b',
    name: '脏工作区：拒绝隔离运行，不 stash、不改文件、不退化原地执行',
    tags: ['worktree', 'fail-closed'],
    critical: true,
    prompt: '修复 src/math.js 里 add 的实现，让测试通过',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    model: { plan: PLAN, turns: TURNS },
    cliArgs: ['--yes', '--worktree'],
    worktree: true,
    // 运行前制造未提交改动（已跟踪文件）
    async mutateBeforeRun({ ws }) {
      writeFileSync(join(ws, 'src/math.js'), "function add(a, b) {\n  return a * b; // 用户本地未提交的半成品\n}\n\nmodule.exports = { add };\n", 'utf8');
    },
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
      // 没有 worktree 产物、也没跑门禁
      noSideEffects: true,
    },
    async verify(ctx) {
      const error = String(ctx.json?.worktreeError ?? '');
      const worktreeRoot = join(ctx.artifacts, 'worktrees');
      const created = existsSync(worktreeRoot) ? readdirSync(worktreeRoot) : [];
      const mainFile = readFileSync(join(ctx.ws, 'src/math.js'), 'utf8');

      return [
        { name: '错误信息说明是未提交改动', pass: error.includes('未提交改动'), actual: error.slice(0, 160) },
        { name: '没有创建任何 worktree 目录', pass: created.length === 0, actual: created },
        { name: '没有跑质量门禁', pass: ctx.db.gates.length === 0, actual: ctx.db.gates.length },
        {
          name: '用户的未提交改动被原样保留（没有 stash/reset）',
          pass: mainFile.includes('用户本地未提交的半成品') && gitAt(ctx.ws, ['stash', 'list']).stdout === '',
          actual: mainFile.slice(0, 60),
        },
        {
          name: '没有执行任何工具（未退化到原地执行）',
          pass: ctx.audit.filter((e) => e.type === 'tool_call').length === 0,
          actual: ctx.audit.map((e) => e.type).slice(0, 5),
        },
      ];
    },
  },

  {
    id: 'T11d',
    name: 'worktree 模式下路径越界被拒绝（权限校验跟着新工作区走）',
    tags: ['worktree', 'path-guard'],
    critical: true,
    prompt: '改一个仓库外的文件',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    model: {
      plan: {
        steps: [
          {
            step_id: 'step_001',
            description: '读取 src/math.js',
            dependencies: [],
            required_tools: ['read_file'],
            risk_level: 'read',
            verification: { type: 'file_exists', target: 'src/math.js' },
          },
          {
            step_id: 'step_002',
            description: '修改工作区之外的文件（应被拒绝）',
            dependencies: ['step_001'],
            required_tools: ['edit_file'],
            risk_level: 'modify',
            verification: { type: 'tool_return_ok' },
          },
        ],
      },
      turns: [
        { toolCalls: [{ name: 'read_file', arguments: { path: 'src/math.js' } }] },
        { text: '已读取。' },
        { toolCalls: [{ name: 'edit_file', arguments: { path: '../escape.txt', oldText: 'a', newText: 'b' } }] },
        { text: '尝试写入工作区之外。' },
      ],
    },
    cliArgs: ['--yes', '--worktree'],
    worktree: true,
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
      noSideEffects: true,
    },
    async verify(ctx) {
      const outsideWorktree = join(ctx.artifacts, 'worktrees', 'escape.txt');
      const editResults = ctx.audit.filter((e) => e.type === 'tool_result' && e.tool === 'edit_file');
      return [
        {
          name: '越界写入没有成功',
          pass: editResults.every((e) => e.ok !== true),
          actual: editResults.map((e) => ({ ok: e.ok, reason: String(e.reason ?? '').slice(0, 120) })),
        },
        {
          name: '失败原因是路径越界（而不是找不到文件）',
          pass: editResults.some((e) => /越界|超出授权|WORKSPACE_ESCAPE|不在授权/i.test(String(e.reason ?? ''))),
          actual: editResults.map((e) => String(e.reason ?? '').slice(0, 120)),
        },
        {
          name: 'worktree 上一级没有多出文件',
          pass: !existsSync(outsideWorktree),
          actual: outsideWorktree,
        },
        {
          name: '原工作区未被改动',
          pass: readFileSync(join(ctx.ws, 'src/math.js'), 'utf8') === MATH_BUGGY,
          actual: 'src/math.js',
        },
      ];
    },
  },

  {
    id: 'T11e',
    name: '进程被强杀：worktree 与分支保留，状态不得是 completed',
    tags: ['worktree', 'crash'],
    critical: true,
    prompt: '改个文件然后跑一个慢命令',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    model: {
      plan: {
        steps: [
          {
            step_id: 'step_001',
            description: '读取 src/math.js',
            dependencies: [],
            required_tools: ['read_file'],
            risk_level: 'read',
            verification: { type: 'file_exists', target: 'src/math.js' },
          },
          {
            step_id: 'step_002',
            description: '跑一个慢命令',
            dependencies: ['step_001'],
            required_tools: ['run_command'],
            risk_level: 'run',
            verification: { type: 'command_exit_zero' },
          },
        ],
      },
      turns: [
        { toolCalls: [{ name: 'read_file', arguments: { path: 'src/math.js' } }] },
        { text: '已读取。' },
        { toolCalls: [{ name: 'run_command', arguments: { program: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'] } }] },
        { text: '等待中。' },
      ],
    },
    cliArgs: ['--yes', '--worktree'],
    worktree: true,
    // 等 worktree 真正建好（git worktree add 完成）后再杀，模拟崩溃而不是打断创建
    onSpawn(child, { art }) {
      const root = join(art, 'worktrees');
      const startedAt = Date.now();
      const timer = setInterval(() => {
        let ready = false;
        try {
          ready = readdirSync(root).some((name) => name.startsWith('run-'));
        } catch {
          ready = false;
        }
        if (ready) {
          clearInterval(timer);
          setTimeout(() => child.kill('SIGKILL'), 1500);
          return;
        }
        if (Date.now() - startedAt > 30_000) clearInterval(timer);
      }, 100);
      timer.unref?.();
    },
    async verify(ctx) {
      const runRow = ctx.db.runs[0];
      const runId = runRow?.run_id;
      const worktreePath = runRow?.worktree_path;
      const branch = runRow?.worktree_branch ?? (runId ? `forgex/run-${runId}` : null);
      return [
        {
          name: '进程不是正常退出（被强杀）',
          pass: ctx.run.code !== 0,
          actual: { code: ctx.run.code, signal: ctx.run.signal },
        },
        {
          name: 'worktree 目录被保留',
          pass: Boolean(worktreePath) && existsSync(worktreePath),
          actual: worktreePath ?? null,
        },
        {
          name: '分支被保留',
          pass: Boolean(branch) && gitAt(ctx.ws, ['rev-parse', '--verify', `refs/heads/${branch}`]).code === 0,
          actual: branch,
        },
        {
          name: '状态没有被写成 completed',
          pass: runRow?.status !== 'completed',
          actual: runRow?.status ?? null,
        },
        {
          name: '原工作区未被改动',
          pass: readFileSync(join(ctx.ws, 'src/math.js'), 'utf8') === MATH_BUGGY,
          actual: 'src/math.js',
        },
      ];
    },
  },

  {
    id: 'T11c',
    name: '质量门禁失败：worktree 与分支保留，产物位置可查',
    tags: ['worktree', 'retention'],
    critical: true,
    prompt: '修改 src/math.js 的注释',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    model: {
      plan: {
        steps: [
          {
            step_id: 'step_001',
            description: '读取 src/math.js',
            dependencies: [],
            required_tools: ['read_file'],
            risk_level: 'read',
            verification: { type: 'file_exists', target: 'src/math.js' },
          },
          {
            step_id: 'step_002',
            description: '在 src/math.js 顶部加一行注释',
            dependencies: ['step_001'],
            required_tools: ['edit_file'],
            risk_level: 'modify',
            verification: { type: 'tool_return_ok' },
          },
        ],
      },
      turns: [
        { toolCalls: [{ name: 'read_file', arguments: { path: 'src/math.js' } }] },
        { text: '已读取。' },
        { toolCalls: [{ name: 'edit_file', arguments: { path: 'src/math.js', oldText: 'function add', newText: '// 改了注释但没修 bug\nfunction add' } }] },
        { text: '已加注释。' },
      ],
    },
    cliArgs: ['--yes', '--worktree'],
    worktree: true,
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
      gateVerdict: 'failed',
    },
    async verify(ctx) {
      const info = ctx.json?.worktree;
      const runRow = ctx.db.runs[0];
      return [
        { name: '门禁失败但输出仍带产物位置', pass: Boolean(info?.path), actual: info ?? null },
        {
          name: 'worktree 与分支被保留（不自动删除）',
          pass:
            Boolean(info?.path)
            && existsSync(info.path)
            && gitAt(ctx.ws, ['rev-parse', '--verify', `refs/heads/${info.branch}`]).code === 0,
          actual: { exists: info?.path ? existsSync(info.path) : false, branch: info?.branch },
        },
        {
          name: '数据库记录仍指向该 worktree',
          pass: runRow?.worktree_path === info?.path,
          actual: runRow?.worktree_path,
        },
        {
          name: '失败任务的改动留在 worktree 里（可排查）',
          pass: Boolean(info?.path) && readFileSync(join(info.path, 'src/math.js'), 'utf8').includes('改了注释但没修 bug'),
          actual: info?.path ? readFileSync(join(info.path, 'src/math.js'), 'utf8').slice(0, 40) : null,
        },
        {
          name: '原工作区没有被改动',
          pass: readFileSync(join(ctx.ws, 'src/math.js'), 'utf8') === MATH_BUGGY,
          actual: 'src/math.js',
        },
      ];
    },
  },
];
