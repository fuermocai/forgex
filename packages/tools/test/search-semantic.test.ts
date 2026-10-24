/**
 * semantic-search.ts 单元测试（TF-IDF 语义层）。
 */
import { describe, expect, it } from 'vitest';
import { semanticSearch, tokenizeDocument } from '../src/search/semantic-search.js';
import type { WalkedFile } from '../src/search/walk.js';

function file(relPath: string, lines: string[]): WalkedFile {
  return { absPath: `/root/${relPath}`, relPath, lines };
}

describe('tokenizeDocument', () => {
  it('拆分标识符并小写化', () => {
    const terms = tokenizeDocument('getUserName');
    expect(terms).toContain('getusername');
    expect(terms).toContain('get');
    expect(terms).toContain('user');
    expect(terms).toContain('name');
  });

  it('提取中文段', () => {
    const terms = tokenizeDocument('用户登录 失败');
    expect(terms).toContain('用户登录');
    expect(terms).toContain('失败');
  });

  it('过滤长度小于 2 的片段', () => {
    const terms = tokenizeDocument('a I x ab');
    expect(terms).not.toContain('a');
    expect(terms).not.toContain('i');
    expect(terms).not.toContain('x');
    expect(terms).toContain('ab');
  });
});

describe('semanticSearch', () => {
  const files: WalkedFile[] = [
    file('src/auth.ts', [
      'export function authenticateUser(credentials: Credentials) {',
      '  const session = verifyCredentials(credentials);',
      '  return session;',
      '}',
    ]),
    file('src/cart.ts', [
      'export function addToCart(item: Item) {',
      '  cart.items.push(item);',
      '}',
    ]),
    file('src/session.ts', [
      'export function verifySession(token: string) {',
      '  return decodeToken(token);',
      '}',
    ]),
  ];

  it('找到与查询语义相关的文件', () => {
    const hits = semanticSearch({ tokens: ['verify', 'credentials'], files, maxHits: 10 });
    expect(hits.length).toBeGreaterThan(0);
    // auth.ts 同时含 verify + credentials，应排第一
    expect(hits[0]!.path).toBe('src/auth.ts');
    expect(hits[0]!.layer).toBe('semantic');
  });

  it('得分在 (0, 1] 区间且按降序排列', () => {
    const hits = semanticSearch({ tokens: ['session'], files, maxHits: 10 });
    expect(hits.length).toBeGreaterThan(1);
    for (let i = 0; i < hits.length; i += 1) {
      expect(hits[i]!.score).toBeGreaterThan(0);
      expect(hits[i]!.score).toBeLessThanOrEqual(1);
      if (i > 0) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it('查询词在语料中不存在时返回空', () => {
    expect(semanticSearch({ tokens: ['nonexistentterm'], files, maxHits: 10 })).toEqual([]);
  });

  it('空查询或空语料返回空', () => {
    expect(semanticSearch({ tokens: [], files, maxHits: 10 })).toEqual([]);
    expect(semanticSearch({ tokens: ['session'], files: [], maxHits: 10 })).toEqual([]);
  });

  it('遵守 maxHits 上限', () => {
    const many: WalkedFile[] = Array.from({ length: 30 }, (_, i) =>
      file(`f${i}.ts`, [`export const common_target_${i} = 'shared token';`]),
    );
    const hits = semanticSearch({ tokens: ['shared', 'token'], files: many, maxHits: 7 });
    expect(hits).toHaveLength(7);
  });

  it('minScore 阈值过滤低分结果', () => {
    const hits = semanticSearch({ tokens: ['session'], files, maxHits: 10, minScore: 0.9 });
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('snippet 选取查询词覆盖最高的行', () => {
    const hits = semanticSearch({ tokens: ['verify', 'credentials'], files, maxHits: 10 });
    const top = hits[0]!;
    // auth.ts 中第 2 行同时含 verify + credentials
    expect(top.line).toBe(2);
    expect(top.snippet).toContain('verifyCredentials');
  });

  it('同分时按路径稳定排序（确定性）', () => {
    const dup: WalkedFile[] = [
      file('b.ts', ['export const alpha_beta = 1;']),
      file('a.ts', ['export const alpha_beta = 1;']),
    ];
    const hits = semanticSearch({ tokens: ['alpha'], files: dup, maxHits: 10 });
    expect(hits.map((h) => h.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('标识符驼峰拆分使查询能命中复合词', () => {
    // 查询 "user" 应命中 authenticateUser（拆分出 user）
    const hits = semanticSearch({ tokens: ['user'], files, maxHits: 10 });
    expect(hits.some((h) => h.path === 'src/auth.ts')).toBe(true);
  });
});
