/**
 * ssh_inspect：SSH 远程只读诊断工具。
 *
 * 安全边界（三层纵深）：
 *   1. PolicySettings.remoteHosts 必须包含目标主机 → 未授权直接拒绝；
 *   2. SshGuard.validate(action) → 禁止任意 shell 字符串、参数白名单、路径白名单；
 *   3. SshClient.connect 时强制 Host Key 指纹比对（ssh2 hostVerifier）。
 *
 * 默认禁用：
 *   配置里 remoteHosts 为空数组时，工具直接返回 TOOL_NOT_AVAILABLE 提示。
 *   这是"显式启用"模式，防止模型在未授权环境里滥用。
 *
 * 错误处理：
 *   SSH 连接/指纹不匹配/超时 → 返回结构化 ToolOutcome.ok=false，不抛异常。
 *   模型拿到错误码后可以换另一台主机，不会崩 Agent。
 */
import { z } from 'zod';
import type { JsonValue, RemoteHostConfig, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { SshGuard, SshClient } from '@forgex/devops';
import type { RemoteDiagAction, SshHostConfig } from '@forgex/devops';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';

const inputSchema = z.object({
  host: z.string().min(1).max(253).describe('目标远程主机名或 IP（必须在授权白名单内）'),
  action: z.discriminatedUnion('action', [
    z.object({ action: z.literal('system_info') }),
    z.object({ action: z.literal('uptime') }),
    z.object({ action: z.literal('memory_usage') }),
    z.object({ action: z.literal('disk_usage') }),
    z.object({ action: z.literal('port_list'), listeningOnly: z.boolean().default(true) }),
    z.object({ action: z.literal('top_processes'), limit: z.number().int().min(1).max(50).default(15), sortBy: z.enum(['memory', 'cpu']).default('memory') }),
    z.object({ action: z.literal('journalctl'), unit: z.string().min(1).max(64).optional(), lines: z.number().int().min(1).max(5000).default(100), since: z.string().min(2).max(64).optional(), priority: z.enum(['error', 'crit', 'warning']).optional(), bootOnly: z.boolean().default(true) }),
    z.object({ action: z.literal('systemctl_status'), unit: z.string().min(1).max(64) }),
    z.object({ action: z.literal('read_remote_log'), path: z.string().min(1).max(4096), lines: z.number().int().min(1).max(2000).default(100), grep: z.string().min(1).max(128).optional() }),
    z.object({ action: z.literal('list_dir'), path: z.string().min(1).max(4096), depth: z.number().int().min(1).max(3).default(1) }),
    z.object({ action: z.literal('stat_file'), path: z.string().min(1).max(4096) }),
    z.object({ action: z.literal('kernel_modules'), filter: z.string().min(1).max(64).optional() }),
  ]).describe('只读诊断动作（结构化，禁止任意 shell 字符串）'),
});

type Input = z.infer<typeof inputSchema>;

const guard = new SshGuard();

export function createSshInspectTool(): ToolDefinition<Input> {
  return {
    name: 'ssh_inspect',
    description:
      '通过 SSH 对**授权远程 Linux 主机**执行只读诊断。' +
      '支持：system_info、uptime、memory_usage、disk_usage、port_list、top_processes、' +
      'journalctl、systemctl_status、read_remote_log、list_dir、stat_file、kernel_modules。' +
      '只接受结构化诊断动作（action 字段），绝不接受任意 shell 命令字符串。' +
      '目标主机必须在配置的 remoteHosts 白名单内，且 Host Key 指纹必须匹配。' +
      '默认禁用——需要在策略配置里显式配置 remoteHosts 才会生效。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
    tags: ['devops', 'remote', 'read', 'ssh'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        // 1. 检查 SSH 功能是否启用
        const remoteHosts = ctx.policy.remoteHosts ?? [];
        if (remoteHosts.length === 0) {
          return toolError(
            'SSH_DISABLED',
            'SSH 远程诊断未启用：策略配置中 remoteHosts 为空。请先在配置里添加授权主机（host、username、privateKeyPath、hostKeyFingerprint）。',
          );
        }

        // 2. 找到匹配的授权主机
        const hostConfig = findHost(remoteHosts, input.host);
        if (!hostConfig) {
          const allowed = remoteHosts.map((h) => h.host).join(', ');
          return toolError(
            'SSH_HOST_NOT_AUTHORIZED',
            `主机 ${input.host} 未在授权白名单内。当前授权主机: ${allowed}`,
            { details: { requestedHost: input.host, allowedHosts: remoteHosts.map((h) => h.host) } },
          );
        }

        // 3. 构建 Guard 需要的 SshHostConfig（Guard 里再做格式校验）
        const sshHost: SshHostConfig = {
          host: hostConfig.host,
          port: hostConfig.port ?? 22,
          username: hostConfig.username,
          privateKeyPath: hostConfig.privateKeyPath,
          hostKeyFingerprint: hostConfig.hostKeyFingerprint,
          allowedAliases: hostConfig.aliases ?? [hostConfig.host],
        };

        // 4. Guard 校验（action 白名单 + 参数校验 + 路径白名单 + hostKey 必填）
        let guarded;
        try {
          guarded = guard.validate({ host: sshHost, action: input.action as RemoteDiagAction });
        } catch (err) {
          return errorToOutcome(err);
        }

        // 5. 执行远程诊断
        const client = new SshClient();
        const result = await client.execute(
          { host: sshHost, action: guarded.action, options: { connectTimeoutMs: 10_000, commandTimeoutMs: Math.min(guarded.command.timeoutMs, ctx.policy.commandTimeoutMs) } },
          guarded,
          ctx.signal,
        );

        if (result.connectionError) {
          return toolError(
            result.timedOut ? 'SSH_TIMEOUT' : 'SSH_CONNECTION_FAILED',
            `SSH 连接失败 (${result.action}): ${result.connectionError}`,
            { details: { host: input.host, action: result.action, durationMs: result.durationMs } },
          );
        }

        if (result.timedOut) {
          return toolError(
            'SSH_COMMAND_TIMEOUT',
            `远程命令 ${result.action} 执行超时 (${result.durationMs}ms)，已终止进程`,
            { details: { host: input.host, action: result.action, durationMs: result.durationMs } },
          );
        }

        return toolOk(
          `SSH ${input.host}: ${result.action} 完成 (exit=${result.exitCode ?? 'null'}, ${result.durationMs}ms)${result.truncated ? '（输出已截断）' : ''}`,
          {
            host: input.host,
            action: result.action,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            truncated: result.truncated,
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

function findHost(remoteHosts: readonly RemoteHostConfig[], target: string): RemoteHostConfig | undefined {
  const lower = target.toLowerCase();
  return (
    remoteHosts.find((h) => h.host.toLowerCase() === lower) ??
    remoteHosts.find((h) => (h.aliases ?? []).some((a) => a.toLowerCase() === lower))
  );
}
