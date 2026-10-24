/**
 * Windows 进程列表（tasklist）。
 *
 * tasklist 不提供命令行与 CPU/用户，因此这些字段返回 null，
 * 而不是用猜测值填充。内存列形如 "123,456 K"，需去掉逗号后换算。
 */
import { execFileText } from '../exec.js';
import type { ProcessInfo } from '../types.js';

export async function listWindowsProcesses(): Promise<ProcessInfo[]> {
  const result = await execFileText('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 15_000 });
  if (result.code !== 0) return [];

  const processes: ProcessInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = splitCsv(line);
    if (fields.length < 5) continue;
    const pid = Number(fields[1]);
    if (!Number.isFinite(pid)) continue;
    const memText = (fields[4] ?? '').replace(/[^\d]/g, '');
    const memKb = memText ? Number(memText) : NaN;
    processes.push({
      pid,
      name: fields[0] ?? 'unknown',
      command: null,
      user: null,
      memoryBytes: Number.isFinite(memKb) ? memKb * 1024 : null,
    });
  }
  return processes;
}

/** 解析 tasklist 的 CSV 行（字段用双引号包裹，内部可能含逗号） */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((item) => item.trim());
}
