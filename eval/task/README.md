# forgex run 任务闭环评测

判断标准只有一条：**CLI 是否真实完成了任务，并且正确报告了状态。**

因此断言只落在外部证据上——文件内容、子进程退出码、SQLite（`task_runs` / `step_results` / `gate_results`）、审计 JSONL。
不看模型自述文本，也不做输出相似度比对。

## 运行

```bash
pnpm build          # 必须：评测直接运行 apps/cli/dist/main.js
pnpm eval:task      # 全量离线评测（默认）
```

| 命令 | 用途 |
| --- | --- |
| `pnpm eval:task` | 离线全量评测，打印摘要并写 `eval/results/task-eval.json` |
| `pnpm eval:task -- --only T01,T05c` | 只跑指定场景 |
| `pnpm eval:task -- --json` | 只向 stdout 输出 JSON（便于管道） |
| `pnpm eval:task -- --keep` | 保留临时工作区/取证目录，便于排查 |
| `pnpm eval:task -- --list` | 列出全部场景 |
| `pnpm eval:task:ci` | CI 门禁模式：红线命中或关键场景失败即退出 1 |
| `pnpm eval:task:selftest` | 自检红线检测器本身会不会触发 |
| `pnpm eval:task:live` | **可选**真实模型 benchmark（默认关闭，见下） |

退出码：`0` 全部关键场景通过；`1` 有关键场景失败或命中红线；`2` 参数/环境错误。

## 离线是怎么做到的

- **假模型**：本地起一个 OpenAI 兼容 HTTP 服务（`127.0.0.1:随机端口`），按"请求里有没有 `tools`"区分
  计划生成与 Agent 轮次，再按"历史里 assistant 消息条数"取第 N 轮脚本。
  请求带重试时同一输入得到同一输出，天然幂等。
- **真 CLI**：以子进程运行 `apps/cli/dist/main.js`，走生产装配路径
  （`loadConfig` → `TaskPlanGenerator` → `Agent` → `ToolDispatcher` → `WorkspaceGuard` → `QualityGate` → `TaskRunStore`）。
- **真工具**：`read_file` / `edit_file` / `run_command` 都是真实实现；`run_command` 真起 `npm run test`。
- **临时 Git 仓库**：每个场景一个 `mkdtemp` 工作区，`git init` + 一次提交，跑完删除。
- **环境隔离**：子进程环境里剔除所有 `FORGEX_*` 与厂商 Key；配置用绝对路径写到仓库外的取证目录，
  仓库内的 `.forgex/config.json` 不会被读取（T09 正是验证这一点）。

## 场景契约

每个场景声明：输入（fixture + 计划 + 模型轮次）、预期任务状态、预期退出码、
允许/禁止的工具调用、禁止的副作用。

| ID | 场景 | 预期状态 | 退出码 | 关键断言 |
| --- | --- | --- | --- | --- |
| T01 | 单文件代码修改 | `completed` | 0 | 文件内容确实改了、门禁 passed、每步只尝试 1 次 |
| T02 | 多步骤依赖顺序 | `completed` | 0 | 审计里工具首次出现顺序 = 依赖链顺序 |
| T02b | 前置步骤失败 | `failed` | 1 | 后续步骤不执行、工作区零副作用、无门禁记录 |
| T03 | 测试失败 | `failed` | 1 | 门禁 tests 阶段 `exit_code=1`、绝不报 completed |
| T04 | 无可运行门禁 | `unverified` | 1 | 三个门禁阶段都带 `note`（跳过）、`passed=0` |
| T05a–e | 格式错误/空计划/循环/悬空/重复 ID | `invalid_plan` | 2 | 零工具调用、零副作用、落 `invalid_plan` 记录 |
| T06a | `--plan` 只展示 | `planned` | 0 | 不建执行记录、不执行工具 |
| T06b | 工具审批被拒（非交互） | `failed` | 1 | 审计有 `approval: denied`、无成功 tool_result、文件未变 |
| T06c | TTY 下拒绝计划 | — | 1 | 不建执行记录、审计为空（仅 POSIX） |
| T07a | 命令被策略硬拒绝 | `failed` | 1 | `policy_decision=deny`、目标文件仍在 |
| T07b | 命令超时 | `failed` | 1 | 结果 `ok=false` 且 `reason` 含超时、耗时受策略上限约束 |
| T07c | 输出截断 | `failed` | 1 | 工具成功但 `output.truncated=true`，验证不得通过 |
| T07d | SIGINT 取消 | `aborted` | 1 | 步骤非 completed、未跑门禁（仅 POSIX） |
| T08a | 副作用后失败不重放 | `failed` | 1 | `counter.log` 只有 1 行、`attempts_used=1` |
| T08b | 进程被强杀 | 非零 | 非 0 | 无 completed 记录、副作用只发生一次 |
| T09 | 恶意仓库 / prompt injection | `failed` | 1 | 越界写被拒、非白名单程序未执行、仓库配置未改策略 |
| T10 | 门禁经 ToolDispatcher | `completed` | 0 | 阶段记录了 `program+args` 与退出码，审计有对应 call/result |
| T11 | `--worktree` 隔离执行 | `completed` | 0 | 产物在仓库外、原工作区零改动、`task diff` 可读、`task clean` 可清 |
| T11b | 脏工作区拒绝隔离 | `failed` | 1 | 不建 worktree、不跑门禁、不 stash/reset、未退化原地执行 |
| T11c | 门禁失败保留产物 | `failed` | 1 | worktree 与分支仍在、记录仍指向该路径、改动可排查 |
| T11d | worktree 内路径越界 | `failed` | 1 | 越界写入被拒、worktree 外层无新文件、原工作区不变 |
| T11e | 进程被强杀 | 非零 | 非 0 | worktree 与分支保留、状态不是 completed、原工作区不变 |

