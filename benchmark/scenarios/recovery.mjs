/**
 * Recovery 套件：10 个故障恢复场景。
 *
 * 验证系统在失败、中断、超限后的确定性行为：
 *  - Planning：重试预算、检查点恢复、取消传播；
 *  - Sub-Agent：资源预算超限熔断；
 *  - Context：证据外置与协议完整性；
 *  - Memory：冲突保护；Session/Evidence：持久化恢复与清理。
 */

import { DatabaseSync } from 'node:sqlite';

/** 构造一个最小合法的 LoopResult（agent 假实现用） */
function okLoopResult(text) {
  return {
    sessionId: 'bench-session',
    reason: 'completed',
    text,
    toolCalls: 1,
    toolResults: [{ toolName: 'run_command', result: { ok: true, summary: 'ok', truncated: false, durationMs: 1, bytes: 10, auditId: 'audit_bench' } }],
    iterations: 1,
    metrics: {
      totalTokens: 0, promptTokens: 0, completionTokens: 0,
      toolCalls: 1, toolMs: 0, modelMs: 0, durationMs: 0, iterations: 1,
    },
  };
}

/** 可重试的瞬态失败（模型超时 / 瞬态不可用）：有 error.retryable=true，且无工具调用 */
function retryableLoopResult(message) {
  return {
    sessionId: 'bench-session',
    reason: 'error',
    text: '',
    toolCalls: 0,
    toolResults: [],
    iterations: 1,
    error: { code: 'PROVIDER_TIMEOUT', message, retryable: true },
    metrics: {
      totalTokens: 0, promptTokens: 0, completionTokens: 0,
      toolCalls: 0, toolMs: 0, modelMs: 0, durationMs: 0, iterations: 1,
    },
  };
}

/** 构造一个带 2 个独立步骤的计划 */
function makePlan(env, mgr, descs) {
  const steps = descs.map((description) => env.core.createStep({ task_id: 'bench', description }));
  return mgr.createPlan({ user_request: '恢复能力基准场景', steps });
}

/** 状态机要求 pending → ready → running：先把目标步骤推进到 ready */
function markReady(env, mgr, plan, stepIndex = 0) {
  mgr.updateStepStatus(plan.plan_id, plan.steps[stepIndex].step_id, 'ready');
}

