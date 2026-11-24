# ForgeX

> **ForgeX · Coding + DevOps Agent** — 面向本地工作区和私有模型服务的可控开发助手。

当前 CLI 的稳定路径是会话式 Agent：模型调用工具、工具经统一权限与审计链执行，Agent 在没有后续工具调用时结束本轮。仓库还包含需求分析、任务编排和质量门禁等独立模块；它们尚未组成 CLI 的端到端自主执行流程。TypeScript 负责 Agent Runtime、工具和安全策略，Rust 提供可选的受控命令执行器。

---

## 安装

### 方式一：npm 全局安装（推荐）

要求 **Node.js >= 22.13**（CLI 使用原生 fetch 与 AbortSignal.any）。

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
forgex doctor          # 环境自检（--full 会打印沙箱能力明细）
forgex sandbox         # 沙箱能力：工作区隔离 / 资源限制 / OS 级隔离
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

### ForgeX 桌面客户端（预览）

桌面端目前提供 Windows x64 安装包，复用 ForgeX Agent Runtime、项目权限边界和会话存储。需要 Node.js >= 22 与 pnpm >= 9：

```powershell
pnpm install
pnpm desktop:dev                 # 本地开发
pnpm desktop:package:win         # 构建 Windows 安装包
```

安装包输出到 `apps/desktop/release/`。桌面端仍在预览阶段；CLI 是当前稳定使用方式。

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
  "agent": { "maxConcurrency": 3, "subagentMaxConcurrency": 3 }
}
```

`subagentMaxConcurrency` 控制 `delegate_task` 的并发数，默认 `3`，最大 `32`；设为 `0` 表示不设并发上限。`delegate_task` 为每项工作创建基于派发时 Git 快照的独立 worktree，返回 patch 预览并将完整 patch 默认保存在 `.forgex/subagents/`（与事件日志同目录），不会自动合并。Git worktree 仅隔离工作目录，不是 OS 沙箱。

本地 Agent Hub 可在父任务运行时用 `/workers` 查看 worker 状态和用量；`/worker <id>` 查看摘要，只有显式加 `transcript` 才会读取并显示完整对话。`/steer <id> <指令>`、`/cancel-worker <id>`、`/retry-worker <id>` 与 `/wait-worker <id>` 控制当前会话的 worker。重试会创建新的 attempt 和隔离 worktree，产物仍需人工审阅。

Advisor 默认关闭。启用后可在每轮检查 Agent 的方案、工具调用、工具结果和最终答复；只提供只读意见，超时或模型输出无效时发出提醒并继续。可指定 `modelId`，或使用 `reasoning` 角色模型：

```json
{
  "advisor": {
    "enabled": true,
    "modelId": "reasoner",
    "stages": ["plan", "tools", "results", "final"],
    "timeoutMs": 5000,
    "maxChecksPerTurn": 4,
    "maxInterventionsPerTurn": 1
  }
}
```

`modelId` 必须指向已配置的模型；省略时优先使用 reasoning 角色/能力模型，找不到时回退到当前默认模型。Advisor 不会收到工具声明，也不能更改路由或控制 worker。

项目记忆默认开启并按授权工作区隔离，默认文件是 ForgeX 启动目录下的 `.forgex/memory.jsonl`；设置 `memory.enabled=false` 可完全关闭并且不读写记忆文件，召回可以单独关闭，自动保存默认关闭。会话中以 `记住：...` 或 `remember: ...` 开头的明确陈述会在轮次结束时进入待审核候选，不会直接进入长期记忆。`autoSave` 设为 `true` 也会逐条请求审批：

```json
{
  "memory": {
    "enabled": true,
    "path": ".forgex/memory.jsonl",
    "autoRecall": true,
    "autoSave": false
  }
}
```

用 `/memory candidates` 检查候选，再用 `/memory approve <id>` 或 `/memory reject <id>`；`/memory list|search|show|edit|forget|export` 用于管理、纠正并导出当前工作区记忆。纠正会新建版本并将旧条目标记为 superseded。`/memory clear confirm` 会软删除当前工作区全部活动记忆，保留历史版本以便审计。当前没有按时间自动清除策略；`forget` 与 `clear` 都只软删除。若要物理删除全部记忆及历史，在 ForgeX 停止后删除配置指定的 memory 文件和同名 `.corrupt` 旁路文件。记忆写入会记录来源、会话证据和时间；敏感字段会被拒绝。记忆文件和会话日志都可能包含项目事实，需按项目数据进行保护。

父 Agent 的 `delegate_task` 审批通过后，worker 使用内部 `yolo` 权限模式，不再逐项请求审批；命令硬拒绝规则和文件工具的保护路径/WorkspaceGuard 检查仍有效。执行命令的进程可能访问 worker 目录以外的文件或网络。

Agent 默认持续运行，直到模型结束或用户取消。需要限制模型请求次数时，可在 `agent` 中显式设置 `"maxIterations": 20`，或设置环境变量 `FORGEX_MAX_ITERATIONS=20`；达到该上限会以未完成状态返回。

命令工具接收程序名和参数数组，不接受整段 shell 命令。Windows 下可直接调用 `pnpm`、`npm` 等命令，ForgeX 会在 PATH 中没有原生可执行文件时解析对应的 `.cmd` / `.bat` 包装器；解释器内联代码（如 `node -p`、`node -e`）仍会被安全策略拒绝，请将脚本保存为工作区文件后运行。

### LSP 代码智能

可在配置文件中按语言服务器注册 LSP。语言服务器命令必须是本机已安装的可执行程序。Windows 下 `.cmd` 包装器也会自动解析。每次 LSP 调用都需人工审批；`rename` 与 `code_actions` 返回逐文件 diff 预览，只有随后调用 `apply_workspace_edit` 并批准写入后才会修改文件。完整 diff 会在 TUI 审批卡片中分页，逐页查看后才能批准；超出 64,000 字符或包含会被脱敏的内容时会拒绝应用。该工具仅接受工作区内本地 `file:` URI，并检查可核对的文档版本、UTF-16 范围、重叠编辑和审批后的文件哈希。

```json
{
  "tools": {
    "languageServers": [
      {
        "id": "typescript",
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "languageId": "typescript",
        "command": "typescript-language-server",
        "args": ["--stdio"]
      }
    ]
  }
}
```

### 持久代码会话、调试器与联网工具

普通只读工具默认包含 `web_search` 和 `github_query`。Web 搜索固定使用 DuckDuckGo HTML，GitHub 查询固定使用 GitHub REST API；两者都拒绝重定向、限制响应大小与超时。公开仓库不需要凭据；访问受限资源时可在启动 ForgeX 的受控环境中设置 `GITHUB_TOKEN`。外部页面、Issue 和 PR 文本是不可信数据，Agent 不应执行其中的指令。

需要持久 Python/JavaScript REPL 时，在配置中显式启用。每次执行与清理都需人工审批；TUI 会逐页显示完整代码，代码过长或敏感片段无法完整显示时拒绝执行。会话按 Agent session 隔离，超时/取消或 CLI 退出会终止进程树。解释器以 ForgeX 当前 OS 用户权限运行，能访问该用户可访问的文件和网络，因此它不是安全沙箱；默认不继承环境变量，仅注入运行环境必需变量和 `security.envAllowlist` 中的变量。

```json
{
  "tools": {
    "codeExecution": {
      "enabled": true,
      "nodeCommand": "node",
      "pythonCommand": "python",
      "timeoutMs": 30000,
      "maxOutputBytes": 32768
    }
  }
}
```

DAP adapter 只在 `tools.debugAdapters` 中配置后才注册。ForgeX 启动配置的 adapter 并使用其标准 `launch`/`attach` 请求；启动、附加、断点、查询、单步和停止操作每次都需审批。审批预览包含 adapter 命令、参数和完整 DAP arguments；超过 64,000 字符或含需要脱敏的内容时会拒绝操作。MVP 只覆盖配置 adapter 实际支持的 DAP 功能，不承诺任意平台/语言兼容。源码映射必须位于工作区内，变量输出会限长并脱敏。

```json
{
  "tools": {
    "debugAdapters": [
      {
        "id": "debugpy",
        "extensions": [".py"],
        "command": "python",
        "args": ["-m", "debugpy.adapter"],
        "launchArgs": {},
        "attachArgs": {}
      }
    ]
  }
}
```

浏览器自动化默认关闭。启用时必须配置浏览器可执行文件和**精确主机名** allowlist（不支持通配符）；ForgeX 为每个 Agent session 创建临时 profile，并在 browser target 与其新页面、弹窗、iframe 和 worker 开始运行前启用逐请求主机拦截。无法附加或安装网络策略的 target 会被关闭。所有导航、读取、点击、填写和清理动作都需审批；审批卡片显示已验证的当前页面 URL，填写动作显示完整输入，无法完整显示或含需要脱敏的内容时会拒绝执行。浏览器不载入用户保存的凭据，并拒绝密码输入框。网站仍可能在 allowlist 主机上执行自己的脚本或产生副作用，批准前请检查目标 URL 与动作。

```json
{
  "tools": {
    "browserAutomation": {
      "enabled": true,
      "command": "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "allowedHosts": ["developer.mozilla.org", "github.com"],
      "timeoutMs": 20000
    }
  }
}
```

启动：

```powershell
node apps/cli/dist/main.js doctor       # 环境自检
node apps/cli/dist/main.js chat          # TUI 会话
node apps/cli/dist/main.js run "为什么 8090 端口无法访问？" --yes
```

### 可审阅的隔离执行（`--worktree`，v0.5.6）

编码任务可以放进独立 Git worktree + 独立分支执行，产物先审阅、再决定怎么用。**默认行为不变**（原地执行），
`--worktree` 是显式 opt-in。

```powershell
node apps/cli/dist/main.js run "修复登录接口的空指针" --worktree
# 结束时打印 worktree 路径 / 分支 / 审阅与清理入口

