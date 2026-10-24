# ForgeX v0.4.0 实现任务清单

> 每条任务映射到 spec.md 中的验收标准（AC）。优先级：high（阻塞闭环）/ medium（功能完整）/ low（增强）。
> 所有任务必须在对应包内完成 vitest 测试后才能标记完成。禁止声称未执行的测试已通过。

## Phase 1：Workflow Engine（首个最小闭环）

### T1.1 新建 workflows 包骨架
- **AC**: AC-001
- **优先级**: high
- **描述**: 创建 `packages/workflows/`，配置 package.json、tsconfig.json，添加到 tsconfig.build.json references。依赖 `@forgex/shared`、`@forgex/core`（TaskPlanner）、`@forgex/security`（AuditLogger）。
- **依赖**: 无
- **测试要求**:
  - rule: `pnpm build` 成功，workflows 包可被其他包 import。
  - rule: 包入口 `index.ts` 导出所有公共类型与类。

### T1.2 Workflow 类型定义
- **AC**: AC-001, AC-003
- **优先级**: high
- **描述**: 在 `packages/workflows/src/types.ts` 定义：WorkflowDefinition、WorkflowNode（type: task/approval/condition/verification）、WorkflowEdge、WorkflowState（pending/running/completed/failed/blocked/cancelled）、WorkflowNodeStatus、WorkflowExecutionReport、WorkflowCheckpointRecord。所有字段可 JSON 序列化。
- **依赖**: T1.1
- **测试要求**:
  - rule: 类型可被 TypeScript strict 模式编译通过。
  - rule: WorkflowNode.type 只能是 task/approval/condition/verification 四值之一。

### T1.3 WorkflowStateMachine
- **AC**: AC-001
- **优先级**: high
- **描述**: 在 `packages/workflows/src/runner/state-machine.ts` 实现节点状态机，合法转移：pending→running→completed/failed/blocked/cancelled；failed→running（重试）；blocked→running。复用 v0.3.0 修复经验：禁止 running→ready 直跳。导出 `isValidTransition(from, to)`、`allowedTransitions(from)`、`isTerminal(status)`。
- **依赖**: T1.2
- **测试要求**:
  - rule: 所有合法转移返回 true，非法转移返回 false。
  - rule: completed/cancelled 为终态，不可转出。

### T1.4 WorkflowValidator
- **AC**: AC-001
- **优先级**: high
- **描述**: 在 `packages/workflows/src/validation/workflow-validator.ts` 实现：DAG 环检测（DFS）、强制验证节点存在检查、未知节点类型拒绝、孤立节点检测。返回 `ValidationResult { ok, errors[] }`。
- **依赖**: T1.2
- **测试要求**:
  - rule: 含环的 DAG 被拒绝，错误信息指出环路径。
  - rule: 缺少 mandatory verification 节点的定义被拒绝。
  - rule: 未知节点类型被拒绝。

### T1.5 WorkflowRegistry
- **AC**: AC-003
- **优先级**: high
- **描述**: 在 `packages/workflows/src/registry/workflow-registry.ts` 实现工作流注册/查找/列表。内置 6 个工作流定义在 `definitions/` 目录。
- **依赖**: T1.2, T1.4
- **测试要求**:
  - rule: 能注册和查找工作流，重复 ID 注册抛错。
  - rubric: 6 个内置工作流（bug-fix, feature-dev, code-review, refactoring, devops-diagnosis, deployment-prep）均可通过 validator。

### T1.6 内置工作流定义
- **AC**: AC-003
- **优先级**: high
- **描述**: 在 `packages/workflows/src/definitions/` 创建 6 个工作流：
  - `bug-fix.ts`: Analyze → Plan → Implement → Test → Review（Test 和 Review 为 mandatory verification）
  - `feature-dev.ts`: Requirement → Analyze → Plan → Implement → Test → Review → Build
  - `code-review.ts`: Fetch → Analyze → Review → Report
  - `refactoring.ts`: Analyze → Plan → Refactor → Test → Review
  - `devops-diagnosis.ts`: Check → Collect → Analyze → Correlate → Verify → Report
  - `deployment-prep.ts`: Validate → Build → Test → Package → Approve → Deliver
  每个工作流的 task 节点映射到 TaskStep（复用 TaskPlanner.create）。
