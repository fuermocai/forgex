/**
 * Windows 端口监听（netstat -ano）。
 *
 * 输出形如：
 *   TCP    0.0.0.0:8090    0.0.0.0:0    LISTENING    1234
 *   UDP    0.0.0.0:5353     *:*                       5678
 * 注意 UDP 没有 state 列，字段数比 TCP 少一个。
 */
import { execFileText } from '../exec.js';
import type { PortInfo, PortProtocol } from '../types.js';
import { listWindowsProcesses } from './processes.js';

export interface ListPortsOptions {
  listeningOnly?: boolean;
}

export async function listWindowsPorts(options: ListPortsOptions = {}): Promise<PortInfo[]> {
  const result = await execFileText('netstat', ['-ano'], { timeoutMs: 20_000 });
  if (result.code !== 0) return [];

  const ports: PortInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const proto = (fields[0] ?? '').toUpperCase();
    if (proto !== 'TCP' && proto !== 'UDP') continue;
    const local = fields[1] ?? '';
    const parsed = parseLocal(local, proto);
    if (!parsed) continue;

    let state = 'UNKNOWN';
    let pidText: string | undefined;
    if (proto === 'TCP' && fields.length >= 5) {
      state = fields[3] ?? 'UNKNOWN';
      pidText = fields[4];
    } else {
      state = 'LISTEN';
      pidText = fields[3];
    }
    if (options.listeningOnly && proto === 'TCP' && state !== 'LISTENING') continue;

    const pid = pidText ? Number(pidText) : NaN;
    ports.push({
      port: parsed.port,
      protocol: parsed.protocol,
      state,
      localAddress: parsed.address,
      pid: Number.isFinite(pid) ? pid : null,
      processName: null,
    });
  }

  // 补全进程名
  const processMap = new Map<number, string>();
  for (const proc of await listWindowsProcesses()) processMap.set(proc.pid, proc.name);
  for (const port of ports) {
    if (port.pid !== null) port.processName = processMap.get(port.pid) ?? null;
  }

  return ports.sort((a, b) => a.port - b.port);
}

function parseLocal(raw: string, proto: 'TCP' | 'UDP'): { address: string; port: number; protocol: PortProtocol } | null {
  const idx = raw.lastIndexOf(':');
  if (idx === -1) return null;
  const address = raw.slice(0, idx).replace(/^\[|\]$/g, '');
  const port = Number(raw.slice(idx + 1));
  if (!Number.isFinite(port)) return null;
  const isV6 = raw.startsWith('[') || raw.split(':').length > 2;
  const protocol: PortProtocol = proto === 'TCP' ? (isV6 ? 'tcp6' : 'tcp') : isV6 ? 'udp6' : 'udp';
  return { address, port, protocol };
}
