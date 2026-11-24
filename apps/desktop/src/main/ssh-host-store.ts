import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import type { SshHostProfile, SshHostProfileInput } from '../shared/desktop-api.js';

export function sshRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('SSH 参数格式无效');
  return value as Record<string, unknown>;
}

export function sshId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) throw new Error('SSH 标识无效');
  return value;
}

export function sshFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)) throw new Error('主机指纹格式无效');
  return value;
}

const profileFields = ['name', 'host', 'port', 'username', 'privateKeyPath'];
const printable = /^[^\x00-\x1f\x7f]+$/;

function parseFields({ name, host, port, username, privateKeyPath }: Record<string, unknown>): SshHostProfileInput {
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || !printable.test(name)) throw new Error('请输入有效的主机显示名称');
  if (typeof host !== 'string' || !host || host.length > 253 || (!isIP(host)
    && (/^[\d.]+$/.test(host) || !host.replace(/\.$/, '').split('.').every(
      (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    )))) throw new Error('请输入有效的主机名或 IP 地址');
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口须在 1 至 65535 之间');
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(username)) throw new Error('SSH 用户名无效');
  if (typeof privateKeyPath !== 'string' || !isAbsolute(privateKeyPath) || !printable.test(privateKeyPath)
    || privateKeyPath.length > 4096 || (process.platform === 'win32' && !/^[A-Z]:[\\/][^:*?"<>|]+$/i.test(privateKeyPath))) {
    throw new Error('请输入本机私钥文件的绝对路径');
  }
  return { name: name.trim(), host, port, username, privateKeyPath };
}

export function parseSshHostInput(value: unknown): SshHostProfileInput & { id?: string } {
  const row = sshRecord(value, [...profileFields, 'id']);
  return { ...parseFields(row), ...(row.id === undefined ? {} : { id: sshId(row.id) }) };
}

function parseProfile(value: unknown): SshHostProfile {
  const row = sshRecord(value, [...profileFields, 'id', 'hostKeyFingerprint']);
  return { ...parseFields(row), id: sshId(row.id),
    hostKeyFingerprint: row.hostKeyFingerprint === null ? null : sshFingerprint(row.hostKeyFingerprint) };
}

export class SshHostStore {
  constructor(private readonly file: string) {}

  list(): SshHostProfile[] {
    try {
      const rows: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(rows) || rows.length > 512) throw new Error();
      const profiles = rows.map(parseProfile);
      if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new Error();
      return profiles;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('无法读取 SSH 主机配置，请检查配置文件和访问权限');
    }
  }

  upsert(value: SshHostProfile): SshHostProfile {
    const profile = parseProfile(value);
    const rows = this.list();
    const index = rows.findIndex((row) => row.id === profile.id);
    if (index < 0) rows.push(profile);
    else rows[index] = profile;
    if (rows.length > 512) throw new Error('已达到 SSH 主机数量上限');
    this.write(rows);
    return profile;
  }

  remove(id: string): void {
    this.write(this.list().filter((row) => row.id !== id));
  }

  private write(rows: SshHostProfile[]): void {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(rows, null, 2), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temp, this.file);
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* Retain the original configuration. */ }
      throw new Error('无法保存 SSH 主机配置，请检查访问权限');
    }
  }
}
