import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createDefaultPolicySettings, WorkspaceGuard } from '@forgex/security';
import type { ToolContext } from '@forgex/shared';
import { BrowserSessionManager, type BrowserAutomationConfig } from '../src/browser/browser-session.js';

const browserCommand = process.env.FORGEX_BROWSER_TEST_COMMAND;

describe('BrowserSessionManager real Chromium smoke test', () => {
  it.skipIf(!browserCommand)('creates an isolated target, applies the host guard, navigates, and closes', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>ForgeX smoke</title><body>local browser target ready</body>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local test server did not bind an ephemeral port');
    const host = `127.0.0.1:${address.port}`;
    const root = process.cwd();
    const settings = createDefaultPolicySettings({ workspaceRoots: [root], mode: 'standard' });
    const ctx: ToolContext = {
      sessionId: 'browser-chrome-smoke',
      workspaceRoot: root,
      cwd: root,
      signal: new AbortController().signal,
      auditId: 'browser-chrome-smoke',
      workspace: new WorkspaceGuard({ roots: [root] }),
      policy: settings,
    };
    const config: BrowserAutomationConfig = { command: browserCommand!, args: [], allowedHosts: [host], timeoutMs: 15_000 };
    const manager = new BrowserSessionManager();
    try {
      const snapshot = await manager.navigate(ctx, config, `http://${host}/`);
      expect(snapshot).toMatchObject({ url: `http://${host}/`, title: 'ForgeX smoke', text: 'local browser target ready' });
      expect(manager.getCurrentUrl(ctx.sessionId)).toBe(`http://${host}/`);
      await manager.close(ctx.sessionId);
      expect(manager.hasSession(ctx.sessionId)).toBe(false);
    } finally {
      await manager.closeAll();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);
});
