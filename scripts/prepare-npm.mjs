/**
 * 生成 npm 发布目录 `dist-npm/`。
 *
 * 前置：`pnpm build && tsup --config tsup.npm.config.ts`
 *
 * 发布包是单文件 bundle，不依赖仓库内的 `@forgex/*` 私有包；
 * 运行时依赖只有 ink / react / ssh2。
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'dist-npm');
const versionSource = await readFile(join(root, 'apps/cli/src/version.ts'), 'utf8');
const version = /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(versionSource)?.[1];

if (!version) {
  throw new Error('无法从 apps/cli/src/version.ts 读取 VERSION');
}
if (!existsSync(join(outDir, 'main.js'))) {
  throw new Error('dist-npm/main.js 不存在，请先运行 tsup --config tsup.npm.config.ts');
}

const packageName = process.env.FORGEX_NPM_PACKAGE ?? '@forgex/cli';
const repositoryUrl = 'https://github.com/fuermocai/forgex';

const manifest = {
  name: packageName,
  version,
  description: 'ForgeX - TUI-first coding & DevOps agent runtime',
  type: 'module',
  main: './main.js',
  exports: {
    '.': './main.js',
  },
  bin: {
    forgex: './main.js',
  },
  files: ['main.js', 'README.md'],
  engines: {
    node: '>=22.13.0',
  },
  dependencies: {
    ink: '5.2.1',
    react: '18.3.1',
    ssh2: '^1.17.0',
  },
  publishConfig: {
    access: 'public',
  },
  repository: {
    type: 'git',
    url: `git+${repositoryUrl}.git`,
  },
  homepage: `${repositoryUrl}#readme`,
  bugs: {
    url: `${repositoryUrl}/issues`,
  },
  keywords: [
    'forgex',
    'agent',
    'coding',
    'devops',
    'tui',
    'deepseek',
    'cli',
  ],
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await copyFile(join(root, 'apps/cli/README.md'), join(outDir, 'README.md'));

if (existsSync(join(root, 'LICENSE'))) {
  await copyFile(join(root, 'LICENSE'), join(outDir, 'LICENSE'));
}

console.log(`npm 发布目录已生成: ${outDir}`);
console.log(`包名: ${packageName}@${version}`);
