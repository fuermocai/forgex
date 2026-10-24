import { defineConfig } from 'tsup';

/**
 * npm 发布包构建配置。
 *
 * 只把 CLI 及其内部 workspace 包打成一个 ESM 入口，避免把 15 个
 * `@forgex/*` 私有包逐个发布到 npm。`ink` / `react` / `ssh2` 保持
 * external，由 npm 安装；`zod` 直接打进 bundle。
 */
export default defineConfig({
  entry: { main: 'apps/cli/src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist-npm',
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  // tsup 默认会去掉 `node:` 前缀；这会把 `node:sqlite` 变成不存在的
  // 裸包 `sqlite`。发布包必须保留前缀。
  removeNodeProtocol: false,
  noExternal: [/^@forgex\//, 'zod'],
  external: ['ink', 'react', 'ssh2'],
});
