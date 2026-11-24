/** macOS Seatbelt profile builder used by the OS sandbox executor. */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { ForgeError } from '@forgex/shared';

/** Absolute system executable used to apply Seatbelt policies. */
export const SEATBELT_EXECUTABLE = '/usr/bin/sandbox-exec';

/** Resolves the platform Seatbelt executable without searching an untrusted PATH. */
export function resolveSeatbeltPath(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'darwin' || !existsSync(SEATBELT_EXECUTABLE)) return null;
  try {
    if (!statSync(SEATBELT_EXECUTABLE).isFile()) return null;
    accessSync(SEATBELT_EXECUTABLE, constants.X_OK);
    return SEATBELT_EXECUTABLE;
  } catch {
    return null;
  }
}

/** Builds a deny-by-default Seatbelt profile with workspace writes and carveouts. */
export function buildSeatbeltProfile(
  workDirInput: string,
  protectedPaths: readonly string[] = [],
  allowNetwork = false,
): string {
  if (!isAbsolute(workDirInput)) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', `Seatbelt 沙箱要求绝对工作目录: ${workDirInput}`);
  }

  const workDir = resolve(workDirInput);
  if (workDir === parse(workDir).root) {
    throw new ForgeError('SANDBOX_UNAVAILABLE', `拒绝把文件系统根作为 Seatbelt 可写工作目录: ${workDir}`);
  }
  const exclusions = new Set<string>();
  for (const protectedPath of protectedPaths) {
    const target = resolve(workDir, protectedPath);
    const rel = relative(workDir, target);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    exclusions.add(target);
  }

  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow file-read*)',
    '(allow file-write-data (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))',
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/tmp"))',
    ...[...exclusions].flatMap((path) => [
      `(deny file-write* (literal ${seatbeltString(path)}))`,
      `(deny file-write* (subpath ${seatbeltString(path)}))`,
    ]),
    `(allow file-write* (subpath ${seatbeltString(workDir)}))`,
    ...(allowNetwork ? ['(allow network*)'] : []),
    `(deny file-write-unlink (require-all (literal ${seatbeltString(workDir)}) (vnode-type DIRECTORY)))`,
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.PowerManagement.control"))',
    '(allow ipc-posix-sem)',
    '(allow pseudo-tty)',
    '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
    '(allow file-read* file-write* (require-all (regex #"^/dev/ttys[0-9]+") (extension "com.apple.sandbox.pty")))',
  ].join('\n');
}

function seatbeltString(value: string): string {
  return JSON.stringify(value);
}
