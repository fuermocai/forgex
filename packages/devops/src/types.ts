/**
 * DevOps 诊断的数据结构。
 *
 * 所有字段都来自真实系统调用（/proc、netstat、tasklist、df、CIM），
 * 无法获取时使用 `null` 而不是猜测值——"未知"必须如实表达。
 */

export interface ProcessInfo {
  pid: number;
  name: string;
  /** 完整命令行（Linux 可获取；Windows tasklist 不提供） */
  command: string | null;
  user: string | null;
  memoryBytes: number | null;
}

export type PortProtocol = 'tcp' | 'tcp6' | 'udp' | 'udp6';

export interface PortInfo {
  port: number;
  protocol: PortProtocol;
  /** LISTEN / ESTABLISHED / ... */
  state: string;
  localAddress: string;
  pid: number | null;
  processName: string | null;
}

export interface DiskInfo {
  filesystem: string;
  mount: string;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
}

export interface MemoryInfo {
  totalBytes: number;
  freeBytes: number;
  availableBytes: number | null;
  usedPercent: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
}

export interface LogTailResult {
  path: string;
  content: string;
  lines: number;
  truncated: boolean;
  sizeBytes: number;
}

export type SupportedPlatform = 'linux' | 'windows' | 'other';

export function currentPlatform(): SupportedPlatform {
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'windows';
  return 'other';
}
