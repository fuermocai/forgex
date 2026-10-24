# ForgeX v0.5.0 — Autonomous Software Engineer

> **发布日期**：2026-10-23
> **从**：v0.4.0（12 TS 包 + 1 Rust crate，693/693 测试全绿）
> **到**：v0.5.0（16 TS 包 + 1 Rust crate，**772/772 测试全绿**）

## 一句话定位

v0.5.0 让 ForgeX 从"会干活的 Agent"升级为**能自主执行完整需求的软件工程师**——具备需求理解、预算控制、质量门禁、多模块协调、模型路由和工程知识六大核心能力，同时保持"模型不可提权、所有操作可审计"的安全底色。

---

## 架构演进

```
v0.4.0                        v0.5.0 (新增/增强)
─────────────────────────────  ──────────────────────────────────
┌──────────┐  ┌──────────┐   ┌────────────────────────────────────┐
│ Agent    │  │ Task      │   │ ① Requirement Engine  (新包)     │
│ Runtime  │  │ Planner   │   │ ② Autonomous Task Runner (新包)  │
└──────────┘  └──────────┘   │ ③ Quality Gate          (新包)   │
                              │ ④ Project Orchestrator  (新包)   │
┌──────────┐  ┌──────────┐   │ ⑤ Model Router           (增强)   │
│ Security │  │ Tool      │   │ ⑥ Engineering Knowledge  (增强)   │
│ Gateway  │  │ Registry  │   └────────────────────────────────────┘
└──────────┘  └──────────┘
        ↑ 所有 Phase 不修改 v0.4.0 核心，零破坏性变更
```

| 指标 | v0.4.0 | v0.5.0 | 变化 |
| --- | --- | --- | --- |
| TS 包数量 | 12 | **16** | +4 新包 |
| 测试文件 | 52 | **58** | +6 |
| 测试用例 | 693 | **772** | **+79** |
| 构建 TypeScript 错误 | 0 | **0** | — |
| 共享错误码 | 基础集 | **+15 个 v0.5.0 专属** | — |

---

## Phase 1 — Requirement Engine 需求理解

**新包**：`@forgex/requirement-engine`

### 核心能力

```
自然语言输入
    │
    ▼
┌──────────────┐   ┌───────────────┐   ┌──────────────┐
│ Requirement  │──▶│ Requirement    │──▶│ 验收标准生成  │
│ Parser       │   │ Analyzer       │   │ (LLM→draft)  │
└──────────────┘   └───────┬───────┘   └──────┬───────┘
    │                      │                    │
    │                      ▼                    ▼
    │              就绪性门禁           CriteriaValidator
    │              assertReady()       (approved 强制)
    ▼                                        │
┌──────────────────┐                         │
│ RequirementTrace │◀────────────────────────┘
│ Store (SQLite)   │   追溯链：workflowRunId 预留
└──────────────────┘   关联 Phase 2 工作流
```

### 安全硬约束

| 设计 | 文件 | 说明 |
| --- | --- | --- |
| `AcceptanceCriterion.approved` 默认 `false` | `types.ts` 第 35 行 | 类型级强制——模型生成的永远是 draft |
| `makeCriterion()` 强制 `approved: params.approved ?? false` | `types.ts` | 即使调用方漏传也默认为未批准 |
| `RequirementParser` 覆盖 LLM 返回值为 `approved: false` | `requirement-parser.ts` | 不信任模型说"已批准" |
| `assertReady()` 抛 `REQUIREMENT_CRITERIA_UNAPPROVED` | `requirement-analyzer.ts` | 未批准标准阻止执行 |
| `RequirementModelInterface` 解耦 | `requirement-model-interface.ts` | 不直接 import `createProvider()` |

### 关键导出

```typescript
export interface RequirementModelInterface {
  parseIntent(input: string): Promise<ParsedIntent>;
  detectAmbiguities(intent: ParsedIntent): Promise<AmbiguityItem[]>;
  generateCriteria(intent: ParsedIntent): Promise<AcceptanceCriterion[]>;
  detectRisks(intent: ParsedIntent): Promise<RiskItem[]>;
}

export class RequirementTraceStore {
  init(req): RequirementTrace;
  get(traceId): RequirementTrace | null;
  bindWorkflowRun(traceId, wfRunId): void; // Phase 2 关联
  markDelivered(traceId, summary): void;
}
```

