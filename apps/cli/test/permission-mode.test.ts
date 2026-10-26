/**
 * 权限模式纯函数测试。
 *
 * 这些函数被三处入口共用（`--mode`、TUI 的 Shift+Tab 与 `/mode`、纯文本 `/mode`），
 * 所以「别名解析」「循环顺序」「非法值处理」必须锁死，避免某一处行为漂移。
 */
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_MODES,
  isPermissionMode,
  nextPermissionMode,
  parsePermissionMode,
  permissionModeHelp,
  permissionModeList,
} from '../src/config/permission-mode.js';

describe('parsePermissionMode', () => {
  it('识别四个标准模式', () => {
    expect(parsePermissionMode('readonly')).toBe('readonly');
    expect(parsePermissionMode('standard')).toBe('standard');
    expect(parsePermissionMode('trusted')).toBe('trusted');
    expect(parsePermissionMode('yolo')).toBe('yolo');
  });

  it('大小写与前后空格不敏感', () => {
    expect(parsePermissionMode('  YOLO ')).toBe('yolo');
    expect(parsePermissionMode('Trusted')).toBe('trusted');
  });

  it('支持常见别名', () => {
    expect(parsePermissionMode('read-only')).toBe('readonly');
    expect(parsePermissionMode('ro')).toBe('readonly');
    expect(parsePermissionMode('std')).toBe('standard');
    expect(parsePermissionMode('trust')).toBe('trusted');
    expect(parsePermissionMode('danger')).toBe('yolo');
  });

  it('无法识别的值返回 null（由调用方决定报错）', () => {
    expect(parsePermissionMode('plan')).toBeNull();
    expect(parsePermissionMode('agent')).toBeNull();
    expect(parsePermissionMode('')).toBeNull();
    expect(parsePermissionMode('root')).toBeNull();
  });
});

describe('nextPermissionMode', () => {
  it('按由严到宽循环，末位回到首位', () => {
    expect(nextPermissionMode('readonly')).toBe('standard');
    expect(nextPermissionMode('standard')).toBe('trusted');
    expect(nextPermissionMode('trusted')).toBe('yolo');
    expect(nextPermissionMode('yolo')).toBe('readonly');
  });

  it('循环顺序与 PERMISSION_MODES 一致且长度固定', () => {
    expect(PERMISSION_MODES).toEqual(['readonly', 'standard', 'trusted', 'yolo']);
    let current = PERMISSION_MODES[0]!;
    const seen: string[] = [];
    for (let i = 0; i < PERMISSION_MODES.length; i += 1) {
      seen.push(current);
      current = nextPermissionMode(current);
    }
    expect(seen).toEqual([...PERMISSION_MODES]);
    expect(current).toBe(PERMISSION_MODES[0]);
  });
});

describe('展示辅助', () => {
  it('isPermissionMode 只认四个标准值', () => {
    expect(isPermissionMode('standard')).toBe(true);
    expect(isPermissionMode('std')).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
  });

  it('permissionModeList 拼出可选值', () => {
    expect(permissionModeList()).toBe('readonly / standard / trusted / yolo');
  });

  it('permissionModeHelp 标出当前模式，并在计划模式下给出退出提示', () => {
    const help = permissionModeHelp('trusted');
    expect(help).toContain('trusted');
    expect(help).toContain('← 当前');
    expect(help).not.toContain('退出计划模式');

    const planHelp = permissionModeHelp('readonly', true);
    expect(planHelp).toContain('计划模式');
    expect(planHelp).toContain('/mode agent');
  });
});
