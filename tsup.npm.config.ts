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
  // Node built-in imports must keep their `node:` protocol in published bundles.
  removeNodeProtocol: false,
  noExternal: [/^@forgex\//, 'zod'],
  external: ['ink', 'react', 'ssh2'],
});
