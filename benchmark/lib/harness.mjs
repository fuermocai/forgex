/**
 * ForgeX Benchmark 场景框架（v0.3.0 Phase 6）。
 *
 * 设计目标：
 *  - 确定性：每个场景在独立的临时工作区里运行，用真实工具 + 真实安全链路，
 *    不依赖任何模型调用，可重复执行、可对比历史结果；
 *  - 隔离性：每个场景一个 mkdtemp 工作区，结束即清理，互不影响；
 *  - 安全链路真实：ToolContext 使用 WorkspaceGuard + trusted 策略，
 *    与生产路径一致（trusted 模式跳过审批交互，但结构防线全部生效）。
 *
 * 场景协议：
 *   scenario = { id, name, run(env) }
 *   run 内通过 expect / expectEq / toolData / toolBlocked 断言，
 *   断言失败抛 ScenarioFailure，由 runner 记录为 fail。
 *   run 可返回 { note?, details? } 附加到结果里（用于消融对比数据）。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

/** 场景断言失败的专用错误类型（runner 据此区分断言失败与运行时异常） */
export class ScenarioFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScenarioFailure';
  }
}

/** 布尔断言 */
export function expect(cond, msg) {
  if (!cond) throw new ScenarioFailure(`断言失败: ${msg}`);
}

/** 严格相等断言（带期望值/实际值输出） */
export function expectEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new ScenarioFailure(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  }
}

/** 工具必须调用成功：返回 data；否则抛 ScenarioFailure（带工具 summary） */
export function toolData(outcome, what = '工具调用') {
  if (!outcome || typeof outcome !== 'object') {
    throw new ScenarioFailure(`${what} 返回了非法结果: ${String(outcome)}`);
  }
  if (!outcome.ok) throw new ScenarioFailure(`${what} 应成功但失败: ${outcome.summary}`);
  return outcome.data;
}

/** 工具必须被拒绝，且错误码命中给定正则（返回 error 对象供进一步断言） */
export function toolBlocked(outcome, codePattern, what = '工具调用') {
  if (!outcome || typeof outcome !== 'object') {
    throw new ScenarioFailure(`${what} 返回了非法结果: ${String(outcome)}`);
  }
  if (outcome.ok) throw new ScenarioFailure(`${what} 应被拒绝但执行成功: ${outcome.summary}`);
  const code = outcome.error?.code ?? '';
  if (!codePattern.test(code)) {
    throw new ScenarioFailure(
      `${what} 错误码不符: 期望 ${codePattern}，实际 ${code}（${outcome.error?.message ?? outcome.summary}）`,
    );
  }
  return outcome.error;
}

/**
 * 为单个场景准备独立环境：
 *   - 全新临时工作区（mkdtemp）；
 *   - trusted 策略（写/执行免审批，便于无人值守跑批；结构防线仍然生效）；
 *   - 真实 WorkspaceGuard（路径逃逸会被拒绝）。
 */
export async function makeScenarioEnv(deps) {
  const ws = await mkdtemp(join(tmpdir(), 'forgex-bench-'));
  const policy = deps.sec.createDefaultPolicySettings({
    workspaceRoots: [ws],
    mode: 'trusted',
    requireApprovalForWrite: false,
    requireApprovalForExecute: false,
    commandTimeoutMs: 15_000,
  });
  const ctx = {
    workspaceRoot: ws,
    cwd: ws,
    signal: new AbortController().signal,
    auditId: 'bench-scenario',
    workspace: new deps.sec.WorkspaceGuard({
      roots: policy.workspaceRoots,
      writableRoots: policy.writableRoots,
      protectedPaths: policy.protectedPaths,
    }),
    policy,
  };

  return {
    /** 工作区绝对路径 */
    ws,
    /** 可直接传给工具 execute 的 ToolContext */
    ctx,
    /** dist 包命名空间：tools / core / sec / shared */
    ...deps,
    expect,
    expectEq,
    toolData,
    toolBlocked,
    /** 在工作区写文件（自动创建父目录），返回绝对路径 */
    async write(rel, content) {
      const abs = join(ws, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return abs;
    },
  };
}

/**
 * 运行单个场景：独立工作区、计时、异常捕获、结束清理。
 * 不抛异常——失败也返回结果对象。
 */
export async function runScenario(suite, scenario, deps) {
  const started = performance.now();
  const env = await makeScenarioEnv(deps);
  const base = { suite, id: scenario.id, name: scenario.name };
  try {
    const extra = (await scenario.run(env)) ?? {};
    return {
      ...base,
      pass: true,
      durationMs: Number((performance.now() - started).toFixed(1)),
      ...extra,
    };
  } catch (err) {
    return {
      ...base,
      pass: false,
      durationMs: Number((performance.now() - started).toFixed(1)),
      failureKind: err instanceof ScenarioFailure ? 'assertion' : 'runtime',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(env.ws, { recursive: true, force: true }).catch(() => {});
  }
}

/** 串行运行一个套件（确定性优先，不并发） */
export async function runSuite(suite, deps, onProgress) {
  const rows = [];
  for (const scenario of suite.scenarios) {
    const row = await runScenario(suite.name, scenario, deps);
    rows.push(row);
    onProgress?.(row);
  }
  return rows;
}
