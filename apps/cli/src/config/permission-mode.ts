/**
 * 权限模式（readonly / standard / trusted / yolo）的枚举、别名解析与循环切换。
 *
 * 为什么单独抽一个纯函数模块：
 *  - 三处入口共用同一套规则：`--mode` 参数（config 层）、TUI 的 Shift+Tab 与 `/mode`、
 *    纯文本模式的 `/mode`，避免各自维护一份顺序表导致行为漂移；
 *  - 不依赖 Ink / 终端，可以直接单测。
 *
 * 语义必须与 packages/security/src/policy/policy-engine.ts 的 `evaluateMode` 保持一致：
 *  readonly  只读放行，其余一律 deny
 *  standard  读放行；write / execute 按 requireApprovalFor* 决定 ask 或 allow
 *  trusted   除 privileged 外放行；execute 仍按 requireApprovalForExecute 决定
 *  yolo      全部 allow，审批被关闭
 */
import type { PermissionMode } from '@forgex/shared';

/** 由弱到强（由保守到激进）的顺序：`Shift+Tab` 与 `/mode` 的循环顺序都基于它 */
export const PERMISSION_MODES: readonly PermissionMode[] = ['readonly', 'standard', 'trusted', 'yolo'];

/** 各模式的一句话解释（`/mode` 列表与 doctor 自检用） */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  readonly: '只读：只能读，写文件/执行命令一律被策略拒绝',
  standard: '标准：读放行，写文件与执行命令逐次人工审批',
  trusted: '受信：写文件自动放行，执行命令与高危操作仍需审批',
  yolo: '放开：关闭全部审批，全部直接执行（风险自负）',
};

/** 常见写法与手滑输入的别名 */
const ALIASES: Record<string, PermissionMode> = {
  readonly: 'readonly',
  'read-only': 'readonly',
  ro: 'readonly',
  read: 'readonly',
  standard: 'standard',
  std: 'standard',
  default: 'standard',
  normal: 'standard',
  trusted: 'trusted',
  trust: 'trusted',
  yolo: 'yolo',
  unsafe: 'yolo',
  danger: 'yolo',
};

/** 判断任意值是否合法权限模式 */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * 解析字符串为权限模式（大小写不敏感，支持别名）。
 *
 * @returns 合法模式；无法识别时返回 `null`（由调用方决定报错还是忽略）
 */
export function parsePermissionMode(raw: string): PermissionMode | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if (isPermissionMode(key)) return key;
  return ALIASES[key] ?? null;
}

/**
 * 循环到下一个模式：readonly → standard → trusted → yolo → readonly。
 * 当前值非法时回到最保守的 readonly，避免"未知模式"把权限放大。
 */
export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const index = PERMISSION_MODES.indexOf(current);
  if (index < 0) return PERMISSION_MODES[0]!;
  return PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length]!;
}

/** `readonly / standard / trusted / yolo` 形式的可选值列表（用于报错信息） */
export function permissionModeList(): string {
  return PERMISSION_MODES.join(' / ');
}

/** 多行模式说明（`/mode` 不带参数时打印） */
export function permissionModeHelp(current: PermissionMode, planMode = false): string {
  const lines = [
    '可用权限模式（由严到宽）：',
    ...PERMISSION_MODES.map(
      (mode) => `  ${mode.padEnd(9)} ${PERMISSION_MODE_LABELS[mode]}${mode === current ? '  ← 当前' : ''}`,
    ),
  ];
  if (planMode) {
    lines.push('', '当前处于计划模式（权限按 readonly 执行，写操作会被直接拒绝）；/mode agent 退出计划模式');
  }
  lines.push('切换：/mode <模式>，或按 Shift+Tab 依次循环');
  return lines.join('\n');
}
