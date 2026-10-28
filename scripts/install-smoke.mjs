/**
 * npm tarball 安装冒烟测试（发布前的最后一道验证）。
 *
 * 用法：node scripts/install-smoke.mjs [tarball 路径]
 *   不传路径时默认找 dist-npm-*.tgz / forgex-agent-*.tgz，或先 npm pack dist-npm。
 *
 * 做什么：
 *  1. 检查 tarball 清单：只允许 package.json / main.js / README.md / LICENSE；
 *     不含 .env、数据库、日志、测试产物；bundle 内无 workspace:*、@forgex/*、
 *     仓库绝对路径、疑似 API Key。
 *  2. 在隔离 HOME（临时目录，绝无 FORGEX_* / 厂商 Key 环境变量）下
 *     `npm install <tarball>` 到独立 prefix。
 *  3. 运行 bin 入口：--help、--version、doctor。
 *     断言 --help 可运行、--version 与包版本一致、doctor 输出未配置 Key 的引导
 *     （证明它没有读到开发机真实凭据）。
 *
 * 不做什么：不发布、不访问真实模型 API、不触碰用户真实 HOME。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const ALLOWED_FILES = new Set(['package.json', 'main.js', 'README.md', 'LICENSE']);

function fail(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exitCode = 1;
}
function ok(msg) {
  process.stdout.write(`✓ ${msg}\n`);
}

/** 解析要测的 tarball；没有就先从 dist-npm 现场打包 */
function findTarball() {
  const arg = process.argv[2];
  if (arg) {
    if (!existsSync(arg)) throw new Error(`找不到 tarball: ${arg}`);
    return resolve(arg);
  }
  const distDir = join(root, 'dist-npm');
  if (!existsSync(join(distDir, 'main.js'))) {
    throw new Error('dist-npm/main.js 不存在，请先运行 pnpm build:npm');
  }
  const out = spawnSync('npm', ['pack', distDir, '--pack-destination', distDir], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (out.status !== 0) throw new Error(`npm pack 失败: ${out.stderr}`);
  const name = out.stdout.split(/\r?\n/).filter((l) => l.trim().endsWith('.tgz')).pop();
  if (!name) throw new Error('npm pack 未输出 tarball 文件名');
  return join(distDir, name.trim());
}

/** 清掉一切能泄露真实凭据的环境变量 */
function isolatedEnv(home) {
  const env = {};
  const KEEP = [
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT',
    'windir', 'WINDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
    'ProgramFiles', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS',
    'OS', 'PROCESSOR_ARCHITECTURE', 'SESSIONNAME', 'COMPUTERNAME', 'LIBRARY_PATH',
    'LD_LIBRARY_PATH', 'npm_config_registry', 'NPM_CONFIG_REGISTRY', 'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
  ];
  for (const k of KEEP) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  // HOME/USERPROFILE 指向临时目录 → ~/.forgex 落在隔离区
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolveDone) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolveDone({ code, stdout, stderr }));
    child.on('error', (err) => resolveDone({ code: null, stdout, stderr: `${stderr}\n${err.message}` }));
  });
}

/** 优先用 node npm-cli.js（跨平台一致）；找不到再退回 npm 命令 */
function npmCommand() {
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(candidate)) return { cmd: process.execPath, baseArgs: [candidate] };
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', baseArgs: [] };
}

