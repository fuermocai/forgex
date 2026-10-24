/**
 * inspect_disk：磁盘使用情况（只读）。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { listDisks } from '@forgex/devops';
import { errorToOutcome, toolOk } from '../tool-result.js';

const inputSchema = z.object({
  mount: z.string().optional().describe('只看某个挂载点/盘符，例如 / 或 C:'),
  minUsedPercent: z.number().min(0).max(100).optional().describe('只返回使用率不低于该值的磁盘'),
});

type Input = z.infer<typeof inputSchema>;

export function createInspectDiskTool(): ToolDefinition<Input> {
  return {
    name: 'inspect_disk',
    description: '查看本机磁盘空间使用情况（只读）。返回文件系统、挂载点、总量、已用、可用与使用率。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 25_000,
    maxOutputBytes: 64 * 1024,
    tags: ['devops', 'read'],
    async execute(input: Input, _ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        let disks = await listDisks();
        if (input.mount) {
          const needle = input.mount.toLowerCase();
          disks = disks.filter((disk) => disk.mount.toLowerCase() === needle || disk.mount.toLowerCase().startsWith(needle));
        }
        if (input.minUsedPercent !== undefined) {
          disks = disks.filter((disk) => disk.usedPercent !== null && disk.usedPercent >= input.minUsedPercent!);
        }

        return toolOk(
          disks.length === 0
            ? '没有匹配的磁盘'
            : disks
                .map((disk) => `${disk.mount} 使用率 ${disk.usedPercent ?? '?'}%`)
                .join('；'),
          {
            platform: process.platform,
            disks: disks.map((disk) => ({
              filesystem: disk.filesystem,
              mount: disk.mount,
              totalBytes: disk.totalBytes,
              usedBytes: disk.usedBytes,
              availableBytes: disk.availableBytes,
              usedPercent: disk.usedPercent,
            })),
          },
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
