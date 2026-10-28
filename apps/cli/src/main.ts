#!/usr/bin/env node
/**
 * ForgeX CLI 入口。
 *
 * 子命令：
 *   chat      交互式会话（默认）
 *   run       单次任务（支持管道与 --json）
 *   doctor    环境自检
 *   tools     列出内置工具
 *   sessions  查看历史会话
 *   config    查看最终生效配置
 *   sandbox   查看沙箱能力（工作区隔离 vs OS 级隔离）
 *   task      查看/审阅/清理任务产物（worktree 差异、清理）
 *
 * 退出码：0 成功；1 失败/未完成；2 参数错误。
 */
import { stderr, stdout } from 'node:process';
import { ForgeError } from '@forgex/shared';
import { parseArgs, flagBool, flagsMissingValue, unknownFlags, type ParsedArgs } from './args.js';
import { chatCommand } from './commands/chat.js';
import { runCommand } from './commands/run.js';
import { doctorCommand } from './commands/doctor.js';
import { toolsCommand } from './commands/tools.js';
import { sessionsCommand } from './commands/sessions.js';
import { configCommand } from './commands/config.js';
import { connectCommand } from './commands/connect.js';
import { sandboxCommand } from './commands/sandbox.js';
import { taskCommand } from './commands/task.js';
import { VERSION } from './version.js';

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // 未知参数直接报错：以前 `--doctor` / `-x` 会被静默忽略并进入 chat
  const unknown = unknownFlags(args.flags);
  if (unknown.length > 0) {
    const rendered = unknown.map((name) => (name.length === 1 ? `-${name}` : `--${name}`)).join(', ');
    stderr.write(`未知参数: ${rendered}\n\n`);
    printHelp();
    return 2;
  }

  // `--limit` / `--config` 这类参数漏写取值时，不要静默回退到默认值
  const missingValue = flagsMissingValue(args.flags);
  if (missingValue.length > 0) {
    const rendered = missingValue.map((name) => `--${name}`).join(', ');
    stderr.write(`参数缺少取值: ${rendered}\n\n`);
    printHelp();
    return 2;
  }

  if (flagBool(args.flags, 'version') || flagBool(args.flags, 'v') || args.command === 'version') {
    stdout.write(`forgex ${VERSION}\n`);
    return 0;
  }
  if (flagBool(args.flags, 'help') || args.flags.h === true || args.command === 'help') {
    printHelp();
    return 0;
  }

  const cwd = process.cwd();

  // 兼容把子命令写成开关的输入（如 `forgex --connect`）：
  // parseArgs 会把未知 `--xxx` 当作布尔 flag，此时 command 仍是默认的 chat。
  if (flagBool(args.flags, 'connect')) {
    return await connectCommand(args, { cwd });
  }

  switch (args.command) {
    case 'chat':
      await chatCommand(args, { cwd });
      return 0;
    case 'run':
      return await runCommand(args, { cwd });
    case 'doctor':
      return await doctorCommand(args, { cwd });
    case 'tools':
      return toolsCommand();
    case 'sessions':
      return sessionsCommand(args, { cwd });
    case 'config':
      return configCommand(args, { cwd });
    case 'connect':
      return await connectCommand(args, { cwd });
    case 'sandbox':
      return await sandboxCommand(args, { cwd });
    case 'task':
      return await taskCommand(args, { cwd });
    default:
      stderr.write(`未知命令: ${args.command}\n\n`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  stdout.write(
    [
      `ForgeX ${VERSION} - 会话式 Coding Agent`,
      '',
      '用法：forgex <命令> [选项]',
      '',
      '命令：',
      '  connect            交互式连接模型（写入 ~/.forgex/config.json + 持久化 API Key）',
      '  chat [--plain] [--session <id>] [--config <path>] [--mode <模式>] [--plan]',
      '      进入交互式会话（TTY 下使用 Ink TUI，管道/--plain 使用纯文本）',
      '  run "<任务>" [--json] [--yes] [--session <id>] [--config <path>] [--mode <模式>] [--plan] [--worktree]',
      '      执行单次任务；支持从标准输入读取任务内容',
      '      --worktree  在独立 Git worktree + 分支中执行，产物可审阅（默认仍为原地执行）',
      '  doctor [--full] [--config <path>] [--mode <模式>]',
      '      检查 Node、工作区、数据库、rg/git、系统诊断能力',
      '  tools',
      '      列出内置工具及风险等级',
      '  sessions [--limit <n>]',
      '      查看历史会话',
      '  config [--config <path>] [--mode <模式>]',
      '      打印最终生效配置（API Key 脱敏）',
      '  sandbox [--json] [--config <path>]',
      '      打印沙箱能力：区分工作区隔离 / 资源限制 / OS 级隔离',
      '  task list|show|diff|clean|diagnose|reconcile|resume [<runId>] [--json]',
      '      审阅任务产物：diff 看 worktree 差异、clean 显式清理、',
      '      diagnose 中断诊断、reconcile 人工核对（--confirm-done/--confirm-retry/--block）、',
      '      resume 安全恢复（只有未开始步骤会自动调度，副作用未知的步骤必须先 reconcile）',
      '',
      '通用选项：',
      '  --mode <模式>      权限模式：readonly | standard | trusted | yolo，优先级高于配置文件与环境变量',
      '                     会话内也可用 /mode 或 Shift+Tab 切换',
      '  --plan             计划模式：只读分析并输出计划，不修改任何文件（适合 CI dry-run）',
      '  -h, --help         显示帮助',
      '  -v, --version      显示版本',
      '',
      '配置优先级：默认值 < 配置文件（forgex.config.json）< 环境变量 < 命令行参数',
      '常用环境变量：FORGEX_BASE_URL / FORGEX_API_KEY / FORGEX_MODEL / FORGEX_PERMISSION_MODE / FORGEX_WORKSPACE',
      '',
    ].join('\n'),
  );
}

function formatError(err: unknown): string {
  if (err instanceof ForgeError) return `[${err.code}] ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

void main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    stderr.write(`[错误] ${formatError(err)}\n`);
    process.exitCode = 1;
  });