- **依赖**: T1.5
- **测试要求**:
  - rule: 每个工作流通过 WorkflowValidator 校验。
  - rule: Bug Fix 工作流包含 Analyze/Plan/Implement/Test/Review 节点。
  - rule: 每个工作流至少有一个 verification 节点。

### T1.7 WorkflowCheckpoint
- **AC**: AC-005
- **优先级**: high
- **描述**: 在 `packages/workflows/src/runner/checkpoint.ts` 实现 SQLite 检查点持久化（复用 v0.3.0 CheckpointManager 模式：DatabaseSync + WAL + busy_timeout）。save(workflowId, snapshot)、load(workflowId)、delete(workflowId)。
- **依赖**: T1.2
- **测试要求**:
  - rule: save 后 load 返回相同快照。
  - rule: 检查点包含 workflow_id、snapshot_at、nodes[]、completed_node_ids、running_node_id。

### T1.8 WorkflowRunner
- **AC**: AC-002, AC-004, AC-005
- **优先级**: high
- **描述**: 在 `packages/workflows/src/runner/workflow-runner.ts` 实现工作流执行编排：
  - 复用 TaskPlanner 执行 task 类型节点（将 WorkflowNode 转为 TaskStep 调用 TaskPlanner.create + runSingle）；
  - approval 节点调用 ApprovalManager.request 阻塞；
  - condition 节点根据上一节点结果选择分支；
  - verification 节点执行并校验结果；
  - 按依赖拓扑调度（复用 DependencyScheduler 思路）；
  - maxSteps 硬上限防止无限循环；
  - 支持超时、取消（AbortSignal）、失败重试（复用 StepExecutor 重试预算）；
  - 每个节点状态变化时写 WorkflowCheckpoint；
  - 输出 WorkflowExecutionReport。
- **依赖**: T1.3, T1.4, T1.6, T1.7
- **测试要求**:
  - rule: 简单线性工作流（task→verification）可完整执行并返回 completed。
  - rule: verification 节点失败时工作流状态为 failed，不进入 completed。
  - rule: maxSteps 超限后工作流停止，不无限循环。
  - rule: approval 节点被拒绝时工作流状态为 failed。
  - rule: 崩溃恢复后从检查点继续，已完成节点不重复执行。

## Phase 2：Sandbox Manager

### T2.1 新建 sandbox 包骨架
- **AC**: AC-006
- **优先级**: high
- **描述**: 创建 `packages/sandbox/`，依赖 `@forgex/shared`、`@forgex/security`（WorkspaceGuard）、`@forgex/tools`（executor-client）。
- **依赖**: 无
- **测试要求**:
  - rule: `pnpm build` 成功。

### T2.2 Sandbox 类型与能力检测
- **AC**: AC-006
- **优先级**: high
- **描述**: 在 `packages/sandbox/src/types.ts` 定义 SandboxType、SandboxCapability、SandboxSpec、SandboxResult。在 `packages/sandbox/src/manager/capability-detector.ts` 实现能力检测：检查 Rust executor 是否可用、Git 是否可用、临时目录是否可写、OS 级沙箱（bubblewrap/cgroups）是否可用。
- **依赖**: T2.1
- **测试要求**:
  - rule: detectCapabilities 返回结构化结果，每项能力有 available + reason。
  - rule: Rust executor 不可用时标记为不可用并给出原因。

### T2.3 SandboxProvider 接口与 TempDirProvider
- **AC**: AC-006, AC-008
- **优先级**: high
- **描述**: 在 `packages/sandbox/src/providers/sandbox-provider.ts` 定义接口 `SandboxProvider { create(spec): Sandbox; destroy(sandbox): void }`。在 `temp-dir-provider.ts` 实现临时目录沙箱（os.tmpdir + 唯一子目录，destroy 时递归删除）。
- **依赖**: T2.2
- **测试要求**:
  - rule: create 返回的沙箱工作目录存在且可写。
  - rule: destroy 后工作目录被删除。

