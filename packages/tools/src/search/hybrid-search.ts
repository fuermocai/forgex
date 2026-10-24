/**
 * 混合检索编排引擎（v0.3.0 Phase 3）。
 *
 * 流程：
 *   1. walkTextFiles 遍历一次文件（三层共享同一份语料，避免 IO 重复）；
 *   2. tokenizeQuery 把自然语言查询拆成检索词；
 *   3. 依次跑 keyword / structure / semantic 三层（CPU 密集、毫秒级，串行即可）；
 *   4. fuseHits 用 RRF 融合；
 *   5. 返回带各层统计的 HybridSearchResult。
 *
 * 每层可独立开关（layers 参数），用于消融实验与调试。
 */
import { keywordSearch } from './keyword-search.js';
import { structureSearch } from './structure-search.js';
import { semanticSearch } from './semantic-search.js';
import { fuseHits } from './fusion.js';
import { walkTextFiles } from './walk.js';
import {
  SEARCH_LAYERS,
  tokenizeQuery,
  type HybridSearchQuery,
  type HybridSearchResult,
  type LayerStat,
  type SearchHit,
  type SearchLayer,
} from './types.js';

const DEFAULT_MAX_PER_LAYER = 20;
const DEFAULT_MAX_RESULTS = 30;

export async function hybridSearch(query: HybridSearchQuery): Promise<HybridSearchResult> {
  const maxPerLayer = Math.max(1, query.maxPerLayer ?? DEFAULT_MAX_PER_LAYER);
  const maxResults = Math.max(1, query.maxResults ?? DEFAULT_MAX_RESULTS);
  const enabledLayers: readonly SearchLayer[] = query.layers ?? SEARCH_LAYERS;
  const tokens = tokenizeQuery(query.query);

  const layerStats: Record<SearchLayer, LayerStat> = {
    keyword: { enabled: enabledLayers.includes('keyword'), hitCount: 0, durationMs: 0 },
    structure: { enabled: enabledLayers.includes('structure'), hitCount: 0, durationMs: 0 },
    semantic: { enabled: enabledLayers.includes('semantic'), hitCount: 0, durationMs: 0 },
  };

  // 无有效检索词时直接返回空结果（仍然给出层统计，便于调用方诊断）
  if (tokens.length === 0) {
    return { hits: [], layerStats, truncated: false, scannedFiles: 0 };
  }

  const walked = await walkTextFiles({
    root: query.root,
    ...(query.glob ? { glob: query.glob } : {}),
    ...(query.signal ? { signal: query.signal } : {}),
  });

  const layerHits: Array<{ layer: SearchLayer; hits: SearchHit[] }> = [];

  const runLayer = (layer: SearchLayer, fn: () => SearchHit[]): void => {
    if (!enabledLayers.includes(layer)) return;
    const started = Date.now();
    const hits = fn();
    layerStats[layer].durationMs = Date.now() - started;
    layerStats[layer].hitCount = hits.length;
    layerHits.push({ layer, hits });
  };

  runLayer('keyword', () =>
    keywordSearch({
      tokens,
      files: walked.files,
      ...(query.caseSensitive !== undefined ? { caseSensitive: query.caseSensitive } : {}),
      maxHits: maxPerLayer,
    }),
  );
  runLayer('structure', () => structureSearch({ tokens, files: walked.files, maxHits: maxPerLayer }));
  runLayer('semantic', () => semanticSearch({ tokens, files: walked.files, maxHits: maxPerLayer }));

  const hits = fuseHits({ layerHits, maxResults });

  return {
    hits,
    layerStats,
    truncated: walked.truncated || hits.length >= maxResults,
    scannedFiles: walked.files.length,
  };
}
