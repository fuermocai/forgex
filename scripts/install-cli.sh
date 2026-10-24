#!/usr/bin/env bash
# ForgeX CLI 安装器（macOS / Linux / WSL / Git Bash）
#
# 用法：
#   bash scripts/install-cli.sh
#   bash scripts/install-cli.sh --skip-install      # 只重建启动器
#   FORGEX_BIN_DIR="$HOME/bin" bash scripts/install-cli.sh
#
# 说明：
#   - 启动器写入本仓库的绝对路径；仓库挪位置后重新执行本脚本即可。
#   - 不写入任何 API Key；首次使用运行 `forgex connect`。

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_JS="$REPO/apps/cli/dist/main.js"
BIN_DIR="${FORGEX_BIN_DIR:-$HOME/.local/bin}"
SKIP_INSTALL=0
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok() { printf '\033[32m[OK] %s\033[0m\n' "$1"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$1"; }

# ---------- Node ----------
step '检查 Node.js'
if ! command -v node >/dev/null 2>&1; then
  echo '未找到 node，请先安装 Node.js >= 22（https://nodejs.org）' >&2
  exit 1
fi
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "需要 Node.js >= 22，当前为 $NODE_VERSION" >&2
  exit 1
fi
ok "Node.js $NODE_VERSION"

# ---------- pnpm ----------
step '检查 pnpm'
if ! command -v pnpm >/dev/null 2>&1; then
  warn '未找到 pnpm，尝试用 corepack 启用'
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@11 --activate
  else
    echo 'pnpm 不可用，请先执行：npm install -g pnpm' >&2
    exit 1
  fi
fi
ok "pnpm $(pnpm --version)"

# ---------- 依赖与构建 ----------
if [ "$SKIP_INSTALL" -eq 0 ]; then
  step '安装依赖（pnpm install）'
  (cd "$REPO" && pnpm install --no-frozen-lockfile)
  ok '依赖安装完成'
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  step '编译 TypeScript（pnpm build）'
  (cd "$REPO" && pnpm build)
  ok '编译完成'
fi

if [ ! -f "$MAIN_JS" ]; then
  echo "未找到 $MAIN_JS，请去掉 --skip-build 重新安装" >&2
  exit 1
fi

# ---------- 启动器 ----------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/forgex" <<EOF
#!/usr/bin/env bash
exec node --disable-warning=ExperimentalWarning "$MAIN_JS" "\$@"
EOF
chmod +x "$BIN_DIR/forgex"
ok "已生成 $BIN_DIR/forgex"

# ---------- PATH ----------
case ":$PATH:" in
  *":$BIN_DIR:"*) ok '启动器目录已在 PATH 中' ;;
  *)
    warn "$BIN_DIR 不在 PATH 中，请把下面一行加入 ~/.bashrc / ~/.zshrc："
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# ---------- 自检 ----------
step '自检'
node "$MAIN_JS" --version

echo
echo 'ForgeX 安装完成'
echo "  仓库      : $REPO"
echo "  启动器    : $BIN_DIR/forgex"
echo "  配置文件  : $HOME/.forgex/config.json（由 forgex connect 生成）"
echo
echo '下一步：'
echo '  1. 让 PATH 生效（重开终端或 source 配置文件）'
echo '  2. cd 到你的项目目录'
echo '  3. forgex connect     # 首次：连接模型并校验 Key'
echo '  4. forgex             # 进入 TUI'