### 测试亮点（27 个用例）

- [x] 类型级：`makeCriterion({}).approved === false`
- [x] `isRequirementReady()`：无歧义 + 全部已批准才 ready
- [x] 双失败同时触发（歧义 + 未批准）
- [x] LLM 生成的 criteria 强制 `approved=false`
- [x] `RequirementTraceStore` CRUD + workflowRunId 绑定

---

## Phase 2 — Autonomous Task Runner 长任务自主执行

**新包**：`@forgex/autonomous`

### 核心能力

```
                   ┌───────────────────────┐
                   │   ExecutionBudget     │
                   │ 5 维硬约束：          │
                   │  ├ tokens             │
                   │  ├ time (ms)          │
                   │  ├ toolCalls          │
                   │  ├ modelCalls         │
                   │  └ steps              │
                   └───────────────────────┘
                             │
                             ▼
┌──────────────┐   ┌──────────────────────┐   ┌───────────────────────┐
│ Autonomous   │──▶│ AutonomousRunner      │──▶│ ContinuationManager    │
│ StepExecutor │   │ (每步检查预算)        │   │ 检查点 / 暂停 / 恢复   │
└──────────────┘   └──────────────────────┘   └───────────────────────┘
```

### 安全硬约束

| 设计 | 文件 | 说明 |
| --- | --- | --- |
| 每步执行前 `budget.addStep()` + `addToken()` + `addModelCall()` | `autonomous-runner.ts` | 5 维预算不可绕过 |
| 预算耗尽 → `BUDGET_EXCEEDED` 异常 | `execution-budget.ts` 第 115 行 | ForgeError 带具体使用量 |
| 耗尽时优雅停止（propagate→标记 cancelled） | `autonomous-runner.ts` 第 87-102 行 | 不崩溃，返回状态供上层恢复 |
| `maxRetryPerStep` 防止无限重试 | `autonomous-runner.ts` 第 133 行 | 默认 2 次 |
| `ApprovalManager` 注入式 | 构造函数参数 | 高风险步骤必须显式审批 |

### 关键导出

```typescript
export class BudgetTracker {
  constructor(limits?: Partial<BudgetLimits>); // 默认 50K tokens / 30min / 500 tools / 50 LLM / 100 steps
  addTokens(n): void;    // 超 → BUDGET_EXCEEDED
  addToolCall(): void;
  addModelCall(): void;
  addStep(): void;
  utilization(): number; // 0-1, 最大维度的使用率
  snapshot(): { limits, usage };
}

export class ContinuationManager {
  startRun(requirementId): string;           // 返回 runId
  saveCheckpoint({ runId, stepId, ... }): void;
  verifyRecoverable(runId): void;            // 环境/策略门禁
}
```

### 测试亮点（18 个用例）

- [x] `BudgetTracker` 5 维分别耗尽 → 都抛 `BUDGET_EXCEEDED`
- [x] `autonomous-runner` 预算耗尽 → success=false + cancelled step
- [x] 步骤暂时性失败 → 自动重试 3 次 → 成功
- [x] 未批准需求 → `assertReady()` 门禁拒绝
- [x] `ContinuationManager` 检查点写入 + 恢复验证

---

## Phase 3 — Quality Gate 质量门禁

**新包**：`@forgex/quality-gate`

### 核心能力

```
┌──────────────────────────────────────────────────────────────┐
│ QualityGate.run(cwd)                                         │
│                                                              │
│  Stage 1: TestRunner ──▶ Stage 2: StaticAnalyzer ──▶ Stage 3: SecurityScanner │
│           (QUALITY_GATE_FAILED)   (STATIC_ANALYSIS_FAILED)   (DELIVERY_VALIDATION_FAILED) │
│                                                              │
│  任一失败 → 立即阻断后续阶段                                   │
│  各阶段独立，可按需关闭                                       │
└──────────────────────────────────────────────────────────────┘
```

### 安全硬约束

