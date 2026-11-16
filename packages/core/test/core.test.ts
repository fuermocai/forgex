/**
 * Core 集成测试。
 *
 * 不使用 Mock 的"假工具结果"：这里启动一个本地 HTTP 服务模拟
 * OpenAI-compatible 模型，工具是真实的文件系统与真实读取逻辑，
 * 会话持久化使用真实的 JSONL 事件文件。
 *
 * 覆盖：
 *  - 工具调用闭环 + tool_call/tool_result 严格配对
 *  - 审批拒绝（写文件）真实阻断
 *  - 重复调用检测
 *  - 取消后的协议完整性
 *  - 上下文压缩与协议修复
 *  - 会话恢复
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateMessageProtocol,
  type AgentEvent,
  type PolicySettings,
  type ToolCall,
} from '@forgex/shared';
import { createProvider, ModelRouter, RoutedModelProvider, type ModelProvider } from '@forgex/models';
import {
  ApprovalManager,
  AuditLogger,
  MemoryAuditSink,
  WorkspaceGuard,
  createDefaultPolicySettings,
} from '@forgex/security';
import { ToolRegistry, createBuiltinTools } from '@forgex/tools';
import { Agent, ContextManager, SessionStore, repairProtocol, type AgentRunResult, type ForgeExtension } from '../src/index.js';

/* ------------------------------------------------------------------ */
/* 本地假模型服务                                                      */
/* ------------------------------------------------------------------ */

interface ModelReply {
  content?: string | null;
  toolCalls?: ToolCall[];
  finishReason?: string;
  delayMs?: number;
}

type Responder = (body: ModelRequestBody, index: number) => ModelReply | Promise<ModelReply>;

interface ModelRequestBody {
  messages: Array<{ role: string; content: string | null; tool_call_id?: string; tool_calls?: ToolCall[] }>;
  tools?: Array<{ function: { name: string } }>;
}

interface FakeModel {
  baseUrl: string;
  requests: ModelRequestBody[];
  server: Server;
  close: () => Promise<void>;
}