### T2.4 GitWorktreeProvider
- **AC**: AC-007
- **优先级**: high
- **描述**: 在 `packages/sandbox/src/providers/git-worktree-provider.ts` 实现：在授权工作区内 `git worktree add` 创建隔离分支，destroy 时 `git worktree remove` + 清理分支。路径必须通过 WorkspaceGuard 校验。
- **依赖**: T2.3
- **测试要求**:
  - rule: create 在 Git 仓库内成功创建 worktree。
  - rule: worktree 路径在授权工作区内。
  - rule: destroy 后 worktree 被清理。

### T2.5 OsSandboxProvider（能力检测占位）
- **AC**: AC-006
- **优先级**: medium
- **描述**: 在 `packages/sandbox/src/providers/os-sandbox-provider.ts` 实现 OS 级沙箱提供者的**能力检测与拒绝**逻辑。第一版不实现完整 bubblewrap/seccomp 集成，只做检测并在不可用时明确拒绝不可信代码执行。禁止自动降级。
- **依赖**: T2.2
- **测试要求**:
  - rule: 当 OS 沙箱不可用时，requestUntrustedExecution 抛出明确拒绝错误，不降级。
  - rule: 错误信息包含不可用原因。

### T2.6 ResourceLimiter
- **AC**: AC-008
- **优先级**: high
- **描述**: 在 `packages/sandbox/src/manager/resource-limiter.ts` 实现：超时控制（复用 Rust executor timeoutMs）、输出上限（maxOutputBytes）、并发限制。命令执行通过 `runViaExecutor` 传递 callerToken + allowedCwdRoots。
- **依赖**: T2.3
- **测试要求**:
  - rule: 超时命令被终止，返回 timedOut=true。
  - rule: 进程树被清理（无残留子进程）。

### T2.7 WorkspaceManager
- **AC**: AC-007
- **优先级**: high
- **描述**: 在 `packages/sandbox/src/workspace/workspace-manager.ts` 实现：创建隔离工作区（优先 Git Worktree，回退临时目录）、获取工作区路径、清理工作区。所有路径通过 WorkspaceGuard 校验。
- **依赖**: T2.4, T2.3
- **测试要求**:
  - rule: Git 仓库内创建 worktree 工作区，非 Git 仓库创建临时目录工作区。
  - rule: 清理后工作区不存在。

### T2.8 SandboxLifecycle
- **AC**: AC-008
- **优先级**: high
- **描述**: 在 `packages/sandbox/src/lifecycle/sandbox-lifecycle.ts` 实现：创建 → 执行 → 清理的生命周期管理，异常时确保资源回收（try/finally）。
- **依赖**: T2.5, T2.6, T2.7
- **测试要求**:
  - rule: 执行异常后沙箱资源被清理。
  - rule: 超时后进程被清理。

### T2.9 SandboxManager
- **AC**: AC-006, AC-007, AC-008
- **优先级**: high
- **描述**: 在 `packages/sandbox/src/manager/sandbox-manager.ts` 实现统一入口：能力检测、选择 Provider、创建沙箱、执行命令、销毁沙箱。不可信代码执行（L2+ risk）在沙箱不可用时拒绝。
- **依赖**: T2.8
- **测试要求**:
  - rule: 沙箱可用时可执行命令。
  - rule: 沙箱不可用时拒绝不可信代码执行，不自动降级。
  - rule: 所有沙箱最终被销毁。

## Phase 3：Approval Engine

### T3.1 新建 approval 包骨架
- **AC**: AC-009
- **优先级**: high
- **描述**: 创建 `packages/approval/`，依赖 `@forgex/shared`、`@forgex/security`（AuditLogger）。
- **依赖**: 无
- **测试要求**:
  - rule: `pnpm build` 成功。

### T3.2 审批类型与四级风险
- **AC**: AC-009
- **优先级**: high
- **描述**: 在 `packages/approval/src/types.ts` 定义：ApprovalRiskLevel（L0/L1/L2/L3）、ApprovalRecord、ApprovalStatus（pending/approved/denied/revoked/expired）、ApprovalScope（操作 + 参数哈希 + 目标环境 + 有效期）。
- **依赖**: T3.1
- **测试要求**:
  - rule: ApprovalRiskLevel 只能是 L0/L1/L2/L3。

