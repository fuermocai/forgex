/**
 * forgex sessions：查看历史会话。
 */
import { existsSync } from 'node:fs';
import { stdout } from 'node:process';
import { SessionStore } from '@forgex/core';
import { flagNumber, flagString, type ParsedArgs } from '../args.js';
import { loadConfig } from '../config/load-config.js';

export function sessionsCommand(args: ParsedArgs, options: { cwd: string }): number {
  const loaded = loadConfig({
    cwd: options.cwd,
    ...(flagString(args.flags, 'config') ? { configPath: flagString(args.flags, 'config')! } : {}),
  });
  const dbPath = loaded.config.session.dbPath;
  const action = args.positionals[0];
  const sourceId = args.positionals[1];
  if (!existsSync(dbPath) && action !== 'fork') {
    stdout.write(`会话事件日志尚未创建: ${dbPath}\n`);
    return 0;
  }

  const limit = flagNumber(args.flags, 'limit') ?? 20;
  const store = new SessionStore(dbPath);
  try {
    if (action === 'fork') {
      if (!sourceId) {
        stdout.write('用法: forgex sessions fork <sessionId> [--at <messageEventId>]\n');
        return 2;
      }
      const branch = store.forkSession(sourceId, flagString(args.flags, 'at'));
      stdout.write(`已创建会话分支: ${branch.id}\n继续使用: forgex chat --session ${branch.id}\n`);
      return 0;
    }
    const sessions = store.listSessions(limit);
    if (sessions.length === 0) {
      stdout.write('暂无会话记录\n');
      return 0;
    }
    stdout.write(`最近 ${sessions.length} 个会话（事件日志: ${dbPath}）\n\n`);
    for (const session of sessions) {
      const title = session.title ?? '(未命名)';
      stdout.write(`${session.id}  ${session.updatedAt}  ${session.model}  ${title}\n`);
    }
    stdout.write('\n使用 forgex chat --session <id> 恢复会话；forgex run --session <id> "..." 继续任务。\n');
    return 0;
  } finally {
    store.close();
  }
}
