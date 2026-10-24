/**
 * 混合检索类型定义（v0.3.0 Phase 3）。
 *
 * 设计原则：
 *   1. 纯类型 + 纯函数文件，零外部运行时依赖；
 *   2. 三层检索各司其职：
 *      - keyword  关键词层：精确正则匹配，快、准确定位字面量；
 *      - structure 结构层：符号（函数/类/导入）匹配，理解代码骨架；
 *      - semantic 语义层：TF-IDF + 余弦相似度，处理"意思相近但字面不同"的查询；
 *   3. 全离线：不依赖 ripgrep 二进制（可选加速）、不下载 Embedding 模型，
 *      语义层用确定性 TF-IDF，保证离线部署与可重复测试；
 *   4. 融合用 RRF（Reciprocal Rank Fusion）：不需要跨层校准分数尺度，
 *      只用名次融合，对异常分数稳健。
 */

/* ------------------------------------------------------------------ */
/* 检索层                                                              */
/* ------------------------------------------------------------------ */

export const SEARCH_LAYERS = ['keyword', 'structure', 'semantic'] as const;
export type SearchLayer = (typeof SEARCH_LAYERS)[number];

export function isSearchLayer(value: unknown): value is SearchLayer {
  return typeof value === 'string' && (SEARCH_LAYERS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* 符号类型（结构层）                                                    */
/* ------------------------------------------------------------------ */

export const SYMBOL_KINDS = [
  'function',
  'class',
  'interface',
  'type',
  'variable',
  'import',
  'method',
  'struct',
  'enum',
  'trait',
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/* ------------------------------------------------------------------ */
/* 单层命中                                                             */
/* ------------------------------------------------------------------ */

/** 单个检索层产生的一条命中 */
export interface SearchHit {
  /** 相对搜索根的路径（统一 / 分隔） */
  path: string;
  /** 行号（1 开始）；语义层按文件粒度命中时为 0 */
  line: number;
  /** 命中行内容或文件摘要片段（已截断到安全长度） */
  snippet: string;
  /** 本层得分，归一化到 (0, 1] */
  score: number;
  /** 产生该命中的层 */
  layer: SearchLayer;
  /** 结构层特有：符号名 */
  symbol?: string;
  /** 结构层特有：符号类型 */
  symbolKind?: SymbolKind;
}

/* ------------------------------------------------------------------ */
/* 查询与结果                                                           */
/* ------------------------------------------------------------------ */

/** 混合检索查询参数 */
export interface HybridSearchQuery {
  /** 自然语言或关键词查询（会被分词） */
  query: string;
  /** 搜索根目录（绝对路径，调用方需已通过 WorkspaceGuard 校验） */
  root: string;
  /** 文件名 glob 过滤，例如 *.ts 或 **\/*.py */
  glob?: string;
  /** 每层最多返回多少条（默认 20） */
  maxPerLayer?: number;
  /** 融合后最多返回多少条（默认 30） */
  maxResults?: number;
  /** 启用哪些层（默认全开） */
  layers?: readonly SearchLayer[];
  /** 关键词层是否区分大小写（默认 false） */
  caseSensitive?: boolean;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 融合后的单条命中 */
export interface FusedHit {
  path: string;
  line: number;
  snippet: string;
  /** RRF 融合得分（越大越相关） */
  fusedScore: number;
  /** 各层贡献明细（哪一层、原始得分、层内名次） */
  contributions: Array<{ layer: SearchLayer; score: number; rank: number }>;
  symbol?: string;
  symbolKind?: SymbolKind;
}

/** 单层执行统计 */
export interface LayerStat {
  enabled: boolean;
  hitCount: number;
  durationMs: number;
}

/** 混合检索最终结果 */
export interface HybridSearchResult {
  hits: FusedHit[];
  layerStats: Record<SearchLayer, LayerStat>;
  /** 任一中间层因上限截断 */
  truncated: boolean;
  /** 实际扫描的文件数（取各层最大值） */
  scannedFiles: number;
}

/* ------------------------------------------------------------------ */
/* 常量与工具函数                                                        */
/* ------------------------------------------------------------------ */

/** RRF 平滑常数（经典取值 60） */
export const RRF_K = 60;

/** snippet 最大长度，避免把超长行塞进结果 */
export const MAX_SNIPPET_LEN = 300;

/** 单文件大小上限（与 grep-fallback 一致） */
export const MAX_FILE_BYTES = 1024 * 1024;

/** 扫描文件数上限 */
export const MAX_SCAN_FILES = 2000;

/** 遍历目录深度上限 */
export const MAX_WALK_DEPTH = 12;

/** 跳过的目录名（与 grep-fallback 保持一致） */
export const SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.forgex',
  'node_modules',
  'dist',
  'build',
  'target',
  '.venv',
  '__pycache__',
  'coverage',
  '.next',
]);

/**
 * 从自然语言查询中提取检索词。
 *
 * 规则：
 *   - 提取驼峰/下划线标识符并拆分（getUserName -> get, user, name, getUserName 保留原词）；
 *   - 提取普通单词（含中文按整段处理）；
 *   - 转小写去重，过滤长度 < 2 的词；
 *   - 上限 32 个词，避免超大查询拖慢 TF-IDF。
 */
export function tokenizeQuery(query: string): string[] {
  const tokens = new Set<string>();
  // 标识符（含驼峰与下划线）
  const identPattern = /[A-Za-z_][A-Za-z0-9_]*/g;
  const idents = query.match(identPattern) ?? [];
  for (const ident of idents) {
    const lower = ident.toLowerCase();
    if (lower.length >= 2) tokens.add(lower);
    // 驼峰 + 下划线拆分
    for (const part of ident.split(/[_\s]+/)) {
      const sub = part.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
      for (const piece of sub) {
        const p = piece.toLowerCase();
        if (p.length >= 2) tokens.add(p);
      }
    }
  }
  // 中文/其他非 ASCII 连续段（按整段加入，语义层用）
  const cjkPattern = /[一-鿿]+/g;
  const cjk = query.match(cjkPattern) ?? [];
  for (const seg of cjk) {
    if (seg.length >= 2) tokens.add(seg);
  }
  return [...tokens].slice(0, 32);
}

/** 截断 snippet 到安全长度 */
export function clampSnippet(text: string, maxLen: number = MAX_SNIPPET_LEN): string {
  const clean = text.replace(/\r?\n$/, '');
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}
