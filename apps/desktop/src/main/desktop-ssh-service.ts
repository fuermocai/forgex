import { SshClient } from '../../../../packages/devops/src/ssh/ssh-client.js';
import { SSH_PATH_REQUIREMENTS, SSH_PATH_UNAVAILABLE_EXIT, SshGuard } from '../../../../packages/devops/src/ssh/ssh-guard.js';
import { redactText } from '../../../../packages/shared/src/utils/redact.js';
import type { RemoteDiagActionDto, SshDiagnosticResult, SshHostProfile } from '../shared/desktop-api.js';

function guardedHost(profile: SshHostProfile) {
  if (!profile.hostKeyFingerprint) throw new Error('请先核对并信任主机指纹');
  const { host, port, username, privateKeyPath, hostKeyFingerprint } = profile;
  return { host, port, username, privateKeyPath, hostKeyFingerprint };
}

/** Only emit fixed messages, even if a local file or the remote server supplies the error. */
function sshFailure(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'TOOL_TIMEOUT': return new Error('SSH 连接超时，请检查主机、端口和网络');
    case 'SSH_HOSTKEY_MISMATCH': return new Error('主机指纹不匹配，连接已阻止。请重新核对指纹');
    case 'SSH_AUTH_FAILED': return new Error('私钥认证失败，请检查用户名、私钥文件、读取权限及是否有口令');
    case 'SSH_EXEC_FAILED': return new Error('远程诊断执行失败');
    case 'SSH_PATH_INVALID':
    case 'SSH_PATH_DENIED': return new Error('远程路径不在允许的诊断范围内');
    case 'SSH_ARG_INVALID':
    case 'SSH_ACTION_INVALID': return new Error('诊断动作或参数无效');
    case 'ABORTED': return new Error('SSH 操作已取消');
    default: return new Error('SSH 连接失败，请检查主机、端口和网络');
  }
}

function displayOutput(text: string, profile: SshHostProfile): string {
  const withoutKeys = text.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[私钥已隐藏]');
  return redactText(withoutKeys.replaceAll(profile.privateKeyPath, '[私钥路径]'));
}

export class DesktopSshService {
  private readonly guard = new SshGuard();
  private readonly client = new SshClient();

  async probeHostKey(profile: SshHostProfile, signal: AbortSignal) {
    try {
      return await this.client.probeHostKey(profile, signal);
    } catch (err) { throw sshFailure(err); }
  }

  async testConnection(profile: SshHostProfile, signal: AbortSignal) {
    const host = guardedHost(profile);
    try {
      await this.client.testConnection(host, signal);
      return { ok: true } as const;
    } catch (err) { throw sshFailure(err); }
  }

  async diagnose(profile: SshHostProfile, action: RemoteDiagActionDto, signal: AbortSignal): Promise<SshDiagnosticResult> {
    const spec = { host: guardedHost(profile), action };
    let result;
    try {
      const guarded = this.guard.validate(spec);
      result = await this.client.execute(spec, guarded, signal);
    } catch (err) { throw sshFailure(err); }
    signal.throwIfAborted();
    const { exitCode, truncated, durationMs, timedOut } = result;
    // 126/127 also cover a login shell that cannot invoke /bin/sh for the preflight.
    if ('path' in action && (exitCode === SSH_PATH_UNAVAILABLE_EXIT || exitCode === 126 || exitCode === 127)) {
      throw new Error(SSH_PATH_REQUIREMENTS);
    }
    return { action: action.action, stdout: displayOutput(result.stdout, profile), stderr: displayOutput(result.stderr, profile),
      exitCode, truncated, durationMs, timedOut };
  }
}
