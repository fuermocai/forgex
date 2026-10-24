# ForgeX 开发指南

## 1. 环境要求

- Node.js >= 22（使用 `node:sqlite`、`AbortSignal.any`、原生 fetch）
- pnpm >= 9（仓库使用 pnpm workspace）
- Rust stable（仅构建 `crates/executor` 时需要）
- ripgrep（可选；缺失时 `grep_search` 自动降级为纯 Node 搜索）
- git（可选；`git_status` / `git_diff` 需要）

## 2. 常用命令

```powershell
pnpm install
pnpm build            # tsc -b（Project References，含类型检查）
pnpm typecheck        # 同 build
pnpm test             # vitest run（packages/*/test + tests/**）
pnpm bench -- --tasks 20
pnpm cargo:build      # cargo build --release
pnpm cargo:test
```

单独运行某个包的测试：`pnpm vitest run packages/core/test`。

## 3. 目录与职责

| 包 | 职责 | 不应包含 |
| --- | --- | --- |
| `shared` | 类型、错误码、日志、脱敏、Token 估算、协议校验 | 业务逻辑、文件 IO |
| `models` | OpenAI-compatible Provider（流式、tool_calls、重试） | 工具、权限 |
| `security` | 策略、Guard、审批、审计 | 工具具体实现 |
| `tools` | 工具执行体与注册表 | 权限判定、审批 |
| `devops` | 只读系统诊断原语 | 工具包装、权限 |
| `core` | Agent Loop、上下文、会话、Dispatcher、指标 | CLI 渲染 |
| `apps/cli` | 配置、装配、命令、TUI | 业务规则 |

依赖方向只能自上而下；`shared` 不得 import 其他包。

## 4. 新增一个工具

1. 在 `packages/tools/src/<category>/` 新建文件，定义 Zod 输入 schema。
2. 实现 `ToolDefinition`：

```ts
export function createMyTool(): ToolDefinition<Input> {
  return {
    name: 'my_tool',
    description: '一句话说明用途与返回结构',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',          // read | write | execute | privileged
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    tags: ['category'],
    async execute(input, ctx) {
      // 1) 路径必须通过 ctx.workspace.resolve(...)
      // 2) 不要抛异常，返回 toolOk / toolError
      // 3) 输出超过 maxOutputBytes 时保留结构并截断
    },
  };
}
```

3. 在 `packages/tools/src/index.ts` 导出并加入 `createBuiltinTools()`。
4. 在 `packages/tools/test/tools.test.ts` 增加：
   - 正常路径（真实文件/系统）；
   - 权限拒绝路径（通过 Dispatcher 或 PolicyEngine）；
   - 超时/取消路径（如适用）。
5. 运行 `pnpm build && pnpm test`。

**禁止**在工具内部判断权限或调用审批；Dispatcher 是唯一入口。

## 5. 消息协议约束

OpenAI-compatible 服务端对 tool 消息有硬约束：

- `assistant.tool_calls[].id` 必须是非空且唯一；
- 每个 `tool_call` 必须在下一个非 tool 消息前得到一条同 `tool_call_id` 的 `tool` 消息；
- 不允许出现没有对应 `tool_call` 的孤立 `tool` 消息。

开发时：

- 新增任何"提前结束"的路径（取消、循环、最大迭代）时，必须为已发出的 tool_calls 补齐结果；
- 修改上下文压缩逻辑后，必须用 `validateMessageProtocol` 断言；
- 恢复会话时调用 `repairProtocol`，不要把非法历史直接发给模型。

## 6. 配置

优先级：默认值 < `forgex.config.json` < 环境变量 < 命令行。

配置文件搜索顺序：

1. `--config <path>`
2. `FORGEX_CONFIG`
3. `<cwd>/forgex.config.json`
4. `~/.forgex/config.json`

主要环境变量：

```
FORGEX_BASE_URL / FORGEX_API_KEY / FORGEX_API_KEY_ENV / FORGEX_MODEL
FORGEX_CONTEXT_WINDOW / FORGEX_MAX_OUTPUT_TOKENS / FORGEX_TEMPERATURE
FORGEX_TIMEOUT_MS / FORGEX_MAX_RETRIES / FORGEX_STREAM
FORGEX_PERMISSION_MODE / FORGEX_WORKSPACE / FORGEX_ALLOWED_PROGRAMS
FORGEX_COMMAND_TIMEOUT_MS / FORGEX_AUDIT_LOG
FORGEX_DB_PATH / FORGEX_MAX_ITERATIONS
FORGEX_EXECUTOR   # Rust 执行器绝对路径
```

相对路径（工作区、数据库、审计）按**进程 cwd** 解析；工具的相对路径按**工作区根目录**解析。

## 7. 离线部署

MVP 不依赖在线 CDN 或运行时下载。离线环境准备：

1. 在联网机器执行 `pnpm install`、`pnpm build`、`cargo build --release`，保留 `node_modules`、`dist`、`target/release/forgex-executor` 与 `pnpm-lock.yaml`；
2. 将模型服务部署在内网（或本机），配置 `baseUrl` 指向内网地址；
3. 可选安装 ripgrep / git（未安装也能运行，只是功能降级）；
4. 使用 `FORGEX_API_KEY_ENV` 注入密钥；
5. 运行 `forgex doctor` 确认工作区、数据库、模型配置、诊断能力全部可用。

