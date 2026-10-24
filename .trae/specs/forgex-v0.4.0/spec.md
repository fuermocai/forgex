# ForgeX v0.4.0 规格说明

## 问题陈述

ForgeX v0.3.0 已具备单 Agent 循环、Task Planner、Sub-Agent、混合检索、项目记忆、上下文引擎和 Rust 安全执行器。但它仍是一个"能执行单任务"的 Agent，缺少企业级工程闭环：

- 没有结构化工作流来编排 Requirement → Analyze → Plan → Implement → Test → Review → Build → Deliver 全流程；
- 代码执行缺少 OS 级隔离（Git Worktree 不等于沙箱），不可信代码可能逃逸工作区；
- 审批只有"是/否"单次回调，缺少四级风险模型、参数绑定、范围/有效期、持久化与撤销；
- Git 操作只有 status/diff 两个只读工具，没有分支、worktree、commit、CI 集成；
- 可观测性只有审计日志，没有 Trace 关联父子代理、指标采集与执行报告；
- 恢复只覆盖 Task Planner 内部检查点，没有工作流级断点恢复、环境兼容性校验与幂等语义。

v0.4.0 的目标是在不重写现有 Runtime 的前提下，增量补齐上述六大模块，使 ForgeX 成为可安全执行完整软件工程工作流、支持企业内网部署、可审批、可审计、可恢复的企业级 Coding + DevOps Agent。

## 用户与目标

**用户**：企业内部 DevOps 工程师、SRE、后端开发者、安全合规团队。

**目标**：
- 在隔离环境中安全执行完整工程工作流；
- 高风险操作必须经过人工审批，参数变化需重新审批；
- 所有操作可审计、可追溯、可恢复；
- 支持企业内网、国产模型、完全离线部署；
- 默认最小权限，生产环境默认只读。

## 非目标

- 不重写 Agent Runtime（agent-loop、tool-dispatcher、session-store 保持不变）；
- 不替换 Task Planner 和 Sub-Agent（Workflow Engine 必须复用 v0.3.0 TaskPlanner）；
- 不破坏现有 Tool Registry 与 Security Gateway；
- 不实现多 Agent 自动协作（Sub-Agent 已够用）；
- 不依赖国外在线服务（GitHub 可选、Jenkins/GitLab 必须私有化）；
- 不声称强沙箱隔离（第一版只做能力检测 + 不可信代码拒绝执行）。

## 约束与依赖

**硬约束**：
1. TypeScript strict 模式，禁止滥用 `any`；
2. 所有工具调用必须通过统一 dispatcher，tool_call_id 与 tool_result 一一对应；
3. 命令执行必须用显式可执行文件 + 参数数组 + 工作目录 + 环境变量白名单；
4. 文件操作限制在授权工作区，防护路径穿越与符号链接逃逸；
5. 支持完全离线部署，不依赖在线 CDN；
6. 生产环境默认只读，所有写入和执行必须可审计；
7. 模型不可直接提升权限；
8. 所有工程任务必须有独立验证结果；
9. 严重越权、敏感数据泄露或沙箱逃逸问题一票否决。

**可复用依赖**：
- `@forgex/core`：TaskPlanner / PlanManager / StepExecutor / CheckpointManager / SubAgentRunner / EventBus / EvidenceStore
- `@forgex/security`：PolicyEngine / WorkspaceGuard / CommandGuard / AuditLogger
- `@forgex/tools`：run_command / executor-client（Rust 执行器）/ git_status / git_diff
- `@forgex/shared`：ForgeError / 类型 / redactValue / uuid
- `crates/executor`：Rust 安全执行器（caller token + cwd 白名单 + 并发限制 + 审计）

## 功能需求

### 模块一：Workflow Engine

复用 v0.3.0 TaskPlanner，**不建立第二套调度系统**。

- `WorkflowDefinition`：结构化工作流定义，含节点（node）、边（dependency）、节点类型（task / approval / condition / verification）；
- `WorkflowStateMachine`：节点级状态机（pending → running → completed/failed/blocked/cancelled），强制验证节点不可跳过；
- `WorkflowValidator`：校验 DAG 无环、强制节点存在、节点类型合法；
- `WorkflowRegistry`：注册/查找工作流定义；
- `WorkflowRunner`：编排执行，串行与依赖调度，超时/取消/重试，人工审批节点阻塞，中断恢复，条件分支，任务执行报告；
- `WorkflowCheckpoint`：持久化工作流状态（复用 CheckpointManager 思路，用 node:sqlite）；
- 内置 6 个工作流：Bug Fix、Feature Development、Code Review、Refactoring、DevOps Diagnosis、Deployment Preparation；
- 禁止无限循环（maxSteps 硬上限）；
- 不允许跳过强制验证节点（如 Test、Review）。

