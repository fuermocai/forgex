/**
 * Bubblewrap（bwrap）执行计划构建与探针。
 *
 * 这个模块是"OS 沙箱"能力的唯一来源：
 *   - `buildBubblewrapPlan()` 生成真正交给 bwrap 的 argv；
 *   - `probeBubblewrap()` **通过同一个 runner 真的启动一次 bwrap**，
 *     只有它成功返回，OS 沙箱才可以被报告为 available；
 *   - `resolveBubblewrapPath()` 只做"存在 + 可执行"检查，**不能**单独作为能力依据。
 *
 * 隔离策略（最小化）：
 *   - `--unshare-all`：mount / pid / net / ipc / uts / user（+ cgroup）命名空间全部隔离；
 *     默认无网络，需显式 `allowNetwork` 才加 `--share-net`。
 *   - `--die-with-parent` + pid namespace：bwrap 一旦退出，命名空间内所有进程被内核回收。
 *   - 根文件系统只有有限只读挂载；`/proc`、`/dev`、`/tmp` 都是沙箱内新挂载的。
 *   - 只有 `workDir` 是 writable bind，其余挂载点一律只读。
 *
 * 不做 `--new-session`：它会 setsid()，让目标程序脱离进程组，
 * 破坏 Rust 执行器基于进程组的 kill -PID 语义。pid 命名空间 + --die-with-parent
 * 已经能保证 bwrap 死后沙箱内进程全部回收。
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, parse, relative, resolve as resolvePath } from 'node:path';
import { runViaExecutor, type ExecutorSpec } from '@forgex/tools';
import { ForgeError } from '@forgex/shared';
import type { SandboxExecResult } from '../types.js';

/** 常见 bwrap 安装位置（PATH 搜索之外的兜底） */
export const BWRAP_CANDIDATE_PATHS = [
  '/usr/bin/bwrap',
  '/usr/local/bin/bwrap',
  '/bin/bwrap',
  '/snap/bin/bwrap',
] as const;

/** 沙箱内固定注入的环境变量 */
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SANDBOX_HOME = '/tmp';

/**
 * 只读挂载白名单。
 * 全部使用 `--ro-bind-try`：源不存在时静默跳过（跨发行版兼容），
 * 但只要 `/usr` 或 `/bin` 缺失，探针里的 `/bin/true` 就跑不起来 → 能力不可用 → fail closed。
 */
const RO_BIND_TARGETS = [
  '/usr',
  '/usr/local',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
  '/etc/hosts',
  '/etc/localtime',
] as const;

/** 探针目标程序候选（真存在才用） */
const PROBE_PROGRAMS = ['/bin/true', '/usr/bin/true'] as const;

/** 可注入的命令执行器：默认走 Rust executor（自带超时 / 输出截断 / 进程树清理） */
export interface SandboxRunnerSpec {
  program: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** 审计标签 */
  auditTag?: string;
}

export interface SandboxRunnerResult extends SandboxExecResult {
  /** 实际被启动的可执行文件（用于校验"确实调用了 bwrap"） */
  program: string;
}

export interface SandboxRunner {
  /** 人类可读的执行器标识（报告里展示） */
  readonly kind: string;
  run(spec: SandboxRunnerSpec, signal?: AbortSignal): Promise<SandboxRunnerResult>;
}

/** bwrap 探测（仅做路径解析，不产生能力结论） */
export interface BwrapLookup {
  found: boolean;
  path: string | null;
  reason: string;
}

export interface BubblewrapPlanInput {
  bwrapPath: string;
  /** 目标程序（bwrap 内部 exec 的可执行文件） */
  program: string;
  args: readonly string[];
  /** 唯一可写目录（绝对路径，且不能是文件系统根） */
  workDir: string;
  /** 进程工作目录（必须在 workDir 内） */
  cwd: string;
  env?: Record<string, string>;
  allowNetwork?: boolean;
  extraRoBinds?: readonly string[];
}

export interface BubblewrapPlan {
  bwrapPath: string;
  /** 完整 argv（不含 bwrap 自身） */
  args: string[];
  /** 执行器侧 cwd（宿主机路径，bwrap 在其中启动） */
  cwd: string;
  /** 沙箱内目标程序名 */
  program: string;
  /** 沙箱内可写根 */
  workDir: string;
}

/**
 * 解析 bwrap 可执行文件。
 *
 * 只做"文件存在 + 具备执行权限 + 是普通文件（跟随符号链接）"。
 * **调用方不得据此判定 OS 沙箱可用**——必须再跑 probeBubblewrap()。
 */
