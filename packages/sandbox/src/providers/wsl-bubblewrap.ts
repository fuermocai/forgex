/** Windows bridge that runs Linux Bubblewrap inside a WSL 2 distribution. */
import { spawn } from 'node:child_process';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { ForgeError } from '@forgex/shared';
import type { SandboxRunner, SandboxRunnerSpec } from './bubblewrap.js';

const SYSTEM_READ_ONLY_PATHS = [
  '/usr', '/usr/local', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32',
  '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/alternatives',
  '/etc/ssl', '/etc/ca-certificates', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf',
  '/etc/hosts', '/etc/localtime',
] as const;

export interface WslBubblewrapEnvironment {
  wslPath: string;
  distro?: string;
  bubblewrapPath: string;
  kernelRelease: string;
}

/** Finds and verifies WSL 2 and Bubblewrap in the selected distribution. */
export async function resolveWslBubblewrap(distro?: string): Promise<WslBubblewrapEnvironment> {
  const wslPath = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
  if (!isAbsolute(wslPath)) throw new ForgeError('SANDBOX_UNAVAILABLE', '无法解析 wsl.exe 的系统路径');

  const args = distro ? ['--distribution', distro] : [];
  const kernelRelease = (await captureWsl(wslPath, [...args, '--exec', 'uname', '-r'])).trim();
  if (!kernelRelease.toLowerCase().includes('microsoft-standard-wsl2')) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', `需要 WSL 2 内核，检测到: ${kernelRelease || '未知内核'}`);
  }

  const bubblewrapPath = (await captureWsl(wslPath, [
    ...args,
    '--exec',
    '/bin/sh',
    '-c',
    'command -v bwrap',
  ])).trim();
  if (!bubblewrapPath.startsWith('/') || bubblewrapPath.includes('\n')) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', 'WSL 发行版中未安装 Bubblewrap（bwrap）');
  }

  return { wslPath, ...(distro ? { distro } : {}), bubblewrapPath, kernelRelease };
}

/** Converts an absolute Windows path to the corresponding WSL path. */
export async function toWslPath(environment: WslBubblewrapEnvironment, windowsPath: string): Promise<string> {
  if (!isAbsolute(windowsPath)) throw new ForgeError('SANDBOX_UNAVAILABLE', `路径必须是 Windows 绝对路径: ${windowsPath}`);
  const args = [
    ...(environment.distro ? ['--distribution', environment.distro] : []),
    '--exec',
    'wslpath',
    '-u',
    windowsPath,
  ];
  const converted = (await captureWsl(environment.wslPath, args)).trim();
  if (!converted.startsWith('/') || converted.includes('\n')) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', `WSL 无法转换工作区路径: ${windowsPath}`);
  }
  return posix.resolve(converted);
}

/** Builds a deny-network Bubblewrap argv for paths mounted through WSL DrvFs. */
export function buildWslBubblewrapArgs(input: {
  workDir: string;
  cwd: string;
  program: string;
  args: readonly string[];
  env?: Record<string, string>;
  protectedPaths?: readonly string[];
  allowNetwork?: boolean;
}): string[] {
  const workDir = posix.resolve(input.workDir);
  const cwd = posix.resolve(input.cwd);
  if (!input.program || !workDir.startsWith('/') || !cwd.startsWith('/')) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', 'WSL 沙箱要求非空程序和绝对 Linux 路径');
  }
  if (workDir === '/') throw new ForgeError('SANDBOX_UNAVAILABLE', '拒绝把 WSL 根目录作为可写工作区');
  if (isOutside(workDir, cwd)) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', `WSL 沙箱 cwd 不在可写工作区内: ${cwd}`);
  }

  if (/\.(exe|com|cmd|bat|ps1)$/i.test(input.program)) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', 'WSL 沙箱仅执行 Linux 程序，拒绝启动 Windows 可执行文件');
  }

  const cwdRelative = posix.relative(workDir, cwd);
  const protectedTargets: string[] = [];
  for (const protectedPath of input.protectedPaths ?? []) {
    const target = posix.resolve(protectedPath);
    if (target === workDir || isOutside(workDir, target)) continue;
    protectedTargets.push(target);
  }

  const workspaceDirs = ancestors(workDir);
  const argv = [
    '--unshare-all', ...(input.allowNetwork ? ['--share-net'] : []), '--die-with-parent', '--clearenv',
    '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  ];
  for (const path of SYSTEM_READ_ONLY_PATHS) argv.push('--ro-bind-try', path, path);
  argv.push('--tmpfs', '/mnt');
  for (const directory of workspaceDirs) {
    if (directory !== '/mnt') argv.push('--dir', directory);
  }
  argv.push('--bind', workDir, workDir);
  for (const target of protectedTargets) {
    argv.push('--ro-bind-try', target, target);
  }
  argv.push('--chdir', cwdRelative ? posix.join(workDir, cwdRelative) : workDir);

  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ['PATH', 'HOME', 'TMPDIR'].includes(key)) continue;
    argv.push('--setenv', key, value);
  }
  argv.push('--', input.program, ...input.args);
  return argv;
}

