# ForgeX CLI

TUI-first 的 Coding + DevOps Agent。用自然语言让 Agent 读代码、改代码、跑测试、排查进程/端口/日志，并在执行写操作或命令前请求确认。

## 环境要求

- Node.js **>= 22.13.0**（依赖原生 fetch 与 AbortSignal.any）
- Git（使用 `git_status` / `git_diff` 时需要）
- 可选：ripgrep（`grep_search` 会优先使用；没有则回退到 Node 搜索）

## 安装

```bash
npm install -g forgex-agent
forgex --version
```

## 快速开始

```bash
# 方式一：直接启动。首次运行会自动进入连接向导（provider → baseUrl → API Key → model）
forgex

# 方式二：先单独配置，会做一次连通性测试
forgex connect
```

首次运行会在 `~/.forgex/config.json` 生成配置。API Key 不写入配置文件，而是保存到环境变量（Windows 用户级环境变量；Unix 会提示 export 命令）。

如果只想用环境变量，也可以完全不建配置文件——启动时会按 Key 自动识别 Provider：

```bash
export DEEPSEEK_API_KEY=sk-xxx   # 自动使用 https://api.deepseek.com + deepseek-flash
forgex

# 也支持 DASHSCOPE_API_KEY / OPENAI_API_KEY
# 自定义端点仍用 FORGEX_BASE_URL / FORGEX_MODEL / FORGEX_API_KEY（或 forgex connect）
```


## TUI 命令

在 TUI 输入框中输入：

| 命令 | 作用 |
| --- | --- |
| `/models` | 查看已配置模型、切换任务角色或检查连通性 |
| `/models role <角色> [model-id]` | 切换 default/cheap/reasoning/coding/vision 角色 |
| `/models check <model-id>` | 检查凭据并测试模型连通性 |
| `/mode [模式]` | 查看/切换权限模式（readonly / standard / trusted / yolo），`Shift+Tab` 循环 |
| `/plan` | 进入/退出计划模式：只读分析，不改文件、不执行命令 |
| `/connect` | 配置 Provider、API Key、模型，并测试连通性 |
| `/key <API Key>` | 保存 API Key（持久化到凭据文件，重开会话仍可用） |
| `/context` | 查看当前上下文 token 估算 |
| `/session` | 查看当前会话 ID |
| `/workers`、`/worker <id>` | 查看本地 worker 状态、资源用量和摘要 |
| `/steer <id> <指令>`、`/cancel-worker <id>` | 指引或取消运行中的 worker |
| `/retry-worker <id>`、`/wait-worker <id>` | 重试或等待 worker |
| `/memory ...` | 查看、搜索、修改、导出和审核项目记忆 |
| `/help` | 查看帮助 |
| `/exit` | 退出（`/quit` 同义） |

任务运行中按 `Ctrl+C` 取消任务；空闲时按 `Ctrl+C` 退出。审批面板中按 `Ctrl+C` 视为拒绝。

输入框编辑：`←`/`→` 移动光标，`Backspace`/`Delete` 删除光标前一个字符，`Ctrl+A`/`Ctrl+E` 跳到行首/行尾，`Ctrl+U` 清空整行。

## CLI 子命令

```bash
forgex connect                 # 配置模型连接
forgex                          # 启动 TUI（非 TTY 时自动纯文本模式）
forgex run "检查端口 8080"       # 单次任务
forgex run --json "..."         # JSON 输出
forgex run "修复空指针" --worktree  # 在独立 Git worktree + 分支中执行，产物可审阅
forgex task list|show|diff|clean  # 审阅/清理 worktree 任务产物
forgex workflows                 # 列出内置工作流
forgex workflows feature-dev     # 查看工作流阶段
forgex run "实现功能" --workflow feature-dev --requirements
forgex sandbox                  # 查看沙箱能力（区分工作区隔离 / 资源限制 / OS 级隔离）
forgex doctor                   # 环境自检
forgex tools                    # 列出内置工具
forgex sessions                 # 查看历史会话
forgex config                   # 查看最终生效配置（Key 脱敏）
```

`forgex run` 支持 `--session <id>` 继续历史会话，`--yes` 跳过审批（仅建议在隔离环境使用）。
任务闭环会生成计划、逐步执行并运行项目质量门禁（如 `npm test`），最终状态以 JSON 输出与
`forgex task list` 为准：`completed` / `unverified` / `failed` 等；`unverified` 表示项目没有可运行的
门禁命令，不能当作验证通过。
`--worktree` 只隔离工作区与改动（独立 worktree + 分支，产物用 `forgex task diff` 审阅），
仓库有未提交改动时会直接拒绝，不会 stash/reset。
`delegate_task` 只在实际会话运行时注册；静态 `forgex tools` 清单不会列出没有执行器的动态工具。会话式 Agent 可一次提交多个独立任务，每个子 Agent 从派发时的 Git 快照创建单独 worktree，完成后返回状态、改动路径和 patch 预览；patch 完整文件默认保存在 `.forgex/subagents/`（与事件日志同目录），不会自动合并回父工作区。父工作区可以有未提交和未跟踪改动，所有 worker 共用同一派发基线。文件工具的读写根限制为 worker 自己的 worktree；命令仍走当前执行策略与审批，worktree 不会限制进程访问外部文件或网络。

