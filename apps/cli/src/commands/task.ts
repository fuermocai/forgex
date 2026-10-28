/**
 * forgex task：任务产物的审阅与清理入口（v0.5.6）。
 *
 *   forgex task list  [--json] [--limit <n>]
 *   forgex task show  <runId> [--json]
 *   forgex task diff  <runId> [--stat] [--patch] [--json]
 *   forgex task clean <runId> [--force]
 *   forgex task diagnose <runId> [--json]        # 中断诊断：停在哪、哪些能自动恢复
 *   forgex task reconcile <runId> [--step <id>] [--confirm-done|--confirm-retry|--block] [--note <s>]
 *   forgex task resume <runId> [--json]          # 安全恢复（委托 forgex run --resume）
 *
 * 恢复语义：
 *   - 自动继续：从未开始的步骤；已完成且验收通过的步骤直接跳过；
 *   - 必须人工核对（reconcile）：中断时 running 的步骤、验收证据缺失的步骤、
 *     被取消/失败的步骤——模型无权替你把这些标成"完成"。
 *
 * 设计约束：
 *   - 只读操作（list/show/diff）绝不修改仓库、worktree 或数据库；
 *   - `clean` 是**唯一**删除入口，且必须通过路径归属校验（见 review-worktree.ts）；
 *   - 没有"自动合并"或"自动复制回原工作区"的子命令——那是用户的决定，不是工具的决定。
 */
import { stdout } from 'node:process';
import { ForgeError } from '@forgex/shared';
import { flagBool, flagNumber, type ParsedArgs } from '../args.js';
import { loadConfig } from '../config/load-config.js';
import { TaskRunStore, type TaskRunSummary } from '../task-run/task-run-store.js';
import { analyzeTaskRun, applyReconcileDecision, type ReconcileDecision } from '../task-run/recovery.js';
import {
  readWorktreeDiff,
  removeReviewWorktree,
  type ReviewWorktreeRecord,
} from '../task-run/review-worktree.js';

const USAGE = [
  '用法：',
  '  forgex task list [--limit <n>] [--json]',
  '  forgex task show <runId> [--json]',
  '  forgex task diff <runId> [--stat] [--patch] [--json]',
  '  forgex task clean <runId> [--force]',
  '  forgex task diagnose <runId> [--json]',
  '  forgex task reconcile <runId> [--step <id>] [--confirm-done|--confirm-retry|--block] [--note <文本>]',
  '  forgex task resume <runId> [--json]',
  '',
].join('\n');

