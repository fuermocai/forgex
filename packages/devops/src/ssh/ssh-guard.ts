/**
 * SSH RemoteSecurityGateway：远程执行的唯一守卫。
 *
 * 关键保证（安全纵深）：
 *   1. 主机必须有 Host Key 指纹（禁止 StrictHostKeyChecking=no）；
 *   2. Host 必须在 allowedAliases 白名单内（或未配置白名单则 host 格式合法）；
 *   3. 只接受预定义的 action（纯 ZodObject discriminatedUnion，不含 ZodEffects）；
 *   4. 每个 action 映射到固定命令模板，参数做二次校验；
 *   5. 路径类参数限制在允许目录（/var/log、/tmp、/home）；
 *   6. Guard 是 ssh-client.ts 之前的唯一入口——ssh-client 不做安全判定。
 *
 * 设计取舍：
 *   Zod discriminatedUnion 不接受 ZodEffects（.refine() 产物），
 *   因此 read_remote_log / list_dir / stat_file 的路径校验拆到
 *   `validateActionPathRefine` 里，Guard.validate 串行调用。
 */
import { z } from 'zod';
import { ForgeError } from '@forgex/shared';
import type {
  JournalCtlAction,
  KernelModulesAction,
  MemoryUsageAction,
  PortListAction,
  SshHostConfig,
  SshExecSpec,
  SystemCtlStatusAction,
  TopProcessesAction,
  UptimeAction,
  DiskUsageAction,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Zod Schema：每个 action 的参数校验（纯 ZodObject，不含 refine）          */
/* ------------------------------------------------------------------ */

const UNIT_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const pathSchema = z.string().min(1).max(4096);

const systemInfoSchema = z.object({ action: z.literal('system_info') });
const uptimeSchema = z.object({ action: z.literal('uptime') });
const memoryUsageSchema = z.object({ action: z.literal('memory_usage') });
const diskUsageSchema = z.object({ action: z.literal('disk_usage') });
const portListSchema = z.object({
  action: z.literal('port_list'),
  listeningOnly: z.boolean().default(true),
});
const topProcessesSchema = z.object({
  action: z.literal('top_processes'),
  limit: z.number().int().min(1).max(50).default(15),
  sortBy: z.enum(['memory', 'cpu']).default('memory'),
});
const journalctlSchema = z.object({
  action: z.literal('journalctl'),
  unit: z.string().regex(UNIT_NAME_REGEX).optional(),
  lines: z.number().int().min(1).max(5000).default(100),
  since: z.string().min(2).max(64).optional(),
  priority: z.enum(['error', 'crit', 'warning']).optional(),
  bootOnly: z.boolean().default(true),
});
const systemctlStatusSchema = z.object({
  action: z.literal('systemctl_status'),
  unit: z.string().regex(UNIT_NAME_REGEX),
});
const kernelModulesSchema = z.object({
  action: z.literal('kernel_modules'),
  filter: z.string().min(1).max(64).optional(),
});

// 这三个需要额外路径白名单校验，先放纯 object，validate 里再 refine
const readRemoteLogSchema = z.object({
  action: z.literal('read_remote_log'),
  path: pathSchema,
  lines: z.number().int().min(1).max(2000).default(100),
  grep: z.string().min(1).max(128).optional(),
});
const listDirSchema = z.object({
  action: z.literal('list_dir'),
  path: pathSchema,
  depth: z.number().int().min(1).max(3).default(1),
});
const statFileSchema = z.object({
  action: z.literal('stat_file'),
  path: pathSchema,
});

// 纯 ZodObject 联合（discriminatedUnion 不接受 ZodEffects）
const actionUnion = z.discriminatedUnion('action', [
  systemInfoSchema,
  uptimeSchema,
  memoryUsageSchema,
  diskUsageSchema,
  portListSchema,
  topProcessesSchema,
  journalctlSchema,
  systemctlStatusSchema,
  readRemoteLogSchema,
  listDirSchema,
  statFileSchema,
  kernelModulesSchema,
]);

/* ------------------------------------------------------------------ */
/* 允许的远程路径前缀                                                       */
/* ------------------------------------------------------------------ */

const ALLOWED_LOG_DIRS = ['/var/log/', '/tmp/', '/home/'];

function isAllowedPath(raw: string): boolean {
  const normalized = raw.replace(/\\/g, '/');
  if (!normalized.startsWith('/')) return false;
  for (const prefix of ALLOWED_LOG_DIRS) {
    if (normalized.startsWith(prefix)) return true;
  }
  for (const prefix of ALLOWED_LOG_DIRS) {
    if (normalized === prefix.replace(/\/$/, '')) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Host Config 校验                                                       */
/* ------------------------------------------------------------------ */

const hostConfigSchema = z.object({
  host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9._:-]+$/),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  privateKeyPath: z.string().min(1).max(4096),
  hostKeyFingerprint: z.string().min(16).max(128).optional(),
  allowedAliases: z.array(z.string().min(1).max(253)).optional(),
});

/* ------------------------------------------------------------------ */
/* SshGuard                                                              */
/* ------------------------------------------------------------------ */

export interface SshCommand {
  action: string;
  shellCommand: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface GuardedSpec {
  host: SshHostConfig;
  action: z.infer<typeof actionUnion>;
  command: SshCommand;
}

export class SshGuard {
  private static readonly MAX_COMMAND_TIMEOUT_MS = 120_000;
  private static readonly MAX_OUTPUT_BYTES = 512 * 1024;

  validate(spec: SshExecSpec): GuardedSpec {
    const host = this.validateHost(spec.host);
    const action = this.validateAction(spec.action);
    this.validateActionPathRefine(action);
    const command = this.compileCommand(action);
    return { host, action, command };
  }

  private validateHost(raw: SshHostConfig): SshHostConfig {
    const parsed = hostConfigSchema.safeParse(raw);
    if (!parsed.success) throw ForgeError.fromZod(parsed.error, 'SSH_HOST_INVALID');
    const host = parsed.data;

    if (host.allowedAliases && host.allowedAliases.length > 0) {
      const normalized = host.allowedAliases.map((alias: string) => alias.toLowerCase());
      if (!normalized.includes(host.host.toLowerCase())) {
        throw new ForgeError(
          'SSH_HOST_DENIED',
          `主机 ${host.host} 不在授权白名单内 (允许: ${host.allowedAliases.join(', ')})`,
        );
      }
    }

    if (!host.hostKeyFingerprint) {
      throw new ForgeError(
        'SSH_HOSTKEY_MISSING',
        '远程主机未提供 Host Key 指纹，为了防止中间人攻击，拒绝连接',
      );
    }
    return host;
  }

  private validateAction(raw: unknown): z.infer<typeof actionUnion> {
    const parsed = actionUnion.safeParse(raw);
    if (!parsed.success) throw ForgeError.fromZod(parsed.error, 'SSH_ACTION_INVALID');
    return parsed.data;
  }

  /**
   * 对 read_remote_log / list_dir / stat_file 做路径白名单校验。
   * 和 shell 元字符双拦截。
   */
  private validateActionPathRefine(action: z.infer<typeof actionUnion>): void {
    if ('path' in action) {
      const p = (action as { path: string }).path;
      if (!isAllowedPath(p)) {
        throw new ForgeError(
          'SSH_PATH_DENIED',
          `路径 ${p} 不在允许目录内 (只允许 ${ALLOWED_LOG_DIRS.join(', ')})`,
        );
      }
      if (/[;|&`$(){}!<>\\]/.test(p)) {
        throw new ForgeError('SSH_PATH_INVALID', '路径包含非法 shell 元字符');
      }
    }
  }

  private compileCommand(action: z.infer<typeof actionUnion>): SshCommand {
    switch (action.action) {
      case 'system_info':
        return {
          action: 'system_info',
          shellCommand:
            "echo '=== OS ===' && cat /etc/os-release 2>/dev/null | head -6 || uname -a && echo '=== KERNEL ===' && uname -a && echo '=== ARCH ===' && uname -m",
          timeoutMs: 20_000,
          maxOutputBytes: 32 * 1024,
        };

      case 'uptime':
        return {
          action: 'uptime',
          shellCommand: "uptime && echo '---' && who -b 2>/dev/null || true",
          timeoutMs: 10_000,
          maxOutputBytes: 8 * 1024,
        };

      case 'memory_usage':
        return {
          action: 'memory_usage',
          shellCommand: "free -h 2>/dev/null && echo '---' && cat /proc/meminfo 2>/dev/null | head -10 || vm_stat 2>/dev/null || true",
          timeoutMs: 10_000,
          maxOutputBytes: 16 * 1024,
        };

      case 'disk_usage':
        return {
          action: 'disk_usage',
          shellCommand: 'df -hT 2>/dev/null || df -h',
          timeoutMs: 10_000,
          maxOutputBytes: 16 * 1024,
        };

      case 'port_list': {
        const listening = action.listeningOnly;
        const cmd = listening
          ? "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || ss -ulnp 2>/dev/null || true"
          : 'ss -tnpa 2>/dev/null || netstat -tna 2>/dev/null || true';
        return { action: 'port_list', shellCommand: cmd, timeoutMs: 15_000, maxOutputBytes: 48 * 1024 };
      }

      case 'top_processes': {
        const sortKey = action.sortBy === 'cpu' ? '%cpu' : '%mem';
        return {
          action: 'top_processes',
          shellCommand: `ps aux --sort=-${sortKey} | head -n ${action.limit + 1}`,
          timeoutMs: 15_000,
          maxOutputBytes: 32 * 1024,
        };
      }

      case 'journalctl': {
        const parts: string[] = ['journalctl', '--no-pager', `-n ${action.lines}`];
        if (action.unit) parts.push(`-u ${escapeShellArg(action.unit)}`);
        if (action.since) parts.push(`--since ${escapeShellArg(action.since)}`);
        if (action.priority) parts.push(`-p ${priorityLevel(action.priority)}`);
        if (action.bootOnly) parts.push('-b');
        parts.push('--utc');
        return {
          action: 'journalctl',
          shellCommand: parts.join(' '),
          timeoutMs: SshGuard.MAX_COMMAND_TIMEOUT_MS,
          maxOutputBytes: 96 * 1024,
        };
      }

      case 'systemctl_status':
        return {
          action: 'systemctl_status',
          shellCommand: `systemctl status --no-pager -l ${escapeShellArg(action.unit)}`,
          timeoutMs: 15_000,
          maxOutputBytes: 64 * 1024,
        };

      case 'read_remote_log': {
        const safePath = escapeShellArg(action.path);
        const grepPart = action.grep
          ? ` | grep -F -n -- ${escapeShellArg(action.grep)} || true`
          : '';
        return {
          action: 'read_remote_log',
          shellCommand: `tail -n ${action.lines} ${safePath}${grepPart}`,
          timeoutMs: 20_000,
          maxOutputBytes: 64 * 1024,
        };
      }

      case 'list_dir': {
        const safePath = escapeShellArg(action.path);
        return {
          action: 'list_dir',
          shellCommand:
            action.depth > 1
              ? `ls -lah --color=never -d ${safePath} && find ${safePath} -maxdepth ${action.depth - 1} -type f -ls 2>/dev/null | head -200`
              : `ls -lah --color=never -d ${safePath}`,
          timeoutMs: 15_000,
          maxOutputBytes: 48 * 1024,
        };
      }

      case 'stat_file': {
        const safePath = escapeShellArg(action.path);
        return {
          action: 'stat_file',
          shellCommand: `stat ${safePath} 2>/dev/null || stat -f %N:%s:%p -x ${safePath} 2>/dev/null || echo 'stat not available'`,
          timeoutMs: 10_000,
          maxOutputBytes: 16 * 1024,
        };
      }

      case 'kernel_modules': {
        const filterFlag = action.filter ? ` | grep -iF -- ${escapeShellArg(action.filter)}` : '';
        return {
          action: 'kernel_modules',
          shellCommand: `lsmod${filterFlag} | head -100`,
          timeoutMs: 10_000,
          maxOutputBytes: 32 * 1024,
        };
      }

      default: {
        const never: never = action as never;
        throw new ForgeError('SSH_ACTION_UNKNOWN', `未知诊断动作: ${String((never as { action?: string }).action)}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                              */
/* ------------------------------------------------------------------ */

function escapeShellArg(raw: string): string {
  if (/[\x00-\x1f]/.test(raw)) throw new ForgeError('SSH_ARG_INVALID', '参数包含非法控制字符');
  return `'${raw.replace(/'/g, "'\\''")}'`;
}

function priorityLevel(priority: 'error' | 'crit' | 'warning'): string {
  switch (priority) {
    case 'crit': return 'emerg..crit';
    case 'error': return 'emerg..err';
    case 'warning': return 'warning..warning';
    default: return 'emerg..err';
  }
}
