#!/usr/bin/env node
/**
 * 可选：真实模型 benchmark（默认关闭，与确定性离线评测完全分开）。
 *
 * 为什么单独一个入口：
 *   - 离线套件（pnpm eval:task）必须可重复、可离线、结果稳定，不能掺入模型随机性；
 *   - 这里跑的是真实模型，结果受模型能力/网络影响，只能作为能力参考；
 *   - 输出写到 eval/results/task-eval-live.json，schema 中的 mode 固定为 "live"。
 *
 * 开启方式（必须显式）：
 *   FORGEX_EVAL_LIVE=1 pnpm eval:task:live -- --config ~/.forgex/config.json
 *   或 FORGEX_EVAL_LIVE=1 FORGEX_BASE_URL=... FORGEX_MODEL=... FORGEX_API_KEY=... pnpm eval:task:live
 *
 * 判定标准与离线一致：只看真实文件与退出码，不看模型自述。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertCliBuilt, REPO_ROOT, runScenario } from './lib/harness.mjs';
import { buildReport, printSummary } from './lib/report.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback = null) => {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1] ?? fallback;
};

if (process.env.FORGEX_EVAL_LIVE !== '1') {
  process.stderr.write(
    '真实模型 benchmark 默认关闭。\n'
    + '如确需运行：FORGEX_EVAL_LIVE=1 pnpm eval:task:live -- --config <path/to/forgex.config.json>\n',
  );
  process.exit(2);
}

const liveModel = readLiveModel();
assertCliBuilt();

const MATH_BUGGY = `function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n`;
const TEST_ADD = `const assert = require('node:assert');\nconst { add } = require('./src/math.js');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('tests passed');\n`;

const LIVE_SCENARIOS = [
  {
    id: 'L01',
    name: '真实模型：修复单文件 bug 并让测试通过',
    tags: ['live'],
    critical: true,
    prompt: 'src/math.js 里的 add 实现有 bug，请修复它并确保 test.js 通过。',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    packageJson: {
      name: 'forgex-live-fixture',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    cliArgs: ['--yes'],
    cliTimeoutMs: 300_000,
    expect: {},
    async verify(ctx) {
      // 独立跑一次测试：这才是"任务是否真的完成"的证据
      const result = spawnSync(process.execPath, ['test.js'], { cwd: ctx.ws, encoding: 'utf8' });
      const status = ctx.json?.taskStatus ?? null;
      return [
        {
          name: '测试真实通过（不依赖模型自述）',
          pass: result.status === 0,
          actual: { exitCode: result.status, stdout: (result.stdout ?? '').slice(0, 120) },
        },
        {
          name: '若报告 completed，则测试必须确实通过',
          pass: status !== 'completed' || result.status === 0,
          actual: { status, testExit: result.status },
        },
        {
          name: '任务状态带明确结论',
          pass: typeof status === 'string' && status.length > 0,
          actual: status,
        },
      ];
    },
  },
  {
    id: 'L02',
    name: '真实模型：没有门禁的项目必须报 unverified',
    tags: ['live'],
    critical: true,
    prompt: '给这个项目加一个 greet.js，导出一个返回 "hello" 的函数。',
    packageJson: null,
    files: { 'README.md': '# demo\n' },
    cliArgs: ['--yes'],
    cliTimeoutMs: 300_000,
    expect: {},
    async verify(ctx) {
      const status = ctx.json?.taskStatus ?? null;
      return [
        {
          name: '无门禁时不得报告 completed',
          pass: status !== 'completed',
          actual: status,
        },
        {
          name: '结论是 unverified 或显式失败',
          pass: status === 'unverified' || status === 'failed',
          actual: status,
        },
      ];
    },
  },
];

const startedAt = new Date();
const results = [];
for (const scenario of LIVE_SCENARIOS) {
  process.stdout.write(`▶  ${scenario.id} ${scenario.name} ... `);
  const row = await runScenario(scenario, { liveModel });
  results.push(row);
  process.stdout.write(`${row.pass ? '通过' : '失败'}（${row.durationMs}ms）\n`);
  if (!row.pass) {
    for (const c of row.checks.filter((item) => !item.pass)) {
      process.stdout.write(`     ✗ ${c.name} ${JSON.stringify(c.actual ?? '')}\n`);
    }
  }
}

const report = buildReport({
  mode: 'live',
  startedAt,
  results,
  environment: {
    platform: process.platform,
    node: process.version,
    cliEntry: 'apps/cli/dist/main.js',
    model: `${liveModel.model} @ ${liveModel.baseUrl}`,
    network: 'required',
    osSandboxVerified: false,
    osSandboxNote: '真实模型结果仅作能力参考，不与离线确定性评测混用；OS 沙箱不在此验证。',
  },
});

const out = resolve(REPO_ROOT, valueOf('--out', join('eval', 'results', 'task-eval-live.json')));
mkdirSync(resolve(REPO_ROOT, 'eval', 'results'), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
printSummary(report, out);
process.exit(results.some((r) => !r.pass) ? 1 : 0);

/* ------------------------------------------------------------------ */

function readLiveModel() {
  const configPath = valueOf('--config');
  if (configPath) {
    const path = resolve(configPath);
    if (!existsSync(path)) {
      process.stderr.write(`配置文件不存在: ${path}\n`);
      process.exit(2);
    }
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const model = raw.model ?? {};
    if (!model.baseUrl || !model.model) {
      process.stderr.write('配置缺少 model.baseUrl 或 model.model\n');
      process.exit(2);
    }
    const apiKey = model.apiKeyEnv ? process.env[model.apiKeyEnv] : model.apiKey;
    return {
      baseUrl: model.baseUrl,
      model: model.model,
      ...(apiKey ? { apiKey } : {}),
      ...(model.apiKeyEnv ? { apiKeyEnv: model.apiKeyEnv } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    };
  }
  const baseUrl = process.env.FORGEX_BASE_URL;
  const model = process.env.FORGEX_MODEL;
  if (!baseUrl || !model) {
    process.stderr.write('需要 --config <file>，或 FORGEX_BASE_URL + FORGEX_MODEL（可选 FORGEX_API_KEY）\n');
    process.exit(2);
  }
  return {
    baseUrl,
    model,
    ...(process.env.FORGEX_API_KEY ? { apiKey: process.env.FORGEX_API_KEY } : {}),
  };
}