async function startFakeModel(responder: Responder): Promise<FakeModel> {
  const requests: ModelRequestBody[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      void (async () => {
        try {
          const body = JSON.parse(raw || '{}') as ModelRequestBody;
          requests.push(body);
          const reply = await responder(body, requests.length - 1);
          if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
          if (res.writableEnded || res.destroyed) return;
          const toolCalls = (reply.toolCalls ?? []).map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          }));
          const payload = {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: reply.content ?? (toolCalls.length > 0 ? null : ''),
                  ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: reply.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch (err) {
          if (!res.writableEnded && !res.destroyed) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** 取出某次请求里最后一条 tool 消息的内容 */
function lastToolContent(request: ModelRequestBody | undefined): string {
  if (!request) return '';
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role === 'tool') return message.content ?? '';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 测试夹具                                                            */
/* ------------------------------------------------------------------ */

let root: string;
let settings: PolicySettings;
let store: SessionStore;
let fake: FakeModel | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forgex-core-'));
  await writeFile(join(root, 'a.ts'), 'export const answer = 42;\n// 中文注释\n', 'utf8');
  settings = createDefaultPolicySettings({
    workspaceRoots: [root],
    mode: 'standard',
    requireApprovalForWrite: true,
    requireApprovalForExecute: true,
  });
  store = new SessionStore(':memory:');
});

afterEach(async () => {
  await fake?.close();
  fake = null;
  store.close();
  await rm(root, { recursive: true, force: true });
});

interface AgentFixture {
  agent: Agent;
  events: AgentEvent[];
  auditSink: MemoryAuditSink;
}

function createAgent(options: {
  baseUrl: string;
  approve?: boolean;
  sessionId?: string;
  maxIterations?: number;
  repeatThreshold?: number;
  contextWindow?: number;
  provider?: ModelProvider;
  extensions?: ReadonlyArray<ForgeExtension>;
}): AgentFixture {
  const provider = options.provider ?? createProvider({
    baseUrl: options.baseUrl,
    model: 'fake-model',
    contextWindow: options.contextWindow ?? 8192,
    maxOutputTokens: 1024,
    temperature: 0,
    timeoutMs: 5000,
    maxRetries: 0,
    stream: false,
  });

  const auditSink = new MemoryAuditSink(500);
  const audit = new AuditLogger({ sinks: [auditSink, store] });
  const approvals = new ApprovalManager({
    handler: () => options.approve === true,
    timeoutMs: 1000,
  });
  const workspace = new WorkspaceGuard({
    roots: settings.workspaceRoots,
    writableRoots: settings.writableRoots,
    protectedPaths: settings.protectedPaths,
  });

  const agent = new Agent({
    provider,
    registry: new ToolRegistry(createBuiltinTools()),
    settings,
    workspace,
    approvals,
    audit,
    store,
    cwd: root,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.maxIterations ? { maxIterations: options.maxIterations } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  });

  const events: AgentEvent[] = [];
  agent.events.on((event) => events.push(event));
  return { agent, events, auditSink };
}

function assertProtocolComplete(result: AgentRunResult, fixture: AgentFixture): void {
  expect(validateMessageProtocol(fixture.agent.messages())).toEqual([]);
  expect(validateMessageProtocol(store.getMessages(result.sessionId))).toEqual([]);
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

describe('AgentLoop 工具闭环', () => {
  it('模型调用 read_file，真实读取文件并把结果回传模型', async () => {
    fake = await startFakeModel((_body, index) => {
      if (index === 0) {
        return { toolCalls: [toolCall('call_1', 'read_file', { path: 'a.ts' })] };
      }
      const content = lastToolContent(fake!.requests[index]);
      return { content: content.includes('answer = 42') ? '已确认文件内容包含 answer = 42' : '未找到内容' };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl });
    const result = await fixture.agent.run('请读取 a.ts 并确认内容');

    expect(result.reason).toBe('completed');
    expect(result.text).toContain('answer = 42');
    expect(result.toolCalls).toBe(1);
    expect(fake.requests).toHaveLength(2);
    expect(result.metrics.modelCalls).toBe(2);
    expect(result.metrics.toolCalls).toBe(1);
    expect(result.metrics.toolFailures).toBe(0);
    assertProtocolComplete(result, fixture);

    // 会话真实落库：user / assistant(tool_calls) / tool / assistant
    const messages = store.getMessages(result.sessionId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1]!.tool_calls?.[0]!.id).toBe('call_1');
    expect(messages[2]!.tool_call_id).toBe('call_1');

    // 审计链路：tool_call / policy_decision / tool_result 都存在
    const types = fixture.auditSink.all.map((event) => event.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('policy_decision');
    expect(types).toContain('tool_result');
    // 模型可见工具声明已注入
    expect(fake.requests[0]!.tools?.map((spec) => spec.function.name)).toContain('read_file');
  });

  it('审计日志中的工具输出经过脱敏', async () => {
    await writeFile(join(root, 'secret.txt'), 'token = sk-abcdefgh12345678\npassword: hunter2\n', 'utf8');
    fake = await startFakeModel((_body, index) => {
      if (index === 0) {
        return { toolCalls: [toolCall('call_secret', 'read_file', { path: 'secret.txt' })] };
      }
      return { content: '已读取' };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl });
    await fixture.agent.run('读取 secret.txt');

    const resultEvent = fixture.auditSink.all.find((event) => event.type === 'tool_result');
    expect(resultEvent).toBeDefined();
    const serialized = JSON.stringify(resultEvent);
    // 原始凭证不能出现在审计日志里，但要保留可检索的占位符
    expect(serialized).not.toContain('sk-abcdefgh12345678');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).toContain('***');
  });

  it('未注册工具返回结构化错误，循环仍可正常结束', async () => {
    fake = await startFakeModel((_body, index) => {
      if (index === 0) return { toolCalls: [toolCall('call_x', 'delete_everything', {})] };
      return { content: `工具错误: ${lastToolContent(fake!.requests[index]).includes('TOOL_NOT_FOUND')}` };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl });
    const result = await fixture.agent.run('尝试调用不存在的工具');

    expect(result.reason).toBe('completed');
    expect(result.text).toContain('true');
    expect(result.metrics.toolFailures).toBe(1);
    assertProtocolComplete(result, fixture);
  });
});

describe('安全链路', () => {
  it('写文件未获审批时真实阻断，文件内容不变', async () => {
    fake = await startFakeModel((_body, index) => {
      if (index === 0) {
        return {
          toolCalls: [
            toolCall('call_w', 'edit_file', { path: 'a.ts', oldText: 'answer = 42', newText: 'answer = 43' }),
          ],
        };
      }
      const denied = lastToolContent(fake!.requests[index]).includes('APPROVAL_DENIED');
      return { content: denied ? '操作被拒绝，未修改文件' : '操作已执行' };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl, approve: false });
    const result = await fixture.agent.run('把 answer 改成 43');

    expect(result.reason).toBe('completed');
    expect(result.text).toContain('拒绝');
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toContain('answer = 42');
    expect(result.metrics.approvals).toBe(1);
    expect(fixture.auditSink.all.some((event) => event.type === 'approval' && event.decision === 'denied')).toBe(true);
    assertProtocolComplete(result, fixture);
  });

  it('审批通过后执行写入，并展示真实 diff', async () => {
    fake = await startFakeModel((_body, index) => {
      if (index === 0) {
        return {
          toolCalls: [
            toolCall('call_w', 'edit_file', { path: 'a.ts', oldText: 'answer = 42', newText: 'answer = 43' }),
          ],
        };
      }
      const content = lastToolContent(fake!.requests[index]);
      return { content: content.includes('answer = 43') ? 'diff 已应用' : 'diff 缺失' };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl, approve: true });
    const result = await fixture.agent.run('把 answer 改成 43');

    expect(result.text).toContain('diff 已应用');
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toContain('answer = 43');
    assertProtocolComplete(result, fixture);
  });

  it('高危命令被策略直接拒绝，不进入审批', async () => {
    fake = await startFakeModel((_body, index) => {
      if (index === 0) {
        return { toolCalls: [toolCall('call_cmd', 'run_command', { program: 'shutdown', args: ['/s'] })] };
      }
      const content = lastToolContent(fake!.requests[index]);
      return { content: content.includes('POLICY_DENIED') ? '命令被策略拒绝' : '未被拒绝' };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl, approve: true });
    const result = await fixture.agent.run('关闭系统');

    expect(result.text).toContain('策略拒绝');
    expect(result.metrics.approvals).toBe(0);
    assertProtocolComplete(result, fixture);
  });
});

describe('计划模式', () => {
  it('开启后追加规划提示、权限降为 readonly，写操作被拒绝；关闭后恢复', async () => {
    fake = await startFakeModel((_body, index) => {
      if (index === 0) {
        return {
          toolCalls: [
            toolCall('call_plan', 'edit_file', {
              path: 'a.ts',
              oldText: 'answer = 42',
              newText: 'answer = 43',
            }),
          ],
        };
      }
      const content = lastToolContent(fake!.requests[index]);
      return { content: content.includes('POLICY_DENIED') ? '写操作被计划模式拒绝' : content };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl, approve: true });
    fixture.agent.setPlanMode(true);

    expect(fixture.agent.isPlanMode).toBe(true);
    expect(fixture.agent.permissionMode).toBe('readonly');
    expect(fixture.events.some((event) => event.type === 'notice' && event.message.includes('计划模式'))).toBe(true);

    const result = await fixture.agent.run('把 answer 改成 43');
    expect(result.text).toContain('拒绝');
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toContain('answer = 42');
    // 计划模式在策略层直接拒绝，不应进入人工审批
    expect(result.metrics.approvals).toBe(0);
    expect(fake.requests[0]!.messages[0]!.content).toContain('计划模式');
    expect(fixture.agent.contextTokens()).toBeGreaterThan(0);

    fixture.agent.setPlanMode(false);
    expect(fixture.agent.isPlanMode).toBe(false);
    expect(fixture.agent.permissionMode).toBe('standard');
    assertProtocolComplete(result, fixture);

    // 直接设置权限模式：计划模式下切换必须先真正退出计划模式，
    // 否则 readonly 会被 setPlanMode 的还原逻辑覆盖，用户以为切了其实没生效
    fixture.agent.setPlanMode(true);
    fixture.agent.setPermissionMode('trusted');
    expect(fixture.agent.isPlanMode).toBe(false);
    expect(fixture.agent.permissionMode).toBe('trusted');

    // 运行中直接升降权限也要立刻反映在 permissionMode 上（TUI 的 Shift+Tab / /mode 依赖）
    fixture.agent.setPermissionMode('yolo');
    expect(fixture.agent.permissionMode).toBe('yolo');
    fixture.agent.setPermissionMode('readonly');
    expect(fixture.agent.permissionMode).toBe('readonly');
  });
});

describe('循环与取消', () => {
  it('运行中收到 steering 时，在工具批次结束后加入上下文并继续', async () => {
    fake = await startFakeModel((body, index) => {
      if (index === 0) return { toolCalls: [toolCall('steer_call', 'read_file', { path: 'a.ts' })] };
      const hasSteering = body.messages.some((message) => message.role === 'user' && message.content?.includes('改用接口 B'));
      return { content: hasSteering ? '已按接口 B 调整' : '没有收到新指令' };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl });
    fixture.agent.events.on((event) => {
      if (event.type === 'tool:start' && event.callId === 'steer_call') {
        fixture.agent.enqueueInput('改用接口 B', 'steer');
      }
    });
    const result = await fixture.agent.run('查看代码');

    expect(result.reason).toBe('completed');
    expect(result.text).toContain('接口 B');
    expect(fake.requests).toHaveLength(2);
    expect(fixture.agent.listQueuedInputs()).toHaveLength(0);
    expect(fixture.agent.messages().some((message) => message.role === 'user' && message.content === '改用接口 B')).toBe(true);
    assertProtocolComplete(result, fixture);
  });

  it('follow-up 在当前任务结束后执行，且队列项可在开始前移除', async () => {
    fake = await startFakeModel((_body, index) => ({ content: index === 0 ? '第一项完成' : '后续项完成', delayMs: 60 }));
    const fixture = createAgent({ baseUrl: fake.baseUrl });
    const running = fixture.agent.run('先处理当前任务');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const queued = fixture.agent.enqueueInput('运行完后总结', 'followup');
    const removed = fixture.agent.enqueueInput('不要执行这条', 'followup');
    expect(fixture.agent.removeQueuedInput(removed.id)).toBe(true);

    const result = await running;
    expect(result.reason).toBe('completed');
    expect(result.text).toBe('后续项完成');
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.messages.some((message) => message.role === 'user' && message.content?.includes('运行完后总结'))).toBe(true);
    expect(fixture.agent.listQueuedInputs()).toHaveLength(0);
    expect(fixture.events.some((event) => event.type === 'input:dequeued' && event.id === queued.id)).toBe(true);
    expect(fixture.events.some((event) => event.type === 'input:removed' && event.id === removed.id)).toBe(true);
  });

  it('连续相同工具调用触发循环检测，终止后仍补齐 tool 结果', async () => {
    fake = await startFakeModel((_body, index) => {
      // 永远返回同一个工具与同一组参数，模拟模型死循环
      return { toolCalls: [toolCall(`call_${index}`, 'read_file', { path: 'a.ts' })] };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl, maxIterations: 10 });
    const result = await fixture.agent.run('反复读取文件');

    expect(result.reason).toBe('loop_detected');
    expect(fake.requests).toHaveLength(3);
    // 前两次真实执行，第三次被判定循环后合成失败结果
    expect(result.toolCalls).toBe(3);
    assertProtocolComplete(result, fixture);

    const messages = store.getMessages(result.sessionId);
    const assistantCalls = messages.filter((m) => m.role === 'assistant' && m.tool_calls);
    const toolResults = messages.filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(assistantCalls.length);
    expect(toolResults[2]!.content).toContain('LOOP_DETECTED');
  });

  it('取消请求后返回 aborted，会话数据仍保持协议完整', async () => {
    fake = await startFakeModel(() => ({ content: '迟到的回答', delayMs: 2000 }));

    const fixture = createAgent({ baseUrl: fake.baseUrl });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);

    const result = await fixture.agent.run('请回答一个很慢的问题', { signal: controller.signal });

    expect(result.reason).toBe('aborted');
    expect(validateMessageProtocol(store.getMessages(result.sessionId))).toEqual([]);
    // 用户消息已持久化，取消不会破坏会话
    expect(store.getMessages(result.sessionId)[0]!.role).toBe('user');
  });

  it('达到最大迭代次数时安全结束', async () => {
    fake = await startFakeModel((_body, index) => {
      // 每次调用不同工具参数，避免触发重复检测
      return { toolCalls: [toolCall(`call_${index}`, 'list_directory', { path: '.' })] };
    });

    const fixture = createAgent({ baseUrl: fake.baseUrl, maxIterations: 2 });
    const result = await fixture.agent.run('不断浏览目录');

    expect(result.reason).toBe('max_iterations');
    expect(result.iterations).toBe(2);
    assertProtocolComplete(result, fixture);
  });
});

