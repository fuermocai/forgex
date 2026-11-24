/**
 * forgex chat：交互式会话（默认命令）。
 *
 * stdin 与 stdout 都是 TTY 时启动 Ink TUI；否则（管道/CI/--plain）使用纯文本模式。
 * 两种模式共享同一套运行时与审批桥，行为一致，只有渲染方式不同。
 *
 * 首次运行没有模型配置时，交互终端仍直接进入 TUI；用户可在会话内用
 * `/connect` 或 `/key` 配置凭据。非交互调用仍要求显式配置模型。
 */
import React from 'react';
import { render } from 'ink';
import { ForgeError } from '@forgex/shared';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { loadConfig } from '../config/load-config.js';
import { modelSetupHint } from '../config/setup-hint.js';
import { createRuntime } from '../runtime/create-runtime.js';
import { App } from '../ui/App.js';
import { ApprovalBridge } from '../ui/approval-bridge.js';
import { runPlainChat } from '../ui/plain.js';

export async function chatCommand(args: ParsedArgs, options: { cwd: string }): Promise<void> {
  const configFlag = flagString(args.flags, 'config');
  const modeFlag = flagString(args.flags, 'mode');
  const readConfig = () =>
    loadConfig({
      cwd: options.cwd,
      ...(configFlag ? { configPath: configFlag } : {}),
      ...(modeFlag ? { permissionMode: modeFlag } : {}),
    });

  const loaded = readConfig();

  if (!loaded.modelConfigured) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      throw new ForgeError('CONFIG_INVALID', modelSetupHint({ interactive: false }));
    }
  }

  const bridge = new ApprovalBridge();
  const runtime = createRuntime({
    cwd: options.cwd,
    loaded,
    approvalHandler: bridge.handler,
    ...(flagString(args.flags, 'session') ? { sessionId: flagString(args.flags, 'session')! } : {}),
  });

  // `--plan`：进入会话即处于计划模式（只读 + 只出方案），等价于进来先敲一次 /plan
  if (flagBool(args.flags, 'plan')) runtime.agent.setPlanMode(true);

  // 只看 stdout 会在 `echo "task" | forgex` 时误判：stdout 是终端、stdin 是管道，
  // Ink 拿不到输入会一直挂着。stdin 不是 TTY 时必须走纯文本。
  const plain = flagBool(args.flags, 'plain') || !process.stdout.isTTY || !process.stdin.isTTY;
  if (plain) {
    await runPlainChat(runtime, bridge);
    return;
  }

  const app = render(
    React.createElement(App, {
      runtime,
      bridge,
    }),
    // Ctrl+C 交给 App 处理：运行中先取消任务，空闲时再退出；
    // Ink 默认会在 Ctrl+C 时直接卸载，导致“取消任务”永远无法触发。
    { exitOnCtrlC: false },
  );

  await app.waitUntilExit();
  // 退出时取消仍未处理的审批，避免后台挂起 Promise
  bridge.cancel();
  await runtime.close();
}
