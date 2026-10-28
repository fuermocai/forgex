/**
 * Sandbox Manager 测试（v0.4.0 Phase 2；v0.5.5 能力一致性加固）。
 *
 * 测试策略：
 *   - bwrap 相关用例全部通过**可注入的 lookup + runner** 在单元层面验证，
 *     不依赖本机是否装了 bubblewrap；
 *   - 真实 Linux 集成验证见 `os-sandbox-linux.integration.test.ts`（CI 无 bwrap 时跳过）；
 *   - 无法在 Windows/macOS 上证明真实隔离效果，这里证明的是**路由与 fail-closed 逻辑**。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { WorkspaceGuard } from '@forgex/security';
import { ForgeError } from '@forgex/shared';
import { detectCapabilities, describeCapabilityReport } from '../src/manager/capability-detector.js';
import { TempDirProvider } from '../src/providers/temp-dir-provider.js';
import { GitWorktreeProvider } from '../src/providers/git-worktree-provider.js';
import {
  OsSandboxProvider,
  detectBwrapSetupError,
} from '../src/providers/os-sandbox-provider.js';
import {
  buildBubblewrapPlan,
  type BwrapLookup,
  type SandboxRunner,
  type SandboxRunnerResult,
  type SandboxRunnerSpec,
} from '../src/providers/bubblewrap.js';
import { SandboxManager } from '../src/manager/sandbox-manager.js';

let tempWorkspace: string;

beforeEach(async () => {
  tempWorkspace = await mkdtemp(join(tmpdir(), 'forgex-sandbox-test-'));
});

afterEach(async () => {
  await rm(tempWorkspace, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 测试替身                                                            */
/* ------------------------------------------------------------------ */

/** 记录调用的假执行器；handler 决定每次返回什么 */
class RecordingRunner implements SandboxRunner {
  readonly kind = 'fake-runner';
  readonly calls: SandboxRunnerSpec[] = [];

  constructor(
    private readonly handler: (spec: SandboxRunnerSpec) => Partial<SandboxRunnerResult> = () => ({}),
  ) {}

  async run(spec: SandboxRunnerSpec): Promise<SandboxRunnerResult> {
    this.calls.push(spec);
    const patch = this.handler(spec);
    return {
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      durationMs: 1,
      program: spec.program,
      ...patch,
    };
  }
}

const FOUND_BWRAP: BwrapLookup = { found: true, path: '/usr/bin/bwrap', reason: '' };
const MISSING_BWRAP: BwrapLookup = {
  found: false,
  path: null,
  reason: '未找到 bubblewrap（bwrap）可执行文件',
};

/** 构造一个"Linux + 有 bwrap + 探针通过"的 provider */
function linuxProviderWithBwrap(runner: SandboxRunner) {
  return new OsSandboxProvider({
    platform: 'linux',
    lookupBwrap: () => FOUND_BWRAP,
    runner,
    probeWorkDir: tempWorkspace,
    // 单元测试在任意平台跑：用当前 node 可执行文件代替 /bin/true 作为探针目标
    probeProgram: process.execPath,
    probeTimeoutMs: 1000,
  });
}

/* ------------------------------------------------------------------ */
/* CapabilityDetector                                                  */
/* ------------------------------------------------------------------ */