父 Agent 对 `delegate_task` 的审批通过后，worker 使用内部 `yolo` 权限模式，不再逐项弹出写入/命令审批。CommandGuard/PolicyEngine 硬拒绝规则以及文件工具的保护路径和 WorkspaceGuard 检查仍然生效；命令进程仍可能访问 worker 目录之外的文件或网络，请只委派可信任务。

子 Agent 并发通过 `agent.subagentMaxConcurrency` 配置，默认 `3`，可设为 `0` 表示不设并发上限；最大配置值为 `32`。子 Agent 不会继续派生子 Agent。包含 Git 子模块或配置了外部 Git clean/smudge/process filter 的仓库会拒绝派发，避免生成不完整快照或运行仓库配置的外部程序。Git worktree 只隔离工作目录，不是 OS 沙箱，也不限制进程访问工作区以外的文件或网络。
`forgex workflows [<id>]` 可查看内置工作流。`run --workflow <id>` 会把所选工作流阶段作为任务规划提示；任务仍由现有计划执行器和质量门禁负责。`run --requirements` 根据计划生成需求分析与验收标准草案，并将追踪记录写入事件日志；模型生成的验收标准全部标记为未批准，不会伪装成用户确认，也不会阻止当前任务执行。

## 配置

默认路径：`~/.forgex/config.json`

```json
{
  "model": {
    "baseUrl": "https://api.deepseek.com",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "model": "deepseek-flash",
    "contextWindow": 1000000,
    "maxOutputTokens": 8192
  }
}
```

支持 OpenAI-compatible Chat Completions 接口；目前不会将兼容端点冒充为原生 Provider。Provider 预设见 `forgex connect`。多个模型可在 `models` 中配置，并通过 `modelRoles` 为不同任务指定模型：

```json
{
  "models": [
    {
      "id": "main",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "FORGEX_API_KEY",
      "model": "coding-model",
      "contextWindow": 128000,
      "maxOutputTokens": 8192,
      "capabilities": ["chat", "coding", "reasoning"],
      "costTier": 3,
      "speedTier": 3
    }
  ],
  "modelRoles": {
    "default": "main",
    "coding": "main",
    "reasoning": "main"
  }
}
```

旧式 `model` 配置仍然可用。`/models check <model-id>` 可在实际任务前检查连通性；凭据只从指定环境变量或现有凭据文件读取。

### Worker Hub 与 Advisor

父 Agent 可将独立任务派发给本地 worker。每个 worker 在隔离 Git worktree 中运行，Hub 提供状态、进度、用量、摘要和 transcript 查看，以及 steer/cancel/retry/wait 控制；产物需要审阅，不会自动合并。Hub 仅管理本地父子 Agent，不提供远程实时共享会话。

Advisor 默认关闭。启用后可按轮检查计划、工具调用、工具结果和最终答复，输出提醒或阻塞意见；Advisor 失败或超时不会阻塞主 Agent。可用 `advisor.modelId` 指定已配置模型，否则使用 reasoning 角色或默认模型。

### 项目记忆

项目记忆默认开启，按工作区隔离，默认写入启动目录下的 `.forgex/memory.jsonl`。设置 `memory.enabled` 为 `false` 可完全关闭记忆读写；`autoRecall` 可单独关闭召回，`autoSave` 默认关闭。以 `记住：...` 或 `remember: ...` 开头的明确陈述会生成待审核候选，不会直接成为长期记忆。审核命令：

```text
/memory candidates
/memory approve <candidate-id>
/memory reject <candidate-id>
```

`/memory list|search|show|edit|forget|export` 用于管理当前工作区的记忆；`/memory clear confirm` 软删除当前工作区活动记忆并保留历史。修正会创建新版本并标记旧版本为 superseded。敏感内容会被过滤，写入会保留来源和证据引用。

### 编码与外部工具

- LSP 支持诊断、符号、定义、引用、hover、code actions 和 rename；WorkspaceEdit 先显示逐文件 diff，再由独立写入工具申请审批后应用。
- 可配置持久 Python/JavaScript 会话和 DAP adapter；每次执行/调试操作需审批，输出限长。它们以 ForgeX 当前 OS 用户权限运行，不是 OS 沙箱。
- `web_search` 使用 DuckDuckGo，`github_query` 只读查询 GitHub API。浏览器自动化默认关闭；启用时要求配置浏览器和精确主机 allowlist，使用无凭据临时 profile，每次操作都需审批。
- 高风险工具的完整审批预览必须可核对；预览过长或需要脱敏时会拒绝操作。

## 安全说明

- 写文件、执行命令默认需要人工审批。
- 审计日志写入 `~/.forgex/audit.jsonl`，敏感字段会脱敏。
- 会话、审计、指标与任务状态默认保存在当前工作区的 `.forgex/events.jsonl`。
- 临时目录 / Git worktree 只隔离文件视图；Rust 执行器只提供超时、输出限额与进程树清理——
  都**不是** OS 沙箱。OS 级隔离（bubblewrap）目前仅 Linux 可用，需通过启动探针验证；
  其它平台或验证失败时，不可信代码执行（`trustLevel: untrusted`）一律拒绝，不降级、不静默裸跑。
- 命令白名单不是内核级沙箱；不要在不可信目录中随意授予执行权限。

## 链接

- 仓库：<https://github.com/fuermocai/forgex>
- 问题反馈：<https://github.com/fuermocai/forgex/issues>

## License

MIT
