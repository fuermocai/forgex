/**
 * Linux 进程采集（/proc）。
 *
 * 只读、无外部命令依赖，适用于常见发行版（含国产化 Linux）。
 * 注意：/proc/PID 在读取过程中可能消失，所有单进程读取都必须容错跳过。
 */
import { readdir, readFile } from 'node:fs/promises';
import type { ProcessInfo } from '../types.js';

interface PasswdEntry {
  name: string;
}

const UID_CACHE = new Map<number, string>();
let passwdLoaded = false;

export async function listLinuxProcesses(): Promise<ProcessInfo[]> {
  const entries = await readdir('/proc', { withFileTypes: true });
  const pids = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name));

  await loadPasswd();

  const results = await Promise.all(pids.map((pid) => readProcess(pid)));
  return results
    .filter((item): item is ProcessInfo => item !== null)
    .sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0));
}

async function readProcess(pid: number): Promise<ProcessInfo | null> {
  try {
    const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
    const open = statText.indexOf('(');
    const close = statText.lastIndexOf(')');
    if (open === -1 || close === -1) return null;
    const name = statText.slice(open + 1, close);

    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    const rssKb = matchNumber(status, /^VmRSS:\s+(\d+)\s+kB$/m);
    const uid = matchNumber(status, /^Uid:\s+(\d+)/m);

    const cmdline = await readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0));
    const command = cmdline.toString('utf8').replace(/\0/g, ' ').trim();

    return {
      pid,
      name,
      command: command.length > 0 ? command.slice(0, 500) : null,
      user: uid === null ? null : (UID_CACHE.get(uid) ?? String(uid)),
      memoryBytes: rssKb === null ? null : rssKb * 1024,
    };
  } catch {
    // 进程已退出或无权限读取
    return null;
  }
}

function matchNumber(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** 一次性加载 /etc/passwd，把 uid 映射为用户名 */
async function loadPasswd(): Promise<void> {
  if (passwdLoaded) return;
  passwdLoaded = true;
  const text = await readFile('/etc/passwd', 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const parts = line.split(':');
    if (parts.length < 3) continue;
    const name = parts[0];
    const uid = Number(parts[2]);
    if (name && Number.isFinite(uid)) UID_CACHE.set(uid, name as PasswdEntry['name']);
  }
}