describe('CapabilityDetector', () => {
  it('报告包含每项能力的隔离类别（禁止把工作区隔离说成 OS 沙箱）', async () => {
    const report = await detectCapabilities(tempWorkspace);

    for (const cap of [report.rustExecutor, report.git, report.tempDir, report.osSandbox]) {
      expect(typeof cap.available).toBe('boolean');
      expect(typeof cap.verified).toBe('boolean');
      expect(typeof cap.reason).toBe('string');
      expect(typeof cap.category).toBe('string');
    }

    expect(report.tempDir.category).toBe('workspace_isolation');
    expect(report.git.category).toBe('workspace_isolation');
    expect(report.rustExecutor.category).toBe('resource_limits');
    expect(report.osSandbox.category).toBe('os_isolation');
  });

  it('临时目录可用，且不参与 untrusted 放行判断', async () => {
    const report = await detectCapabilities(tempWorkspace);
    expect(report.tempDir.available).toBe(true);
    expect(report.anyAvailable).toBe(true);
    // 有工作区隔离 ≠ 可以跑不可信代码
    expect(report.untrustedExecution.allowed).toBe(report.osSandbox.available);
  });

  it('无 OS 沙箱时 untrustedExecution 明确拒绝并给出原因', async () => {
    const runner = new RecordingRunner();
    const provider = new OsSandboxProvider({
      platform: 'win32',
      lookupBwrap: () => FOUND_BWRAP,
      runner,
      probeWorkDir: tempWorkspace,
    });
    const report = await detectCapabilities(tempWorkspace, { osSandboxProvider: provider });

    expect(report.osSandbox.available).toBe(false);
    expect(report.osSandbox.verified).toBe(false);
    expect(report.osSandbox.reason.length).toBeGreaterThan(0);
    expect(report.untrustedExecution.allowed).toBe(false);
    expect(report.untrustedExecution.reason).toMatch(/拒绝/);
    // 平台不支持时绝不应尝试启动 bwrap
    expect(runner.calls).toHaveLength(0);
  });

  it('describeCapabilityReport 分层展示，且不把 temp_dir 当 OS 沙箱', async () => {
    const report = await detectCapabilities(tempWorkspace);
    const text = describeCapabilityReport(report).join('\n');

    expect(text).toContain('工作区隔离');
    expect(text).toContain('资源限制');
    expect(text).toContain('OS 级隔离');
    expect(text).toContain('Git worktree');
    expect(text).toMatch(/不可信代码执行: (允许|拒绝)/);
  });

  it('bwrap 存在且探针通过时才报告 os_sandbox 可用', async () => {
    const runner = new RecordingRunner(() => ({ code: 0 }));
    const provider = linuxProviderWithBwrap(runner);
    const report = await detectCapabilities(tempWorkspace, { osSandboxProvider: provider });

    expect(report.osSandbox.available).toBe(true);
    expect(report.osSandbox.verified).toBe(true);
    expect(report.osSandbox.details?.mechanism).toBe('bubblewrap');
    expect(report.untrustedExecution.allowed).toBe(true);
    // 探针必须真的通过 bwrap 启动
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.program).toBe('/usr/bin/bwrap');
  });

  it('回归：逻辑上"检测到 bwrap"但执行链没有调用 bwrap → 必须报告不可用', async () => {
    // 模拟能力检测只看二进制的旧实现：runner 实际启动的是目标程序而不是 bwrap
    const runner = new RecordingRunner(() => ({ code: 0, program: '/bin/true' }));
    const provider = linuxProviderWithBwrap(runner);

    const available = await provider.isAvailable();
    expect(available).toBe(false);

    const status = await provider.status();
    expect(status.reason).toMatch(/没有真正调用 bwrap/);
    expect(status.details.execution_integrated).toBe('false');

    const report = await detectCapabilities(tempWorkspace, { osSandboxProvider: provider });
    expect(report.osSandbox.available).toBe(false);
    expect(report.untrustedExecution.allowed).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* TempDirProvider                                                     */
/* ------------------------------------------------------------------ */

describe('TempDirProvider', () => {
  it('create 返回存在且可写的工作目录', async () => {
    const provider = new TempDirProvider();
    const sandbox = await provider.create({ workspaceRoot: tempWorkspace });

    expect(sandbox.type).toBe('temp_dir');
    expect(existsSync(sandbox.workDir)).toBe(true);
    expect(sandbox.destroyed).toBe(false);
  });

  it('工作目录在授权工作区内', async () => {
    const provider = new TempDirProvider();
    const sandbox = await provider.create({ workspaceRoot: tempWorkspace });
    expect(sandbox.workDir.startsWith(tempWorkspace)).toBe(true);
  });

  it('destroy 后工作目录被删除，且幂等', async () => {
    const provider = new TempDirProvider();
    const sandbox = await provider.create({ workspaceRoot: tempWorkspace });
    expect(existsSync(sandbox.workDir)).toBe(true);

    await provider.destroy(sandbox);
    expect(existsSync(sandbox.workDir)).toBe(false);
    expect(sandbox.destroyed).toBe(true);

    await provider.destroy(sandbox); // 第二次不抛错
  });
});

/* ------------------------------------------------------------------ */
/* OsSandboxProvider                                                   */
/* ------------------------------------------------------------------ */

describe('OsSandboxProvider — 能力判定', () => {
  it('非 Linux 平台：不可用、不探测、拒绝执行', async () => {
    const runner = new RecordingRunner();
    const provider = new OsSandboxProvider({
      platform: 'darwin',
      lookupBwrap: () => FOUND_BWRAP,
      runner,
      probeWorkDir: tempWorkspace,
    });

    expect(await provider.isAvailable()).toBe(false);
    const status = await provider.status();
    expect(status.mechanism).toBeNull();
    expect(status.reason).toMatch(/darwin/);

    await expect(provider.requestUntrustedExecution()).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    });
    await expect(
      provider.execUntrusted({ program: 'echo', args: ['hi'] }, { workDir: tempWorkspace }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(runner.calls).toHaveLength(0);
  });

  it('缺少 bwrap 二进制：不可用', async () => {
    const runner = new RecordingRunner();
    const provider = new OsSandboxProvider({
      platform: 'linux',
      lookupBwrap: () => MISSING_BWRAP,
      runner,
      probeWorkDir: tempWorkspace,
    });

    expect(await provider.isAvailable()).toBe(false);
    expect((await provider.status()).reason).toContain('未找到 bubblewrap');
    expect(runner.calls).toHaveLength(0);
  });

  it('bwrap 存在但内核不允许创建命名空间（权限不足）→ 不可用', async () => {
    const runner = new RecordingRunner(() => ({
      code: 1,
      stderr: 'bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces',
    }));
    const provider = linuxProviderWithBwrap(runner);

    expect(await provider.isAvailable()).toBe(false);
    const status = await provider.status();
    expect(status.reason).toMatch(/bwrap 无法创建沙箱/);
    expect(status.reason).toMatch(/No permissions/);
    expect(status.details.execution_integrated).toBe('false');
  });

  it('探针本身 spawn 失败（执行器缺失等）→ 不可用', async () => {
    const runner = new RecordingRunner(() => ({
      code: null,
      spawnError: 'spawn /usr/bin/bwrap EACCES',
    }));
    const provider = linuxProviderWithBwrap(runner);

    expect(await provider.isAvailable()).toBe(false);
    expect((await provider.status()).reason).toMatch(/启动失败/);
  });

  it('探针超时 → 不可用', async () => {
    const runner = new RecordingRunner(() => ({ code: null, timedOut: true }));
    const provider = linuxProviderWithBwrap(runner);
    expect(await provider.isAvailable()).toBe(false);
    expect((await provider.status()).reason).toMatch(/超时/);
  });

  it('探针结果缓存；refresh 会重新探测', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const runner = new RecordingRunner(() =>
      mode === 'ok' ? { code: 0 } : { code: 1, stderr: 'bwrap: setup failed' },
    );
    const provider = linuxProviderWithBwrap(runner);

    expect(await provider.isAvailable()).toBe(true);
    expect(await provider.isAvailable()).toBe(true);
    expect(runner.calls).toHaveLength(1);

    mode = 'fail';
    expect((await provider.status({ refresh: true })).available).toBe(false);
    expect(runner.calls).toHaveLength(2);
  });

  it('create() 不会返回伪装成 OS 沙箱的空壳', async () => {
    const provider = linuxProviderWithBwrap(new RecordingRunner());
    await expect(provider.create({ workspaceRoot: tempWorkspace })).rejects.toMatchObject({
      code: 'SANDBOX_CREATE_FAILED',
    });
  });
});

describe('OsSandboxProvider — 执行链', () => {
  it('真正通过 bwrap 启动目标程序，并返回带溯源标记的结果', async () => {
    const runner = new RecordingRunner(() => ({ code: 0, stdout: 'hello\n' }));
    const provider = linuxProviderWithBwrap(runner);
    const workDir = tempWorkspace;

    const result = await provider.execUntrusted(
      { program: 'echo', args: ['hello'] },
      { workDir },
    );

    expect(result.isolation).toBe('os_sandbox');
    expect(result.mechanism).toBe('bubblewrap');
    expect(result.bwrapPath).toBe('/usr/bin/bwrap');
    expect(result.program).toBe('/usr/bin/bwrap');
    expect(result.stdout).toBe('hello\n');

    // 业务执行必须与探针走同一构造器：检查关键参数
    const exec = runner.calls[1]!;
    expect(exec.program).toBe('/usr/bin/bwrap');
    expect(exec.args).toContain('--unshare-all');
    expect(exec.args).toContain('--die-with-parent');
    expect(exec.args).toContain('--clearenv');
    expect(exec.args).not.toContain('--share-net'); // 默认断网
    expect(exec.args).toContain('--ro-bind-try');
    expect(exec.args).toContain('--bind');
    expect(exec.args.join(' ')).toContain(`--bind ${workDir} ${workDir}`);
    expect(exec.args.join(' ')).toContain(`--chdir ${workDir}`);
    // `--` 之后才是目标程序，避免 program 以 '-' 开头被当成 bwrap 选项
    const sep = exec.args.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(exec.args.slice(sep + 1)).toEqual(['echo', 'hello']);
    // 目标程序在沙箱内的 cwd 与可写根一致
    expect(exec.cwd).toBe(workDir);
  });

  it('allowNetwork:true 才会加 --share-net', async () => {
    const runner = new RecordingRunner();
    const provider = linuxProviderWithBwrap(runner);

    await provider.execUntrusted(
      { program: 'curl', args: ['https://example.com'] },
      { workDir: tempWorkspace, allowNetwork: true },
    );

    expect(runner.calls[1]!.args).toContain('--share-net');
  });

  it('环境变量只以 --setenv 注入，不接受非法变量名', async () => {
    const runner = new RecordingRunner();
    const provider = linuxProviderWithBwrap(runner);

    await provider.execUntrusted(
      { program: 'env', args: [], env: { FOO: 'bar', 'BAD-NAME': 'x' } },
      { workDir: tempWorkspace },
    );

    const argv = runner.calls[1]!.args;
    expect(argv.join(' ')).toContain('--setenv FOO bar');
    expect(argv.join(' ')).not.toContain('BAD-NAME');
  });

  it('拒绝把文件系统根作为可写目录', async () => {
    const provider = linuxProviderWithBwrap(new RecordingRunner());
    await expect(
      provider.execUntrusted({ program: 'ls', args: [] }, { workDir: '/' }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });

  it('拒绝 cwd 落在可写目录之外', async () => {
    const provider = linuxProviderWithBwrap(new RecordingRunner());
    await expect(
      provider.execUntrusted(
        { program: 'ls', args: [], cwd: join(tempWorkspace, '..') },
        { workDir: tempWorkspace },
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });

  it('可写目录不存在 → 拒绝', async () => {
    const provider = linuxProviderWithBwrap(new RecordingRunner());
    await expect(
      provider.execUntrusted(
        { program: 'ls', args: [] },
        { workDir: join(tempWorkspace, 'not-exists') },
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });

  it('执行时 runner 没有调用 bwrap → 拒绝，不把结果当已隔离', async () => {
    const runner = new RecordingRunner(() => ({ code: 0, program: 'echo' }));
    const provider = linuxProviderWithBwrap(runner);

    await expect(
      provider.execUntrusted({ program: 'echo', args: ['x'] }, { workDir: tempWorkspace }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });

  it('bwrap 启动失败（spawnError）→ SANDBOX_CREATE_FAILED，不回退裸跑', async () => {
    const runner = new RecordingRunner((spec) =>
      spec.program === '/usr/bin/bwrap' && spec.auditTag === 'sandbox-untrusted'
        ? { code: null, spawnError: 'spawn bwrap EACCES' }
        : { code: 0 },
    );
    const provider = linuxProviderWithBwrap(runner);

    const error = await provider
      .execUntrusted({ program: 'echo', args: ['x'] }, { workDir: tempWorkspace })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ForgeError);
    expect((error as ForgeError).code).toBe('SANDBOX_CREATE_FAILED');
    expect((error as ForgeError).message).toMatch(/拒绝在未隔离状态下执行/);
    // 只调用了一次（就是那次失败的 bwrap），没有第二次裸跑
    expect(runner.calls).toHaveLength(2); // 1 次探针 + 1 次执行
  });

  it('bwrap 自身报错（命名空间/挂载失败）→ SANDBOX_CREATE_FAILED', async () => {
    const runner = new RecordingRunner((spec) =>
      spec.auditTag === 'sandbox-untrusted'
        ? { code: 1, stderr: 'bwrap: Can\'t mount proc on /proc: Operation not permitted' }
        : { code: 0 },
    );
    const provider = linuxProviderWithBwrap(runner);

    await expect(
      provider.execUntrusted({ program: 'echo', args: ['x'] }, { workDir: tempWorkspace }),
    ).rejects.toMatchObject({ code: 'SANDBOX_CREATE_FAILED' });
  });

  it('目标程序自身失败（非 bwrap 前缀）不算沙箱建立失败', async () => {
    const runner = new RecordingRunner((spec) =>
      spec.auditTag === 'sandbox-untrusted'
        ? { code: 2, stderr: 'grep: no such file' }
        : { code: 0 },
    );
    const provider = linuxProviderWithBwrap(runner);

    const result = await provider.execUntrusted(
      { program: 'grep', args: ['x'] },
      { workDir: tempWorkspace },
    );
    expect(result.code).toBe(2);
    expect(result.isolation).toBe('os_sandbox');
  });
});

describe('detectBwrapSetupError', () => {
  it('识别 bwrap 前缀的 setup 错误', () => {
    expect(detectBwrapSetupError('bwrap: Creating new namespace failed', 1)).toMatch(/bwrap:/);
    expect(detectBwrapSetupError('some program error', 1)).toBeNull();
    expect(detectBwrapSetupError('bwrap: noise', 0)).toBeNull();
  });
});

describe('buildBubblewrapPlan', () => {
  it('挂载顺序：只读在前，可写 bind 在后', () => {
    const plan = buildBubblewrapPlan({
      bwrapPath: '/usr/bin/bwrap',
      program: 'node',
      args: ['-v'],
      workDir: tempWorkspace,
      cwd: tempWorkspace,
    });

    const bindIndex = plan.args.lastIndexOf('--bind');
    const lastRoIndex = plan.args.lastIndexOf('--ro-bind-try');
    expect(lastRoIndex).toBeGreaterThan(-1);
    expect(bindIndex).toBeGreaterThan(lastRoIndex);
    expect(plan.args[plan.args.length - 2]).toBe('node');
    expect(plan.args[plan.args.length - 1]).toBe('-v');
  });

  it('非绝对路径的 bwrap / 空 program 直接拒绝', () => {
    expect(() =>
      buildBubblewrapPlan({
        bwrapPath: 'bwrap',
        program: 'ls',
        args: [],
        workDir: tempWorkspace,
        cwd: tempWorkspace,
      }),
    ).toThrow(ForgeError);

    expect(() =>
      buildBubblewrapPlan({
        bwrapPath: '/usr/bin/bwrap',
        program: '',
        args: [],
        workDir: tempWorkspace,
        cwd: tempWorkspace,
      }),
    ).toThrow(ForgeError);
  });
});

/* ------------------------------------------------------------------ */
/* SandboxManager 路由                                                 */
/* ------------------------------------------------------------------ */

function createManager(provider?: OsSandboxProvider): SandboxManager {
  const guard = new WorkspaceGuard({ roots: [tempWorkspace] });
  return new SandboxManager({
    workspaceRoot: tempWorkspace,
    workspaceGuard: guard,
    ...(provider ? { osSandboxProvider: provider } : {}),
  });
}

function unavailableProvider(): OsSandboxProvider {
  return new OsSandboxProvider({
    platform: 'win32',
    lookupBwrap: () => FOUND_BWRAP,
    runner: new RecordingRunner(),
    probeWorkDir: tempWorkspace,
  });
}

describe('SandboxManager — untrusted 必须经 OS 沙箱', () => {
  it('无 OS 沙箱：untrusted 被拒绝，且不创建任何工作区、不调用 ResourceLimiter', async () => {
    const manager = createManager(unavailableProvider());
    const spy = vi.spyOn(manager.getResourceLimiter(), 'exec');

    await expect(
      manager.runInSandbox(
        { workspaceRoot: tempWorkspace },
        { program: 'echo', args: ['hello'] },
        'untrusted',
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });

    expect(spy).not.toHaveBeenCalled();
    // 拒绝发生在创建资源之前：工作区里不应留下任何 forgex-sandbox-* 目录
    await expect(readdir(tempWorkspace)).resolves.toEqual([]);
    spy.mockRestore();
  });

  it('有 OS 沙箱：untrusted 走 bwrap，ResourceLimiter 完全不参与', async () => {
    const runner = new RecordingRunner(() => ({ code: 0, stdout: 'ok' }));
    const manager = createManager(linuxProviderWithBwrap(runner));
    const spy = vi.spyOn(manager.getResourceLimiter(), 'exec');

    const result = await manager.runInSandbox(
      { workspaceRoot: tempWorkspace },
      { program: 'echo', args: ['hello'] },
      'untrusted',
    );

    expect(spy).not.toHaveBeenCalled();
    expect(result.isolation).toBe('os_sandbox');
    expect(result.program).toBe('/usr/bin/bwrap');

    const execCalls = runner.calls.filter((call) => call.auditTag === 'sandbox-untrusted');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.program).toBe('/usr/bin/bwrap');
    spy.mockRestore();
  });

  it('回归：provider 声称可用但返回未隔离结果 → 抛错而不是静默放行', async () => {
    // 模拟"检查通过，实际执行走了普通路径"的退化实现：
    // execUntrusted 返回一个没有任何溯源标记的普通结果
    const runner = new RecordingRunner();
    const provider = linuxProviderWithBwrap(runner);
    // 用原型链派生，保留 requestUntrustedExecution / isAvailable 等真实实现
    const fakeUntagged = Object.assign(Object.create(provider) as OsSandboxProvider, {
      status: async () => ({ ...(await provider.status()), available: true }),
      execUntrusted: async () => ({
        code: 0,
        stdout: 'plain execution',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 1,
      }),
    });

    const manager = createManager(fakeUntagged);
    const spy = vi.spyOn(manager.getResourceLimiter(), 'exec');

    await expect(
      manager.runInSandbox(
        { workspaceRoot: tempWorkspace },
        { program: 'echo', args: ['x'] },
        'untrusted',
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('execInSandbox 的 untrusted 同样被 gate 拦住（不能绕过）', async () => {
    const manager = createManager(unavailableProvider());
    const sandbox = await manager.createSandbox({ type: 'temp_dir' });
    try {
      await expect(
        manager.execInSandbox(sandbox, { program: 'echo', args: ['x'] }, 'untrusted'),
      ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    } finally {
      await manager.destroySandbox(sandbox);
    }
  });
});

describe('SandboxManager — trusted 行为保持不变', () => {
  it('trusted 仍走 ResourceLimiter，结果标记 isolation=none', async () => {
    const manager = createManager(unavailableProvider());
    const spy = vi.spyOn(manager.getResourceLimiter(), 'exec').mockResolvedValue({
      code: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      truncated: false,
      durationMs: 1,
    });

    const result = await manager.runInSandbox(
      { workspaceRoot: tempWorkspace },
      { program: 'echo', args: ['hello'] },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    // trusted 不能被误标成 OS 沙箱
    expect(result.isolation).toBe('none');
    expect(result.program).toBe('echo');
    spy.mockRestore();
  });

  it('trusted 默认路径不会因为 OS 沙箱不可用而被拒绝', async () => {
    const manager = createManager(unavailableProvider());
    const sandbox = await manager.createSandbox({ workspaceRoot: tempWorkspace });
    expect(sandbox.type).toBe('temp_dir');
    await manager.destroySandbox(sandbox);
  });
});

describe('SandboxManager — spec.type 不能绕过检查', () => {
  it('type=os_sandbox 在无 OS 沙箱时直接拒绝，不会退化成临时目录', async () => {
    const manager = createManager(unavailableProvider());
    await expect(
      manager.createSandbox({ workspaceRoot: tempWorkspace, type: 'os_sandbox' }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    await expect(readdir(tempWorkspace)).resolves.toEqual([]);
  });

  it('type=os_sandbox 在 OS 沙箱可用时创建句柄，且其上的执行仍走 bwrap', async () => {
    const runner = new RecordingRunner(() => ({ code: 0 }));
    const manager = createManager(linuxProviderWithBwrap(runner));

    const sandbox = await manager.createSandbox({ workspaceRoot: tempWorkspace, type: 'os_sandbox' });
    try {
      expect(sandbox.type).toBe('os_sandbox');
      expect(existsSync(sandbox.workDir)).toBe(true);

      const result = await manager.execInSandbox(
        sandbox,
        { program: 'echo', args: ['x'] },
        'trusted', // 即使 trustLevel 是 trusted，os_sandbox 类型也必须走 bwrap
      );
      expect(result.isolation).toBe('os_sandbox');
      const execCalls = runner.calls.filter((call) => call.auditTag === 'sandbox-untrusted');
      expect(execCalls).toHaveLength(1);
    } finally {
      await manager.destroySandbox(sandbox);
    }
  });

  it('type=git_worktree 但 Git 不可用：默认报错，不会静默换成临时目录', async () => {
    vi.spyOn(GitWorktreeProvider.prototype, 'isAvailable').mockResolvedValue(false);
    const manager = createManager(unavailableProvider());

    await expect(
      manager.createSandbox({ workspaceRoot: tempWorkspace, type: 'git_worktree' }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });

    // 显式允许回退时才回退
    const fallback = await manager.createSandbox({
      workspaceRoot: tempWorkspace,
      type: 'git_worktree',
      allowWorkspaceFallback: true,
    });
    expect(fallback.type).toBe('temp_dir');
    await manager.destroySandbox(fallback);
    vi.restoreAllMocks();
  });

  it('未知沙箱类型被拒绝', async () => {
    const manager = createManager(unavailableProvider());
    await expect(
      manager.createSandbox({
        workspaceRoot: tempWorkspace,
        type: 'os-sandbox' as unknown as 'os_sandbox',
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_CREATE_FAILED' });
  });

  it('detectCapabilities 复用执行用 provider（报告与执行不分裂）', async () => {
    const runner = new RecordingRunner(() => ({ code: 0 }));
    const manager = createManager(linuxProviderWithBwrap(runner));

    const report = await manager.detectCapabilities();
    expect(report.osSandbox.available).toBe(true);

    const result = await manager.runInSandbox(
      { workspaceRoot: tempWorkspace },
      { program: 'echo', args: ['x'] },
      'untrusted',
    );
    expect(result.isolation).toBe('os_sandbox');
  });
});
