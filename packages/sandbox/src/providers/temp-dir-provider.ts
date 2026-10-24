/**
 * TempDirProvider：临时目录沙箱提供者（v0.4.0 Phase 2）。
 *
 * 创建唯一临时目录作为工作区，任务结束后递归删除。
 *
 * 安全约束：
 *   - 临时目录在 os.tmpdir() 下，不在授权工作区内时需要注意；
 *   - 实际上临时目录应该在授权工作区内创建，避免越权；
 *   - destroy 时递归删除，确保无残留。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Sandbox, SandboxSpec } from '../types.js';
import type { SandboxProvider } from './sandbox-provider.js';

export class TempDirProvider implements SandboxProvider {
  readonly type = 'temp_dir' as const;

  async isAvailable(): Promise<boolean> {
    // 临时目录总是可用的（除非磁盘满）
    return true;
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    // 在授权工作区内创建临时子目录，避免越出工作区
    const workDir = await mkdtemp(join(spec.workspaceRoot, `forgex-sandbox-${randomUUID().slice(0, 8)}-`));

    return {
      id: `sandbox_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      type: 'temp_dir',
      workDir,
      workspaceRoot: spec.workspaceRoot,
      destroyed: false,
    };
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    if (sandbox.destroyed) return;
    try {
      await rm(sandbox.workDir, { recursive: true, force: true });
    } catch {
      // 删除失败不抛异常——可能目录已被手动删除
      // 但标记为 destroyed，避免重复尝试
    }
    sandbox.destroyed = true;
  }
}
