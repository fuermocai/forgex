/**
 * DevOps 诊断包测试。
 *
 * 这些测试刻意调用真实系统接口（tasklist/netstat/df//proc），
 * 不使用 mock——否则无法证明"诊断能力真实可用"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getMemory,
  listDisks,
  listPorts,
  listProcesses,
  readLogTail,
  type MemoryInfo,
  type PortInfo,
  type ProcessInfo,
  type DiskInfo,
} from '../src/index.js';

describe('readLogTail', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'forgex-log-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('读取最后 N 行并标记截断', async () => {
    const file = join(dir, 'app.log');
    const content = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join('\n');
    await writeFile(file, content, 'utf8');

    const tail = await readLogTail(file, { lines: 10 });
    expect(tail.lines).toBe(10);
    expect(tail.content.startsWith('line-41')).toBe(true);
    expect(tail.truncated).toBe(true);
  });

  it('完整读取小文件时不标记截断', async () => {
    const file = join(dir, 'small.log');
    await writeFile(file, 'a\nb\nc\n', 'utf8');
    const tail = await readLogTail(file, { lines: 10 });
    expect(tail.content).toBe('a\nb\nc');
    expect(tail.truncated).toBe(false);
  });

  it('支持 UTF-16LE BOM', async () => {
    const file = join(dir, 'utf16.log');
    const payload = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文日志', 'utf16le')]);
    await writeFile(file, payload);
    const tail = await readLogTail(file);
    expect(tail.content).toContain('中文日志');
  });

  it('文件不存在时抛出 PATH_NOT_FOUND', async () => {
    await expect(readLogTail(join(dir, 'missing.log'))).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
  });
});

describe('真实系统诊断', () => {
  let server: Server;
  let port = 0;

  beforeEach(async () => {
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') port = address.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('能列出进程且包含当前进程', async () => {
    const processes: ProcessInfo[] = await listProcesses();
    expect(processes.length).toBeGreaterThan(0);
    expect(processes.some((p) => p.pid === process.pid)).toBe(true);
  }, 20_000);

  it('能发现本进程监听的端口', async () => {
    const ports: PortInfo[] = await listPorts({ listeningOnly: true });
    expect(ports.some((p) => p.port === port)).toBe(true);
  }, 20_000);

  it('能读取磁盘与内存真实数据', async () => {
    const disks: DiskInfo[] = await listDisks();
    expect(Array.isArray(disks)).toBe(true);
    expect(disks.length).toBeGreaterThan(0);
    const memory: MemoryInfo = await getMemory();
    expect(memory.totalBytes).toBeGreaterThan(0);
    if (memory.usedPercent !== null) {
      expect(memory.usedPercent).toBeGreaterThanOrEqual(0);
      expect(memory.usedPercent).toBeLessThanOrEqual(100);
    }
  }, 40_000);
});
