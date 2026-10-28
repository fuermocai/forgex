# ForgeX 安全设计

ForgeX 的假设是：**模型输出不可信**。模型可能被提示注入、可能犯错、也可能被恶意构造的仓库内容诱导。安全边界必须由代码与操作系统保证，而不是靠提示词。

## 1. 威胁模型

| 威胁 | 场景 | 主要防线 |
| --- | --- | --- |
| 路径穿越 / 符号链接逃逸 | 模型请求读取或写入工作区外的文件 | `WorkspaceGuard`：realpath 解析 + 最近存在祖先检查 + 写入根限制 |
| 命令注入 | 模型传入 `"rm -rf /"`、`sh -c "..."`、`node -e "..."` | `CommandGuard`：program+args 结构、shell/解释器内联拒绝、参数黑名单、程序黑名单 |
| 越权写入 | 模型修改 `.git`、`.env`、`node_modules` | 受保护路径（写操作默认拒绝，需显式配置） |
| 未经批准执行 | 模型自行运行构建/测试/脚本 | `PolicyEngine` 判定 `ask` → `ApprovalManager`；无 handler 时自动拒绝 |
| 秘密泄露 | API Key、密码出现在日志/会话/审计 | Key 仅在 Provider 请求头；`redactValue` 递归脱敏；会话/审计不记录原始 Key |
| 提示注入 | 仓库文件或日志中含"忽略之前指令" | 系统提示词声明工具输出是数据；权限不因文本改变；写/执行仍需审批 |
| 资源耗尽 | 超大文件、无限输出、死循环、僵尸进程 | 读取/输出字节上限、Token 预算、最大迭代、循环检测、进程树终止 |
| 审计缺失 | 操作发生后无法追溯 | 所有工具调用/策略判定/审批/结果写审计；会话库同时作为 sink |

## 2. 权限模型

四档模式（`PolicySettings.mode`）：

| 模式 | read | write | execute | privileged |
| --- | --- | --- | --- | --- |
| `readonly` | allow | deny | deny | deny |
| `standard`（默认） | allow | ask（可配置为 allow） | ask | deny |
| `trusted` | allow | allow | ask | ask |
| `yolo` | allow | allow | allow | allow |

判定顺序（`policy-engine.ts`）：

1. 受保护路径（非 read）→ `deny`；
2. 黑名单程序 / 危险参数模式（execute、privileged）→ `deny`；
3. 模式矩阵；
4. `allowedPrograms` 未命中时降级为 `ask`（不是放行）。

`PRIVILEGED` 工具在 `standard` 下永远拒绝，模型无法通过任何参数改变这一点。

## 3. 审批流程

```
Dispatcher → PolicyEngine.evaluate()
  ├─ allow → 直接执行
  ├─ deny  → 返回 POLICY_DENIED（不进入审批）
  └─ ask   → ApprovalManager.request()
               ├─ 有 handler：等待人工 y/n（可超时）
               ├─ 无 handler：立即 denied（非交互环境默认安全）
               └─ AbortSignal：取消即拒绝
```

- 审批请求包含工具名、风险等级、原因、已脱敏参数和预览（如命令行/diff）。
- 审批结论写入审计（`approval: approved / denied / timeout`）。
- TUI 中审批是模态提示：未处理前普通输入被屏蔽；Ctrl+C 视为拒绝。

## 4. 命令执行约束

`run_command` 与 `CommandGuard` 的硬规则：

1. 只接受 `program` + `args[]`，**永远 `shell: false`**；
2. 拒绝交互式解释器与包装器：`sh`、`bash`、`zsh`、`cmd`、`powershell`、`pwsh`、`env`、`xargs`、`eval`、`exec`、`nice`、`nohup`、`timeout`、`start`、`call` 等；
3. 拒绝解释器内联代码：`node -e`、`python -c`、`perl -e`、`ruby -e`、`php -r` 等；
4. 拒绝 `find -exec`；
5. 拒绝程序名中的路径分隔之外的可疑字符与控制字符；
6. 参数黑名单：`--no-preserve-root`、`-rf`、`-fr`；
7. 环境变量只注入 `envAllowlist`（默认 PATH/HOME/USERPROFILE/TEMP/SystemRoot 等），其余全部丢弃；
8. 超时不超过 `commandTimeoutMs`，超时/取消终止整个进程树；
9. 执行结果按字节截断，并继续 drain 管道。

Rust 执行器（`crates/executor`）额外保证：`env_clear()`、独立进程组、Windows `taskkill /T /F`、Unix 进程组负 PID、stdout/stderr 各自限流。

