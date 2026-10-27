# ForgeX 项目长期记忆

## 包与发布

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
