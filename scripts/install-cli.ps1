# ForgeX CLI 安装器（Windows）
#
# 作用：
#   1. 校验 Node >= 22 / pnpm
#   2. pnpm install + pnpm build
#   3. 生成 forgex 启动器（.cmd / .ps1 / bash 三个入口）
#   4. 把启动器目录加入用户级 PATH（已存在则跳过）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1 -SkipInstall   # 只重建启动器
#   powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1 -BinDir D:\bin
#
# 说明：
#   - 启动器里写的是本仓库的绝对路径；仓库挪位置后重新跑一次本脚本即可。
#   - 不会写入任何 API Key；首次使用请运行 `forgex connect`。

[CmdletBinding()]
param(
  [string]$BinDir = '',
  [switch]$SkipInstall,
  [switch]$SkipPath,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$mainJs = Join-Path $repo 'apps\cli\dist\main.js'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "[OK] $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "[!] $text" -ForegroundColor Yellow }

# 运行原生命令：临时放宽 ErrorActionPreference，避免 PowerShell 5.1
# 把子进程的 stderr 当成终止性错误（pnpm/tsc 会往 stderr 写进度）。
function Invoke-Native {
  param([scriptblock]$Command, [string]$What)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0) { throw "$What 失败（退出码 $code）" }
}

# ---------- 1. Node ----------
Write-Step '检查 Node.js'
try {
  $nodeVersion = (& node --version).Trim()
} catch {
  throw '未找到 node，请先安装 Node.js >= 22（https://nodejs.org）'
}
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "需要 Node.js >= 22，当前为 $nodeVersion" }
Write-Ok "Node.js $nodeVersion"

# ---------- 2. pnpm ----------
Write-Step '检查 pnpm'
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Warn '未找到 pnpm，尝试用 corepack 启用'
  try {
    corepack enable
    corepack prepare pnpm@11 --activate
  } catch {
    throw 'pnpm 不可用，请先执行：npm install -g pnpm'
  }
}
$pnpmVersion = (& pnpm --version).Trim()
Write-Ok "pnpm $pnpmVersion"

# ---------- 3. 依赖与构建 ----------
if (-not $SkipInstall) {
  Write-Step '安装依赖（pnpm install）'
  Push-Location $repo
  try {
    Invoke-Native { pnpm install --no-frozen-lockfile } 'pnpm install'
  } finally { Pop-Location }
  Write-Ok '依赖安装完成'
}

if (-not $SkipBuild) {
  Write-Step '编译 TypeScript（pnpm build）'
  Push-Location $repo
  try {
    Invoke-Native { pnpm build } 'pnpm build'
  } finally { Pop-Location }
  Write-Ok '编译完成'
}

if (-not (Test-Path $mainJs)) { throw "未找到 $mainJs，请去掉 -SkipBuild 重新安装" }

# ---------- 4. 选择启动器目录 ----------
if (-not $BinDir) {
  $existing = Get-Command forgex -ErrorAction SilentlyContinue
  if ($existing -and $existing.Source) {
    # 已经装过：复用原目录，避免 PATH 里出现两个 forgex
    $BinDir = Split-Path -Parent $existing.Source
  } elseif ($env:LOCALAPPDATA) {
    $BinDir = Join-Path $env:LOCALAPPDATA 'ForgeX\bin'
  } else {
    $BinDir = Join-Path $HOME '.forgex\bin'
  }
}
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Write-Ok "启动器目录 $BinDir"

# ---------- 5. 生成启动器 ----------
$cmdShim = @"
@echo off
node --disable-warning=ExperimentalWarning "$mainJs" %*
"@
Set-Content -Path (Join-Path $BinDir 'forgex.cmd') -Value $cmdShim -Encoding ASCII

$ps1Shim = @"
# ForgeX CLI launcher（由 scripts/install-cli.ps1 生成）
# 强制 UTF-8，避免 Windows PowerShell 5.1 把中文输出按 GBK 解码
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}
node --disable-warning=ExperimentalWarning "$mainJs" @args
exit `$LASTEXITCODE
"@
Set-Content -Path (Join-Path $BinDir 'forgex.ps1') -Value $ps1Shim -Encoding UTF8

$shShim = @"
#!/usr/bin/env bash
exec node --disable-warning=ExperimentalWarning "$mainJs" "`$@"
"@
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $BinDir 'forgex'), $shShim, $utf8NoBom)

Write-Ok '已生成 forgex.cmd / forgex.ps1 / forgex'

# ---------- 6. PATH ----------
if (-not $SkipPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if ($parts -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $BinDir) -join ';'), 'User')
    Write-Ok '已加入用户级 PATH（需要新开终端生效）'
  } else {
    Write-Ok '启动器目录已在 PATH 中'
  }
  if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }
}

# ---------- 7. 自检 ----------
Write-Step '自检'
$version = Invoke-Native { node --disable-warning=ExperimentalWarning $mainJs --version } 'forgex 自检'
Write-Ok "forgex 启动器可用：$version"

Write-Host ''
Write-Host 'ForgeX 安装完成' -ForegroundColor Green
Write-Host "  仓库      : $repo"
Write-Host "  启动器    : $BinDir\forgex.cmd"
Write-Host "  配置文件  : $HOME\.forgex\config.json（由 forgex connect 生成）"
Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 新开一个终端（让 PATH 生效）'
Write-Host '  2. cd 到你的项目目录'
Write-Host '  3. forgex connect     # 首次：连接模型并校验 Key'
Write-Host '  4. forgex             # 进入 TUI'
