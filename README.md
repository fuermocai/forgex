# ForgeX

> **v0.5.0 · Autonomous Software Engineer** — 从"会干活的 Agent"升级为**能自主执行完整需求**的软件工程师。

面向企业私有化环境的 Coding + DevOps Agent。TypeScript 负责 Agent Runtime、工具、安全和 **自主执行引擎**，Rust 负责受控命令执行器。零依赖 Agent SDK / Agent Runtime。

---

## 快速开始

前置：**Node.js >= 22**、**pnpm >= 9**。Rust 执行器可选（Rust stable）。

```powershell
# 安装 & 构建 & 测试
pnpm.cmd install --no-frozen-lockfile
pnpm.cmd build
pnpm.cmd test

# Rust 执行器（可选）
cargo build --release --manifest-path crates/executor/Cargo.toml
```

创建 `forgex.config.json`：

```json
{
  "model": {
    "baseUrl": "http://10.0.0.10:8000/v1",
    "apiKeyEnv": "QWEN_API_KEY",
    "model": "qwen2.5-coder-32b-instruct",
    "contextWindow": 32768,
    "maxOutputTokens": 4096,
    "stream": true
  },
  "security": {
    "mode": "standard",
    "workspaceRoots": ["D:/projects/my-service"],
    "requireApprovalForWrite": true,
    "requireApprovalForExecute": true
  },
  "agent": { "maxIterations": 12, "maxConcurrency": 3 }
}
```

启动：

```powershell
node apps/cli/dist/main.js doctor       # 环境自检
node apps/cli/dist/main.js chat          # TUI 会话
node apps/cli/dist/main.js run "为什么 8090 端口无法访问？" --yes
```

---

## v0.5.0 新能力

| Phase | 包 | 能力 | 核心安全约束 |
| --- | --- | --- | --- |
| ① 需求理解 | `@forgex/requirement-engine` | 自然语言 → 结构化需求 → 歧义检测 → 验收标准 → 追溯链 | `ApprovalCriterion.approved` 默认 `false`，模型生成的永远是 draft |
| ② 自主执行 | `@forgex/autonomous` | 5 维预算硬约束（tokens/time/tools/models/steps）→ 长任务 → 检查点暂停/恢复 | 每步检查预算，耗尽立即停；不允许无限循环 |
| ③ 质量门禁 | `@forgex/quality-gate` | TestRunner → StaticAnalyzer → SecurityScanner 三阶段串联 | critical/high 安全漏洞立即阻断；静态分析 error 阻断 |
| ④ 多模块协调 | `@forgex/orchestrator` | 依赖图拓扑排序 + 循环依赖检测 + 分层并行计划 | 有环立即阻断；影响面分析 |
| ⑤ 模型路由 | models 增强 | 能力匹配 + tier 优先 + 健康度降级 + 故障回退 | 能力不匹配 → 明确错误；全失败 → `MODEL_FALLBACK_EXHAUSTED` |
| ⑥ 工程知识 | core 增强 | 结构化工程经验存储 + 生命周期（draft → active → deprecated → archived） | 知识必须 `evidenceRefs.length >= 1`；LLM 推断默认 draft |

### 安全设计（摘要）

```
┌─────────────────────────────────────────────────────────────┐
│                 ForgeX 安全边界：模型不可信                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  · 权限模式  readonly │ standard │ trusted │ yolo           │
│  · 默认最小权限：写/执行需审批，privileged 级默认拒绝         │
│  · 路径必须在 workspaceRoots 内                              │
│  · 命令只接受 program + args[]，禁止 shell 字符串            │
│  · API Key 不进入日志、会话、审计；敏感字段自动脱敏           │
│  · Agent 输出 → ToolDispatcher → Zod → Policy → Approval    │
│                                                             │
│  v0.5.0 新增：                                               │
│  · 验收标准必须用户显式批准（approved=false 默认）           │
│  · 5 维预算硬约束，超预算立即停止                             │
│  · 安全扫描 critical/high 立即阻断交付                       │
│  · 模型能力不匹配不随机选择，明确报错                        │
│  · 工程知识必须有出处（evidenceRefs 强制）                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 架构全景

```
┌──────────────────────────────────────────────────────────────────┐
│                        ForgeX v0.5.0                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─ apps/cli ──────────────────────────────────────────────┐    │
│  │  chat / run / doctor / tools / sessions / config          │    │
│  │  Ink TUI + 纯文本模式                                     │    │
│  └─────────────────────┬───────────────────────────────────┘    │
│                        │                                         │
│  ┌─ packages/core ─────────────────────────────────────────┐    │
│  │  Agent Loop · Task Planner · Sub-Agent Runner             │    │
│  │  Context · Session · Metrics · Event Bus · Memory         │    │
│  │  Engineering Knowledge (v0.5 新增)                        │    │
│  └─────────────────────┬───────────────────────────────────┘    │
│                        │                                         │
│  ┌─ v0.5 新增执行层 ────────────────────────────────────────┐    │
│  │  RequirementEngine → AutonomousRunner → QualityGate      │    │
│  │                              ↑                     ↑     │    │
│  │                    Orchestrator            Model Router   │    │
│  └─────────────────────┬───────────────────────────────────┘    │
│                        │                                         │
│  ┌─ packages/ ──────────────────────────────────────────────┐    │
│  │  shared · models · security · tools · workflows           │    │
│  │  devops · integrations · sandbox · approval · recovery   │    │
│  │  observability                                           │    │
│  └─────────────────────┬───────────────────────────────────┘    │
│                        │                                         │
│  ┌─ crates/executor ────────────────────────────────────────┐    │
│  │  Rust 受控执行器 · argv 直执行 · 超时杀进程树 · 输出上限  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 测试覆盖

