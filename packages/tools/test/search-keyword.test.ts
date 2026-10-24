/**
 * keyword-search.ts 单元测试（真实内存文件数组，无 IO）。
 */
import { describe, expect, it } from 'vitest';
import { keywordSearch } from '../src/search/keyword-search.js';
import type { WalkedFile } from '../src/search/walk.js';

function file(relPath: string, lines: string[]): WalkedFile {
  return { absPath: `/root/${relPath}`, relPath, lines };
}

describe('keywordSearch', () => {
  const files: WalkedFile[] = [
    file('src/auth.ts', [
      'export function loginUser(name: string, password: string) {',
      '  const session = createSession(name);',
      '  return session;',
      '}',
    ]),
    file('src/config.ts', [
      'export const LOGIN_TIMEOUT_MS = 30_000;',
      'export const MAX_RETRY = 3;',
    ]),
    file('README.md', ['# 登录模块', '用户登录超时配置见 config.ts']),
  ];

  it('命中包含查询词的行并给出得分', () => {
    const hits = keywordSearch({ tokens: ['login'], files, maxHits: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.layer === 'keyword')).toBe(true);
    expect(hits.some((h) => h.path === 'src/config.ts' && h.line === 1)).toBe(true);
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  it('多词查询时覆盖率高的行排在前面', () => {
    const hits = keywordSearch({ tokens: ['login', 'timeout'], files, maxHits: 10 });
    expect(hits.length).toBeGreaterThan(0);
    // config.ts 第 1 行同时含 login + timeout，应为第一名
    expect(hits[0]!.path).toBe('src/config.ts');
    expect(hits[0]!.line).toBe(1);
  });

  it('默认不区分大小写', () => {
    const hits = keywordSearch({ tokens: ['login_timeout_ms'], files, maxHits: 10 });
    expect(hits.some((h) => h.path === 'src/config.ts')).toBe(true);
  });

  it('区分大小写模式严格匹配', () => {
    const hits = keywordSearch({ tokens: ['login_timeout_ms'], files, caseSensitive: true, maxHits: 10 });
    expect(hits).toHaveLength(0);
    const hitsExact = keywordSearch({ tokens: ['LOGIN_TIMEOUT_MS'], files, caseSensitive: true, maxHits: 10 });
    expect(hitsExact.length).toBeGreaterThan(0);
  });

  it('空 token 列表返回空结果', () => {
    expect(keywordSearch({ tokens: [], files, maxHits: 10 })).toEqual([]);
    expect(keywordSearch({ tokens: ['', ''], files, maxHits: 10 })).toEqual([]);
  });

  it('遵守 maxHits 上限', () => {
    const manyLines: WalkedFile[] = [
      file('big.ts', Array.from({ length: 100 }, (_, i) => `const token_${i} = "target";`)),
    ];
    const hits = keywordSearch({ tokens: ['target'], files: manyLines, maxHits: 5 });
    expect(hits).toHaveLength(5);
  });

  it('跳过空行', () => {
    const withEmpty: WalkedFile[] = [file('a.ts', ['', '  ', 'target here'])];
    const hits = keywordSearch({ tokens: ['target'], files: withEmpty, maxHits: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(3);
  });

  it('snippet 去除首尾空白并截断超长行', () => {
    const longLine = `  target ${'x'.repeat(500)}`;
    const hits = keywordSearch({ tokens: ['target'], files: [file('a.ts', [longLine])], maxHits: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(301);
    expect(hits[0]!.snippet.startsWith('target')).toBe(true);
  });

  it('结果排序确定性：得分相同按路径与行号排序', () => {
    const tie: WalkedFile[] = [
      file('b.ts', ['target']),
      file('a.ts', ['target']),
    ];
    const hits = keywordSearch({ tokens: ['target'], files: tie, maxHits: 10 });
    expect(hits.map((h) => h.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('命中次数多的行获得频次加成', () => {
    const freq: WalkedFile[] = [
      file('a.ts', ['target target target target target target']),
      file('b.ts', ['target']),
    ];
    const hits = keywordSearch({ tokens: ['target'], files: freq, maxHits: 10 });
    expect(hits[0]!.path).toBe('a.ts');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });
});
