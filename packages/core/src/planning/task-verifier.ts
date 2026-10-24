/**
 * TaskVerifier：步骤完成条件验证（v0.3.0 Phase 1）。
 *
 * 纯验证层——给定一个 TaskStep + 执行结果，按 step.verification.type
 * 判定是否"真的完成了"。不负责执行——StepExecutor 负责跑 AgentLoop。
 *
 * 验证类型（对应 types.ts StepVerification.type）：
 *   - tool_return_ok         — 执行的最后一个工具返回 result.success=true
 *   - file_exists            — result.evidence_refs 里应该有 code_snippet 且 source 是文件路径
 *   - command_exit_zero      — 执行过程中 run_command 结果 code=0
 *   - git_no_conflict        — 没有 git merge conflict 证据
 *   - auto                   — 默认：result.success=true 且 verificationPassed=true 即可
 *
 * 未来扩展：custom type 让模型定义验证逻辑（需要 prompt + context）。
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
    // 要求至少调了一次工具
    if (result.toolCallCount === 0) return { passed: false, reason: '未调用任何工具', type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'file_exists') {
    if (!result) return { passed: false, reason: '缺少执行结果', type: vtype };
    // 有 code_snippet 或 git_diff_hunk 类型证据就当通过
    const hasEvidence = step.evidence_refs.some(
      (e) => e.kind === 'code_snippet' || e.kind === 'git_diff_hunk' || e.kind === 'git_commit',
    );
    if (!hasEvidence) return { passed: false, reason: '缺少文件相关证据', type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'command_exit_zero') {
    if (!result) return { passed: false, reason: '缺少执行结果', type: vtype };
    if (!result.success) return { passed: false, reason: `命令执行失败: ${result.failureReason ?? '未知'}`, type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'git_no_conflict') {
    // 没有 git_diff_hunk 包含 "<<<<<<<" 或 ">>>>>>>" 就通过
    const conflict = step.evidence_refs.some(
      (e) => e.kind === 'git_diff_hunk' && /^(<<<<<<<|>>>>>>>|=======)/m.test(e.description ?? ''),
    );
    if (conflict) return { passed: false, reason: '存在 git 冲突标记', type: vtype };
    return { passed: true, type: vtype };
  }

  if (vtype === 'custom') {
    // custom 验证交给外部——默认通过
    return { passed: true, type: vtype };
  }

  return { passed: false, reason: `未知验证类型: ${vtype}`, type: vtype };
}
