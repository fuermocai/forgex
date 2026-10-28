/**
 * forgex sandbox：打印沙箱能力，并明确区分三层保证。
 *
 * 存在的意义：用户经常把「临时目录 / Git worktree」当成 OS 沙箱。
 * 这个命令按隔离类别分层输出，并直接给出"不可信代码执行是否被允许"的结论。
 */
import { stdout } from 'node:process';
import { describeCapabilityReport, detectCapabilities } from '@forgex/sandbox';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { loadConfig } from '../config/load-config.js';

export async function sandboxCommand(args: ParsedArgs, options: { cwd: string }): Promise<number> {
  const configFlag = flagString(args.flags, 'config');
  const loaded = loadConfig({
    cwd: options.cwd,
    ...(configFlag ? { configPath: configFlag } : {}),
  });
  const root = loaded.config.security.workspaceRoots[0] ?? options.cwd;
  const report = await detectCapabilities(root);

  if (flagBool(args.flags, 'json')) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  stdout.write('ForgeX 沙箱能力\n');
  stdout.write(`工作区根: ${root}\n\n`);
  for (const line of describeCapabilityReport(report)) {
    stdout.write(`${line}\n`);
  }
  stdout.write(
    [
      '',
      '说明：',
      '  - 临时目录 / Git worktree 只隔离文件视图，进程仍以当前用户权限、正常网络运行；',
      '  - Rust 执行器只做超时、输出限额与进程树清理，不是隔离边界；',
      '  - 只有 OS 级隔离（Linux bubblewrap）可以承载 trustLevel=untrusted；',
      '    其它平台或未通过探针时一律拒绝，不降级、不静默裸跑。',
    ].join('\n'),
  );
  stdout.write('\n');
  return 0;
}
