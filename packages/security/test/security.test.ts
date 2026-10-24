/**
 * Security 层单元测试。
 *
 * 覆盖：
 *  - 四种权限模式 × 风险等级矩阵；
 *  - 受保护路径与程序黑名单；
 *  - 路径穿越、符号链接逃逸、写入越权；
 *  - shell / 解释器内联代码 / 命令包装器的拒绝；
 *  - 审批在非交互、拒绝、批准、超时四种情况下的行为；
 *  - 审计脱敏与 sink 失败隔离。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ApprovalRequest, PolicySettings } from '@forgex/shared';
import {
  ApprovalManager,
  AuditLogger,
  CommandGuard,
  JsonlFileSink,
  MemoryAuditSink,
  PolicyEngine,
  WorkspaceGuard,
  createDefaultPolicySettings,
  isInside,
  type AuditSink,
} from '../src/index.js';

const policy = new PolicyEngine();

function settingsWith(overrides: Partial<PolicySettings> = {}): PolicySettings {
  return {
    ...createDefaultPolicySettings({ workspaceRoots: [process.cwd()], mode: 'standard' }),
    ...overrides,
  };
}

describe('PolicyEngine 权限模式矩阵', () => {
  it('readonly：只允许只读', () => {
    const s = settingsWith({ mode: 'readonly' });
    expect(policy.evaluate({ tool: 'read_file', riskLevel: 'read', settings: s }).decision).toBe('allow');
    expect(policy.evaluate({ tool: 'edit_file', riskLevel: 'write', settings: s }).decision).toBe('deny');
    expect(policy.evaluate({ tool: 'run_command', riskLevel: 'execute', settings: s }).decision).toBe('deny');
    expect(policy.evaluate({ tool: 'x', riskLevel: 'privileged', settings: s }).decision).toBe('deny');
  });

  it('standard：写入/执行需要审批，高权限拒绝', () => {
    const s = settingsWith({ mode: 'standard' });
    expect(policy.evaluate({ tool: 'read_file', riskLevel: 'read', settings: s }).decision).toBe('allow');
    expect(policy.evaluate({ tool: 'edit_file', riskLevel: 'write', settings: s }).decision).toBe('ask');
    expect(policy.evaluate({ tool: 'run_command', riskLevel: 'execute', settings: s }).decision).toBe('ask');
    expect(policy.evaluate({ tool: 'x', riskLevel: 'privileged', settings: s }).decision).toBe('deny');
  });

  it('standard 且关闭写入审批时直接放行（用户显式配置）', () => {
    const s = settingsWith({ mode: 'standard', requireApprovalForWrite: false });
    expect(policy.evaluate({ tool: 'edit_file', riskLevel: 'write', settings: s }).decision).toBe('allow');
  });

  it('trusted：写入放行，执行与高权限仍需审批', () => {
    const s = settingsWith({ mode: 'trusted' });
    expect(policy.evaluate({ tool: 'edit_file', riskLevel: 'write', settings: s }).decision).toBe('allow');
    expect(policy.evaluate({ tool: 'run_command', riskLevel: 'execute', settings: s }).decision).toBe('ask');
    expect(policy.evaluate({ tool: 'x', riskLevel: 'privileged', settings: s }).decision).toBe('ask');
  });

  it('yolo：全部放行但保留规则名用于审计', () => {
    const s = settingsWith({ mode: 'yolo' });
    const result = policy.evaluate({ tool: 'x', riskLevel: 'privileged', settings: s });
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('mode_yolo');
  });
});

describe('PolicyEngine 路径与程序规则', () => {
  it('写入受保护路径被拒绝', () => {
    const s = settingsWith();
    const result = policy.evaluate({
      tool: 'edit_file',
      riskLevel: 'write',
      facts: { paths: ['src/../.git/config'] },
      settings: s,
    });
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('protected_path');
  });

  it('受保护规则按路径片段匹配，不会误伤 .gitignore', () => {
    const s = settingsWith();
    expect(
      policy.evaluate({ tool: 'edit_file', riskLevel: 'write', facts: { paths: ['.gitignore'] }, settings: s }).decision,
    ).toBe('ask');
  });

  it('高危程序无条件拒绝，即使 yolo 模式', () => {
    const s = settingsWith({ mode: 'yolo' });
    const result = policy.evaluate({
      tool: 'run_command',
      riskLevel: 'execute',
      facts: { program: 'rm', args: ['-rf', 'build'] },
      settings: s,
    });
    expect(result.decision).toBe('deny');
    expect(['hard_denied_program', 'denied_arg_pattern', 'destructive_recursive_delete']).toContain(result.rule);
  });

  it('高危参数模式被拒绝', () => {
    const s = settingsWith();
    const result = policy.evaluate({
      tool: 'run_command',
      riskLevel: 'execute',
      facts: { program: 'git', args: ['clean', '--no-preserve-root'] },
      settings: s,
    });
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('denied_arg_pattern');
  });

  it('白名单未命中降级为 ask 而不是 deny', () => {
    const s = settingsWith({ allowedPrograms: ['git'] });
    expect(
      policy.evaluate({ tool: 'run_command', riskLevel: 'execute', facts: { program: 'git', args: ['status'] }, settings: s })
        .decision,
    ).toBe('ask');
    expect(
      policy.evaluate({ tool: 'run_command', riskLevel: 'execute', facts: { program: 'cargo', args: ['test'] }, settings: s })
        .decision,
    ).toBe('ask');
  });
});

describe('CommandGuard 结构防线', () => {
  const guard = new CommandGuard();
  const s = settingsWith({ mode: 'trusted', requireApprovalForExecute: false });

  it('拒绝交互式 shell', () => {
    expect(guard.check({ program: 'bash', args: [] }, s).rule).toBe('shell_interpreter');
    expect(guard.check({ program: 'cmd', args: ['/c', 'dir'] }, s).rule).toBe('shell_interpreter');
    expect(guard.check({ program: 'pwsh', args: [] }, s).rule).toBe('shell_interpreter');
  });

  it('拒绝解释器内联代码', () => {
    expect(guard.check({ program: 'node', args: ['-e', 'console.log(1)'] }, s).rule).toBe('inline_code_execution');
    expect(guard.check({ program: 'python', args: ['-c', 'print(1)'] }, s).rule).toBe('inline_code_execution');
    expect(guard.check({ program: 'node', args: ['script.js'] }, s).decision).toBe('allow');
  });

  it('拒绝命令包装器与 find -exec', () => {
    expect(guard.check({ program: 'env', args: ['rm', '-rf', '.'] }, s).rule).toBe('command_wrapper');
    expect(guard.check({ program: 'find', args: ['.', '-exec', 'rm', '{}', ';'] }, s).rule).toBe('find_exec');
  });

  it('拒绝程序名注入与参数换行', () => {
    expect(guard.check({ program: 'git;rm', args: [] }, s).rule).toBe('illegal_program_chars');
    expect(guard.check({ program: 'git', args: ['status\nrm -rf /'] }, s).rule).toBe('control_chars_in_args');
  });

  it('拒绝递归强制删除的各种等价写法', () => {
    const variants = [
      ['-rf', 'build'],
      ['-r', '-f', 'build'],
      ['-f', '-r', 'build'],
      ['-Rf', 'build'],
      ['-fR', 'build'],
      ['--recursive', '--force', 'build'],
    ];
    for (const args of variants) {
      expect(guard.check({ program: 'rm', args }, s).rule).toBe('destructive_recursive_delete');
    }
  });

  it('拒绝 Windows 递归删除、find -delete 与 git clean -fdx', () => {
    expect(guard.check({ program: 'rmdir', args: ['/s', '/q', 'build'] }, s).rule).toBe(
      'destructive_recursive_delete',
    );
    expect(guard.check({ program: 'del', args: ['/s', '/q', 'build'] }, s).rule).toBe(
      'destructive_recursive_delete',
    );
    expect(guard.check({ program: 'find', args: ['.', '-delete'] }, s).rule).toBe('destructive_find_delete');
    expect(guard.check({ program: 'git', args: ['clean', '-fdx'] }, s).rule).toBe('destructive_git_clean');
    expect(guard.check({ program: 'git', args: ['clean', '-n'] }, s).decision).toBe('allow');
  });

  it('硬拒绝磁盘级操作，且兼容 .com 程序名', () => {
    expect(guard.check({ program: 'dd', args: ['if=/dev/zero', 'of=/dev/sda'] }, s).rule).toBe(
      'hard_denied_program',
    );
    expect(guard.check({ program: 'C:\\Windows\\System32\\format.com', args: ['C:'] }, s).rule).toBe(
      'hard_denied_program',
    );
  });

  it('正常命令在 trusted 下放行', () => {
    expect(guard.check({ program: 'git', args: ['status', '--short'] }, s).decision).toBe('allow');
  });
});

describe('WorkspaceGuard 文件边界', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forgex-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'forgex-out-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function guard(): WorkspaceGuard {
    return new WorkspaceGuard({ roots: [root], protectedPaths: ['.git', '.forgex'] });
  }

  it('允许读取工作区内文件', async () => {
    const resolved = await guard().resolve('src/a.ts', 'read');
    expect(isInside(resolve(root), resolved)).toBe(true);
  });

  it('拒绝 ../ 路径穿越', async () => {
    await expect(guard().resolve('../outside.txt', 'read')).rejects.toMatchObject({ code: 'WORKSPACE_ESCAPE' });
  });

  it('拒绝绝对路径越界', async () => {
    await expect(guard().resolve(join(outside, 'x.txt'), 'write')).rejects.toMatchObject({
      code: 'WORKSPACE_ESCAPE',
    });
  });

  it('拒绝符号链接逃逸', async () => {
    const link = join(root, 'escape');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(guard().resolve('escape/secret.txt', 'read')).rejects.toMatchObject({
      code: 'WORKSPACE_ESCAPE',
    });
  });

  it('允许新建工作区内文件，拒绝写入受保护目录', async () => {
    const g = guard();
    const target = await g.resolve('src/new.ts', 'write');
    expect(target.endsWith('new.ts')).toBe(true);
    await expect(g.resolve('.git/config', 'write')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('允许在 .git 内只读（诊断场景）', async () => {
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await expect(guard().resolve('.git/HEAD', 'read')).resolves.toContain('HEAD');
  });
});

describe('ApprovalManager', () => {
  const request: ApprovalRequest = {
    id: 'a1',
    tool: 'run_command',
    riskLevel: 'execute',
    reason: '执行命令',
    input: { program: 'git', args: ['status'] },
  };

  it('非交互环境自动拒绝', async () => {
    await expect(new ApprovalManager().request(request)).resolves.toBe('denied');
  });

  it('用户批准 / 拒绝', async () => {
    await expect(new ApprovalManager({ handler: () => true }).request(request)).resolves.toBe('approved');
    await expect(new ApprovalManager({ handler: () => false }).request(request)).resolves.toBe('denied');
  });

  it('回调抛错按拒绝处理', async () => {
    const manager = new ApprovalManager({
      handler: () => {
        throw new Error('boom');
      },
    });
    await expect(manager.request(request)).resolves.toBe('denied');
  });

  it('超时返回 timeout', async () => {
    const manager = new ApprovalManager({
      handler: () => new Promise<boolean>(() => {}),
      timeoutMs: 50,
    });
    await expect(manager.request(request)).resolves.toBe('timeout');
  });

  it('取消信号按拒绝处理', async () => {
    const controller = new AbortController();
    const manager = new ApprovalManager({
      handler: () => new Promise<boolean>(() => {}),
    });
    const pending = manager.request(request, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe('denied');
  });
});

describe('AuditLogger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'forgex-audit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('写入内存 sink 并脱敏敏感字段', async () => {
    const sink = new MemoryAuditSink();
    const audit = new AuditLogger({ sinks: [sink] });
    const id = await audit.record({
      type: 'tool_call',
      tool: 'run_command',
      input: { program: 'git', apiKey: 'sk-abcdefgh12345678' },
      actor: 'agent',
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(sink.all).toHaveLength(1);
    const event = sink.all[0]!;
    expect((event.input as Record<string, unknown>).apiKey).toBe('***');
  });

  it('JSONL 文件 sink 追加写入', async () => {
    const file = join(dir, 'nested', 'audit.jsonl');
    const audit = new AuditLogger({ sinks: [new JsonlFileSink(file)] });
    await audit.record({ type: 'session', reason: 'start' });
    await audit.record({ type: 'session', reason: 'end' });
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'session', reason: 'start' });
  });

  it('sink 失败不会抛出，且不影响其他 sink', async () => {
    const failing: AuditSink = {
      write: () => {
        throw new Error('disk full');
      },
    };
    const memory = new MemoryAuditSink();
    const audit = new AuditLogger({ sinks: [failing, memory] });
    await expect(audit.record({ type: 'error', reason: 'x' })).resolves.toBeTruthy();
    expect(memory.all).toHaveLength(1);
  });
});
