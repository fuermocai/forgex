/**
 * forgex run：编码任务端到端验收闭环（v0.5.0 重写，v0.5.6 增加可审阅 worktree）。
 *
 * 状态机：
 *   ┌──────────┐  generate  ┌─────────────┐  valid? ┌────────────┐
 *   │ 用户请求  │───────────→│  TaskPlan    │────────→│  继续执行   │
 *   └──────────┘             │  (LLM+校验)  │         │ --plan?     │
 *                            └─────────────┘         │ 仅展示 退出  │
 *                                                    └────────────┘
 *                                                          │ 确认
 *                                                          ↓
 *                                              ┌──────────────────────┐
 *                                              │ --worktree?          │
 *                                              │  干净性检查 → 建 worktree │
 *                                              │  失败即终止（不回退）    │
 *                                              └──────────┬───────────┘
 *                                                          ↓
 *                                                    ┌────────────┐
 *                                                    │ TaskPlanner│ runSingle()
 *                                                    │ StepExec   │ → 每步 auto verify
 *                                                    │ TaskVerify │
 *                                                    └─────┬──────┘
 *                                                          ↓
 *                                                    ┌────────────┐
 *                                                    │ QualityGate│ 在生效工作区里跑
 *                                                    │ test/tsc/build
 *                                                    └─────┬──────┘
 *                                                          ↓
 *                                                    ┌────────────┐
 *                                                    │持久化 + 输出│
 *                                                    │ exit_code： 0 仅当
 *                                                    │ completed + passed
 *                                                    └────────────┘
 *
 * 隔离语义（v0.5.6）：
 *   - 默认仍在**原地**执行，行为不变；`--worktree` 是显式 opt-in；
 *   - worktree 只隔离**工作区与改动**，不是 OS 沙箱（无 namespace/网络/进程隔离）；
 *   - 任务结束**不**自动合并、**不**复制回原工作区、**不**自动删除 worktree；
 *     审阅用 `forgex task diff <runId>`，清理用 `forgex task clean <runId>`。
 *
 * 退出码：
 *   0  completed — 计划全过 + 质量门禁 passed
 *   1  failed / blocked / unverified / aborted（含 worktree 创建失败）
 *   2  invalid_plan — 计划校验失败
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { ForgeError, createLogger, type Logger } from '@forgex/shared';
import { createProvider } from '@forgex/models';
import { PlanManager, SessionStore, StepExecutor, TaskPlanner, type CheckpointRecord, type PlanManagerOptions, type StepExecResult, type TaskPlan } from '@forgex/core';
import type { ApprovalHandler } from '@forgex/security';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { loadConfig } from '../config/load-config.js';
import { modelSetupHint } from '../config/setup-hint.js';
import { createRuntime, type ForgeRuntime } from '../runtime/create-runtime.js';
import { TaskPlanGenerator, TaskPlanGeneratorError } from '../task-run/task-plan-generator.js';
import { ProductionQualityGate } from '../task-run/production-quality-gate.js';
import { TaskRunStore, type TaskRunStatus } from '../task-run/task-run-store.js';
import { analyzeTaskRun, assertResumable, verifyWorktreeForResume } from '../task-run/recovery.js';
import {
  assertCleanRepo,
  createReviewWorktree,
  type RepoState,
  type ReviewWorktreeRecord,
} from '../task-run/review-worktree.js';

export async function runCommand(args: ParsedArgs, options: { cwd: string }): Promise<number> {
  const loaded = loadConfig({
    cwd: options.cwd,
    ...(flagString(args.flags, 'config') ? { configPath: flagString(args.flags, 'config')! } : {}),
    ...(flagString(args.flags, 'mode') ? { permissionMode: flagString(args.flags, 'mode')! } : {}),
  });
  if (!loaded.modelConfigured) {
    throw new ForgeError('CONFIG_INVALID', modelSetupHint({ interactive: false }));
  }

  const resumeRunId = flagString(args.flags, 'resume');
  const prompt = (args.positionals.join(' ').trim() || (resumeRunId ? '' : await readStdin())).trim();
  if (!prompt && !resumeRunId) {
    throw new ForgeError('CONFIG_INVALID', '缺少任务内容：请传入 prompt 或通过标准输入提供');
  }
  const json = flagBool(args.flags, 'json');
  const autoApprove = flagBool(args.flags, 'yes');
  const planOnly = flagBool(args.flags, 'plan');
  const useWorktree = flagBool(args.flags, 'worktree');
  if (resumeRunId && (useWorktree || planOnly)) {
    throw new ForgeError('CONFIG_INVALID', '--resume 不能与 --worktree / --plan 组合：worktree 沿用中断前的记录，不做新创建');
  }
  const interactive = Boolean(stdin.isTTY) && !json;
  const rl = interactive ? createInterface({ input: stdin, output: stderr, terminal: true }) : null;

  let approvalHandler: ApprovalHandler | undefined;
  if (autoApprove) {
    approvalHandler = () => true;
  } else if (rl) {
    approvalHandler = async (request) => {
      const preview = request.preview ? `\n  ${request.preview}` : '';
      const answer = await rl.question(`\n[审批] ${request.tool}: ${request.reason}${preview}\n批准执行？(y/N) `);
      return /^y(es)?$/i.test(answer.trim());
    };
  }

  // task_runs 有 `session_id → sessions(id)` 外键；全新数据库里若 sessions 表还不存在，
  // 插入会直接报 "no such table: main.sessions"。先让 SessionStore 把 schema 建好，
  // 这样"计划还没开始就拒绝/失败"的记录也能落库（例如脏工作区拒绝、invalid_plan）。
  // --plan 不得创建目录、建表或迁移用户数据库；用独立内存库满足统一执行路径的依赖。
  const taskDbPath = planOnly ? ':memory:' : loaded.config.session.dbPath;
  const sessionBootstrap = new SessionStore(taskDbPath);
  const store = new TaskRunStore(taskDbPath);
  const logger: Logger = createLogger({ level: 'error' });
  const configuredWorkspace = loaded.config.security.workspaceRoots[0] ?? options.cwd;

  // [P4] SIGINT/SIGTERM 中断处理：收到后持久化状态，阻止自动续跑
  let aborted = false;
  let abortReason = '';
  let runId: string | undefined;
  let runtime: ForgeRuntime | undefined;
  let worktree: ReviewWorktreeRecord | undefined;
  const taskStartedAt = Date.now();
  let priorDurationMs = 0;
  let taskMetrics = { toolCalls: 0, modelCalls: 0, totalTokens: 0 };
  const abort = new AbortController();

  const interrupt = (signal: string) => {
    aborted = true;
    abortReason = signal === 'SIGINT' ? '用户中断' : '进程终止请求';
    if (!abort.signal.aborted) abort.abort(new Error(abortReason));
    // 如果已经有 runId，立即写状态（即使 run.ts 还没走到 try 里的 createRun）
    // 也能保证不会有 planned 状态的幽灵记录
    if (runId) {
      try { store.updateRun(runId, { status: 'aborted', final_message: abortReason }); } catch { /* store 可能还没准备好 */ }
    }
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    // ==============================================================
    // [0] --worktree 预检：仓库必须干净，否则立刻拒绝（在花模型调用之前）
    // ==============================================================
    let repoState: RepoState | undefined;
    if (useWorktree && !planOnly) {
      try {
        repoState = await assertCleanRepo(options.cwd);
        if (abort.signal.aborted) throw abort.signal.reason;
      } catch (err) {
        if (aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        // 拒绝也要留痕：用户事后能查到"为什么这次没建 worktree"
        const refusedRunId = store.createRun({
          user_prompt: prompt,
          workspace: options.cwd,
          model: loaded.config.model.model,
          isolation: 'worktree',
        });
        store.updateRun(refusedRunId, { status: 'failed', exit_code: 1, final_message: message });
        emitResult({ runId: refusedRunId, worktreeError: message, isolation: 'worktree' }, json, 'failed', 1);
        return 1;
      }
    }

    // ==============================================================
    // [R] 恢复预检（--resume <runId>）：先做安全诊断，全部通过才重建执行环境。
    //     任何一步不通过都 fail closed：不重建 worktree、不猜测产物位置、不删除任何东西。
    // ==============================================================
    let resumed: { record: CheckpointRecord; summary: NonNullable<ReturnType<TaskRunStore['getRunSummary']>> } | undefined;
    if (resumeRunId) {
      runId = resumeRunId;
      const summary = store.getRunSummary(resumeRunId);
      if (!summary) {
        emitResult({ runId: resumeRunId, resumeError: `任务不存在: ${resumeRunId}` }, json, 'failed', 2);
        return 2;
      }
      priorDurationMs = summary.durationMs ?? 0;
      taskMetrics = {
        toolCalls: summary.toolCalls,
        modelCalls: summary.modelCalls,
        totalTokens: summary.totalTokens,
      };
      try {
        store.markMetricsPartial(resumeRunId);
        // A hard stop can land after the checkpoint records a step result but before
        // its task-store transaction. Reconcile those durable results before recovery
        // analysis, so completed work and its metrics are not lost or replayed.
        const runRecord = store.getRun(resumeRunId);
        const checkpointPlanId = typeof runRecord?.plan_id === 'string' ? runRecord.plan_id : undefined;
        const checkpoint = checkpointPlanId ? store.loadCheckpoint(checkpointPlanId) : null;
        if (checkpoint) {
          const persistedSteps = new Set(store.listStepResults(resumeRunId).map((step) => step.step_id));
          for (const step of checkpoint.plan.steps) {
            if (
              persistedSteps.has(step.step_id)
              || !step.result
              || (step.status !== 'completed' && step.status !== 'failed' && step.status !== 'cancelled')
            ) continue;
            const result = step.result;
            const metrics = {
              toolCalls: result.toolCallCount ?? 0,
              modelCalls: result.modelCallCount ?? 0,
              totalTokens: result.tokenUsage ?? 0,
            };
            store.recordStepExecution(resumeRunId, {
              step_id: step.step_id,
              final_status: step.status,
              attempts_used: step.attempts,
              duration_ms: result.durationMs,
              verification_passed: step.status === 'completed',
              verification_reason: step.status === 'completed' ? undefined : result.failureReason,
              tool_call_count: metrics.toolCalls,
              failure_reason: result.failureReason,
              evidence_count: step.evidence_refs.length,
              summary: result.summary,
            }, metrics);
            persistedSteps.add(step.step_id);
            taskMetrics.toolCalls += metrics.toolCalls;
            taskMetrics.modelCalls += metrics.modelCalls;
            taskMetrics.totalTokens += metrics.totalTokens;
          }
        }
        const record = await assertResumable(store, resumeRunId);
        if (summary.isolation === 'worktree') {
          // worktree 必须原样还在、归属核对通过；缺失/换根/改名 → 拒绝，不重建不删除
          await verifyWorktreeForResume(summary);
          worktree = {
            runId: resumeRunId,
            repoRoot: summary.workspace,
            root: summary.worktreeRoot!,
            path: summary.worktreePath!,
            branch: summary.worktreeBranch!,
            baseCommit: summary.baseCommit!,
          };
          loaded.config.security.workspaceRoots = [worktree.path];
          loaded.config.security.writableRoots = [worktree.path];
        }
        resumed = { record, summary };
      } catch (err) {
        if (aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        const analysis = await analyzeTaskRun(store, resumeRunId).catch((e) => ({
          message: `诊断本身失败: ${e instanceof Error ? e.message : String(e)}`,
        }));
        store.updateRun(resumeRunId, { status: 'blocked', final_message: `恢复被拒绝：${message}` });
        emitResult({ runId: resumeRunId, resumeError: message, analysis }, json, 'failed', 2);
        emitText(stderr, json, `\n✗ 恢复被拒绝：${message}\n`);
        return 2;
      }
    }

    // 计划快照从第一步起就落盘：每个步骤状态变化都会自动写 checkpoint（含 running 态），
    // 进程中断后 recovery 层才能可靠判断"停在哪、哪些可以自动继续"。
    const planManager = new PlanManager({ checkpoint: store.createCheckpointManager() } satisfies PlanManagerOptions);

    // ==============================================================
    // [1] 生成计划（只需要 provider：不传 tools，模型看不到任何工具定义）
    // ==============================================================
    let plan: TaskPlan;
    if (resumed) {
      emitText(stderr, json, `\n🔁 恢复任务 ${resumed.summary.runId}（快照时间 ${resumed.record.snapshot_at}）\n`);
      plan = planManager.restoreFromCheckpoint(resumed.record);
    } else {
      emitText(stderr, json, '🔎 正在让模型拆解任务...\n');
      // [P1 加固] 用 provider 直连模型生成计划，完全绕开 AgentLoop 和 ToolDispatcher
      const generator = new TaskPlanGenerator(createProvider(loaded.config.model, { logger }), planManager);

      try {
        const { plan: generatedPlan, adjustments, modelCallCount, tokenUsage } = await generator.generate(prompt, { signal: abort.signal });
        if (abort.signal.aborted) throw abort.signal.reason;
        plan = generatedPlan;
        taskMetrics.modelCalls += modelCallCount;
        taskMetrics.totalTokens += tokenUsage;
        if (!json && adjustments.length > 0) {
          emitText(stderr, false, `\n⚠️  已自动调整 ${adjustments.length} 个步骤的 risk_level（不信任模型的风险评估）\n`);
        }
      } catch (err) {
        if (aborted) throw err;
        // 计划生成失败（解析/校验） → 标记 invalid_plan
        if (err instanceof TaskPlanGeneratorError) {
          if (planOnly) {
            emitResult({ planError: err.message }, json, 'invalid_plan', 2);
            return 2;
          }
          runId = store.createRun({
            user_prompt: prompt,
            workspace: repoState?.repoRoot ?? configuredWorkspace,
            model: loaded.config.model.model,
            ...(useWorktree ? { isolation: 'worktree' as const } : {}),
          });
          // 立即更新为 invalid_plan，不让它停在 planned
          store.updateRun(runId, { status: 'invalid_plan', final_message: err.message });
          emitResult({ runId, planError: err.message }, json, 'invalid_plan', 2);
          return 2;
        }
        throw err;
      }
    }

    // ==============================================================
    // [2] 展示计划 / 确认
    // ==============================================================
    emitText(stderr, json, `\n📋 ${resumed ? '已恢复计划' : '计划已生成'}：${plan.steps.length} 个步骤\n\n`);
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i]!;
      const deps = s.dependencies.length > 0 ? ` [← ${s.dependencies.join(', ')}]` : '';
      emitText(stderr, json, `  ${i + 1}. [${s.status}] ${s.description}${deps} (risk=${s.risk_level})\n`);
    }

    if (planOnly) {
      // --plan 只读：不建 worktree（没有产物需要审阅）
      emitText(stderr, json, `\n✓ 计划生成完毕（--plan 模式：不执行任何写操作）\n`);
      emitResult({ plan }, json, 'planned', 0);
      return 0;
    }

    if (useWorktree && !resumed) {
      emitText(
        stderr,
        json,
        `\n🌿 --worktree：将在 ${loaded.config.worktree.root} 下创建独立工作树与分支`
          + `（只隔离工作区与改动，不是 OS 沙箱）\n`,
      );
    }
    if (resumed && worktree) {
      emitText(
        stderr,
        json,
        `\n🌿 沿用已有隔离 worktree（不重建、不移动）\n   路径: ${worktree.path}\n   分支: ${worktree.branch}\n`,
      );
    }

    if (abort.signal.aborted) throw abort.signal.reason;

    // 交互式确认：恢复是显式命令（task resume / --resume），已视为用户同意继续
    if (!resumed) {
      let userConfirmed = autoApprove;
      if (rl && !autoApprove) {
        emitText(stderr, false, '\n开始执行以上计划？(y/N) ');
        const answer = (await rl.question('')).trim();
        userConfirmed = /^y(es)?$/i.test(answer);
        if (!userConfirmed) {
          emitText(stderr, false, '\n已取消\n');
          emitResult({ plan, cancellationReason: '用户拒绝计划执行' }, json, 'aborted', 1);
          return 1;
        }
      }
      const hasApprovalGates = loaded.config.security.requireApprovalForWrite
        || loaded.config.security.requireApprovalForExecute;
      if (!autoApprove && !rl && !hasApprovalGates) {
        const reason = '非交互模式下必须显式传入 --yes 才能执行计划；当前策略未设置写入或执行审批门槛';
        emitText(stderr, json, `\n⛔ ${reason}\n`);
        emitResult({ plan, cancellationReason: reason }, json, 'aborted', 1);
        return 1;
      }
    }

    // ==============================================================
    // [3] 持久化 task run，并按需建立隔离工作区
    // ==============================================================
    if (!resumed) {
      if (abort.signal.aborted) throw abort.signal.reason;
      runId = store.createRun({
        user_prompt: prompt,
        plan_id: plan.plan_id,
        workspace: repoState?.repoRoot ?? configuredWorkspace,
        model: loaded.config.model.model,
        ...(useWorktree ? { isolation: 'worktree' as const } : {}),
        metrics: taskMetrics,
      });

      if (useWorktree) {
        try {
          worktree = await createReviewWorktree({
            repoRoot: repoState!.repoRoot,
            runId,
            root: loaded.config.worktree.root,
          });
          // 映射持久化：runId ↔ path / branch / baseCommit
          store.setWorktree(runId, {
            root: worktree.root,
            path: worktree.path,
            branch: worktree.branch,
            baseCommit: worktree.baseCommit,
          });
          // 权限、审批、审计都跟着生效工作区走：把 workspaceRoots 收窄到 worktree
          loaded.config.security.workspaceRoots = [worktree.path];
          loaded.config.security.writableRoots = [worktree.path];
          emitText(
            stderr,
            json,
            `\n🌿 已创建隔离 worktree\n   路径: ${worktree.path}\n   分支: ${worktree.branch}（基线 ${worktree.baseCommit.slice(0, 8)}）\n`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // fail closed：不回退到原目录继续执行
          store.updateRun(runId, {
            status: 'failed',
            exit_code: 1,
            final_message: `worktree 创建失败，任务未执行：${message}`,
          });
          emitResult({ runId, plan, worktreeError: message, isolation: 'worktree' }, json, 'failed', 1);
          return 1;
        }
      }
    }

    if (!runId) {
      throw new ForgeError('INTERNAL', 'runId 未初始化（内部错误）');
    }
    if (abort.signal.aborted) throw abort.signal.reason;
    // [P4] 立即更新为 running——避免进程崩溃后留下 planned 幽灵记录
    store.updateRun(runId, { status: 'running' });

    runtime = createRuntime({
      cwd: options.cwd,
      loaded,
      ...(approvalHandler ? { approvalHandler } : {}),
      ...(flagString(args.flags, 'session') ? { sessionId: flagString(args.flags, 'session')! } : {}),
    });
    store.updateRun(runId, { session_id: runtime.agent.sessionId });

    if (worktree) {
      // 审计里留下生效工作区：工具调用的相对路径都要靠这条事件才能还原成绝对位置
      await runtime.audit.record({
        type: 'session',
        sessionId: runtime.agent.sessionId,
        actor: 'system',
        reason: `隔离执行：${worktree.path}（分支 ${worktree.branch}，基线 ${worktree.baseCommit}）`,
        meta: {
          isolation: 'worktree',
          repoRoot: worktree.repoRoot,
          worktreePath: worktree.path,
          branch: worktree.branch,
          baseCommit: worktree.baseCommit,
          isOsSandbox: false,
        },
      });
    }

    // [P4] 把 process signal 转发给 StepExecutor 的 AbortController
    emitText(stderr, json, '\n🚀 开始执行计划...\n');
    const executor = new StepExecutor({
      planManager,
      agent: runtime.agent,
      signal: abort.signal,
      // 每步 Agent.run() 前注入计划上下文
      contextBuilder: (p, step) => {
        const completedSteps = p.steps.filter((s) => s.status === 'completed').map((s) => `  ✓ ${s.description}`).join('\n');
        const failedSteps = p.steps.filter((s) => s.status === 'failed').map((s) => `  ✗ ${s.description}`).join('\n');
        return `\n\n当前计划进度：\n${completedSteps || '  (无)'}\n${failedSteps || ''}\n请只执行步骤「${step.description}」，完成后自然结束回合即可。`;
      },
    });
    const planner = new TaskPlanner({ planManager, stepExecutor: executor });

    const persistStepResult = (r: StepExecResult): void => {
      const planStep = planManager.getPlan(plan.plan_id).steps.find((s) => s.step_id === r.step_id);
      const metrics = {
        toolCalls: r.execution_result?.toolCallCount ?? 0,
        modelCalls: r.execution_result?.modelCallCount ?? 0,
        totalTokens: r.execution_result?.tokenUsage ?? 0,
      };
      store.recordStepExecution(runId!, {
        step_id: r.step_id,
        final_status: r.final_status,
        attempts_used: r.attemptsUsed,
        duration_ms: r.duration_ms,
        verification_passed: r.verification_result?.passed ?? false,
        verification_reason: r.verification_result?.reason,
        tool_call_count: metrics.toolCalls,
        failure_reason: r.execution_result?.failureReason,
        evidence_count: planStep?.evidence_refs.length ?? 0,
        summary: r.execution_result?.summary,
      }, metrics);
      taskMetrics.toolCalls += metrics.toolCalls;
      taskMetrics.modelCalls += metrics.modelCalls;
      taskMetrics.totalTokens += metrics.totalTokens;
    };

    const execStart = Date.now();
    const execResult = await planner.runSingle(plan.plan_id, {
      maxSteps: plan.steps.length + 2,
      onStepResult: persistStepResult,
    });
    const execDurationMs = Date.now() - execStart;

    emitText(stderr, json, `\n✅ 执行完成：${execResult.completed}/${execResult.total_steps} 步成功，${execResult.failed} 失败，${execResult.cancelled} 取消（${execDurationMs}ms）\n`);

    // 计划未全部完成 → 不跑 QualityGate，直接标 blocked / failed
    if (execResult.plan_status !== 'completed' || execResult.failed > 0 || execResult.cancelled > 0 || execResult.truncated) {
      const status: TaskRunStatus = execResult.failed > 0 ? 'failed'
        : execResult.cancelled > 0 || execResult.plan_status === 'cancelled' ? 'aborted'
        : 'blocked';
      store.updateRun(runId, {
        status,
        duration_ms: priorDurationMs + Date.now() - taskStartedAt,
        tool_calls: taskMetrics.toolCalls,
        model_calls: taskMetrics.modelCalls,
        total_tokens: taskMetrics.totalTokens,
        final_message: status === 'failed' ? '部分步骤失败，跳过质量门禁'
          : status === 'aborted' ? '执行被取消'
          : execResult.truncated ? '预算耗尽，计划未完整执行'
          : `计划状态为 ${execResult.plan_status}，跳过质量门禁`,
      });
      emitResult(
        {
          runId,
          plan,
          execution: execResult,
          gateResult: null,
          ...(worktree ? { worktree: worktreeInfo(worktree) } : {}),
        },
        json,
        status,
        1,
      );
      return 1;
    }

    // ==============================================================
    // [5] QualityGate（cwd = 生效工作区，worktree 模式下就是隔离目录）
    // ==============================================================
    emitText(stderr, json, '\n🔍 运行质量门禁...\n');

    const gate = new ProductionQualityGate(runtime);
    const gateResult = await gate.run({
      cwd: runtime.settings.workspaceRoots[0] ?? options.cwd,
      sessionId: runtime.agent.sessionId,
      signal: abort.signal,
    });
    taskMetrics.toolCalls += gateResult.run_count;

    if (abort.signal.aborted) {
      store.updateRun(runId, {
        status: 'aborted', duration_ms: priorDurationMs + Date.now() - taskStartedAt, exit_code: 1,
        tool_calls: taskMetrics.toolCalls, model_calls: taskMetrics.modelCalls, total_tokens: taskMetrics.totalTokens,
        final_message: abortReason || '用户中断',
      });
      emitResult({ runId, plan, execution: execResult, gateResult, finalStatus: 'aborted', exitCode: 1 }, json, 'aborted', 1);
      return 1;
    }

    for (const s of gateResult.stages) {
      if (s.note) {
        emitText(stderr, json, `  ➖ ${s.name}: ${s.note}\n`);
      } else {
        emitText(stderr, json, `  ${s.passed ? '✅' : '❌'} ${s.name}: ${s.command} → exit=${s.exit_code} (${s.duration_ms}ms)${s.failure_summary ? '\n     ' + s.failure_summary.split('\n').join('\n     ') : ''}\n`);
      }
    }

    store.insertGateResult(runId, 'production', {
      passed: gateResult.verdict === 'passed',
      stages_completed: gateResult.stages.filter((s) => s.note === undefined).map((s) => s.name),
      stages_failed: gateResult.stages.filter((s) => s.note === undefined && !s.passed).map((s) => s.name),
      details_json: JSON.stringify(gateResult.stages),
      final_message: gateResult.verdict,
    });

    // ==============================================================
    // [6] 最终状态
    // ==============================================================
    const finalStatus: TaskRunStatus =
      gateResult.verdict === 'passed' ? 'completed'
      : gateResult.verdict === 'unverified' ? 'unverified'
      : 'failed';
    const exitCode = finalStatus === 'completed' ? 0 : 1;

    store.updateRun(runId, {
      status: finalStatus,
      duration_ms: priorDurationMs + Date.now() - taskStartedAt,
      tool_calls: taskMetrics.toolCalls,
      model_calls: taskMetrics.modelCalls,
      total_tokens: taskMetrics.totalTokens,
      exit_code: exitCode,
      final_message: finalStatus === 'completed' ? '任务完成，质量门禁通过' : finalStatus === 'unverified' ? '无可用测试/门禁脚本，结果未验证' : '质量门禁失败',
    });

    emitResult(
      {
        runId,
        plan,
        execution: execResult,
        gateResult,
        finalStatus,
        exitCode,
        ...(worktree ? { worktree: worktreeInfo(worktree) } : {}),
      },
      json,
      finalStatus,
      exitCode,
    );
    return exitCode;

  } catch (err) {
    if (aborted) {
      if (runId) {
        try {
          store.updateRun(runId, {
            status: 'aborted', exit_code: 1, final_message: abortReason,
            duration_ms: priorDurationMs + Date.now() - taskStartedAt,
            tool_calls: taskMetrics.toolCalls, model_calls: taskMetrics.modelCalls, total_tokens: taskMetrics.totalTokens,
          });
        } catch { /* store 可能不可用 */ }
      }
      emitResult({ ...(runId ? { runId } : {}), cancellationReason: abortReason }, json, 'aborted', 1);
      return 1;
    }
    // [P4] 异常捕获：如果 run 已经在 running 状态，标记为 failed
    if (runId) {
      try {
        const current = store.getRun(runId);
        if (current && String(current.status) === 'running') {
          store.updateRun(runId, {
            status: 'failed',
            exit_code: 1,
            duration_ms: priorDurationMs + Date.now() - taskStartedAt,
            tool_calls: taskMetrics.toolCalls,
            model_calls: taskMetrics.modelCalls,
            total_tokens: taskMetrics.totalTokens,
            final_message: err instanceof Error ? err.message : String(err),
          });
        }
      } catch { /* store 可能已 close，忽略 */ }
    }
    throw err;
  } finally {
    // [P4] 如果 aborted 但 finally 还没走到 updateRun（比如计划生成前就 SIGINT），
    //      或者执行中途 SIGINT 但 StepExecutor 还没来得及写入 aborted 状态
    if (aborted && runId) {
      try {
        const current = store.getRun(runId);
        if (current && String(current.status) === 'running') {
          store.updateRun(runId, { status: 'aborted', exit_code: 1, final_message: abortReason });
        }
      } catch { /* store 可能已 close */ }
    }
    // worktree 保留：无论成功、失败还是取消，都不在这里删除，也不合并回原工作区
    if (worktree) emitWorktreeFooter(worktree, json);
    // 只移除本次命令注册的监听器，保留宿主应用的其他 signal 处理器。
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    rl?.close();
    store.close();
    sessionBootstrap.close();
    runtime?.close();
  }
}

