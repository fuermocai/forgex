/**
 * CapabilityDetector：沙箱能力检测器（v0.5.5 能力一致性加固）。
 *
 * 职责：
 *   1. 检测 Rust 资源限制执行器（超时 / 输出限额 / 进程树清理）；
 *   2. 检测 Git 是否可用（worktree = 工作区隔离）；
 *   3. 检测临时目录是否可写（工作区隔离）；
 *   4. 检测 OS 级沙箱（= 复用 OsSandboxProvider 的真实探针结果）；
 *   5. 返回结构化报告：每项能力带 category / available / verified / reason。
 *
 * 安全约束：
 *   - 检测是只读的，不修改系统状态；
 *   - **不把工作区隔离算成 OS 沙箱**：`tempDir` / `git` 的 category 是
 *     `workspace_isolation`，`osSandbox` 才是 `os_isolation`；
 *   - `osSandbox.available` 只在探针真的通过 bwrap 启动过程序时为 true；
 *   - 不自动启用 / 关闭任何系统安全机制（如 AppArmor）。
 */
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveExecutorBinary } from '@forgex/tools';
import type { SandboxCapability, SandboxCapabilityReport } from '../types.js';
import { OsSandboxProvider } from '../providers/os-sandbox-provider.js';

export interface DetectCapabilitiesOptions {
  /**
   * 复用同一个 OsSandboxProvider 实例。
   * 必须与实际执行用同一个实例——否则"报告可用"和"执行可用"可能来自两次不同的探测。
   */
  osSandboxProvider?: OsSandboxProvider;
  /** 目标平台（透传给默认 provider） */
  platform?: NodeJS.Platform;
}

/**
 * 检测沙箱能力。
 *
 * @param workspaceRoot 工作区根目录（用于检测 Rust executor）
 */
export async function detectCapabilities(
  workspaceRoot: string,
  options: DetectCapabilitiesOptions = {},
): Promise<SandboxCapabilityReport> {
  const provider =
    options.osSandboxProvider ??
    new OsSandboxProvider({
      workspaceRoot,
      ...(options.platform ? { platform: options.platform } : {}),
    });

  const rustExecutor = detectRustExecutor(workspaceRoot);
  const git = await detectGit();
  const tempDir = await detectTempDir();
  const osSandbox = await detectOsSandbox(provider);

  const anyAvailable = rustExecutor.available || git.available || tempDir.available;

  return {
    rustExecutor,
    git,
    tempDir,
    osSandbox,
    anyAvailable,
    untrustedExecution: {
      allowed: osSandbox.available,
      // 这里只给"为什么不可用"；"被拒绝"由报告字段本身表达，避免重复措辞
      reason: osSandbox.available ? '' : osSandbox.reason || '没有可用的 OS 级沙箱',
    },
  };
}