## 5. 工作区防护

`WorkspaceGuard.resolve(target, mode, cwd)`：

1. 以 `cwd` 或工作区根为基准解析相对路径；
2. 对**最深的已存在祖先**做 `realpath`，再拼接不存在的尾部（防止通过尚未创建的文件绕过）；
3. 用 `path.relative` 判断是否位于允许根目录内（避免 `startsWith` 前缀误判，例如 `/work-evil`）；
4. `write` 模式额外检查 `writableRoots` 与 `protectedPaths`；
5. 读取不存在的文件抛 `PATH_NOT_FOUND`，越界抛 `WORKSPACE_ESCAPE`。

所有文件工具（read/list/grep/edit/git/logs/run_command cwd）都通过 `ToolContext.workspace` 解析路径，禁止自行拼接。

**威胁边界**：上述检查防止模型提交越界路径和静态符号链接逃逸；校验与后续文件系统调用仍是分开的路径操作，不能防御有能力并发替换工作区目录/符号链接的本机进程。处理不可信仓库或不可信本机进程时，应在容器/虚拟机等独立 OS 边界内运行；Rust 执行器本身也不是完整 OS 沙箱。

## 6. 审计

审计事件（JSONL + SQLite）包含：

```json
{"id":"a_...","ts":1730000000000,"type":"tool_call","sessionId":"s_...","callId":"call_1","tool":"edit_file","riskLevel":"write","input":{"path":"src/a.ts"}}
{"type":"policy_decision","decision":"ask","rule":"mode:standard:write","reason":"..."}
{"type":"approval","decision":"approved"}
{"type":"tool_result","ok":true,"durationMs":12,"bytes":340}
```

- 所有字符串值经过 `redactValue`：`apiKey`、`token`、`password`、`authorization`、`cookie`、`privateKey` 等键整值替换；`sk-...` 等字面量也替换。
- `sessionId` **不脱敏**，用于把工具调用、审批与会话关联起来。
- 单个 sink 失败不会中断其他 sink，也不会中断 Agent。
- 审计文件默认位于 `.forgex/audit.jsonl`（已加入 `.gitignore`），部署时应设置文件权限。

## 7. 密钥处理

- 推荐 `apiKeyEnv`：配置文件只写变量名，真实 Key 由部署环境注入。
- Key 只进入 Provider 的 `Authorization` 头。
- 不记录请求头、不记录完整请求体；错误信息只包含状态码与服务端摘要。
- `forgex config` 输出 `***已配置***`，不会打印 Key。
- `/connect` 与 `/key` 的持久化：三平台统一写 `~/.forgex/credentials.json`（强制 `600`）。该文件是**明文**，通过 `loadConfig` 兜底注入，优先级低于真实环境变量；不再写 Windows 用户环境变量（只对新终端生效，行为不一致且多一份注册表明文拷贝）。高合规场景应删除该文件，改为在启动脚本里 `export`。

## 8. 沙箱与隔离能力（能力 = 实际效果）

沙箱能力按**保证强度**分三层，命名与报告字段都不得混用（`SandboxCapability.category`）：

| 层次 | 实现 | 提供的保证 | 能跑 untrusted 吗 |
| --- | --- | --- | --- |
| 工作区隔离 | `TempDirProvider` / `GitWorktreeProvider` | 只隔离文件视图（新目录 / 独立 worktree）。仍以当前用户权限、正常网络、正常进程表运行 | **不能** |
| 资源限制 | `ResourceLimiter` + Rust executor | 进程超时、输出限额、`env_clear()`、进程树清理。不降权、无命名空间 | **不能** |
| OS 级隔离 | `OsSandboxProvider` + bubblewrap（仅 Linux） | mount / pid / net / ipc / uts / user 命名空间；默认断网；根文件系统只读；只有 workDir 可写 | **能**（且是唯一途径） |

`forgex sandbox` 与 `forgex doctor` 会按这三层输出，并直接给出「不可信执行：允许 / 拒绝」。

### 可审阅 worktree（`forgex run --worktree`，v0.5.6）

`--worktree` 属于**第一层：工作区隔离**，不是 OS 沙箱。它解决的问题是"让编码任务的产物先隔离出来给人看"，
不是"把不可信代码关起来"。

