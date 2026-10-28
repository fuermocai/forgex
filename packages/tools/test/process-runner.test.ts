/**
 * process-runner 的 Windows 包装器行为测试。
 *
 * 背景：Node >= 18.20（CVE-2024-27980 缓解）不允许直接 spawn `.cmd`/`.bat`，
 * 而 Windows 上的 npm / pnpm 只有 `.cmd` 包装器。质量门禁与 run_command 都依赖它，
 * 一旦回归就会表现为 "spawn EINVAL"，进而是"门禁全部失败"。
 *
 * 这里用真实的 `.cmd` 文件验证三件事：
 *   1. 能跑起来并拿到退出码；
 *   2. 参数里的空格能正确传递；
 *   3. 参数里的 cmd 元字符被拒绝（不退化成命令注入）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../src/index.js';

const isWindows = process.platform === 'win32';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgex-proc-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.runIf(isWindows)('Windows .cmd 包装器', () => {
  it('能执行 .cmd 并返回退出码与输出', async () => {
    await writeFile(join(dir, 'echo-args.cmd'), '@echo off\r\necho got:%1\r\nexit /b 3\r\n', 'utf8');
    const result = await runProcess({ program: join(dir, 'echo-args.cmd'), args: ['hello'], cwd: dir, timeoutMs: 15_000 });
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('got:hello');
  });

  it('带空格的参数能原样传给脚本', async () => {
    // 注意：cmd 对含空白的参数会保留引号（%1 带引号，%~1 才剥掉），这是 cmd 语义，
    // 所以这里只断言参数内容到达，不断言引号形态。
    await writeFile(join(dir, 'echo-args.cmd'), '@echo off\r\necho got=[%~1]\r\n', 'utf8');
    const result = await runProcess({
      program: join(dir, 'echo-args.cmd'),
      args: ['hello world'],
      cwd: dir,
      timeoutMs: 15_000,
    });
    expect(result.stdout).toContain('got=[hello world]');
  });

  it('拒绝把 cmd 元字符当参数传入', async () => {
    await writeFile(join(dir, 'echo-args.cmd'), '@echo off\r\necho %1\r\n', 'utf8');
    await expect(
      runProcess({ program: join(dir, 'echo-args.cmd'), args: ['x&whoami'], cwd: dir, timeoutMs: 15_000 }),
    ).rejects.toThrow(/元字符/);
  });
});

describe.runIf(!isWindows)('POSIX 直接执行', () => {
  it('不带 shell 执行脚本并获得真实退出码', async () => {
    await writeFile(join(dir, 'run.sh'), '#!/bin/sh\necho posix-ok\nexit 4\n', { mode: 0o755 });
    const result = await runProcess({ program: '/bin/sh', args: [join(dir, 'run.sh')], cwd: dir, timeoutMs: 15_000 });
    expect(result.code).toBe(4);
    expect(result.stdout).toContain('posix-ok');
  });

  it('超时会杀掉进程并标记 timedOut', async () => {
    const result = await runProcess({ program: '/bin/sh', args: ['-c', 'sleep 5'], cwd: dir, timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });
});
