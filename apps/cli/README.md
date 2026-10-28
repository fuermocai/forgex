# ForgeX CLI

TUI-first 的 Coding + DevOps Agent。用自然语言让 Agent 读代码、改代码、跑测试、排查进程/端口/日志，并在执行写操作或命令前请求确认。

## 环境要求

- Node.js **>= 22.13.0**（依赖内置 `node:sqlite`）
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
| `/models` | 切换模型；也支持 `/models deepseek-v4-pro` |
| `/mode [模式]` | 查看/切换权限模式（readonly / standard / trusted / yolo），`Shift+Tab` 循环 |
| `/plan` | 进入/退出计划模式：只读分析，不改文件、不执行命令 |
| `/connect` | 配置 Provider、API Key、模型，并测试连通性 |
| `/key <API Key>` | 保存 API Key（持久化到凭据文件，重开会话仍可用） |
| `/context` | 查看当前上下文 token 估算 |
| `/session` | 查看当前会话 ID |
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

支持任意 OpenAI-compatible 接口；Provider 预设见 `forgex connect`。

## 安全说明

- 写文件、执行命令默认需要人工审批。
- 审计日志写入 `~/.forgex/audit.jsonl`，敏感字段会脱敏。
- 会话保存在 `~/.forgex/sessions.db`。
- 临时目录 / Git worktree 只隔离文件视图；Rust 执行器只提供超时、输出限额与进程树清理——
  都**不是** OS 沙箱。OS 级隔离（bubblewrap）目前仅 Linux 可用，需通过启动探针验证；
  其它平台或验证失败时，不可信代码执行（`trustLevel: untrusted`）一律拒绝，不降级、不静默裸跑。
- 命令白名单不是内核级沙箱；不要在不可信目录中随意授予执行权限。

## 链接

- 仓库：<https://github.com/fuermocai/forgex>
- 问题反馈：<https://github.com/fuermocai/forgex/issues>

## License

MIT