node apps/cli/dist/main.js task list                        # 列出任务与产物位置
node apps/cli/dist/main.js task diff run_ab12cd34           # 变更文件 + 状态 + diff 统计
node apps/cli/dist/main.js task diff run_ab12cd34 --patch   # 完整补丁（超长会截断）
node apps/cli/dist/main.js task clean run_ab12cd34          # 显式清理（有未提交产物需 --force）
```

| 保证 | 说明 |
| --- | --- |
| 只隔离工作区与改动 | 进程仍是普通进程：能读 worktree 之外的文件、能联网。**不是** OS 沙箱 |
| 不碰你的未提交改动 | 仓库脏（含未跟踪文件）时直接拒绝，不 stash / 不 reset / 不移动文件，也不退化成原地执行 |
| 不自动合并、不自动删除 | 成功、失败、取消都保留 worktree 与分支；是否合并、何时删除由 `forgex task clean` 决定 |
| 权限与审计跟着生效工作区走 | 运行时 `workspaceRoots` 收窄到该 worktree，路径校验 / 审批 / 审计都按新路径生效 |
| 可查询映射 | `task_runs` 记录 runId ↔ worktree 路径 / 分支 / 基线 commit |

worktree 默认落在 `~/.forgex/worktrees`，可用配置 `worktree.root` 或环境变量 `FORGEX_WORKTREE_ROOT` 改。

### 中断诊断与安全恢复（v0.5.7）

进程退出或机器重启后，任务停在哪儿、哪些能继续、哪些必须人工确认，都有明确答案：

```powershell
node apps/cli/dist/main.js task diagnose run_ab12cd34        # 停在哪、每步分类、下一步动作
node apps/cli/dist/main.js task reconcile run_ab12cd34       # 待核对步骤：原因/工具/验收规则/下游影响
node apps/cli/dist/main.js task reconcile run_ab12cd34 --step step_x1 --confirm-done --note "文件确实已改"
node apps/cli/dist/main.js task reconcile run_ab12cd34 --step step_x1 --confirm-retry       # 确认外部状态后允许重试
node apps/cli/dist/main.js task resume run_ab12cd34          # 安全恢复（前置校验不通过会拒绝并给出诊断）
```

| 恢复语义 | 说明 |
| --- | --- |
| 自动继续 | 只有**从未开始**的步骤；已完成且验收通过的步骤直接跳过 |
| 必须人工核对 | 中断时 `running` 的步骤（副作用结果未知）、声称完成但验收证据缺失的步骤、被取消/失败的步骤——模型**无权**替你把这些标成"完成" |
| 快照即事实 | 计划完整快照（步骤/依赖/验收规则/状态）在每个状态变化时追加到 JSONL 事件流，带 schema 版本；损坏或旧版本快照拒绝恢复并给出诊断 |
| worktree 不猜测 | 恢复时校验 worktree 存在、目录名与 runId 匹配、路径归属；异常时拒绝恢复，不重建、不删除 |

### TUI 内命令

`forgex`（无参数）直接进入 Ink TUI，所有日常操作都在会话内完成：

| 命令 | 作用 |
| --- | --- |
| `/models` | 列出可用模型并切换；`/models deepseek-v4-pro` 直接切（没有配置文件时自动创建 `~/.forgex/config.json`） |
| `/key` | 填写/替换 API Key：`/key` 进入隐藏输入（`•` 掩码，回车确认 / Esc 取消），`/key sk-xxx` 一步到位；两种情况都会立即做一次连通性校验 |
| `/mode` | 查看/切换权限模式：`/mode trusted`、`/mode plan`（进计划模式）、`/mode agent`（退出计划模式）；`Shift+Tab` 也可循环切换 |
| `/plan` | 计划模式开关：权限降为 `readonly` + 系统提示词追加"只输出计划"，退出时还原原权限 |
| `/connect` | 会话内完成 Key 校验 → 持久化 → 写配置 → 立即生效（完整向导） |
| `/context` | 当前上下文 token 估算 |
| `/session` | 当前会话 id |
| `/help` `/exit` | 帮助 / 退出 |

命令行侧对应 `--mode <readonly\|standard\|trusted\|yolo>`（优先级高于配置文件与环境变量）和 `--plan`（只读对话模式；模型按提示草拟建议，不创建或持久化可执行步骤计划）。

模型切换只替换 Provider 与上下文预算，**会话历史、工具注册、权限策略全部保留**；配置里只写 `apiKeyEnv` 引用，`forgex.config.json` 里不出现明文 Key。

Key 的落盘位置在三个平台统一为 `~/.forgex/credentials.json`（权限 `600`），启动时由 `loadConfig` 在环境变量缺失时兜底注入——填一次，之后每次启动（包括同一终端里重开）都能直接用。不再额外写 Windows 用户环境变量：那种写法只对新开的终端生效，同一窗口里重开会表现为"Key 又没了"。真环境变量的优先级始终高于凭据文件。

---

## 能力与成熟度

以下区分 CLI 用户现在能直接使用的能力与仓库内的独立模块，避免把尚未接入的模块当作产品闭环。

| 范围 | 包 | 能力 | 当前状态 |
| --- | --- | --- | --- |
| CLI 主路径 | `apps/cli` + `@forgex/core` | chat/run、会话、工具调用、权限审批、上下文与结果状态 | 可直接使用 |
| CLI 安全链 | `@forgex/security` + `@forgex/tools` | 工作区边界、命令策略、审批、审计、工具输出限额 | CLI 主路径使用 |
| 可审阅隔离 | `apps/cli` | `run --worktree` + `task list/diff/clean`：独立 worktree/分支、产物审阅、显式清理 | 可直接使用（仅工作区隔离，非 OS 沙箱） |
| 沙箱隔离 | `@forgex/sandbox` | 工作区隔离（temp dir / worktree）、资源限制、Linux bubblewrap、macOS Seatbelt、Windows WSL 2 bubblewrap | OS 沙箱需平台后端探针通过；Windows 仅支持 WSL 中的 Linux 命令，其余情况拒绝 untrusted |
| 需求分析 | `@forgex/requirement-engine` | 结构化需求、歧义和验收标准 | 独立模块，未接入 CLI 任务流 |
| 自主执行 | `@forgex/autonomous` | 预算和步骤执行抽象 | 实验性模块；没有 CLI 生产执行器 |
| 质量门禁 | `@forgex/quality-gate` | 可注入的测试、静态分析和安全扫描阶段 | 独立抽象；未接入 CLI，需配置实际执行器 |
| 多模块协调 | `@forgex/orchestrator` | 依赖图与执行分层 | 独立模块，未接入 CLI 任务流 |
| 模型路由 / 工程知识 | `@forgex/models` / `@forgex/core` | 路由、知识存储等扩展能力 | 独立模块，未接入 CLI 默认运行时 |
| 持久化审批引擎 | `@forgex/approval` | 风险级别、参数哈希和审批记录 | 独立模块；CLI 当前仍使用 `@forgex/security` 的旧审批实现 |

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
│  · 隔离分三层：工作区隔离 / 资源限制 / Linux/macOS/WSL OS 沙箱 │
│  · untrusted 只能走 OS 沙箱；不可用即拒绝，绝不降级裸跑        │
│  · Agent 输出 → ToolDispatcher → Zod → Policy → Approval    │
│                                                             │
│  · 高级任务模块尚未接入 CLI 主执行路径                        │
│  · 质量门禁必须显式配置执行器；空配置不会视为通过             │
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
│  │  Agent Loop · Context · Session · Metrics · Event Bus     │    │
│  │  Task Planner / Sub-Agent / Memory (可组合模块)            │    │
│  └─────────────────────┬───────────────────────────────────┘    │
│                        │                                         │
│  ┌─ 独立扩展模块（当前不在 CLI 主路径）──────────────────────┐    │
│  │  RequirementEngine · Autonomous · QualityGate             │    │
│  │  Orchestrator · Recovery · Integrations                  │    │
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

### v0.5.0 发布时的验证快照

以下数字是 v0.5.0 发布记录，不代表当前工作树已重新验证。

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
│   ├── tools                         # 工具注册表 + 内置工具（delegate_task 在会话运行时注入）
│   ├── workflows                     # 状态机、流程注册、checkpoint
│   ├── core                          # Agent Loop / Task Planner / Memory / Sub-Agent / Event Bus / Engineering Knowledge (v0.5)
│   ├── sandbox                       # workspace / resource / capability
│   ├── approval                      # 审批策略、store、审计
│   ├── recovery                      # checkpoint store / verifier / planner / rollback
│   ├── observability                 # audit / metrics / tracing / reports
│   ├── devops                        # Linux/Windows 只读系统诊断、Docker、SSH、K8s
│   ├── integrations                  # GitLab / Jenkins / Git Review / Pipeline
│   ├── requirement-engine  (v0.5 新)  # 需求解析、歧义检测、验收标准、追溯链
│   ├── autonomous          (实验性)    # 注入式步骤执行与预算钩子；尚未接入 CLI
│   ├── quality-gate        (v0.5 新)  # TestRunner / StaticAnalyzer / SecurityScanner 聚合
│   └── orchestrator        (v0.5 新)  # 依赖图拓扑排序、循环检测、分层并行
├── crates/executor                   # Rust 受控执行器
├── tests/                            # integration / security / benchmark
├── benchmark/                        # 可重复基准（coding / devops / security / recovery / ablation）
├── eval/task/                        # `forgex run` 任务闭环评测（离线、可进 CI）
└── docs/                             # ARCHITECTURE · SECURITY · DEVELOPMENT · RELEASE-v0.5.0
```

