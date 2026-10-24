/**
 * 语义检索层（v0.3.0 Phase 3）：TF-IDF + 余弦相似度。
 *
 * 为什么用 TF-IDF 而不是神经网络 Embedding：
 *   1. 全离线硬约束——Embedding 模型要么在线下载（违反部署约束），
 *      要么 vendored（几百 MB 二进制入库不可接受）；
 *   2. 确定性——同一查询同一语料永远得到同一排序，测试可重复；
 *   3. 零依赖——不引入 onnxruntime/transformers.js 等重型依赖；
 *   4. 对代码语料足够好——代码检索的"语义"大量体现在标识符词汇重叠上，
 *      TF-IDF 配合驼峰拆分能覆盖大部分字面不同但含义相近的场景。
 *
 * 算法：
 *   - 文档 = 文件；分词 = 标识符驼峰/下划线拆分 + 普通单词 + 中文段；
 *   - tf 子线性缩放：1 + ln(count)；idf 平滑：ln(1 + N / (1 + df))；
 *   - 相似度 = cosine(query, doc)；
 *   - snippet 取文件内查询词覆盖最高的那一行。
 */

import { clampSnippet, type SearchHit } from './types.js';
import type { WalkedFile } from './walk.js';

export interface SemanticSearchOptions {
  /** 查询词（tokenizeQuery 输出，已小写化） */
  tokens: readonly string[];
  files: readonly WalkedFile[];
  maxHits: number;
  /** 最低相似度阈值（默认 0.01，过滤噪声） */
  minScore?: number;
}

/** 文档分词：产出小写 term 数组（含重复，用于计数） */
export function tokenizeDocument(text: string): string[] {
  const terms: string[] = [];
  const identPattern = /[A-Za-z_][A-Za-z0-9_]*/g;
  const idents = text.match(identPattern) ?? [];
  for (const ident of idents) {
    const lower = ident.toLowerCase();
    if (lower.length >= 2) terms.push(lower);
    for (const seg of ident.split(/[_\s]+/)) {
      const parts = seg.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
      for (const p of parts) {
        const lp = p.toLowerCase();
        if (lp.length >= 2) terms.push(lp);
      }
    }
  }
  const cjk = text.match(/[一-鿿]+/g) ?? [];
  for (const seg of cjk) {
    if (seg.length >= 2) terms.push(seg);
  }
  return terms;
}

interface DocVector {
  file: WalkedFile;
  /** term -> tf-idf 权重（稀疏） */
  weights: Map<string, number>;
  /** 向量范数 */
  norm: number;
  /** term -> 原始计数（snippet 选择用） */
  counts: Map<string, number>;
}

/** 计算语料的逆文档频率表 */
function computeIdf(docs: ReadonlyArray<Map<string, number>>): Map<string, number> {
  const df = new Map<string, number>();
  for (const counts of docs) {
    for (const term of counts.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log(1 + n / (1 + freq)));
  }
  return idf;
}

/** 构造文档向量（子线性 tf * idf） */
function buildDocVector(file: WalkedFile, counts: Map<string, number>, idf: Map<string, number>): DocVector {
  const weights = new Map<string, number>();
  let normSq = 0;
  for (const [term, count] of counts) {
    const termIdf = idf.get(term) ?? 0;
    if (termIdf === 0) continue;
    const w = (1 + Math.log(count)) * termIdf;
    weights.set(term, w);
    normSq += w * w;
  }
  return { file, weights, norm: Math.sqrt(normSq), counts };
}

/** 统计文件分词计数 */
function countTerms(file: WalkedFile): Map<string, number> {
  const counts = new Map<string, number>();
  const terms = tokenizeDocument(file.lines.join('\n'));
  for (const term of terms) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

/** 选出文件中对查询词覆盖最高的一行作为 snippet */
function pickBestLine(file: WalkedFile, queryTokens: ReadonlySet<string>): { line: number; text: string } {
  let bestLine = 0;
  let bestCovered = -1;
  for (let i = 0; i < file.lines.length; i += 1) {
    const raw = file.lines[i] ?? '';
    if (raw.trim().length === 0) continue;
    const lineTerms = new Set(tokenizeDocument(raw));
    let covered = 0;
    for (const token of queryTokens) {
      if (lineTerms.has(token)) covered += 1;
    }
    if (covered > bestCovered) {
      bestCovered = covered;
      bestLine = i + 1;
      if (covered >= queryTokens.size) break;
    }
    if (bestLine === 0) bestLine = i + 1; // 保底：第一个非空行
  }
  return { line: bestLine, text: file.lines[bestLine - 1]?.trim() ?? '' };
}

export function semanticSearch(options: SemanticSearchOptions): SearchHit[] {
  const queryTokens = [...new Set(options.tokens.filter((t) => t.length > 0).map((t) => t.toLowerCase()))];
  if (queryTokens.length === 0 || options.files.length === 0) return [];
  const minScore = options.minScore ?? 0.01;

  // 1. 文档计数 + IDF
  const allCounts = options.files.map(countTerms);
  const idf = computeIdf(allCounts);
  const docs = options.files.map((file, i) => buildDocVector(file, allCounts[i]!, idf));

  // 2. 查询向量（查询词视为一次性出现，tf = 1 + ln(1) = 1）
  const queryWeights = new Map<string, number>();
  let queryNormSq = 0;
  for (const token of queryTokens) {
    const termIdf = idf.get(token);
    if (!termIdf) continue; // 语料中不存在的词对相似度无贡献
    queryWeights.set(token, termIdf);
    queryNormSq += termIdf * termIdf;
  }
  if (queryNormSq === 0) return [];
  const queryNorm = Math.sqrt(queryNormSq);

  // 3. 余弦相似度
  const querySet = new Set(queryTokens);
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    let dot = 0;
    for (const [term, qw] of queryWeights) {
      const dw = doc.weights.get(term);
      if (dw) dot += qw * dw;
    }
    if (dot === 0 || doc.norm === 0) continue;
    const score = dot / (queryNorm * doc.norm);
    if (score < minScore) continue;
    const snippet = pickBestLine(doc.file, querySet);
    hits.push({
      path: doc.file.relPath,
      line: snippet.line,
      snippet: clampSnippet(snippet.text),
      score,
      layer: 'semantic',
    });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return hits.slice(0, Math.max(1, options.maxHits));
}
