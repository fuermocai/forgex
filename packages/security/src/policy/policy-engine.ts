/**
 * PolicyEngine：权限判定的唯一权威。
 *
 * 判定顺序（先拒绝、后放行）：
 *  1. 受保护路径（写入类）—— 无条件拒绝；
 *  2. 硬拒绝程序 / 配置黑名单程序 / 高危参数 —— 无条件拒绝；
 *  3. 权限模式矩阵 —— allow / ask / deny；
 *  4. 程序白名单 —— 未命中降级为 ask（而不是 deny，保留人工审批通道）。
 *
 * 重要约束：
 *  - 本模块只做"是否允许"的判断，不执行任何 IO；
 *  - 模型无法访问本对象，也无法修改 settings；运行时切换（如 TUI 的 /plan、
 *    配置里的 mode）只能由本地用户操作，且仅影响本次进程。
 *  - 白名单不等于沙箱，allow 仅表示"不需要审批"，不代表隔离。
 */
import type {
  JsonValue,
  PermissionMode,
  PolicyDecision,
  PolicySettings,
  RiskLevel,
} from '@forgex/shared';
import { HARD_DENIED_PROGRAMS, programBasename } from './defaults.js';

/** 判定所需的客观事实（由 CommandGuard / WorkspaceGuard 提供） */
export interface PolicyFacts {
  /** 本次操作涉及的路径（原始值即可，内部做归一化） */
  paths?: string[];
  /** 可执行程序（仅 execute 级） */
  program?: string;
  /** 参数数组（仅 execute 级） */
  args?: string[];
}

export interface PolicyEvaluationInput {
  tool: string;
  riskLevel: RiskLevel;
  facts?: PolicyFacts;
  settings: PolicySettings;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  /** 给人看的原因（会进入审批提示与审计日志） */
  reason: string;
  /** 命中的规则名，便于审计检索与测试断言 */
  rule: string;
}

const RISK_LABEL: Record<RiskLevel, string> = {
  read: '只读',
  write: '写文件',
  execute: '执行命令',
  privileged: '高权限系统操作',
};

export class PolicyEngine {
  /**
   * 评估一次工具调用。
   * 返回 deny 时调用方必须直接拒绝，不得执行工具。
   */
  evaluate(input: PolicyEvaluationInput): PolicyEvaluation {
    const { settings, riskLevel, facts } = input;

    const protectedHit = this.checkProtectedPaths(riskLevel, facts, settings);
    if (protectedHit) return protectedHit;

    const programHit = this.checkProgram(riskLevel, facts, settings);
    if (programHit) return programHit;

    const modeDecision = this.evaluateMode(riskLevel, settings);
    if (modeDecision.decision !== 'allow') return modeDecision;

    // 允许之后再看白名单：未命中白名单只是需要审批，不是拒绝
    if (riskLevel === 'execute' && facts?.program && settings.allowedPrograms.length > 0) {
      const base = programBasename(facts.program);
      const allowed = settings.allowedPrograms.some((item) => programBasename(item) === base);
      if (!allowed) {
        return {
          decision: 'ask',
          reason: `程序 ${base} 不在白名单内，需要人工审批`,
          rule: 'program_not_allowlisted',
        };
      }
    }

    return modeDecision;
  }

  /** 受保护路径：写入/执行类只要碰到就拒绝 */
  private checkProtectedPaths(
    riskLevel: RiskLevel,
    facts: PolicyFacts | undefined,
    settings: PolicySettings,
  ): PolicyEvaluation | null {
    if (riskLevel === 'read') return null;
    const paths = facts?.paths ?? [];
    for (const target of paths) {
      for (const protectedPath of settings.protectedPaths) {
        if (pathContains(target, protectedPath)) {
          return {
            decision: 'deny',
            reason: `路径 ${target} 命中受保护规则 ${protectedPath}，禁止修改`,
            rule: 'protected_path',
          };
        }
      }
    }
    return null;
  }

