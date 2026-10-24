/**
 * Linux 磁盘使用率（df -kP）。
 *
 * -P 参数保证 POSIX 单行输出格式，避免长设备名换行导致解析错位。
 */
import { ForgeError } from '@forgex/shared';
import { execFileText } from '../exec.js';
import type { DiskInfo } from '../types.js';

export async function listLinuxDisks(): Promise<DiskInfo[]> {
  const result = await execFileText('df', ['-kP'], { timeoutMs: 10_000 });
  if (result.code !== 0) {
    throw new ForgeError('TOOL_FAILED', `df 执行失败: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const disks: DiskInfo[] = [];
  const lines = result.stdout.split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const totalKb = Number(match[2]);
    const usedKb = Number(match[3]);
    const availKb = Number(match[4]);
    disks.push({
      filesystem: match[1] ?? 'unknown',
      mount: match[6] ?? 'unknown',
      totalBytes: totalKb * 1024,
      usedBytes: usedKb * 1024,
      availableBytes: availKb * 1024,
      usedPercent: Number(match[5]),
    });
  }
  return disks;
}
