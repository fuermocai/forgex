/**
 * Linux 端口监听采集（/proc/net/{tcp,tcp6,udp,udp6}）。
 *
 * 地址字段是十六进制且按小端存储，需要逐字节反转后再格式化。
 * 进程归属通过 socket inode 反查 /proc/PID/fd，因此可能因权限不足缺省 pid。
 */
import { readdir, readlink } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import type { PortInfo, PortProtocol } from '../types.js';

const STATE_MAP: Record<string, string> = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
};

const SOURCE_FILES: ReadonlyArray<[string, PortProtocol]> = [
  ['/proc/net/tcp', 'tcp'],
  ['/proc/net/tcp6', 'tcp6'],
  ['/proc/net/udp', 'udp'],
  ['/proc/net/udp6', 'udp6'],
];

export interface ListPortsOptions {
  /** 只返回 LISTEN（TCP）或未连接（UDP）状态的监听端口 */
  listeningOnly?: boolean;
}

export async function listLinuxPorts(options: ListPortsOptions = {}): Promise<PortInfo[]> {
  const inodePid = await buildSocketOwnerMap();
  const ports: PortInfo[] = [];

  for (const [file, protocol] of SOURCE_FILES) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (!text) continue;
    const lines = text.split('\n').slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const local = fields[1] ?? '';
      const stateHex = fields[3] ?? '';
      const inode = Number(fields[9]);
      const state = STATE_MAP[stateHex] ?? stateHex;
      if (options.listeningOnly && protocol.startsWith('tcp') && state !== 'LISTEN') continue;
      const localAddr = decodeLocalAddress(local, protocol);
      if (!localAddr) continue;
      const pid = Number.isFinite(inode) ? (inodePid.get(inode) ?? null) : null;
      ports.push({
        port: localAddr.port,
        protocol,
        state,
        localAddress: localAddr.address,
        pid,
        processName: null,
      });
    }
  }

  // 补全进程名（按唯一 pid 读取 /proc/PID/comm）
  const names = new Map<number, string>();
  await Promise.all(
    [...new Set(ports.map((p) => p.pid).filter((pid): pid is number => pid !== null))].map(async (pid) => {
      const comm = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
      if (comm.trim()) names.set(pid, comm.trim());
    }),
  );
  for (const port of ports) {
    if (port.pid !== null) port.processName = names.get(port.pid) ?? null;
  }

  return ports.sort((a, b) => a.port - b.port);
}

/** 解析 `0100007F:1F90` 形式的本地地址 */
function decodeLocalAddress(raw: string, protocol: PortProtocol): { address: string; port: number } | null {
  const [addrHex, portHex] = raw.split(':');
  if (!addrHex || !portHex) return null;
  const port = Number.parseInt(portHex, 16);
  if (!Number.isFinite(port)) return null;

  if (protocol === 'tcp6' || protocol === 'udp6') {
    return { address: `[${addrHex}]`, port };
  }
  const bytes = addrHex.match(/.{2}/g);
  if (!bytes || bytes.length !== 4) return null;
  const address = bytes
    .reverse()
    .map((byte) => Number.parseInt(byte, 16))
    .join('.');
  return { address, port };
}

/** 建立 socket inode -> pid 映射；无权限的进程跳过 */
async function buildSocketOwnerMap(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const entries = await readdir('/proc', { withFileTypes: true }).catch(() => []);
  const pids = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name));

  await Promise.all(
    pids.map(async (pid) => {
      const fds = await readdir(`/proc/${pid}/fd`).catch(() => null);
      if (!fds) return;
      for (const fd of fds) {
        const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
        const match = /^socket:\[(\d+)\]$/.exec(link);
        if (match) {
          const inode = Number(match[1]);
          if (Number.isFinite(inode) && !map.has(inode)) map.set(inode, pid);
        }
      }
    }),
  );
  return map;
}
