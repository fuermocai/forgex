# ForgeX 项目长期记忆

## 包与发布

- 安装冒烟：`pnpm smoke:npm`（scripts/install-smoke.mjs），CI 见 .github/workflows/package.yml。
  Windows 上脚本必须用 `node npm-cli.js` 直调 npm（.cmd 链路触发 CVE 缓解与用户 reg.exe 黑名单）；
  tar 清单用 `npm pack --dry-run --json`，不要依赖 tar 的 Windows 路径语义。

- **npm 包名 `forgex-agent`，但 CLI 命令 / bin 名是 `forgex`** —— 安装要写
  `npm install -g forgex-agent[@版本]`；写成 `npm install -g forgex` 装的是 npm 上
  另一个人的包（v1.0.0，maintainer `ikaka`），与本项目无关。
- 发布流程：`pnpm build:npm`（tsc → tsup 单文件 bundle → `scripts/prepare-npm.mjs` 生成
  `dist-npm/package.json`）→ `npm publish ./dist-npm --access public`。
- 版本号有**三处**必须同步：根 `package.json`、`apps/cli/package.json`、
  `apps/cli/src/version.ts`（`prepare-npm.mjs` 从 version.ts 读取 VERSION）。
  只改代码不 bump 版本 → 发布报 E403「cannot publish over the previously published versions」。
- `dist-npm/` 在 `.gitignore` 里，是构建产物；发布前务必重新 build，否则会把旧 bundle 发出去
  （0.5.2 就踩过：线上包是几小时前的产物，不含当天的 `/mode` 改动）。
- npm 账号 `fuermocai`，发布需要 2FA：交互式 `npm publish` 会打印
  `Press ENTER to open in the browser`，或改用 `--otp=<动态码>`；非交互环境直接 EOTP 失败。
- tsup 会在仓库根生成 `tsup.npm.config.bundled_*.mjs` 临时文件，已加入 `.gitignore`。
- **tsup 产物会把中文转成 `\uXXXX` 转义**：用 `grep 中文` 检查 bundle 是否含新代码会 0 命中，
  别据此判断"没打进包"；要验就跑 `node dist-npm/main.js` 实际执行，或 grep 英文标识符。

## API Key 存储

- 配置文件只写 `apiKeyEnv`（变量名），不落明文 Key。
- Windows：`/connect`、`/key` 写用户级环境变量（PowerShell 失败时回落凭据文件）。
- Linux/macOS：写 `~/.forgex/credentials.json`（`{keys:{ENV:KEY}}`，强制 0600）；
  `loadConfig` 在环境变量缺失时兜底注入，优先级低于真实 env（`credentialsPath`/`skipCredentials` 可控）。
- `applyApiKey()`（`runtime/api-key.ts`）优先沿用 `ModelConfig.apiKeyEnv`，否则按 baseUrl 反查
  `PROVIDERS` 预设；跨提供方切模型不会沿用旧 Key。

## CLI 权限模式

- 计划模式（plan）与权限模式（readonly/standard/trusted/yolo）是两套东西：
  plan 是开关，进入时把权限强制降到 readonly 并追加系统提示词约束。
- 切换入口：`Shift+Tab` 循环、`/mode [模式|plan|agent]`、`/plan`、`--mode`、`--plan`（CI dry-run）。
- 规则集中在 `apps/cli/src/config/permission-mode.ts`（纯函数，可单测）。

## 中断恢复（--resume / task diagnose|reconcile，v0.5.7）

- 快照 schema v2 带校验（悬空依赖/版本/一致性），load 即验；恢复语义：running/cancelled/failed/blocked 一律人工核对，模型无权标完成，幂等声明不信任。
- `task resume` 委托 `run --resume`；worktree 恢复走归属校验不重建。

## 可审阅 worktree（--worktree，v0.5.6）

- 核心模块 `apps/cli/src/task-run/review-worktree.ts` + `commands/task.ts`（list/show/diff/clean）。
- worktree 是**工作区隔离**，不是 OS 沙箱；文档必须区分。脏仓库拒绝不 stash；clean 四重归属核对。
- 新 SQLite 库必须先用 SessionStore 建 sessions 表再插 task_runs（外键），否则计划前失败无法落库。

## 任务闭环评测（eval/task）

- 单一入口 `pnpm eval:task`；CI 用 `pnpm eval:task:ci`（红线即 exit 1，写 `eval/results/`，
  该目录在 `.gitignore`）。结果 JSON schema `forgex.task-eval/v1`。
- 断言只认外部证据：文件内容、退出码、SQLite（`task_runs`/`step_results`/`gate_results`）、
  审计 JSONL。**永远不要**用模型输出文本做成功判据。
- 加新场景只改 `eval/task/scenarios/*.mjs` 并在 `index.mjs` 登记；harness 不认识具体场景。
- 三类红线：`false_completed` / `forbidden_tool_executed` / `side_effect_after_denial`，
  改动检测逻辑后必须跑 `pnpm eval:task:selftest`。
- `assertCliBuilt()` 会拒绝 dist 早于源码的情况——评测前先 `pnpm build`，否则跑的是旧代码。
- POSIX-only 场景（T06c pty、T07d SIGINT）在 Windows 跳过；它们只在 CI 的 ubuntu job 覆盖，
  **尚未在真实 Linux 上实跑过**（远端 172.16.1.210 当时不可达）。

## 可审阅 worktree（`forgex run --worktree`）

- 只是**工作区隔离**，不是 OS 沙箱。文案/能力报告里不能混用（`forgex sandbox` 分三层讲）。
- 默认 `~/.forgex/worktrees/run-<runId>` + 分支 `forgex/run-<runId>`，基线是创建时的 HEAD；
  根目录可用配置 `worktree.root` 或 `FORGEX_WORKTREE_ROOT` 覆盖。
- 隔离生效靠"把 security.workspaceRoots 收窄到 worktree 再建 runtime"，不要改成在工具层传 cwd，
  否则路径校验/审批/审计会漏。
- 硬约束：仓库脏（含未跟踪文件）拒绝，不 stash/reset；创建失败不回退原地执行；
  不自动合并/复制/删除；`task clean` 前必须核对 路径∈根目录、目录名==run-<runId>、
  `git worktree list` 归属，有未提交产物还要 `--force`。
- 新库先建 SessionStore 再开 TaskRunStore（task_runs 有指向 sessions 的外键）。
- 元数据列：`isolation` / `worktree_root` / `worktree_path` / `worktree_branch` / `base_commit`，
  迁移用 `PRAGMA table_info` 增量 ALTER。


