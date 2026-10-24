/**
 * run_command：受控执行外部命令。
 *
 * 安全边界（务必逐条理解）：
 *  - 输入是 `program + args[]`，不存在命令字符串，永远 `shell: false`；
 *  - 程序/参数先经 CommandGuard 结构校验，再由 Dispatcher 做策略判定与审批；
 *  - 工作目录必须位于授权工作区内（WorkspaceGuard）；
 *  - 环境变量只注入 policy.envAllowlist 中的键，其余全部丢弃；
 *  - 超时时间不能超过 policy.commandTimeoutMs；
 *  - 输出按字节截断，避免撑爆上下文。
 *
 * 再次强调：允许执行某个程序 ≠ 安全沙箱。构建/测试脚本仍可能执行任意代码，
 * 企业环境应只在隔离机器上使用 EXECUTE 权限。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { formatMs, ForgeError } from '@forgex/shared';
import { CommandGuard } from '@forgex/security';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';
import { runProcess } from '../execution/process-runner.js';
import { resolveExecutorBinary, runViaExecutor } from '../execution/executor-client.js';
import { toWorkspaceRelative } from '../coding/fs-utils.js';

/** 两种执行器的统一结果形态 */
interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

const inputSchema = z.object({
  program: z
    .string()
    .min(1)
    .describe('可执行程序名或绝对路径，例如 git、pnpm、node；禁止传递 shell 命令字符串'),
  args: z.array(z.string()).default([]).describe('参数数组，每个参数单独一项，不做 shell 展开'),
  cwd: z.string().optional().describe('工作目录（相对工作区），默认当前目录'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .optional()
    .describe('超时毫秒数，不超过策略上限（默认策略上限 60s）'),
});

type Input = z.infer<typeof inputSchema>;

export function createRunCommandTool(): ToolDefinition<Input> {
  const guard = new CommandGuard();

  return {
    name: 'run_command',
    description:
      '在授权工作区内执行一个外部程序（只接受 program + args 数组，不接受 shell 命令字符串）。' +
      '适用于构建、测试、git 等操作。执行前可能需要人工审批；被策略拒绝时会返回明确原因。' +
      '注意：该工具不具备沙箱隔离能力，请勿在生产机器上执行不受信任的脚本。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'execute',
    timeoutMs: 300_000,
    maxOutputBytes: 160 * 1024,
    tags: ['execution', 'execute'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        // 纵深防御：即使被直接调用，结构校验也必须通过
        const structural = guard.validateStructure({
          program: input.program,
          args: input.args,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        });
        if (structural && structural.decision === 'deny') {
          return toolError('COMMAND_BLOCKED', structural.reason, { details: { rule: structural.rule } });
        }

        const cwdAbs = await ctx.workspace.resolve(input.cwd ?? '.', 'read', ctx.cwd);
        const env = pickEnv(ctx.policy.envAllowlist);
        const timeoutMs = Math.min(input.timeoutMs ?? ctx.policy.commandTimeoutMs, ctx.policy.commandTimeoutMs);
        const maxOutputBytes = 128 * 1024;

        // 优先使用 Rust 执行器（若已部署）；否则使用 Node 兜底实现
        let executor: 'rust' | 'node' = 'node';
        let fallbackReason: string | undefined;
        let result: CommandResult | null = null;

        const rustBinary = resolveExecutorBinary(ctx.workspaceRoot);
        if (rustBinary) {
          try {
            const envSpec: Record<string, string> = {};
            for (const [key, value] of Object.entries(env)) {
              if (value !== undefined) envSpec[key] = value;
            }
            const rust = await runViaExecutor(
              rustBinary,
              {
                program: input.program,
                args: input.args,
                cwd: cwdAbs,
                env: envSpec,
                timeoutMs,
                maxOutputBytes,
              },
              ctx.signal,
            );
            if (rust.spawnError) {
              return toolError('TOOL_FAILED', `无法启动程序 ${input.program}: ${rust.spawnError}`, {
                details: { program: input.program },
              });
            }
            executor = 'rust';
            result = {
              code: rust.code,
              signal: null,
              stdout: rust.stdout,
              stderr: rust.stderr,
              truncated: rust.truncated,
              timedOut: rust.timedOut,
              aborted: false,
              durationMs: rust.durationMs,
            };
          } catch (err) {
            // 取消/超时不能降级重试：命令可能已经产生副作用
            if (err instanceof ForgeError && (err.code === 'ABORTED' || err.code === 'TOOL_TIMEOUT')) {
              return errorToOutcome(err);
            }
            fallbackReason = err instanceof Error ? err.message : String(err);
          }
        }

        if (!result) {
          const nodeResult = await runProcess({
            program: input.program,
            args: input.args,
            cwd: cwdAbs,
            env,
            signal: ctx.signal,
            timeoutMs,
            maxOutputBytes,
          });
          result = {
            code: nodeResult.code,
            signal: nodeResult.signal,
            stdout: nodeResult.stdout,
            stderr: nodeResult.stderr,
            truncated: nodeResult.truncated,
            timedOut: nodeResult.timedOut,
            aborted: nodeResult.aborted,
            durationMs: nodeResult.durationMs,
          };
        }

        const relCwd = toWorkspaceRelative(ctx.workspaceRoot, cwdAbs);

        if (result.aborted) {
          return toolError('ABORTED', '命令已被取消', {
            details: { program: input.program, stdout: result.stdout, stderr: result.stderr },
          });
        }
        if (result.timedOut) {
          return toolError('TOOL_TIMEOUT', `命令执行超过 ${timeoutMs}ms，已终止进程树`, {
            retryable: true,
            details: {
              program: input.program,
              timeoutMs,
              stdout: result.stdout,
              stderr: result.stderr,
            },
          });
        }

        const lineCount = result.stdout.split(/\r?\n/).filter((line) => line.length > 0).length;
        const exit = result.code === null ? `signal ${result.signal ?? 'unknown'}` : `退出码 ${result.code}`;
        return toolOk(
          `${input.program} ${exit}，用时 ${formatMs(result.durationMs)}，stdout ${lineCount} 行` +
            (result.truncated ? '（输出已截断）' : ''),
          {
            program: input.program,
            args: input.args,
            cwd: relCwd,
            executor,
            ...(fallbackReason ? { executorFallback: fallbackReason } : {}),
            exitCode: result.code,
            signal: result.signal,
            durationMs: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          result.truncated,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}

/** 只保留白名单环境变量；Windows 下键名大小写不敏感 */
function pickEnv(allowlist: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const wanted = new Set(allowlist.map((key) => (process.platform === 'win32' ? key.toLowerCase() : key)));
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const normalized = process.platform === 'win32' ? key.toLowerCase() : key;
    if (wanted.has(normalized)) out[key] = value;
  }
  return out;
}
