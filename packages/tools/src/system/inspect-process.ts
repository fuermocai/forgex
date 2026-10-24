/**
 * inspect_process：查看本机进程（只读）。
 *
 * 不修改任何进程状态；按名称/pid 过滤，默认按内存降序返回前 20 个。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { listProcesses } from '@forgex/devops';
import { errorToOutcome, toolOk } from '../tool-result.js';

const inputSchema = z.object({
  name: z.string().optional().describe('进程名过滤（不区分大小写，子串匹配）'),
  pid: z.number().int().min(1).optional().describe('精确查询某个 PID'),
  limit: z.number().int().min(1).max(200).default(20).describe('最多返回多少条，默认 20'),
  sortBy: z.enum(['memory', 'pid', 'name']).default('memory').describe('排序字段，默认按内存占用降序'),
});

type Input = z.infer<typeof inputSchema>;

export function createInspectProcessTool(): ToolDefinition<Input> {
  return {
    name: 'inspect_process',
    description:
      '查看本机进程列表（只读）。可按进程名或 PID 查询，返回 PID、名称、用户、内存占用。' +
      '用于定位服务进程、确认进程是否存活。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 20_000,
    maxOutputBytes: 96 * 1024,
    tags: ['devops', 'read'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const all = await listProcesses();
        if (ctx.signal.aborted) {
          return { ok: false, summary: '操作已取消', error: { code: 'ABORTED', message: '用户取消了操作' } };
        }

        let filtered = all;
        if (input.pid !== undefined) {
          filtered = filtered.filter((proc) => proc.pid === input.pid);
        } else if (input.name) {
          const needle = input.name.toLowerCase();
          filtered = filtered.filter((proc) => proc.name.toLowerCase().includes(needle));
        }

        const sorted = [...filtered].sort((a, b) => {
          if (input.sortBy === 'pid') return a.pid - b.pid;
          if (input.sortBy === 'name') return a.name.localeCompare(b.name);
          return (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0);
        });
        const selected = sorted.slice(0, input.limit);

        return toolOk(
          selected.length === 0
            ? `未找到匹配的进程（共 ${all.length} 个进程）`
            : `共匹配 ${sorted.length} 个进程，返回前 ${selected.length} 个（系统进程总数 ${all.length}）`,
          {
            platform: process.platform,
            totalProcesses: all.length,
            matched: sorted.length,
            processes: selected.map((proc) => ({
              pid: proc.pid,
              name: proc.name,
              user: proc.user,
              memoryBytes: proc.memoryBytes,
              command: proc.command,
            })),
          },
          selected.length < sorted.length,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