```
Test Files   58 passed
Tests       772 passed    (v0.4.0: 693 → +79)
Duration    ~9s
TypeScript  0 errors
```

---

## 目录结构

```
forgex/
├── apps/cli                          # CLI 入口、配置、TUI
├── packages/
│   ├── shared                        # 错误、日志、Token、脱敏、协议
│   ├── models                        # OpenAI-compatible Provider + ModelRouter (v0.5)
│   ├── security                      # Policy / Workspace / Command Guard、审批、审计
│   ├── tools                         # 工具注册表 + 12 个内置工具
│   ├── workflows                     # 状态机、流程注册、checkpoint
│   ├── core                          # Agent Loop / Task Planner / Memory / Sub-Agent / Event Bus / Engineering Knowledge (v0.5)
│   ├── sandbox                       # workspace / resource / capability
│   ├── approval                      # 审批策略、store、审计
│   ├── recovery                      # checkpoint store / verifier / planner / rollback
│   ├── observability                 # audit / metrics / tracing / reports
│   ├── devops                        # Linux/Windows 只读系统诊断、Docker、SSH、K8s
│   ├── integrations                  # GitLab / Jenkins / Git Review / Pipeline
│   ├── requirement-engine  (v0.5 新)  # 需求解析、歧义检测、验收标准、追溯链
│   ├── autonomous          (v0.5 新)  # 预算追踪、长任务执行、检查点恢复
│   ├── quality-gate        (v0.5 新)  # TestRunner / StaticAnalyzer / SecurityScanner 聚合
│   └── orchestrator        (v0.5 新)  # 依赖图拓扑排序、循环检测、分层并行
├── crates/executor                   # Rust 受控执行器
├── tests/                            # integration / security / benchmark
├── benchmark/                        # 可重复基准（coding / devops / security / recovery / ablation）
└── docs/                             # ARCHITECTURE · SECURITY · DEVELOPMENT · RELEASE-v0.5.0
```

---

## 文档

- [v0.5.0 发布说明](docs/RELEASE-v0.5.0.md) ← **推荐从这里开始**
- [安全设计](docs/SECURITY.md)
- [架构设计](docs/ARCHITECTURE.md)
- [开发指南](docs/DEVELOPMENT.md)

---

## 已知限制

- 命令白名单不是内核级沙箱。构建/测试/脚本类命令仍可执行任意代码，只应在隔离环境授予 EXECUTE 权限。
- Rust 执行器是进程树/输出/环境隔离的执行器，不含 namespaces / cgroup / seccomp。
- `node:sqlite` 为 Node 22 实验特性，启动时会打印一次 `ExperimentalWarning`（不影响功能）。
- 未内置树解析（tree-sitter）与向量检索，代码理解以文件 + ripgrep 为主。
- v0.5 的 ModelRouter 和 EngineeringKnowledgeStore 生产适配器（真实 prompt 模板、SQLite WAL 持久化）将在 v0.5.1 交付。

---

## 版本历史

| 版本 | 主题 | 测试 | 核心 |
| --- | --- | --- | --- |
| v0.1.0 | 第一版 | 87 TS + 4 Rust | 模型接入 + Agent Loop + 工具 + 安全层 |
| v0.3.0 | Task Planning + Sub-Agent + Project Memory | — | 计划器、子 Agent、结构化记忆 |
| v0.4.0 | 稳态 | 693 全绿 | 全包构建 + 集成测试 + 基准 |
| **v0.5.0** | **Autonomous Software Engineer** | **772 全绿** | 需求理解 · 自主执行 · 质量门禁 · 多模块协调 · 模型路由 · 工程知识 |
