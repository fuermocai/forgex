/**
 * CapabilityDetector：沙箱能力检测器（v0.4.0 Phase 2）。
 *
 * 职责：
 *   1. 检测 Rust 安全执行器是否可用；
 *   2. 检测 Git 是否可用（用于 worktree）；
 *   3. 检测临时目录是否可写；
 *   4. 检测 OS 级沙箱是否可用（bubblewrap/seccomp/cgroups，Linux）；
 *   5. 返回结构化报告，每项能力有 available + reason。
 *
 * 安全约束：
 *   - 检测是只读的，不修改系统状态；
 *   - 不自动启用任何安全机制（如 AppArmor）；
 *   - 不自动关闭任何安全机制。
 */
import { existsSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveExecutorBinary } from '@forgex/tools';
import type { SandboxCapability, SandboxCapabilityReport } from '../types.js';

/**
 * 检测沙箱能力。
 *
 * @param workspaceRoot 工作区根目录（用于检测 Rust executor）
 * @returns 能力检测报告
 */
export async function detectCapabilities(workspaceRoot: string): Promise<SandboxCapabilityReport> {
  const rustExecutor = detectRustExecutor(workspaceRoot);
  const git = await detectGit();
  const tempDir = await detectTempDir();
  const osSandbox = detectOsSandbox();

  const anyAvailable =
    rustExecutor.available || git.available || tempDir.available || osSandbox.available;

  return {
    rustExecutor,
    git,
    tempDir,
    osSandbox,
    anyAvailable,
  };
}

/** 检测 Rust 执行器是否可用 */
function detectRustExecutor(workspaceRoot: string): SandboxCapability {
  try {
    const binary = resolveExecutorBinary(workspaceRoot);
    if (binary) {
      return {
        type: 'rust_executor',
        available: true,
        reason: '',
        details: { path: binary },
      };
    }
    return {
      type: 'rust_executor',
      available: false,
      reason: '未找到 Rust 执行器（FORGEX_EXECUTOR 环境变量或 .forgex/bin/forgex-executor）',
    };
  } catch (err) {
    return {
      type: 'rust_executor',
      available: false,
      reason: `检测 Rust 执行器失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 检测 Git 是否可用 */
async function detectGit(): Promise<SandboxCapability> {
  return new Promise((resolve) => {
    const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
    const child = spawn(gitName, ['--version'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill();
      resolve({
        type: 'git',
        available: false,
        reason: 'Git 命令超时',
      });
    }, 5000);
    timer.unref?.();

    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        type: 'git',
        available: false,
        reason: '未找到 git 可执行文件',
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          type: 'git',
          available: true,
          reason: '',
          details: { version: stdout.trim() },
        });
      } else {
        resolve({
          type: 'git',
          available: false,
          reason: `git --version 失败: ${stderr.trim() || `exit code ${code}`}`,
        });
      }
    });
  });
}

/** 检测临时目录是否可写 */
async function detectTempDir(): Promise<SandboxCapability> {
  try {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-sandbox-test-'));
    // 测试写入
    await access(dir);
    // 清理
    await rm(dir, { recursive: true, force: true });
    return {
      type: 'temp_dir',
      available: true,
      reason: '',
      details: { path: tmpdir() },
    };
  } catch (err) {
    return {
      type: 'temp_dir',
      available: false,
      reason: `临时目录不可写: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 检测 OS 级沙箱是否可用。
 *
 * Linux: 检查 bubblewrap (bwrap)、seccomp、cgroups v2
 * Windows: 第一版不支持 OS 级沙箱，返回不可用
 *
 * 注意：第一版只做能力检测，不实现完整 OS 沙箱集成。
 * 不可用时明确拒绝不可信代码执行，禁止自动降级。
 */
function detectOsSandbox(): SandboxCapability {
  if (process.platform !== 'linux') {
    return {
      type: 'os_sandbox',
      available: false,
      reason: `当前平台 ${process.platform} 不支持 OS 级沙箱（第一版仅 Linux 评估）`,
    };
  }

  // Linux: 检查 bubblewrap
  const bwrapPaths = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/snap/bin/bwrap'];
  const bwrapAvailable = bwrapPaths.some((p) => existsSync(p));

  if (bwrapAvailable) {
    return {
      type: 'os_sandbox',
      available: true,
      reason: '',
      details: { mechanism: 'bubblewrap' },
    };
  }

  // 检查 cgroups v2
  const cgroupV2Available = existsSync('/sys/fs/cgroup/cgroup.controllers');

  return {
    type: 'os_sandbox',
    available: false,
    reason: `未检测到可用的 OS 级沙箱机制（bubblewrap: ${bwrapAvailable}, cgroups v2: ${cgroupV2Available}）`,
    details: {
      bubblewrap: String(bwrapAvailable),
      cgroupsV2: String(cgroupV2Available),
    },
  };
}
