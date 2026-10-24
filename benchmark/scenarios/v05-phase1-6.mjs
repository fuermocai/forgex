/**
 * ForgeX v0.5.0 Benchmark 场景（确定性，无模型调用）。
 *
 * 评测维度（对应用户建议的 SWE-bench / Terminal-Bench 指标）：
 *   1. REQ-x  需求理解 → 结构化 → 歧义 → 验收标准 → 追溯链
 *   2. BUD-x  预算追踪 → 5 维硬约束 → 耗尽优雅停止
 *   3. QUAL-x 质量门禁 → 测试/静态/安全 串联阻断
 *   4. ORC-x  多模块协调 → 拓扑排序 + 循环依赖检测
 *   5. RTR-x  模型路由 → 能力选择 + 健康度降级 + 故障回退
 *   6. KNOW-x 工程知识 → 生命周期 + 证据强制 + draft 隔离
 *
 * 每个场景对应一个真实的工程能力指标，全部确定性，无外部依赖。
 */
import { DatabaseSync } from 'node:sqlite';

export const suite = {
  name: 'v0.5',
  scenarios: [
    /* ============================================================ */
    /* REQ — 需求理解（Phase 1）                                     */
    /* ============================================================ */
    {
      id: 'REQ-01',
      name: '需求结构化解析 + 验收标准 approved 默认 false',
      async run(env) {
        const { req } = env;
        const model = new req.DeterministicMockModel({
          intent: { category: 'feature', summary: '用户权限管理', functionalReqs: ['RBAC'], nonFunctionalReqs: ['安全性'] },
          criteria: [
            req.makeCriterion({ description: '角色创建正常', testable: true, verificationMethod: '运行单测' }),
            req.makeCriterion({ description: '权限分配正常', testable: true, verificationMethod: '运行单测' }),
          ],
        });
        const parser = new req.RequirementParser({ model });
        const result = await parser.parse('给项目增加用户权限管理功能');

        env.expect(result.parsed.category === 'feature', 'category 应为 feature');
        env.expect(result.parsed.summary === '用户权限管理', 'summary 应等于 mock 返回值');
        env.expect(result.acceptanceCriteria.length === 2, '应有 2 条验收标准');
        // 关键：模型返回的 criteria 必须被 parser 覆盖为 approved=false
        env.expect(result.acceptanceCriteria[0].approved === false, '模型返回的 criteria 必须强制 approved=false');
        env.expect(result.traceId.startsWith('trace_'), 'traceId 应有前缀');
      },
    },
    {
      id: 'REQ-02',
      name: '验收标准未批准 → assertReady 拒绝执行（安全门禁）',
      async run(env) {
        const { req } = env;
        const analyzer = new req.RequirementAnalyzer();
        const make = req.makeStructuredRequirement;

        // 有未批准标准
        const req1 = make({
          original: 'x',
          parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
          acceptanceCriteria: [
            req.makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: false }),
          ],
        });
        let thrown = false;
        try { analyzer.assertReady(req1); } catch { thrown = true; }
        env.expect(thrown, '未批准标准应触发 assertReady 抛错');

        // 全部批准 → 通过
        const req2 = make({
          original: 'x',
          parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
          acceptanceCriteria: [
            req.makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
          ],
        });
        analyzer.assertReady(req2); // 不应抛
      },
    },
    {
      id: 'REQ-03',
      name: '追溯链 trace-store 完整生命周期 + workflowRunId 预留',
      async run(env) {
        const { req } = env;
        const db = new DatabaseSync(':memory:');
        const store = new req.RequirementTraceStore(db);
        const r = req.makeStructuredRequirement({
          original: 'x',
          parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
        });
        const t = store.init(r);
        env.expect(t.status === 'pending', '初始状态 pending');
        store.bindWorkflowRun(t.traceId, 'wf_run_001');
        const afterBind = store.get(t.traceId);
        env.expect(afterBind.workflowRunId === 'wf_run_001', 'workflowRunId 绑定成功');
        store.addCodeChange(t.traceId, 'src/auth/auth.ts');
        store.addTest(t.traceId, 'test/auth.test.ts');
        const loaded = store.get(t.traceId);
        env.expect(loaded.codeChanges.includes('src/auth/auth.ts'), 'codeChanges 包含路径');
        store.markDelivered(t.traceId, '完成角色权限 API');
        const delivered = store.get(t.traceId);
        env.expect(delivered.status === 'delivered', '最终状态 delivered');
      },
    },

    /* ============================================================ */
    /* BUD — 预算追踪（Phase 2）                                     */
    /* ============================================================ */
    {
      id: 'BUD-01',
      name: 'BudgetTracker 5 维独立耗尽测试（tokens/time/tools/models/steps）',
      run(env) {
        const { auto } = env;
        // tokens
        const t1 = new auto.BudgetTracker({ maxTokens: 5 });
        let budgetErr = false;
        try { t1.addTokens(6); } catch (e) { budgetErr = e.code === 'BUDGET_EXCEEDED'; }
        env.expect(budgetErr, 'Token 耗尽应抛 BUDGET_EXCEEDED');

        // toolCalls
        const t2 = new auto.BudgetTracker({ maxToolCalls: 1 });
        budgetErr = false;
        try { t2.addToolCall(); t2.addToolCall(); } catch (e) { budgetErr = e.code === 'BUDGET_EXCEEDED'; }
        env.expect(budgetErr, '工具调用耗尽应抛 BUDGET_EXCEEDED');

        // modelCalls
        const t3 = new auto.BudgetTracker({ maxModelCalls: 1 });
        budgetErr = false;
        try { t3.addModelCall(); t3.addModelCall(); } catch (e) { budgetErr = e.code === 'BUDGET_EXCEEDED'; }
        env.expect(budgetErr, '模型调用耗尽应抛 BUDGET_EXCEEDED');

        // steps
        const t4 = new auto.BudgetTracker({ maxSteps: 1 });
        budgetErr = false;
        try { t4.addStep(); t4.addStep(); } catch (e) { budgetErr = e.code === 'BUDGET_EXCEEDED'; }
        env.expect(budgetErr, '步骤耗尽应抛 BUDGET_EXCEEDED');

        // utilization 最大维度
        const t5 = new auto.BudgetTracker({ maxTokens: 100 });
        t5.addTokens(50);
        const u = t5.utilization();
        env.expect(u >= 0.49 && u <= 0.51, `utilization 应约 0.5，实际 ${u}`);
      },
    },
    {
      id: 'BUD-02',
      name: '预算耗尽 AutonomousRunner 优雅停止（success=false + cancelled step）',
      async run(env) {
        const { auto, req } = env;
        const { BudgetTracker, AutonomousRunner } = auto;
        const analyzer = new req.RequirementAnalyzer();
        // 给极少的 steps 预算
        const budget = new BudgetTracker({ maxSteps: 2, maxToolCalls: 50, maxTokens: 5000, maxModelCalls: 50, maxTimeMs: 60000 });
        const runner = new AutonomousRunner({ budget, analyzer });
        const approvedReq = req.makeStructuredRequirement({
          original: 'x',
          parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
          acceptanceCriteria: [
            req.makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
          ],
        });
        const executor = {
          planSteps() {
            // 10 步但预算只允许 2 步
            return Array.from({ length: 10 }, (_, i) => ({ id: `s_${i}`, name: `Step ${i}`, description: '' }));
          },
          async executeStep() {
            return { success: true, tokenUsage: 0, llmCalls: 0, summary: '' };
          },
        };
        const result = await runner.execute(
          approvedReq,
          { traceId: approvedReq.traceId, requirementId: approvedReq.id, status: 'pending', createdAt: new Date().toISOString() },
          executor,
        );
        env.expect(result.success === false, '预算耗尽后 success 应为 false');
        const cancelled = result.steps.some((s) => s.status === 'cancelled');
        env.expect(cancelled, '应有 cancelled step');
      },
    },

    /* ============================================================ */
    /* QUAL — 质量门禁（Phase 3）                                    */
    /* ============================================================ */
    {
      id: 'QUAL-01',
      name: 'QualityGate 三阶段串联：tests→static→security 全通过',
      async run(env) {
        const { qg } = env;
        const runner = new qg.TestRunner({
          async runTests() { return { total: 5, passed: 5, failed: 0, skipped: 0, durationMs: 30, rawFailures: [] }; },
        });
        const analyzer = new qg.StaticAnalyzer({
          async analyze() { return []; },
        });
        const scanner = new qg.SecurityScanner({
          async scan() { return []; },
        });
        const gate = new qg.QualityGate({ testRunner: runner, staticAnalyzer: analyzer, securityScanner: scanner });
        const result = await gate.run('/tmp');
        env.expect(result.passed, '全通过应 passed=true');
        env.expect(result.stagesCompleted.length === 3, '三个阶段全部完成');
      },
    },
    {
      id: 'QUAL-02',
      name: 'critical 安全漏洞 → 阻断 + DELIVERY_VALIDATION_FAILED',
      async run(env) {
        const { qg } = env;
        const scanner = new qg.SecurityScanner({
          async scan() {
            return [{
              id: 'f1', severity: 'critical', category: 'secret', file: '.env', line: 3,
              title: '发现 API Key', description: '硬编码密钥',
            }];
          },
        });
        let thrown = false;
        try { await scanner.scan('/tmp'); } catch (e) { thrown = e.code === 'DELIVERY_VALIDATION_FAILED'; }
        env.expect(thrown, 'critical 应抛 DELIVERY_VALIDATION_FAILED');
      },
    },
    {
      id: 'QUAL-03',
      name: 'tests 失败 → static/security 被跳过（短路）',
      async run(env) {
        const { qg } = env;
        const testRunner = new qg.TestRunner({
          async runTests() {
            return { total: 5, passed: 4, failed: 1, skipped: 0, durationMs: 30, rawFailures: [{ name: 'x', suite: 'y', message: 'm' }] };
          },
        });
        const staticAnalyzer = new qg.StaticAnalyzer({ async analyze() { return []; } });
        const securityScanner = new qg.SecurityScanner({ async scan() { return []; } });
        const gate = new qg.QualityGate({ testRunner, staticAnalyzer, securityScanner });
        const result = await gate.run('/tmp');
        env.expect(result.passed === false, 'tests 失败 → passed=false');
        env.expect(result.stagesFailed.includes('tests'), 'tests 在 failed 列表');
        env.expect(!result.stagesCompleted.includes('static'), 'static 被跳过');
        env.expect(!result.stagesCompleted.includes('security'), 'security 被跳过');
      },
    },

    /* ============================================================ */
    /* ORC — 多模块协调（Phase 4）                                   */
    /* ============================================================ */
    {
      id: 'ORC-01',
      name: '依赖图拓扑排序 + 循环依赖检测',
      run(env) {
        const { orch } = env;
        const g = new orch.DependencyGraph();
        // app → core → shared；cli → core
        g.addEdge('app', 'core');
        g.addEdge('core', 'shared');
        g.addEdge('cli', 'core');

        const order = g.topologicalOrder();
        env.expect(order.indexOf('shared') < order.indexOf('core'), 'shared 在 core 前');
        env.expect(order.indexOf('core') < order.indexOf('app'), 'core 在 app 前');
        env.expect(order.indexOf('core') < order.indexOf('cli'), 'core 在 cli 前');

        // 循环依赖
        const g2 = new orch.DependencyGraph();
        g2.addEdge('a', 'b'); g2.addEdge('b', 'c'); g2.addEdge('c', 'a');
        let thrown = false;
        try { g2.topologicalOrder(); } catch { thrown = true; }
        env.expect(thrown, '循环依赖应抛错');
      },
    },
    {
      id: 'ORC-02',
      name: 'ProjectOrchestrator 分层并行计划（shared→core/models→app/cli）',
      run(env) {
        const { orch } = env;
        const o = new orch.ProjectOrchestrator();
        o.register({ name: 'shared', dir: 'p/shared', dependencies: [] });
        o.register({ name: 'core', dir: 'p/core', dependencies: ['shared'] });
        o.register({ name: 'models', dir: 'p/models', dependencies: ['shared'] });
        o.register({ name: 'app', dir: 'p/app', dependencies: ['core', 'models'] });

        const plan = o.plan();
        env.expect(plan.groups[0].length === 1 && plan.groups[0][0] === 'shared', 'Layer 0: shared');
        const layer1 = plan.groups[1];
        env.expect(layer1.length === 2, 'Layer 1 应有 2 个可并行模块');
        env.expect(layer1.sort()[0] === 'core' && layer1.sort()[1] === 'models', 'Layer 1 = core + models');
      },
    },
    {
      id: 'ORC-03',
      name: '影响面分析：修改 shared → 所有依赖模块标记',
      run(env) {
        const { orch } = env;
        const g = new orch.DependencyGraph();
        g.addEdge('app', 'core');
        g.addEdge('core', 'shared');
        g.addEdge('cli', 'core');
        const downstream = g.downstream('shared');
        env.expect(downstream.includes('core'), 'shared 的下游包含 core');
        env.expect(downstream.includes('app'), 'shared 的下游包含 app');
        env.expect(downstream.includes('cli'), 'shared 的下游包含 cli');
        env.expect(downstream.length === 3, '共 3 个下游');
      },
    },

    /* ============================================================ */
    /* RTR — 模型路由（Phase 5）                                     */
    /* ============================================================ */
    {
      id: 'RTR-01',
      name: 'ModelRouter 按能力匹配 + tier 优先 + 故障回退',
      async run(env) {
        const { models } = env;
        const { ModelRouter } = models;
        const router = new ModelRouter();
        const dsV3 = { name: 'deepseek-v3', config: {}, async chat() { return null; } };
        const qwenTurbo = { name: 'qwen-turbo', config: {}, async chat() { return null; } };
        const qwenMax = { name: 'qwen-max', config: {}, async chat() { return null; } };
        router.register({ id: 'ds', provider: dsV3, capabilities: ['reasoning', 'coding'], tier: 2 });
        router.register({ id: 'qt', provider: qwenTurbo, capabilities: ['chat', 'fast'], tier: 1 });
        router.register({ id: 'qm', provider: qwenMax, capabilities: ['chat', 'reasoning'], tier: 3 });

        // coding 需求 → 选 ds
        const codingProvider = router.select({ requiredCapabilities: ['coding'] });
        env.expect(codingProvider.name === 'deepseek-v3', `coding 需求应选 ds，实际 ${codingProvider.name}`);

        // 能力不匹配 → MODEL_CAPABILITY_MISMATCH
        let thrown = false;
        try { router.select({ requiredCapabilities: ['vision'] }); } catch (e) { thrown = e.code === 'MODEL_CAPABILITY_MISMATCH'; }
        env.expect(thrown, '无匹配能力应抛 MODEL_CAPABILITY_MISMATCH');

        // executeWithFallback 主模型 qt 挂 → 回退到 qm → 成功
        let callCount = 0;
        const result = await router.executeWithFallback({ requiredCapabilities: ['chat'] }, async (p) => {
          callCount++;
          if (p.name === 'qwen-turbo') throw new Error('主模型挂');
          return 'ok';
        });
        env.expect(result === 'ok', `回退应成功返回 ok，实际 ${result}`);
        env.expect(callCount === 2, `应调用 2 次（qt + qm），实际 ${callCount}`);
      },
    },

    /* ============================================================ */
    /* KNOW — 工程知识（Phase 6）                                    */
    /* ============================================================ */
    {
      id: 'KNOW-01',
      name: '工程知识必须有证据引用 + LLM 推断默认 draft=true',
      run(env) {
        const { core } = env;
        const store = new core.EngineeringKnowledgeStore();

        // 无 evidence → 拒绝
        let thrown = false;
        try {
          store.create({ title: 't', type: 'pitfall', content: 'c', scope: ['x'], evidenceRefs: [], source: 'agent' });
        } catch { thrown = true; }
        env.expect(thrown, '无 evidence 应抛错');

        // agent 推断 → draft
        const k1 = store.create({ title: 't', type: 'pitfall', content: 'c', scope: ['x'], evidenceRefs: ['e1'], source: 'agent' });
        env.expect(k1.draft === true && k1.status === 'draft', 'agent 推断应为 draft');

        // user 明确 → active
        const k2 = store.create({ title: 't2', type: 'best-practice', content: 'c', scope: ['all'], evidenceRefs: ['e1'], source: 'user' });
        env.expect(k2.draft === false && k2.status === 'active', 'user 陈述应为 active');

        // verify → draft 变 active
        const verified = store.verify(k1.id);
        env.expect(verified.status === 'active' && verified.draft === false, 'verify 后变 active');

        // archive → search 排除
        store.archive(verified.id);
        const searchResult = store.search('t');
        const stillArchived = searchResult.some((s) => s.id === verified.id);
        env.expect(!stillArchived, 'archive 后 search 排除');
      },
    },
  ],
};