export function resolveBubblewrapPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BwrapLookup {
  if (platform !== 'linux') {
    return {
      found: false,
      path: null,
      reason: `当前平台 ${platform} 没有 bubblewrap 实现（OS 级隔离只在 Linux 提供）`,
    };
  }

  const candidates: string[] = [];
  const pathEnv = env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (dir) candidates.push(join(dir, 'bwrap'));
  }
  candidates.push(...BWRAP_CANDIDATE_PATHS);
  if (env.FORGEX_BWRAP) candidates.unshift(env.FORGEX_BWRAP);

  let firstSeen: string | null = null;
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
    firstSeen ??= candidate;
    try {
      // 跟随符号链接后必须是普通文件，且当前用户可执行
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return { found: true, path: candidate, reason: '' };
    } catch {
      // 不可执行，继续找下一个
    }
  }

  return {
    found: false,
    path: null,
    reason: firstSeen
      ? `找到 ${firstSeen}，但当前用户没有执行权限`
      : '未找到 bubblewrap（bwrap）可执行文件',
  };
}

/** 校验可写目录：不能是文件系统根，必须是绝对路径 */
export function validateWritableRoot(workDir: string): string {
  if (!workDir || !isAbsolute(workDir)) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', `OS 沙箱要求绝对路径的可写目录，收到: ${workDir || '(空)'}`, {
      details: { workDir },
    });
  }
  const normalized = resolvePath(workDir);
  const parsed = parse(normalized);
  if (parsed.root === normalized) {
    throw new ForgeError(
      'SANDBOX_UNAVAILABLE',
      `拒绝把文件系统根 ${normalized} 作为可写目录——那会让 OS 沙箱的写保护完全失效`,
      { details: { workDir: normalized } },
    );
  }
  return normalized;
}

/** 校验 cwd 落在可写根内（否则写权限与预期不一致） */
export function validateCwdWithinWorkDir(cwd: string, workDir: string): string {
  const absCwd = resolvePath(cwd);
  const rel = relative(workDir, absCwd);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ForgeError(
      'SANDBOX_UNAVAILABLE',
      `OS 沙箱内的工作目录必须位于可写目录内：cwd=${absCwd} 不在 workDir=${workDir} 内`,
      { details: { cwd: absCwd, workDir } },
    );
  }
  return absCwd;
}

/**
 * 构建 bwrap 执行计划。
 *
 * 所有会进 argv 的值都做校验：`--` 之后才是目标程序，
 * 因此即使 program 以 `-` 开头也不会被 bwrap 当成选项。
 */
export function buildBubblewrapPlan(input: BubblewrapPlanInput): BubblewrapPlan {
  if (!input.program) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', 'OS 沙箱要求非空的 program');
  }
  if (!isAbsolute(input.bwrapPath)) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', `bwrap 路径必须是绝对路径: ${input.bwrapPath}`);
  }

  const workDir = validateWritableRoot(input.workDir);
  const cwd = validateCwdWithinWorkDir(input.cwd, workDir);

  const args: string[] = [
    '--unshare-all',
    ...(input.allowNetwork ? ['--share-net'] : []),
    '--die-with-parent',
    '--clearenv',
    '--setenv',
    'PATH',
    SANDBOX_PATH,
    '--setenv',
    'HOME',
    SANDBOX_HOME,
    '--setenv',
    'TMPDIR',
    SANDBOX_HOME,
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];

  const binds = [...RO_BIND_TARGETS, ...(input.extraRoBinds ?? [])];
  for (const target of binds) {
    if (!isAbsolute(target)) continue;
    // 可写目录之外一律只读（若 extraRoBinds 与 workDir 重叠，后者的 --bind 在后，写权限以 --bind 为准）
    args.push('--ro-bind-try', target, target);
  }

  args.push('--bind', workDir, workDir, '--chdir', cwd);

  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key === 'PATH' || key === 'HOME' || key === 'TMPDIR') continue;
    args.push('--setenv', key, value);
  }

  args.push('--', input.program, ...input.args);

  return {
    bwrapPath: input.bwrapPath,
    args,
    cwd: workDir,
    program: input.program,
    workDir,
  };
}

/**
 * 默认 runner：通过 Rust executor 启动 bwrap。
 *
 * 不提供 Node `child_process` 兜底——那会丢掉超时后的进程树清理与输出截断语义，
 * 变成"看起来在沙箱里、实际资源失控"。缺少执行器时直接拒绝。
 */