| 它做了什么 | 它**没有**做什么 |
| --- | --- |
| 在 `~/.forgex/worktrees/run-<runId>` 建独立工作树，分支 `forgex/run-<runId>`，基线为创建时的 HEAD | 不建命名空间、不 seccomp、不降权、不断网 |
| 把该目录作为本次运行的 `workspaceRoots`，路径校验/审批/审计都按它生效 | 不阻止进程读到 worktree 之外的文件 |
| 结束时保留目录与分支，可用 `forgex task diff/clean` 审阅或清理 | 不自动合并、不复制回原工作区、不自动删除 |

安全约束（全部 fail closed，不降级）：

- **脏工作区拒绝**：`git status --porcelain --untracked-files=all` 有任何条目就拒绝创建，并列出前 10 条。
  ForgeX **不**执行 `git stash` / `reset` / `checkout` / 移动文件；未跟踪文件也算脏，因为它们不会被带进
  worktree，放行等于让任务在一个缺文件的环境里跑。
- **路径归属**：worktree 只能建在配置的 `worktree.root` 内；目录名由 runId 推导；
  创建前后各做一次 realpath 包含校验（防软链接逃逸），Windows 下做大小写不敏感比较。
- **分支冲突**：同名分支已存在 → `WORKTREE_BRANCH_EXISTS`，不用 `-B` 覆盖（那会丢掉别人的分支）。
- **创建失败**：`git worktree add` 失败、HEAD 与基线不一致、目录已存在 → 回滚残留后抛错，
  任务终止，**不**退回原目录继续执行。
- **清理核对**：`forgex task clean <runId>` 删除前依次校验
  ①目录名 == `run-<runId>`、②记录根目录 == 当前配置的 `worktree.root`、
  ③realpath 后仍在根目录内、④`git worktree list` 确认该目录登记在本仓库；
  任一条不满足即拒绝。worktree 有未提交产物时默认拒绝，需显式 `--force`。
- **不自动删除**：成功、失败、取消、崩溃都保留 worktree 与分支，状态记录里写明产物路径。

### OS 级沙箱（Linux bubblewrap）具体做了什么

- **执行链**：`SandboxManager` → `OsSandboxProvider.execUntrusted()` → Rust executor 启动 `bwrap`，目标程序由 bwrap 在沙箱内 exec。不再有"先检查布尔值、再交给普通执行器"的路径。
- **能力判定**：`isAvailable()` 只有在内核真的能建立命名空间、且**探针**（与业务执行同一套 argv 构建器 + 同一执行器，跑 `/bin/true`）成功返回后才为 `true`。仅检测到 `bwrap` 二进制存在 → `available=false` + 原因。执行器回报的 program 不是 bwrap → 同样判为不可用。
- **挂载最小化**：`--unshare-all`、`--die-with-parent`、`--clearenv`、`--proc /proc`、`--dev /dev`、`--tmpfs /tmp`；`/usr`、`/usr/local`、`/bin`、`/sbin`、`/lib*` 与少量 `/etc` 文件用 `--ro-bind-try` **只读**挂载；**只有沙箱 workDir 是 `--bind` 可写**，`--chdir` 锁定在其中。
- **网络**：默认 `--unshare-all` 已包含 `--unshare-net`（无网络）；只有调用方显式 `allowNetwork` 才加 `--share-net`。
- **生命周期**：`--die-with-parent` + pid namespace，bwrap 退出即整组回收；超时、输出截断、取消由 Rust 执行器施加在 bwrap 进程组上（`kill -KILL -PID`）。
- **fail closed**：bwrap 缺失、无权限创建命名空间、执行器缺失、`spawnError`、`bwrap:` 前缀的 setup 错误、探针不通过 —— 全部抛 `SANDBOX_UNAVAILABLE` / `SANDBOX_CREATE_FAILED`，**不降级**到临时目录、worktree 或普通进程。

### 实测记录（Ubuntu 24.04 + bwrap 0.9.0）

在真实 Linux 主机上跑生产代码路径（`status()` 探针 → `buildBubblewrapPlan()` → runner → 溯源校验），只用 Node `spawn` 替掉 Rust 执行器，观测到的实际效果：

