/**
 * hybrid_search 工具集成测试（真实文件系统 + WorkspaceGuard 全链路）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicySettings, ToolContext, ToolOutcome } from '@forgex/shared';
import { createDefaultPolicySettings, WorkspaceGuard } from '@forgex/security';
import { createBuiltinTools, createHybridSearchTool, ToolRegistry } from '../src/index.js';

let root: string;
let settings: PolicySettings;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forgex-hybrid-tool-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'src', 'pay.ts'),
    [
      'export function processPayment(amount: number) {',
      '  return chargeCard(amount);',
      '}',
    ].join('\n'),
    'utf8',
  );
  settings = createDefaultPolicySettings({
    workspaceRoots: [root],
    mode: 'trusted',
    requireApprovalForWrite: false,
    commandTimeoutMs: 20_000,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
  return {
    workspaceRoot: root,
    cwd: root,
    signal: new AbortController().signal,
    auditId: 'audit-test',
    workspace: new WorkspaceGuard({ roots: [root], writableRoots: [root], protectedPaths: ['.git'] }),
    policy: settings,
  };
}

function expectOk(outcome: ToolOutcome): Extract<ToolOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望成功，实际失败: ${outcome.summary}`);
  return outcome;
}

describe('hybrid_search 工具', () => {
  it('已注册到内置工具集', () => {
    const registry = new ToolRegistry();
    registry.registerAll(createBuiltinTools());
    expect(registry.has('hybrid_search')).toBe(true);
  });

  it('end-to-end：自然语言查询命中真实文件', async () => {
    const tool = createHybridSearchTool();
    const outcome = expectOk(
      await tool.execute(
        { query: 'processPayment', path: '.', maxPerLayer: 20, maxResults: 30, caseSensitive: false },
        makeCtx(),
      ),
    );
    const data = outcome.data as { hits: Array<{ path: string; symbol?: string }>; layerStats: { keyword: { enabled: boolean } } };
    expect(data.hits.length).toBeGreaterThan(0);
    expect(data.hits.some((h) => h.path === 'src/pay.ts')).toBe(true);
    expect(data.hits.some((h) => h.symbol === 'processPayment')).toBe(true);
    expect(data.layerStats.keyword.enabled).toBe(true);
  });

  it('拒绝工作区外的路径', async () => {
    const tool = createHybridSearchTool();
    const outcome = await tool.execute(
      { query: 'anything', path: '..', maxPerLayer: 20, maxResults: 30, caseSensitive: false },
      makeCtx(),
    );
    expect(outcome.ok).toBe(false);
  });

  it('空查询被 Zod 拦截（schema 层 min(1)）', () => {
    const tool = createHybridSearchTool();
    const parsed = tool.parameters.safeParse({ query: '', path: '.', maxPerLayer: 20, maxResults: 30, caseSensitive: false });
    expect(parsed.success).toBe(false);
  });

  it('layers 参数限定检索层', async () => {
    const tool = createHybridSearchTool();
    const outcome = expectOk(
      await tool.execute(
        { query: 'processPayment', path: '.', layers: ['keyword'], maxPerLayer: 20, maxResults: 30, caseSensitive: false },
        makeCtx(),
      ),
    );
    const data = outcome.data as { layerStats: { structure: { enabled: boolean }; semantic: { enabled: boolean } } };
    expect(data.layerStats.structure.enabled).toBe(false);
    expect(data.layerStats.semantic.enabled).toBe(false);
  });
});