### T3.3 ApprovalPolicy
- **AC**: AC-009
- **优先级**: high
- **描述**: 在 `packages/approval/src/policy/approval-policy.ts` 实现：根据风险级别返回审批要求（L0 自动放行、L1 可选审批、L2 必须审批、L3 必须人工审批且默认拒绝）。策略由可信配置决定，不接受模型输入。
- **依赖**: T3.2
- **测试要求**:
  - rule: L0 返回 auto-allow，L3 返回 must-approve-manual。
  - rule: 策略不可被模型参数修改。

### T3.4 参数哈希
- **AC**: AC-010, AC-012
- **优先级**: high
- **描述**: 在 `packages/approval/src/requests/param-hasher.ts` 实现：对操作名 + 完整参数（program + args + 输入）计算 SHA-256 哈希。参数任何变化导致哈希变化。
- **依赖**: T3.2
- **测试要求**:
  - rule: 相同参数产生相同哈希。
  - rule: 参数任何变化产生不同哈希。
  - rule: 命令拆分后各部分哈希不同。

### T3.5 ApprovalStore
- **AC**: AC-010, AC-011
- **优先级**: high
- **描述**: 在 `packages/approval/src/store/approval-store.ts` 实现 SQLite 持久化：create(request)、get(id)、listByScope(scopeHash)、updateStatus(id, status)、expireOutdated()。
- **依赖**: T3.2, T3.4
- **测试要求**:
  - rule: create 后 get 返回相同记录。
  - rule: listByScope 返回匹配的审批。
  - rule: expireOutdated 将过期审批标记为 expired。

### T3.6 ApprovalAudit
- **AC**: AC-010
- **优先级**: high
- **描述**: 在 `packages/approval/src/audit/approval-audit.ts` 实现：审批事件写入 AuditLogger，包含操作摘要、风险级别、目标环境、申请主体、审批主体、有效期、决策时间。
- **依赖**: T3.2
- **测试要求**:
  - rule: 审批事件包含所有必填字段。
  - rule: 敏感字段被脱敏。

### T3.7 增强版 ApprovalManager
- **AC**: AC-009, AC-010, AC-011, AC-012
- **优先级**: high
- **描述**: 在 `packages/approval/src/approval-manager.ts` 实现增强版：
  - request(operation, params, riskLevel, scope): 创建审批记录，根据策略决定是否需要人工审批；
  - 校验参数哈希是否已有有效审批；
  - 撤销（revoke）、过期检查（isExpired）；
  - 对子代理操作强制审批（DelegationManager 调用）。
- **依赖**: T3.3, T3.4, T3.5, T3.6
- **测试要求**:
  - rule: L0 操作自动放行，不创建审批记录。
  - rule: L3 操作必须人工审批，非交互环境默认拒绝。
  - rule: 参数哈希变化后已有审批失效，必须重新审批。
  - rule: 撤销后审批不可用。
  - rule: 过期后审批不可用。

### T3.8 旧 ApprovalManager 兼容包装
- **AC**: AC-021
- **优先级**: high
- **描述**: 在 `packages/approval/src/compat/legacy-approval-manager.ts` 实现对旧 `security.ApprovalManager` 的兼容包装，使 v0.3.0 调用方无需修改。
- **依赖**: T3.7
- **测试要求**:
  - rule: 旧接口 `request(ApprovalRequest, signal?)` 继续工作。
  - rule: v0.3.0 security 测试全部通过。

## Phase 4：Git / CI-CD Integration

### T4.1 新建 integrations 包骨架
- **AC**: AC-013
- **优先级**: high
- **描述**: 创建 `packages/integrations/`，依赖 `@forgex/shared`、`@forgex/security`、`@forgex/tools`。
- **依赖**: 无
- **测试要求**:
  - rule: `pnpm build` 成功。

### T4.2 GitService
- **AC**: AC-013
- **优先级**: high
- **描述**: 在 `packages/integrations/src/git/git-service.ts` 实现：diff、status、branch（list/create/switch）、worktree（add/remove/list）、commit（message + staged files）。commit 必须经过审批，禁止自动推送。
- **依赖**: T4.1
- **测试要求**:
  - rule: diff 返回结构化变更列表。
  - rule: commit 操作被标记为需要审批。
  - rule: 不提供 push 方法。

