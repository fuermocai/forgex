/**
 * 工具层测试：使用真实文件系统与真实子进程，不使用 mock。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicySettings, ToolContext, ToolOutcome } from '@forgex/shared';
import { createDefaultPolicySettings, WorkspaceGuard } from '@forgex/security';
import {
  createBuiltinTools,
  createEditFileTool,
  createGrepSearchTool,
  createInspectMemoryTool,
  createListDirectoryTool,
  createReadFileTool,
  createReadLogsTool,
  createRunCommandTool,
  ToolRegistry,
} from '../src/index.js';

let root: string;
let settings: PolicySettings;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forgex-tools-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'logs'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const answer = 42;\n// 中文注释\n', 'utf8');
  await writeFile(join(root, 'README.md'), '# Demo\n', 'utf8');
  await writeFile(join(root, 'logs', 'app.log'), ['boot', 'start', 'warn: slow', 'error: boom', 'exit'].join('\n'), 'utf8');
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

describe('ToolRegistry', () => {
  it('注册内置工具并生成 JSON Schema', () => {
    const registry = new ToolRegistry();
    registry.registerAll(createBuiltinTools());
    expect(registry.names()).toEqual(
      expect.arrayContaining([
        'read_file',
        'edit_file',
        'grep_search',
        'git_status',
        'git_diff',
        'inspect_port',
        'inspect_memory',
        'read_logs',
        'run_command',
      ]),
    );
    const spec = registry.specs().find((item) => item.function.name === 'read_file');
    expect(spec?.function.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
  });

  it('拒绝重复注册与非法名称', () => {
    const registry = new ToolRegistry();
    const tool = createReadFileTool();
    registry.register(tool as never);
    expect(() => registry.register(tool as never)).toThrowError(/重复注册/);
    expect(() =>
      registry.register({ ...tool, name: 'Bad-Name' } as never),
    ).toThrowError(/工具名不合法/);
  });

  it('参数校验失败时返回结构化错误', () => {
    const registry = new ToolRegistry();
    const tool = createReadFileTool();
    registry.register(tool as never);
    const result = registry.parseInput(registry.require('read_file'), { offset: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOOL_INVALID_INPUT');
  });
});

describe('read_file', () => {
  it('读取文件内容与行范围', async () => {
    const outcome = expectOk(await createReadFileTool().execute({ path: 'src/a.ts' }, makeCtx()));
    expect(outcome.data).toMatchObject({
      path: 'src/a.ts',
      startLine: 1,
      endLine: 2,
      totalLines: 2,
    });
    expect((outcome.data as { content: string }).content).toContain('answer = 42');
  });

  it('拒绝路径穿越', async () => {
    const outcome = await createReadFileTool().execute({ path: '../secret.txt' }, makeCtx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('WORKSPACE_ESCAPE');
  });
});

describe('edit_file', () => {
  it('执行替换并返回 unified diff', async () => {
    const outcome = expectOk(
      await createEditFileTool().execute(
        { path: 'src/a.ts', oldText: 'answer = 42', newText: 'answer = 43', replaceAll: false },
        makeCtx(),
      ),
    );
    expect(outcome.data).toMatchObject({ changed: true, added: 1, removed: 1 });
    expect((outcome.data as { diff: string }).diff).toContain('+export const answer = 43;');
    const after = expectOk(await createReadFileTool().execute({ path: 'src/a.ts' }, makeCtx()));
    expect((after.data as { content: string }).content).toContain('answer = 43');
  });

  it('oldText 不存在时返回明确错误', async () => {
    const outcome = await createEditFileTool().execute(
      { path: 'src/a.ts', oldText: 'not-present', newText: 'x', replaceAll: false },
      makeCtx(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('TOOL_FAILED');
  });
});

describe('list_directory / grep_search / read_logs', () => {
  it('列出目录项', async () => {
    const outcome = expectOk(await createListDirectoryTool().execute({ path: '.', depth: 2, includeHidden: false, limit: 100 }, makeCtx()));
    const entries = (outcome.data as { entries: Array<{ path: string }> }).entries;
    expect(entries.some((entry) => entry.path === 'src/')).toBe(true);
    expect(entries.some((entry) => entry.path === 'src/a.ts')).toBe(true);
  });

  it('搜索代码（ripgrep 或降级实现）', async () => {
    const outcome = expectOk(
      await createGrepSearchTool().execute(
        { pattern: 'answer = 42', path: '.', caseSensitive: true, maxResults: 10 },
        makeCtx(),
      ),
    );
    const data = outcome.data as { matches: Array<{ path: string; line: number }>; engine: string };
    expect(data.matches.length).toBeGreaterThan(0);
    expect(data.matches[0]).toMatchObject({ path: 'src/a.ts', line: 1 });
  });

  it('读取日志尾部', async () => {
    const outcome = expectOk(await createReadLogsTool().execute({ path: 'logs/app.log', lines: 2 }, makeCtx()));
    expect((outcome.data as { content: string }).content).toBe('error: boom\nexit');
    expect(outcome.truncated).toBe(true);
  });
});

describe('run_command', () => {
  it('执行真实子进程并返回输出', async () => {
    const script = join(root, 'hello.mjs');
    await writeFile(script, "console.log('forgex-ok');\nconsole.error('warn-line');\n", 'utf8');
    const outcome = expectOk(
      await createRunCommandTool().execute(
        { program: process.execPath, args: [script], cwd: '.', timeoutMs: 10_000 },
        makeCtx(),
      ),
    );
    const data = outcome.data as { stdout: string; stderr: string; exitCode: number };
    expect(data.stdout).toContain('forgex-ok');
    expect(data.stderr).toContain('warn-line');
    expect(data.exitCode).toBe(0);
  });

  it('拒绝 shell 与解释器内联代码', async () => {
    const shell = await createRunCommandTool().execute(
      { program: 'bash', args: ['-c', 'echo hi'], cwd: '.', timeoutMs: 5000 },
      makeCtx(),
    );
    expect(shell.ok).toBe(false);
    if (!shell.ok) expect(shell.error.code).toBe('COMMAND_BLOCKED');

    const inline = await createRunCommandTool().execute(
      { program: 'node', args: ['-e', 'console.log(1)'], cwd: '.', timeoutMs: 5000 },
      makeCtx(),
    );
    expect(inline.ok).toBe(false);
    if (!inline.ok) expect(inline.error.code).toBe('COMMAND_BLOCKED');
  });

  it('超时会终止进程并返回 TOOL_TIMEOUT', async () => {
    const script = join(root, 'sleep.mjs');
    await writeFile(script, 'setTimeout(() => {}, 30000);\n', 'utf8');
    const outcome = await createRunCommandTool().execute(
      { program: process.execPath, args: [script], cwd: '.', timeoutMs: 1000 },
      makeCtx(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('TOOL_TIMEOUT');
  }, 15_000);
});

describe('inspect_memory', () => {
  it('返回真实内存数据', async () => {
    const outcome = expectOk(await createInspectMemoryTool().execute({}, makeCtx()));
    expect((outcome.data as { totalBytes: number }).totalBytes).toBeGreaterThan(0);
  }, 20_000);
});
