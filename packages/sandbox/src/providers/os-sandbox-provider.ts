/**
 * OsSandboxProvider：OS 级沙箱提供者（v0.4.0 Phase 2）。
 *
 * 第一版策略：
 *   - 只做能力检测，不实现完整 bubblewrap/seccomp/cgroups 集成；
 *   - 当 OS 沙箱不可用时，明确拒绝不可信代码执行；
 *   - 禁止自动降级到无沙箱执行；
 *   - 禁止自动关闭 AppArmor 或其他系统安全机制。
 *
 * 未来版本：
 *   - Linux: 集成 bubblewrap (bwrap) 实现文件系统和网络隔离；
 *   - Linux: 使用 cgroups v2 限制 CPU/内存；
 *   - Windows: 研究 Job Object / Windows Sandbox 方案。
 */
import { existsSync } from 'node:fs';
import { ForgeError } from '@forgex/shared';
import type { Sandbox, SandboxSpec } from '../types.js';
import type { SandboxProvider } from './sandbox-provider.js';

export class OsSandboxProvider implements SandboxProvider {
  readonly type = 'os_sandbox' as const;

  async isAvailable(): Promise<boolean> {
    // 第一版：只有 Linux 且 bubblewrap 可用时才返回 true
    if (process.platform !== 'linux') return false;
    const bwrapPaths = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/snap/bin/bwrap'];
    return bwrapPaths.some((p) => existsSync(p));
  }

  async create(_spec: SandboxSpec): Promise<Sandbox> {
    // 第一版不实现完整 OS 沙箱创建
    // 调用方应在 create 前检查 isAvailable()
    throw new ForgeError(
      'SANDBOX_UNAVAILABLE',
      'OS 级沙箱尚未实现集成。第一版仅做能力检测，不可信代码执行在 OS 沙箱不可用时被拒绝。',
      { details: { platform: process.platform } },
    );
  }

  async destroy(_sandbox: Sandbox): Promise<void> {
    // 第一版无实际资源需要清理
  }

  /**
   * 请求执行不可信代码。
   * OS 沙箱不可用时必须拒绝，禁止自动降级。
   */
  async requestUntrustedExecution(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      throw new ForgeError(
        'SANDBOX_UNAVAILABLE',
        this.getUnavailableReason(),
        { details: { platform: process.platform } },
      );
    }
    // 即使可用，第一版也不实际执行——需要等待完整集成
    throw new ForgeError(
      'SANDBOX_UNAVAILABLE',
      'OS 级沙箱集成尚未实现，不可信代码执行被拒绝。请使用 TempDir 或 GitWorktree 沙箱执行可信命令。',
    );
  }

  private getUnavailableReason(): string {
    if (process.platform !== 'linux') {
      return `当前平台 ${process.platform} 不支持 OS 级沙箱。不可信代码执行被拒绝。`;
    }
    return '未检测到 bubblewrap (bwrap)，OS 级沙箱不可用。不可信代码执行被拒绝，不自动降级。';
  }
}