### T4.3 RepositoryManager
- **AC**: AC-013
- **优先级**: high
- **描述**: 在 `packages/integrations/src/git/repository-manager.ts` 实现：受保护分支检测（main/master/release/*）、仓库状态、远程配置。禁止修改仓库权限。
- **依赖**: T4.2
- **测试要求**:
  - rule: main 分支被识别为受保护。
  - rule: 合并到受保护分支被拒绝。

### T4.4 ChangeSetManager
- **AC**: AC-013
- **优先级**: medium
- **描述**: 在 `packages/integrations/src/git/change-set-manager.ts` 实现：变更集创建、文件影响分析（哪些文件变更、影响哪些模块）。
- **依赖**: T4.2
- **测试要求**:
  - rule: 变更集列出所有变更文件。

### T4.5 ReviewManager
- **AC**: AC-013
- **优先级**: medium
- **描述**: 在 `packages/integrations/src/git/review-manager.ts` 实现：Commit Message 建议、PR/MR 描述生成（基于 diff 内容）。
- **依赖**: T4.4
- **测试要求**:
  - rubric: Commit Message 符合 conventional commits 格式。

### T4.6 PipelineAdapter 接口与本地 CI
- **AC**: AC-014
- **优先级**: high
- **描述**: 在 `packages/integrations/src/ci/pipeline-adapter.ts` 定义接口 `PipelineAdapter { getStatus(buildId): PipelineStatus; getLogs(buildId): string; diagnoseFailure(buildId): FailureDiagnosis }`。本地实现读取 Git pre-commit/post-commit 钩子或本地脚本输出。
- **依赖**: T4.1
- **测试要求**:
  - rule: 接口类型可编译。

### T4.7 GitLabAdapter（私有化）
- **AC**: AC-014
- **优先级**: medium
- **描述**: 在 `packages/integrations/src/gitlab/gitlab-adapter.ts` 实现 GitLab API 封装：项目、Pipeline、Job、日志。支持自定义 baseURL + private token。
- **依赖**: T4.6
- **测试要求**:
  - rule: baseURL 和 token 从配置读取，不硬编码。
  - rubric: 能解析 GitLab pipeline JSON 响应。

### T4.8 JenkinsAdapter（私有化）
- **AC**: AC-014
- **优先级**: medium
- **描述**: 在 `packages/integrations/src/jenkins/jenkins-adapter.ts` 实现 Jenkins API 封装：build 状态、控制台日志。支持自定义 baseURL + username/apiToken。
- **依赖**: T4.6
- **测试要求**:
  - rule: baseURL 和凭据从配置读取，不硬编码。

## Phase 5：Observability

### T5.1 新建 observability 包骨架
- **AC**: AC-015
- **优先级**: high
- **描述**: 创建 `packages/observability/`，依赖 `@forgex/shared`、`@forgex/security`（AuditLogger）、`@forgex/core`（EventBus）。
- **依赖**: 无
- **测试要求**:
  - rule: `pnpm build` 成功。

### T5.2 Trace 类型与 SpanRecorder
- **AC**: AC-015
- **优先级**: high
- **描述**: 在 `packages/observability/src/tracing/types.ts` 定义：Trace、Span、SpanContext（traceId/spanId/parentSpanId）。在 `span-recorder.ts` 实现 Span 创建、记录（开始/结束/属性/事件）。
- **依赖**: T5.1
- **测试要求**:
  - rule: Span 必须有 traceId、spanId，子 Span 有 parentSpanId。

### T5.3 TraceManager
- **AC**: AC-015
- **优先级**: high
- **描述**: 在 `packages/observability/src/tracing/trace-manager.ts` 实现：创建 Trace、为 Task/Session/Agent/Tool/WorkflowStep 创建 Span、关联父子代理（parentAgentId）、导出 Trace 为 JSON。
- **依赖**: T5.2
- **测试要求**:
  - rule: 子代理 Span 的 parentAgentId 指向父代理。
  - rule: export 返回可 JSON 序列化的 Trace。

### T5.4 MetricsCollector
- **AC**: AC-017
- **优先级**: high
- **描述**: 在 `packages/observability/src/metrics/metrics-collector.ts` 实现：采集 token 用量（prompt/completion/total）、执行耗时、工具调用次数/失败次数、审批次数。支持 P50/P95 计算。
- **依赖**: T5.1
- **测试要求**:
  - rule: record 后 get 返回正确计数。
  - rule: P50/P95 计算正确（至少 5 个样本）。

### T5.5 AuditEventStore
- **AC**: AC-016
- **优先级**: high
- **描述**: 在 `packages/observability/src/audit/audit-event-store.ts` 实现：扩展 AuditLogger，支持事件查询（按 sessionId/agentId/tool 过滤）、事件存储（SQLite 或 JSONL）。所有事件通过 redactValue 脱敏。
- **依赖**: T5.1
- **测试要求**:
  - rule: 查询按 sessionId 过滤正确。
  - rule: 含 API Key 的事件被脱敏。

### T5.6 ExecutionReporter
- **AC**: AC-017
- **优先级**: high
- **描述**: 在 `packages/observability/src/reports/execution-reporter.ts` 实现：从 Trace + Metrics + AuditEvent 生成任务执行报告，包含 Task ID、Session ID、各步骤状态、耗时、Token 消耗、验证结果、审批记录。导出 JSON。
- **依赖**: T5.3, T5.4, T5.5
- **测试要求**:
  - rubric: 报告包含所有必填字段，可导出为 JSON。

## Phase 6：Recovery Engine

### T6.1 新建 recovery 包骨架
- **AC**: AC-018
- **优先级**: high
- **描述**: 创建 `packages/recovery/`，依赖 `@forgex/shared`、`@forgex/core`（CheckpointManager、TaskPlanner）、`@forgex/security`（PolicyEngine）、`@forgex/workflows`。
- **依赖**: T1.8
- **测试要求**:
  - rule: `pnpm build` 成功。

### T6.2 CheckpointStore（工作流级）
- **AC**: AC-018
- **优先级**: high
- **描述**: 在 `packages/recovery/src/checkpoints/checkpoint-store.ts` 实现：扩展 WorkflowCheckpoint，增加环境快照（工作区路径、Git HEAD、关键文件 hash）、权限策略版本。save/load/delete。
- **依赖**: T6.1, T1.7
- **测试要求**:
  - rule: 检查点包含环境快照和权限策略版本。

### T6.3 RecoveryPlanner
- **AC**: AC-018, AC-019
- **优先级**: high
- **描述**: 在 `packages/recovery/src/coordinator/recovery-planner.ts` 实现：根据检查点识别已完成节点、决定哪些节点可重跑（幂等）、哪些需要人工确认（非幂等）。输出 RecoveryPlan。
- **依赖**: T6.2
- **测试要求**:
  - rule: 已完成节点不在恢复计划中。
  - rule: 非幂等节点标记为 need_confirmation。

### T6.4 RollbackCoordinator
- **AC**: AC-019, AC-020
- **优先级**: high
- **描述**: 在 `packages/recovery/src/coordinator/rollback-coordinator.ts` 实现：Git 回滚（git revert/reset）、已执行操作核对、不可回滚操作标记。生产回滚走独立审批。
- **依赖**: T6.3, T4.2
- **测试要求**:
  - rule: 不可回滚操作在报告中明确标记。
  - rule: 生产回滚需要 L3 审批。

### T6.5 RecoveryVerifier
- **AC**: AC-018
- **优先级**: high
- **描述**: 在 `packages/recovery/src/verification/recovery-verifier.ts` 实现：恢复后验证——权限策略兼容、环境未变、关键步骤结果一致。
- **依赖**: T6.2
- **测试要求**:
  - rule: 权限策略收紧时验证失败，暂停恢复。
  - rule: Git HEAD 变化时检测到环境不兼容。

### T6.6 RecoveryManager
- **AC**: AC-018, AC-019, AC-020
- **优先级**: high
- **描述**: 在 `packages/recovery/src/recovery-manager.ts` 实现统一入口：恢复前权限重验 → 环境兼容校验 → 生成恢复计划 → 执行可恢复节点 → 回滚协调 → 恢复验证。
- **依赖**: T6.3, T6.4, T6.5
- **测试要求**:
  - rule: 恢复前权限不兼容时暂停并请求审批。
  - rule: 非幂等操作不盲目重跑。
  - rule: 恢复报告区分已回滚和未回滚资源。

## Phase 7：端到端集成测试、安全测试与 Benchmark

### T7.1 E2E 场景 A：自动修复 Bug
- **AC**: AC-002, AC-003, AC-007, AC-013
- **优先级**: high
- **描述**: 集成测试：输入可复现 Bug → 创建隔离工作区 → 分析 → 计划 → 修改 → 测试 → 审查 → 输出 Diff → 等待确认后提交。使用确定性 mock 模型。
- **依赖**: T1.8, T2.9, T4.2
- **测试要求**:
  - rule: 工作流完整执行到 Review 节点。
  - rule: Diff 输出正确。
  - rule: commit 前等待审批。

### T7.2 E2E 场景 B：Docker 服务故障诊断
- **AC**: AC-002, AC-003
- **优先级**: high
- **描述**: 集成测试：输入 HTTP 500 故障 → 检查网络 → 检查容器 → 获取日志 → 分析异常 → 关联代码 → 验证根因 → 提供修复方案。不执行生产重启。
- **依赖**: T1.8
- **测试要求**:
  - rule: 不调用生产重启命令。
  - rule: 诊断报告包含根因和修复方案。

### T7.3 E2E 场景 C：隔离测试
- **AC**: AC-006, AC-008
- **优先级**: high
- **描述**: 安全测试：不可信命令无法访问未授权目录、无法读取敏感凭据、无法访问未授权网络、超时后进程清理、沙箱失败时安全终止。
- **依赖**: T2.9
- **测试要求**:
  - rule: 越权访问被拒绝。
  - rule: 敏感凭据读取被拒绝。
  - rule: 超时后进程被清理。

### T7.4 E2E 场景 D：人工审批
- **AC**: AC-004, AC-009, AC-010
- **优先级**: high
- **描述**: 集成测试：Agent 尝试修改生产服务器配置（L3）→ 停止并请求审批 → 拒绝后不得继续执行。
- **依赖**: T3.7, T1.8
- **测试要求**:
  - rule: L3 操作触发审批请求。
  - rule: 拒绝后工作流终止，不继续执行后续节点。

### T7.5 E2E 场景 E：任务恢复
- **AC**: AC-005, AC-018, AC-019
- **优先级**: high
- **描述**: 集成测试：模拟进程异常退出 → 重启后恢复任务状态 → 重新验证授权 → 识别已完成步骤 → 避免重复副作用 → 安全继续或终止。
- **依赖**: T6.6
- **测试要求**:
  - rule: 恢复后已完成节点不重复执行。
  - rule: 非幂等操作不盲目重跑。

### T7.6 v0.3.0 vs v0.4.0 Benchmark
- **AC**: AC-021, AC-022
- **优先级**: high
- **描述**: 扩展 benchmark/ 增加 v0.4 场景：任务完成率、Bug 修复成功率、工具执行成功率、安全隔离有效性、审批策略覆盖率、工作流恢复成功率、P50/P95 延迟、Token 消耗、CI 失败诊断准确率。在相同模型、硬件、任务预算下对比。
- **依赖**: T1.8, T2.9, T3.7, T6.6
- **测试要求**:
  - rubric: Benchmark 输出 JSON 报告，包含 v0.3.0 和 v0.4.0 对比。
  - rule: 安全隔离有效性和审批策略覆盖率 100%。

### T7.7 全量回归
- **AC**: AC-021
- **优先级**: high
- **描述**: 运行 `pnpm build`、`pnpm test`、`cargo test`、`pnpm benchmark`，确认全部通过。
- **依赖**: T7.1-T7.6
- **测试要求**:
  - rule: TS 测试全部通过。
  - rule: Rust 测试全部通过。
  - rule: Benchmark 全部通过。
  - rule: 无新增 any 类型（lint 检查）。