| 设计 | 文件 | 说明 |
| --- | --- | --- |
| `criticalCount > 0 \|\| highCount > 0` → 立即阻断 | `security-scanner.ts` 第 45 行 | SECURITY CRITICAL/ HIGH 不可跳过 |
| `errorCount > 0` → 静态分析阻断 | `static-analyzer.ts` 第 42 行 | 生产级代码不能有 TS ESLint error |
| `failed > 0` → 测试阻断 | `test-runner.ts` 第 32 行 | 测试未全绿不能交付 |
| 三个阶段独立注入 | `quality-gate.ts` 第 14-17 行 | 可按需只开部分阶段 |
| 所有执行器接口化 | `TestExecutor` / `StaticAnalysisExecutor` / `SecurityScanExecutor` | 生产封装 vitest/ESLint/semgrep，测试用 mock |

### 关键导出

```typescript
export class QualityGate {
  constructor(options: {
    testRunner?: TestRunner;
    staticAnalyzer?: StaticAnalyzer;
    securityScanner?: SecurityScanner;
  });
  run(cwd, testPattern?): Promise<QualityGateResult>;
  // QualityGateResult: { passed, stagesCompleted, stagesFailed, results, finalMessage }
}
```

### 测试亮点（11 个用例）

- [x] 全通过 → 3 个阶段完成
- [x] tests 失败 → static/security 被跳过
- [x] critical 安全漏洞 → `DELIVERY_VALIDATION_FAILED`
- [x] 只有 warning → 静态分析通过
- [x] 仅开启 tests → 部分模式可用

---

## Phase 4 — Project Orchestrator 多模块协调

**新包**：`@forgex/orchestrator`

### 核心能力

```
注册所有包及依赖        拓扑排序（Kahn's algorithm）       分层并行计划
─────────────────────  ────────────────────────────────   ──────────────────────────────
shared (无依赖)      →  shared         →  Layer 0: [shared]
├── core (→ shared)  →  core, models   →  Layer 1: [core, models]  ← 可并行
├── models (→ shared)→  app, cli       →  Layer 2: [app, cli]      ← 可并行
└── app (→ core, models)

                    循环依赖检测：有环立即 ForgeError
```

### 安全硬约束

| 设计 | 说明 |
| --- | --- |
| Kahn's 拓扑排序 | 依赖边语义 `addEdge(A, B) = A 依赖 B → B 在 A 之前` |
| 循环依赖立即阻断 | 有环时所有节点无法进入 order → 抛错 |
| `downstream(x)` 影响面分析 | 修改 shared → 知道 app/cli/core/models 全受影响 |

### 关键导出

```typescript
export class DependencyGraph {
  addNode(id): void;
  addEdge(from, to, type?): void;
  topologicalOrder(): string[];    // 有环抛 ForgeError
  downstream(dependsOn): string[]; // 递归下游影响面
  directUpstream(node): string[];
}

export class ProjectOrchestrator {
  register(pkg: { name, dir, dependencies }): void;
  plan(): OrchestratorPlan; // { executionOrder, groups: string[][] }
  getGraph(): DependencyGraph;
}
```

### 测试亮点（8 个用例）

- [x] 简单链 shared→core→app：拓扑排序正确
- [x] 循环依赖 a→b→c→a：抛错
- [x] 下游影响面：修改 shared → 返回 [core, app, cli]
- [x] 分层计划：shared(0) → core/models(1) → app/cli(2)

---

## Phase 5 — Model Router 模型路由

**增强包**：`@forgex/models`（新增 `model-router.ts`）

### 核心能力

```
                    ┌─────────────────────────────┐
                    │ ModelRouter.register()       │
                    │ 注册模型 + 能力 + tier        │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │ select({                     │
                    │   requiredCapabilities,      │
                    │   preferTier,                │
                    │   maxTier                    │
                    │ })                           │
                    │                              │
                    │ 1. 按能力过滤                 │
                    │ 2. 按 tier 排序（便宜快优先）  │
                    │ 3. 跳过冷却中失败模型          │
                    │ 4. 返回 Provider             │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │ executeWithFallback()        │
                    │ 主模型失败 → 自动试下个        │
                    │ 全失败 → MODEL_FALLBACK_     │
                    │        EXHAUSTED             │
                    └─────────────────────────────┘
```

### 安全硬约束

