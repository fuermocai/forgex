/**
 * hybrid-search.ts 编排引擎测试（真实临时文件系统）。
 *
 * 覆盖：三层协同、层开关（消融）、glob 过滤、层统计、确定性。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch } from '../src/search/hybrid-search.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forgex-search-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'junk'), { recursive: true });
  await writeFile(
    join(root, 'src', 'auth.ts'),
    [
      "import { createHash } from 'node:crypto';",
      'export function loginUser(name: string, password: string) {',
      '  const hash = createHash("sha256").update(password).digest("hex");',
      '  return verifyPassword(name, hash);',
      '}',
      'export function verifyPassword(name: string, hash: string) {',
      '  return lookupUser(name)?.passwordHash === hash;',
      '}',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(root, 'src', 'server.go'),
    ['package main', 'func startServer(port int) error {', '\treturn nil', '}'].join('\n'),
    'utf8',
  );
  await writeFile(join(root, 'README.md'), '# 用户认证模块\n密码登录与校验逻辑。\n', 'utf8');
  // node_modules 里的文件必须被跳过
  await writeFile(join(root, 'node_modules', 'junk', 'index.js'), 'function loginUser() {}\n', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('hybridSearch', () => {
  it('三层协同：符号查询命中结构层与关键词层', async () => {
    const result = await hybridSearch({ query: 'loginUser', root });
    expect(result.hits.length).toBeGreaterThan(0);
    const layers = new Set(result.hits.flatMap((h) => h.contributions.map((c) => c.layer)));
    expect(layers.has('structure')).toBe(true);
    expect(layers.has('keyword')).toBe(true);
    // 结构层应识别出 loginUser 是 function
    const withSymbol = result.hits.find((h) => h.symbol === 'loginUser');
    expect(withSymbol?.symbolKind).toBe('function');
    // 各层统计完整
    expect(result.layerStats.keyword.enabled).toBe(true);
    expect(result.layerStats.structure.enabled).toBe(true);
    expect(result.layerStats.semantic.enabled).toBe(true);
    expect(result.scannedFiles).toBeGreaterThan(0);
  });

  it('跳过 node_modules', async () => {
    const result = await hybridSearch({ query: 'loginUser', root });
    expect(result.hits.every((h) => !h.path.includes('node_modules'))).toBe(true);
  });

  it('层开关：只跑关键词层（消融）', async () => {
    const result = await hybridSearch({ query: 'loginUser', root, layers: ['keyword'] });
    expect(result.layerStats.keyword.enabled).toBe(true);
    expect(result.layerStats.structure.enabled).toBe(false);
    expect(result.layerStats.semantic.enabled).toBe(false);
    expect(result.layerStats.structure.hitCount).toBe(0);
    expect(result.hits.length).toBeGreaterThan(0);
    const layers = new Set(result.hits.flatMap((h) => h.contributions.map((c) => c.layer)));
    expect([...layers]).toEqual(['keyword']);
  });

  it('glob 过滤限定文件类型', async () => {
    const result = await hybridSearch({ query: 'startServer', root, glob: '*.go' });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((h) => h.path.endsWith('.go'))).toBe(true);
  });

  it('自然语言中文查询走语义层', async () => {
    const result = await hybridSearch({ query: '密码 校验', root });
    expect(result.hits.length).toBeGreaterThan(0);
    // README 或 auth.ts 应被命中
    const paths = result.hits.map((h) => h.path);
    expect(paths.some((p) => p.includes('README') || p.includes('auth'))).toBe(true);
  });

  it('空查询返回空结果但保留层统计', async () => {
    const result = await hybridSearch({ query: '', root });
    expect(result.hits).toEqual([]);
    expect(result.layerStats.keyword.enabled).toBe(true);
    expect(result.scannedFiles).toBe(0);
  });

  it('同一查询重复执行结果完全一致（确定性）', async () => {
    const a = await hybridSearch({ query: 'verify password hash', root });
    const b = await hybridSearch({ query: 'verify password hash', root });
    expect(a.hits.map((h) => `${h.path}:${h.line}:${h.fusedScore}`)).toEqual(
      b.hits.map((h) => `${h.path}:${h.line}:${h.fusedScore}`),
    );
  });

  it('maxResults 限制融合后总数', async () => {
    const result = await hybridSearch({ query: 'login user password hash verify', root, maxResults: 3 });
    expect(result.hits.length).toBeLessThanOrEqual(3);
  });

  it('不存在的根目录返回空结果', async () => {
    const result = await hybridSearch({ query: 'anything', root: join(root, 'no-such-dir') });
    expect(result.hits).toEqual([]);
  });
});
