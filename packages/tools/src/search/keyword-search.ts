/**
 * 关键词检索层（v0.3.0 Phase 3）。
 *
 * 策略（纯函数、确定性）：
 *   - 对每行做子串匹配（默认不区分大小写）；
 *   - 得分 = 0.7 * 词覆盖率 + 0.3 * 频次加成：
 *       覆盖率 = 该行命中的不同查询词数 / 查询词总数
 *       频次加成 = min(1, 该行命中总次数 / 5)
 *   - 只保留得分 > 0 的行，按得分降序输出，最多 maxHits 条。
 *
 * 为什么不用正则逐词匹配：查询词来自 tokenizeQuery（已转义为纯文本），
 * 子串匹配对"getUserName"查询能命中 "getUserNameById"——这恰恰是
 * 代码检索想要的行为；正则词边界反而会漏掉这类部分匹配。
 */
import { clampSnippet, type SearchHit } from './types.js';
import type { WalkedFile } from './walk.js';

export interface KeywordSearchOptions {
  /** 查询词（tokenizeQuery 输出，已小写化） */
  tokens: readonly string[];
  /** 已遍历好的文件 */
  files: readonly WalkedFile[];
  /** 是否区分大小写（默认 false） */
  caseSensitive?: boolean;
  /** 最多返回多少条 */
  maxHits: number;
}

const COVERAGE_WEIGHT = 0.7;
const FREQ_WEIGHT = 0.3;
const FREQ_SATURATION = 5;

export function keywordSearch(options: KeywordSearchOptions): SearchHit[] {
  const tokens = options.tokens.filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const caseSensitive = options.caseSensitive ?? false;
  const needles = caseSensitive ? tokens : tokens.map((t) => t.toLowerCase());

  const hits: SearchHit[] = [];
  for (const file of options.files) {
    for (let i = 0; i < file.lines.length; i += 1) {
      const rawLine = file.lines[i] ?? '';
      if (rawLine.trim().length === 0) continue;
      const haystack = caseSensitive ? rawLine : rawLine.toLowerCase();

      let covered = 0;
      let totalOccurrences = 0;
      for (const needle of needles) {
        const count = countOccurrences(haystack, needle);
        if (count > 0) {
          covered += 1;
          totalOccurrences += count;
        }
      }
      if (covered === 0) continue;

      const coverage = covered / needles.length;
      const freqBonus = Math.min(1, totalOccurrences / FREQ_SATURATION);
      const score = COVERAGE_WEIGHT * coverage + FREQ_WEIGHT * freqBonus;
      hits.push({
        path: file.relPath,
        line: i + 1,
        snippet: clampSnippet(rawLine.trim()),
        score,
        layer: 'keyword',
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return hits.slice(0, Math.max(1, options.maxHits));
}

/** 统计子串出现次数（非重叠） */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return count;
    count += 1;
    from = idx + needle.length;
  }
}