### 任务闭环评测

`pnpm eval:task` 在临时 Git 仓库里跑**真实 CLI**（本地假模型、零网络、零付费），
判断"任务是否真的完成、状态是否报得对"——只看文件、退出码、JSONL 事件记录与审计日志，
不看模型自述。21 个场景覆盖计划校验、审批拒绝、超时/截断/取消、中断不重放、prompt injection
与质量门禁取证；误报 completed、越权工具调用、拒绝后仍产生副作用会直接让 CI 失败。

详见 [eval/task/README.md](eval/task/README.md)。

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
- 三层能力不可互换：临时目录 / Git worktree 只隔离文件视图；Rust 执行器只提供超时、输出限额与进程树清理（无 namespaces / cgroup / seccomp）。
- `--worktree` 只隔离工作区与改动，**不**限制文件读取范围与网络，也不是 `trustLevel: untrusted` 的实现途径。
  已知边界：仓库必须至少有一次提交；子模块 / sparse-checkout 未覆盖；Windows 下若 `core.autocrlf=true`，
  worktree 内的文件是 CRLF（`git` 的 diff 结论正确，但字节与源文件不同）。
- OS 级沙箱通过平台后端提供：Linux bubblewrap、macOS Seatbelt、Windows WSL 2 bubblewrap；均必须通过真实探针。Windows 后端只执行 WSL 内的 Linux 命令，需要 WSL 2 发行版安装 bubblewrap 和对应 Linux 工具链。详情见 `docs/SECURITY.md` 第 8 节。
- 未内置树解析（tree-sitter）与向量检索，代码理解以文件 + ripgrep 为主。
- v0.5 的 ModelRouter 和 EngineeringKnowledgeStore 生产适配器（真实 prompt 模板、JSONL 持久化）将在 v0.5.1 交付。

---

## 版本历史

| 版本 | 主题 | 测试 | 核心 |
| --- | --- | --- | --- |
| v0.1.0 | 第一版 | 87 TS + 4 Rust | 模型接入 + Agent Loop + 工具 + 安全层 |
| v0.3.0 | Task Planning + Sub-Agent + Project Memory | — | 计划器、子 Agent、结构化记忆 |
| v0.4.0 | 稳态 | 693 全绿 | 全包构建 + 集成测试 + 基准 |
| **v0.5.0** | **模块扩展（部分未接 CLI）** | **发布时 817 项通过** | 需求分析 · 自主执行原语 · 质量门禁接口 · 多模块协调 · 模型路由 · 工程知识 |