/** 检测 Rust 执行器是否可用 */
function detectRustExecutor(workspaceRoot: string): SandboxCapability {
  try {
    const binary = resolveExecutorBinary(workspaceRoot);
    if (binary) {
      return {
        type: 'rust_executor',
        category: 'resource_limits',
        available: true,
        verified: true,
        reason: '',
        details: { path: binary, provides: 'timeout,output-limit,process-tree-kill' },
      };
    }
    return {
      type: 'rust_executor',
      category: 'resource_limits',
      available: false,
      verified: false,
      reason: '未找到 Rust 执行器（FORGEX_EXECUTOR 环境变量或 .forgex/bin/forgex-executor）',
    };
  } catch (err) {
    return {
      type: 'rust_executor',
      category: 'resource_limits',
      available: false,
      verified: false,
      reason: `检测 Rust 执行器失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 检测 Git 是否可用（worktree 属于工作区隔离，不是 OS 沙箱） */
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
        category: 'workspace_isolation',
        available: false,
        verified: false,
        reason: 'Git 命令超时',
      });
    }, 5000);
    timer.unref?.();

    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        type: 'git',
        category: 'workspace_isolation',
        available: false,
        verified: false,
        reason: '未找到 git 可执行文件',
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          type: 'git',
          category: 'workspace_isolation',
          available: true,
          verified: true,
          reason: '',
          details: { version: stdout.trim(), provides: 'git-worktree' },
        });
      } else {
        resolve({
          type: 'git',
          category: 'workspace_isolation',
          available: false,
          verified: false,
          reason: `git --version 失败: ${stderr.trim() || `exit code ${code}`}`,
        });
      }
    });
  });
}

/** 检测临时目录是否可写（工作区隔离，不是 OS 沙箱） */
async function detectTempDir(): Promise<SandboxCapability> {
  try {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-sandbox-test-'));
    // 测试写入
    await access(dir);
    // 清理
    await rm(dir, { recursive: true, force: true });
    return {
      type: 'temp_dir',
      category: 'workspace_isolation',
      available: true,
      verified: true,
      reason: '',
      details: { path: tmpdir(), provides: 'temporary-directory' },
    };
  } catch (err) {
    return {
      type: 'temp_dir',
      category: 'workspace_isolation',
      available: false,
      verified: false,
      reason: `临时目录不可写: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 检测 OS 级沙箱。
 *
 * 结论完全来自 `OsSandboxProvider.status()`：它会在 Linux 上用真实探针
 * （`bwrap --unshare-all … -- /bin/true`）验证执行链，仅"二进制存在"不会让
 * `available` 变成 true。Windows / macOS 直接不可用并说明原因。
 */
async function detectOsSandbox(provider: OsSandboxProvider): Promise<SandboxCapability> {
  const status = await provider.status();
  return {
    type: 'os_sandbox',
    category: 'os_isolation',
    available: status.available,
    verified: status.verified,
    reason: status.available ? '' : status.reason,
    details: {
      platform: status.platform,
      mechanism: status.mechanism ?? 'none',
      bwrap_path: status.bwrapPath ?? '(未找到)',
      execution_integrated: status.verified ? 'true' : 'false',
      ...(status.probeDurationMs !== undefined
        ? { probe_duration_ms: String(status.probeDurationMs) }
        : {}),
      ...status.details,
    },
  };
}

/**
 * 生成人类可读的能力说明（doctor / CLI 用）。
 *
 * 明确把"工作区隔离""资源限制""OS 级隔离"分开列，避免用户把
 * 临时目录或 worktree 当成 OS 沙箱。
 */
export function describeCapabilityReport(report: SandboxCapabilityReport): string[] {
  const label = (available: boolean): string => (available ? '可用' : '不可用');
  const lines = [
    `工作区隔离（只隔离文件视图，不隔离进程/网络）:`,
    `  - 临时目录      ${label(report.tempDir.available)}${report.tempDir.available ? '' : `: ${report.tempDir.reason}`}`,
    `  - Git worktree  ${label(report.git.available)}${report.git.available ? '' : `: ${report.git.reason}`}`,
    `资源限制（超时/输出限额/进程树清理，不是隔离边界）:`,
    `  - Rust 执行器   ${label(report.rustExecutor.available)}${report.rustExecutor.available ? '' : `: ${report.rustExecutor.reason}`}`,
    `OS 级隔离（文件系统/网络/进程，支撑 untrusted 执行）:`,
    `  - bubblewrap    ${label(report.osSandbox.available)}${report.osSandbox.available ? `（探针已验证，机制 ${report.osSandbox.details?.mechanism ?? 'bubblewrap'}）` : `: ${report.osSandbox.reason}`}`,
    `不可信代码执行: ${report.untrustedExecution.allowed ? '允许（经 OS 沙箱）' : '拒绝（fail closed，不降级）'}`,
  ];
  if (!report.untrustedExecution.allowed && report.untrustedExecution.reason) {
    lines.push(`  原因: ${report.untrustedExecution.reason}`);
  }
  return lines;
}
