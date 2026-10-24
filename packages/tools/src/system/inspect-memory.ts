/**
 * inspect_memory：内存与 swap 状态（只读）。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { formatBytes } from '@forgex/shared';
import { getMemory } from '@forgex/devops';
import { errorToOutcome, toolOk } from '../tool-result.js';

const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;

export function createInspectMemoryTool(): ToolDefinition<Input> {
  return {
    name: 'inspect_memory',
    description: '查看本机内存与 swap 使用情况（只读）。返回总量、可用量、使用率与 swap 数据。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 20_000,
    maxOutputBytes: 16 * 1024,
    tags: ['devops', 'read'],
    async execute(_input: Input, _ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const memory = await getMemory();
        return toolOk(
          `内存 ${formatBytes(memory.totalBytes)}，可用 ${formatBytes(memory.availableBytes ?? memory.freeBytes)}` +
            `，使用率 ${memory.usedPercent ?? '?'}%`,
          {
            platform: process.platform,
            totalBytes: memory.totalBytes,
            freeBytes: memory.freeBytes,
            availableBytes: memory.availableBytes,
            usedPercent: memory.usedPercent,
            swapTotalBytes: memory.swapTotalBytes,
            swapUsedBytes: memory.swapUsedBytes,
          },
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}