### ssh2 native addon 离线处理（v0.2.0）

`ssh2` 是 native addon（通过 `node-gyp` 编译 C++ 绑定 `sshcrypto.node`），不能像纯 JS 依赖那样直接 copy `node_modules`。

三种处理方式：

**方式 A：目标机执行一次 approve-builds（最简单，推荐）**

```powershell
pnpm install
pnpm approve-builds ssh2 cpu-features
```

pnpm 的 supply-chain 安全策略默认阻止所有 build script，`approve-builds` 会弹出候选列表，选择允许 ssh2 和 cpu-features 即可。这是一次性操作，后续 `pnpm install` 不会再询问。

**方式 B：预编译二进制拷过去（适合严格离线）**

在联网开发机执行方式 A，编译好的 `sshcrypto.node` 位于：

```
node_modules\.pnpm\ssh2@<version>\node_modules\ssh2\lib\protocol\crypto\build\Release\sshcrypto.node
```

连同 `cpu-features` 的 `cpu_features.lib` / `cpu_features.dll`（Windows）一起拷到目标机对应的 `node_modules` 路径下即可。

**方式 C：关闭 SSH 远程诊断（最小依赖）**

不在 `forgex.config.json` 里配置 `security.remoteHosts`（默认空），`ssh_inspect` 工具不会注册，ssh2 依赖不会被 import。此时 forgeX 正常运行所有本机诊断能力，只是远程 SSH 禁用。

注意：`node:sqlite` 首次使用会打印一行 ExperimentalWarning，可通过 `NODE_NO_WARNINGS=1` 抑制（不建议在生产盲目屏蔽所有警告）。

## 8. Rust 执行器

构建：

```powershell
cargo build --release --manifest-path crates/executor/Cargo.toml
```

启用方式（任选其一）：

- 设置 `FORGEX_EXECUTOR=<绝对路径>`；
- 将二进制放到 `<workspace>/.forgex/bin/forgex-executor(.exe)`。

协议：

```json
{"program":"node","args":["--version"],"cwd":"D:/ws","env":{"PATH":"..."},"timeoutMs":30000,"maxOutputBytes":262144}
```

返回：

```json
{"code":0,"stdout":"v22.19.0\n","stderr":"","truncated":false,"timedOut":false,"durationMs":25}
```

启动失败时 `code=null` 且带 `spawnError`。取消/超时**不会**降级重试，因为命令可能已产生副作用。

## 9. Benchmark

```powershell
pnpm build
pnpm bench -- --tasks 20
pnpm bench -- --tasks 20 --compare .forgex/bench/results/<旧结果>.json
```

Benchmark 使用本地假模型 + 真实工具：

- coding 任务：`read_file` 必须读到标记内容；
- diagnosis 任务：为每个任务申请一个刚释放的空闲端口，`inspect_port` 必须返回 `found=false`；
- 同时测量上下文压缩耗时、协议合法性、Token 估算吞吐。

结果写入 `.forgex/bench/results/*.json`，不会污染仓库。

## 10. 第三方依赖与许可证

| 依赖 | 用途 | 许可证 | 风险说明 |
| --- | --- | --- | --- |
| zod | 工具参数校验 + JSON Schema 生成 | MIT | 纯运行时校验，无网络行为 |
| ink / react | TUI 渲染 | MIT | 仅 CLI 层使用，不进入 Agent Runtime |
| `node:sqlite` | 会话/审计/指标持久化 | Node 内置 | 实验特性，需 Node 22+ |
| ripgrep | 代码搜索 | MIT / Unlicense | 外部二进制，缺失时降级 |
| ssh2 | SSH2 协议实现（v0.2.0 远程诊断） | MIT | **native addon**，需预编译或在目标机执行 `pnpm approve-builds ssh2` |
| serde / serde_json | Rust 执行器协议 | MIT / Apache-2.0 | 仅 executor crate |
| tree-sitter | 预留（v0.1.0 未启用） | MIT | 引入前需评估离线构建成本 |

未使用 pi-agent-core、Claude Agent SDK、Codex SDK 等 Agent Runtime。

## 11. 排查

- `forgex doctor`：优先运行，检查 Node、配置、工作区、数据库、rg/git、诊断能力。
- `forgex config`：确认配置来源与最终值（Key 脱敏）。
- 模型请求失败：检查 `baseUrl` 是否包含 `/v1`、网关是否要求额外 header、是否禁用 SSE。
- 工具总是被拒绝：检查 `mode`、`requireApprovalForWrite/Execute`、是否处于非交互环境（默认拒绝）。
- 端口诊断为 `found=false`：确认服务是否真的监听、是否绑定到其他地址/协议。
- SQLite 打不开：确认 `FORGEX_DB_PATH` 目录存在且可写。
- Windows 下中文乱码：源文件使用 UTF-8；诊断工具对 UTF-16LE 日志做了兼容。
