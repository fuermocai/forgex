/**
 * forgex doctor：环境自检。
 *
 * 全部检查都是真实执行（读取版本、访问文件、调用系统命令），
 * 不使用任何预置的健康状态。用于部署前确认内网环境是否满足运行条件。
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { stdout } from 'node:process';
import { getMemory, listProcesses } from '@forgex/devops';
import { createBuiltinTools, ToolRegistry } from '@forgex/tools';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { loadConfig, type ApiKeySource } from '../config/load-config.js';
import { PERMISSION_MODE_LABELS } from '../config/permission-mode.js';
import { maskKey } from '../runtime/connect-core.js';

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  detail: string;
}

export async function doctorCommand(args: ParsedArgs, options: { cwd: string }): Promise<number> {
  const checks: Check[] = [];
  const full = flagBool(args.flags, 'full');

  // 1. Node 版本
  const major = Number(process.versions.node.split('.')[0] ?? '0');
  checks.push({
    name: 'Node.js',
    status: major >= 22 ? 'ok' : 'fail',
    detail: `${process.version}${major >= 22 ? '' : '（需要 >= 22）'}`,
  });

  // 2. 平台
  checks.push({
    name: '平台',
    status: process.platform === 'linux' || process.platform === 'win32' ? 'ok' : 'warn',
    detail: `${process.platform} ${process.arch}`,
  });

  // 3. 配置
  let loaded: ReturnType<typeof loadConfig> | null = null;
  try {
    loaded = loadConfig({
      cwd: options.cwd,
      ...(flagString(args.flags, 'config') ? { configPath: flagString(args.flags, 'config')! } : {}),
      ...(flagString(args.flags, 'mode') ? { permissionMode: flagString(args.flags, 'mode')! } : {}),
    });
    checks.push({
      name: '配置文件',
      status: 'ok',
      detail: loaded.configPath ?? '未找到（使用默认值，需通过环境变量提供模型配置）',
    });
    checks.push({
      name: '模型配置',
      status: loaded.modelConfigured ? 'ok' : 'warn',
      detail: loaded.modelConfigured
        ? `${loaded.config.model.model} @ ${loaded.config.model.baseUrl}`
        : '未配置 baseUrl/model，chat/run 不可用',
    });
    // Key 单独一项：既能回答"到底配没配"，也能回答"重启后从哪读的"
    // ——排查「填了一次重开又没了」时，看来源比看有没有更直接。
    const apiKey = loaded.config.model.apiKey;
    const keyEnv = loaded.config.model.apiKeyEnv ?? 'FORGEX_API_KEY';
    const sourceLabel: Record<Exclude<ApiKeySource, null>, string> = {
      env: '环境变量',
      credentials: `凭据文件 ${loaded.credentialsPath}`,
      file: '配置文件明文（建议改用 /key 或环境变量）',
    };
    checks.push({
      name: 'API Key',
      status: apiKey ? (loaded.apiKeySource === 'file' ? 'warn' : 'ok') : 'warn',
      detail: apiKey
        ? `${maskKey(apiKey)}（${loaded.apiKeySource ? sourceLabel[loaded.apiKeySource] : '来源未知'}）`
        : `未配置：/key <API Key> 或 export ${keyEnv}=...（凭据文件路径 ${loaded.credentialsPath}）`,
    });
    // 权限模式直接决定"能不能动手"，自检时必须让它可见：yolo 单独告警
    checks.push({
      name: '权限模式',
      status: loaded.config.security.mode === 'yolo' ? 'warn' : 'ok',
      detail: `${loaded.config.security.mode} — ${PERMISSION_MODE_LABELS[loaded.config.security.mode]}`,
    });
  } catch (err) {
    checks.push({ name: '配置文件', status: 'fail', detail: err instanceof Error ? err.message : String(err) });
  }

  // 4. 工作区
  if (loaded) {
    const root = loaded.config.security.workspaceRoots[0]!;
    try {
      accessSync(root, constants.R_OK);
      let writable = true;
      try {
        accessSync(root, constants.W_OK);
      } catch {
        writable = false;
      }
      checks.push({
        name: '工作区',
        status: 'ok',
        detail: `${root}（${writable ? '可读写' : '只读'}）`,
      });
    } catch {
      checks.push({ name: '工作区', status: 'fail', detail: `${root} 不存在或不可访问` });
    }

    // 5. 审计目录
    const auditDir = dirname(loaded.config.security.auditLogPath);
    checks.push({
      name: '审计目录',
      status: existsSync(auditDir) ? 'ok' : 'warn',
      detail: existsSync(auditDir) ? auditDir : `${auditDir}（首次运行时创建）`,
    });

    // 6. SQLite 会话库
    const dbPath = loaded.config.session.dbPath;
    if (!existsSync(dbPath)) {
      checks.push({ name: '会话数据库', status: 'warn', detail: `${dbPath}（首次运行时创建）` });
    } else {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n?: number } | undefined;
        db.close();
        checks.push({ name: '会话数据库', status: 'ok', detail: `${dbPath}（${row?.n ?? 0} 个会话）` });
      } catch (err) {
        checks.push({
          name: '会话数据库',
          status: 'fail',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 7. ripgrep / git
  const rg = await checkCommand('rg', ['--version']);
  checks.push({
    name: 'ripgrep',
    status: rg.ok ? 'ok' : 'warn',
    detail: rg.ok ? rg.detail : '未安装（grep_search 将使用纯 Node 降级搜索）',
  });
  const git = await checkCommand('git', ['--version']);
  checks.push({
    name: 'git',
    status: git.ok ? 'ok' : 'warn',
    detail: git.ok ? git.detail : '未安装（git_status / git_diff 不可用）',
  });

  // 8. 工具注册
  try {
    const registry = new ToolRegistry(createBuiltinTools());
    checks.push({
      name: '工具注册',
      status: registry.names().length > 0 ? 'ok' : 'fail',
      detail: `${registry.names().length} 个工具：${registry.names().join(', ')}`,
    });
  } catch (err) {
    checks.push({ name: '工具注册', status: 'fail', detail: err instanceof Error ? err.message : String(err) });
  }

  // 9. 系统诊断能力（真实调用）
  try {
    const processes = await listProcesses();
    checks.push({ name: '进程诊断', status: 'ok', detail: `可读取 ${processes.length} 个进程` });
  } catch (err) {
    checks.push({ name: '进程诊断', status: 'fail', detail: err instanceof Error ? err.message : String(err) });
  }
  try {
    const memory = await getMemory();
    checks.push({
      name: '内存诊断',
      status: 'ok',
      detail: `总量 ${formatBytes(memory.totalBytes)}，可用 ${formatBytes(memory.freeBytes)}`,
    });
  } catch (err) {
    checks.push({ name: '内存诊断', status: 'fail', detail: err instanceof Error ? err.message : String(err) });
  }

  if (full && loaded) {
    checks.push({
      name: '权限策略',
      status: 'ok',
      detail: `mode=${loaded.config.security.mode} 写审批=${loaded.config.security.requireApprovalForWrite} 执行审批=${loaded.config.security.requireApprovalForExecute}`,
    });
  }

  // 输出
  stdout.write('ForgeX 环境自检\n');
  for (const check of checks) {
    stdout.write(`[${label(check.status)}] ${check.name}: ${check.detail}\n`);
  }
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  stdout.write(`\n结果：${checks.length} 项检查，${failed} 项失败，${warned} 项警告\n`);
  return failed > 0 ? 1 : 0;
}

function label(status: Status): string {
  if (status === 'ok') return 'OK';
  if (status === 'warn') return 'WARN';
  return 'FAIL';
}

function checkCommand(program: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(program, args, { timeout: 5000, windowsHide: true }, (err, out) => {
      if (err) {
        resolve({ ok: false, detail: err.message.split('\n')[0] ?? '不可用' });
        return;
      }
      resolve({ ok: true, detail: out.trim().split('\n')[0] ?? '可用' });
    });
  });
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}
