# ForgeX 架构设计与阶段验收

本文记录 v0.1.0 的架构决策、对原始需求的评审结论、模块依赖、最小可运行闭环，以及每个阶段的验收方式。

## 1. 架构评审：原方案的问题与调整

原始需求的方向是正确的（单 Agent、强安全、证据优先）。在落地时发现以下设计缺陷，已在实现中调整：

| 原设计 | 问题 | 调整 |
| --- | --- | --- |
| Security 放在 Phase 6，而 Phase 5 已实现写文件与执行 | 存在"危险能力先于防护上线"的窗口，阶段测试可能默认放行 | 工具只负责执行体；权限/审批/超时/审计全部集中在 `ToolDispatcher`。Dispatcher 与 Security 同批完成，写/执行在接入前保持禁用 |
| 上下文压缩倾向"LLM 摘要" | 额外模型调用、成本高、破坏 tool_call 配对、离线不可控 | 确定性压缩：先截断工具输出，再按 user 边界删旧轮次，最后强截断/减半；压缩后就地更新历史，保证协议合法 |
| 各工具自行判断权限 | 规则重复、易绕过、无法统一审计 | 所有模型工具调用必须经统一 Dispatcher；工具内的 `CommandGuard.validateStructure` 只是纵深防御 |
| 工具输出"统一结构"但无大小上限 | 大日志会撑爆上下文与内存 | 工具级 `maxOutputBytes` + Dispatcher 二次限流；超限时 `data` 替换为截断预览并标记 `truncated` |
| 审计与会话各自落盘 | 两套写入可能不一致，故障时难以关联 | SQLite 会话库同时实现 `AuditSink`；JSONL 审计文件是附加输出，任一 sink 失败不影响主流程 |
| 一开始就上 Rust Sandbox | 跨语言协议、构建链、离线分发成本高，收益在 MVP 阶段有限 | Rust 只承担"进程执行"这一明确系统职责；Node 执行器保留为默认兜底；通过 `FORGEX_EXECUTOR` / `.forgex/bin` 启用 |
| TUI 直接调用 Agent 内部方法 | UI 与 Runtime 强耦合，难以测试 | Agent 只暴露 `run()` 与 `EventBus`；审批通过 `ApprovalBridge` 解耦，TUI/纯文本复用同一 Runtime |
| 依赖第三方 zod→JSON Schema 转换 | 增加供应链面，离线安装负担 | 自实现 `zodToJsonSchema` 子集（object/string/number/enum/array/union/record 等），只覆盖工具参数所需语法 |
| 只在配置里写 API Key | 密钥易被提交到仓库 | 支持 `apiKeyEnv` 间接引用环境变量；日志/审计统一脱敏，Key 只存在于 Provider 请求头 |
| 假设网关一定支持 SSE | 内网网关常忽略 `stream=true`，直接返回 JSON | Provider 检查 `content-type`，非 `text/event-stream` 时按普通 JSON 解析（已用真实网关行为验证） |

## 2. 模块依赖

依赖方向单向向下，`shared` 不依赖任何业务包：

```
apps/cli
  ├── config/load-config ──► shared
  ├── runtime/create-runtime ──► models / security / tools / core
  └── ui (Ink / plain) ──► core(Agent, EventBus) + shared

core
  ├── agent (Agent, AgentLoop, system-prompt)
  ├── context (ContextManager)
  ├── session (SessionStore, 实现 AuditSink)
  ├── runtime (ToolDispatcher, MetricsCollector)
  └── events (EventBus)
     依赖 ──► models(ModelProvider) / tools(ToolRegistry) / security(Guard/Policy/Approval/Audit) / shared

tools
  ├── registry (ToolRegistry)
  ├── coding / system / execution
  └── 依赖 ──► devops / security(CommandGuard) / shared
       （路径解析通过 ToolContext.workspace 注入，不直接依赖 WorkspaceGuard）

security ──► shared
devops   ──► shared
models   ──► shared
shared   ──► zod（仅类型）
crates/executor ──► serde / serde_json（独立进程，无 TS 依赖）
```

关键接口契约：

- `ModelProvider.chat(request, handlers)`：返回完整 assistant 消息与 usage，支持流式回调与 `AbortSignal`。
- `ToolDefinition.execute(input, ctx)`：只返回 `ToolOutcome`，不抛异常；不自行判断权限。
- `WorkspaceResolver.resolve(target, mode, cwd)`：Security 注入的路径解析器，禁止工具自行拼路径。
- `AuditSink.write(event)`：会话库、JSONL 文件、内存 sink 均实现同一接口。
- `ApprovalHandler(request) => Promise<boolean>`：无 handler 时自动拒绝。

## 3. 最小可运行闭环

```
用户输入
  → CLI 加载配置 / 构建 Runtime
  → Agent.run()
  → AgentLoop: ContextManager.build()（压缩 + 协议修复）
  → Provider.chat()（流式/非流式）
  → 若返回 tool_calls:
       ToolDispatcher.executeMany()
         → Zod 校验 → 路径预解析 → PolicyEngine / CommandGuard
         → allow / ask(审批) / deny
         → 执行（超时、取消、输出限流）
         → 审计 + 事件流
       → 回填 tool 消息（严格按 id 配对）
  → 无 tool_calls：返回最终文本
  → 持久化消息、记录指标、输出事件
```

这个闭环不依赖任何 Demo 数据：模型是真实 HTTP 服务，工具读写真实文件/系统，会话写入真实 SQLite。

