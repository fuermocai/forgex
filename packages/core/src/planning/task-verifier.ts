/**
 * TaskVerifier：步骤完成条件验证（v0.3.0 Phase 1）。
 *
 * 纯验证层——给定一个 TaskStep + 执行结果，按 step.verification.type
 * 判定是否"真的完成了"。不负责执行——StepExecutor 负责跑 AgentLoop。
 *
 * 验证类型（对应 types.ts StepVerification.type）：
 *   - tool_return_ok         — 执行的最后一个工具返回 result.success=true
 *   - file_exists            — 执行结果必须包含目标路径的成功读取/目录项证据
 *   - command_exit_zero      — 执行过程中 run_command 结果 code=0
 *   - git_no_conflict        — 完整 git_status 不含未合并项，且可用 diff 不含冲突标记
 *   - auto                   — 默认：result.success=true 且 verificationPassed=true 即可
 *
 * custom 暂未注册验证器，因此 fail closed。
 */
import type { ExecutionResult, StepVerification, TaskStep } from './types.js';

export interface VerifyResult {
  passed: boolean;
  /** 失败时给 StepExecutor / 模型看的说明 */
  reason?: string;
  /** 验证类型 */
  type: StepVerification['type'];
}

/**
 * 核心验证函数。
 * 纯函数，无外部依赖，不抛异常（只返回 passed=false）。
 */
export function verifyStep(step: TaskStep, result?: ExecutionResult): VerifyResult {
  const vtype = step.verification.type;

  if (vtype === 'auto') {
    // 默认：result.success=true 且 verificationPassed=true
    if (!result) return { passed: false, reason: '缺少执行结果', type: vtype };
    if (!result.success) return { passed: false, reason: `执行失败: ${result.failureReason ?? '未知'}`, type: vtype };
    if (!result.verificationPassed) return { passed: false, reason: '模型声称验证未通过', type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'tool_return_ok') {
    if (!result) return { passed: false, reason: '缺少执行结果', type: vtype };
    if (!result.success) return { passed: false, reason: `工具调用失败: ${result.failureReason ?? '未知'}`, type: vtype };
    const lastTool = result.toolResults?.at(-1);
    if (!lastTool) return { passed: false, reason: '缺少工具执行结果', type: vtype };
    if (!lastTool.ok) return { passed: false, reason: `最后一个工具调用失败: ${lastTool.toolName}`, type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'file_exists') {
    if (!result) return { passed: false, reason: '缺少执行结果', type: vtype };
    const target = normalizePath(step.verification.target ?? '');
    if (!target) return { passed: false, reason: 'file_exists 验证缺少目标路径', type: vtype };
    const exists = result.toolResults?.some((tool) => {
      if (!tool.ok || !tool.data || typeof tool.data !== 'object' || Array.isArray(tool.data)) return false;
      const data = tool.data as Record<string, unknown>;
      if (tool.toolName === 'read_file' && typeof data.path === 'string') return normalizePath(data.path) === target;
      if (tool.toolName === 'list_directory' && Array.isArray(data.entries)) {
        return data.entries.some((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
          const record = entry as Record<string, unknown>;
          return record.type === 'file' && typeof record.path === 'string' && normalizePath(record.path) === target;
        });
      }
      return false;
    });
    if (!exists) return { passed: false, reason: `没有证据证明目标文件存在: ${step.verification.target}`, type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'command_exit_zero') {
    if (!result) return { passed: false, reason: '缺少执行结果', type: vtype };
    if (!result.success) return { passed: false, reason: `命令执行失败: ${result.failureReason ?? '未知'}`, type: vtype };
    const exitedZero = result.toolResults?.some((tool) => {
      if (!tool.ok || tool.toolName !== 'run_command' || !tool.data || typeof tool.data !== 'object' || Array.isArray(tool.data)) return false;
      return (tool.data as Record<string, unknown>).exitCode === 0;
    });
    if (!exitedZero) return { passed: false, reason: '没有成功退出码为 0 的 run_command 结果', type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'git_no_conflict') {
    const statusResult = result?.toolResults?.find((tool) => tool.toolName === 'git_status' && tool.ok);
    if (!statusResult || statusResult.truncated || !statusResult.data || typeof statusResult.data !== 'object' || Array.isArray(statusResult.data)) {
      return { passed: false, reason: '缺少完整的 git_status 结果，无法验证冲突状态', type: vtype };
    }
    const entries = (statusResult.data as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) return { passed: false, reason: 'git_status 结果缺少文件状态', type: vtype };
    const hasUnmergedPath = entries.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const status = (entry as Record<string, unknown>).status;
      return typeof status === 'string' && (status.includes('U') || status === 'AA' || status === 'DD');
    });
    if (hasUnmergedPath) return { passed: false, reason: 'Git 状态中存在未合并文件', type: vtype };

    const diffResult = result?.toolResults?.find((tool) => tool.toolName === 'git_diff' && tool.ok);
    if (!diffResult || diffResult.truncated || !diffResult.data || typeof diffResult.data !== 'object' || Array.isArray(diffResult.data)) {
      return { passed: false, reason: '缺少完整的 git_diff 结果，无法验证冲突标记', type: vtype };
    }
    const diffData = diffResult.data as Record<string, unknown>;
    if (diffData.complete !== true || diffData.hasConflictMarkers !== false) {
      return { passed: false, reason: 'git_diff 未明确证明不存在冲突标记', type: vtype };
    }
    return { passed: true, type: vtype };
  }

  if (vtype === 'custom') {
    return { passed: false, reason: '尚未注册 custom 验证器', type: vtype };
  }

  return { passed: false, reason: `未知验证类型: ${vtype}`, type: vtype };
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
