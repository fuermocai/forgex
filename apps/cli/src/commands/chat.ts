/**
 * forgex chat：交互式会话（默认命令）。
 *
 * stdin 与 stdout 都是 TTY 时启动 Ink TUI；否则（管道/CI/--plain）使用纯文本模式。
 * 两种模式共享同一套运行时与审批桥，行为一致，只有渲染方式不同。
 *
 * 首次运行（没有任何模型配置）且处于交互终端时，先自动进入 `forgex connect`
 * 向导，完成后原地继续启动会话，不再把用户丢在一条报错上。
 */
import React from 'react';
import { render } from 'ink';
import { stderr } from 'node:process';
import { ForgeError } from '@forgex/shared';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { loadConfig } from '../config/load-config.js';
import { modelSetupHint } from '../config/setup-hint.js';
import { createRuntime } from '../runtime/create-runtime.js';
import { App } from '../ui/App.js';
import { ApprovalBridge } from '../ui/approval-bridge.js';
import { runPlainChat } from '../ui/plain.js';
import { connectCommand } from './connect.js';

export async function chatCommand(args: ParsedArgs, options: { cwd: string }): Promise<void> {
  const configFlag = flagString(args.flags, 'config');
  const readConfig = () =>
    loadConfig({
      cwd: options.cwd,
      ...(configFlag ? { configPath: configFlag } : {}),
    });

  let loaded = readConfig();

  if (!loaded.modelConfigured) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      throw new ForgeError('CONFIG_INVALID', modelSetupHint({ interactive: false }));
    }

    stderr.write('尚未配置模型，先进入连接向导（Ctrl+C 可取消）\n\n');
    const code = await connectCommand(args, { cwd: options.cwd });
    if (code !== 0) {
      throw new ForgeError('CONFIG_INVALID', '模型连接未完成，已退出。稍后可重新执行：forgex connect');
    }

    // 向导会写入配置文件，并把 Key 注入当前进程环境变量，需要重新加载
    loaded = readConfig();
    if (!loaded.modelConfigured) {
      throw new ForgeError(
        'CONFIG_INVALID',
        `连接向导没有生成可用的模型配置（${loaded.configPath ?? '未找到配置文件'}），请检查保存路径后重试`,
      );
    }
  }

  const bridge = new ApprovalBridge();
  const runtime = createRuntime({
    cwd: options.cwd,
    loaded,
    approvalHandler: bridge.handler,
    ...(flagString(args.flags, 'session') ? { sessionId: flagString(args.flags, 'session')! } : {}),
  });

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
  runtime.close();
}
