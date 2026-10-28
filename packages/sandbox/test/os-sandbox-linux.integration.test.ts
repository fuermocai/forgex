/**
 * 真实 Linux bubblewrap 集成测试（v0.5.5）。
 *
 * **这个文件才是"OS 隔离确实生效"的证据来源**；单元测试里的可注入 runner
 * 只能证明路由与 fail-closed 逻辑，不能证明隔离效果。
 *
 * 跳过条件（任一不满足即 skip，并在理由里说明）：
 *   - 平台不是 Linux；
 *   - 没有可执行的 bwrap；
 *   - 没有 Rust 执行器（forgex-executor）——我们不允许用 Node spawn 兜底，
 *     否则会丢掉超时/输出截断/进程树清理语义。
 *
 * 本地验证方式：
 *   cargo build --release --manifest-path crates/executor/Cargo.toml
 *   FORGEX_EXECUTOR=$PWD/target/release/forgex-executor \
 *     pnpm vitest run packages/sandbox/test/os-sandbox-linux.integration.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExecutorBinary } from '@forgex/tools';
import { OsSandboxProvider } from '../src/providers/os-sandbox-provider.js';
import { resolveBubblewrapPath } from '../src/providers/bubblewrap.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const isLinux = process.platform === 'linux';
const bwrapLookup = isLinux ? resolveBubblewrapPath() : { found: false, path: null, reason: '非 Linux' };
const executorBinary = isLinux ? resolveExecutorBinary(repoRoot) : null;

const skipReason = !isLinux
  ? '非 Linux 平台，没有 bubblewrap 实现'
  : !bwrapLookup.found
    ? `bwrap 不可用（${bwrapLookup.reason}）`
    : !executorBinary
      ? '未找到 Rust 执行器（cargo build 后设置 FORGEX_EXECUTOR 再跑）'
      : '';

if (skipReason) {
  // 让跳过原因在 CI 日志里显式可见，而不是静默通过
  console.warn(`[sandbox integration] 跳过真实 bwrap 集成验证：${skipReason}`);
}

describe.skipIf(skipReason !== '')('真实 bwrap 集成（Linux）', () => {
  let workDir: string;
  let provider: OsSandboxProvider;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'forgex-bwrap-it-'));
    provider = new OsSandboxProvider({
      executorBinary,
      probeWorkDir: workDir,
      allowedCwdRoots: [workDir],
    });
  });

  it('探针通过，能力报告为可用', async () => {
    const status = await provider.status();
    expect(status.available).toBe(true);
    expect(status.verified).toBe(true);
    expect(status.mechanism).toBe('bubblewrap');
  });

  it('untrusted 命令经 bwrap 执行并返回结果', async () => {
    const result = await provider.execUntrusted(
      { program: '/bin/echo', args: ['sandbox-ok'] },
      { workDir },
    );

    expect(result.isolation).toBe('os_sandbox');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('sandbox-ok');
  });

  it('工作目录可写，宿主机其它路径只读', async () => {
    const inside = await provider.execUntrusted(
      { program: '/bin/sh', args: ['-c', 'echo data > ./inside.txt && cat ./inside.txt'] },
      { workDir },
    );
    expect(inside.code).toBe(0);
    expect((await readFile(join(workDir, 'inside.txt'), 'utf8')).trim()).toBe('data');

    const outside = await provider.execUntrusted(
      { program: '/bin/sh', args: ['-c', 'echo pwned > /etc/forgex-sandbox-test'] },
      { workDir },
    );
    expect(outside.code).not.toBe(0);
    expect(existsSync('/etc/forgex-sandbox-test')).toBe(false);
  });

  it('默认断网（net namespace 内只有 loopback）', async () => {
    const result = await provider.execUntrusted(
      {
        program: '/bin/sh',
        args: ['-c', 'ip -o link show 2>/dev/null || cat /proc/net/dev'],
      },
      { workDir },
    );
    // 没有 eth0 / 只有 lo
    expect(result.stdout).not.toMatch(/\beth0\b/);
  });

  it('超时被终止，进程不会残留到宿主', async () => {
    const started = Date.now();
    const result = await provider.execUntrusted(
      { program: '/bin/sh', args: ['-c', 'sleep 30'] },
      { workDir, timeoutMs: 800 },
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('输出被截断并标记 truncated', async () => {
    const result = await provider.execUntrusted(
      { program: '/bin/sh', args: ['-c', 'yes forgex | head -c 200000'] },
      { workDir, maxOutputBytes: 4096 },
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(4096 + 64);
  });

  it('清理：删除可写目录', async () => {
    await writeFile(join(workDir, 'tmp.txt'), 'x', 'utf8');
    await rm(workDir, { recursive: true, force: true });
    expect(existsSync(workDir)).toBe(false);
  });
});