export function createExecutorRunner(options: {
  executorBinary: string | null;
  callerToken?: string;
  allowedCwdRoots?: readonly string[];
}): SandboxRunner {
  return {
    kind: 'rust-executor',
    async run(spec, signal) {
      if (!options.executorBinary) {
        throw new ForgeError(
          'SANDBOX_UNAVAILABLE',
          'OS 沙箱需要 Rust 执行器来保证超时、输出截断与进程树清理，但未找到 forgex-executor',
        );
      }
      const executorSpec: ExecutorSpec = {
        program: spec.program,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
        ...(options.callerToken ? { callerToken: options.callerToken } : {}),
        ...(options.allowedCwdRoots ? { allowedCwdRoots: [...options.allowedCwdRoots] } : {}),
        ...(spec.auditTag ? { auditTag: spec.auditTag } : {}),
      };
      const result = await runViaExecutor(options.executorBinary, executorSpec, signal);
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        program: spec.program,
        ...(result.spawnError ? { spawnError: result.spawnError } : {}),
      };
    },
  };
}

export interface BwrapProbeOutcome {
  /** 探针是否真的通过 bwrap 启动并成功退出 */
  verified: boolean;
  reason: string;
  bwrapPath: string | null;
  /** 探针用的目标程序 */
  probeProgram?: string;
  durationMs?: number;
}

/**
 * 真实探针：用**与业务执行完全相同的 plan 构建器与 runner**启动一次 bwrap。
 *
 * 只有这一步成功，才允许声称 OS 沙箱可用。它同时验证了：
 *   - bwrap 可执行；
 *   - 内核允许创建 user / mount / pid / net 等命名空间（权限不足会失败）；
 *   - 最小挂载集里有可用的动态链接环境（/bin/true 能跑起来）；
 *   - 执行链真的把 bwrap 作为 program 启动（runner 回报的 program 必须是 bwrap）。
 */
export async function probeBubblewrap(options: {
  runner: SandboxRunner;
  lookup: BwrapLookup;
  /** 探针用的可写目录（宿主已存在） */
  probeWorkDir: string;
  /** 探针目标程序（默认 /bin/true 或 /usr/bin/true；测试可注入） */
  probeProgram?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BwrapProbeOutcome> {
  const lookup = options.lookup;
  if (!lookup.found || !lookup.path) {
    return { verified: false, reason: lookup.reason, bwrapPath: null };
  }

  const probeProgram =
    options.probeProgram ?? PROBE_PROGRAMS.find((candidate) => existsSync(candidate));
  if (!probeProgram || !isAbsolute(probeProgram)) {
    return {
      verified: false,
      reason: '宿主机上找不到可用于探针的目标程序（/bin/true 或 /usr/bin/true），无法验证 bwrap 是否能启动程序',
      bwrapPath: lookup.path,
    };
  }

  const plan = buildBubblewrapPlan({
    bwrapPath: lookup.path,
    program: probeProgram,
    args: [],
    workDir: options.probeWorkDir,
    cwd: options.probeWorkDir,
    env: {},
    allowNetwork: false,
  });

  let result: SandboxRunnerResult;
  try {
    result = await options.runner.run(
      {
        program: plan.bwrapPath,
        args: plan.args,
        cwd: plan.cwd,
        env: {},
        timeoutMs: options.timeoutMs ?? 5_000,
        maxOutputBytes: 16 * 1024,
        auditTag: 'sandbox-probe',
      },
      options.signal,
    );
  } catch (err) {
    return {
      verified: false,
      reason: `bwrap 探针执行失败: ${err instanceof Error ? err.message : String(err)}`,
      bwrapPath: lookup.path,
    };
  }

  if (result.program !== plan.bwrapPath) {
    return {
      verified: false,
      reason: `执行链没有真正调用 bwrap（实际启动的是 ${result.program}），OS 沙箱报告为不可用`,
      bwrapPath: lookup.path,
      probeProgram,
      durationMs: result.durationMs,
    };
  }
  if (result.spawnError) {
    return {
      verified: false,
      reason: `bwrap 启动失败: ${result.spawnError}`,
      bwrapPath: lookup.path,
      probeProgram,
      durationMs: result.durationMs,
    };
  }
  if (result.timedOut) {
    return {
      verified: false,
      reason: 'bwrap 探针超时，无法确认 OS 隔离可用',
      bwrapPath: lookup.path,
      probeProgram,
      durationMs: result.durationMs,
    };
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    return {
      verified: false,
      reason: `bwrap 无法创建沙箱（退出码 ${result.code ?? 'null'}）${detail ? `: ${detail}` : ''}`,
      bwrapPath: lookup.path,
      probeProgram,
      durationMs: result.durationMs,
    };
  }

  return {
    verified: true,
    reason: '',
    bwrapPath: lookup.path,
    probeProgram,
    durationMs: result.durationMs,
  };
}
