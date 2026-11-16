import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { createUnifiedDiff } from '@forgex/shared';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';
import { atomicWriteText, readWholeText, toWorkspaceRelative } from './fs-utils.js';

const inputSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  lineHash: z.string().regex(/^[a-f0-9]{12}$/),
  newText: z.string().refine((value) => !/[\r\n]/.test(value), 'newText must contain exactly one line'),
});

type Input = z.infer<typeof inputSchema>;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export function createHashlineEditTool(): ToolDefinition<Input> {
  return {
    name: 'edit_file_hashline',
    description: 'Replace one complete line using the line number and hash returned by read_file. Stale hashes are rejected before writing.',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'write',
    timeoutMs: 15_000,
    maxOutputBytes: 200 * 1024,
    tags: ['coding', 'write'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        const absPath = await ctx.workspace.resolve(input.path, 'write', ctx.cwd);
        const original = await readWholeText(absPath, MAX_EDIT_BYTES);
        const lines = splitLinesPreservingEndings(original);
        const index = input.line - 1;
        const currentLine = lines[index]?.text;
        if (currentLine === undefined || hashLine(currentLine) !== input.lineHash) {
          return toolError('TOOL_FAILED', 'Hashline anchor is stale or does not match. Read the current line and retry.', {
            details: { path: input.path, line: input.line },
          });
        }

        const updatedLines = [...lines];
        updatedLines[index] = { ...updatedLines[index]!, text: input.newText };
        const updated = updatedLines.map((line) => line.text + line.ending).join('');
        if (updated === original) return toolOk('Line is unchanged', { path: input.path, changed: false });

        const rel = toWorkspaceRelative(ctx.workspaceRoot, absPath);
        const diff = createUnifiedDiff(original, updated, rel);
        const bytesWritten = await atomicWriteText(absPath, updated);
        return toolOk(`Updated ${rel}`, {
          path: rel,
          line: input.line,
          changed: true,
          contentHash: hashContent(await readWholeText(absPath, MAX_EDIT_BYTES)),
          added: diff.stat.added,
          removed: diff.stat.removed,
          diff: diff.patch,
          bytesWritten,
        });
      } catch (error) {
        return errorToOutcome(error);
      }
    },
  };
}

function splitLinesPreservingEndings(content: string): Array<{ text: string; ending: string }> {
  const lines: Array<{ text: string; ending: string }> = [];
  const lineEnding = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = lineEnding.exec(content)) !== null) {
    lines.push({ text: content.slice(start, match.index), ending: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: content.slice(start), ending: '' });
  return lines;
}

function hashLine(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex').slice(0, 12);
}

function hashContent(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}