  /** 程序与参数黑名单 */
  private checkProgram(
    riskLevel: RiskLevel,
    facts: PolicyFacts | undefined,
    settings: PolicySettings,
  ): PolicyEvaluation | null {
    if (riskLevel !== 'execute' && riskLevel !== 'privileged') return null;
    if (!facts?.program) return null;

    const base = programBasename(facts.program);
    if (!base) {
      return { decision: 'deny', reason: '程序名为空，拒绝执行', rule: 'empty_program' };
    }

    if (HARD_DENIED_PROGRAMS.includes(base)) {
      return {
        decision: 'deny',
        reason: `程序 ${base} 属于高危操作（删除/分区/重启/网络或服务配置），第一版禁止执行`,
        rule: 'hard_denied_program',
      };
    }

    if (settings.deniedPrograms.some((item) => programBasename(item) === base)) {
      return {
        decision: 'deny',
        reason: `程序 ${base} 在拒绝列表中`,
        rule: 'denied_program',
      };
    }

    const joinedArgs = (facts.args ?? []).join(' ');
    for (const pattern of settings.deniedArgPatterns) {
      if (!pattern) continue;
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        // 配置中的非法正则不应导致 Agent 崩溃；忽略该条规则
        continue;
      }
      if (regex.test(joinedArgs)) {
        return {
          decision: 'deny',
          reason: `参数命中高危模式 ${pattern}`,
          rule: 'denied_arg_pattern',
        };
      }
    }

    return null;
  }

  /** 权限模式矩阵 */
  private evaluateMode(riskLevel: RiskLevel, settings: PolicySettings): PolicyEvaluation {
    const mode: PermissionMode = settings.mode;
    const label = RISK_LABEL[riskLevel];

    switch (mode) {
      case 'readonly':
        if (riskLevel === 'read') {
          return { decision: 'allow', reason: '只读模式允许只读操作', rule: 'mode_readonly' };
        }
        return {
          decision: 'deny',
          reason: `只读模式禁止${label}；如需修改请切换权限模式`,
          rule: 'mode_readonly',
        };

      case 'standard':
        if (riskLevel === 'read') {
          return { decision: 'allow', reason: '普通模式允许只读操作', rule: 'mode_standard' };
        }
        if (riskLevel === 'write') {
          return settings.requireApprovalForWrite
            ? { decision: 'ask', reason: '修改文件需要人工审批', rule: 'mode_standard' }
            : { decision: 'allow', reason: '普通模式允许修改工作区文件', rule: 'mode_standard' };
        }
        if (riskLevel === 'execute') {
          return settings.requireApprovalForExecute
            ? { decision: 'ask', reason: '执行命令需要人工审批', rule: 'mode_standard' }
            : { decision: 'allow', reason: '普通模式允许执行命令', rule: 'mode_standard' };
        }
        return {
          decision: 'deny',
          reason: `普通模式禁止${label}，请使用可信模式并逐次审批`,
          rule: 'mode_standard',
        };

      case 'trusted':
        if (riskLevel === 'privileged') {
          return {
            decision: 'ask',
            reason: `${label}必须由人工明确批准`,
            rule: 'mode_trusted',
          };
        }
        if (riskLevel === 'execute' && settings.requireApprovalForExecute) {
          return { decision: 'ask', reason: '执行命令需要人工审批', rule: 'mode_trusted' };
        }
        return {
          decision: 'allow',
          reason: `可信模式允许${label}`,
          rule: 'mode_trusted',
        };

      case 'yolo':
        return {
          decision: 'allow',
          reason: `yolo 模式已关闭审批，${label}将直接执行（由用户承担风险）`,
          rule: 'mode_yolo',
        };

      default: {
        // 防御未知模式：宁可拒绝
        return {
          decision: 'deny',
          reason: `未知权限模式 ${String(mode)}`,
          rule: 'mode_unknown',
        };
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 统一分隔符并去掉首尾的 ./ 与多余斜杠 */
function normalizePathForMatch(p: string): string[] {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
}

/**
 * 判断 target 路径中是否包含 protectedPath 片段。
 * 采用片段级匹配，避免 `.gitignore` 误命中 `.git` 或 `src/git` 误命中 `git`。
 * Windows 下大小写不敏感。
 */
export function pathContains(target: string, protectedPath: string): boolean {
  const t = normalizePathForMatch(target).map(lower);
  const p = normalizePathForMatch(protectedPath).map(lower);
  if (p.length === 0 || p.length > t.length) return false;
  outer: for (let i = 0; i + p.length <= t.length; i += 1) {
    for (let j = 0; j < p.length; j += 1) {
      if (t[i + j] !== p[j]) continue outer;
    }
    return true;
  }
  return false;
}

function lower(segment: string): string {
  return process.platform === 'win32' ? segment.toLowerCase() : segment;
}

/** 把策略判定结果转成可审计的 JSON 值 */
export function evaluationToJson(evaluation: PolicyEvaluation): JsonValue {
  return { decision: evaluation.decision, reason: evaluation.reason, rule: evaluation.rule };
}
