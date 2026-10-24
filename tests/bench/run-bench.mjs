#!/usr/bin/env node
/**
 * ForgeX 可重复 Benchmark。
 *
 * 目标（对应需求「性能设计」第 10 条）：
 *  - 用相同任务、相同工具、相同假模型，测量不同版本的完成率与延迟；
 *  - 结果落盘为 JSON，可与历史结果对比；
 *  - 全程离线：本地 HTTP 假模型 + 真实工具 + 真实 SQLite(:memory:)。
 *
 * 运行前提：先 `pnpm build`。
 * 用法：
 *   pnpm bench
 *   pnpm bench -- --tasks 30 --compare .forgex/bench/results/xxx.json
 */
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = process.cwd();
const DISTS = ['packages/shared', 'packages/models', 'packages/security', 'packages/tools', 'packages/core'];

for (const pkg of DISTS) {
  if (!existsSync(join(ROOT, pkg, 'dist', 'index.js'))) {
    console.error(`缺少 ${pkg}/dist，请先运行 pnpm build`);
    process.exit(1);
  }
}

const loadDist = (pkg) => import(pathToFileURL(join(ROOT, pkg, 'dist', 'index.js')).href);

const { Agent, ContextManager, SessionStore } = await loadDist('packages/core');
const { createProvider } = await loadDist('packages/models');
const {
  ApprovalManager,
  AuditLogger,
  MemoryAuditSink,
  WorkspaceGuard,
  createDefaultPolicySettings,
} = await loadDist('packages/security');
const { ToolRegistry, createBuiltinTools } = await loadDist('packages/tools');
const { validateMessageProtocol, estimateTokens } = await loadDist('packages/shared');

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

const TASKS = Number(argValue('--tasks', '20'));
const COMPARE = argValue('--compare', null);
const OUT_DIR = resolve(ROOT, argValue('--out-dir', join('.forgex', 'bench', 'results')));

/* ------------------------------------------------------------------ */
/* 假模型                                                              */
/* ------------------------------------------------------------------ */

const requests = [];