| 验证项 | 观测结果 |
| --- | --- |
| 能力判定 | `available=true, verified=true, mechanism=bubblewrap`，探针耗时 20ms |
| 执行溯源 | 每次执行的 `program` 均为 `/usr/bin/bwrap`，`isolation=os_sandbox` |
| workDir 可写 | 沙箱内写 `./inside.txt` 成功，宿主同一目录可见该文件 |
| `/usr` 只读 | `touch /usr/bin/...` → `Read-only file system` |
| `/etc` 不落宿主 | 沙箱内写 `/etc/xxx` 退出码 0（写入临时挂载），宿主 `/etc` 无该文件 |
| 网络隔离 | 沙箱内 `/proc/net/dev` 只有 `lo`，无 `eth0`/`ens*` |
| pid 命名空间 | 沙箱内 `/proc/1/comm` = `bwrap`（看不到宿主 init） |
| 文件系统最小化 | 沙箱内 `/` 只有 `bin dev etc lib lib64 proc sbin tmp usr`，`/home/pms` 不存在 |
| 超时 | `sleep 30` 在 800ms 超时，`timedOut=true`、`code=null` |
| 进程回收 | kill bwrap 后，沙箱内 `sleep` 立即从宿主进程表消失，无泄漏 |

未在真实主机验证的部分：Rust 执行器自身的超时/截断/进程树清理（本机未编译 `forgex-executor`，该部分由单元测试与 Rust 侧测试覆盖）。

### 尚未提供（不要当成已有）

- 无 seccomp 系统调用过滤；无 cgroup CPU/内存/IO 配额（资源限制只是超时 + 输出截断）。
- 不降权到另一个 uid（只有 user namespace 映射）；与宿主共享内核，不防御内核漏洞。
- 无 GPU / 设备透传，`/dev` 为沙箱内最小 devtmpfs。
- **Windows / macOS 没有真实实现**：`trustLevel: 'untrusted'` 与 `type: 'os_sandbox'` 一律拒绝，不提供"看起来像沙箱"的替身。
- 隔离效果已在真实 Linux + bwrap 上实测（见上表）；但**每个部署环境仍需自行复验**——AppArmor / SELinux 策略、容器内运行、`kernel.unprivileged_userns_clone=0` 都可能让 bwrap 建不起命名空间，此时能力检测会如实报 `available=false` 并拒绝执行。单元测试用可注入执行器只证明路由与 fail-closed 逻辑，不构成隔离证明（`packages/sandbox/test/os-sandbox-linux.integration.test.ts` 是真实集成验证，条件不满足时跳过并打印原因）。

## 9. 明确的安全限制

1. **命令白名单不是沙箱。** `run_command` 执行的是真实程序，构建脚本、测试框架、`npm install` 钩子都可能执行任意代码。生产环境应只在隔离机器/容器中授予 EXECUTE。
2. **同用户权限执行（资源限制 ≠ 隔离）。** Rust 执行器不降权，不提供 namespaces/cgroup/seccomp；它只保证"不会失控"，不保证"不能越界"。若需要强隔离，应在容器或独立低权限账户中运行。
3. **OS 级沙箱只在 Linux 且探针通过时可用。** 其余情况 `trustLevel: 'untrusted'` 被拒绝（fail closed）。能力报告里的 `os_sandbox.available` 是"执行链确实会用已验证的 OS 隔离机制"，不是"机器上装了 bwrap"。
4. **临时目录 / Git Worktree 不是 OS 沙箱。** 它们只做文件系统隔离，进程仍在同一用户权限下运行，网络正常、进程表正常、可执行文件路径正常。报告里 `category` 为 `workspace_isolation`，与 `os_isolation` 分开统计；`anyAvailable` 只看工作区隔离，不代表可跑不可信代码。
5. **提示注入无法完全消除。** 防线是"即使模型被骗，也无法越权"，而不是"模型永远不会被骗"。
6. **审计是本地文件。** 未实现远程不可篡改存储与签名；高合规场景应把审计文件转发到集中日志系统。
7. **`node:sqlite` 为实验特性。** 数据库文件应限制在受控目录，避免被其他进程替换。
8. **输出截断可能丢失证据。** 截断会标记 `truncated`，模型会被提示"内容已截断"，但不应把截断结果当作完整证据。


## 10. 部署加固清单

- [ ] 以专用低权限账户运行 ForgeX。
- [ ] `workspaceRoots` 只包含业务仓库，不包含 `/`、`C:\` 或用户主目录。
- [ ] 生产环境保持 `mode=standard` 或 `readonly`，禁止 `yolo`。
- [ ] 通过 `apiKeyEnv` 注入 Key，不写入仓库。
- [ ] 将 `.forgex/` 与审计文件放在受控目录，配置访问权限与轮转。
- [ ] 构建/测试类命令只在隔离环境执行。
- [ ] 定期审查 `sessions` 与审计日志中的高频工具与拒绝记录。
- [ ] 对模型网关使用内网地址，禁止代码/日志外发到公网服务。
