/**
 * forgex chat：交互式会话（默认命令）。
 *
 * stdin 与 stdout 都是 TTY 时启动 Ink TUI；否则（管道/CI/--plain）使用纯文本模式。
 * 两种模式共享同一套运行时与审批桥，行为一致，只有渲染方式不同。
 */
import React from 'react';
import { render } from 'ink';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { loadConfig } from '../config/load-config.js';
import { createRuntime } from '../runtime/create-runtime.js';
import { App } from '../ui/App.js';
import { ApprovalBridge } from '../ui/approval-bridge.js';
import { runPlainChat } from '../ui/plain.js';

export async function chatCommand(args: ParsedArgs, options: { cwd: string }): Promise<void> {
  const loaded = loadConfig({
    cwd: options.cwd,
    ...(flagString(args.flags, 'config') ? { configPath: flagString(args.flags, 'config')! } : {}),
  });

  if (!loaded.modelConfigured) {
    throw new Error(
      '尚未配置模型。请创建 forgex.config.json（参考 README）或设置环境变量 FORGEX_BASE_URL / FORGEX_MODEL。',
    );
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
  );

  await app.waitUntilExit();
  // 退出时取消仍未处理的审批，避免后台挂起 Promise
  bridge.cancel();
  runtime.close();
}
