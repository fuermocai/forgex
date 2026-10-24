#!/usr/bin/env node
/**
 * ForgeX 确定性 Benchmark 主入口（v0.3.0 Phase 6）。
 *
 * 与 tests/bench/run-bench.mjs 的区别：
 *   旧 bench 用"假模型 + AgentLoop"测量端到端完成率与延迟；
 *   本 benchmark 不走任何模型调用——65 个确定性场景直接断言真实工具与
 *   核心模块的行为（Coding 20 / DevOps 20 / 安全对抗 10 / 恢复 10 / 消融 5），
 *   用于回归防线：任何模块行为退化都会让对应场景失败。
 *
 * 运行前提：先 `pnpm build`。
 * 用法：
 *   pnpm benchmark                          # 跑全部套件
 *   node benchmark/run-benchmark.mjs --suites coding,security
 *   node benchmark/run-benchmark.mjs --compare benchmark/results/<旧文件>.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { runSuite } from './lib/harness.mjs';
import { suite as coding } from './scenarios/coding.mjs';
import { suite as devops } from './scenarios/devops.mjs';
import { suite as security } from './scenarios/security.mjs';
import { suite as recovery } from './scenarios/recovery.mjs';
import { suite as ablation } from './scenarios/ablation.mjs';
import { suite as v05 } from './scenarios/v05-phase1-6.mjs';

const ROOT = process.cwd();
const ALL_SUITES = [coding, devops, security, recovery, ablation, v05];

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

const SUITE_FILTER = argValue('--suites', null)
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const COMPARE = argValue('--compare', null);
const OUT_DIR = resolve(ROOT, argValue('--out-dir', join('benchmark', 'results')));

/* ------------------------------------------------------------------ */
/* 加载 dist（必须先 pnpm build）                                       */
/* ------------------------------------------------------------------ */

const DISTS = [
  'packages/shared', 'packages/security', 'packages/tools', 'packages/devops', 'packages/core',
  'packages/requirement-engine', 'packages/autonomous', 'packages/quality-gate', 'packages/orchestrator',
  'packages/models',
];
for (const pkg of DISTS) {
  if (!existsSync(join(ROOT, pkg, 'dist', 'index.js'))) {
    console.error(`缺少 ${pkg}/dist，请先运行 pnpm build`);
    process.exit(1);
  }
}
const loadDist = (pkg) => import(pathToFileURL(join(ROOT, pkg, 'dist', 'index.js')).href);

const deps = {
  shared: await loadDist('packages/shared'),
  sec: await loadDist('packages/security'),
  tools: await loadDist('packages/tools'),
  core: await loadDist('packages/core'),
  req: await loadDist('packages/requirement-engine'),
  auto: await loadDist('packages/autonomous'),
  qg: await loadDist('packages/quality-gate'),
  orch: await loadDist('packages/orchestrator'),
  models: await loadDist('packages/models'),
};

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const suites = SUITE_FILTER ? ALL_SUITES.filter((s) => SUITE_FILTER.includes(s.name)) : ALL_SUITES;
if (suites.length === 0) {
  console.error(`没有匹配的套件。可用: ${ALL_SUITES.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

const started = performance.now();
const rows = [];
for (const suite of suites) {
  const suiteRows = await runSuite(suite, deps, (row) => {
    const mark = row.pass ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${row.id} ${row.name} (${row.durationMs}ms)${row.error ? ` — ${row.error}` : ''}`);
  });
  rows.push(...suiteRows);
}
const totalMs = Number((performance.now() - started).toFixed(1));

const suiteSummaries = suites.map((suite) => {
  const suiteRows = rows.filter((row) => row.suite === suite.name);
  const passed = suiteRows.filter((row) => row.pass).length;
  return { name: suite.name, total: suiteRows.length, passed, failed: suiteRows.length - passed };
});

const passed = rows.filter((row) => row.pass).length;
const report = {
  timestamp: new Date().toISOString(),
  benchmarkVersion: '0.3.0',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  summary: {
    total: rows.length,
    passed,
    failed: rows.length - passed,
    passRate: rows.length === 0 ? 0 : Number((passed / rows.length).toFixed(4)),
    durationMs: totalMs,
  },
  suites: suiteSummaries,
  scenarios: rows,
};

await mkdir(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `${report.timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('\nForgeX Benchmark（确定性场景，无模型调用）');
for (const s of suiteSummaries) {
  console.log(`  ${s.name.padEnd(10)} ${s.passed}/${s.total} 通过`);
}
console.log(
  `  总计       ${passed}/${rows.length} 通过（${(report.summary.passRate * 100).toFixed(1)}%），用时 ${totalMs}ms`,
);
console.log(`  结果已保存: ${outPath}`);

if (COMPARE) {
  try {
    const previous = JSON.parse(await readFile(resolve(ROOT, COMPARE), 'utf8'));
    console.log('\n与历史结果对比：');
    console.log(`  通过率: ${(previous.summary.passRate * 100).toFixed(1)}% -> ${(report.summary.passRate * 100).toFixed(1)}%`);
    console.log(`  总耗时: ${previous.summary.durationMs}ms -> ${report.summary.durationMs}ms`);
    // 找出从通过变成失败的场景（行为退化检测）
    const prevPass = new Set(previous.scenarios.filter((r) => r.pass).map((r) => r.id));
    const regressions = rows.filter((row) => !row.pass && prevPass.has(row.id));
    if (regressions.length > 0) {
      console.log(`  行为退化场景: ${regressions.map((r) => r.id).join(', ')}`);
    } else {
      console.log('  无行为退化场景');
    }
  } catch (err) {
    console.error(`无法读取对比文件: ${err instanceof Error ? err.message : String(err)}`);
  }
}

process.exit(report.summary.failed > 0 ? 1 : 0);
