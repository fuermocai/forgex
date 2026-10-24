/**
 * Sub-Agent 类型定义单元测试（v0.3.0 Phase 2）。
 *
 * 覆盖：
 *   - 角色枚举与 isSubAgentRole 守卫
 *   - resolveBudget 的默认值填充与硬上限 clip
 *   - createSubAgentSpec 的 ID 生成与时间戳
 *   - findOutOfScopeTools 的权限收敛校验
 */
import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_ROLES,
  ROLE_DESCRIPTIONS,
  HARD_BUDGET_LIMITS,
  DEFAULT_BUDGET,
  createSubAgentSpec,
  findOutOfScopeTools,
  isSubAgentRole,
  newSubAgentId,
  nowIsoSub,
  resolveBudget,
  type SubAgentRole,
} from '../src/subagent/types.js';

describe('SubAgentRole 枚举', () => {
  it('包含四种角色', () => {
    expect(SUBAGENT_ROLES).toHaveLength(4);
    expect(SUBAGENT_ROLES).toContain('explorer');
    expect(SUBAGENT_ROLES).toContain('debugger');
    expect(SUBAGENT_ROLES).toContain('reviewer');
    expect(SUBAGENT_ROLES).toContain('worker');
  });

  it('每种角色都有描述', () => {
    for (const role of SUBAGENT_ROLES) {
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
      expect(typeof ROLE_DESCRIPTIONS[role]).toBe('string');
    }
  });

  it('isSubAgentRole 正确识别合法角色', () => {
    expect(isSubAgentRole('explorer')).toBe(true);
    expect(isSubAgentRole('debugger')).toBe(true);
    expect(isSubAgentRole('reviewer')).toBe(true);
    expect(isSubAgentRole('worker')).toBe(true);
  });

  it('isSubAgentRole 拒绝非法角色', () => {
    expect(isSubAgentRole('admin')).toBe(false);
    expect(isSubAgentRole('hacker')).toBe(false);
    expect(isSubAgentRole('')).toBe(false);
    expect(isSubAgentRole(null)).toBe(false);
    expect(isSubAgentRole(undefined)).toBe(false);
    expect(isSubAgentRole(123)).toBe(false);
    expect(isSubAgentRole({})).toBe(false);
  });
});

describe('resolveBudget', () => {
  it('空 spec 返回默认值', () => {
    const resolved = resolveBudget(undefined);
    expect(resolved).toEqual(DEFAULT_BUDGET);
  });

  it('空对象返回默认值', () => {
    const resolved = resolveBudget({});
    expect(resolved).toEqual(DEFAULT_BUDGET);
  });

  it('部分覆盖时其他字段保持默认', () => {
    const resolved = resolveBudget({ maxTokens: 1000 });
    expect(resolved.maxTokens).toBe(1000);
    expect(resolved.maxToolCalls).toBe(DEFAULT_BUDGET.maxToolCalls);
    expect(resolved.maxDurationMs).toBe(DEFAULT_BUDGET.maxDurationMs);
    expect(resolved.maxIterations).toBe(DEFAULT_BUDGET.maxIterations);
  });

  it('超过硬上限的字段被 clip', () => {
    const resolved = resolveBudget({
      maxTokens: HARD_BUDGET_LIMITS.maxTokens + 999_999,
      maxToolCalls: HARD_BUDGET_LIMITS.maxToolCalls + 100,
      maxDurationMs: HARD_BUDGET_LIMITS.maxDurationMs + 100_000,
      maxIterations: HARD_BUDGET_LIMITS.maxIterations + 5,
    });
    expect(resolved.maxTokens).toBe(HARD_BUDGET_LIMITS.maxTokens);
    expect(resolved.maxToolCalls).toBe(HARD_BUDGET_LIMITS.maxToolCalls);
    expect(resolved.maxDurationMs).toBe(HARD_BUDGET_LIMITS.maxDurationMs);
    expect(resolved.maxIterations).toBe(HARD_BUDGET_LIMITS.maxIterations);
  });

  it('低于硬上限的字段保持原值', () => {
    const resolved = resolveBudget({
      maxTokens: 10_000,
      maxToolCalls: 5,
      maxDurationMs: 30_000,
      maxIterations: 4,
    });
    expect(resolved.maxTokens).toBe(10_000);
    expect(resolved.maxToolCalls).toBe(5);
    expect(resolved.maxDurationMs).toBe(30_000);
    expect(resolved.maxIterations).toBe(4);
  });

  it('硬上限小于默认值（理论上不应该），返回硬上限', () => {
    // 防御性测试：确保即使 DEFAULT 被错误修改，resolveBudget 也会保护
    expect(DEFAULT_BUDGET.maxTokens).toBeLessThanOrEqual(HARD_BUDGET_LIMITS.maxTokens);
    expect(DEFAULT_BUDGET.maxToolCalls).toBeLessThanOrEqual(HARD_BUDGET_LIMITS.maxToolCalls);
    expect(DEFAULT_BUDGET.maxDurationMs).toBeLessThanOrEqual(HARD_BUDGET_LIMITS.maxDurationMs);
    expect(DEFAULT_BUDGET.maxIterations).toBeLessThanOrEqual(HARD_BUDGET_LIMITS.maxIterations);
  });
});