function ancestors(path: string): string[] {
  const result: string[] = [];
  let current = '';
  for (const segment of path.split('/').filter(Boolean)) {
    current += `/${segment}`;
    if (current === path) break;
    result.push(current);
  }
  result.push(path);
  return result;
}

/** Finds existing protected paths; absent paths need no host bind and must not be created. */
export async function findMissingWslPaths(
  environment: WslBubblewrapEnvironment,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  if (paths.length === 0) return new Set();
  const script = 'for path do if [ -e "$path" ]; then printf 1; else printf 0; fi; done';
  const output = await captureWsl(environment.wslPath, [
    ...(environment.distro ? ['--distribution', environment.distro] : []),
    '--exec', '/bin/sh', '-c', script, 'sh', ...paths,
  ]);
  if (output.length !== paths.length || /[^01]/.test(output)) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', 'WSL 无法确认受保护路径状态');
  }
  return new Set(paths.filter((_path, index) => output[index] === '0'));
}

/** Wraps the configured resource-limited runner so it starts WSL and Bubblewrap. */
export function createWslBubblewrapRunner(
  baseRunner: SandboxRunner,
  environment: WslBubblewrapEnvironment,
  hostCwd: string,
): SandboxRunner {
  return {
    kind: 'wsl2-bubblewrap',
    async run(spec: SandboxRunnerSpec, signal?: AbortSignal) {
      const args = [
        ...(environment.distro ? ['--distribution', environment.distro] : []),
        '--exec',
        spec.program,
        ...spec.args,
      ];
      const env: Record<string, string> = {};
      if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      return baseRunner.run({ ...spec, program: environment.wslPath, args, cwd: hostCwd, env }, signal);
    },
  };
}

async function captureWsl(program: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(program, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      rejectOutput(new ForgeError('SANDBOX_UNAVAILABLE', 'WSL 沙箱探测超时'));
      settled = true;
    }, 8_000);
    timeout.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectOutput(new ForgeError('SANDBOX_UNAVAILABLE', `无法启动 WSL: ${error.message}`, { cause: error }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        rejectOutput(new ForgeError('SANDBOX_UNAVAILABLE', `WSL 命令失败: ${decode(stderr).trim() || `exit code ${code}`}`));
        return;
      }
      resolveOutput(decode(stdout));
    });
  });
}

function appendBounded(current: Buffer, chunk: Buffer): Buffer {
  const remaining = 64 * 1024 - current.length;
  return remaining > 0 ? Buffer.concat([current, chunk.subarray(0, remaining)]) : current;
}

function decode(value: Buffer): string {
  if (value.length >= 2 && value[1] === 0) return value.toString('utf16le').replace(/\0/g, '');
  return value.toString('utf8').replace(/\0/g, '');
}

function isOutside(root: string, target: string): boolean {
  const relativePath = posix.relative(root, target);
  return relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath);
}
