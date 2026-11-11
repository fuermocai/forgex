import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { errorToOutcome, toolOk } from '../tool-result.js';

const taskSchema = z.object({
  name: z.string().trim().min(1).describe('任务名称，在本次批次中唯一'),
  task: z.string().trim().min(1).describe('完整、可独立执行的子任务说明'),
  expectedOutput: z.string().optional().describe('期望的交付内容'),
}).strict();

const inputSchema = z.object({
  context: z.string().trim().describe('所有子任务共用的背景信息'),
  tasks: z.array(taskSchema).min(1).describe('并行委派的独立任务列表'),
}).strict().superRefine((input, context) => {
  const names = new Set<string>();
  input.tasks.forEach((task, index) => {
    const key = task.name.toLowerCase();
    if (names.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `任务名称重复: ${task.name}`, path: ['tasks', index, 'name'] });
    }
    names.add(key);
  });
});

export type DelegateTaskInput = z.infer<typeof inputSchema>;

export interface DelegateTaskResult {
  name: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  changedPaths: string[];
  patch: string;
  patchTruncated: boolean;
  usage?: { modelCalls: number; totalTokens: number; toolCalls: number; iterations: number; durationMs: number };
  sessionId?: string;
  artifactPath?: string;
  worktreePath?: string;
  cleanupWarning?: string;
}

export interface DelegateTaskBatchResult {
  results: DelegateTaskResult[];
  durationMs: number;
  concurrency: number;
}

export type DelegateTaskExecutor = (
  input: DelegateTaskInput,
  context: ToolContext,
) => Promise<DelegateTaskBatchResult>;

export function createDelegateTaskTool(execute: DelegateTaskExecutor): ToolDefinition<DelegateTaskInput> {
  return {
    name: 'delegate_task',
    description: '把互相独立的编码任务交给子 Agent 并行执行。每个子 Agent 在派发时父工作区的独立 Git 快照中工作；返回状态、改动路径和可审阅 patch，不会自动合并。子 Agent 仍受当前审批策略约束。Git worktree 是目录隔离，不是操作系统沙箱。',
    parameters: inputSchema as unknown as ToolDefinition<DelegateTaskInput>['parameters'],
    riskLevel: 'execute',
    timeoutMs: 1_800_000,
    maxOutputBytes: 512 * 1024,
    tags: ['coding', 'execute', 'subagent'],
    async execute(input: DelegateTaskInput, context: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const result = await execute(input, context);
        return toolOk(`委派 ${result.results.length} 个子任务`, result);
      } catch (error) {
        return errorToOutcome(error);
      }
    },
  };
}
