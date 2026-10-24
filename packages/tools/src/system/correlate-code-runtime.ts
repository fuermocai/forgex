/**
 * correlate_code_runtime：代码 + 运行环境关联分析工具。
 *
 * 输入日志文本（或工作区内的日志文件路径），输出：
 *   - 异常事件列表（severity、kind、context）
 *   - 用户代码堆栈帧（排除框架/系统）
 *   - 关联的 Git 变更（如果提供了 repoRoot）
 *   - 置信度分数（0-1）
 *
 * 安全边界：
 *   logPath / repoRoot 必须在工作区内 → 越界直接拒绝。
 *   correlate.ts 内部只读 git log/status，不执行任意命令。
 *
 * 确定性：
 *   除 git 命令执行外，其余全是纯函数（正则 + 字符串分割）。
 *   不调 LLM。
 */
import { z } from 'zod';
import type { JsonValue, ToolContext, ToolDefinition, ToolOutcome } from '@forgex/shared';
import { correlate } from '@forgex/devops';
import type { Language } from '@forgex/devops';
import { errorToOutcome, toolError, toolOk } from '../tool-result.js';

const inputSchema = z.object({
  /** 原始日志文本（与 logPath 二选一） */
  logText: z.string().min(1).max(512_000).optional().describe('直接传入的日志文本（最大 500KB，与 logPath 二选一）'),
  /** 日志文件路径（必须在工作区内） */
  logPath: z.string().min(1).max(4096).optional().describe('工作区内的日志文件绝对路径（与 logText 二选一）'),
  /** Git 仓库根目录（必须在工作区内，提供后会做 Git 关联） */
  repoRoot: z.string().min(1).max(4096).optional().describe('Git 仓库根目录绝对路径（可选，提供后会关联最近提交）'),
  /** 语言提示（默认 auto 检测） */
  hintLanguage: z.enum(['java', 'python', 'nodejs']).optional().describe('已知日志语言——不填则自动检测'),
  /** 回溯时间窗口（毫秒），默认 1 小时 */
  gitTimeWindowMs: z.number().int().min(60_000).max(86_400_000).optional().describe('Git 关联回溯时间窗口（毫秒），默认 3600000（1 小时）'),
});

type Input = z.infer<typeof inputSchema>;

export function createCorrelateCodeRuntimeTool(): ToolDefinition<Input> {
  return {
    name: 'correlate_code_runtime',
    description:
      '代码 + 运行环境关联分析：从错误日志里提取异常堆栈，定位到具体代码文件和行号，' +
      '结合 Git 最近提交找出最可能引入问题的变更。' +
      '输入日志文本或工作区内的日志文件路径，输出结构化证据链（异常事件、用户代码帧、关联 Git 变更、置信度）。' +
      '纯确定性分析（正则 + 字符串匹配 + 只读 git log），不调 LLM。',
    parameters: inputSchema as unknown as ToolDefinition<Input>['parameters'],
    riskLevel: 'read',
    timeoutMs: 60_000,
    maxOutputBytes: 256 * 1024,
    tags: ['devops', 'diagnosis', 'analysis', 'read'],
    async execute(input: Input, ctx: ToolContext): Promise<ToolOutcome<JsonValue>> {
      try {
        // 1. 至少提供一个日志源
        if (!input.logText && !input.logPath) {
          return toolError('TOOL_INPUT_MISSING', '必须提供 logText 或 logPath 二选一');
        }
        if (input.logText && input.logPath) {
          return toolError('TOOL_INPUT_CONFLICT', 'logText 和 logPath 只能二选一');
        }

        // 2. 工作区路径校验
        if (input.logPath && !isWithinWorkspace(input.logPath, ctx.workspaceRoot)) {
          return toolError(
            'PATH_OUTSIDE_WORKSPACE',
            `日志文件路径越界：${input.logPath} 不在工作区 ${ctx.workspaceRoot} 内`,
            { details: { logPath: input.logPath, workspaceRoot: ctx.workspaceRoot } },
          );
        }
        if (input.repoRoot && !isWithinWorkspace(input.repoRoot, ctx.workspaceRoot)) {
          return toolError(
            'PATH_OUTSIDE_WORKSPACE',
            `Git 仓库根目录越界：${input.repoRoot} 不在工作区 ${ctx.workspaceRoot} 内`,
            { details: { repoRoot: input.repoRoot, workspaceRoot: ctx.workspaceRoot } },
          );
        }

        // 3. 调关联分析主入口
        const report = await correlate({
          logText: input.logText,
          logPath: input.logPath,
          repoRoot: input.repoRoot,
          hintLanguage: input.hintLanguage as Language | undefined,
          gitTimeWindowMs: input.gitTimeWindowMs,
        });

        // 4. 构建工具输出（摘要，控制大小）
        const topEvents = report.events.slice(0, 5).map((e) => ({
          severity: e.severity,
          kind: e.kind,
          language: e.language,
          lineStart: e.lineStart,
          lineEnd: e.lineEnd,
          context: e.context,
          stackCount: e.stack.length,
        }));

        const topUserFrames = report.userFrames.slice(0, 10).map((f) => ({
          function: f.function,
          classOrModule: f.classOrModule,
          filePath: f.filePath,
          line: f.line,
          column: f.column,
        }));

        const topChanges = report.relatedChanges.slice(0, 10).map((c) => ({
          filePath: c.filePath,
          additions: c.additions,
          deletions: c.deletions,
          lastCommitDate: c.lastCommitDate,
          lastCommitMessage: c.lastCommitMessage,
          author: c.author,
        }));

        const summary =
          `关联分析完成：置信度 ${(report.confidence * 100).toFixed(0)}%  |  ` +
          `${report.events.length} 个异常事件  |  ` +
          `${report.userFrames.length} 处用户代码帧  |  ` +
          `${report.relatedChanges.length} 处 Git 变更` +
          (report.errors.length > 0 ? `  |  警告: ${report.errors.join('; ')}` : '');

        return toolOk(
          summary,
          {
            confidence: report.confidence,
            analyzedAt: report.analyzedAt,
            source: report.source,
            topEvents,
            topUserFrames,
            topChanges,
            allEventKinds: report.events.map((e) => e.kind),
            errors: report.errors,
          },
          report.events.length > 5 || report.userFrames.length > 10,
        );
      } catch (err) {
        return errorToOutcome(err);
      }
    },
  };
}

function isWithinWorkspace(target: string, workspaceRoot: string): boolean {
  const normalized = target.replace(/\\/g, '/');
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.startsWith(root + '/') || normalized === root;
}