export const suite = {
  name: 'recovery',
  scenarios: [
    {
      id: 'REC-01',
      name: 'Planning 重试预算耗尽后标记 failed',
      async run(env) {
        const mgr = new env.core.PlanManager();
        const plan = makePlan(env, mgr, ['永远失败的步骤']);
        markReady(env, mgr, plan);
        let calls = 0;
        const executor = new env.core.StepExecutor({
          planManager: mgr,
          agent: {
            run: async () => {
              calls += 1;
              return retryableLoopResult('模拟模型持续失败');
            },
          },
        });
        const result = await executor.executeStep(plan.plan_id, plan.steps[0].step_id);
        env.expectEq(result.final_status, 'failed', '最终状态');
        env.expectEq(result.attemptsUsed, plan.steps[0].max_attempts, '应耗尽重试预算');
        env.expectEq(calls, plan.steps[0].max_attempts, 'agent 调用次数应等于重试预算');
      },
    },
    {
      id: 'REC-02',
      name: 'Planning 首次失败第二次成功（重试恢复）',
      async run(env) {
        const mgr = new env.core.PlanManager();
        const plan = makePlan(env, mgr, ['先失败后成功的步骤']);
        markReady(env, mgr, plan);
        let calls = 0;
        const executor = new env.core.StepExecutor({
          planManager: mgr,
          agent: {
            run: async () => {
              calls += 1;
              if (calls === 1) return retryableLoopResult('首次失败');
              return okLoopResult('完成');
            },
          },
        });
        const result = await executor.executeStep(plan.plan_id, plan.steps[0].step_id);
        env.expectEq(result.final_status, 'completed', '最终状态');
        env.expectEq(result.attemptsUsed, 2, '应重试一次后成功');
      },
    },
    {
      id: 'REC-03',
      name: 'Planning checkpoint 保存后可完整恢复',
      async run(env) {
        const db = new DatabaseSync(':memory:');
        try {
          const checkpoint = new env.core.CheckpointManager(db);
          const mgr = new env.core.PlanManager({ checkpoint });
          const plan = makePlan(env, mgr, ['步骤A', '步骤B']);
          // 推一个步骤到 completed：pending → ready → running → completed
          mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
          mgr.markStepRunning(plan.plan_id, plan.steps[0].step_id);
          mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'completed');
          checkpoint.snapshotPlan(mgr.getPlan(plan.plan_id));

          const loaded = checkpoint.load(plan.plan_id);
          env.expect(loaded !== null, 'checkpoint 应存在');
          env.expect(loaded.completed_step_ids.includes(plan.steps[0].step_id), '已完成步骤应被记录');
          env.expectEq(loaded.plan.steps.length, 2, '完整计划应可恢复');
        } finally {
          db.close();
        }
      },
    },
    {
      id: 'REC-04',
      name: 'Planning 取消信号传播到步骤执行',
      async run(env) {
        const mgr = new env.core.PlanManager();
        const plan = makePlan(env, mgr, ['将被取消的步骤']);
        markReady(env, mgr, plan);
        const controller = new AbortController();
        controller.abort(); // 执行前已取消
        let calls = 0;
        const executor = new env.core.StepExecutor({
          planManager: mgr,
          signal: controller.signal,
          agent: {
            run: async () => {
              calls += 1;
              return okLoopResult('不应到达');
            },
          },
        });
        const result = await executor.executeStep(plan.plan_id, plan.steps[0].step_id);
        env.expectEq(result.final_status, 'cancelled', '最终状态应为 cancelled');
        env.expectEq(calls, 0, '取消后 agent 不应被调用');
      },
    },
    {
      id: 'REC-05',
      name: 'Sub-Agent 工具调用预算超限立即熔断',
      async run(env) {
        const budget = env.core.resolveBudget({ maxToolCalls: 2 });
        const limiter = new env.core.ResourceLimiter(budget);
        limiter.recordToolCall();
        limiter.recordToolCall();
        limiter.recordToolCall(); // 第 3 次超过预算 2
        env.expect(limiter.isExceeded(), '应已超预算');
        let code = null;
        try {
          limiter.assertWithinBudget();
        } catch (err) {
          code = err?.code ?? null;
        }
        env.expectEq(code, 'SUBAGENT_BUDGET_EXCEEDED', '超预算必须抛 SUBAGENT_BUDGET_EXCEEDED');
      },
    },
    {
      id: 'REC-06',
      name: 'Context 超长工具输出外置为证据且可取回原文',
      async run(env) {
        const store = new env.core.EvidenceStore(':memory:');
        try {
          const cm = new env.core.ContextManager({
            systemPrompt: '你是恢复场景基准代理',
            contextWindow: 2048,
            maxOutputTokens: 256,
            safetyMarginTokens: 0,
            evidenceStore: store,
            evidenceSessionId: 'bench-session',
          });
          const bigLog = '错误日志行 '.repeat(800); // 远超 600 token 外置阈值
          cm.append({ role: 'user', content: '分析这段日志' });
          cm.append({
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_logs', arguments: '{}' } }],
          });
          cm.append({ role: 'tool', tool_call_id: 'c1', name: 'read_logs', content: bigLog });
          cm.append({ role: 'assistant', content: '初步结论：日志中有大量错误' });
          // 关键：再补一轮小的工具调用——ContextManager 不会外置"最近一条"工具输出，
          // 保证 c1 的大日志是外置候选
          cm.append({ role: 'user', content: '再看一下端口' });
          cm.append({
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c2', type: 'function', function: { name: 'inspect_port', arguments: '{"port":80}' } }],
          });
          cm.append({ role: 'tool', tool_call_id: 'c2', name: 'inspect_port', content: '{"found":false}' });
          cm.append({ role: 'assistant', content: '端口未监听，继续分析' });

          const built = cm.build();
          env.expect(built.externalized >= 1, '应至少外置一条证据');
          const toolMsg = built.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
          env.expect(toolMsg.content.startsWith('[内容已外置为证据'), '消息应替换为证据占位符');
          // 从占位符提取 evidence_id 并取回原文
          const match = /ev_[a-zA-Z0-9_-]+/.exec(toolMsg.content);
          env.expect(match !== null, '占位符应含 evidence_id');
          const record = store.get(match[0]);
          env.expectEq(record.content, bigLog, '证据库应保留完整原文');
        } finally {
          store.close();
        }
      },
    },
    {
      id: 'REC-07',
      name: 'Context 压缩后消息协议保持合法',
      async run(env) {
        const cm = new env.core.ContextManager({
          systemPrompt: '你是恢复场景基准代理',
          contextWindow: 2048,
          maxOutputTokens: 256,
          safetyMarginTokens: 0,
        });
        for (let i = 0; i < 20; i += 1) {
          cm.append({ role: 'user', content: `问题 ${i}` });
          cm.append({
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `c_${i}`, type: 'function', function: { name: 'read_logs', arguments: '{}' } }],
          });
          cm.append({ role: 'tool', tool_call_id: `c_${i}`, name: 'read_logs', content: '日志 '.repeat(150) });
          cm.append({ role: 'assistant', content: `结论 ${i}` });
        }
        cm.append({ role: 'user', content: '最后的问题' });
        const built = cm.build();
        env.expect(built.compressed, '应发生压缩');
        env.expectEq(built.externalized, 0, '未配置证据库时不应外置');
        const violations = env.shared.validateMessageProtocol(built.messages);
        env.expectEq(violations.length, 0, `协议应合法: ${violations.join('; ')}`);
        env.expect(built.estimatedTokens <= cm.budgetTokens(), '压缩后不应超预算');
      },
    },
    {
      id: 'REC-08',
      name: 'Memory user 高置信事实不被 agent 覆盖（冲突保护）',
      async run(env) {
        const memory = env.core.createMemoryManager(':memory:');
        try {
          memory.rememberUserFact({ scope: 'project', key: 'deploy.region', content: 'cn-hangzhou', workspace: env.ws });
          const conflict = memory.remember({
            kind: 'fact',
            source: 'agent',
            scope: 'project',
            key: 'deploy.region',
            content: 'cn-shanghai',
            workspace: env.ws,
          });
          env.expect(conflict.conflict === true, '应报告冲突且未覆盖');
          const hits = memory.recall({ workspace: env.ws, text: 'deploy.region' });
          env.expectEq(hits.length, 1, '应只有一条有效记忆');
          env.expectEq(hits[0].entry.content, 'cn-hangzhou', 'user 事实应保持不变');
        } finally {
          memory.close();
        }
      },
    },
    {
      id: 'REC-09',
      name: 'SessionStore 消息持久化后可完整恢复',
      async run(env) {
        const store = new env.core.SessionStore(':memory:');
        try {
          const session = store.createSession({ workspace: env.ws, model: 'bench-model' });
          store.appendMessage(session.id, { role: 'user', content: '读取文件' });
          store.appendMessage(session.id, {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
          });
          store.appendMessage(session.id, { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'file content' });
          const messages = store.getMessages(session.id);
          env.expectEq(messages.length, 3, '应恢复 3 条消息');
          env.expectEq(messages[1].tool_calls[0].function.name, 'read_file', 'tool_calls 应完整');
          const violations = env.shared.validateMessageProtocol(messages);
          env.expectEq(violations.length, 0, '恢复的协议应合法');
        } finally {
          store.close();
        }
      },
    },
    {
      id: 'REC-10',
      name: 'EvidenceStore 按会话清理且不影响其他会话',
      async run(env) {
        const store = new env.core.EvidenceStore(':memory:');
        try {
          store.put({ kind: 'tool_output', content: '会话1证据A', sessionId: 's1' });
          store.put({ kind: 'tool_output', content: '会话1证据B', sessionId: 's1' });
          store.put({ kind: 'tool_output', content: '会话2证据', sessionId: 's2' });
          env.expectEq(store.listBySession('s1').length, 2, 's1 应有 2 条');
          const purged = store.purgeSession('s1');
          env.expectEq(purged, 2, '应清理 2 条');
          env.expectEq(store.listBySession('s1').length, 0, 's1 应被清空');
          env.expectEq(store.listBySession('s2').length, 1, 's2 不应受影响');
        } finally {
          store.close();
        }
      },
    },
  ],
};
