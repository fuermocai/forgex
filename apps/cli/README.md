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
# 配置模型 API Key（会做一次连通性测试）
forgex connect

# 在当前目录启动 TUI
forgex
```

首次运行会在 `~/.forgex/config.json` 生成配置。API Key 不写入配置文件，而是保存到环境变量（Windows 用户级环境变量；Unix 会提示 export 命令）。

## TUI 命令

在 TUI 输入框中输入：

| 命令 | 作用 |
| --- | --- |
| `/models` | 切换模型；也支持 `/models deepseek-v4-pro` |
| `/plan` | 进入/退出计划模式：只读分析，不改文件、不执行命令 |
| `/connect` | 配置 Provider、API Key、模型，并测试连通性 |
| `/context` | 查看当前上下文 token 估算 |
| `/session` | 查看当前会话 ID |
| `/help` | 查看帮助 |
| `/exit` | 退出（`/quit` 同义） |

任务运行中按 `Ctrl+C` 取消任务；空闲时按 `Ctrl+C` 退出。审批面板中按 `Ctrl+C` 视为拒绝。

## CLI 子命令

```bash
forgex connect                 # 配置模型连接
forgex                          # 启动 TUI（非 TTY 时自动纯文本模式）
forgex run "检查端口 8080"       # 单次任务
forgex run --json "..."         # JSON 输出
forgex doctor                   # 环境自检
forgex tools                    # 列出内置工具
forgex sessions                 # 查看历史会话
forgex config                   # 查看最终生效配置（Key 脱敏）
```

`forgex run` 支持 `--session <id>` 继续历史会话，`--yes` 跳过审批（仅建议在隔离环境使用）。

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
- 命令白名单不是内核级沙箱；不要在不可信目录中随意授予执行权限。

## 链接

- 仓库：<https://github.com/fuermocai/forgex>
- 问题反馈：<https://github.com/fuermocai/forgex/issues>

## License

MIT
