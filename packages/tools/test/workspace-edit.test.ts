import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PolicySettings, ToolContext } from '@forgex/shared';
import { createDefaultPolicySettings, WorkspaceGuard } from '@forgex/security';
import { WorkspaceEditPreviewStore } from '../src/lsp/workspace-edit.js';
import { atomicWriteText } from '../src/coding/fs-utils.js';

let root: string;
let settings: PolicySettings;
let store: WorkspaceEditPreviewStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forgex-workspace-edit-'));
  await writeFile(join(root, 'a.ts'), 'const a = "😀";\r\n', 'utf8');
  await writeFile(join(root, 'b.ts'), 'const b = 2;\n', 'utf8');
  settings = createDefaultPolicySettings({ workspaceRoots: [root], mode: 'standard' });
  store = new WorkspaceEditPreviewStore();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeCtx(sessionId = 'session-a'): ToolContext {
  return {
    sessionId,
    workspaceRoot: root,
    cwd: root,
    signal: new AbortController().signal,
    auditId: 'audit-test',
    workspace: new WorkspaceGuard({ roots: [root], writableRoots: [root], protectedPaths: ['.git'] }),
    policy: settings,
  };
}

function fileUri(path: string): string {
  return pathToFileURL(join(root, path)).href;
}

describe('WorkspaceEditPreviewStore', () => {
  it('previews and applies a UTF-16 edit while preserving CRLF', async () => {
    const preview = await store.createPreview({
      changes: {
        [fileUri('a.ts')]: [{ range: { start: { line: 0, character: 11 }, end: { line: 0, character: 13 } }, newText: 'x' }],
      },
    }, makeCtx());

    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]?.diff).toContain('-const a = "😀";');
    const result = await store.apply(preview.previewId, makeCtx());

    expect(result).toMatchObject({ changed: true, files: ['a.ts'] });
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = "x";\r\n');
  });

  it('rejects path traversal after decoding a file URI', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'forgex-outside-'));
    try {
      const uri = pathToFileURL(join(outside, 'secret.ts')).href;
      await expect(store.createPreview({ changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'bad' }] } }, makeCtx()))
        .rejects.toMatchObject({ code: 'WORKSPACE_ESCAPE' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects non-local and duplicate file URIs', async () => {
    const edit = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }];
    await expect(store.createPreview({ changes: { 'https://example.com/a.ts': edit } }, makeCtx())).rejects.toThrow(/file URI/);
    await expect(store.createPreview({ changes: { [fileUri('a.ts')]: edit }, documentChanges: [{ textDocument: { uri: fileUri('a.ts'), version: null }, edits: edit }] }, makeCtx()))
      .rejects.toThrow(/重复/);
  });

  it('decodes encoded file URIs and builds a multi-file diff preview', async () => {
    await writeFile(join(root, 'space file.ts'), 'const value = 1;\n', 'utf8');
    const spaceUri = fileUri('space file.ts');
    const bUri = fileUri('b.ts');
    const preview = await store.createPreview({ changes: {
      [spaceUri]: [{ range: { start: { line: 0, character: 14 }, end: { line: 0, character: 15 } }, newText: '2' }],
      [bUri]: [{ range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, newText: '3' }],
    } }, makeCtx());
    expect(preview.files).toHaveLength(2);
    expect(preview.files.map((file) => file.path)).toEqual(expect.arrayContaining(['space file.ts', 'b.ts']));
    expect(store.approvalPreview(preview.previewId, 'session-a')).toContain('--- space file.ts ---');
    const result = await store.apply(preview.previewId, makeCtx());
    expect(result.files).toEqual(expect.arrayContaining(['space file.ts', 'b.ts']));
  });

  it('rejects stale source content and overlapping ranges', async () => {
    const uri = fileUri('a.ts');
    const edit = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'let' }];
    const preview = await store.createPreview({ changes: { [uri]: edit } }, makeCtx());
    await writeFile(join(root, 'a.ts'), 'changed\n', 'utf8');
    await expect(store.apply(preview.previewId, makeCtx())).rejects.toThrow(/陈旧/);

    await expect(store.createPreview({ changes: { [uri]: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: 'x' },
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: 'y' },
    ] } }, makeCtx())).rejects.toThrow(/重叠/);
  });

  it('rejects an LSP document version that does not match the opened snapshot', async () => {
    const uri = fileUri('a.ts');
    const edit = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }];
    await expect(store.createPreview({ documentChanges: [{ textDocument: { uri, version: 2 }, edits: edit }] }, makeCtx(), new Map([[uri, { text: 'const a = "😀";\r\n', version: 1 }]])))
      .rejects.toThrow(/文档版本已过期/);
  });

  it('rejects versioned edits when no matching LSP snapshot is available', async () => {
    const uri = fileUri('b.ts');
    const edit = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }];
    await expect(store.createPreview({ documentChanges: [{ textDocument: { uri, version: 2 }, edits: edit }] }, makeCtx()))
      .rejects.toThrow(/无法核对 WorkspaceEdit 文档版本/);
  });

  it('refuses diffs that cannot fit in a complete approval preview', async () => {
    await writeFile(join(root, 'large.ts'), `${'a'.repeat(70_000)}\n`, 'utf8');
    const uri = fileUri('large.ts');
    const edit = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'b' }];
    await expect(store.createPreview({ changes: { [uri]: edit } }, makeCtx()))
      .rejects.toThrow(/超过 64000 字符，无法完整审批/);
  });

  it('rolls back earlier files when a later atomic write fails', async () => {
    const failingStore = new WorkspaceEditPreviewStore({
      writeText: async (path, text) => {
        if (path.endsWith('c.ts')) throw new Error('fixture write failure');
        return atomicWriteText(path, text);
      },
    });
    const uriA = fileUri('a.ts');
    const uriB = fileUri('b.ts');
    const uriC = fileUri('c.ts');
    await writeFile(join(root, 'c.ts'), 'const c = 4;\n', 'utf8');
    const editA = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'const' }];
    const editB = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } }, newText: 'changed b' }];
    const editC = [{ range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, newText: '5' }];
    const preview = await failingStore.createPreview({ changes: { [uriA]: editA, [uriB]: editB, [uriC]: editC } }, makeCtx());
    await expect(failingStore.apply(preview.previewId, makeCtx())).rejects.toThrow(/c.ts.*fixture write failure.*已回滚/);
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = "😀";\r\n');
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('const b = 2;\n');
    expect(await readFile(join(root, 'c.ts'), 'utf8')).toBe('const c = 4;\n');
  });

  it('keeps previews isolated by agent session', async () => {
    const preview = await store.createPreview({ changes: { [fileUri('a.ts')]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'let' }] } }, makeCtx());
    await expect(store.apply(preview.previewId, makeCtx('session-b'))).rejects.toThrow(/不存在或已过期/);
  });
});
