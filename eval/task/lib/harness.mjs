/**
 * 任务评测脚手架：临时 Git 仓库 + 本地假模型 + 真实 CLI 子进程 + 结果取证。
 *
 * 设计原则（与 benchmark/lib/harness.mjs 保持一致的取舍）：
 *   - 一个场景一个 mktemp 工作区，跑完即删；
 *   - 断言只看**可外部验证的证据**：文件内容、进程退出码、SQLite 记录、审计 JSONL；
 *     不看模型自述文本，也不做输出相似度比对；
 *   - 不做进程内打桩：CLI 以子进程运行，走生产装配路径（loadConfig / Agent / Dispatcher）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeModel } from './fake-model.mjs';

/** 场景断言失败（与脚手架自身异常区分） */
export class EvalFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvalFailure';
  }
}

export function assert(cond, message) {
  if (!cond) throw new EvalFailure(message);
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new EvalFailure(`${message}（期望 ${e}，实际 ${a}）`);
}

/* ------------------------------------------------------------------ */
/* CLI 定位                                                             */
/* ------------------------------------------------------------------ */

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const CLI_ENTRY = join(REPO_ROOT, 'apps', 'cli', 'dist', 'main.js');

export function assertCliBuilt() {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`缺少 ${relative(REPO_ROOT, CLI_ENTRY)}，请先运行 pnpm build`);
  }
  // dist 旧于源码时静默跑旧代码是评测套件最危险的坑，这里直接拒绝。
  // 逐文件比对不现实（tsc 只重写真正变化的文件），因此比较"两侧最新 mtime"：
  // 只要有任何源码比任何产物都新，就说明构建不完整。
  const distRoots = ['apps/cli/dist', ...listPackageDistDirs()];
  const srcRoots = ['apps/cli/src', 'packages/core/src', 'packages/tools/src', 'packages/security/src'];
  const newestDist = distRoots.map((dir) => newestMtime(join(REPO_ROOT, dir))).reduce((a, b) => Math.max(a, b), 0);
  const newestSrc = srcRoots.map((dir) => newestMtime(join(REPO_ROOT, dir))).reduce((a, b) => Math.max(a, b), 0);
  if (newestDist === 0) {
    throw new Error('没有找到构建产物，请先运行 pnpm build');
  }
  if (newestSrc > newestDist + 1000) {
    throw new Error(
      `构建产物早于源码（dist=${new Date(newestDist).toISOString()}，src=${new Date(newestSrc).toISOString()}），`
      + '评测会跑旧代码；请先 pnpm build',
    );
  }
}

function listPackageDistDirs() {
  const packagesDir = join(REPO_ROOT, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('packages', entry.name, 'dist'))
    .filter((dir) => existsSync(join(REPO_ROOT, dir)));
}

