/**
 * ProductionQualityGate：连接 CLI 主链的确定性质量门禁（v0.5.0 加固）。
 *
 * 关键修复（v0.5.0 → v0.5.1 对照 run-command.ts 的真实 Zod schema）：
 *   ✅ [P2 参数修复] 传入 { program, args, cwd, timeoutMs }，不再传 shell 命令字符串 { command, timeout }
 *      - 旧代码：{ command: "pnpm.cmd run test", timeout: 300_000 } → Zod schema 校验会失败
 *      - 新代码：{ program: "pnpm.cmd", args: ["run", "test"], cwd, timeoutMs: 60_000 } → 正确
 *   ✅ [P2 cwd 不强制覆盖] 构造器不再悄悄固定 cwd；run({ cwd }) 使用传入的 cwd
 *   ✅ [P2 强制 pnpm.cmd / npm.cmd] Windows 平台必须用 .cmd 后缀（PowerShell 执行策略）
 *   ✅ [P2 全链路 ToolDispatcher] 不独立 child_process；所有执行走 dispatcher.execute() → approval/audit/policy
 *
 * 其他设计：
 *   - 优先发现 package.json scripts（test/test:ci/vitest、typecheck/tsc/check-types、build/compile）；
 *   - 找不到测试脚本 → unverified（构建/类型检查不能替代测试）；
 *   - 找到的检查脚本全部通过且包含测试 → passed；任一已发现脚本失败 → failed；
 *   - 记录：实际 program+args、退出码、截断、失败摘要。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDispatcher } from '@forgex/core';
import type { ForgeRuntime } from '../runtime/create-runtime.js';

export interface QGStageResult {
  name: string;
  /** program + args 人类可读形式 */
  command: string;
  passed: boolean;
  exit_code: number | null;
  duration_ms: number;
  truncated: boolean;
  failure_summary?: string;
  /** 脚本不存在或无 package.json 等跳过原因 */
  note?: string;
}

export interface QGResult {
  verdict: 'passed' | 'failed' | 'unverified';
  stages: QGStageResult[];
  run_count: number;
  total_count: number;
}

interface StageDef { name: string; scriptNames: readonly string[] }

const DEFAULT_STAGES: readonly StageDef[] = [
  { name: 'tests', scriptNames: ['test', 'test:ci', 'vitest'] },
  { name: 'typecheck', scriptNames: ['typecheck', 'tsc', 'check-types'] },
  { name: 'build', scriptNames: ['build', 'compile'] },
];

export interface RunOptions {
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  skip?: ReadonlySet<string>;
}

export class ProductionQualityGate {
  private readonly dispatcher: ToolDispatcher;

  constructor(runtime: ForgeRuntime) {
    this.dispatcher = runtime.agent.dispatcher;
  }

  async run(options: RunOptions): Promise<QGResult> {
    const stages: QGStageResult[] = [];
    let runCount = 0;
    let hasTestScript = false;

    for (const stage of DEFAULT_STAGES) {
      if (options.signal.aborted) break;
      if (options.skip?.has(stage.name)) continue;
      const r = await this.runStage(stage.name, stage.scriptNames, options.cwd, options.sessionId, options.signal);
      stages.push(r);
      if (r.note === undefined) {
        runCount++;
        if (stage.name === 'tests') hasTestScript = true;
      }
    }

    const anyFailed = stages.some((s) => s.note === undefined && !s.passed);
    const allPassed = runCount > 0 && stages.filter((s) => s.note === undefined).every((s) => s.passed);
    // 构建或类型检查通过不能替代测试：没有可运行的测试脚本时，禁止把任务标记为 completed。
    const verdict: QGResult['verdict'] = anyFailed ? 'failed' : !hasTestScript ? 'unverified' : allPassed ? 'passed' : 'failed';

    return { verdict, stages, run_count: runCount, total_count: stages.length };
  }

  private async runStage(
    name: string,
    scriptNames: readonly string[],
    cwd: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<QGStageResult> {
    const pkgJsonPath = join(cwd, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      return { name, command: '', passed: false, exit_code: null, duration_ms: 0, truncated: false, note: '项目无 package.json' };
    }
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return { name, command: '', passed: false, exit_code: null, duration_ms: 0, truncated: false, note: 'package.json 解析失败' };
    }
    const scripts = pkg.scripts as Record<string, unknown> | undefined;
    if (!scripts) {
      return { name, command: '', passed: false, exit_code: null, duration_ms: 0, truncated: false, note: '无 scripts 字段' };
    }

    const matchedScript = scriptNames.find((n) => typeof scripts[n] === 'string');
    if (!matchedScript) {
      return { name, command: '', passed: false, exit_code: null, duration_ms: 0, truncated: false, note: `未找到 ${scriptNames.join('/')} 脚本` };
    }

    // 用 pnpm 如果仓库里有 pnpm-lock.yaml，否则 npm
    const hasPnpm = existsSync(join(cwd, 'pnpm-lock.yaml'));
    // Windows 必须用 .cmd 后缀（PowerShell 执行策略 + 无 shim fallback）
    const isWin32 = process.platform === 'win32';
    const baseProgram = hasPnpm ? 'pnpm' : 'npm';
    const program = isWin32 ? `${baseProgram}.cmd` : baseProgram;
    const args = hasPnpm ? ['run', matchedScript] : ['run', matchedScript];
    const command = `${program} ${args.join(' ')}`;

    const started = Date.now();
    const call = {
      id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function' as const,
      function: {
        name: 'run_command',
        // 正确 Zod schema：program + args[] + cwd + timeoutMs
        arguments: JSON.stringify({
          program,
          args,
          cwd,
          timeoutMs: 60_000, // 单阶段 60s 上限（ToolDispatcher 策略上限通常 300s）
        }),
      },
    };
    const result = await this.dispatcher.execute(call, { sessionId, signal });
    const durationMs = Date.now() - started;

    let exitCode: number | null = null;
    let failureSummary: string | undefined;
    let truncated = false;

    if (result.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
      const d = result.data as Record<string, unknown>;
      exitCode = typeof d.code === 'number' ? d.code : typeof d.exitCode === 'number' ? d.exitCode : null;
      truncated = typeof d.truncated === 'boolean' ? d.truncated : Boolean(result.truncated);
      if (exitCode !== 0) {
        const out = typeof d.stdout === 'string' ? d.stdout : typeof d.stderr === 'string' ? d.stderr : typeof d.output === 'string' ? d.output : '';
        failureSummary = out.split('\n').filter((l) => l.trim().length > 0).slice(-8).join('\n').slice(0, 500);
      }
    } else if (!result.ok) {
      failureSummary = result.error?.message ?? '工具调用被拒绝或失败';
    }

    const passed = exitCode === 0 && result.ok;
    return { name, command, passed, exit_code: exitCode, duration_ms: durationMs, truncated, failure_summary: failureSummary };
  }
}
