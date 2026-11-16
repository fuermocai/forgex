import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolOk } from '../tool-result.js';
import { CodeExecutionSessionManager } from './code-session.js';

const executeSchema = z.object({ action: z.literal('execute'), language: z.enum(['javascript', 'python']), code: z.string().min(1).max(64 * 1024) });
const clearSchema = z.object({ action: z.literal('clear'), language: z.enum(['javascript', 'python']).optional() });
const inputSchema = z.discriminatedUnion('action', [executeSchema, clearSchema]);

type Input = z.infer<typeof inputSchema>;

export interface CodeExecutionToolOptions {
  nodeCommand: string;
  pythonCommand: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

/** Creates the persistent code execution tool; every call requires approval. */
export function createCodeSessionTool(
  options: CodeExecutionToolOptions,
  manager = new CodeExecutionSessionManager(options),
): ToolDefinition<Input> {
  return {
    name: 'code_session',
    description: '在当前 Agent session 的持久 JavaScript/Python 解释器进程中运行代码，或显式清理会话。每次运行与清理都需审批；这是高风险本机代码执行，不是 OS 沙箱。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'execute',
    alwaysRequireApproval: true,
    requireCompleteApprovalPreview: true,
    maxApprovalPreviewChars: 66_000,
    getApprovalPreview(input: Input): string {
      if (input.action === 'clear') return `清理 ${input.language ?? '全部'} 代码会话及其子进程`;
      return `在独立持久进程执行 ${input.language} 代码；无 OS 沙箱，代码可访问该进程可访问的文件与网络。\n\n${input.code}`;
    },
    timeoutMs: 600_000,
    maxOutputBytes: Math.max(4_096, options.maxOutputBytes),
    tags: ['coding', 'execute', 'session'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      if (input.action === 'clear') {
        manager.clear(ctx.sessionId, input.language);
        return toolOk(input.language ? `已清理 ${input.language} 代码会话` : '已清理当前 Agent session 的全部代码会话', {
          cleared: true,
          language: input.language ?? 'all',
        });
      }
      try {
        const cwd = await ctx.workspace.resolve('.', 'read', ctx.cwd);
        const result = await manager.execute({
          sessionId: ctx.sessionId,
          language: input.language,
          code: input.code,
          cwd,
          env: pickExecutionEnv(ctx.policy.envAllowlist),
          signal: ctx.signal,
          timeoutMs: Math.min(options.timeoutMs, ctx.policy.commandTimeoutMs),
          maxOutputBytes: options.maxOutputBytes,
        });
        return toolOk(result.error ? `${input.language} 执行完成，但代码抛出异常` : `${input.language} 执行完成`, result);
      } catch (error) {
        return errorToOutcome(error);
      }
    },
  };
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
