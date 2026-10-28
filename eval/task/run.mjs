#!/usr/bin/env node
/**
 * ForgeX `forgex run` 任务闭环评测入口。
 *
 * 判断标准：CLI 是否**真实完成任务**并**正确报告状态**。
 *   - 只看外部证据：文件内容、子进程退出码、SQLite task_runs/step_results/gate_results、审计 JSONL；
 *   - 不看模型自述，也不做输出文本相似度比对。
 *
 * 用法：
 *   pnpm eval:task                  # 全量离线评测（默认）
 *   pnpm eval:task -- --only T01,T05
 *   pnpm eval:task -- --ci           # CI 模式：任一红线违规或关键场景失败即退出 1
 *   pnpm eval:task -- --json         # 只输出 JSON（便于管道）
 *   pnpm eval:task -- --keep         # 保留临时工作区便于排查
 *   pnpm eval:task -- --list         # 列出场景
 *
 * 前提：先 `pnpm build`（本脚本会校验 dist 不早于源码）。
 * 真实模型 benchmark 是另一个入口（eval:task:live），默认关闭且结果分开存放。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertCliBuilt, REPO_ROOT, runScenario } from './lib/harness.mjs';
import { scenarios } from './scenarios/index.mjs';
import { buildReport, exitCodeFor, printSummary } from './lib/report.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback = null) => {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
};

const ONLY = valueOf('--only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const JSON_ONLY = has('--json');
const CI = has('--ci');
const KEEP = has('--keep');
const OUT = resolve(REPO_ROOT, valueOf('--out', join('eval', 'results', 'task-eval.json')));

if (has('--list')) {
  for (const scn of scenarios) {
    process.stdout.write(`${scn.id}  ${scn.critical === false ? '(非关键) ' : ''}${scn.name}\n`);
  }
  process.exit(0);
}

const selected = ONLY ? scenarios.filter((s) => ONLY.includes(s.id)) : scenarios;
if (selected.length === 0) {
  process.stderr.write(`没有匹配的场景：${ONLY?.join(',') ?? ''}\n`);
  process.exit(2);
}

const platform = process.platform;
const startedAt = new Date();
const results = [];

for (const scenario of selected) {
  const skipReason = scenario.skipOn?.(platform, process.version);
  if (skipReason) {
    const row = {
      id: scenario.id,
      name: scenario.name,
      tags: scenario.tags ?? [],
      critical: scenario.critical !== false,
      pass: true,
      skipped: true,
      skipReason,
      durationMs: 0,
      checks: [],
      violations: [],
    };
    results.push(row);
    if (!JSON_ONLY) process.stdout.write(`⏭  ${row.id} 跳过（${skipReason}）\n`);
    continue;
  }

  if (!JSON_ONLY) process.stdout.write(`▶  ${scenario.id} ${scenario.name} ... `);
  const row = await runScenario(scenario, { keepWorkspace: KEEP });
  results.push(row);
  if (!JSON_ONLY) {
    process.stdout.write(`${row.pass ? '通过' : '失败'}（${row.durationMs}ms）\n`);
    if (!row.pass) {
      for (const c of row.checks.filter((item) => !item.pass)) {
        const detail = Object.entries(c)
          .filter(([key]) => !['name', 'pass'].includes(key))
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(' ');
        process.stdout.write(`     ✗ ${c.name}  ${detail}\n`);
      }
      if (KEEP && row.workspace) process.stdout.write(`     工作区: ${row.workspace}\n`);
      if (KEEP && row.artifacts) process.stdout.write(`     取证目录: ${row.artifacts}\n`);
    }
  }
}

const report = buildReport({
  mode: 'offline',
  startedAt,
  results,
  environment: {
    platform,
    node: process.version,
    cliEntry: 'apps/cli/dist/main.js',
    model: 'fake-openai-compatible (127.0.0.1)',
    network: 'none',
    osSandboxVerified: false,
    osSandboxNote:
      '本套件不验证 OS 级沙箱：它只覆盖 forgex run 的任务闭环。真实 bwrap 隔离效果见 '
      + 'packages/sandbox/test/os-sandbox-linux.integration.test.ts（仅 Linux，条件不满足时跳过）。',
  },
});

mkdirSync(resolve(REPO_ROOT, 'eval', 'results'), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (JSON_ONLY) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printSummary(report, OUT);
}

const code = exitCodeFor(report);
if (CI && code !== 0) {
  process.stderr.write('\nCI 门禁失败：存在红线违规或关键场景未通过（详见上面的失败场景列表）\n');
}
process.exit(code);