describe('上下文管理', () => {
  it('摘要压缩保留最新用户输入，并把摘要写成独立上下文记录', () => {
    const manager = new ContextManager({ systemPrompt: 'system', contextWindow: 8192, maxOutputTokens: 1024 });
    manager.append({ role: 'user', content: '旧目标：实现导出功能' });
    manager.append({ role: 'assistant', content: '已定位导出入口' });
    manager.append({ role: 'user', content: '当前输入：修复 CSV 转义' });
    const source = manager.compactionSource();

    expect(source?.text).toContain('旧目标');
    expect(manager.compactWithSummary('当前目标：修复 CSV 转义\n约束：兼容旧格式')).toBe(true);
    expect(manager.raw).toHaveLength(2);
    expect(manager.raw[0]!.content).toContain('当前目标');
    expect(manager.raw[1]!.content).toBe('当前输入：修复 CSV 转义');
  });

  it('超预算时压缩历史，且不破坏 tool_call 与 tool_result 配对', () => {
    const manager = new ContextManager({
      systemPrompt: '你是测试助手',
      contextWindow: 1800,
      maxOutputTokens: 256,
      safetyMarginTokens: 0,
    });

    const big = '日志内容 '.repeat(400);
    for (let i = 0; i < 8; i += 1) {
      manager.append({ role: 'user', content: `第 ${i} 个问题：请分析日志` });
      manager.append({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c_${i}`, type: 'function', function: { name: 'read_logs', arguments: '{}' } }],
      });
      manager.append({ role: 'tool', tool_call_id: `c_${i}`, name: 'read_logs', content: big });
      manager.append({ role: 'assistant', content: `第 ${i} 轮结论：${'结论'.repeat(200)}` });
    }
    manager.append({ role: 'user', content: '最后的问题' });

    const built = manager.build();
    expect(built.compressed).toBe(true);
    expect(built.dropped).toBeGreaterThan(0);
    expect(validateMessageProtocol(built.messages)).toEqual([]);
    // 历史压缩后仍必须以 user 开头
    expect(built.messages[1]!.role).toBe('user');
    // 每条 assistant.tool_calls 都应有对应的 tool 消息
    for (const message of built.messages) {
      if (message.role === 'assistant' && message.tool_calls) {
        for (const call of message.tool_calls) {
          expect(built.messages.some((m) => m.role === 'tool' && m.tool_call_id === call.id)).toBe(true);
        }
      }
    }
  });

  it('协议修复：清理孤立 tool 结果并补齐缺失结果', () => {
    const repaired = repairProtocol([
      { role: 'user', content: '你好' },
      { role: 'tool', tool_call_id: 'orphan', content: '孤立结果' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'missing', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
    ]);

    expect(repaired.changed).toBe(true);
    expect(repaired.dropped).toBe(1);
    expect(repaired.repaired).toBe(1);
    expect(validateMessageProtocol(repaired.messages)).toEqual([]);
    expect(repaired.messages.some((m) => m.tool_call_id === 'missing')).toBe(true);
  });
});

describe('会话恢复', () => {
  it('通过角色路由运行并恢复会话角色与实际模型', async () => {
    fake = await startFakeModel(() => ({ content: 'role routed' }));
    const makeRoutedProvider = () => {
      const router = new ModelRouter();
      const primaryConfig = {
        baseUrl: fake!.baseUrl, model: 'primary-model', contextWindow: 8192,
        maxOutputTokens: 1024, temperature: 0, timeoutMs: 5000, maxRetries: 0, stream: false,
      };
      const unavailablePrimary: ModelProvider = {
        name: 'primary-model',
        config: primaryConfig,
        async chat() { throw new Error('primary temporary outage'); },
      };
      router.register({
        id: 'primary-id',
        provider: unavailablePrimary,
        capabilities: ['chat', 'coding'], tier: 1, available: true, contextWindow: 8192,
      });
      router.register({
        id: 'backup-id',
        provider: createProvider({ ...primaryConfig, model: 'backup-model' }),
        capabilities: ['chat', 'coding'], tier: 2, available: true, contextWindow: 8192,
      });
      return new RoutedModelProvider(router, { default: 'primary-id', coding: 'primary-id' });
    };

    const first = createAgent({ baseUrl: fake.baseUrl, provider: makeRoutedProvider() });
    first.agent.setModelRole('coding');
    const result = await first.agent.run('use coding route');

    expect(result.text).toBe('role routed');
    expect(store.getSession(result.sessionId)).toMatchObject({ model: 'backup-model', modelId: 'backup-id', modelRole: 'coding' });
    expect(first.events.find((event) => event.type === 'model:response')).toMatchObject({
      type: 'model:response', modelId: 'backup-id', modelName: 'backup-model', role: 'coding',
      fallbackReason: expect.stringContaining('primary temporary outage'),
    });

    const restored = createAgent({ baseUrl: fake.baseUrl, provider: makeRoutedProvider(), sessionId: result.sessionId });
    expect(restored.agent.modelRole).toBe('coding');
    const continued = await restored.agent.run('continue with the restored role');
    expect(continued.text).toBe('role routed');
    expect(store.getSession(result.sessionId)?.modelRole).toBe('coding');
  });

  it('使用同一 sessionId 恢复历史并继续多轮对话', async () => {
    fake = await startFakeModel((body, index) => {
      if (index === 0) {
        return { toolCalls: [toolCall('call_1', 'read_file', { path: 'a.ts' })] };
      }
      if (index === 1) return { content: '第一轮：已读取文件' };
      // 第二轮：确认历史里仍能看到第一轮用户消息
      const hasHistory = body.messages.some((m) => m.role === 'user' && (m.content ?? '').includes('读取 a.ts'));
      return { content: hasHistory ? '第二轮：历史已恢复' : '第二轮：历史缺失' };
    });

    const first = createAgent({ baseUrl: fake.baseUrl, approve: false });
    const firstResult = await first.agent.run('请读取 a.ts');
    expect(firstResult.text).toContain('第一轮');
    const sessionId = firstResult.sessionId;

    // 新 Agent 实例复用同一 sessionId / store
    const second = createAgent({ baseUrl: fake.baseUrl, approve: false, sessionId });
    const secondResult = await second.agent.run('刚才读了什么文件？');

    expect(secondResult.sessionId).toBe(sessionId);
    expect(secondResult.text).toContain('历史已恢复');
    expect(second.agent.messages().length).toBeGreaterThan(first.agent.messages().length);
    assertProtocolComplete(secondResult, second);
  });

  it('上下文超预算时先生成结构化摘要，并保留原始消息记录', async () => {
    fake = await startFakeModel((_body, index) => ({ content: index === 1 ? '当前目标：保留旧目标\n约束：只总结事实\n已确认事实：旧事实存在\n已完成工作：读取历史\n未完成工作：继续当前任务\n证据引用：消息历史' : '已处理' }));
    const fixture = createAgent({ baseUrl: fake.baseUrl, contextWindow: 2048 });
    const first = await fixture.agent.run(`历史目标：${'旧事实 '.repeat(220)}`);
    expect(first.reason).toBe('completed');
    const second = await fixture.agent.run('继续处理当前工作');

    expect(second.reason).toBe('completed');
    expect(fake.requests.length).toBe(3);
    expect(fake.requests[1]!.tools).toBeUndefined();
    expect(fake.requests[1]!.messages.some((message) => message.role === 'system' && message.content?.includes('证据引用'))).toBe(true);
    expect(fixture.events.some((event) => event.type === 'context:compacted')).toBe(true);
    expect(store.getMessages(second.sessionId).some((message) => message.content?.includes('历史目标'))).toBe(true);
    expect(store.readEvents('context.compacted')).toHaveLength(1);
  });

  it('摘要格式无效时记录原因并回退到确定性压缩', async () => {
    fake = await startFakeModel((_body, index) => ({ content: index === 1 ? '只给一个不完整摘要' : '已处理' }));
    const fixture = createAgent({ baseUrl: fake.baseUrl, contextWindow: 2048 });
    await fixture.agent.run(`历史目标：${'旧事实 '.repeat(220)}`);
    const result = await fixture.agent.run('继续处理当前工作');

    expect(result.reason).toBe('completed');
    expect(fake.requests).toHaveLength(3);
    expect(store.readEvents('context.compaction_failed')[0]?.data.reason).toBe('摘要缺少必需字段');
    expect(fixture.events.some((event) => event.type === 'notice' && event.message.includes('回退到确定性压缩'))).toBe(true);
  });

  it('扩展命令执行，扩展事件订阅收到 Agent 生命周期事件', async () => {
    fake = await startFakeModel(() => ({ content: '完成' }));
    const observed: AgentEvent[] = [];
    const extension: ForgeExtension = {
      id: 'test.extension',
      activate(api) {
        api.registerCommand({ name: 'hello', description: 'test command', execute: (args) => { observed.push({ type: 'notice', level: 'info', message: args, ts: Date.now() }); } });
        api.onEvent((event) => observed.push(event));
      },
    };
    const fixture = createAgent({ baseUrl: fake.baseUrl, extensions: [extension] });
    expect(fixture.agent.listExtensionCommands().map((command) => command.name)).toEqual(['hello']);
    expect(await fixture.agent.executeExtensionCommand('hello', 'from test')).toBe(true);
    await fixture.agent.run('run once');
    expect(store.getAuditEvents(fixture.agent.sessionId).filter((event) => event.tool === 'extension:hello')).toHaveLength(2);
    expect(observed.some((event) => event.type === 'notice' && event.message === 'from test')).toBe(true);
    expect(observed.some((event) => event.type === 'user:message')).toBe(true);
  });

  it('拒绝与内置命令重名的扩展命令', async () => {
    fake = await startFakeModel(() => ({ content: 'unused' }));
    expect(() => createAgent({
      baseUrl: fake!.baseUrl,
      extensions: [{ id: 'test.extension', activate(api) { api.registerCommand({ name: 'help', description: 'shadow built-in', execute() {} }); } }],
    })).toThrow(/命令名非法或重复/);
  });
});