function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readDirRecursive(dir)) {
    const t = statSync(entry).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

function* readDirRecursive(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        // node_modules / .git 内部文件对快照无意义，且会让场景变慢
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 场景执行                                                             */
/* ------------------------------------------------------------------ */

/**
 * 运行一个场景并返回取证结果（不抛异常；断言失败记录在 checks 里）。
 *
 * @param {object} scenario
 * @param {{keepWorkspace?: boolean, cliTimeoutMs?: number}} [options]
 */
export async function runScenario(scenario, options = {}) {
  const started = Date.now();
  const ws = mkdtempSync(join(tmpdir(), 'forgex-eval-'));
  const art = mkdtempSync(join(tmpdir(), 'forgex-eval-art-'));
  const checks = [];
  const base = {
    id: scenario.id,
    name: scenario.name,
    tags: scenario.tags ?? [],
    critical: scenario.critical !== false,
  };

  let fake = null;
  let run = null;
  const observed = { taskStatus: null, dbStatus: null, gateVerdict: null, toolCalls: null, exitCode: null };
  try {
    await prepareWorkspace(ws, scenario);
    // 场景可以在运行前改动工作区（例如故意留下未提交改动）
    if (scenario.mutateBeforeRun) await scenario.mutateBeforeRun({ ws, artifacts: art });
    const before = snapshotTree(ws);

    // live 模式：用真实模型（调用方显式开启），否则一律用本地假模型
    fake = options.liveModel ? null : await startFakeModel(scenario.model ?? {});
    const configPath = writeConfig(art, fake ? fake.baseUrl : null, scenario, options.liveModel);
    run = await spawnCli({
      cwd: ws,
      args: ['run', scenario.prompt, '--json', ...(scenario.cliArgs ?? [])],
      configPath,
      timeoutMs: options.cliTimeoutMs ?? scenario.cliTimeoutMs ?? 120_000,
      // onSpawn 额外拿到 ws/art：便于"等产物出现再发信号"这类场景
      ...(scenario.onSpawn ? { onSpawn: (child) => scenario.onSpawn(child, { ws, art }) } : {}),
      ...(scenario.pty ? { pty: true } : {}),
      ...(scenario.stdinData !== undefined ? { stdinData: scenario.stdinData } : {}),
      ...(scenario.stdinDelayMs !== undefined ? { stdinDelayMs: scenario.stdinDelayMs } : {}),
    });

    const after = snapshotTree(ws);
    const ctx = {
      scenario,
      ws,
      artifacts: art,
      configPath,
      run,
      json: parseJsonOutput(run.stdout),
      db: readDatabase(readDbPath(configPath)),
      audit: readAudit(configPath),
      requests: fake?.requests ?? [],
      before,
      after,
      changedFiles: diffSnapshots(before, after),
    };

    // 通用检查
    const expect = scenario.expect ?? {};
    observed.taskStatus = ctx.json?.taskStatus ?? null;
    observed.exitCode = run.code;
    observed.dbStatus = ctx.db.runs[0]?.status ?? null;
    observed.gateVerdict = ctx.db.gates[0]?.final_message ?? null;
    observed.toolCalls = executedToolNames(ctx.audit).length;
    if (expect.taskStatus !== undefined) {
      checks.push(check('任务状态', ctx.json?.taskStatus === expect.taskStatus, {
        expected: expect.taskStatus,
        actual: ctx.json?.taskStatus ?? null,
      }));
    }
    if (expect.exitCode !== undefined) {
      checks.push(check('退出码', run.code === expect.exitCode, { expected: expect.exitCode, actual: run.code }));
    }
    if (expect.dbStatus !== undefined) {
      const actual = ctx.db.runs[0]?.status ?? null;
      checks.push(check('持久化状态', actual === expect.dbStatus, { expected: expect.dbStatus, actual }));
    }
    if (expect.gateVerdict !== undefined) {
      const actual = ctx.db.gates[0]?.final_message ?? null;
      checks.push(check('质量门禁结论', actual === expect.gateVerdict, { expected: expect.gateVerdict, actual }));
    }
    if (expect.files) {
      for (const [rel, matcher] of Object.entries(expect.files)) {
        const abs = join(ws, rel);
        const text = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        const ok = text !== null && (matcher instanceof RegExp ? matcher.test(text) : text === matcher);
        checks.push(check(`文件 ${rel}`, ok, { expected: String(matcher), actual: text === null ? '(不存在)' : shorten(text) }));
      }
    }
    if (expect.filesAbsent) {
      for (const rel of expect.filesAbsent) {
        const ok = !existsSync(join(ws, rel));
        checks.push(check(`文件 ${rel} 不存在`, ok, { actual: existsSync(join(ws, rel)) ? '存在' : '不存在' }));
      }
    }
    if (expect.planningHadNoTools === true) {
      const planning = ctx.requests.filter((r) => r.kind === 'planning');
      const ok = planning.length > 0 && planning.every((r) => r.toolCount === 0);
      checks.push(check('计划阶段未暴露工具', ok, { actual: planning.map((r) => r.toolCount) }));
    }
    if (expect.toolsExecuted) {
      const executed = executedToolNames(ctx.audit);
      const missing = expect.toolsExecuted.filter((name) => !executed.includes(name));
      checks.push(check('实际执行的工具', missing.length === 0, { expected: expect.toolsExecuted, actual: executed }));
    }
    if (expect.toolsForbidden) {
      const executed = executedToolNames(ctx.audit);
      const bad = expect.toolsForbidden.filter((name) => executed.includes(name));
      checks.push(check('禁止执行的工具未被执行', bad.length === 0, { actual: bad }));
    }
    if (expect.maxToolCalls !== undefined) {
      const count = executedToolNames(ctx.audit).length;
      checks.push(check('工具调用次数上限', count <= expect.maxToolCalls, {
        expected: `<= ${expect.maxToolCalls}`,
        actual: count,
      }));
    }
    if (expect.noSideEffects === true) {
      checks.push(check('工作区零副作用', ctx.changedFiles.length === 0, { actual: ctx.changedFiles }));
    }
    if (expect.auditEmptyTools === true) {
      const executed = executedToolNames(ctx.audit);
      checks.push(check('未执行任何工具', executed.length === 0, { actual: executed }));
    }

    if (typeof scenario.verify === 'function') {
      const extra = await scenario.verify(ctx);
      for (const item of extra ?? []) checks.push(item);
    }
  } catch (err) {
    checks.push(check('场景执行', false, { error: err instanceof Error ? err.message : String(err) }));
  } finally {
    if (fake) await fake.close().catch(() => {});
    if (!options.keepWorkspace) {
      rmSync(ws, { recursive: true, force: true });
      rmSync(art, { recursive: true, force: true });
    }
  }

  const violations = detectViolations(scenario, checks, run);
  return {
    ...base,
    pass: checks.every((c) => c.pass),
    durationMs: Date.now() - started,
    checks,
    violations,
    observed,
    ...(run ? { exitCode: run.code, signal: run.signal } : {}),
    ...(options.keepWorkspace ? { workspace: ws, artifacts: art, stderr: run?.stderr ?? '', stdout: run?.stdout ?? '' } : {}),
  };
}

/**
 * 三类"红线"违规：无论场景是否 pass，出现就让 CI 失败。
 * 它们对应最容易出现的假阳性/越权。
 */
function detectViolations(scenario, checks, run) {
  const violations = [];
  const byName = (name) => checks.find((c) => c.name === name);

  const expectedStatus = scenario.expect?.taskStatus;
  const statusCheck = byName('任务状态');
  if (expectedStatus && expectedStatus !== 'completed' && statusCheck?.actual === 'completed') {
    violations.push({
      type: 'false_completed',
      detail: `期望 ${expectedStatus}，实际报告 completed`,
    });
  }

  const forbidden = byName('禁止执行的工具未被执行');
  if (forbidden && !forbidden.pass) {
    violations.push({ type: 'forbidden_tool_executed', detail: JSON.stringify(forbidden.actual) });
  }

  const noSideEffects = byName('工作区零副作用');
  if (noSideEffects && !noSideEffects.pass) {
    violations.push({ type: 'side_effect_after_denial', detail: JSON.stringify(noSideEffects.actual) });
  }

  if (run && run.code === null && run.signal === null) {
    violations.push({ type: 'cli_not_terminated', detail: 'CLI 进程未正常结束' });
  }
  return violations;
}

function check(name, pass, detail = {}) {
  return { name, pass: Boolean(pass), ...detail };
}

/* ------------------------------------------------------------------ */
/* 工作区准备                                                           */
/* ------------------------------------------------------------------ */

async function prepareWorkspace(ws, scenario) {
  const files = { ...(scenario.files ?? {}) };
  if (scenario.packageJson !== null) {
    files['package.json'] = JSON.stringify(
      scenario.packageJson ?? {
        name: 'forgex-eval-fixture',
        version: '1.0.0',
        private: true,
        scripts: { test: 'node test.js' },
      },
      null,
      2,
    );
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  if (scenario.git !== false) {
    git(ws, ['init', '-q']);
    git(ws, ['add', '-A']);
    git(ws, ['-c', 'user.email=eval@forgex.local', '-c', 'user.name=ForgeX Eval', 'commit', '-q', '-m', 'fixture']);
  }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败: ${result.stderr || result.stdout}`);
  }
}

/** 场景配置写在仓库外的 artifacts 目录，避免污染被测工作区 */
function writeConfig(art, baseUrl, scenario, liveModel) {
  const security = {
    mode: 'trusted',
    workspaceRoots: ['.'],
    requireApprovalForWrite: false,
    requireApprovalForExecute: false,
    commandTimeoutMs: 20_000,
    ...(scenario.config ?? {}),
  };
  const model = liveModel
    ? { ...liveModel, stream: false, maxRetries: 0, temperature: 0 }
    : {
        baseUrl,
        model: 'forgex-eval-fake',
        apiKey: 'eval-not-a-real-key',
        stream: false,
        maxRetries: 0,
        timeoutMs: 20_000,
        temperature: 0,
      };
  const config = {
    model,
    security: {
      ...security,
      auditLogPath: join(art, 'audit.jsonl'),
    },
    session: { dbPath: join(art, 'sessions.db') },
    agent: { maxIterations: 8, ...(liveModel ? { maxIterations: 16 } : {}) },
    ...(scenario.worktree
      ? { worktree: { root: scenario.worktreeRoot ?? join(art, 'worktrees') } }
      : {}),
  };
  const path = join(art, 'forgex.config.json');
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  return path;
}

/* ------------------------------------------------------------------ */
/* 子进程                                                               */
/* ------------------------------------------------------------------ */

/** 清掉所有 FORGEX_* 与厂商 Key，保证评测不受本机环境影响 */
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^FORGEX_/i.test(key)) continue;
    if (/^(DEEPSEEK|OPENAI|ANTHROPIC|DASHSCOPE|MOONSHOT|ZHIPU|QWEN|SILICONFLOW|GROQ|MISTRAL)_/i.test(key)) continue;
    env[key] = value;
  }
  env.FORGEX_EVAL = '1';
  return env;
}

function spawnCli({ cwd, args, configPath, timeoutMs, onSpawn, pty, stdinData, stdinDelayMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const fullArgs = [CLI_ENTRY, ...args, '--config', configPath];
    // pty 模式用于验证"用户在终端里拒绝计划"这类必须走 TTY 的分支（仅 POSIX）
    const launch = pty
      ? { command: 'script', args: ['-qec', [process.execPath, ...fullArgs].map(shQuote).join(' '), '/dev/null'] }
      : { command: process.execPath, args: fullArgs };
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    if (pty && stdinData !== undefined) {
      const stdinTimer = setTimeout(() => {
        try {
          child.stdin.write(stdinData);
        } catch { /* 进程可能已退出 */ }
      }, stdinDelayMs ?? 1500);
      stdinTimer.unref?.();
    }
    onSpawn?.(child);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut, durationMs: Date.now() - started });
    });
  });
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 解析 --json 输出；容忍前面夹带的告警行 */
export function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch { /* 继续尝试 */ }
  const start = text.indexOf('{\n');
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start));
    } catch { /* 继续尝试 */ }
  }
  // 逐行倒序找第一个能解析的 JSON 对象
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines.slice(i).join('\n');
    if (!candidate.trimStart().startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch { /* 继续 */ }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 取证：SQLite / 审计 / 文件快照                                        */
/* ------------------------------------------------------------------ */

function readDbPath(configPath) {
  return JSON.parse(readFileSync(configPath, 'utf8')).session.dbPath;
}

export function readDatabase(dbPath) {
  if (!existsSync(dbPath)) return { runs: [], steps: [], gates: [] };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tableExists = (name) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
    const runs = tableExists('task_runs')
      ? db.prepare('SELECT * FROM task_runs ORDER BY created_at ASC').all()
      : [];
    const steps = tableExists('step_results')
      ? db.prepare('SELECT * FROM step_results ORDER BY id ASC').all()
      : [];
    const gates = tableExists('gate_results')
      ? db.prepare('SELECT * FROM gate_results ORDER BY id ASC').all()
      : [];
    return { runs: toPlain(runs), steps: toPlain(steps), gates: toPlain(gates) };
  } finally {
    db.close();
  }
}

/** node:sqlite 返回的是无原型对象，统一转成普通对象便于 JSON 序列化 */
function toPlain(rows) {
  return rows.map((row) => ({ ...row }));
}

export function readAudit(configPath) {
  const path = JSON.parse(readFileSync(configPath, 'utf8')).security.auditLogPath;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/**
 * 实际执行过的工具名（按出现顺序去重）。
 * 只统计 `tool_result` 且 ok=true —— 被拒绝/未执行的调用不算"执行过"。
 */
export function executedToolNames(audit) {
  const names = [];
  for (const event of audit) {
    if (event.type !== 'tool_result' || event.ok !== true) continue;
    const name = event.tool;
    if (typeof name === 'string' && !names.includes(name)) names.push(name);
  }
  return names;
}

export function toolEvents(audit) {
  return audit
    .filter((e) => e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'approval')
    .map((e) => ({ type: e.type, tool: e.tool, ok: e.ok, decision: e.decision, input: e.input }));
}

export function snapshotTree(root) {
  const out = new Map();
  for (const file of readDirRecursive(root)) {
    const rel = relative(root, file).split('\\').join('/');
    if (rel.startsWith('.git/') || rel === '.git') continue;
    out.set(rel, hashOf(file));
  }
  return out;
}

function hashOf(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

export function diffSnapshots(before, after) {
  const changed = [];
  for (const [rel, hash] of after) {
    if (before.get(rel) !== hash) changed.push(before.has(rel) ? `M ${rel}` : `A ${rel}`);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changed.push(`D ${rel}`);
  }
  return changed;
}

export { shorten };

function shorten(text, max = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
