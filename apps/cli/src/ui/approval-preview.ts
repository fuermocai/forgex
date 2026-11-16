export interface ApprovalPreviewLine {
  text: string;
  continuesPrevious: boolean;
  newline: boolean;
}

/** Splits an approval preview into terminal-sized rows without dropping source characters. */
export function paginateApprovalPreview(preview: string, width: number, rowsPerPage: number): ApprovalPreviewLine[][] {
  const lineWidth = Math.max(1, Math.floor(width));
  const pageHeight = Math.max(1, Math.floor(rowsPerPage));
  const sourceLines = preview.split('\n');
  const displayLines: ApprovalPreviewLine[] = [];

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const sourceLine = sourceLines[lineIndex]!;
    const chars = Array.from(sourceLine);
    const hasNewline = lineIndex < sourceLines.length - 1;
    if (chars.length === 0) {
      displayLines.push({ text: '', continuesPrevious: false, newline: hasNewline });
      continue;
    }

    let text = '';
    let cells = 0;
    let segmentIndex = 0;
    for (const character of chars) {
      const characterCells = terminalCells(character);
      if (text.length > 0 && cells + characterCells > lineWidth) {
        displayLines.push({ text, continuesPrevious: segmentIndex > 0, newline: false });
        text = '';
        cells = 0;
        segmentIndex += 1;
      }
      text += character;
      cells += characterCells;
    }
    displayLines.push({ text, continuesPrevious: segmentIndex > 0, newline: hasNewline });
  }

  const pages: ApprovalPreviewLine[][] = [];
  for (let index = 0; index < displayLines.length; index += pageHeight) {
    pages.push(displayLines.slice(index, index + pageHeight));
  }
  return pages.length > 0 ? pages : [[{ text: '', continuesPrevious: false, newline: false }]];
}

function terminalCells(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(character) || codePoint === 0xfe0f || codePoint === 0x200d) return 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}