/* ========================================================================== */
/* 输出辅助                                                                    */
/* ========================================================================== */

interface EmitPayload {
  runId?: string;
  plan?: unknown;
  execution?: unknown;
  gateResult?: unknown;
  planError?: string;
  cancellationReason?: string;
  finalStatus?: TaskRunStatus;
  exitCode?: number;
  worktree?: { path: string; branch: string; baseCommit: string; runId: string };
  worktreeError?: string;
  resumeError?: string;
  analysis?: unknown;
  isolation?: 'in_place' | 'worktree';
}

function worktreeInfo(worktree: ReviewWorktreeRecord): NonNullable<EmitPayload['worktree']> {
  return {
    runId: worktree.runId,
    path: worktree.path,
    branch: worktree.branch,
    baseCommit: worktree.baseCommit,
  };
}

/** 产物落在哪、怎么看、怎么清——每次 worktree 运行结束都要说清楚 */
function emitWorktreeFooter(worktree: ReviewWorktreeRecord, json: boolean): void {
  if (json) return;
  stdout.write(
    [
      '',
      '📦 产物保存在隔离 worktree（未合并、未复制回原工作区、未删除）',
      `   路径: ${worktree.path}`,
      `   分支: ${worktree.branch}（基线 ${worktree.baseCommit.slice(0, 8)}）`,
      `   查看差异: forgex task diff ${worktree.runId}`,
      `   清理产物: forgex task clean ${worktree.runId}`,
      '',
    ].join('\n'),
  );
}

