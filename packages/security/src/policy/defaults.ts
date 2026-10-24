/**
 * 安全策略默认值。
 *
 * 设计原则：
 *  - 默认"最保守"：standard 模式下所有命令都需要人工审批，所有写入也需要审批。
 *  - 删除 / 重启 / 分区 / 防火墙 / 服务管理等高风险操作无条件拒绝，配置无法放开，
 *    只能由用户显式修改代码（而不是模型输出）来调整；递归删除的等价写法
 *    （`-r -f`、`-Rf`、`--recursive --force`）由 CommandGuard 在结构层统一拦截。
 *  - 白名单只降低审批频率，不等于沙箱；文档与 UI 必须如实说明这一点。
 */
import { resolve } from 'node:path';
import type { PermissionMode, PolicySettings, RemoteHostConfig } from '@forgex/shared';

/**
 * 无条件拒绝的程序（按 basename 匹配，忽略大小写与 .exe 后缀）。
 * 之所以单独于 `settings.deniedPrograms`，是为了防止配置文件被误改成
 * "允许 rm -rf" 这类组合；如需放开必须改代码并走代码评审。
 */
export const HARD_DENIED_PROGRAMS: readonly string[] = [
  'format',
  'mkfs',
  'mkfs.ext4',
  'mkfs.xfs',
  'mkfs.fat',
  'mkfs.ntfs',
  'mkfs.vfat',
  'mkswap',
  'fdisk',
  'sfdisk',
  'gdisk',
  'cgdisk',
  'parted',
  'diskpart',
  'diskutil',
  'dd',
  'shred',
  'wipefs',
  'hdparm',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  'bcdedit',
  'iptables',
  'ip6tables',
  'ufw',
  'netsh',
  'systemctl',
  'service',
  'reg',
  'regedit',
  'takeown',
  'icacls',
  'cacls',
];

/** 默认受保护路径（即使位于可写工作区也禁止修改） */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  '.git',
  '.forgex',
  '.env',
  '.env.local',
  '.env.production',
  '.ssh',
  'node_modules',
];

/** 默认拒绝的高危参数模式（对 args.join(' ') 做正则匹配） */
export const DEFAULT_DENIED_ARG_PATTERNS: readonly string[] = [
  '--no-preserve-root',
  '(^|\\s)-rf(\\s|$)',
  '(^|\\s)-fr(\\s|$)',
];

/** 默认传给子进程的环境变量白名单 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'USERNAME',
  'USER',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'PWD',
  'NODE_ENV',
];

export interface DefaultPolicyOptions {
  /** 授权工作区根目录（绝对路径优先；相对路径以进程 cwd 解析） */
  workspaceRoots: string[];
  /** 可写根目录，默认等于 workspaceRoots */
  writableRoots?: string[];
  mode?: PermissionMode;
  protectedPaths?: string[];
  allowedPrograms?: string[];
  deniedPrograms?: string[];
  deniedArgPatterns?: string[];
  commandTimeoutMs?: number;
  requireApprovalForWrite?: boolean;
  requireApprovalForExecute?: boolean;
  auditLogPath?: string;
  /** v0.2.0：SSH 远程授权主机列表（默认空 = 禁用 SSH） */
  remoteHosts?: RemoteHostConfig[];
}

/** 构造一份默认策略配置（调用方按需覆盖） */
export function createDefaultPolicySettings(options: DefaultPolicyOptions): PolicySettings {
  const roots = options.workspaceRoots.map((root) => resolve(root));
  return {
    mode: options.mode ?? 'standard',
    workspaceRoots: roots,
    writableRoots: (options.writableRoots ?? roots).map((root) => resolve(root)),
    protectedPaths: [...(options.protectedPaths ?? DEFAULT_PROTECTED_PATHS)],
    allowedPrograms: options.allowedPrograms ?? [],
    deniedPrograms: [...new Set([...(options.deniedPrograms ?? []), ...HARD_DENIED_PROGRAMS])],
    deniedArgPatterns: options.deniedArgPatterns ?? [...DEFAULT_DENIED_ARG_PATTERNS],
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
    commandTimeoutMs: options.commandTimeoutMs ?? 60_000,
    requireApprovalForWrite: options.requireApprovalForWrite ?? true,
    requireApprovalForExecute: options.requireApprovalForExecute ?? true,
    ...(options.auditLogPath ? { auditLogPath: options.auditLogPath } : {}),
    remoteHosts: options.remoteHosts ?? [],
  };
}

/** 取程序基名：`C:\Windows\System32\cmd.exe` -> `cmd`；`format.com` -> `format` */
export function programBasename(program: string): string {
  const base = program.replace(/\\/g, '/').split('/').pop() ?? program;
  return base.toLowerCase().replace(/\.(exe|com)$/, '');
}
