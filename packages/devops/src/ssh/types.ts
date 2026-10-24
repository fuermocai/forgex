/**
 * SSH 远程诊断：结构化类型定义。
 *
 * 核心设计原则：
 *   远程执行**绝不接受任意 shell 命令字符串**。模型只能发起一组预定义的
 *   "诊断动作"（RemoteDiagAction），每个 action 在 ssh-guard.ts 里映射到
 *   固定的命令模板 + 参数校验，模型无法绕过。
 *
 * 为什么不用命令字符串：
 *   - 模型可能编造或拼接危险命令；
 *   - 参数注入（如 `journalctl -u xxx --output=cat /etc/passwd`）很难防御；
 *   - 白名单 action 是最小权限原则：Agent 能"做什么"由开发者定义，
 *     不是由模型决定。
 */
import type { JsonValue } from '@forgex/shared';

/* ------------------------------------------------------------------ */
/* 主机配置                                                              */
/* ------------------------------------------------------------------ */

/**
 * 远程主机配置。
 *
 * 安全约束（由 SSH Guard 强制执行）：
 *   - hostKey 必填：禁止 StrictHostKeyChecking=no，防止中间人；
 *   - password 字段**故意缺失**：第一版只允许密钥认证；
 *   - username 必须非空且不包含非法字符（ssh-guard 再校验）。
 */
export interface SshHostConfig {
  /** 主机名或 IP 地址 */
  host: string;
  /** SSH 端口，默认 22 */
  port?: number;
  /** 登录用户 */
  username: string;
  /**
   * 私钥文件路径（绝对或相对于授权工作区）。
   * 私钥文件本身不受工具读取权限约束（Guard 会单独校验路径白名单）。
   */
  privateKeyPath: string;
  /**
   * 期望的主机公钥指纹（SHA256: 开头的 base64）。
   * 连接建立后必须校验指纹匹配，否则立即断开。
   */
  hostKeyFingerprint?: string;
  /**
   * 允许的主机名别名列表（可选）。
   * 若配置了则 host 必须命中其一，防止模型随意连接未授权主机。
   */
  allowedAliases?: string[];
}

/* ------------------------------------------------------------------ */
/* 诊断动作（Action 白名单）                                              */
/* ------------------------------------------------------------------ */

/**
 * 预定义的远程诊断动作。
 *
 * 每个 action 的命令模板和参数校验在 ssh-guard.ts 里单独定义。
 * 这里只声明输入结构，不做任何执行。
 */
export type RemoteDiagAction =
  | SystemInfoAction
  | TopProcessesAction
  | PortListAction
  | DiskUsageAction
  | MemoryUsageAction
  | JournalCtlAction
  | SystemCtlStatusAction
  | ReadRemoteLogAction
  | ListDirAction
  | StatFileAction
  | UptimeAction
  | KernelModulesAction;

export interface SystemInfoAction {
  action: 'system_info';
}

export interface TopProcessesAction {
  action: 'top_processes';
  /** 最多返回多少条进程，默认 15 */
  limit?: number;
  /** 排序键：内存或 CPU */
  sortBy?: 'memory' | 'cpu';
}

export interface PortListAction {
  action: 'port_list';
  /** 只返回监听状态，默认 true */
  listeningOnly?: boolean;
}

export interface DiskUsageAction {
  action: 'disk_usage';
}

export interface MemoryUsageAction {
  action: 'memory_usage';
}

/**
 * 读取 systemd journal 日志。
 * 只允许 journalctl 的只读参数组合，输出被截断。
 */
export interface JournalCtlAction {
  action: 'journalctl';
  /** systemd unit 名（可省略 .service） */
  unit?: string;
  /** 日志行数上限，默认 100 */
  lines?: number;
  /** 从时间戳开始读取（ISO 8601），或 "1 hour ago" 等相对时间 */
  since?: string;
  /** 只看错误级别及以上 */
  priority?: 'error' | 'crit' | 'warning';
  /** 只看本引导周期 */
  bootOnly?: boolean;
}

export interface SystemCtlStatusAction {
  action: 'systemctl_status';
  /** systemd unit 名 */
  unit: string;
}

/**
 * 读取远程日志文件。
 * 只允许读取白名单目录（/var/log、/var/log/*.log、journalctl 输出），
 * 禁止读取 /etc、/root/.ssh、应用配置等敏感路径。
 */
export interface ReadRemoteLogAction {
  action: 'read_remote_log';
  /** 日志文件路径（绝对路径），必须位于白名单目录内 */
  path: string;
  /** 从尾部读取的行数上限，默认 100 */
  lines?: number;
  /** 过滤关键字（grep -F 精确匹配） */
  grep?: string;
}

export interface ListDirAction {
  action: 'list_dir';
  /** 目录路径，必须位于允许的只读目录（如 /var/log、/tmp） */
  path: string;
  /** 递归深度，默认 1（不递归），最大 3 */
  depth?: number;
}

export interface StatFileAction {
  action: 'stat_file';
  path: string;
}

export interface UptimeAction {
  action: 'uptime';
}

export interface KernelModulesAction {
  action: 'kernel_modules';
  /** 按关键字过滤模块名或描述 */
  filter?: string;
}

/* ------------------------------------------------------------------ */
/* 执行结果                                                              */
/* ------------------------------------------------------------------ */

/**
 * SSH 结构化执行结果。
 *
 * 与 Rust Executor 的 ExecResult 对齐，但这里是远程执行层的结果；
 * 后续 Dispatcher 会再做 ToolResult 封装。
 */
export interface SshExecuteResult {
  /** SSH 命令退出码；连接失败/校验失败时为 null */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 输出超过上限被截断 */
  truncated: boolean;
  /** 执行超时被终止 */
  timedOut: boolean;
  /** 本次执行耗时（毫秒） */
  durationMs: number;
  /** 执行的诊断动作类型（便于审计与诊断关联） */
  action: string;
  /** 原始诊断动作输入（审计用，已脱敏） */
  input: JsonValue;
  /** SSH 连接层错误（拒绝主机、密钥不可用等） */
  connectionError?: string;
}

/* ------------------------------------------------------------------ */
/* SSH 连接配置                                                          */
/* ------------------------------------------------------------------ */

export interface SshConnectOptions {
  /** 单条命令执行超时（毫秒），默认 30s */
  commandTimeoutMs?: number;
  /** SSH 连接超时（毫秒），默认 10s */
  connectTimeoutMs?: number;
  /** 最大 stdout/stderr 输出（字节），默认 256KB */
  maxOutputBytes?: number;
  /** 启用详细日志（调试用，不进审计） */
  verbose?: boolean;
}

export interface SshExecSpec {
  host: SshHostConfig;
  action: RemoteDiagAction;
  options?: SshConnectOptions;
}