function startFakeModel() {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      const toolMessages = (body.messages ?? []).filter((message) => message.role === 'tool');
      const system = (body.messages ?? []).find((message) => message.role === 'system');
      const isDiagnosis = (system?.content ?? '').includes('BENCH_MODE=diagnosis');
      const portMatch = /BENCH_PORT=(\d+)/.exec(system?.content ?? '');
      const targetPort = portMatch ? Number(portMatch[1]) : 54321;

      let message;
      let finish = 'stop';
      if (toolMessages.length === 0) {
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${requests.length}`,
              type: 'function',
              function: isDiagnosis
                ? { name: 'inspect_port', arguments: JSON.stringify({ port: targetPort }) }
                : { name: 'read_file', arguments: JSON.stringify({ path: 'bench-target.ts' }) },
            },
          ],
        };
        finish = 'tool_calls';
      } else {
        const content = toolMessages[toolMessages.length - 1].content ?? '';
        if (isDiagnosis) {
          message = {
            role: 'assistant',
            content: content.includes('"found":false') ? 'DIAG_OK：端口未监听' : 'DIAG_BAD：证据不符',
          };
        } else {
          message = {
            role: 'assistant',
            content: content.includes('BENCH_MARKER') ? 'BENCH_OK：已读取目标文件' : 'BENCH_BAD：内容缺失',
          };
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-bench',
          object: 'chat.completion',
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        }),
      );
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveP({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

async function runTask({ baseUrl, workspace, mode, index, port }) {
  const store = new SessionStore(':memory:');
  const audit = new AuditLogger({ sinks: [new MemoryAuditSink(100)] });
  const settings = createDefaultPolicySettings({
    workspaceRoots: [workspace],
    mode: 'standard',
    requireApprovalForWrite: false,
    requireApprovalForExecute: false,
  });
  const provider = createProvider({
    baseUrl,
    model: 'bench-model',
    contextWindow: 8192,
    maxOutputTokens: 1024,
    temperature: 0,
    timeoutMs: 10_000,
    maxRetries: 0,
    stream: false,
  });
  const agent = new Agent({
    provider,
    registry: new ToolRegistry(createBuiltinTools()),
    settings,
    workspace: new WorkspaceGuard({
      roots: settings.workspaceRoots,
      writableRoots: settings.writableRoots,
      protectedPaths: settings.protectedPaths,
    }),
    approvals: new ApprovalManager({ timeoutMs: 1000 }),
    audit,
    store,
    cwd: workspace,
    systemPrompt: `BENCH_MODE=${mode}\nBENCH_PORT=${port}\n你是基准测试代理。`,
  });

  const started = performance.now();
  try {
    const result = await agent.run(mode === 'diagnosis' ? `检查 ${port} 端口为什么不可用` : '读取 bench-target.ts 并确认标记');
    const durationMs = performance.now() - started;
    const expected = mode === 'diagnosis' ? 'DIAG_OK' : 'BENCH_OK';
    const success = result.reason === 'completed' && result.text.includes(expected);
    const protocol = validateMessageProtocol(store.getMessages(result.sessionId));
    return {
      index,
      mode,
      success,
      durationMs,
      protocolValid: protocol.length === 0,
      reason: result.reason,
      toolCalls: result.toolCalls,
      tokens: result.metrics.totalTokens,
      toolMs: result.metrics.toolMs,
      modelMs: result.metrics.modelMs,
    };
  } finally {
    store.close();
  }
}

/** 申请一个当前空闲的 TCP 端口，然后立即释放（用于可验证的端口诊断） */
function freeTcpPort() {
  return new Promise((resolveP, rejectP) => {
    const server = createTcpServer();
    server.once('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolveP(port));
    });
  });
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(rows) {
  const durations = rows.map((row) => row.durationMs);
  const successes = rows.filter((row) => row.success).length;
  return {
    count: rows.length,
    successRate: rows.length === 0 ? 0 : successes / rows.length,
    protocolValidRate: rows.length === 0 ? 0 : rows.filter((row) => row.protocolValid).length / rows.length,
    p50Ms: Number(percentile(durations, 50).toFixed(1)),
    p95Ms: Number(percentile(durations, 95).toFixed(1)),
    meanMs: Number((durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)).toFixed(1)),
    avgTokens: Number((rows.reduce((sum, row) => sum + row.tokens, 0) / Math.max(1, rows.length)).toFixed(1)),
    avgToolMs: Number((rows.reduce((sum, row) => sum + row.toolMs, 0) / Math.max(1, rows.length)).toFixed(1)),
    avgModelMs: Number((rows.reduce((sum, row) => sum + row.modelMs, 0) / Math.max(1, rows.length)).toFixed(1)),
  };
}

/* ------------------------------------------------------------------ */
/* 上下文压缩基准                                                      */
/* ------------------------------------------------------------------ */

function contextBench() {
  const manager = new ContextManager({
    systemPrompt: '你是基准测试代理',
    contextWindow: 4096,
    maxOutputTokens: 512,
    safetyMarginTokens: 0,
  });
  const toolOutput = '日志行 '.repeat(120);
  for (let i = 0; i < 60; i += 1) {
    manager.append({ role: 'user', content: `问题 ${i}：分析日志` });
    manager.append({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c_${i}`, type: 'function', function: { name: 'read_logs', arguments: '{}' } }],
    });
    manager.append({ role: 'tool', tool_call_id: `c_${i}`, name: 'read_logs', content: toolOutput });
    manager.append({ role: 'assistant', content: `结论 ${i}：${'分析'.repeat(80)}` });
  }
  manager.append({ role: 'user', content: '最后一个问题' });

  const runs = 20;
  const started = performance.now();
  let built;
  for (let i = 0; i < runs; i += 1) built = manager.build();
  const totalMs = performance.now() - started;

  return {
    runs,
    avgMs: Number((totalMs / runs).toFixed(2)),
    compressed: built.compressed,
    finalMessages: built.messages.length,
    finalTokens: built.estimatedTokens,
    protocolValid: validateMessageProtocol(built.messages).length === 0,
  };
}

