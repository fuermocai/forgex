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

## 8. 明确的安全限制

1. **命令白名单不是沙箱。** `run_command` 执行的是真实程序，构建脚本、测试框架、`npm install` 钩子都可能执行任意代码。生产环境应只在隔离机器/容器中授予 EXECUTE。
2. **同用户权限执行。** Rust 执行器不降权，不提供 namespaces/cgroup/seccomp。若需要强隔离，应在容器或独立低权限账户中运行。
3. **提示注入无法完全消除。** 防线是"即使模型被骗，也无法越权"，而不是"模型永远不会被骗"。
4. **审计是本地文件。** 未实现远程不可篡改存储与签名；高合规场景应把审计文件转发到集中日志系统。
5. **`node:sqlite` 为实验特性。** 数据库文件应限制在受控目录，避免被其他进程替换。
6. **输出截断可能丢失证据。** 截断会标记 `truncated`，模型会被提示"内容已截断"，但不应把截断结果当作完整证据。

## 9. 部署加固清单

- [ ] 以专用低权限账户运行 ForgeX。
- [ ] `workspaceRoots` 只包含业务仓库，不包含 `/`、`C:\` 或用户主目录。
- [ ] 生产环境保持 `mode=standard` 或 `readonly`，禁止 `yolo`。
- [ ] 通过 `apiKeyEnv` 注入 Key，不写入仓库。
- [ ] 将 `.forgex/` 与审计文件放在受控目录，配置访问权限与轮转。
- [ ] 构建/测试类命令只在隔离环境执行。
- [ ] 定期审查 `sessions` 与审计日志中的高频工具与拒绝记录。
- [ ] 对模型网关使用内网地址，禁止代码/日志外发到公网服务。