| 设计 | 说明 |
| --- | --- |
| 能力不匹配 → `MODEL_CAPABILITY_MISMATCH` | 不会随机选一个错误模型 |
| 所有模型冷却 → `MODEL_UNAVAILABLE` | 有意义的错误而非返回 undefined |
| tier 5 最贵能力最齐全，tier 1 最便宜快 | 默认选最低可行 tier |
| 失败冷却 30s + 连续失败降级 | 不让频繁故障的模型被反复尝试 |

### 关键导出

```typescript
export type ModelCapability = 'coding' | 'vision' | 'reasoning' | 'chat' | 'fast' | 'cheap' | 'large-context';

export class ModelRouter {
  register({ id, provider, capabilities, tier }): void;
  select(request: RoutingRequest): ModelProvider;
  executeWithFallback<T>(request, fn): Promise<T>;
  markFailed(modelId): void;     // 上层失败时调用
  markSucceeded(modelId): void;  // 成功时清除连续失败
}
```

### 测试亮点（8 个用例）

- [x] 按能力选模型：coding 需求选中 deepseek-v3 而非 qwen-turbo
- [x] capability 不匹配 → `MODEL_CAPABILITY_MISMATCH`
- [x] 连续失败 → 健康度降级，备份模型优先
- [x] 主模型挂 → 自动回退 → 成功
- [x] 全挂 → `MODEL_FALLBACK_EXHAUSTED`

---

## Phase 6 — Engineering Knowledge 工程知识

**增强包**：`@forgex/core`（新增 `memory/engineering-knowledge-store.ts`）

### 核心能力

```
┌─────────────────────────────────────────────────────┐
│ EngineeringKnowledgeStore                           │
│                                                     │
│  知识生命周期：                                     │
│  draft ──verify()──▶ active ──deprecate()──▶        │
│                              (保留但不推荐)          │
│                                                     │
│  然后 archive() → 过期归档，不参与 search            │
│                                                     │
│  桥接 Project Memory：                              │
│  写入时同步创建 MemoryEntry (scope=project)         │
└─────────────────────────────────────────────────────┘
```

### 安全硬约束

| 设计 | 说明 |
| --- | --- |
| `evidenceRefs.length >= 1` 强制 | 知识必须有出处，不允许凭空生成事实 |
| 来源区分 `user` / `agent` / `tool_run` | LLM 推断的知识默认 `draft=true` |
| `draft` 必须显式 `verify()` 才变 `active` | 不会把未验证知识当事实使用 |
| `archive` 后不参与 `search()` | 过期知识被主动过滤 |

### 关键导出

```typescript
export type KnowledgeType = 'architecture-decision' | 'pitfall' | 'best-practice' | 'command-reference' | 'dependency-notes';

export class EngineeringKnowledgeStore {
  create(input: CreateKnowledgeInput): EngineeringKnowledge;
  verify(id): EngineeringKnowledge;    // draft → active
  deprecate(id): EngineeringKnowledge;
  archive(id): EngineeringKnowledge;
  search(keyword): EngineeringKnowledge[]; // 排除 archived
  active(): EngineeringKnowledge[];
  drafts(): EngineeringKnowledge[];
}
```

### 测试亮点（8 个用例）

- [x] 用户知识 → `active` 状态
- [x] Agent 推断知识 → `draft=true`
- [x] `evidenceRefs=[]` → 抛错
- [x] `verify()` 从 draft → active
- [x] `archive()` 后 `search()` 排除

---

## 新增错误码（shared/errors）