function emitResult(payload: EmitPayload, json: boolean, status: TaskRunStatus | 'planned' | 'invalid_plan', exitCode: number): void {
  if (json) {
    stdout.write(
      JSON.stringify(
        {
          runId: payload.runId ?? null,
          taskStatus: status,
          exitCode,
          ...payload,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    const banner =
      status === 'completed' ? '🎉 任务完成（质量门禁通过）'
      : status === 'failed' ? '❌ 任务失败'
      : status === 'blocked' ? '⚠️  任务被阻塞'
      : status === 'unverified' ? '🔎 任务执行但未验证（无可用测试脚本）'
      : status === 'aborted' ? '⏹️  任务取消'
      : status === 'invalid_plan' ? '🚫 计划生成失败'
      : '📋 计划已生成';
    stdout.write(`\n${banner}\n`);
    if (status !== 'planned' && status !== 'invalid_plan') {
      const plan = payload.plan as { steps: { description: string; step_id: string; status?: string }[] } | undefined;
      const exec = payload.execution as { completed?: number; failed?: number; cancelled?: number; total_steps?: number; results?: unknown[] } | undefined;
      if (plan && exec) {
        stdout.write(`   ${exec.completed ?? 0}/${exec.total_steps ?? plan.steps.length} 步完成，${exec.failed ?? 0} 失败，${exec.cancelled ?? 0} 取消\n`);
      }
      const gate = payload.gateResult as { verdict?: string; run_count?: number; total_count?: number } | null;
      if (gate) stdout.write(`   质量门禁: ${gate.verdict}（${gate.run_count}/${gate.total_count} 阶段）\n`);
      if (payload.worktree) stdout.write(`   隔离 worktree: ${payload.worktree.path}（分支 ${payload.worktree.branch}）\n`);
    }
    if (payload.planError) stdout.write(`   计划错误: ${payload.planError}\n`);
    if (payload.worktreeError) stdout.write(`   隔离失败: ${payload.worktreeError}\n`);
    if (payload.cancellationReason) stdout.write(`   ${payload.cancellationReason}\n`);
  }
}

function emitText(stream: NodeJS.WritableStream, json: boolean, text: string): void {
  if (!json) stream.write(text);
}

async function readStdin(): Promise<string> {
  if (stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}
