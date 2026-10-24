/**
 * Sandbox Manager 测试（v0.4.0 Phase 2）。
 *
 * 重点验证：
 *   1. 能力检测返回结构化结果；
 *   2. TempDirProvider 创建/销毁临时目录；
 *   3. OsSandboxProvider 在不可用时拒绝不可信代码执行；
 *   4. SandboxManager 不可信代码执行被拒绝。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { WorkspaceGuard } from '@forgex/security';
import { detectCapabilities } from '../src/manager/capability-detector.js';
import { TempDirProvider } from '../src/providers/temp-dir-provider.js';
import { OsSandboxProvider } from '../src/providers/os-sandbox-provider.js';
import { SandboxManager } from '../src/manager/sandbox-manager.js';
import { ForgeError } from '@forgex/shared';

let tempWorkspace: string;

beforeEach(async () => {
  tempWorkspace = await mkdtemp(join(tmpdir(), 'forgex-sandbox-test-'));
});

describe('CapabilityDetector', () => {
  it('返回结构化能力报告', async () => {
    const report = await detectCapabilities(tempWorkspace);
    expect(report).toHaveProperty('rustExecutor');
    expect(report).toHaveProperty('git');
    expect(report).toHaveProperty('tempDir');
    expect(report).toHaveProperty('osSandbox');
    expect(report).toHaveProperty('anyAvailable');

    // 每项能力有 available 和 reason
    for (const cap of [report.rustExecutor, report.git, report.tempDir, report.osSandbox]) {
      expect(typeof cap.available).toBe('boolean');
      expect(typeof cap.reason).toBe('string');
    }
  });

  it('临时目录应该可用', async () => {
    const report = await detectCapabilities(tempWorkspace);
    expect(report.tempDir.available).toBe(true);
  });

  it('anyAvailable 至少为 true（临时目录可用）', async () => {
    const report = await detectCapabilities(tempWorkspace);
    expect(report.anyAvailable).toBe(true);
  });
});

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

  it('destroy 后工作目录被删除', async () => {
    const provider = new TempDirProvider();
    const sandbox = await provider.create({ workspaceRoot: tempWorkspace });
    expect(existsSync(sandbox.workDir)).toBe(true);

    await provider.destroy(sandbox);
    expect(existsSync(sandbox.workDir)).toBe(false);
    expect(sandbox.destroyed).toBe(true);
  });

  it('destroy 幂等（多次调用不抛错）', async () => {
    const provider = new TempDirProvider();
    const sandbox = await provider.create({ workspaceRoot: tempWorkspace });

    await provider.destroy(sandbox);
    await provider.destroy(sandbox); // 第二次不抛错
    expect(sandbox.destroyed).toBe(true);
  });
});

describe('OsSandboxProvider', () => {
  it('isAvailable 在非 Linux 平台返回 false', async () => {
    const provider = new OsSandboxProvider();
    const available = await provider.isAvailable();
    // Windows 上应该返回 false
    if (process.platform !== 'linux') {
      expect(available).toBe(false);
    }
  });

  it('requestUntrustedExecution 在不可用时抛 SANDBOX_UNAVAILABLE', async () => {
    const provider = new OsSandboxProvider();
    const available = await provider.isAvailable();

    if (!available) {
      await expect(provider.requestUntrustedExecution()).rejects.toThrow(ForgeError);
      try {
        await provider.requestUntrustedExecution();
      } catch (err) {
        expect((err as ForgeError).code).toBe('SANDBOX_UNAVAILABLE');
      }
    }
  });

  it('create 在不可用时抛错', async () => {
    const provider = new OsSandboxProvider();
    const available = await provider.isAvailable();
    if (!available) {
      await expect(
        provider.create({ workspaceRoot: tempWorkspace }),
      ).rejects.toThrow(ForgeError);
    }
  });
});

describe('SandboxManager', () => {
  function createManager(): SandboxManager {
    const guard = new WorkspaceGuard({ roots: [tempWorkspace] });
    return new SandboxManager({
      workspaceRoot: tempWorkspace,
      workspaceGuard: guard,
    });
  }

  it('detectCapabilities 返回报告', async () => {
    const manager = createManager();
    const report = await manager.detectCapabilities();
    expect(report.anyAvailable).toBe(true);
  });

  it('createSandbox 创建临时目录沙箱', async () => {
    const manager = createManager();
    const sandbox = await manager.createSandbox({ workspaceRoot: tempWorkspace });
    expect(existsSync(sandbox.workDir)).toBe(true);
    await manager.destroySandbox(sandbox);
    expect(existsSync(sandbox.workDir)).toBe(false);
  });

  it('不可信代码执行在 OS 沙箱不可用时被拒绝', async () => {
    const manager = createManager();
    const osProvider = new OsSandboxProvider();
    const osAvailable = await osProvider.isAvailable();

    if (!osAvailable) {
      const sandbox = await manager.createSandbox({ workspaceRoot: tempWorkspace });
      try {
        await expect(
          manager.execInSandbox(
            sandbox,
            { program: 'echo', args: ['hello'] },
            'untrusted',
          ),
        ).rejects.toThrow(ForgeError);
      } finally {
        await manager.destroySandbox(sandbox);
      }
    }
  });
});
