/**
 * Windows 内存信息（PowerShell CIM）。
 *
 * TotalVisibleMemorySize / FreePhysicalMemory 单位为 KB；
 * 页面文件信息来自 Win32_PageFileUsage，用于近似 swap。
 */
import { ForgeError } from '@forgex/shared';
import { execFileText } from '../exec.js';
import type { MemoryInfo } from '../types.js';

const SCRIPT =
  '$os=Get-CimInstance Win32_OperatingSystem;' +
  '$pf=Get-CimInstance Win32_PageFileUsage;' +
  '[pscustomobject]@{' +
  'Total=[double]$os.TotalVisibleMemorySize;' +
  'Free=[double]$os.FreePhysicalMemory;' +
  'SwapTotal=[double](($pf | Measure-Object -Property AllocatedBaseSize -Sum).Sum);' +
  'SwapUsed=[double](($pf | Measure-Object -Property CurrentUsage -Sum).Sum)' +
  '} | ConvertTo-Json -Compress';

export async function getWindowsMemory(): Promise<MemoryInfo> {
  const result = await execFileText(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    { timeoutMs: 20_000 },
  );
  if (result.code !== 0) {
    throw new ForgeError('TOOL_FAILED', `PowerShell 内存查询失败: ${result.stderr.trim() || `exit ${result.code}`}`);
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new ForgeError('TOOL_FAILED', '无法解析 Windows 内存查询结果');
  }

  const totalKb = toNumber(parsed.Total) ?? 0;
  const freeKb = toNumber(parsed.Free) ?? 0;
  const swapTotalKb = toNumber(parsed.SwapTotal);
  const swapUsedKb = toNumber(parsed.SwapUsed);
  if (totalKb <= 0) throw new ForgeError('TOOL_FAILED', 'Windows 内存总量无效');

  const usedKb = Math.max(0, totalKb - freeKb);
  return {
    totalBytes: totalKb * 1024,
    freeBytes: freeKb * 1024,
    availableBytes: freeKb * 1024,
    usedPercent: Math.round((usedKb / totalKb) * 1000) / 10,
    swapTotalBytes: swapTotalKb !== null ? swapTotalKb * 1024 : null,
    swapUsedBytes: swapUsedKb !== null ? swapUsedKb * 1024 : null,
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
