/**
 * Linux 内存信息（/proc/meminfo）。
 *
 * 使用 MemAvailable 计算已用内存，比 MemFree 更贴近真实可用量。
 */
import { readFile } from 'node:fs/promises';
import { ForgeError } from '@forgex/shared';
import type { MemoryInfo } from '../types.js';

export async function getLinuxMemory(): Promise<MemoryInfo> {
  const text = await readFile('/proc/meminfo', 'utf8').catch((err: unknown) => {
    throw new ForgeError('TOOL_FAILED', '无法读取 /proc/meminfo', { cause: err });
  });

  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)(?:\s+kB)?$/.exec(line.trim());
    if (match) values.set(match[1] ?? '', Number(match[2]));
  }

  const totalKb = values.get('MemTotal');
  if (!totalKb) throw new ForgeError('TOOL_FAILED', '/proc/meminfo 缺少 MemTotal');

  const freeKb = values.get('MemFree') ?? 0;
  const availableKb = values.get('MemAvailable') ?? freeKb;
  const swapTotalKb = values.get('SwapTotal') ?? 0;
  const swapFreeKb = values.get('SwapFree') ?? 0;
  const usedKb = Math.max(0, totalKb - availableKb);

  return {
    totalBytes: totalKb * 1024,
    freeBytes: freeKb * 1024,
    availableBytes: availableKb * 1024,
    usedPercent: totalKb > 0 ? Math.round((usedKb / totalKb) * 1000) / 10 : null,
    swapTotalBytes: swapTotalKb * 1024,
    swapUsedBytes: (swapTotalKb - swapFreeKb) * 1024,
  };
}