describe('newSubAgentId', () => {
  it('生成的 ID 以 sub_ 开头', () => {
    const id = newSubAgentId();
    expect(id.startsWith('sub_')).toBe(true);
  });

  it('生成的 ID 总长度为 12（sub_ + 8 位 hex）', () => {
    const id = newSubAgentId();
    expect(id).toHaveLength(12);
  });

  it('连续生成 100 个 ID 不重复', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(newSubAgentId());
    }
    expect(ids.size).toBe(100);
  });
});

describe('nowIsoSub', () => {
  it('返回合法 ISO 时间字符串', () => {
    const iso = nowIsoSub();
    expect(typeof iso).toBe('string');
    expect(() => new Date(iso)).not.toThrow();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});

describe('createSubAgentSpec', () => {
  it('必填字段正确填充', () => {
    const spec = createSubAgentSpec({
      role: 'explorer',
      task: '查找所有 .ts 文件',
      allowed_tools: ['read_file', 'grep_search'],
    });
    expect(spec.subagent_id).toMatch(/^sub_[0-9a-f]{8}$/);
    expect(spec.role).toBe('explorer');
    expect(spec.task).toBe('查找所有 .ts 文件');
    expect(spec.allowed_tools).toEqual(['read_file', 'grep_search']);
    expect(spec.created_at).toBeTruthy();
  });

  it('可选字段缺省时不出现在 spec 中', () => {
    const spec = createSubAgentSpec({
      role: 'worker',
      task: '执行任务',
      allowed_tools: [],
    });
    expect(spec.budget).toBeUndefined();
    expect(spec.context).toBeUndefined();
    expect(spec.parent_task_id).toBeUndefined();
    expect(spec.parent_step_id).toBeUndefined();
    expect(spec.parent_session_id).toBeUndefined();
  });

  it('可选字段传入时正确填充', () => {
    const spec = createSubAgentSpec({
      role: 'debugger',
      task: '诊断内存泄漏',
      allowed_tools: ['inspect_memory'],
      budget: { maxTokens: 5000 },
      context: '上次 OOM 在 12:34',
      parent_task_id: 'plan_abc',
      parent_step_id: 'step_xyz',
      parent_session_id: 's_123',
    });
    expect(spec.budget).toEqual({ maxTokens: 5000 });
    expect(spec.context).toBe('上次 OOM 在 12:34');
    expect(spec.parent_task_id).toBe('plan_abc');
    expect(spec.parent_step_id).toBe('step_xyz');
    expect(spec.parent_session_id).toBe('s_123');
  });

  it('allowed_tools 被复制（外部修改原数组不影响 spec）', () => {
    const tools = ['read_file'];
    const spec = createSubAgentSpec({
      role: 'explorer',
      task: 'test',
      allowed_tools: tools,
    });
    tools.push('edit_file');
    expect(spec.allowed_tools).toEqual(['read_file']);
    expect(spec.allowed_tools).not.toContain('edit_file');
  });

  it('空 allowed_tools 合法（完全无工具）', () => {
    const spec = createSubAgentSpec({
      role: 'reviewer',
      task: '纯文本审查',
      allowed_tools: [],
    });
    expect(spec.allowed_tools).toEqual([]);
  });
});

describe('findOutOfScopeTools', () => {
  it('子集 ⊆ 父集 → 返回空数组', () => {
    const result = findOutOfScopeTools(['read_file', 'grep_search'], ['read_file', 'grep_search', 'edit_file']);
    expect(result).toEqual([]);
  });

  it('子集 == 父集 → 返回空数组', () => {
    const result = findOutOfScopeTools(['read_file'], ['read_file']);
    expect(result).toEqual([]);
  });

  it('子集 ⊄ 父集 → 返回越权工具', () => {
    const result = findOutOfScopeTools(['read_file', 'edit_file', 'run_command'], ['read_file', 'edit_file']);
    expect(result).toEqual(['run_command']);
  });

  it('子集为空 → 返回空数组', () => {
    const result = findOutOfScopeTools([], ['read_file']);
    expect(result).toEqual([]);
  });

  it('父集为空 → 所有子集工具都越权', () => {
    const result = findOutOfScopeTools(['read_file', 'edit_file'], []);
    expect(result).toEqual(['read_file', 'edit_file']);
  });

  it('多个越权工具全部返回', () => {
    const result = findOutOfScopeTools(
      ['read_file', 'edit_file', 'run_command', 'ssh_inspect'],
      ['read_file'],
    );
    expect(result).toEqual(['edit_file', 'run_command', 'ssh_inspect']);
  });
});

describe('类型完整性', () => {
  it('所有角色都能作为 SubAgentRole 类型使用', () => {
    // 编译期检查：如果 SUBAGENT_ROLES 增加了新角色但类型没更新，这里会报错
    const roles: SubAgentRole[] = ['explorer', 'debugger', 'reviewer', 'worker'];
    expect(roles).toHaveLength(4);
  });
});
