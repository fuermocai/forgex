import { redactText, type ChatMessage } from '@forgex/shared';
import type { ForgeRuntime } from './create-runtime.js';
import type { WorkerSnapshot } from './subagent-manager.js';

const HUB_COMMAND = /^\/(?:workers|worker|steer|cancel-worker|retry-worker|wait-worker)(?:\s|$)/;

export function isWorkerHubCommand(text: string): boolean {
  return HUB_COMMAND.test(text.trim());
}

/** Execute one local worker-control command and return user-facing text. */
export async function dispatchWorkerHubCommand(runtime: ForgeRuntime, text: string): Promise<string> {
  const [command = '', id, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ').trim();
  const parentSessionId = runtime.agent.sessionId;

  switch (command) {
    case '/workers': {
      const workers = runtime.workers.listWorkers(parentSessionId);
      return workers.length === 0
        ? '当前会话没有 worker'
        : workers.map(formatWorkerRow).join('\n');
    }
    case '/worker': {
      if (!id) return '用法：/worker <id> [transcript]';
      const includeTranscript = arg === 'transcript';
      const worker = runtime.workers.getWorker(parentSessionId, id, includeTranscript);
      if (includeTranscript) return formatTranscript(worker.transcript ?? []);
      if (arg) return '用法：/worker <id> [transcript]';
      return [
        `${worker.id} [${worker.status}] ${worker.name} · attempt ${worker.attempt}`,
        `进度：${worker.progress || '暂无'}`,
        `摘要：${worker.summary || '暂无'}`,
        `产物：${worker.artifactPath ?? worker.worktreePath ?? '无'}`,
        `资源：${formatUsage(worker)}`,
        `Transcript：使用 /worker ${worker.id} transcript 查看`,
      ].join('\n');
    }
    case '/steer': {
      if (!id || !arg) return '用法：/steer <id> <指令>';
      const queuedId = runtime.workers.steerWorker(parentSessionId, id, arg);
      return `已向 ${id} 排队 steering：${queuedId}`;
    }
    case '/cancel-worker': {
      if (!id || rest.length > 0) return '用法：/cancel-worker <id>';
      return runtime.workers.cancelWorker(parentSessionId, id)
        ? `已请求取消 ${id}`
        : `${id} 已结束，无需取消`;
    }
    case '/retry-worker': {
      if (!id || rest.length > 0) return '用法：/retry-worker <id>';
      const retried = await runtime.workers.retryWorker(parentSessionId, id);
      return `已启动重试 ${retried.id}（${retried.name}，attempt ${retried.attempt}）`;
    }
    case '/wait-worker': {
      if (!id || rest.length > 0) return '用法：/wait-worker <id>';
      const completed = await runtime.workers.waitWorker(parentSessionId, id);
      return formatWorkerRow(completed);
    }
    default:
      return '未知 Agent Hub 命令';
  }
}

export function formatWorkerRow(worker: WorkerSnapshot): string {
  return `${worker.id} [${worker.status}] ${worker.name} — ${worker.progress || '暂无进度'} · ${formatUsage(worker)}`;
}

function formatUsage(worker: WorkerSnapshot): string {
  const usage = worker.usage;
  return usage
    ? `${usage.modelCalls} 模型调用 / ${usage.totalTokens} tokens / ${usage.toolCalls} 工具 / ${usage.durationMs}ms`
    : '资源统计暂无';
}

function formatTranscript(messages: ReadonlyArray<ChatMessage>): string {
  if (messages.length === 0) return 'worker transcript 为空';
  return messages.map((message) => {
    const content = redactText(message.content ?? '');
    const calls = message.tool_calls?.map((call) =>
      `${call.function.name}(${redactText(call.function.arguments)})`,
    ).join('\n');
    return [`[${message.role}]`, content, calls ? `tool calls:\n${calls}` : ''].filter(Boolean).join('\n');
  }).join('\n\n');
}
