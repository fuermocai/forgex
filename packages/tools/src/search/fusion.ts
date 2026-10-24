/**
 * RRF 融合层（v0.3.0 Phase 3）。
 *
 * 为什么用 Reciprocal Rank Fusion 而不是加权分数融合：
 *   - 三层分数尺度不同（关键词 0~1、结构 0~1、TF-IDF 余弦 0~1 但分布差异大），
 *     直接加权需要跨层校准，脆弱且依赖调参；
 *   - RRF 只用名次：score = Σ 1/(k + rank)，对单层的异常高分天然稳健；
 *   - k=60 是信息检索文献的经典取值，已沉淀为 SEARCH constants。
 *
 * 去重键：path + line——同一行被多层命中时合并为一条，保留各层贡献明细。
 */
import { RRF_K, type FusedHit, type SearchHit, type SearchLayer } from './types.js';

export interface FusionInput {
  /** 各层已按得分降序排好的命中 */
  layerHits: ReadonlyArray<{ layer: SearchLayer; hits: readonly SearchHit[] }>;
  /** 融合后最多返回多少条 */
  maxResults: number;
}

export function fuseHits(input: FusionInput): FusedHit[] {
  /** key = `${path}:${line}` */
  const merged = new Map<string, {
    path: string;
    line: number;
    snippet: string;
    fusedScore: number;
    contributions: Array<{ layer: SearchLayer; score: number; rank: number }>;
    symbol?: string;
    symbolKind?: FusedHit['symbolKind'];
    /** 用于稳定排序：最大单层得分 */
    bestLayerScore: number;
  }>();

  for (const { layer, hits } of input.layerHits) {
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i]!;
      const rank = i + 1;
      const key = `${hit.path}:${hit.line}`;
      const rrf = 1 / (RRF_K + rank);
      const existing = merged.get(key);
      if (existing) {
        existing.fusedScore += rrf;
        existing.contributions.push({ layer, score: hit.score, rank });
        if (hit.score > existing.bestLayerScore) {
          existing.bestLayerScore = hit.score;
          existing.snippet = hit.snippet;
        }
        // 结构层符号信息优先保留
        if (!existing.symbol && hit.symbol) {
          existing.symbol = hit.symbol;
          if (hit.symbolKind) existing.symbolKind = hit.symbolKind;
        }
      } else {
        merged.set(key, {
          path: hit.path,
          line: hit.line,
          snippet: hit.snippet,
          fusedScore: rrf,
          contributions: [{ layer, score: hit.score, rank }],
          ...(hit.symbol ? { symbol: hit.symbol } : {}),
          ...(hit.symbolKind ? { symbolKind: hit.symbolKind } : {}),
          bestLayerScore: hit.score,
        });
      }
    }
  }

  const fused = [...merged.values()];
  // 排序：融合得分降序 -> 最大单层得分降序 -> 路径 -> 行号（完全确定性）
  fused.sort(
    (a, b) =>
      b.fusedScore - a.fusedScore ||
      b.bestLayerScore - a.bestLayerScore ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );

  return fused.slice(0, Math.max(1, input.maxResults)).map((entry) => ({
    path: entry.path,
    line: entry.line,
    snippet: entry.snippet,
    fusedScore: entry.fusedScore,
    contributions: entry.contributions,
    ...(entry.symbol ? { symbol: entry.symbol } : {}),
    ...(entry.symbolKind ? { symbolKind: entry.symbolKind } : {}),
  }));
}