### 模块二：Sandbox Manager

- `SandboxManager`：统一入口，检测沙箱能力，创建/销毁沙箱；
- `SandboxProvider`：沙箱提供者接口，多实现（GitWorktreeProvider / TempDirProvider / OsSandboxProvider）；
- `WorkspaceManager`：Git Worktree 创建与清理、临时工作目录管理；
- `ResourceLimiter`：CPU/内存/超时配额（优先用 Rust executor 的 timeout + cwd 白名单）；
- `SandboxLifecycle`：创建 → 使用 → 清理，进程树清理，临时资源回收；
- Linux 评估 bubblewrap / seccomp / cgroups v2 / namespaces（第一版只做能力检测，不实现完整 OS 沙箱）；
- Windows 独立适配，不假设 Linux 机制可直接运行；
- **沙箱不可用时：明确提示原因，拒绝不可信代码执行，禁止自动降级到无沙箱执行，禁止自动关闭 AppArmor 等安全机制**；
- Git Worktree 只负责代码工作区隔离，不替代 OS 级安全沙箱。

### 模块三：Approval Engine

- `ApprovalManager`（增强版）：四级风险（L0 只读 / L1 工作区低风险修改 / L2 敏感操作 / L3 高风险操作）；
- `ApprovalPolicy`：可信配置决定权限，模型不可自行决定；
- `ApprovalRequest`：绑定具体操作及参数，参数哈希用于变化检测；
- `ApprovalStore`：持久化审批记录（node:sqlite）；
- `ApprovalAudit`：审批全字段审计（操作摘要、风险、目标环境、申请主体、审批主体、有效期）；
- 支持单次审批、限定范围和有效期的审批；
- 参数变化后重新审批；
- 高风险操作（L3）必须人工审批；
- 支持拒绝、撤销和过期；
- 子代理不能绕过审批（通过 DelegationManager 注入审批检查）；
- 不允许通过命令拆分绕过审批（参数哈希包含完整命令）；
- 默认不允许自动执行生产变更；
- 对旧 `security.ApprovalManager` 做兼容包装，不破坏 v0.3.0 调用方。

### 模块四：Git / CI-CD Integration

- `GitService`：本地 Git 操作封装（diff、branch、worktree、commit）；
- `RepositoryManager`：仓库状态管理、受保护分支检测；
- `ChangeSetManager`：变更集管理、变更影响分析；
- `ReviewManager`：PR/MR 描述生成、Commit Message 建议；
- `PipelineAdapter`：CI 状态读取、构建日志分析、测试失败诊断；
- 优先支持本地 Git、企业 GitLab（私有化）、Jenkins（私有化）；GitHub 可选；
- **禁止默认自动合并到受保护分支**；
- **禁止默认自动推送代码**；
- **禁止自动修改仓库权限或 CI 凭据**。

### 模块五：Observability

- `TraceManager`：Trace 管理，关联父代理和子代理；
- `SpanRecorder`：Span 记录（task/session/agent/tool/workflow step）；
- `MetricsCollector`：指标采集（token 用量、耗时、调用次数）；
- `AuditEventStore`：审计事件存储（扩展现有 AuditLogger，支持查询）；
- `ExecutionReporter`：任务执行报告生成；
- 记录字段：Task ID、Session ID、Agent ID、Parent Agent ID、Tool Call ID、Workflow Step ID、Model Provider、Token 使用量、执行耗时、工具调用结果、审批记录、错误信息、验证结果；
- JSON 结构化日志；
- OpenTelemetry 可选集成（不强制依赖）；
- 本地离线存储；
- 敏感数据脱敏（复用 redactValue，禁止日志含完整密钥/Token）；
- Trace 导出。

### 模块六：Recovery Engine

- `RecoveryManager`：恢复入口；
- `CheckpointStore`：工作流级检查点存储（复用 Task Planner CheckpointManager，扩展到工作流节点）；
- `RecoveryPlanner`：恢复计划生成（识别已完成步骤、决定哪些重跑）；
- `RollbackCoordinator`：回滚协调（Git 回滚 + 操作核对）；
- `RecoveryVerifier`：恢复结果验证；
- 恢复前重新验证权限；
- 恢复前确认环境没有发生不兼容变化；
- 不能盲目重复副作用操作；
- 每个可重试操作必须定义幂等语义；
- 不能假设所有操作都可回滚；
- Git 回滚不能替代数据库或基础设施回滚；
- 生产回滚必须遵循独立审批流程。

