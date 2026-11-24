import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PREVIEW_LIMIT = 256 * 1024;
const unavailable = '文件已变更，或无法验证工作区文件的位置，请刷新后重试';

// stdin is the already-open file. No project path or file content is passed as
// program text. The helper returns the kernel name of that very handle.
const windowsHandleName = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ForgeXHandle {
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint size, uint flags);
}
'@
$name = New-Object System.Text.StringBuilder 32768
$length = [ForgeXHandle]::GetFinalPathNameByHandle([ForgeXHandle]::GetStdHandle(-10), $name, $name.Capacity, 0)
if ($length -eq 0 -or $length -ge $name.Capacity) { exit 1 }
[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($name.ToString())))
`;

async function handlePath(fd: number): Promise<string> {
  if (process.platform === 'linux') return readlink(`/proc/self/fd/${fd}`);
  const windows = process.platform === 'win32';
  if (!windows && process.platform !== 'darwin') throw new Error(unavailable);
  const executable = windows
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    : '/usr/bin/perl';
  // Darwin F_GETPATH returns the vnode path for the inherited descriptor.
  const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(windowsHandleName, 'utf16le').toString('base64')]
    : ['-T', '-e', 'my $p = "\\0" x 1024; fcntl(STDIN, 50, $p) or exit 1; print unpack("Z*", $p);'];
  const output = await new Promise<Buffer>((fulfill, reject) => {
    const child = spawn(executable, args, {
      cwd: windows ? process.env.SystemRoot : '/', stdio: [fd, 'pipe', 'ignore'],
      windowsHide: true, timeout: 10_000,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.on('error', () => reject(new Error(unavailable)));
    child.on('close', (code) => {
      if (code !== 0 || size > 256 * 1024) reject(new Error(unavailable));
      else fulfill(Buffer.concat(chunks));
    });
  });
  if (!windows) return output.toString();
  const path = Buffer.from(output.toString(), 'base64').toString();
  return path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
}

/** Reads a bounded preview from a regular file whose open handle resolves to
 * the requested project path. A directory or symlink substitution fails closed.
 */
export async function previewUntrackedFile(root: string, file: string): Promise<string> {
  const expected = resolve(root, file);
  const original = await lstat(expected, { bigint: true });
  if (original.isSymbolicLink()) return '符号链接（不读取目标内容）';
  if (!original.isFile()) throw new Error(unavailable);
  const handle = await open(expected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const pinned = await handle.stat({ bigint: true });
    if (!pinned.isFile() || pinned.dev !== original.dev || pinned.ino !== original.ino
      || await handlePath(handle.fd) !== expected) throw new Error(unavailable);
    const data = Buffer.alloc(PREVIEW_LIMIT + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > PREVIEW_LIMIT) throw new Error('未跟踪文件超出预览大小限制（256 KiB）');
    const contents = data.subarray(0, size);
    if (contents.includes(0)) return '二进制文件';
    if (size === 0) return '空文件';
    const lines = contents.toString().split('\n');
    if (lines.at(-1) === '') lines.pop();
    return `--- /dev/null\n+++ ${JSON.stringify(file)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => '+' + line).join('\n')}`;
  } finally {
    await handle.close();
  }
}
