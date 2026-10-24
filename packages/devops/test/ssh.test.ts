/**
 * SshGuard 安全负向测试。
 *
 * 目标：验证 Guard 拒绝所有绕过安全边界的输入。
 * 纯单元测试，不需要真实 SSH 连接。
 */
import { describe, expect, it } from 'vitest';
import { SshGuard } from '../src/ssh/ssh-guard.js';
import { ForgeError } from '@forgex/shared';
import type { SshExecSpec } from '../src/ssh/types.js';

const FAKE_FINGERPRINT = 'SHA256:' + 'a'.repeat(30);

function validHost() {
  return {
    host: 'test.example.com',
    port: 22,
    username: 'forgex',
    privateKeyPath: '/home/forgex/.ssh/id_rsa',
    hostKeyFingerprint: FAKE_FINGERPRINT,
    allowedAliases: ['test.example.com'],
  };
}

function tryValidate(spec: SshExecSpec): { code?: string; message?: string; thrown: boolean } {
  try {
    new SshGuard().validate(spec);
    return { thrown: false };
  } catch (err) {
    const fe = err as ForgeError;
    return { code: fe.code, message: fe.message, thrown: true };
  }
}

const guard = new SshGuard();

describe('SshGuard Host 校验', () => {
  it('缺少 Host Key 指纹 → SSH_HOSTKEY_MISSING', () => {
    const host = { ...validHost(), hostKeyFingerprint: undefined };
    const result = tryValidate({ host, action: { action: 'system_info' } });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_HOSTKEY_MISSING');
    expect(result.message).toMatch(/Host Key 指纹/);
  });

  it('主机不在白名单 → SSH_HOST_DENIED', () => {
    const host = { ...validHost(), allowedAliases: ['other.example.com'] };
    const result = tryValidate({ host, action: { action: 'system_info' } });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_HOST_DENIED');
  });

  it('白名单未配置时主机合法 → 通过', () => {
    const host = { ...validHost(), allowedAliases: undefined };
    const result = tryValidate({ host, action: { action: 'system_info' } });
    expect(result.thrown).toBe(false);
  });

  it('主机名含非法字符 → SSH_HOST_INVALID', () => {
    const host = { ...validHost(), host: 'evil; rm -rf /' };
    const result = tryValidate({ host, action: { action: 'system_info' } });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_HOST_INVALID');
  });

  it('用户名字段非法 → SSH_HOST_INVALID', () => {
    const host = { ...validHost(), username: 'forgex; su root' };
    const result = tryValidate({ host, action: { action: 'system_info' } });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_HOST_INVALID');
  });

  it('非法端口 → SSH_HOST_INVALID', () => {
    const host = { ...validHost(), port: 999999 as unknown as number };
    const result = tryValidate({ host, action: { action: 'system_info' } });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_HOST_INVALID');
  });
});

describe('SshGuard Action 校验', () => {
  it('未知 action → SSH_ACTION_INVALID', () => {
    const result = tryValidate({ host: validHost(), action: { action: 'rm_rf_all' } as unknown as SshExecSpec['action'] });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_ACTION_INVALID');
  });

  it('journalctl unit 名含 shell 元字符 → SSH_ACTION_INVALID', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'journalctl', unit: 'nginx; rm -rf /' },
    });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_ACTION_INVALID');
  });

  it('journalctl unit 名含空格 → SSH_ACTION_INVALID', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'journalctl', unit: 'bad name' },
    });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_ACTION_INVALID');
  });

  it('journalctl 行数超限 → SSH_ACTION_INVALID', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'journalctl', unit: 'nginx.service', lines: 99999 },
    });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_ACTION_INVALID');
  });

  it('systemctl_status 缺少 unit → SSH_ACTION_INVALID', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'systemctl_status' },
    });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_ACTION_INVALID');
  });
});

describe('SshGuard 路径安全', () => {
  it('read_remote_log /etc/passwd → SSH_PATH_DENIED', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'read_remote_log', path: '/etc/passwd', lines: 50 },
    });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_PATH_DENIED');
  });

  it('read_remote_log /root/.ssh → SSH_PATH_DENIED', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'read_remote_log', path: '/root/.ssh/id_rsa', lines: 50 },
    });
    expect(result.thrown).toBe(true);
    expect(result.code).toBe('SSH_PATH_DENIED');
  });

  it('read_remote_log 路径含 shell 元字符 → SSH_PATH_INVALID', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'read_remote_log', path: '/var/log/a; rm -rf /', lines: 50 },
    });
    expect(result.thrown).toBe(true);
    expect(['SSH_PATH_INVALID', 'SSH_PATH_DENIED']).toContain(result.code!);
  });

  it('read_remote_log 合法路径 /var/log/syslog → 通过', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'read_remote_log', path: '/var/log/syslog', lines: 100 },
    });
    expect(result.thrown).toBe(false);
  });

  it('list_dir 允许 /home → 通过', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'list_dir', path: '/home', depth: 1 },
    });
    expect(result.thrown).toBe(false);
  });

  it('stat_file 允许 /tmp → 通过', () => {
    const result = tryValidate({
      host: validHost(),
      action: { action: 'stat_file', path: '/tmp/test.log' },
    });
    expect(result.thrown).toBe(false);
  });
});

describe('SshGuard 命令模板安全', () => {
  it('journalctl 命令不包含危险管道/重定向', () => {
    const guarded = guard.validate({
      host: validHost(),
      action: { action: 'journalctl', unit: 'nginx.service', lines: 50 },
    });
    const cmd = guarded.command.shellCommand;
    expect(cmd).toMatch(/^journalctl/);
    expect(cmd).toContain("-u 'nginx.service'");
    // 禁止危险拼接
    expect(cmd).not.toMatch(/;\s*rm\b/);
    expect(cmd).not.toMatch(/\|\s*sh\b/);
    expect(cmd).not.toMatch(/`/);
  });

  it('top_processes 排序键白名单化', () => {
    const guarded = guard.validate({
      host: validHost(),
      action: { action: 'top_processes', sortBy: 'cpu', limit: 5 },
    });
    expect(guarded.command.shellCommand).toContain('--sort=-%cpu');
    expect(guarded.command.shellCommand).not.toMatch(/rm|curl|wget/);
  });

  it('kernel_modules filter 被单引号包裹', () => {
    const guarded = guard.validate({
      host: validHost(),
      action: { action: 'kernel_modules', filter: 'netdev' },
    });
    expect(guarded.command.shellCommand).toContain("'netdev'");
  });

  it('所有 action 都是只读命令模板（不涉及 apt/yum/dnf/pip/npm install）', () => {
    const allActions = [
      { action: 'system_info' },
      { action: 'uptime' },
      { action: 'memory_usage' },
      { action: 'disk_usage' },
      { action: 'port_list', listeningOnly: true },
      { action: 'top_processes', limit: 5 },
      { action: 'journalctl', lines: 10 },
      { action: 'kernel_modules', filter: 'netdev' },
    ];
    for (const spec of allActions) {
      const guarded = guard.validate({ host: validHost(), action: spec as unknown as SshExecSpec['action'] });
      const cmd = guarded.command.shellCommand.toLowerCase();
      expect(cmd, `${spec.action} 不应包含危险命令`).not.toMatch(/apt|yum|dnf|brew|pip\s+install|npm\s+install|wget|curl\s|bash\s+-c/);
    }
  });
});
