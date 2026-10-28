/**
 * 本地假模型服务（OpenAI 兼容），供 `forgex run` 评测使用。
 *
 * 为什么用 HTTP 假服务而不是给 CLI 打桩：
 *   - 走的是生产代码路径（真 loadConfig → 真 provider → 真 AgentLoop → 真 ToolDispatcher）
 *   - 不需要改业务模块，也不需要 if (isTest) 这类分支
 *   - 完全离线：只监听 127.0.0.1，不发起任何外部请求
 *
 * 协议要点（见 packages/models/src/openai-compatible.ts）：
 *   - 计划生成请求**不带 tools** → 返回计划 JSON（纯文本）
 *   - Agent 轮次请求带 tools → 按"历史里的 assistant 消息条数"决定返回第几轮脚本
 *     用消息内容定位轮次，重试时同一请求得到同一响应，天然幂等
 */
import { createServer } from 'node:http';

/**
 * @typedef {object} Turn
 * @property {Array<{name: string, arguments: object|string}>} [toolCalls]
 * @property {string} [text]
 * @property {string} [finishReason]
 */

/**
 * 启动假模型服务。
 *
 * @param {object} spec
 * @param {object|string} [spec.plan]       计划对象（或原始字符串，用于构造非法 JSON）
 * @param {Turn[]} [spec.turns]             agent 轮次脚本
 * @param {Array<{name:string,args:object}>} [spec.planToolCalls] 计划阶段强行返回工具调用（负向用例）
 * @param {string} [spec.planText]          计划阶段直接返回的文本（优先于 plan）
 */
export async function startFakeModel(spec) {
  const requests = [];

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const assistantTurns = messages.filter((m) => m && m.role === 'assistant').length;
      const record = {
        kind: hasTools ? 'agent' : 'planning',
        turnIndex: hasTools ? assistantTurns : 0,
        toolCount: hasTools ? body.tools.length : 0,
        toolNames: hasTools ? body.tools.map((t) => t?.function?.name).filter(Boolean) : [],
        // 仅记录角色与内容长度，避免把大段提示词写进结果文件
        messageRoles: messages.map((m) => m?.role),
      };
      requests.push(record);

      if (!hasTools) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(planningResponse(spec)));
        return;
      }

      const turn = pickTurn(spec, assistantTurns);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(agentResponse(turn, assistantTurns)));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function planningResponse(spec) {
  if (spec.planToolCalls) {
    return completion({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: spec.planToolCalls.map((call, index) => ({
          id: `plan_call_${index}`,
          type: 'function',
          function: { name: call.name, arguments: toArgs(call.arguments) },
        })),
      },
      finishReason: 'tool_calls',
    });
  }
  const content =
    spec.planText !== undefined
      ? spec.planText
      : typeof spec.plan === 'string'
        ? spec.plan
        : JSON.stringify(spec.plan ?? { steps: [] });
  return completion({ message: { role: 'assistant', content }, finishReason: 'stop' });
}

/** 超出脚本长度时返回终止文本，避免死循环（也用于"模型声称完成"的对照） */
function pickTurn(spec, index) {
  const turns = spec.turns ?? [];
  if (index < turns.length) return turns[index];
  return { text: spec.fallbackText ?? '步骤已处理完毕。' };
}

function agentResponse(turn, index) {
  if (Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
    return completion({
      message: {
        role: 'assistant',
        content: turn.text ?? null,
        tool_calls: turn.toolCalls.map((call, i) => ({
          id: `call_${index}_${i}`,
          type: 'function',
          function: { name: call.name, arguments: toArgs(call.arguments) },
        })),
      },
      finishReason: turn.finishReason ?? 'tool_calls',
    });
  }
  return completion({
    message: { role: 'assistant', content: turn.text ?? '完成。' },
    finishReason: turn.finishReason ?? 'stop',
  });
}

function toArgs(args) {
  if (args === undefined || args === null) return '{}';
  return typeof args === 'string' ? args : JSON.stringify(args);
}

function completion({ message, finishReason }) {
  return {
    id: `chatcmpl-eval-${Math.random().toString(36).slice(2, 10)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'forgex-eval-fake',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