async function runNpm(args, env, cwd) {
  const { cmd, baseArgs } = npmCommand();
  if (cmd !== process.execPath && process.platform === 'win32') {
    // Windows 上不能直接 spawn .cmd（CVE-2024-27980 缓解），走 cmd.exe /d /s /c
    const comspec = process.env.ComSpec || 'cmd.exe';
    const line = [cmd, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
    return run(comspec, ['/d', '/s', '/c', line], { env, cwd, windowsVerbatimArguments: true });
  }
  return run(cmd, [...baseArgs, ...args], { env, cwd });
}

const tarball = findTarball();
const work = join(tmpdir(), `forgex-install-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const home = join(work, 'home');
const prefix = join(work, 'prefix');
for (const dir of [home, prefix]) mkdirSync(dir, { recursive: true });

const versionTs = /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(readFileSync(join(root, 'apps/cli/src/version.ts'), 'utf8'))?.[1];

try {
  // ── 1. tarball 清单与内容检查 ─────────────────────────────
  // 用 npm pack --dry-run --json 拿清单（跨平台，不依赖 tar 的路径语义）。
  // npm pack 的打包源就是 dist-npm/（files 字段声明），所以内容扫描直接读源目录。
  const packList = spawnSync('npm', ['pack', join(root, 'dist-npm'), '--dry-run', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (packList.status !== 0) throw new Error(`npm pack --dry-run 失败: ${packList.stderr}`);
  const packInfo = JSON.parse(packList.stdout)[0];
  const pkgDir = join(root, 'dist-npm');
  const files = packInfo.files.map((f) => f.path.replaceAll('\\', '/'));
  const unexpected = files.filter((f) => !ALLOWED_FILES.has(f));
  if (unexpected.length > 0) fail(`tarball 含未声明的文件: ${unexpected.join(', ')}`);
  else ok(`tarball 清单干净：仅 ${[...ALLOWED_FILES].join(' / ')}（共 ${files.length} 个文件）`);

  const forbiddenPatterns = /\.(env|log|db|sqlite|sqlite3)$|(^|\/)(coverage|\.git|node_modules)(\/|$)/i;
  const bad = files.filter((f) => forbiddenPatterns.test(f));
  if (bad.length > 0) fail(`tarball 含疑似敏感/构建残留文件: ${bad.join(', ')}`);
  else ok('无 .env / 数据库 / 日志 / 测试产物');

  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const manifestProblems = [];
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (spec.includes('workspace:') || spec.startsWith('link:') || spec.startsWith('file:')) {
      manifestProblems.push(`${name}: ${spec}`);
    }
  }
  if (manifestProblems.length > 0) fail(`package.json 残留 workspace/file 依赖: ${manifestProblems.join(', ')}`);
  else ok('package.json 无 workspace:*/link:/file: 依赖');
  const unknownDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => !['ink', 'react', 'ssh2'].includes(d));
  if (unknownDeps.length > 0) fail(`依赖超出声明的运行时白名单(ink/react/ssh2): ${unknownDeps.join(', ')}`);
  else ok('运行时依赖 = ink / react / ssh2，与 tsup external 一致');
  if (!['main.js', './main.js'].includes(pkg.bin?.forgex ?? '')) fail(`bin.forgex = ${pkg.bin?.forgex}，应为 main.js`);
  if (versionTs && pkg.version !== versionTs) fail(`包版本 ${pkg.version} != version.ts ${versionTs}`);
  else if (versionTs) ok(`包版本与仓库一致：${pkg.version}`);

  const bundle = readFileSync(join(pkgDir, 'main.js'), 'utf8');
  const bundleProblems = [];
  if (/workspace:\*/.test(bundle)) bundleProblems.push('bundle 含 workspace:* 依赖协议');
  if (/@forgex\//.test(bundle)) bundleProblems.push('bundle 引用未发布的 @forgex/* 包');
  if (/sk-[A-Za-z0-9_-]{20,}/.test(bundle)) bundleProblems.push('bundle 含疑似 API Key (sk-...)');
  const repoRoot = root.replaceAll('\\', '/');
  if (bundle.includes(repoRoot) || bundle.includes(repoRoot.replaceAll('/', '\\'))) {
    bundleProblems.push(`bundle 含仓库绝对路径 ${repoRoot}`);
  }
  if (bundleProblems.length > 0) fail(bundleProblems.join('; '));
  else ok('bundle 无 workspace:*/@forgex/*/仓库路径/密钥残留');

  // ── 2. 隔离环境安装 ────────────────────────────────────────
  const env = isolatedEnv(home);
  process.stdout.write('\n安装 tarball（隔离 HOME，已清除 FORGEX_* 与厂商 Key）…\n');
  const install = await runNpm(['install', tarball, '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error'], env, work);
  if (install.code !== 0) {
    fail(`npm install 失败（exit ${install.code}）:\n${install.stderr.slice(0, 800)}`);
  } else {
    ok(`npm install 成功 → ${prefix}`);
  }

  // bin shim 必须存在（npm 生成）
  const shimBase = join(prefix, 'node_modules', '.bin', 'forgex');
  const shims = process.platform === 'win32'
    ? [`${shimBase}.cmd`, `${shimBase}.ps1`, shimBase]
    : [shimBase];
  const missingShims = shims.filter((p) => !existsSync(p));
  if (missingShims.length > 0) fail(`缺少 npm bin shim: ${missingShims.join(', ')}`);
  else ok(`npm bin shim 齐全（forgex${process.platform === 'win32' ? '.cmd/.ps1' : ''}）`);

  // ── 3. 入口命令真实运行 ────────────────────────────────────
  const entry = join(prefix, 'node_modules', 'forgex-agent', 'main.js');
  // 3a. bin shim 真实可执行（不是只看文件在不在）
  const shimRun = await run(
    process.platform === 'win32' ? 'cmd.exe' : shims[0],
    process.platform === 'win32' ? ['/d', '/s', '/c', `"${shims[0]}" --version`].map((a) => a) : ['--version'],
    process.platform === 'win32' ? { env, cwd: work, windowsVerbatimArguments: true } : { env, cwd: work },
  );
  if (shimRun.code !== 0) fail(`bin shim --version 失败（exit ${shimRun.code}）: ${shimRun.stderr.slice(0, 300)}`);
  else if (!shimRun.stdout.includes(pkg.version)) fail(`bin shim --version 输出 ${JSON.stringify(shimRun.stdout.trim())} 不含版本 ${pkg.version}`);
  else ok(`forgex --version = ${pkg.version}（经 bin shim 真实执行）`);

  const help = await run(process.execPath, [entry, '--help'], { env, cwd: work });
  if (help.code !== 0) fail(`--help 失败（exit ${help.code}）: ${help.stderr.slice(0, 400)}`);
  else if (!/forgex/i.test(help.stdout)) fail('--help 输出不含用法信息');
  else ok(`--help 可运行（${help.stdout.split('\n').length} 行用法输出）`);

  const doctor = await run(process.execPath, [entry, 'doctor'], { env, cwd: work });
  if (doctor.code !== 0) fail(`doctor 失败（exit ${doctor.code}）: ${doctor.stderr.slice(0, 400)}`);
  if (!/未配置/.test(doctor.stdout) || !/FORGEX_API_KEY|\/key/.test(doctor.stdout)) {
    fail(`doctor 未给出无 Key 配置引导。输出前 500 字：\n${doctor.stdout.slice(0, 500)}`);
  } else {
    ok('doctor 可运行，无 Key 时给出配置引导（未读取开发机真实凭据）');
  }
  if (doctor.code !== 0 || !/未配置/.test(doctor.stdout)) {
    // 已在上面 fail，这里不重复
  }

  // ── 4. 汇总 ────────────────────────────────────────────────
  const failures = process.exitCode === 1;
  console.log(`\n${failures ? '✗ 冒烟测试未通过' : '✓ 安装冒烟测试全部通过'}：${tarball}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
