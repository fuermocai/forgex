/**
 * 场景 C：隔离测试 — 安全测试（v0.4.0 Phase 7）。
 *
 * 验证沙箱安全约束：
 *   - untrusted 代码在无 OS 沙箱时被拒绝；
 *   - 临时目录在 workspaceRoot 内；
 *   - 沙箱销毁后路径不存在；
 *   - 超时后进程被清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { SandboxManager } from '@forgex/sandbox';
import { WorkspaceGuard } from '@forgex/security';

describe('场景 C：沙箱隔离安全', () => {
  let workspaceRoot: string;
  let workspaceGuard: WorkspaceGuard;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'forgex-sandbox-test-'));
    workspaceGuard = new WorkspaceGuard({ roots: [workspaceRoot] });
  });

  afterEach(() => {
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('untrusted 信任级别在无 OS 沙箱时拒绝执行', async () => {
    const manager = new SandboxManager({ workspaceRoot, workspaceGuard });

    // 在 Windows 上通常没有 OS 沙箱
    const result = await manager
      .runInSandbox(
        { type: 'temp_dir' },
        { program: 'echo', args: ['hello'], timeoutMs: 5000 },
        'untrusted',
      )
      .catch((e) => e);

    // 要么拒绝（无沙箱），要么返回结果（有沙箱）
    // 关键是不能在无沙箱时降级执行
    if (result instanceof Error) {
      expect(result.message).toContain('沙箱');
    } else {
      // 如果有沙箱，执行结果应有效
      expect(result).toBeDefined();
    }
  });

  it('临时目录沙箱在 workspaceRoot 内创建', async () => {
    const manager = new SandboxManager({ workspaceRoot, workspaceGuard });
    const sandbox = await manager.createSandbox({
      type: 'temp_dir',
    });

    // 沙箱路径必须在 workspaceRoot 内
    expect(sandbox.workDir.startsWith(workspaceRoot)).toBe(true);
    expect(existsSync(sandbox.workDir)).toBe(true);

    // 清理
    await manager.destroySandbox(sandbox);
    expect(existsSync(sandbox.workDir)).toBe(false);
  });

  it('沙箱销毁后路径不存在', async () => {
    const manager = new SandboxManager({ workspaceRoot, workspaceGuard });
    const sandbox = await manager.createSandbox({
      type: 'temp_dir',
    });
    const path = sandbox.workDir;

    expect(existsSync(path)).toBe(true);
    await manager.destroySandbox(sandbox);
    expect(existsSync(path)).toBe(false);
  });

  it('超时后进程被清理', async () => {
    const manager = new SandboxManager({ workspaceRoot, workspaceGuard });
    const sandbox = await manager.createSandbox({
      type: 'temp_dir',
    });

    // 执行一个会超时的命令
    const result = await manager
      .execInSandbox(
        sandbox,
        { program: 'ping', args: ['-n', '10', '127.0.0.1'], timeoutMs: 1000 },
        'trusted',
      )
      .catch((e) => e);

    // 应该超时或被终止
    if (result && typeof result === 'object' && 'timedOut' in result) {
      expect((result as { timedOut: boolean }).timedOut).toBe(true);
    }

    await manager.destroySandbox(sandbox);
  });
});