function tokenBench() {
  const text = '中文日志内容以及 English log lines. '.repeat(20_000);
  const started = performance.now();
  const tokens = estimateTokens(text);
  const durationMs = performance.now() - started;
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    tokens,
    ms: Number(durationMs.toFixed(1)),
    mbPerSec: Number(((Buffer.byteLength(text, 'utf8') / 1024 / 1024 / (durationMs / 1000)) || 0).toFixed(1)),
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

if (!Number.isFinite(TASKS) || TASKS < 1) {
  console.error('--tasks 必须是正整数');
  process.exit(1);
}

const workspace = await mkdtemp(join(tmpdir(), 'forgex-bench-'));
await writeFile(join(workspace, 'bench-target.ts'), '// BENCH_MARKER\nexport const value = 1;\n', 'utf8');

const fake = await startFakeModel();
const results = { coding: [], diagnosis: [] };

try {
  for (let i = 0; i < TASKS; i += 1) {
    results.coding.push(await runTask({ baseUrl: fake.baseUrl, workspace, mode: 'coding', index: i, port: 0 }));
  }
  const diagnosisCount = Math.max(1, Math.floor(TASKS / 2));
  for (let i = 0; i < diagnosisCount; i += 1) {
    // 每个任务使用一个刚释放的空闲端口，确保诊断结论可验证
    const port = await freeTcpPort();
    results.diagnosis.push(await runTask({ baseUrl: fake.baseUrl, workspace, mode: 'diagnosis', index: i, port }));
  }
} finally {
  fake.server.closeAllConnections?.();
  fake.server.close();
  await rm(workspace, { recursive: true, force: true });
}

const report = {
  timestamp: new Date().toISOString(),
  version: '0.1.0',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  tasks: TASKS,
  coding: { summary: summarize(results.coding), rows: results.coding },
  diagnosis: { summary: summarize(results.diagnosis), rows: results.diagnosis },
  context: contextBench(),
  tokenEstimation: tokenBench(),
  modelRequests: requests.length,
};

await mkdir(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `${report.timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('ForgeX Benchmark');
console.log(`  编码任务:      ${formatSummary(report.coding.summary)}`);
console.log(`  诊断任务:      ${formatSummary(report.diagnosis.summary)}`);
console.log(
  `  上下文压缩:    平均 ${report.context.avgMs}ms/次，压缩后 ${report.context.finalMessages} 条消息 / ${report.context.finalTokens} tokens，协议合法=${report.context.protocolValid}`,
);
console.log(`  Token 估算:    ${report.tokenEstimation.mbPerSec} MB/s（${report.tokenEstimation.ms}ms）`);
console.log(`  结果已保存:    ${outPath}`);

if (COMPARE) {
  try {
    const previous = JSON.parse(await readFile(resolve(ROOT, COMPARE), 'utf8'));
    compareReports(previous, report);
  } catch (err) {
    console.error(`无法读取对比文件: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const failed =
  report.coding.summary.successRate < 1 ||
  report.diagnosis.summary.successRate < 1 ||
  report.coding.summary.protocolValidRate < 1 ||
  report.diagnosis.summary.protocolValidRate < 1 ||
  !report.context.protocolValid;
process.exit(failed ? 1 : 0);

function formatSummary(summary) {
  return `完成率 ${(summary.successRate * 100).toFixed(1)}% | p50 ${summary.p50Ms}ms | p95 ${summary.p95Ms}ms | tokens/任务 ${summary.avgTokens}`;
}

function compareReports(previous, current) {
  console.log('\n与历史结果对比（负值表示变快/变少）：');
  const rows = [
    ['编码完成率', previous.coding.summary.successRate, current.coding.summary.successRate],
    ['编码 p50(ms)', previous.coding.summary.p50Ms, current.coding.summary.p50Ms],
    ['编码 p95(ms)', previous.coding.summary.p95Ms, current.coding.summary.p95Ms],
    ['编码 tokens', previous.coding.summary.avgTokens, current.coding.summary.avgTokens],
    ['诊断完成率', previous.diagnosis.summary.successRate, current.diagnosis.summary.successRate],
    ['诊断 p95(ms)', previous.diagnosis.summary.p95Ms, current.diagnosis.summary.p95Ms],
    ['压缩耗时(ms)', previous.context.avgMs, current.context.avgMs],
  ];
  for (const [name, before, after] of rows) {
    const delta = before === 0 ? 0 : ((after - before) / before) * 100;
    console.log(`  ${name}: ${before} -> ${after} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`);
  }
}
