import { readFile } from 'node:fs/promises';
import { extname, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { ForgeError } from '@forgex/shared';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';
import { LspClient, type LspServerConfig } from './lsp-client.js';

const inputSchema = z.object({
  path: z.string().min(1),
  operation: z.enum(['diagnostics', 'symbols', 'definition', 'references']),
  position: z.object({ line: z.number().int().min(0), character: z.number().int().min(0) }).optional(),
});

type Input = z.infer<typeof inputSchema>;

/** Creates an LSP tool for explicitly configured language servers. */
export function createLspTool(servers: readonly LspServerConfig[]): ToolDefinition<Input> {
  return {
    name: 'lsp',
    description: '使用已配置的语言服务器查询文件诊断、文档符号、定义和引用。服务器进程会在审批后于授权工作区内启动。位置的行列从 0 开始。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'execute',
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1024,
    tags: ['coding', 'lsp', 'execute'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      const server = findServer(servers, input.path);
      if (!server) return toolError('TOOL_FAILED', `没有为 ${extname(input.path) || '该文件类型'} 配置语言服务器`);
      if (input.operation !== 'diagnostics' && !input.position) {
        return toolError('TOOL_FAILED', `${input.operation} 操作需要 position.line 和 position.character`);
      }

      let client: LspClient | null = null;
      const abort = () => { if (client) void client.close(); };
      try {
        const filePath = await ctx.workspace.resolve(input.path, 'read', ctx.cwd);
        const text = await readFile(filePath, 'utf8');
        const uri = pathToFileURL(filePath).href;
        const env = pickEnv(ctx.policy.envAllowlist);
        client = new LspClient(server, ctx.workspaceRoot, env, Math.min(ctx.policy.commandTimeoutMs, 30_000));
        ctx.signal.addEventListener('abort', abort, { once: true });
        await client.initialize();
        await client.openDocument(uri, server.languageId, text);

        let result: unknown;
        if (input.operation === 'diagnostics') {
          result = client.getDiagnostics(uri);
        } else if (input.operation === 'symbols') {
          result = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
        } else if (input.operation === 'definition') {
          result = await client.request('textDocument/definition', { textDocument: { uri }, position: input.position });
        } else {
          result = await client.request('textDocument/references', {
            textDocument: { uri },
            position: input.position,
            context: { includeDeclaration: true },
          });
        }

        return toolOk(`LSP ${input.operation}: ${relative(ctx.workspaceRoot, filePath).split(sep).join('/')}`, {
          operation: input.operation,
          path: relative(ctx.workspaceRoot, filePath).split(sep).join('/'),
          server: server.id,
          result: toJsonValue(result),
        });
      } catch (error) {
        if (error instanceof ForgeError) return errorToOutcome(error);
        return toolError('TOOL_FAILED', `LSP ${server.id} 执行失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        ctx.signal.removeEventListener('abort', abort);
        if (client) await client.close();
      }
    },
  };
}

function findServer(servers: readonly LspServerConfig[], filePath: string): LspServerConfig | undefined {
  const extension = extname(filePath).toLowerCase();
  return servers.find((server) => server.extensions.some((item) => item.toLowerCase() === extension));
}

function pickEnv(allowlist: readonly string[]): NodeJS.ProcessEnv {
  const names = new Set(allowlist.map((name) => process.platform === 'win32' ? name.toLowerCase() : name));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if (names.has(key)) env[name] = value;
  }
  return env;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value);
}
