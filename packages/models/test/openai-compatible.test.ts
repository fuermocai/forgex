import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForgeError, type ChatMessage } from '@forgex/shared';
import { OpenAICompatibleProvider, flushToolCalls, mergeToolCallDeltas } from '../src/openai-compatible.js';
import type { ModelConfig } from '../src/types.js';

/** 极简 OpenAI-compatible 假服务：只用于验证协议解析，不模拟业务语义 */
interface Scenario {
  handler: (req: IncomingMessage, body: any, res: ServerResponse) => void;
}

let server: Server | undefined;
let baseUrl = '';
let requests: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = [];
let scenario: Scenario;

function listen(handler: Scenario['handler']): Promise<void> {
  scenario = { handler };
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        requests.push({ headers: req.headers, body });
        scenario.handler(req, body, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}/v1`;
      resolve();
    });
  });
}

function sse(res: ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const config = (overrides: Partial<ModelConfig> = {}): ModelConfig => ({
  baseUrl,
  apiKey: 'sk-test-SECRETVALUE-1234567890',
  model: 'test-model',
  contextWindow: 8192,
  maxOutputTokens: 512,
  temperature: 0,
  timeoutMs: 2000,
  maxRetries: 1,
  stream: true,
  ...overrides,
});

const userMessage: ChatMessage = { role: 'user', content: 'hello' };

describe('OpenAICompatibleProvider', () => {
  beforeEach(() => {
    requests = [];
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('拼接流式 tool_calls 分片并保留 id', async () => {
    await listen((_req, _body, res) => {
      sse(res, [
        { choices: [{ delta: { role: 'assistant', content: '' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"pa' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
        { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
      ]);
    });

    const provider = new OpenAICompatibleProvider({ config: config() });
    const deltas: string[] = [];
    const response = await provider.chat(
      { messages: [userMessage], tools: [{ type: 'function', function: { name: 'read_file', description: 'd', parameters: {} } }] },
      { onDelta: (t) => deltas.push(t) },
    );

    expect(response.message.tool_calls?.[0]).toEqual({
      id: 'call_abc',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
    });
    expect(response.finishReason).toBe('tool_calls');
    expect(response.usage.totalTokens).toBe(18);
    expect(response.streamed).toBe(true);
    expect(requests[0]?.body.stream).toBe(true);
    expect(requests[0]?.body.tools?.[0]?.function?.name).toBe('read_file');
    // API Key 只出现在请求头
    expect(requests[0]?.headers.authorization).toBe('Bearer sk-test-SECRETVALUE-1234567890');
  });

  it('多个并行工具调用按 index 排序', async () => {
    await listen((_req, _body, res) => {
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: 'call_b', function: { name: 'grep_search', arguments: '{}' } },
                  { index: 0, id: 'call_a', function: { name: 'list_directory', arguments: '{}' } },
                ],
              },
            },
          ],
        },
        { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
      ]);
    });
    const provider = new OpenAICompatibleProvider({ config: config() });
    const res = await provider.chat({ messages: [userMessage] });
    expect(res.message.tool_calls?.map((c) => c.id)).toEqual(['call_a', 'call_b']);
  });

  it('累积文本增量并触发 onFirstToken', async () => {
    await listen((_req, _body, res) => {
      sse(res, [
        { choices: [{ delta: { content: '你' } }] },
        { choices: [{ delta: { content: '好' } }] },
        { choices: [{ finish_reason: 'stop', delta: {} }] },
      ]);
    });
    const provider = new OpenAICompatibleProvider({ config: config() });
    let first = 0;
    const res = await provider.chat({ messages: [userMessage] }, { onFirstToken: () => (first += 1) });
    expect(res.message.content).toBe('你好');
    expect(first).toBe(1);
  });

  it('非流式模式解析完整响应', async () => {
    await listen((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    });
    const provider = new OpenAICompatibleProvider({ config: config({ stream: false }) });
    const res = await provider.chat({ messages: [userMessage] });
    expect(res.message.content).toBe('ok');
    expect(res.usage.totalTokens).toBe(4);
    expect(res.streamed).toBe(false);
  });

  it('429 会重试且最终成功', async () => {
    let count = 0;
    await listen((_req, _body, res) => {
      count += 1;
      if (count === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{"error":"rate limited"}');
        return;
      }
      sse(res, [{ choices: [{ delta: { content: 'retried' } }] }, { choices: [{ finish_reason: 'stop', delta: {} }] }]);
    });
    const provider = new OpenAICompatibleProvider({ config: config() });
    const res = await provider.chat({ messages: [userMessage] });
    expect(res.message.content).toBe('retried');
    expect(count).toBe(2);
  });

  it('4xx 认证错误不重试', async () => {
    let count = 0;
    await listen((_req, _body, res) => {
      count += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid key"}');
    });
    const provider = new OpenAICompatibleProvider({ config: config() });
    const err = (await provider.chat({ messages: [userMessage] }).catch((e) => e)) as ForgeError;
    expect(err).toBeInstanceOf(ForgeError);
    expect(err.retryable).toBe(false);
    expect(count).toBe(1);
    // 错误信息里不得出现 API Key
    expect(err.message).not.toContain('sk-test-SECRETVALUE');
  });

  it('超时抛出 PROVIDER_TIMEOUT 并有限重试', async () => {
    let count = 0;
    await listen((_req, _body, _res) => {
      count += 1;
      // 不返回，触发客户端超时
    });
    const provider = new OpenAICompatibleProvider({
      config: config({ timeoutMs: 60, maxRetries: 1 }),
    });
    const err = (await provider.chat({ messages: [userMessage] }).catch((e) => e)) as ForgeError;
    expect(err.code).toBe('PROVIDER_TIMEOUT');
    expect(count).toBe(2);
  });

  it('用户取消抛出 PROVIDER_ABORTED', async () => {
    await listen((_req, _body, _res) => {
      /* 挂起 */
    });
    const provider = new OpenAICompatibleProvider({ config: config({ maxRetries: 3 }) });
    const controller = new AbortController();
    const promise = provider.chat({ messages: [userMessage], signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const err = (await promise.catch((e) => e)) as ForgeError;
    expect(err.code).toBe('PROVIDER_ABORTED');
  });
});

describe('tool call 累积纯函数', () => {
  it('merge 与 flush 保持顺序与参数完整性', () => {
    const accs = new Map<number, { args: string; id?: string; name?: string }>();
    mergeToolCallDeltas(accs, [{ index: 0, id: 'x', function: { name: 'a', arguments: '{"k":' } }]);
    mergeToolCallDeltas(accs, [{ index: 0, function: { arguments: '1}' } }]);
    const calls = flushToolCalls(accs);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.arguments).toBe('{"k":1}');
  });
});