## 非功能需求

- 性能：单个工作流步骤执行延迟 P95 < 5s（不含模型调用）；
- 可恢复性：进程崩溃后可从最后一个检查点恢复，不重复副作用；
- 安全性：L3 操作 100% 人工审批，沙箱不可用时拒绝不可信代码执行；
- 可观测性：所有操作可追溯到 session/agent/tool/workflow；
- 兼容性：100% 向后兼容 v0.3.0（不破坏现有 API 和测试）；
- 离线部署：不依赖任何在线 CDN 或远程下载。

## 验收标准

### AC-001：Workflow Engine 基础能力
- **type**: rule
- WorkflowDefinition 必须支持节点类型 task / approval / condition / verification，节点之间通过 dependencies 形成 DAG。
- WorkflowValidator 必须拒绝含环的 DAG、缺少强制验证节点的定义、未知节点类型。
- WorkflowStateMachine 必须只允许合法状态转移，禁止 running → ready 直跳（复用 v0.3.0 修复经验）。

### AC-002：Workflow 执行与强制节点
- **type**: rule
- WorkflowRunner 必须按依赖拓扑顺序执行节点，支持 maxSteps 硬上限防止无限循环。
- verification 类型节点必须执行且通过后工作流才能进入 completed 状态；标记为 mandatory 的节点不可跳过。
- 支持超时、取消（传播 AbortSignal）、失败重试（复用 StepExecutor 重试预算）。

### AC-003：内置工作流
- **type**: rubric
- 必须提供 6 个内置工作流定义：Bug Fix、Feature Development、Code Review、Refactoring、DevOps Diagnosis、Deployment Preparation。
- 每个工作流必须包含至少一个 verification 节点。
- Bug Fix 工作流必须包含 Analyze → Plan → Implement → Test → Review 节点。

### AC-004：人工审批节点
- **type**: rule
- approval 类型节点执行时必须阻塞工作流并调用 ApprovalManager.request。
- 审批拒绝后节点状态为 cancelled，工作流状态为 failed；审批超时视为拒绝。
- 审批通过后节点状态为 completed，工作流继续。

### AC-005：Workflow 检查点与恢复
- **type**: rule
- WorkflowCheckpoint 必须在每个节点状态变化时持久化到 SQLite。
- 崩溃恢复后必须从最后一个未终态节点继续，已完成节点不重复执行。
- 恢复前必须校验工作流定义版本与检查点兼容。

### AC-006：Sandbox 能力检测
- **type**: rule
- SandboxManager 启动时必须检测可用沙箱能力（Rust executor、Git worktree、临时目录、OS 级沙箱）。
- 检测结果必须结构化返回可用/不可用及原因。
- 不可信代码执行（L2 及以上 risk 的 execute 操作）在沙箱不可用时必须被拒绝，禁止自动降级。

### AC-007：Git Worktree 隔离
- **type**: rule
- WorkspaceManager 必须能为工作流创建 Git worktree 隔离工作区，任务结束后清理。
- worktree 路径必须在授权工作区内，禁止路径穿越。
- Git Worktree 只做代码隔离，不替代 OS 级沙箱——执行命令仍须通过 SandboxManager。

### AC-008：资源限制与超时清理
- **type**: rule
- ResourceLimiter 必须对沙箱内命令施加超时（复用 Rust executor timeoutMs）。
- 超时后必须清理进程树（复用 Rust executor kill_tree），不得遗留僵尸进程。
- 临时工作目录在沙箱销毁后必须被清理。

### AC-009：Approval 四级风险
- **type**: rule
- ApprovalPolicy 必须定义 L0（只读）、L1（工作区低风险修改）、L2（敏感操作）、L3（高风险操作）四级。
- 各级别的审批要求：L0 自动放行、L1 可选审批、L2 必须审批、L3 必须人工审批且默认拒绝。
- 风险级别由可信配置决定，模型不可指定或提升。

### AC-010：审批参数绑定与变化检测
- **type**: rule
- ApprovalRequest 必须绑定操作名、参数哈希、目标环境、有效期。
- 参数哈希变化后已有审批自动失效，必须重新审批。
- 审批记录必须持久化到 ApprovalStore（SQLite），包含操作摘要、风险级别、目标环境、申请主体、审批主体、有效期、决策时间。

