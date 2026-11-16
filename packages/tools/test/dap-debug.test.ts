import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicySettings, ToolContext } from '@forgex/shared';
import { createDefaultPolicySettings, WorkspaceGuard } from '@forgex/security';
import { DapSessionManager, type DebugAdapterConfig } from '../src/debug/dap-client.js';
import { createDapTool } from '../src/debug/dap-tool.js';

let root: string;
let manager: DapSessionManager;
let settings: PolicySettings;

const adapterScript = `
const readline=require('node:readline');
let buffer=Buffer.alloc(0);
function send(message){const body=Buffer.from(JSON.stringify(message));process.stdout.write('Content-Length: '+body.length+'\\r\\n\\r\\n');process.stdout.write(body);}
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const header=buffer.subarray(0,end).toString();const length=Number(/Content-Length: (\\d+)/i.exec(header)[1]);if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);const args=message.arguments||{};let body={};if(message.command==='launch'||message.command==='attach'){send({seq:90,type:'event',event:'initialized',body:{}});}if(message.command==='setBreakpoints')body={breakpoints:[{verified:false,line:args.breakpoints[0].line,message:'fixture breakpoint'}]};if(message.command==='threads')body={threads:[{id:3,name:'main'}]};if(message.command==='stackTrace')body={stackFrames:[{id:4,name:'main',line:1,column:1,source:{name:'sample.py',path:args.path||process.env.FORGEX_TEST_SOURCE}}],totalFrames:1};if(message.command==='scopes')body={scopes:[{name:'Locals',variablesReference:7}]};if(message.command==='variables')body={variables:[{name:'token',value:'ghp_abcdefghijklmnopqrstuvwxyz1234567890',variablesReference:0}]};if(message.command==='continue')body={allThreadsContinued:true};if(message.command==='badRequest'){send({seq:message.seq+100,type:'response',request_seq:message.seq,command:message.command,success:false,message:'fixture adapter error'});continue;}send({seq:message.seq+100,type:'response',request_seq:message.seq,command:message.command,success:true,body});}});
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forgex-dap-'));
  await writeFile(join(root, 'sample.py'), 'print("hello")\n', 'utf8');
  settings = createDefaultPolicySettings({ workspaceRoots: [root], mode: 'standard' });
  manager = new DapSessionManager();
});

afterEach(async () => {
  await manager.closeAll();
  await rm(root, { recursive: true, force: true });
});

function makeCtx(sessionId = 'debug-agent'): ToolContext {
  return {
    sessionId,
    workspaceRoot: root,
    cwd: root,
    signal: new AbortController().signal,
    auditId: 'dap-test',
    workspace: new WorkspaceGuard({ roots: [root], writableRoots: [root], protectedPaths: ['.git'] }),
    policy: settings,
  };
}

function config(overrides: Partial<DebugAdapterConfig> = {}): DebugAdapterConfig {
  return {
    id: 'fake-python',
    extensions: ['.py'],
    command: process.execPath,
    args: ['-e', adapterScript],
    launchArgs: {},
    attachArgs: {},
    ...overrides,
  };
}

describe('DapSessionManager', () => {
  it('requires a complete preview of adapter and launch arguments', () => {
    const adapterArgs = `adapter-${'a'.repeat(9_000)}`;
    const programArgs = `program-${'b'.repeat(9_000)}`;
    const tool = createDapTool([config({ args: [adapterArgs] })], manager);
    const preview = tool.getApprovalPreview?.({ action: 'start', adapterId: 'fake-python', program: 'sample.py', args: [programArgs], breakpoints: [] }, makeCtx()) ?? '';

    expect(tool.requireCompleteApprovalPreview).toBe(true);
    expect(preview).toContain(adapterArgs);
    expect(preview).toContain(programArgs);
  });

  it('launches, reports unverified breakpoints, queries state, and disconnects', async () => {
    const ctx = makeCtx();
    const start = await manager.start(ctx, config(), 'sample.py', [], [{ line: 1 }], {});
    expect(start).toMatchObject({ adapterId: 'fake-python', program: 'sample.py' });
    expect(start.breakpoints).toMatchObject({ breakpoints: [{ verified: false, line: 1 }] });
    expect(await manager.request('debug-agent', 'threads')).toMatchObject({ threads: [{ id: 3, name: 'main' }] });
    const variables = await manager.request('debug-agent', 'variables', { variablesReference: 7 });
    expect(JSON.stringify(variables)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    await manager.close('debug-agent');
    expect(manager.hasSession('debug-agent')).toBe(false);
  });

  it('rejects adapter sources that resolve outside the workspace', async () => {
    const ctx = makeCtx();
    await manager.start(ctx, config(), 'sample.py', [], [], {});
    const outside = await mkdtemp(join(tmpdir(), 'forgex-dap-outside-'));
    try {
      await expect(manager.validateSources([{ source: { path: join(outside, 'secret.py') } }], ctx)).rejects.toMatchObject({ code: 'WORKSPACE_ESCAPE' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('kills the adapter when startup is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = { ...makeCtx(), signal: controller.signal };
    await expect(manager.start(ctx, config(), 'sample.py', [], [], {})).rejects.toMatchObject({ code: 'ABORTED' });
    expect(manager.hasSession(ctx.sessionId)).toBe(false);
  });

  it('supports attach through the DAP attach request', async () => {
    const ctx = makeCtx('attach-agent');
    await manager.attach(ctx, config(), 1234, {});
    expect(manager.hasSession(ctx.sessionId)).toBe(true);
    await manager.close(ctx.sessionId);
  });

  it('surfaces adapter error responses with the DAP command name', async () => {
    const ctx = makeCtx('error-agent');
    await manager.start(ctx, config(), 'sample.py', [], [], {});
    await expect(manager.request(ctx.sessionId, 'badRequest')).rejects.toThrow(/DAP badRequest 失败: fixture adapter error/);
  });

  it('reports a configured adapter that cannot be started', async () => {
    const ctx = makeCtx('missing-adapter');
    await expect(manager.start(ctx, config({ command: join(root, 'missing-adapter.exe'), args: [] }), 'sample.py', [], [], {}))
      .rejects.toThrow(/无法启动 DAP adapter/);
    expect(manager.hasSession(ctx.sessionId)).toBe(false);
  });
});
