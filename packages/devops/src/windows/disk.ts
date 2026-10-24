/**
 * Windows 磁盘使用率（PowerShell CIM）。
 *
 * 只查询 DriveType=3（本地固定磁盘），避免把光驱/网络盘算进来。
 * 所有参数都是硬编码脚本，不拼接任何外部输入。
 */
import { ForgeError } from '@forgex/shared';
import { execFileText } from '../exec.js';
import type { DiskInfo } from '../types.js';

const SCRIPT =
  'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ' +
  'Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress';

export async function listWindowsDisks(): Promise<DiskInfo[]> {
  const result = await execFileText(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    { timeoutMs: 20_000 },
  );
  if (result.code !== 0) {
    throw new ForgeError('TOOL_FAILED', `PowerShell 磁盘查询失败: ${result.stderr.trim() || `exit ${result.code}`}`);
  }

  const parsed = parseJson(result.stdout);
  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const disks: DiskInfo[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const mount = typeof record.DeviceID === 'string' ? record.DeviceID : null;
    if (!mount) continue;
    const total = toNumber(record.Size);
    const free = toNumber(record.FreeSpace);
    const used = total !== null && free !== null ? total - free : null;
    disks.push({
      filesystem: mount,
      mount,
      totalBytes: total,
      usedBytes: used,
      availableBytes: free,
      usedPercent: total !== null && used !== null && total > 0 ? Math.round((used / total) * 1000) / 10 : null,
    });
  }
  return disks;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
