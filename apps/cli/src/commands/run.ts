/**
 * forgex run：单次任务执行（适合脚本、CI、管道）。
 *
 * 输入来源：
 *   forgex run "分析当前项目结构"
 *   echo "检查 8090 端口" | forgex run
 *
 * 审批策略：
 *  - --yes：自动批准（仅限受信环境，风险自负）；
 *  - TTY：命令行交互确认；
 *  - 非 TTY 且未加 --yes：审批自动拒绝（安全默认）。
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { ForgeError, type AgentEvent } from '@forgex/shared';
import type { ApprovalHandler } from '@forgex/security';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { loadConfig } from '../config/load-config.js';
import { modelSetupHint } from '../config/setup-hint.js';
import { createRuntime } from '../runtime/create-runtime.js';

export async function runCommand(args: ParsedArgs, options: { cwd: string }): Promise<number> {
  const loaded = loadConfig({
    cwd: options.cwd,
    ...(flagString(args.flags, 'config') ? { configPath: flagString(args.flags, 'config')! } : {}),
    ...(flagString(args.flags, 'mode') ? { permissionMode: flagString(args.flags, 'mode')! } : {}),
  });
  if (!loaded.modelConfigured) {
    throw new ForgeError('CONFIG_INVALID', modelSetupHint({ interactive: false }));
  }

  const prompt = (args.positionals.join(' ').trim() || (await readStdin())).trim();
  if (!prompt) {
    throw new ForgeError('CONFIG_INVALID', '缺少任务内容：请传入 prompt 或通过标准输入提供');
  }

  const json = flagBool(args.flags, 'json');
  const autoApprove = flagBool(args.flags, 'yes');
  const interactive = Boolean(stdin.isTTY) && !json;
  const rl = interactive ? createInterface({ input: stdin, output: stderr, terminal: true }) : null;

  let approvalHandler: ApprovalHandler | undefined;
  if (autoApprove) {
    approvalHandler = () => true;
  } else if (rl) {
    approvalHandler = async (request) => {
      const preview = request.preview ? `\n  ${request.preview}` : '';
      const answer = await rl.question(`\n[审批] ${request.tool}: ${request.reason}${preview}\n批准执行？(y/N) `);
      return /^y(es)?$/i.test(answer.trim());
    };
  }

  const runtime = createRuntime({
    cwd: options.cwd,
    loaded,
    ...(approvalHandler ? { approvalHandler } : {}),
    ...(flagString(args.flags, 'session') ? { sessionId: flagString(args.flags, 'session')! } : {}),
  });

  // `--plan`：只读分析并输出计划，写操作会被策略直接拒绝，适合 CI 里做 dry-run
  if (flagBool(args.flags, 'plan')) runtime.agent.setPlanMode(true);

  let sawDelta = false;
  const off = runtime.agent.events.on((event: AgentEvent) => {
    if (json) return;
    switch (event.type) {
      case 'assistant:delta':
        sawDelta = true;
        stdout.write(event.text);
        break;
      case 'tool:start':
        stderr.write(`[工具] 调用 ${event.name}\n`);
        break;
      case 'tool:end':
        stderr.write(`[工具] ${event.name} ${event.result.ok ? '成功' : '失败'}：${event.result.summary}\n`);
        break;
      case 'notice':
        stderr.write(`[提示] ${event.message}\n`);
        break;
      case 'approval:resolved':
        stderr.write(`[审批] ${event.decision}\n`);
        break;
      default:
        break;
    }
  });

  try {
    const result = await runtime.agent.run(prompt, {});
    if (!json && !sawDelta && result.text) stdout.write(`${result.text}\n`);

    if (json) {
      stdout.write(
        `${JSON.stringify(
          {
            sessionId: result.sessionId,
            reason: result.reason,
            text: result.text,
            ...(result.error ? { error: result.error } : {}),
            metrics: result.metrics,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      stderr.write(
        `[完成] 结束原因=${result.reason} 用时=${result.metrics.totalMs}ms ` +
          `模型=${result.metrics.modelCalls} 次 工具=${result.metrics.toolCalls} 次 tokens=${result.metrics.totalTokens}\n`,
      );
    }
    return result.reason === 'completed' ? 0 : 1;
  } finally {
    off();
    rl?.close();
    runtime.close();
  }
}

/** 读取管道输入（非 TTY 时） */
async function readStdin(): Promise<string> {
  if (stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}
