/**
 * 轻量 unified diff 生成器。
 *
 * 为什么自己实现：
 *  - 避免为一次展示引入第三方 diff 库（减少供应链面）；
 *  - 只需覆盖 edit_file 产生的局部修改，不需要完整 git 语义。
 *
 * 算法：先剥离公共前后缀，再对剩余部分做 LCS 动态规划；
 * 规模超过阈值时退化为"整段替换"，保证不会因超大文件卡死。
 */

const MAX_DP_CELLS = 4_000_000;

export interface DiffStat {
  added: number;
  removed: number;
}

interface Op {
  kind: 'equal' | 'add' | 'del';
  text: string;
}

function splitLines(text: string): string[] {
  // 保留行尾换行的语义：末尾换行不产生额外空行
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function toOps(oldLines: string[], newLines: string[]): Op[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }

  const prefix = oldLines.slice(0, start).map<Op>((text) => ({ kind: 'equal', text }));
  const suffix = oldLines.slice(endOld).map<Op>((text) => ({ kind: 'equal', text }));
  const a = oldLines.slice(start, endOld);
  const b = newLines.slice(start, endNew);

  if (a.length === 0 && b.length === 0) return prefix.concat(suffix);
  if (a.length * b.length > MAX_DP_CELLS) {
    const middle: Op[] = [
      ...a.map<Op>((text) => ({ kind: 'del', text })),
      ...b.map<Op>((text) => ({ kind: 'add', text })),
    ];
    return [...prefix, ...middle, ...suffix];
  }

  // LCS 表：lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs: Uint32Array = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + (j + 1)]! + 1
          : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + (j + 1)]!);
    }
  }

  const middle: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      middle.push({ kind: 'equal', text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + (j + 1)]!) {
      middle.push({ kind: 'del', text: a[i]! });
      i += 1;
    } else {
      middle.push({ kind: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    middle.push({ kind: 'del', text: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    middle.push({ kind: 'add', text: b[j]! });
    j += 1;
  }

  return [...prefix, ...middle, ...suffix];
}

/** 统计新增/删除行数 */
export function diffStat(oldText: string, newText: string): DiffStat {
  const ops = toOps(splitLines(oldText), splitLines(newText));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') added += 1;
    else if (op.kind === 'del') removed += 1;
  }
  return { added, removed };
}

/**
 * 生成 unified diff 文本。
 * @param filename 展示用文件名（不参与 IO）
 * @param context 每段 hunk 的上下文行数
 */
export function createUnifiedDiff(
  oldText: string,
  newText: string,
  filename = 'file',
  context = 3,
): { patch: string; stat: DiffStat; hasChanges: boolean } {
  const ops = toOps(splitLines(oldText), splitLines(newText));
  const stat = diffStat(oldText, newText);
  if (stat.added === 0 && stat.removed === 0) {
    return { patch: '', stat, hasChanges: false };
  }

  // 只保留变更附近 context 行的修改索引，并合并相邻区间
  const changed: number[] = [];
  ops.forEach((op, idx) => {
    if (op.kind !== 'equal') changed.push(idx);
  });
  const ranges: Array<[number, number]> = [];
  for (const idx of changed) {
    const from = Math.max(0, idx - context);
    const to = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  const lines: string[] = [`--- a/${filename}`, `+++ b/${filename}`];
  for (const [from, to] of ranges) {
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < from; k += 1) {
      if (ops[k]!.kind !== 'add') oldLine += 1;
      if (ops[k]!.kind !== 'del') newLine += 1;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let k = from; k <= to; k += 1) {
      if (ops[k]!.kind !== 'add') oldCount += 1;
      if (ops[k]!.kind !== 'del') newCount += 1;
    }
    lines.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (let k = from; k <= to; k += 1) {
      const op = ops[k]!;
      const prefix = op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' ';
      lines.push(`${prefix}${op.text}`);
    }
  }
  return { patch: lines.join('\n'), stat, hasChanges: true };
}
