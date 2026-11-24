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
import { isIPv6 } from 'node:net';
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
  if (normalized.split('/').includes('..')) return false;
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
  host: z.string().min(1).max(253).refine((host) => /^[a-zA-Z0-9._:-]+$/.test(host) || isIPv6(host)),
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

/** Parse the desktop IPC action without accepting caller-supplied command fields. */
export function parseRemoteDiagAction(raw: unknown) {
  const parsed = actionUnion.safeParse(raw);
  if (!parsed.success || !raw || typeof raw !== 'object'
    || Object.keys(raw).some((key) => !Object.hasOwn(parsed.data, key))) {
    throw new ForgeError('SSH_ACTION_INVALID', '诊断动作或参数无效');
  }
  return parsed.data;
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

      case 'read_remote_log':
        return { action: action.action, shellCommand: pathDiagnosticCommand(action), timeoutMs: 20_000, maxOutputBytes: 64 * 1024 };
      case 'list_dir':
        return { action: action.action, shellCommand: pathDiagnosticCommand(action), timeoutMs: 15_000, maxOutputBytes: 48 * 1024 };
      case 'stat_file':
        return { action: action.action, shellCommand: pathDiagnosticCommand(action), timeoutMs: 10_000, maxOutputBytes: 16 * 1024 };

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

/** EX_UNAVAILABLE is reserved for a missing remote path-diagnostic prerequisite. */
export const SSH_PATH_UNAVAILABLE_EXIT = 69;
export const SSH_PATH_REQUIREMENTS = '远端主机不支持此路径诊断。需要 Linux O_PATH、/proc/self/fd、/bin/sh、Python 3.4 或更高版本、base64 -d 和相应的诊断命令。';

// ASCII keeps the preflight usable on hosts with a C locale.
const remoteRequirements = 'Unsupported SSH path diagnostic: requires Linux O_PATH, /proc/self/fd, /bin/sh, Python 3.4 or later, base64 -d and the diagnostic utilities.';

/** Fixed remote program. Open metadata without touching device/FIFO data or requiring read permission.
 * Each utility operates on the pinned object or the directory selected by fchdir.
 */
const pathDiagnosticProgram = `
import base64
import json
import os
import shutil
import stat
import sys

def has_prerequisites(request):
    tools = {"stat_file": ["stat"], "list_dir": ["find", "head"], "read_remote_log": ["tail"]}[request["action"]]
    if request.get("grep"):
        tools.append("grep")
    if any(shutil.which(tool) is None for tool in tools):
        return False
    try:
        fd = os.open("/", os.O_PATH | os.O_CLOEXEC)
        try:
            return os.readlink("/proc/self/fd/" + str(fd)) == "/"
        finally:
            os.close(fd)
    except (AttributeError, OSError):
        return False

def inspect_target(request):
    fd = os.open(request["path"], os.O_PATH | os.O_CLOEXEC)
    try:
        ref = "/proc/self/fd/" + str(fd)
        resolved = os.readlink(ref)
        roots = ${JSON.stringify(ALLOWED_LOG_DIRS)}
        if not any(resolved == root[:-1] or resolved.startswith(root) for root in roots):
            raise ValueError("outside diagnostic roots")
        mode = os.fstat(fd).st_mode
        os.set_inheritable(fd, True)
        action = request["action"]
        if action == "stat_file":
            os.execlp("stat", "stat", "-L", "--", ref)
        if action == "list_dir" and stat.S_ISDIR(mode):
            os.fchdir(fd)
            script = 'find -P . -mindepth 1 -maxdepth "$1" -ls | head -200'
            os.execl("/bin/sh", "sh", "-c", script, "sh", str(request["depth"]))
        if action == "read_remote_log" and stat.S_ISREG(mode):
            # Opening through this descriptor cannot switch to a different inode.
            data_fd = os.open(ref, os.O_RDONLY | os.O_NONBLOCK)
            os.dup2(data_fd, 0)
            if data_fd != 0:
                os.close(data_fd)
            lines = str(request["lines"])
            if not request.get("grep"):
                os.execlp("tail", "tail", "-n", lines)
            script = 'tail -n "$1" | grep -F -n -- "$2"; result=$?; [ "$result" -le 1 ]'
            os.execl("/bin/sh", "sh", "-c", script, "sh", lines, request["grep"])
        raise ValueError("unsupported diagnostic target")
    finally:
        os.close(fd)

try:
    request = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    if not has_prerequisites(request):
        print(${JSON.stringify(remoteRequirements)}, file=sys.stderr)
        sys.exit(${SSH_PATH_UNAVAILABLE_EXIT})
    inspect_target(request)
except (AttributeError, OSError, ValueError):
    sys.exit("SSH diagnostic target is unavailable or outside allowed roots")
`;

const pathProgramArgument = Buffer.from(pathDiagnosticProgram).toString('base64');
type PathDiagnostic = Extract<z.infer<typeof actionUnion>, { action: 'read_remote_log' | 'list_dir' | 'stat_file' }>;

function pathDiagnosticCommand(action: PathDiagnostic): string {
  // SSH delivers a command string to the account's login shell. Only this fixed quoted
  // argument and two shell-neutral base64 words cross it. User input is always data.
  if (/[\x00-\x1f]/.test(action.path) || (action.action === 'read_remote_log' && action.grep && /[\x00-\x1f]/.test(action.grep))) {
    throw new ForgeError('SSH_ARG_INVALID', '参数包含非法控制字符');
  }
  const payload = Buffer.from(JSON.stringify(action)).toString('base64');
  const launcher = [
    `unavailable() { echo "${remoteRequirements}" >&2; exit ${SSH_PATH_UNAVAILABLE_EXIT}; }`,
    'python3 -I -c "import sys; sys.exit(sys.version_info < (3, 4) or not sys.flags.isolated)" >/dev/null 2>&1 || unavailable',
    'script=$(printf %s "$1" | base64 -d 2>/dev/null) || unavailable',
    'exec python3 -I -c "$script" "$2"',
  ].join('; ');
  return `/bin/sh -c '${launcher}' sh ${pathProgramArgument} ${payload}`;
}

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