export async function taskCommand(args: ParsedArgs, options: { cwd: string }): Promise<number> {
  const sub = args.positionals[0] ?? 'list';
  const runId = args.positionals[1];
  const json = flagBool(args.flags, 'json');

  const loaded = loadConfig({
    cwd: options.cwd,
    ...(typeof args.flags.config === 'string' ? { configPath: args.flags.config } : {}),
  });
  const store = new TaskRunStore(loaded.config.session.dbPath);

  try {
    switch (sub) {
      case 'list':
        return listTasks(store, flagNumber(args.flags, 'limit') ?? 20, json);
      case 'show':
        return showTask(store, requireRunId(runId), json);
      case 'diff':
        return diffTask(store, loaded.config.worktree.root, requireRunId(runId), args, json);
      case 'clean':
        return cleanTask(store, loaded.config.worktree.root, requireRunId(runId), flagBool(args.flags, 'force'), json);
      case 'diagnose':
        return await diagnoseTask(store, requireRunId(runId), json);
      case 'reconcile':
        return await reconcileTask(store, requireRunId(runId), args, json);
      case 'resume':
        return await resumeTask(requireRunId(runId), args, options.cwd);
      default:
        throw new ForgeError('CONFIG_INVALID', `未知的 task 子命令: ${sub}\n\n${USAGE}`);
    }
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* list                                                                */
/* ------------------------------------------------------------------ */

function listTasks(store: TaskRunStore, limit: number, json: boolean): number {
  const runs = store.listRuns(limit);
  if (json) {
    stdout.write(JSON.stringify({ runs }, null, 2) + '\n');
    return 0;
  }
  if (runs.length === 0) {
    stdout.write('还没有任务记录。用 `forgex run "<任务>"` 创建。\n');
    return 0;
  }
  stdout.write(`${pad('RUN ID', 18)} ${pad('状态', 14)} ${pad('隔离', 9)} ${pad('创建时间', 20)} 任务\n`);
  for (const run of runs) {
    const isolation = run.isolation === 'worktree' ? 'worktree' : '原地';
    stdout.write(
      `${pad(run.runId, 18)} ${pad(run.status, 14)} ${pad(isolation, 9)} ${pad(run.createdAt, 20)} ${truncate(run.prompt, 60)}\n`,
    );
    if (run.worktreePath) stdout.write(`   产物: ${run.worktreePath}（分支 ${run.worktreeBranch ?? '?'}）\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* show                                                                */
/* ------------------------------------------------------------------ */

function showTask(store: TaskRunStore, runId: string, json: boolean): number {
  const run = requireRun(store, runId);
  const steps = store.listStepResults(runId);
  if (json) {
    stdout.write(JSON.stringify({ run, steps }, null, 2) + '\n');
    return 0;
  }
  stdout.write(`runId      ${run.runId}\n`);
  stdout.write(`状态       ${run.status}${run.exitCode === null ? '' : `（exit=${run.exitCode}）`}\n`);
  stdout.write(`隔离       ${run.isolation === 'worktree' ? 'worktree（可审阅）' : '原地执行'}\n`);
  stdout.write(`工作区     ${run.workspace}\n`);
  stdout.write(`耗时       ${run.durationMs ?? 0}ms\n`);
  const metricsLabel = run.metricsSource === 'recorded' ? '已记录'
    : run.metricsSource === 'partial' ? '部分记录（中断时可能有遗漏）'
    : run.metricsSource === 'backfilled_estimate' ? '历史回填估算' : '不可用';
  stdout.write(`指标       ${metricsLabel}：模型 ${run.modelCalls} 次；工具 ${run.toolCalls} 次；tokens ${run.totalTokens}\n`);
  if (run.worktreePath) {
    stdout.write(`产物路径   ${run.worktreePath}\n`);
    stdout.write(`分支       ${run.worktreeBranch}\n`);
    stdout.write(`基线提交   ${run.baseCommit}\n`);
  }
  stdout.write(`创建时间   ${run.createdAt}\n`);
  if (run.finalMessage) stdout.write(`结论       ${run.finalMessage}\n`);
  if (steps.length > 0) {
    stdout.write('\n步骤：\n');
    for (const s of steps) {
      const verify = s.verification_passed ? '验证通过' : '验证未通过';
      stdout.write(
        `  ${s.final_status === 'completed' ? '✓' : '✗'} ${s.step_id}  ${s.final_status}  尝试 ${s.attempts_used} 次  ${verify}`
          + `${s.failure_reason ? `  ${truncate(s.failure_reason, 80)}` : ''}\n`,
      );
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* diagnose：中断诊断（纯读取，不改任何状态）                           */
/* ------------------------------------------------------------------ */

async function diagnoseTask(store: TaskRunStore, runId: string, json: boolean): Promise<number> {
  const analysis = await analyzeTaskRun(store, runId);
  if (json) {
    stdout.write(JSON.stringify(analysis, null, 2) + '\n');
    return analysis.verdict === 'unrecoverable' ? 2 : 0;
  }
  stdout.write(`runId      ${analysis.runId}\n`);
  stdout.write(`状态       ${analysis.runStatus}  快照 ${analysis.snapshotAt ?? '无'}\n`);
  stdout.write(`诊断       ${analysis.message}\n`);
  if (analysis.blockers.length > 0) {
    stdout.write('\n阻塞项：\n');
    for (const b of analysis.blockers) stdout.write(`  ! ${b}\n`);
  }
  if (analysis.steps.length > 0) {
    stdout.write('\n步骤：\n');
    for (const st of analysis.steps) {
      const mark = st.classification === 'verified_done' || st.classification === 'manual_done' ? '✓'
        : st.classification === 'resumable' ? '·'
        : '✗';
      stdout.write(`  ${mark} ${st.step_id}  [${st.status}] ${st.classification}  ${st.reason}\n`);
    }
  }
  if (analysis.next_actions.length > 0) {
    stdout.write('\n下一步：\n');
    for (const a of analysis.next_actions) stdout.write(`  ${a}\n`);
  }
  return analysis.verdict === 'unrecoverable' ? 2 : 0;
}

/* ------------------------------------------------------------------ */
/* reconcile：人工核对（唯一能把中断步骤改为可继续状态的入口）           */
/* ------------------------------------------------------------------ */

async function reconcileTask(store: TaskRunStore, runId: string, args: ParsedArgs, json: boolean): Promise<number> {
  const stepId = typeof args.flags.step === 'string' ? args.flags.step : undefined;
  const note = typeof args.flags.note === 'string' ? args.flags.note : undefined;
  const decisions: ReconcileDecision[] = [];
  if (flagBool(args.flags, 'confirm-done')) decisions.push('confirm_done');
  if (flagBool(args.flags, 'confirm-retry')) decisions.push('confirm_retry');
  if (flagBool(args.flags, 'block')) decisions.push('block');
  if (decisions.length > 1) {
    throw new ForgeError('CONFIG_INVALID', '--confirm-done / --confirm-retry / --block 只能选一个');
  }

  // 无决定：展示待核对清单（原因、工具、验收规则、下游影响面），退出码 0
  if (decisions.length === 0) {
    const analysis = await analyzeTaskRun(store, runId);
    if (json) {
      stdout.write(JSON.stringify({ runId, verdict: analysis.verdict, reconcile: analysis.reconcile_step_ids, steps: analysis.steps, next_actions: analysis.next_actions }, null, 2) + '\n');
      return 0;
    }
    stdout.write(`待核对的步骤（${analysis.reconcile_step_ids.length}）：\n`);
    for (const st of analysis.steps) {
      if (st.classification !== 'needs_reconciliation' && st.classification !== 'failed') continue;
      stdout.write(`  ${st.step_id}  [${st.status}] ${st.description}\n`);
      stdout.write(`    原因: ${st.reason}\n`);
      stdout.write(`    工具: ${st.required_tools.join(', ') || '(无)'}  验收: ${JSON.stringify(st.verification)}\n`);
      stdout.write(`    下游受影响步骤: ${st.downstream_step_ids.join(', ') || '(无)'}\n`);
    }
    if (analysis.worktree.path) stdout.write(`worktree  ${analysis.worktree.path}\n`);
    stdout.write('\n决定方式：\n');
    for (const a of analysis.next_actions) stdout.write(`  ${a}\n`);
    return 0;
  }

  // 有决定：必须指定步骤
  if (!stepId) {
    throw new ForgeError('CONFIG_INVALID', '使用 --confirm-done / --confirm-retry / --block 时必须提供 --step <step_id>');
  }
  const decision = decisions[0]!;
  const result = await applyReconcileDecision(store, runId, stepId, decision, note);
  if (json) {
    stdout.write(JSON.stringify({ runId, decision, ...result }, null, 2) + '\n');
  } else {
    const label = decision === 'confirm_done' ? '已确认完成（人工背书）' : decision === 'confirm_retry' ? '已确认外部状态，恢复时将重新执行' : '已阻塞';
    stdout.write(`${stepId}: ${label}\n`);
    stdout.write(`下游受影响步骤: ${result.affected_downstream.join(', ') || '(无)'}\n`);
    stdout.write(`继续执行: forgex task resume ${runId}\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* resume：安全恢复（委托 run --resume，全部前置校验在那里执行）         */
/* ------------------------------------------------------------------ */

async function resumeTask(runId: string, args: ParsedArgs, cwd: string): Promise<number> {
  const { runCommand } = await import('./run.js');
  // 把 task resume 转成 run --resume：<runId>（无 prompt；诊断失败返回非零）
  const resumedArgs = {
    command: 'run',
    positionals: [],
    flags: { ...args.flags, resume: runId },
  } satisfies ParsedArgs;
  return await runCommand(resumedArgs, { cwd });
}

/* ------------------------------------------------------------------ */
/* diff                                                               */
/* ------------------------------------------------------------------ */

async function diffTask(
  store: TaskRunStore,
  configuredRoot: string,
  runId: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const record = requireWorktreeRecord(store, configuredRoot, runId);
  const diff = await readWorktreeDiff(record);

  if (json) {
    stdout.write(JSON.stringify(diff, null, 2) + '\n');
    return 0;
  }

  stdout.write(`runId      ${diff.runId}\n`);
  stdout.write(`worktree   ${diff.path}\n`);
  stdout.write(`分支       ${diff.branch}（基线 ${diff.baseCommit.slice(0, 8)}，HEAD ${diff.head.slice(0, 8)}）\n`);

  if (diff.files.length === 0) {
    stdout.write('\n没有变更：worktree 与基线一致。\n');
    return 0;
  }

  stdout.write(`\n变更文件（${diff.files.length}）：\n`);
  for (const file of diff.files) {
    stdout.write(`  ${pad(file.status, 11)} ${file.path}\n`);
  }
  if (diff.untrackedCount > 0) {
    stdout.write(`\n注意：其中 ${diff.untrackedCount} 个未跟踪文件不会出现在下面的 patch 里（git 不追踪它们）。\n`);
  }

  if (diff.stat) stdout.write(`\n统计：\n${indent(diff.stat, '  ')}\n`);

  if (flagBool(args.flags, 'patch')) {
    stdout.write(`\n补丁${diff.patchTruncated ? '（已截断）' : ''}：\n${diff.patch}\n`);
  } else if (!flagBool(args.flags, 'stat')) {
    stdout.write('\n加 --patch 查看完整补丁，加 --stat 只看统计。\n');
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* clean                                                              */
/* ------------------------------------------------------------------ */

async function cleanTask(
  store: TaskRunStore,
  configuredRoot: string,
  runId: string,
  force: boolean,
  json: boolean,
): Promise<number> {
  const record = requireWorktreeRecord(store, configuredRoot, runId);
  const removed = await removeReviewWorktree(record, { root: configuredRoot, force });

  if (json) {
    stdout.write(JSON.stringify({ runId, ...removed }, null, 2) + '\n');
  } else {
    stdout.write(`已删除 worktree: ${removed.path}\n`);
    stdout.write(`已删除分支: ${removed.branch}\n`);
    stdout.write(`任务记录保留：forgex task show ${runId}\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* 辅助                                                               */
/* ------------------------------------------------------------------ */

function requireRunId(runId: string | undefined): string {
  if (!runId) {
    throw new ForgeError('CONFIG_INVALID', `缺少 runId\n\n${USAGE}`);
  }
  return runId;
}

function requireRun(store: TaskRunStore, runId: string): TaskRunSummary {
  const run = store.getRunSummary(runId);
  if (!run) {
    throw new ForgeError('WORKTREE_NOT_FOUND', `找不到任务记录: ${runId}`);
  }
  return run;
}

/** 从数据库记录重建 worktree 句柄；记录不完整时拒绝而不是猜 */
function requireWorktreeRecord(store: TaskRunStore, configuredRoot: string, runId: string): ReviewWorktreeRecord {
  const run = requireRun(store, runId);
  if (run.isolation !== 'worktree') {
    throw new ForgeError(
      'WORKTREE_NOT_FOUND',
      `任务 ${runId} 是原地执行的，没有 worktree 产物（隔离方式：${run.isolation}）`,
      { details: { runId, isolation: run.isolation } },
    );
  }
  if (!run.worktreePath || !run.worktreeBranch || !run.baseCommit) {
    throw new ForgeError(
      'WORKTREE_NOT_FOUND',
      `任务 ${runId} 标记为 worktree 隔离，但记录里缺少路径/分支/基线信息，拒绝操作`,
      { details: { runId, worktreePath: run.worktreePath, branch: run.worktreeBranch, baseCommit: run.baseCommit } },
    );
  }
  return {
    runId,
    repoRoot: run.workspace,
    // 用记录里的根目录做归属判定；与当前配置不一致时由 removeReviewWorktree 拒绝
    root: run.worktreeRoot ?? configuredRoot,
    path: run.worktreePath,
    branch: run.worktreeBranch,
    baseCommit: run.baseCommit,
  };
}

function pad(text: string, width: number): string {
  // 中文按 2 个显示宽度算，避免表格错位
  const displayWidth = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - displayWidth));
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n');
}
