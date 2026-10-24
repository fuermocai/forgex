/**
 * fusion.ts（RRF）单元测试。
 */
import { describe, expect, it } from 'vitest';
import { fuseHits } from '../src/search/fusion.js';
import { RRF_K, type SearchHit } from '../src/search/types.js';

function hit(path: string, line: number, score: number, layer: SearchHit['layer'], symbol?: string): SearchHit {
  return {
    path,
    line,
    snippet: `${path}:${line}`,
    score,
    layer,
    ...(symbol ? { symbol, symbolKind: 'function' as const } : {}),
  };
}

describe('fuseHits', () => {
  it('单层命中按 RRF 公式计分', () => {
    const fused = fuseHits({
      layerHits: [{ layer: 'keyword', hits: [hit('a.ts', 1, 0.9, 'keyword')] }],
      maxResults: 10,
    });
    expect(fused).toHaveLength(1);
    expect(fused[0]!.fusedScore).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(fused[0]!.contributions).toEqual([{ layer: 'keyword', score: 0.9, rank: 1 }]);
  });

  it('同一行被多层命中时合并并累加 RRF 分', () => {
    const fused = fuseHits({
      layerHits: [
        { layer: 'keyword', hits: [hit('a.ts', 5, 0.8, 'keyword')] },
        { layer: 'semantic', hits: [hit('a.ts', 5, 0.6, 'semantic')] },
      ],
      maxResults: 10,
    });
    expect(fused).toHaveLength(1);
    expect(fused[0]!.fusedScore).toBeCloseTo(2 / (RRF_K + 1), 10);
    expect(fused[0]!.contributions).toHaveLength(2);
  });

  it('多层都命中的条目排在单层命中之前', () => {
    const fused = fuseHits({
      layerHits: [
        { layer: 'keyword', hits: [hit('solo.ts', 1, 0.99, 'keyword'), hit('both.ts', 2, 0.5, 'keyword')] },
        { layer: 'structure', hits: [hit('both.ts', 2, 0.9, 'structure', 'demo')] },
      ],
      maxResults: 10,
    });
    expect(fused[0]!.path).toBe('both.ts');
    expect(fused[1]!.path).toBe('solo.ts');
  });

  it('不同行号视为不同条目', () => {
    const fused = fuseHits({
      layerHits: [
        { layer: 'keyword', hits: [hit('a.ts', 1, 0.9, 'keyword')] },
        { layer: 'semantic', hits: [hit('a.ts', 2, 0.9, 'semantic')] },
      ],
      maxResults: 10,
    });
    expect(fused).toHaveLength(2);
  });

  it('结构层符号信息在合并后保留', () => {
    const fused = fuseHits({
      layerHits: [
        { layer: 'keyword', hits: [hit('a.ts', 3, 0.7, 'keyword')] },
        { layer: 'structure', hits: [hit('a.ts', 3, 0.95, 'structure', 'myFunc')] },
      ],
      maxResults: 10,
    });
    expect(fused[0]!.symbol).toBe('myFunc');
    expect(fused[0]!.symbolKind).toBe('function');
  });

  it('遵守 maxResults 上限', () => {
    const many = Array.from({ length: 50 }, (_, i) => hit(`f${i}.ts`, 1, 0.5, 'keyword'));
    const fused = fuseHits({ layerHits: [{ layer: 'keyword', hits: many }], maxResults: 8 });
    expect(fused).toHaveLength(8);
  });

  it('名次越靠前 RRF 贡献越大', () => {
    const fused = fuseHits({
      layerHits: [
        { layer: 'keyword', hits: [hit('top.ts', 1, 0.5, 'keyword'), hit('low.ts', 1, 0.99, 'keyword')] },
      ],
      maxResults: 10,
    });
    // top.ts 单层得分低但名次第一，fusedScore 仍高于 low.ts
    expect(fused[0]!.path).toBe('top.ts');
    expect(fused[0]!.fusedScore).toBeGreaterThan(fused[1]!.fusedScore);
  });

  it('空输入返回空数组', () => {
    expect(fuseHits({ layerHits: [], maxResults: 10 })).toEqual([]);
    expect(fuseHits({ layerHits: [{ layer: 'keyword', hits: [] }], maxResults: 10 })).toEqual([]);
  });
});
