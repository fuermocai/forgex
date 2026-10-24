/**
 * planning/types.ts 单元测试。
 *
 * 覆盖：
 *   1. TaskStatus 状态机（合法转换通过 / 非法转换拒绝 / 幂等 / 终态判断）
 *   2. createStep 工厂函数（默认值填充）
 *   3. computePlanStatus 折叠（各种组合 → 正确的整体状态）
 *   4. 所有类型可 JSON 序列化往返
 *   5. 依赖关系数组的语义（空数组 = 无依赖）
 *
 * 零外部依赖——全部是纯函数和类型字面量。
 */
import { describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  allowedTransitions,
  canRetry,
  computePlanStatus,
  createStep,
  isTerminal,
  isValidTransition,
  nowIso,
  type EvidenceRef,
  type ExecutionResult,
  type RiskLevel,
  type StepVerification,
  type TaskPlan,
  type TaskStep,
  type TaskStatus,
  newPlanId,
  newStepId,
} from '../src/planning/types.js';

/* ------------------------------------------------------------------ */
/* 状态机                                                               */
/* ------------------------------------------------------------------ */

describe('TaskStatus 状态机', () => {
  const allStatuses: TaskStatus[] = [...TASK_STATUSES];

  it('定义了 7 种状态', () => {
    expect(allStatuses).toHaveLength(7);
    expect(allStatuses).toContain('pending', 'ready', 'running', 'completed', 'failed', 'blocked', 'cancelled');
  });

  it('幂等转换（from → from）始终合法', () => {
    for (const s of allStatuses) {
      expect(isValidTransition(s, s)).toBe(true);
    }
  });

  it('pending 的合法转出：ready / cancelled / blocked', () => {
    expect(allowedTransitions('pending').sort()).toEqual(['blocked', 'cancelled', 'ready']);
    expect(isValidTransition('pending', 'ready')).toBe(true);
    expect(isValidTransition('pending', 'cancelled')).toBe(true);
    expect(isValidTransition('pending', 'blocked')).toBe(true);
    // 非法
    expect(isValidTransition('pending', 'completed')).toBe(false);
    expect(isValidTransition('pending', 'failed')).toBe(false);
  });

  it('ready 的合法转出：running / cancelled / blocked', () => {
    expect(allowedTransitions('ready').sort()).toEqual(['blocked', 'cancelled', 'running']);
    expect(isValidTransition('ready', 'running')).toBe(true);
    expect(isValidTransition('ready', 'cancelled')).toBe(true);
    expect(isValidTransition('ready', 'blocked')).toBe(true);
    expect(isValidTransition('ready', 'pending')).toBe(false); // 不能倒退
  });

  it('running 的合法转出：completed / failed / blocked / cancelled', () => {
    expect(allowedTransitions('running').sort()).toEqual(['blocked', 'cancelled', 'completed', 'failed']);
    expect(isValidTransition('running', 'completed')).toBe(true);
    expect(isValidTransition('running', 'failed')).toBe(true);
    expect(isValidTransition('running', 'blocked')).toBe(true);
    expect(isValidTransition('running', 'cancelled')).toBe(true);
    expect(isValidTransition('running', 'ready')).toBe(false); // 不能回到 ready
  });

  it('failed 的合法转出：ready / cancelled（重试过预算内）', () => {
    expect(allowedTransitions('failed').sort()).toEqual(['cancelled', 'ready']);
    expect(isValidTransition('failed', 'ready')).toBe(true);
    expect(isValidTransition('failed', 'cancelled')).toBe(true);
    expect(isValidTransition('failed', 'pending')).toBe(false);
  });

  it('blocked 的合法转出：ready / cancelled', () => {
    expect(allowedTransitions('blocked').sort()).toEqual(['cancelled', 'ready']);
    expect(isValidTransition('blocked', 'ready')).toBe(true);
    expect(isValidTransition('blocked', 'cancelled')).toBe(true);
    expect(isValidTransition('blocked', 'running')).toBe(false); // 必须先经 ready
  });

  it('completed 是终态：不允许转出（幂等除外）', () => {
    expect(allowedTransitions('completed')).toEqual([]);
    expect(isValidTransition('completed', 'ready')).toBe(false);
    expect(isValidTransition('completed', 'pending')).toBe(false);
    expect(isValidTransition('completed', 'cancelled')).toBe(false);
  });

  it('cancelled 是终态：不允许转出', () => {
    expect(allowedTransitions('cancelled')).toEqual([]);
    expect(isValidTransition('cancelled', 'running')).toBe(false);
    expect(isValidTransition('cancelled', 'ready')).toBe(false);
  });

  it('isTerminal 只对 completed / cancelled 返回 true', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('ready')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('failed')).toBe(false);
    expect(isTerminal('blocked')).toBe(false);
  });

  it('canRetry 只对 failed 返回 true', () => {
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('completed')).toBe(false);
    expect(canRetry('running')).toBe(false);
    expect(canRetry('pending')).toBe(false);
    expect(canRetry('cancelled')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 工厂函数                                                             */
/* ------------------------------------------------------------------ */

describe('工厂函数', () => {
  it('newPlanId / newStepId 产生唯一值且前缀正确', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(newPlanId());
    expect(ids.size).toBe(50);
    expect([...ids][0]).toMatch(/^plan_/);

    const stepIds = new Set<string>();
    for (let i = 0; i < 50; i++) stepIds.add(newStepId());
    expect(stepIds.size).toBe(50);
    expect([...stepIds][0]).toMatch(/^step_/);
  });

  it('nowIso 返回合法 ISO 8601 UTC', () => {
    const s = nowIso();
    // 大致形如 2026-10-23T09:14:05.123Z
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const parsed = new Date(s);
    expect(parsed.getTime()).toBeGreaterThan(0);
  });

  it('createStep 默认值正确填充', () => {
    const step = createStep({
      task_id: 'task_abc',
      description: '读取 server.js',
    });
    expect(step.step_id).toMatch(/^step_/);
    expect(step.task_id).toBe('task_abc');
    expect(step.status).toBe('pending');
    expect(step.dependencies).toEqual([]);
    expect(step.required_tools).toEqual([]);
    expect(step.risk_level).toBe('read');
    expect(step.verification).toEqual({ type: 'auto' });
    expect(step.evidence_refs).toEqual([]);
    expect(step.attempts).toBe(0);
    expect(step.max_attempts).toBe(2);
    expect(step.parallelizable).toBe(false);
    expect(step.created_at).toBeTruthy();
    expect(step.updated_at).toBeTruthy();
    expect(step.block_reason).toBeUndefined();
    expect(step.result).toBeUndefined();
  });

  it('createStep 传入参数覆盖默认值', () => {
    const step = createStep({
      task_id: 'task_xyz',
      description: '部署服务',
      dependencies: ['step_a', 'step_b'],
      required_tools: ['run_command'],
      risk_level: 'deploy',
      parallelizable: false,
      max_attempts: 1,
      verification: { type: 'tool_return_ok', hintOnFail: '检查 run_command 输出' },
    });
    expect(step.dependencies).toEqual(['step_a', 'step_b']);
    expect(step.required_tools).toEqual(['run_command']);
    expect(step.risk_level).toBe('deploy');
    expect(step.max_attempts).toBe(1);
    expect(step.verification).toEqual({ type: 'tool_return_ok', hintOnFail: '检查 run_command 输出' });
  });

  it('createStep 不同调用产生不同 step_id', () => {
    const a = createStep({ task_id: 't1', description: 'A' });
    const b = createStep({ task_id: 't1', description: 'B' });
    expect(a.step_id).not.toBe(b.step_id);
  });
});

/* ------------------------------------------------------------------ */
/* computePlanStatus 折叠                                               */
/* ------------------------------------------------------------------ */

describe('computePlanStatus', () => {
  const mk = (status: TaskStatus): TaskStep => {
    const s = createStep({ task_id: 't', description: 'd' });
    s.status = status;
    return s;
  };

  it('空步骤 → completed（边界情况：空计划算完成）', () => {
    expect(computePlanStatus([])).toBe('completed');
  });

  it('全部 pending → pending', () => {
    expect(computePlanStatus([mk('pending'), mk('pending')])).toBe('pending');
  });

  it('全部 ready → pending（整体还没开始执行）', () => {
    expect(computePlanStatus([mk('ready'), mk('ready')])).toBe('pending');
  });

  it('有 running → running（无论其他状态）', () => {
    expect(computePlanStatus([mk('running'), mk('pending'), mk('completed')])).toBe('running');
    expect(computePlanStatus([mk('running'), mk('failed'), mk('blocked')])).toBe('running');
  });

  it('全部 completed → completed', () => {
    expect(computePlanStatus([mk('completed'), mk('completed')])).toBe('completed');
  });

  it('有 pending/ready 且有 completed → pending（进行中）', () => {
    expect(computePlanStatus([mk('completed'), mk('pending')])).toBe('pending');
    expect(computePlanStatus([mk('completed'), mk('ready'), mk('pending')])).toBe('pending');
  });

  it('有 blocked → blocked（阻塞优先）', () => {
    expect(computePlanStatus([mk('completed'), mk('blocked')])).toBe('blocked');
    expect(computePlanStatus([mk('blocked'), mk('ready')])).toBe('blocked');
  });

  it('有 failed 且其他都终态 → failed', () => {
    expect(computePlanStatus([mk('completed'), mk('failed')])).toBe('failed');
    expect(computePlanStatus([mk('failed'), mk('cancelled')])).toBe('failed');
  });

  it('全部 cancelled → cancelled', () => {
    expect(computePlanStatus([mk('cancelled'), mk('cancelled')])).toBe('cancelled');
  });

  it('混合 failed + running → running（running 优先）', () => {
    expect(computePlanStatus([mk('running'), mk('failed')])).toBe('running');
  });
});

/* ------------------------------------------------------------------ */
/* JSON 序列化往返（所有字段必须能 JSON.parse(JSON.stringify(x))）       */
/* ------------------------------------------------------------------ */

describe('JSON 序列化往返', () => {
  it('TaskStep 完整序列化往返', () => {
    const step = createStep({
      task_id: 't',
      description: 'D',
      dependencies: ['step_a'],
      required_tools: ['run_command', 'grep_search'],
      risk_level: 'modify',
    });

    // 填充执行结果和证据（完整的 TaskStep）
    step.status = 'completed';
    step.result = {
      success: true,
      toolCallCount: 3,
      tokenUsage: 2048,
      durationMs: 15234,
      verificationPassed: true,
      summary: '改了 server.js 第 30 行',
    } satisfies ExecutionResult;
    step.evidence_refs = [
      { kind: 'code_snippet', source: '/app/server.js', startLine: 28, endLine: 32, description: '修复后的处理逻辑' },
      { kind: 'git_commit', source: 'a1b2c3d4', description: '本次修改的 commit' },
    ] satisfies EvidenceRef[];

    const json = JSON.stringify(step);
    const restored = JSON.parse(json) as TaskStep;

    expect(restored.step_id).toBe(step.step_id);
    expect(restored.status).toBe('completed');
    expect(restored.result).toEqual(step.result);
    expect(restored.evidence_refs).toEqual(step.evidence_refs);
    expect(restored.evidence_refs[0].source).toBe('/app/server.js');
  });

  it('TaskPlan 完整序列化往返', () => {
    const plan: TaskPlan = {
      plan_id: newPlanId(),
      user_request: '修复 HTTP 500',
      created_at: nowIso(),
      updated_at: nowIso(),
      status: 'pending',
      steps: [
        createStep({ task_id: 't', description: '读日志', risk_level: 'read' }),
        createStep({ task_id: 't', description: '改代码', risk_level: 'modify', dependencies: ['step_1'] }),
      ],
      metadata: { model: 'qwen-max', max_attempts_default: 2 },
    };

    const restored = JSON.parse(JSON.stringify(plan)) as TaskPlan;
    expect(restored.plan_id).toBe(plan.plan_id);
    expect(restored.steps).toHaveLength(2);
    expect(restored.metadata).toEqual({ model: 'qwen-max', max_attempts_default: 2 });
    // metadata 里的 [key: string]: unknown 也能 round-trip
  });

  it('RiskLevel 的 5 种值都能序列化', () => {
    const levels: RiskLevel[] = ['read', 'modify', 'run', 'deploy', 'critical'];
    for (const l of levels) {
      const json = JSON.stringify(l);
      expect(JSON.parse(json)).toBe(l);
    }
  });

  it('StepVerification 各种 type 都能序列化', () => {
    const types: StepVerification['type'][] = ['tool_return_ok', 'file_exists', 'command_exit_zero', 'git_no_conflict', 'custom', 'auto'];
    for (const t of types) {
      const v: StepVerification = { type: t };
      const restored = JSON.parse(JSON.stringify(v)) as StepVerification;
      expect(restored.type).toBe(t);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 依赖关系                                                             */
/* ------------------------------------------------------------------ */

describe('依赖关系语义', () => {
  it('空 dependencies = 无依赖（就绪即可执行）', () => {
    const step = createStep({ task_id: 't', description: '独立步骤' });
    expect(step.dependencies).toEqual([]);
  });

  it('dependencies 是 step_id 字符串数组', () => {
    const stepA = createStep({ task_id: 't', description: 'A' });
    const stepB = createStep({ task_id: 't', description: 'B', dependencies: [stepA.step_id] });
    expect(stepB.dependencies).toEqual([stepA.step_id]);
    expect(typeof stepB.dependencies[0]).toBe('string');
  });

  it('允许并行的步骤需要显式 parallelizable=true', () => {
    const step = createStep({ task_id: 't', description: '探索代码', parallelizable: true });
    expect(step.parallelizable).toBe(true);
    const step2 = createStep({ task_id: 't', description: '串行写文件' });
    expect(step2.parallelizable).toBe(false); // 默认 false
  });

  it('依赖数组里的 step_id 可以不存在（PlanManager 运行时校验）', () => {
    // types.ts 只定义结构，不校验依赖有效性——这是 PlanManager 的职责
    const step = createStep({ task_id: 't', description: 'D', dependencies: ['nonexistent_step'] });
    expect(step.dependencies).toEqual(['nonexistent_step']);
  });
});
