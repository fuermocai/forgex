/**
 * 纯文本交互模式（默认，也用于非 TTY / CI）。
 *
 * 特点：
 *  - 使用 readline 读取输入，流式输出模型增量；
 *  - 工具调用、审批、提示都以纯文本行展示，不依赖终端控制序列；
 *  - Ctrl+C 只取消当前一轮，再次 Ctrl+C 退出。
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { formatMs, type AgentEvent } from '@forgex/shared';
import type { ForgeRuntime } from '../runtime/create-runtime.js';
import { MODEL_PRESETS } from '../runtime/connect-core.js';
import { switchModel } from '../runtime/model-switch.js';
import { applyApiKey, currentApiKeyEnv } from '../runtime/api-key.js';
import { parsePermissionMode, permissionModeHelp, permissionModeList } from '../config/permission-mode.js';
import type { ApprovalBridge } from './approval-bridge.js';

export async function runPlainChat(runtime: ForgeRuntime, bridge: ApprovalBridge): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  const agent = runtime.agent;

  bridge.onRequest((request) => {
    void (async () => {
      const command = request.preview ? `\n  ${request.preview}` : '';
      const answer = await rl.question(
        `\n[审批] ${request.tool}（${request.riskLevel}）: ${request.reason}${command}\n批准执行？(y/N) `,
      );
      bridge.respond(/^y(es)?$/i.test(answer.trim()));
    })();
  });

  const streamState = { streamed: false };
  const off = agent.events.on((event) => printEvent(event, streamState));

  let busy = false;
  let controller: AbortController | null = null;

  rl.on('SIGINT', () => {
    if (busy && controller) {
      controller.abort();
      stdout.write('\n[提示] 已请求取消当前任务，等待工具安全退出…\n');
      return;
    }
    rl.close();
  });

  stdout.write(
    [
      'ForgeX 交互模式（纯文本）',
      `模型: ${runtime.config.model.model}  工作区: ${runtime.settings.workspaceRoots[0]}`,
      `权限模式: ${runtime.settings.mode}  会话: ${agent.sessionId}`,
      ...(runtime.config.model.apiKey
        ? []
        : [`未检测到 API Key：输入 /key <API Key> 填写，或 export ${currentApiKeyEnv(runtime)}=...`]),
      '输入 /help 查看命令，Ctrl+C 取消当前任务，再按一次退出。',
      '',
    ].join('\n'),
  );

  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;

    if (text === '/exit' || text === '/quit') break;
    if (text === '/help') {
      printHelp();
      continue;
    }
    if (text === '/session') {
      stdout.write(`会话 id: ${agent.sessionId}\n`);
      continue;
    }
    if (text === '/context') {
      stdout.write(`当前上下文估算: ${agent.contextTokens()} tokens\n`);
      continue;
    }
    if (text === '/plan') {
      agent.setPlanMode(!agent.isPlanMode);
      stdout.write(
        agent.isPlanMode
          ? `[提示] 已进入计划模式（权限 ${agent.permissionMode}）：只读分析并输出计划\n`
          : `[提示] 已退出计划模式（权限 ${agent.permissionMode}）\n`,
      );
      continue;
    }
    if (text === '/mode' || text.startsWith('/mode ')) {
      const target = text.slice('/mode'.length).trim().toLowerCase();
      if (!target) {
        stdout.write(`${permissionModeHelp(agent.permissionMode, agent.isPlanMode)}\n`);
        continue;
      }
      if (target === 'plan' || target === 'agent') {
        const wantPlan = target === 'plan';
        if (wantPlan === agent.isPlanMode) {
          stdout.write(`[提示] ${wantPlan ? '已处于计划模式' : `当前已是执行模式（${agent.permissionMode}）`}\n`);
          continue;
        }
        // 切换结果由 agent 的 notice 事件统一打印，避免这里和事件各输出一遍
        agent.setPlanMode(wantPlan);
        continue;
      }
      const mode = parsePermissionMode(target);
      if (!mode) {
        stdout.write(`[错误] 未知权限模式: ${target}（可选：${permissionModeList()}，或 plan / agent）\n`);
        continue;
      }
      agent.setPermissionMode(mode);
      continue;
    }
    if (text === '/models' || text.startsWith('/models ')) {
      const target = text.slice('/models'.length).trim();
      if (!target) {
        stdout.write(
          [
            '可用模型：',
            ...MODEL_PRESETS.map(
              (preset, index) =>
                `  ${index + 1}. ${preset.model} — ${preset.label}${preset.model === agent.modelName ? '（当前）' : ''}`,
            ),
            `当前: ${agent.modelName}`,
            '切换: /models <模型名>',
            '',
          ].join('\n'),
        );
        continue;
      }
      try {
        const result = switchModel(runtime, target);
        stdout.write(
          `[提示] 已切换模型: ${result.model} @ ${result.baseUrl}` +
            (result.saved ? `（已写入 ${result.savedPath ?? '配置文件'}）` : '（仅本次会话生效）') +
            '\n',
        );
        if (!result.keyReady) {
          stdout.write(
            `[提示] 该模型需要 ${result.apiKeyEnv ?? 'API Key'}：用 /key <API Key> 填一个（换提供方后旧 Key 不沿用）\n`,
          );
        }
      } catch (err) {
        stdout.write(`[错误] 切换模型失败: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      continue;
    }
    if (text === '/key' || text.startsWith('/key ')) {
      const key = text.slice('/key'.length).trim();
      const envName = currentApiKeyEnv(runtime);
      if (!key) {
        stdout.write(
          [
            `API Key 状态：${runtime.config.model.apiKey ? '已配置' : '未配置'}（环境变量 ${envName}）`,
            '用法：/key <API Key>   直接替换当前模型的 Key',
            `      export ${envName}=...   在 shell 里设置（优先级最高）`,
            '',
          ].join('\n'),
        );
        continue;
      }
      try {
        const result = applyApiKey(runtime, key);
        stdout.write(`[提示] API Key 已更新（${result.masked}）\n`);
        stdout.write(
          result.saved
            ? `[提示] 已保存到 ${result.hint}（变量 ${result.envName}），重开会话自动读取\n`
            : `[提示] 未能自动保存：${result.hint}\n`,
        );
        if (!result.configSaved) {
          stdout.write('[提示] 配置文件写入失败：重启后模型与 baseUrl 可能回到默认值，请检查 ~/.forgex 是否可写\n');
        }
      } catch (err) {
        stdout.write(`[错误] 更新 API Key 失败: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      continue;
    }
    if (text === '/connect') {
      stdout.write('[提示] 纯文本模式不支持交互式向导，可用 /key <API Key> 直接填写；完整向导请运行：forgex connect\n');
      continue;
    }

    busy = true;
    controller = new AbortController();
    try {
      const result = await agent.run(text, { signal: controller.signal });
      const metrics = result.metrics;
      const status = result.reason === 'completed' ? '完成' : result.reason === 'aborted' ? '已取消' : '未完成';
      stdout.write(
        `\n[${status}] 结束原因=${result.reason} 用时=${formatMs(metrics.totalMs)} ` +
          `模型=${metrics.modelCalls} 次 工具=${metrics.toolCalls} 次 ` +
          `tokens=${metrics.totalTokens}\n`,
      );
      if (result.reason !== 'completed') {
        if (result.error) stdout.write(`[错误] ${result.error.code}: ${result.error.message}\n`);
        else stdout.write(`[提示] 本轮没有完成，请根据结束原因决定是否继续。\n`);
      }
    } catch (err) {
      stdout.write(`[错误] ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      busy = false;
      controller = null;
    }
  }

  off();
  rl.close();
  runtime.close();
}

function printEvent(event: AgentEvent, state: { streamed: boolean }): void {
  switch (event.type) {
    case 'user:message':
      state.streamed = false;
      break;
    case 'assistant:delta':
      state.streamed = true;
      stdout.write(event.text);
      break;
    case 'assistant:message':
      // 非流式响应不会产生 delta，这里补打完整文本，避免"模型回答了但终端没显示"
      if (event.text && !state.streamed) stdout.write(`${event.text}\n`);
      else if (event.text) stdout.write('\n');
      state.streamed = false;
      break;
    case 'tool:start':
      stdout.write(`\n[工具] 调用 ${event.name}\n`);
      break;
    case 'tool:end':
      stdout.write(
        `[工具] ${event.name} ${event.result.ok ? '成功' : '失败'} (${formatMs(event.result.durationMs)}) ` +
          `${event.result.summary}\n`,
      );
      break;
    case 'notice':
      stdout.write(`[提示] ${event.message}\n`);
      break;
    case 'approval:resolved':
      stdout.write(`[审批] ${event.decision === 'approved' ? '已批准' : '已拒绝/超时'}\n`);
      break;
    default:
      break;
  }
}

function printHelp(): void {
  stdout.write(
    [
      '可用命令：',
      '  /models [模型名]  查看可用模型 / 切换模型',
      '  /key <API Key>    直接填写或替换当前模型的 API Key',
      '  /mode [模式]      查看或切换权限模式（/mode plan、/mode agent 控制计划模式）',
      '  /plan             进入或退出计划模式（只读，只出计划）',
      '  /connect          提示退出后运行 forgex connect（完整向导）',
      '  /session          显示当前会话 id',
      '  /context          显示上下文 token 估算',
      '  /exit             退出',
      '',
    ].join('\n'),
  );
}
