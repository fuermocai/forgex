/**
 * 结构符号检索层（v0.3.0 Phase 3）。
 *
 * 为什么用正则而不是 tree-sitter：
 *   - tree-sitter 需要原生绑定与每个语言的 grammar WASM，离线部署链路长；
 *   - 代码检索只需要"符号级"理解（函数/类/导入在哪），不需要完整 AST；
 *   - 正则解析确定性、零依赖、可重复测试——符合项目的确定性优先原则。
 *
 * 支持语言：TypeScript/JavaScript、Python、Go、Rust、Java。
 * 未知后缀的文件直接跳过（由关键词层兜底）。
 *
 * 计分：
 *   match(token, symbol) = 1.0 精确 | 0.8 前缀 | 0.6 子串 | 0.5 驼峰部件命中
 *   score = maxMatch * (0.5 + 0.5 * 命中词覆盖率)
 */
import { clampSnippet, type SearchHit, type SymbolKind } from './types.js';
import type { WalkedFile } from './walk.js';

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  line: number;
  lineText: string;
}

/* ------------------------------------------------------------------ */
/* 各语言符号正则（每条规则：pattern + 捕获组 1 = 符号名 + 类型）            */
/* ------------------------------------------------------------------ */

interface SymbolRule {
  pattern: RegExp;
  kind: SymbolKind;
}

const TS_JS_RULES: SymbolRule[] = [
  { pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/, kind: 'function' },
  { pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: 'type' },
  { pattern: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: 'variable' },
  { pattern: /^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|[A-Za-z_$][\w$]*)?\s*from\s*['"]([^'"]+)['"]/, kind: 'import' },
  { pattern: /^\s*import\s+([A-Za-z_$][\w$]*)\s*from/, kind: 'import' },
  // 类/对象方法（缩进的 name( 形式，排除控制关键字）
  { pattern: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, kind: 'method' },
];

const PYTHON_RULES: SymbolRule[] = [
  { pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function' },
  { pattern: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' },
  { pattern: /^\s*import\s+([A-Za-z_][\w.]*)/, kind: 'import' },
  { pattern: /^\s*from\s+([A-Za-z_][\w.]*)\s+import/, kind: 'import' },
];

const GO_RULES: SymbolRule[] = [
  { pattern: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/, kind: 'method' },
  { pattern: /^func\s+([A-Za-z_]\w*)\s*\(/, kind: 'function' },
  { pattern: /^type\s+([A-Za-z_]\w*)\s+struct/, kind: 'struct' },
  { pattern: /^type\s+([A-Za-z_]\w*)\s+interface/, kind: 'interface' },
  { pattern: /^type\s+([A-Za-z_]\w*)\s+/, kind: 'type' },
];

const RUST_RULES: SymbolRule[] = [
  { pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
  { pattern: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
  { pattern: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
  { pattern: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait' },
  { pattern: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/, kind: 'struct' },
];

const JAVA_RULES: SymbolRule[] = [
  { pattern: /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: 'class' },
  { pattern: /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
  { pattern: /^\s*(?:public\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
  { pattern: /^\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+|final\s+|synchronized\s+)*[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\{/, kind: 'method' },
];

/** 方法匹配时要排除的假阳性（控制流关键字） */
const METHOD_BLOCKLIST = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'this', 'else', 'do']);

function rulesForPath(relPath: string): SymbolRule[] | null {
  const lower = relPath.toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) return TS_JS_RULES;
  if (/\.py$/.test(lower)) return PYTHON_RULES;
  if (/\.go$/.test(lower)) return GO_RULES;
  if (/\.rs$/.test(lower)) return RUST_RULES;
  if (/\.java$/.test(lower)) return JAVA_RULES;
  return null;
}

/* ------------------------------------------------------------------ */
/* 符号提取                                                              */
/* ------------------------------------------------------------------ */

/** 从单个文件提取符号（纯函数） */
export function extractSymbols(file: WalkedFile): SymbolEntry[] {
  const rules = rulesForPath(file.relPath);
  if (!rules) return [];
  const symbols: SymbolEntry[] = [];
  for (let i = 0; i < file.lines.length; i += 1) {
    const line = file.lines[i] ?? '';
    if (line.trim().length === 0) continue;
    for (const rule of rules) {
      const match = line.match(rule.pattern);
      const name = match?.[1];
      if (!name) continue;
      if (rule.kind === 'method' && METHOD_BLOCKLIST.has(name)) continue;
      symbols.push({ name, kind: rule.kind, line: i + 1, lineText: line.trim() });
      break; // 一行只取第一个命中的规则
    }
  }
  return symbols;
}

/* ------------------------------------------------------------------ */
/* 符号匹配与计分                                                        */
/* ------------------------------------------------------------------ */

/** 拆分符号名为部件（驼峰 + 下划线） */
export function splitSymbolName(name: string): string[] {
  const parts: string[] = [];
  for (const seg of name.split(/[_\s]+/)) {
    const sub = seg.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
    parts.push(...sub.map((s) => s.toLowerCase()));
  }
  return parts;
}

/** 单个 token 对符号名的匹配度（0 表示不匹配） */
function matchScore(token: string, symbolName: string): number {
  const lower = symbolName.toLowerCase();
  if (lower === token) return 1.0;
  if (lower.startsWith(token)) return 0.8;
  if (lower.includes(token)) return 0.6;
  const parts = splitSymbolName(symbolName);
  if (parts.includes(token)) return 0.5;
  return 0;
}

export interface StructureSearchOptions {
  tokens: readonly string[];
  files: readonly WalkedFile[];
  maxHits: number;
}

export function structureSearch(options: StructureSearchOptions): SearchHit[] {
  const tokens = options.tokens.filter((t) => t.length > 0).map((t) => t.toLowerCase());
  if (tokens.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const file of options.files) {
    const symbols = extractSymbols(file);
    for (const sym of symbols) {
      let best = 0;
      let covered = 0;
      for (const token of tokens) {
        const s = matchScore(token, sym.name);
        if (s > 0) {
          covered += 1;
          if (s > best) best = s;
        }
      }
      if (best === 0) continue;
      const coverage = covered / tokens.length;
      const score = best * (0.5 + 0.5 * coverage);
      hits.push({
        path: file.relPath,
        line: sym.line,
        snippet: clampSnippet(sym.lineText),
        score,
        layer: 'structure',
        symbol: sym.name,
        symbolKind: sym.kind,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return hits.slice(0, Math.max(1, options.maxHits));
}
