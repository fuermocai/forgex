import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ApprovalManager, AuditLogger, MemoryAuditSink, WorkspaceGuard, createDefaultPolicySettings } from '@forgex/security';
import type { ToolDefinition } from '@forgex/shared';
import { EventBus } from '../src/events/event-bus.js';
import { ToolDispatcher } from '../src/runtime/tool-dispatcher.js';
import { ToolRegistry } from '../../tools/src/registry/tool-registry.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forgex-tool-approval-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeDispatcher(approved: boolean, calls: number[], previews: string[], mode: 'standard' | 'yolo' = 'standard') {
  const settings = createDefaultPolicySettings({ workspaceRoots: [root], mode });
  const workspace = new WorkspaceGuard({ roots: [root], writableRoots: [root] });
  const tool: ToolDefinition<Record<string, never>> = {
    name: 'forced_approval',
    description: 'test tool',
    parameters: z.object({}),
    riskLevel: 'execute',
    alwaysRequireApproval: true,
    getApprovalPreview: () => 'trusted approval preview',
    timeoutMs: 2_000,
    maxOutputBytes: 1024,
    async execute() {
      calls.push(1);
      return { ok: true, summary: 'executed' };
    },
  };
  const registry = new ToolRegistry([tool as never]);
  const approvals = new ApprovalManager({ handler: (request) => { previews.push(request.preview ?? ''); return approved; } });
  const audit = new AuditLogger({ sinks: [new MemoryAuditSink()] });
  return new ToolDispatcher({ registry, settings, workspace, approvals, audit, events: new EventBus(), cwd: root });
}

function makeCompletePreviewDispatcher(options: { preview: string; maxChars: number; approved: boolean; calls: number[]; previews: string[]; requests: Array<{ mustReview?: boolean }> }) {
  const settings = createDefaultPolicySettings({ workspaceRoots: [root], mode: 'standard' });
  const workspace = new WorkspaceGuard({ roots: [root], writableRoots: [root] });
  const tool: ToolDefinition<Record<string, never>> = {
    name: 'complete_preview',
    description: 'test tool',
    parameters: z.object({}),
    riskLevel: 'execute',
    alwaysRequireApproval: true,
    requireCompleteApprovalPreview: true,
    maxApprovalPreviewChars: options.maxChars,
    getApprovalPreview: () => options.preview,
    timeoutMs: 2_000,
    maxOutputBytes: 1024,
    async execute() {
      options.calls.push(1);
      return { ok: true, summary: 'executed' };
    },
  };
  const registry = new ToolRegistry([tool as never]);
  const approvals = new ApprovalManager({ handler: (request) => {
    options.previews.push(request.preview ?? '');
    options.requests.push({ mustReview: request.previewMustBeReviewed });
    return options.approved;
  } });
  const audit = new AuditLogger({ sinks: [new MemoryAuditSink()] });
  return new ToolDispatcher({ registry, settings, workspace, approvals, audit, events: new EventBus(), cwd: root });
}

const call = { id: 'call-1', type: 'function' as const, function: { name: 'forced_approval', arguments: '{}' } };

describe('ToolDispatcher mandatory approval', () => {
  it('requests approval in standard mode when the tool requires it', async () => {
    const calls: number[] = [];
    const previews: string[] = [];
    const dispatcher = makeDispatcher(true, calls, previews);
    const result = await dispatcher.execute(call, { sessionId: 'session-a', signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(previews).toEqual(['trusted approval preview']);
  });

  it('yolo mode bypasses even tool-level approval requirements', async () => {
    const calls: number[] = [];
    const previews: string[] = [];
    const dispatcher = makeDispatcher(false, calls, previews, 'yolo');
    const result = await dispatcher.execute(call, { sessionId: 'session-a', signal: new AbortController().signal });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(previews).toEqual([]);
  });

  it('does not execute a mandatory-approval tool after rejection', async () => {
    const calls: number[] = [];
    const previews: string[] = [];
    const dispatcher = makeDispatcher(false, calls, previews);
    const result = await dispatcher.execute(call, { sessionId: 'session-a', signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, error: { code: 'APPROVAL_DENIED' } });
    expect(calls).toHaveLength(0);
    expect(previews).toHaveLength(1);
  });

  it('sends a complete long approval preview without truncation', async () => {
    const previews: string[] = [];
    const requests: Array<{ mustReview?: boolean }> = [];
    const calls: number[] = [];
    const fullPreview = 'x'.repeat(9_000);
    const dispatcher = makeCompletePreviewDispatcher({ preview: fullPreview, maxChars: 10_000, approved: true, calls, previews, requests });
    const result = await dispatcher.execute({ ...call, function: { ...call.function, name: 'complete_preview' } }, { sessionId: 'session-a', signal: new AbortController().signal });

    expect(result.ok).toBe(true);
    expect(previews).toEqual([fullPreview]);
    expect(requests).toEqual([{ mustReview: true }]);
    expect(calls).toHaveLength(1);
  });

  it('refuses approval when a complete preview exceeds its review limit', async () => {
    const previews: string[] = [];
    const requests: Array<{ mustReview?: boolean }> = [];
    const calls: number[] = [];
    const dispatcher = makeCompletePreviewDispatcher({ preview: 'x'.repeat(11), maxChars: 10, approved: true, calls, previews, requests });
    const result = await dispatcher.execute({ ...call, function: { ...call.function, name: 'complete_preview' } }, { sessionId: 'session-a', signal: new AbortController().signal });

    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_FAILED' } });
    expect(previews).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses complete previews whose secret text would otherwise be hidden by redaction', async () => {
    const previews: string[] = [];
    const requests: Array<{ mustReview?: boolean }> = [];
    const calls: number[] = [];
    const dispatcher = makeCompletePreviewDispatcher({ preview: 'const token = "abcdefgh";', maxChars: 100, approved: true, calls, previews, requests });
    const result = await dispatcher.execute({ ...call, function: { ...call.function, name: 'complete_preview' } }, { sessionId: 'session-a', signal: new AbortController().signal });

    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_FAILED' } });
    expect(previews).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('renders terminal control bytes as visible escaped text', async () => {
    const previews: string[] = [];
    const requests: Array<{ mustReview?: boolean }> = [];
    const calls: number[] = [];
    const dispatcher = makeCompletePreviewDispatcher({ preview: 'first\u001b[2J\u0000end', maxChars: 100, approved: true, calls, previews, requests });
    const result = await dispatcher.execute({ ...call, function: { ...call.function, name: 'complete_preview' } }, { sessionId: 'session-a', signal: new AbortController().signal });

    expect(result.ok).toBe(true);
    expect(previews).toEqual(['first\\x1b[2J\\x00end']);
  });
});
