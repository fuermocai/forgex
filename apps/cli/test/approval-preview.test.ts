import { describe, expect, it } from 'vitest';
import { paginateApprovalPreview } from '../src/ui/approval-preview.js';

describe('paginateApprovalPreview', () => {
  it('keeps every preview character while wrapping long lines and respecting page height', () => {
    const preview = `开始${'界'.repeat(30)}\nline two\n`;
    const pages = paginateApprovalPreview(preview, 8, 2);
    const reconstructed = pages.flat().map((line) => `${line.text}${line.newline ? '\n' : ''}`).join('');

    expect(reconstructed).toBe(preview);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 2)).toBe(true);
    expect(pages.flat().some((line) => line.continuesPrevious)).toBe(true);
  });

  it('represents an empty preview as one visible row', () => {
    expect(paginateApprovalPreview('', 80, 8)).toEqual([[{ text: '', continuesPrevious: false, newline: false }]]);
  });
});
