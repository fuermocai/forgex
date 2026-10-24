/**
 * inspect_port：检查端口监听状态（只读）。
 *
 * 这是"为什么 8090 端口无法访问"类问题的第一手证据来源：
 *  - 是否监听、监听地址（0.0.0.0 还是 127.0.0.1）；
 *  - 对应进程与 PID；
 *  - 若未找到，明确返回 found=false，绝不臆测原因。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { listPorts } from '@forgex/devops';
import { errorToOutcome, toolOk } from '../tool-result.js';

const inputSchema = z.object({
  port: z.number().int().min(1).max(65535).describe('要检查的端口号'),
  protocol: z.enum(['tcp', 'udp', 'all']).default('all').describe('协议过滤，默认 all'),
  listeningOnly: z.boolean().default(true).describe('只显示监听状态，默认 true'),
  limit: z.number().int().min(1).max(200).default(50).describe('最多返回多少条'),
});

type Input = z.infer<typeof inputSchema>;

export function createInspectPortTool(): ToolDefinition<Input> {
  return {
    name: 'inspect_port',
    description:
      '检查本机指定端口的监听/连接状态（只读）。返回监听地址、协议、状态、占用进程与 PID。' +
      '若端口未监听，会明确返回 found=false，请结合其他证据继续排查。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 25_000,
    maxOutputBytes: 96 * 1024,
    tags: ['devops', 'read'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const all = await listPorts({ listeningOnly: input.listeningOnly });
        if (ctx.signal.aborted) {
          return { ok: false, summary: '操作已取消', error: { code: 'ABORTED', message: '用户取消了操作' } };
        }

        const matches = all
          .filter((item) => item.port === input.port)
          .filter((item) => input.protocol === 'all' || item.protocol.startsWith(input.protocol))
          .slice(0, input.limit);

        const listeners = matches.filter((item) => item.state === 'LISTEN' || item.state === 'LISTENING');
        const summary =
          matches.length === 0
            ? `端口 ${input.port} 未发现监听或连接记录（已检查 ${all.length} 条端口记录）`
            : `端口 ${input.port} 有 ${matches.length} 条记录，其中 ${listeners.length} 条处于监听状态`;

        return toolOk(summary, {
          platform: process.platform,
          port: input.port,
          found: matches.length > 0,
          listening: listeners.length > 0,
          records: matches.map((item) => ({
            protocol: item.protocol,
            state: item.state,
            localAddress: item.localAddress,
            pid: item.pid,
            processName: item.processName,
          })),
          checkedRecords: all.length,
        });
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
