/**
 * search/types.ts 单元测试。
 *
 * 重点验证：
 *   - tokenizeQuery 的驼峰/下划线拆分与中文提取；
 *   - isSearchLayer 运行时守卫；
 *   - clampSnippet 截断行为；
 *   - 常量集合的稳定性（防止误改导致层丢失）。
 */
import { describe, expect, it } from 'vitest';
import {
  SEARCH_LAYERS,
  SYMBOL_KINDS,
  RRF_K,
  MAX_SNIPPET_LEN,
  clampSnippet,
  isSearchLayer,
  tokenizeQuery,
} from '../src/search/types.js';

describe('isSearchLayer', () => {
  it('接受合法层名', () => {
    expect(isSearchLayer('keyword')).toBe(true);
    expect(isSearchLayer('structure')).toBe(true);
    expect(isSearchLayer('semantic')).toBe(true);
  });

  it('拒绝非法输入', () => {
    expect(isSearchLayer('unknown')).toBe(false);
    expect(isSearchLayer('')).toBe(false);
    expect(isSearchLayer(123)).toBe(false);
    expect(isSearchLayer(null)).toBe(false);
    expect(isSearchLayer(undefined)).toBe(false);
    expect(isSearchLayer(['keyword'])).toBe(false);
  });
});

describe('常量集合', () => {
  it('恰好包含三层检索', () => {
    expect(SEARCH_LAYERS).toEqual(['keyword', 'structure', 'semantic']);
  });

  it('符号类型包含常用种类', () => {
    expect(SYMBOL_KINDS).toContain('function');
    expect(SYMBOL_KINDS).toContain('class');
    expect(SYMBOL_KINDS).toContain('import');
  });

  it('RRF 平滑常数为经典值 60', () => {
    expect(RRF_K).toBe(60);
  });
});

describe('tokenizeQuery', () => {
  it('拆分驼峰标识符并保留原词', () => {
    const tokens = tokenizeQuery('getUserName');
    expect(tokens).toContain('getusername');
    expect(tokens).toContain('get');
    expect(tokens).toContain('user');
    expect(tokens).toContain('name');
  });

  it('拆分下划线标识符', () => {
    const tokens = tokenizeQuery('max_retry_count');
    expect(tokens).toContain('max_retry_count');
    expect(tokens).toContain('max');
    expect(tokens).toContain('retry');
    expect(tokens).toContain('count');
  });

  it('处理全大写缩写', () => {
    const tokens = tokenizeQuery('HTTPSConnection');
    expect(tokens).toContain('httpsconnection');
    expect(tokens).toContain('https');
    expect(tokens).toContain('connection');
  });

  it('提取中文整段', () => {
    const tokens = tokenizeQuery('用户登录 失败原因');
    expect(tokens).toContain('用户登录');
    expect(tokens).toContain('失败原因');
  });

  it('过滤长度小于 2 的词', () => {
    const tokens = tokenizeQuery('a b c ab');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('b');
    expect(tokens).not.toContain('c');
    expect(tokens).toContain('ab');
  });

  it('去重并限制数量上限', () => {
    const many = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const tokens = tokenizeQuery(many);
    expect(tokens.length).toBeLessThanOrEqual(32);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('空查询返回空数组', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('   ')).toEqual([]);
  });

  it('混合查询同时拿到中英文词', () => {
    const tokens = tokenizeQuery('修复 loginTimeout 配置');
    expect(tokens).toContain('logintimeout');
    expect(tokens).toContain('login');
    expect(tokens).toContain('timeout');
    expect(tokens).toContain('修复');
    expect(tokens).toContain('配置');
  });
});

describe('clampSnippet', () => {
  it('短文本原样返回并去掉行尾换行', () => {
    expect(clampSnippet('hello world\n')).toBe('hello world');
    expect(clampSnippet('abc')).toBe('abc');
  });

  it('超长文本截断并加省略号', () => {
    const long = 'x'.repeat(MAX_SNIPPET_LEN + 50);
    const out = clampSnippet(long);
    expect(out.length).toBe(MAX_SNIPPET_LEN + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('支持自定义长度', () => {
    expect(clampSnippet('abcdefgh', 5)).toBe('abcde…');
  });
});