### AC-011：审批撤销与过期
- **type**: rule
- 支持撤销未使用的审批（状态变为 revoked）。
- 超过有效期的审批自动失效。
- 子代理发起的操作必须经过审批，不得绕过 DelegationManager 的审批检查。

### AC-012：命令拆分绕过防护
- **type**: rule
- 审批参数哈希必须包含完整命令（program + args），拆分命令必须各自独立审批。
- 不允许通过将高风险命令拆分为多个低风险子命令来绕过审批。

### AC-013：Git 操作安全约束
- **type**: rule
- GitService 禁止默认自动合并到受保护分支（main/master/release/*）。
- 禁止默认自动推送代码到远程。
- 禁止自动修改仓库权限或 CI 凭据。
- commit 生成必须经过人工确认（L2 审批）。

### AC-014：CI/CD 集成
- **type**: rubric
- PipelineAdapter 必须支持读取 CI 状态（成功/失败/运行中）和构建日志。
- 测试失败诊断必须能关联到具体测试用例和错误信息。
- GitLab 和 Jenkins 必须支持私有化部署（自定义 baseURL + token）。

### AC-015：Trace 父子关联
- **type**: rule
- TraceManager 必须为每个 Task/Session/Agent/Tool/WorkflowStep 创建 Span。
- 子代理 Span 必须携带 parentAgentId，可追溯到父代理。
- Trace 必须可导出为 JSON。

### AC-016：敏感数据脱敏
- **type**: rule
- 所有日志和 Trace 中的 API Key、Token、密码、敏感环境变量必须脱敏（复用 redactValue）。
- 禁止在审计日志中记录完整密钥。
- 脱敏规则必须可测试（单元测试验证脱敏效果）。

### AC-017：执行报告
- **type**: rubric
- ExecutionReporter 必须生成任务执行报告，包含 Task ID、Session ID、各步骤状态、耗时、Token 消耗、验证结果、审批记录。
- 报告必须可导出为 JSON。

### AC-018：恢复前权限重验
- **type**: rule
- RecoveryManager 在恢复执行前必须重新校验当前权限策略与检查点记录时是否兼容。
- 若权限策略收紧，必须暂停恢复并请求重新审批。
- 恢复前必须校验环境（工作区路径、Git HEAD、关键文件）未发生不兼容变化。

### AC-019：幂等与副作用避免
- **type**: rule
- 每个可重试操作必须定义幂等语义（通过 WorkflowNode.idempotent 字段）。
- 恢复时非幂等操作不可盲目重跑，必须先检查是否已执行。
- 不能假设所有操作都可回滚；不可回滚操作必须在恢复报告中明确标记。

### AC-020：生产回滚独立审批
- **type**: rule
- 生产环境回滚操作必须走独立审批流程（L3），不得复用普通执行审批。
- Git 回滚不能替代数据库或基础设施回滚；恢复报告必须区分已回滚和未回滚的资源。

### AC-021：向后兼容
- **type**: rule
- v0.3.0 全部测试（545 TS + 8 Rust + 65 Benchmark）必须继续通过。
- 不修改现有公共 API 签名；新增模块不影响现有模块加载。
- 旧 ApprovalManager 调用方必须继续工作（兼容包装）。

### AC-022：离线部署
- **type**: rule
- 新增依赖不得引入需要在线下载的运行时资源。
- 所有内置工作流、策略配置、脱敏规则必须内嵌在代码中。
- 不依赖外部 CDN。

## 假设与开放问题

**假设**：
- 运行环境已安装 Git（Git Worktree 功能依赖）；
- Node.js >= 20（node:sqlite 可用）；
- Rust 执行器已编译或可通过 cargo 编译；
- 企业内网有 GitLab/Jenkins 实例（可选，不影响本地 Git 功能）。

**开放问题**：
1. OS 级沙箱在 Linux 上是否需要第一版就实现 bubblewrap 集成？（当前决定：第一版只做能力检测 + 拒绝不可信代码，bubblewrap 集成留到后续版本）
2. ApprovalStore 是否需要与现有 SessionStore 共享 SQLite 数据库？（当前决定：独立数据库文件，避免耦合）
3. CI/CD 适配器是否需要支持 GitHub Actions？（当前决定：GitHub 可选，优先 GitLab + Jenkins + 本地 Git）