| 错误码 | 所属 Phase | 抛出处 | 说明 |
| --- | --- | --- | --- |
| `REQUIREMENT_PARSE_FAILED` | 1 | `RequirementParser` | 空输入 / 模型返回不可解析 |
| `REQUIREMENT_AMBIGUITY_UNRESOLVED` | 1 | `RequirementAnalyzer.assertReady()` | 需求存在未解决歧义 |
| `REQUIREMENT_CRITERIA_UNAPPROVED` | 1 | `AcceptanceCriteriaValidator.assertValid()` | 验收标准存在未批准项 |
| `REQUIREMENT_TRACE_NOT_FOUND` | 1 | `RequirementTraceStore.get()` | 追溯链不存在 |
| `BUDGET_EXCEEDED` | 2 | `BudgetTracker.check()` | 预算耗尽（tokens/time/toolCalls/modelCalls/steps 任一） |
| `BUDGET_APPROVAL_REQUIRED` | 2 | 预留 | 追加预算需审批 |
| `EXECUTION_CANCELLED` | 2 | `AutonomousRunner` | 用户或系统取消执行 |
| `QUALITY_GATE_FAILED` | 3 | `TestRunner` | 测试未全绿 |
| `TEST_EXECUTION_FAILED` | 3 | `TestRunner` | 测试框架本身崩溃 |
| `STATIC_ANALYSIS_FAILED` | 3 | `StaticAnalyzer` | 静态分析发现 error 级问题 |
| `DELIVERY_VALIDATION_FAILED` | 3 | `SecurityScanner` | 安全扫描发现 critical/high |
| `MODEL_UNAVAILABLE` | 5 | `ModelRouter` | 所有模型都在冷却中 |
| `MODEL_CAPABILITY_MISMATCH` | 5 | `ModelRouter` | 没有模型匹配所需能力 |
| `MODEL_FALLBACK_EXHAUSTED` | 5 | `ModelRouter.executeWithFallback()` | 所有候选模型都失败 |

---

## 包清单

### 新增（4 个）

```
packages/requirement-engine/   ← Phase 1
  ├── src/
  │   ├── types.ts
  │   ├── index.ts
  │   ├── model/requirement-model-interface.ts
  │   ├── parser/requirement-parser.ts
  │   ├── analyzer/requirement-analyzer.ts
  │   ├── criteria/criteria-validator.ts
  │   └── traceability/trace-store.ts
  ├── test/requirement-engine.test.ts
  ├── package.json
  └── tsconfig.json

packages/autonomous/           ← Phase 2
  ├── src/
  │   ├── index.ts
  │   ├── budget/execution-budget.ts
  │   ├── runner/autonomous-runner.ts
  │   └── continuation/continuation-manager.ts
  ├── test/autonomous.test.ts
  ├── package.json
  └── tsconfig.json

packages/quality-gate/         ← Phase 3
  ├── src/
  │   ├── index.ts
  │   ├── quality-gate.ts
  │   ├── testing/test-runner.ts
  │   ├── static/static-analyzer.ts
  │   └── security/security-scanner.ts
  ├── test/quality-gate.test.ts
  ├── package.json
  └── tsconfig.json

packages/orchestrator/         ← Phase 4
  ├── src/
  │   ├── index.ts
  │   ├── dependency-graph.ts
  │   └── project-orchestrator.ts
  ├── test/orchestrator.test.ts
  ├── package.json
  └── tsconfig.json
```

### 增强（2 个）

```
packages/models/
  src/model-router.ts          ← 新增文件

packages/core/
  src/memory/engineering-knowledge-store.ts ← 新增文件
```

### 配置更新

- `tsconfig.build.json`：新增 4 个包引用
- `vitest.config.ts`：新增 `@forgex/requirement-engine`、`@forgex/autonomous`、`@forgex/quality-gate`、`@forgex/orchestrator` 别名

---

## 破坏性变更

**无**。所有新功能都是增量添加：
- 不修改 v0.4.0 的 `AgentLoop` / `TaskPlanner` / `SubAgentRunner`
- 不修改 `ToolRegistry` / `SecurityGateway` / `ApprovalManager` 核心接口
- 不修改 Rust `crates/executor`

v0.4.0 全部 693 个测试在 v0.5.0 下继续通过。

---

## 后续路线图

| 版本 | 主题 | 方向 |
| --- | --- | --- |
| v0.5.1 | 生产适配器 | `RequirementModelInterface` → 真实 prompt 模板 + `createProvider()` 注入 |
| v0.5.2 | SQLite 持久化 | `RequirementTraceStore` + `EngineeringKnowledgeStore` 接 SQLite WAL |
| v0.6.0 | 远程并行 | Orchestrator 跨工作区 + 远程 Agent 实例 |
| v0.7.0 | 企业特性 | SSO / RBAC / 多租户 / 审计合规报告 |

---

## 构建验证

```
$ pnpm build
$ pnpm test

✓ 58 test files passed
✓ 772 tests passed
✓ TypeScript 0 errors
✓ Exit code 0
```

v0.5.0 构建与全量测试于 2026-10-23 通过。
