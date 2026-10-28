/**
 * TaskVerifier：步骤完成条件验证（v0.3.0 Phase 1）。
 *
 * 纯验证层——给定一个 TaskStep + 执行结果，按 step.verification.type
 * 判定是否"真的完成了"。不负责执行——StepExecutor 负责跑 AgentLoop。
 *
 * 验证类型（对应 types.ts StepVerification.type）：
 *   - tool_return_ok         — 所有工具调用成功且未截断，最后一个工具成功
 *   - file_exists            — 执行结果必须包含目标路径的成功读取/目录项证据
 *   - file_changed           — 执行结果必须包含本步骤 edit_file / write_file 成功修改目标路径的证据
 *   - file_content           — 完整文件内容的 SHA-256 必须匹配 expectedContent
 *   - command_exit_zero      — 执行过程中 run_command 结果 code=0
 *   - git_no_conflict        — 完整 git_status 不含未合并项，且可用 diff 不含冲突标记
 *   - auto                   — 默认：result.success=true 且 verificationPassed=true 即可
 *
 * custom 暂未注册验证器，因此 fail closed。
 */
import type { ExecutionResult, StepVerification, TaskStep } from './types.js';
import { createHash } from 'node:crypto';

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
    if (!result || !hasCleanToolEvidence(result)) return { passed: false, reason: toolEvidenceFailure(result), type: vtype };
    const lastTool = result.toolResults?.at(-1);
    if (!lastTool) return { passed: false, reason: '缺少工具执行结果', type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'file_exists') {
    if (!result || !hasCleanToolEvidence(result)) return { passed: false, reason: toolEvidenceFailure(result), type: vtype };
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

  if (vtype === 'file_changed') {
    if (!result || !hasCleanToolEvidence(result)) return { passed: false, reason: toolEvidenceFailure(result), type: vtype };
    const target = normalizePath(step.verification.target ?? '');
    if (!target) return { passed: false, reason: 'file_changed 验证缺少目标路径', type: vtype };
    const targetOperations = fileOperationsFor(result, target, ['edit_file', 'write_file']);
    const finalOperation = targetOperations.at(-1);
    if (!finalOperation || finalOperation.changed !== true) {
      return { passed: false, reason: `没有证据证明本步骤最终修改了目标文件: ${step.verification.target}`, type: vtype };
    }
    return { passed: true, type: vtype };
  }

  if (vtype === 'file_content') {
    if (!result || !hasCleanToolEvidence(result)) return { passed: false, reason: toolEvidenceFailure(result), type: vtype };
    const target = normalizePath(step.verification.target ?? '');
    const expected = step.verification.expectedContent;
    if (!target) return { passed: false, reason: 'file_content 验证缺少目标路径', type: vtype };
    if (expected === undefined) return { passed: false, reason: 'file_content 验证缺少 expectedContent', type: vtype };
    const finalOperation = fileOperationsFor(result, target, ['read_file', 'edit_file', 'write_file']).at(-1);
    const expectedHash = sha256(expected);
    if (!finalOperation || finalOperation.contentComplete !== true || finalOperation.contentHash !== expectedHash) {
      return { passed: false, reason: `目标文件完整内容与预期不一致或缺少完整证据: ${step.verification.target}`, type: vtype };
    }
    return { passed: true, type: vtype };
  }

  if (vtype === 'command_exit_zero') {
    if (!result || !hasCleanToolEvidence(result)) return { passed: false, reason: toolEvidenceFailure(result), type: vtype };
    const commands = result.toolResults!.filter((tool) => tool.toolName === 'run_command');
    const allExitedZero = commands.length > 0 && commands.every((tool) => {
      if (!tool.data || typeof tool.data !== 'object' || Array.isArray(tool.data)) return false;
      const data = tool.data as Record<string, unknown>;
      return (data.exitCode ?? data.code) === 0;
    });
    if (!allExitedZero) return { passed: false, reason: '没有 run_command 结果，或存在非零/缺失退出码', type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'git_no_conflict') {
    if (!result || !hasCleanToolEvidence(result)) return { passed: false, reason: toolEvidenceFailure(result), type: vtype };
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

function fileOperationsFor(
  result: ExecutionResult,
  target: string,
  allowedTools: readonly string[],
): Array<{ changed?: boolean; contentHash?: string; contentComplete?: boolean }> {
  return (result.toolResults ?? []).flatMap((tool) => {
    if (!allowedTools.includes(tool.toolName) || !tool.data || typeof tool.data !== 'object' || Array.isArray(tool.data)) return [];
    const data = tool.data as Record<string, unknown>;
    if (typeof data.path !== 'string' || normalizePath(data.path) !== target) return [];
    return [{
      ...(typeof data.changed === 'boolean' ? { changed: data.changed } : {}),
      ...(typeof data.contentHash === 'string' ? { contentHash: data.contentHash } : {}),
      ...(typeof data.contentComplete === 'boolean' ? { contentComplete: data.contentComplete } : {}),
    }];
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

function hasCleanToolEvidence(result?: ExecutionResult): boolean {
  return Boolean(
    result?.success
    && result.toolResults?.length
    && result.toolResults.every((tool) => tool.ok && !tool.truncated),
  );
}

function toolEvidenceFailure(result?: ExecutionResult): string {
  if (!result) return '缺少执行结果';
  if (!result.success) return `工具调用失败: ${result.failureReason ?? '未知'}`;
  const failed = result.toolResults?.find((tool) => !tool.ok);
  if (failed) return `执行期间存在失败的工具调用: ${failed.toolName}`;
  const truncated = result.toolResults?.find((tool) => tool.truncated);
  if (truncated) return `执行期间存在被截断的工具结果: ${truncated.toolName}`;
  return '缺少工具执行结果';
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