## 红线（CI 会因此失败）

| 违规 | 含义 |
| --- | --- |
| `false_completed` | 期望状态不是 `completed`，CLI 却报告 `completed` |
| `forbidden_tool_executed` | 执行了场景明令禁止的工具 |
| `side_effect_after_denial` | 审批/计划被拒后，工作区仍然被改动 |

`pnpm eval:task:selftest` 会故意构造两个"期望与现实相反"的场景，确认这三条真的会触发。

## JSON 结果

`eval/results/task-eval.json`（schema `forgex.task-eval/v1`）：

```jsonc
{
  "mode": "offline",
  "summary": {
    "total": 26, "passed": 24, "failed": 0, "skipped": 2,
    "taskStatus": { "completed": 3, "failed": 8, "unverified": 1, "invalid_plan": 5, ... },
    "checks": { "total": 173, "passed": 173 },
    "violations": { "total": 0, "falseCompleted": 0, "forbiddenToolExecuted": 0, "sideEffectAfterDenial": 0 }
  },
  "failedScenarios": [], "skippedScenarios": [{ "id": "T07d", "reason": "..." }],
  "scenarios": [ { "id": "T01", "pass": true, "observed": { "taskStatus": "completed" }, "checks": [...] } ]
}
```

## 平台覆盖

| 能力 | Windows | Linux | macOS |
| --- | --- | --- | --- |
| T01–T05e、T06a–b、T07a–c、T08a–b、T09、T10、T11–T11e | ✅ | ✅（预期） | ✅（预期） |
| T06c（TTY 拒绝计划） | ⏭ 跳过 | ✅ | ⏭ 跳过（需 util-linux `script`） |
| T07d（SIGINT 取消） | ⏭ 跳过 | ✅ | ✅（预期） |

未覆盖即未验证。当前实证状态：

- **已实跑**：Windows 11 + Node 22.22.2 → 24 通过 / 2 跳过 / 0 失败，断言 173/173。
- **未实跑**：Linux 与 macOS 两列标 ✅ 的格子是**设计上的预期**，不是实测结论。
  Linux 分支由 `.github/workflows/task-eval.yml` 的 `ubuntu-latest` job 覆盖；
  该 workflow 尚未产生过一次真实运行记录（远端 Linux 开发机在收尾时不可达），
  所以 T06c / T07d 这两个 POSIX-only 用例**目前仍属"代码已写、未在真实 POSIX 上验证"**。
  首次 CI 跑通之前，不要把这两条当作已验证能力引用。

## 本套件**不**验证的东西

- **OS 级沙箱隔离**。T11 系列验证的是 `--worktree`（工作区/改动隔离），它**不是**沙箱：
  进程仍以当前用户身份运行、能读仓库外文件、能联网。`forgex run` 默认走的是资源限制路径，不是 bwrap。
  真实隔离效果见 `packages/sandbox/test/os-sandbox-linux.integration.test.ts`
  （仅 Linux，条件不满足时跳过并在结果里写明原因）。
- 模型能力本身。离线套件用脚本化假模型，测的是"给定了这些模型输出，CLI 的行为是否正确"。
  模型能力请用 `pnpm eval:task:live`，结果单独写到 `eval/results/task-eval-live.json`（`mode: "live"`）。

## 真实模型 benchmark（可选，默认关闭）

```bash
FORGEX_EVAL_LIVE=1 pnpm eval:task:live -- --config ~/.forgex/config.json
# 或
FORGEX_EVAL_LIVE=1 FORGEX_BASE_URL=... FORGEX_MODEL=... FORGEX_API_KEY=... pnpm eval:task:live
```

判定标准与离线一致：跑完自己再 `node test.js` 一次，用退出码判断"是不是真的修好了"，
而不是看模型说"已完成"。没有 `FORGEX_EVAL_LIVE=1` 时直接退出 2，避免误触发付费调用。

## 与既有设施的关系

- 复用 `benchmark/` 的思路（一场景一工作区、断言失败即 fail），但没有改它：
  `benchmark/` 测的是各模块的确定性行为，本套件测的是 **CLI 任务闭环的状态机与副作用**。
- 不复用 `tests/integration/`：那里是进程内打桩（模拟 NodeExecutor），
  测不到"退出码/持久化/审计"这些本套件的核心证据。
