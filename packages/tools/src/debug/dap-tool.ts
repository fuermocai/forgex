import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';
import { DapSessionManager, type DebugAdapterConfig } from './dap-client.js';

const breakpointSchema = z.object({ line: z.number().int().min(1), condition: z.string().max(1000).optional() });
const adapterId = z.string().min(1).max(64);
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), adapterId, program: z.string().min(1), args: z.array(z.string()).max(128).default([]), breakpoints: z.array(breakpointSchema).max(256).default([]) }),
  z.object({ action: z.literal('attach'), adapterId, processId: z.number().int().min(1) }),
  z.object({ action: z.literal('set_breakpoints'), source: z.string().min(1), breakpoints: z.array(breakpointSchema).max(256) }),
  z.object({ action: z.literal('threads') }),
  z.object({ action: z.literal('stack_trace'), threadId: z.number().int().min(0) }),
  z.object({ action: z.literal('scopes'), frameId: z.number().int().min(0) }),
  z.object({ action: z.literal('variables'), variablesReference: z.number().int().min(0) }),
  z.object({ action: z.literal('continue'), threadId: z.number().int().min(0).default(0) }),
  z.object({ action: z.literal('pause'), threadId: z.number().int().min(0) }),
  z.object({ action: z.literal('next'), threadId: z.number().int().min(0) }),
  z.object({ action: z.literal('step_in'), threadId: z.number().int().min(0) }),
  z.object({ action: z.literal('step_out'), threadId: z.number().int().min(0) }),
  z.object({ action: z.literal('stop') }),
]);

type Input = z.infer<typeof inputSchema>;

/** Creates a DAP tool limited to explicitly configured adapter commands. */
export function createDapTool(
  adapters: readonly DebugAdapterConfig[],
  manager: DapSessionManager,
): ToolDefinition<Input> {
  return {
    name: 'dap_debug',
    description: '使用已配置的 DAP adapter 启动/附加调试会话、断点、单步和检查变量。adapter/目标进程及每次调试操作都需人工审批，源码路径必须在工作区内。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'execute',
    alwaysRequireApproval: true,
    requireCompleteApprovalPreview: true,
    maxApprovalPreviewChars: 64_000,
    getApprovalPaths(input: Input): readonly string[] {
      if (input.action === 'start') return [input.program];
      if (input.action === 'set_breakpoints') return [input.source];
      return [];
    },
    getApprovalPreview(input: Input, ctx: ToolContext): string {
      if (input.action === 'start' || input.action === 'attach') {
        const adapter = findAdapter(adapters, input.adapterId);
        const invocation = adapter ? { command: adapter.command, args: adapter.args } : { command: '(未配置)', args: [] };
        if (input.action === 'start') {
          return `启动配置的 DAP adapter 并运行工作区程序。\n工作区: ${ctx.workspaceRoot}\n程序: ${input.program}\nAdapter 进程:\n${formatPreview(invocation)}\nLaunch arguments:\n${formatPreview({ ...adapter?.launchArgs, program: input.program, args: input.args, cwd: ctx.workspaceRoot, stopOnEntry: true, noDebug: false })}\n初始断点:\n${formatPreview(input.breakpoints)}`;
        }
        return `启动配置的 DAP adapter 并附加到 PID ${input.processId}。\nAdapter 进程:\n${formatPreview(invocation)}\nAttach arguments:\n${formatPreview({ ...adapter?.attachArgs, processId: input.processId })}`;
      }
      if (input.action === 'stop') return '关闭当前 Agent session 的 DAP adapter，并请求终止调试目标。';
      if (input.action === 'set_breakpoints') {
        return `设置工作区断点。\n工作区: ${ctx.workspaceRoot}\n源码: ${input.source}\nArguments:\n${formatPreview({ source: { path: input.source }, breakpoints: input.breakpoints, sourceModified: false })}`;
      }
      const request = toDapRequest(input);
      return `发送 DAP ${request.command} 请求。\nArguments:\n${formatPreview(request.args)}`;
    },
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1024,
    tags: ['coding', 'debug', 'execute'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      const abort = () => { void manager.close(ctx.sessionId); };
      ctx.signal.addEventListener('abort', abort, { once: true });
      try {
        let result: unknown;
        if (input.action === 'start') {
          const adapter = findAdapter(adapters, input.adapterId);
          if (!adapter) return toolError('TOOL_FAILED', `没有配置 DAP adapter: ${input.adapterId}`);
          result = await manager.start(ctx, adapter, input.program, input.args, input.breakpoints, pickExecutionEnv(ctx.policy.envAllowlist));
        } else if (input.action === 'attach') {
          const adapter = findAdapter(adapters, input.adapterId);
          if (!adapter) return toolError('TOOL_FAILED', `没有配置 DAP adapter: ${input.adapterId}`);
          result = await manager.attach(ctx, adapter, input.processId, pickExecutionEnv(ctx.policy.envAllowlist));
        } else if (input.action === 'stop') {
          await manager.close(ctx.sessionId);
          return toolOk('DAP 调试会话已结束', { stopped: true });
        } else if (input.action === 'set_breakpoints') {
          const source = await ctx.workspace.resolve(input.source, 'read', ctx.cwd);
          result = await manager.request(ctx.sessionId, 'setBreakpoints', {
            source: { path: source },
            breakpoints: input.breakpoints,
            sourceModified: false,
          });
        } else {
          const request = toDapRequest(input);
          result = await manager.request(ctx.sessionId, request.command, request.args);
        }
        await manager.validateSources(result, ctx);
        return toolOk(`DAP ${input.action} 完成`, result as JsonValue);
      } catch (error) {
        return errorToOutcome(error);
      } finally {
        ctx.signal.removeEventListener('abort', abort);
      }
    },
  };
}

function findAdapter(adapters: readonly DebugAdapterConfig[], id: string): DebugAdapterConfig | undefined {
  return adapters.find((adapter) => adapter.id === id);
}

function formatPreview(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function toDapRequest(input: Exclude<Input, { action: 'start' | 'attach' | 'stop' }>): { command: string; args: Record<string, unknown> } {
  switch (input.action) {
    case 'set_breakpoints':
      return { command: 'setBreakpoints', args: { source: { path: input.source }, breakpoints: input.breakpoints, sourceModified: false } };
    case 'threads':
      return { command: 'threads', args: {} };
    case 'stack_trace':
      return { command: 'stackTrace', args: { threadId: input.threadId } };
    case 'scopes':
      return { command: 'scopes', args: { frameId: input.frameId } };
    case 'variables':
      return { command: 'variables', args: { variablesReference: input.variablesReference } };
    case 'continue':
      return { command: 'continue', args: { threadId: input.threadId } };
    case 'pause':
      return { command: 'pause', args: { threadId: input.threadId } };
    case 'next':
      return { command: 'next', args: { threadId: input.threadId } };
    case 'step_in':
      return { command: 'stepIn', args: { threadId: input.threadId } };
    case 'step_out':
      return { command: 'stepOut', args: { threadId: input.threadId } };
    default:
      return { command: '', args: {} };
  }
}

function pickExecutionEnv(allowlist: readonly string[]): NodeJS.ProcessEnv {
  const baseNames = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME'];
  const names = new Set([...baseNames, ...allowlist].map((name) => process.platform === 'win32' ? name.toLowerCase() : name));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if (names.has(key)) env[name] = value;
  }
  return env;
}