## 4. 逐文件实现顺序（实际执行）

### Phase 1 工程基础
`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`tsconfig.build.json`、`vitest.config.ts`、各包 `package.json/tsconfig.json`。

### Phase 2 shared
`types/index.ts` → `errors/index.ts` → `utils/id.ts` → `utils/text.ts` → `utils/tokens.ts` → `utils/redact.ts` → `utils/logger.ts` → `utils/diff.ts` → `utils/protocol.ts` → `utils/zod-schema.ts`。

### Phase 3 models
`types.ts` → `openai-compatible.ts`（SSE 解析、tool_calls 累积、超时/重试/取消、非 SSE 降级） → `index.ts`。

### Phase 4 security
`policy/defaults.ts` → `policy/policy-engine.ts` → `guards/workspace-guard.ts` → `guards/command-guard.ts` → `approval/approval-manager.ts` → `audit/audit-logger.ts` → `index.ts`。

### Phase 5 tools
`registry/tool-registry.ts` → `tool-result.ts` → `execution/process-runner.ts` → `coding/fs-utils.ts` → `coding/read-file.ts` → `coding/list-directory.ts` → `coding/grep-fallback.ts` → `coding/grep-search.ts` → `coding/edit-file.ts` → `coding/git-status.ts` → `coding/git-diff.ts` → 系统工具 → `execution/run-command.ts` → `index.ts`。

### Phase 6 core
`events/event-bus.ts` → `context/context-manager.ts` → `session/session-store.ts` → `runtime/metrics.ts` → `runtime/tool-dispatcher.ts` → `agent/system-prompt.ts` → `agent/agent-loop.ts` → `agent/agent.ts` → `index.ts`。

### Phase 7 devops
`types.ts` → `exec.ts` → `logs.ts` → `linux/{processes,ports,disk,memory}.ts` → `windows/{processes,ports,disk,memory}.ts` → `index.ts`。

### Phase 8 CLI
`args.ts` → `config/load-config.ts` → `runtime/create-runtime.ts` → `ui/approval-bridge.ts` → `ui/plain.ts` → `ui/App.tsx` → `commands/*` → `main.ts`。

### Phase 9 执行器 / 测试 / 基准 / 文档
`crates/executor/src/lib.rs` → `src/main.rs` → `packages/tools/src/execution/executor-client.ts` → `tests/integration/config.test.ts` → `tests/bench/run-bench.mjs` → `docs/*`。

## 5. 阶段验收

| 阶段 | 验收内容 | 对应验证 |
| --- | --- | --- |
| 1 工程 | 严格 TS 构建通过、Rust 可编译 | `pnpm build`、`cargo build` |
| 2 shared | 类型/错误/脱敏/Token/协议校验 | `packages/shared/test/*.test.ts` |
| 3 Provider | 流式增量、tool_calls 累积、超时/重试/取消、Key 不进日志 | `packages/models/test/*.test.ts`（本地假服务） |
| 4 Security | 模式矩阵、路径穿越/符号链接、命令黑名单、审批超时/取消、审计脱敏 | `packages/security/test/security.test.ts` |
| 5 Tools | 真实读写/搜索/编辑/Git/命令执行、超时杀进程树、权限拒绝 | `packages/tools/test/tools.test.ts` |
| 6 Core | 工具闭环、配对完整性、审批拒绝、循环检测、取消、压缩、会话恢复、指标 | `packages/core/test/core.test.ts` |
| 7 DevOps | Windows 真实进程/端口/磁盘/内存/日志读取 | `packages/devops/test/devops.test.ts` |
| 8 CLI | 参数解析、配置优先级、Key 脱敏、doctor 真实检查、TUI 构建 | `tests/integration/config.test.ts` + 手工/脚本验证 |
| 9 执行器 | argv 直执行、超时杀进程树、缺失程序、非法 JSON | `cargo test` |
| 性能 | 完成率、p50/p95、tokens、压缩耗时、版本对比 | `pnpm bench` |

### 验收场景 A–G 对照

- **A 代码理解**：`read_file` / `list_directory` / `grep_search` 真实读取；Agent 结论基于工具结果。
- **B 代码修改**：`edit_file` 精确替换 + diff；默认需审批；文件写入原子化。
- **C 系统诊断**：`inspect_port` / `inspect_process` / `read_logs` 真实调用；Benchmark 中诊断任务要求证据命中。
- **D 安全审批**：非交互环境默认拒绝；`--yes` 才自动批准；策略黑名单先于审批直接拒绝。
- **E 上下文管理**：请求前 `validateMessageProtocol`，异常时本地修复；压缩后 pair 完整；循环检测终止重复调用。
- **F 离线运行**：无 CDN/远程下载；Provider 指向内网或 localhost；依赖已锁定。
- **G 异常恢复**：模型超时/取消、工具失败、审批拒绝都转换为结构化结果；会话消息协议始终合法。

## 6. 设计取舍摘要

1. **单 Agent 优先**：多 Agent 会放大权限、审计与上下文复杂度；MVP 用循环检测与最大迭代保证可控性。
2. **确定性压缩优先**：不引入摘要模型，压缩行为可预测、可测试、离线可复现。
3. **安全集中化**：Dispatcher 是唯一执行入口，避免"某个工具忘了鉴权"。
4. **Rust 克制使用**：只做系统级执行器，保留 Node 兜底，避免为跨语言而跨语言。
5. **只为必要依赖付费**：zod、ink/react、serde；没有 Agent SDK、没有向量数据库、没有在线 CDN。
