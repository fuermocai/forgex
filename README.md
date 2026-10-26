# ForgeX

> **v0.5.0 · Autonomous Software Engineer** — 从"会干活的 Agent"升级为**能自主执行完整需求**的软件工程师。

面向企业私有化环境的 Coding + DevOps Agent。TypeScript 负责 Agent Runtime、工具、安全和 **自主执行引擎**，Rust 负责受控命令执行器。零依赖 Agent SDK / Agent Runtime。

---

## 安装

### 方式一：npm 全局安装（推荐）

要求 **Node.js >= 22.13**（CLI 使用内置 `node:sqlite`）。

```bash
npm install -g forgex-agent
forgex --version
```

> `forgex-agent` 是单文件 bundle，运行时只依赖 `ink` / `react` / `ssh2`，不需要克隆仓库。
> 如果该包尚未发布，请使用下面的源码安装。

### 方式二：源码安装

源码安装需要 **Node.js >= 22**、**pnpm >= 9**（没有 pnpm 时安装器会用 corepack 自动启用）。Rust 执行器可选。

#### Windows

```powershell
git clone <仓库地址> E:\ForgeX
cd E:\ForgeX
powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1
```

安装器会做四件事：`pnpm install` → `pnpm build` → 生成 `forgex.cmd` / `forgex.ps1` / `forgex` 启动器 → 把启动器目录加入用户级 PATH。
已装过时自动复用原启动器目录，不会产生两个 `forgex`。

#### macOS / Linux / WSL / Git Bash

```bash
git clone <仓库地址> ~/ForgeX
cd ~/ForgeX
bash scripts/install-cli.sh
# 若提示目录不在 PATH，按提示把 export PATH 写入 ~/.bashrc 或 ~/.zshrc
```

### 验证

```powershell
forgex --version
forgex doctor          # 环境自检
```

### 安装器参数

| 参数 | 作用 |
| --- | --- |
| `-SkipInstall` / `--skip-install` | 跳过依赖安装，只重建启动器 |
| `-SkipBuild` / `--skip-build` | 跳过编译 |
| `-BinDir <目录>` / `FORGEX_BIN_DIR=<目录>` | 指定启动器位置 |
| `-SkipPath` | 不修改 PATH |

> 启动器记录的是仓库绝对路径；仓库移动位置后重新执行一次安装器即可（加 `-SkipInstall` 更快）。
> 升级代码后同样执行 `-SkipBuild:$false` 或直接 `pnpm build`，启动器始终指向 `apps/cli/dist/main.js`。

---

## 快速开始（开发 / 二次开发）

> 只是使用 CLI 的话，上面的「安装」已经完成构建；`forgex connect` 会自动生成配置文件，无需手写。

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

### TUI 内命令

`forgex`（无参数）直接进入 Ink TUI，所有日常操作都在会话内完成：

| 命令 | 作用 |
| --- | --- |
| `/models` | 列出可用模型并切换；`/models deepseek-v4-pro` 直接切 |
| `/plan` | 计划模式开关：权限降为 `readonly` + 系统提示词追加"只输出计划"，退出时还原原权限 |
| `/connect` | 会话内完成 Key 校验 → 持久化到用户环境变量 → 写配置 → 立即生效 |
| `/context` | 当前上下文 token 估算 |
| `/session` | 当前会话 id |
| `/help` `/exit` | 帮助 / 退出 |

模型切换只替换 Provider 与上下文预算，**会话历史、工具注册、权限策略全部保留**；`/connect` 的配置里只写 `apiKeyEnv` 引用，API Key 不明文落盘。

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
Test Files   62 passed
Tests       817 passed    (v0.5.0: 772 → +45)
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
│   ├── tools                         # 工具注册表 + 14 个内置工具
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

## 发布到 npm（维护者）

npm 包名为 `forgex-agent`，发布的是 `dist-npm/` 单文件 bundle，不会发布 `packages/*` 私有包。

```bash
# 1. 登录 npm（当前账号 fuermocai 即可；forgex-agent 是未占用的裸包名，不需要 scope）
npm login
npm whoami

# 2. 本地构建并检查包内容
pnpm pack:npm:dry

# 3. 发布（如开启 2FA，npm 会提示输入 OTP）
pnpm publish:npm
```

版本号唯一来源是 `apps/cli/src/version.ts`，发布前先改这里并提交。`dist-npm/` 与 `*.tgz` 已加入 `.gitignore`。

如果 `forgex-agent` 已被占用，可改用其他包名重新生成：

```powershell
$env:FORGEX_NPM_PACKAGE = "@your-scope/forgex"
pnpm pack:npm:dry
pnpm publish:npm
```

> 项目采用 MIT License，见仓库根目录 `LICENSE`。

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
| **v0.5.0** | **Autonomous Software Engineer** | **817 全绿** | 需求理解 · 自主执行 · 质量门禁 · 多模块协调 · 模型路由 · 工程知识 |
