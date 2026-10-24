/**
 * ToolRegistry：工具定义的唯一注册表。
 *
 * 职责：
 *  - 注册时做静态校验（重名、必填字段、参数 schema 可转换）；
 *  - 对外提供 OpenAI function calling 所需的工具声明；
 *  - 调用前用 Zod 对模型输入做严格校验，绝不把原始 JSON 直接传给工具。
 *
 * 不负责：权限判定、审批、超时、审计、并发控制——这些由 Core 的
 * ToolDispatcher 统一处理，保证任何工具（包括未来扩展的插件工具）
 * 都无法绕过安全链路。
 */
import type { JsonValue, ToolDefinition } from '@forgex/shared';
import { ForgeError, zodToJsonSchema } from '@forgex/shared';
import type { ZodType } from 'zod';

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolParseResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: { code: string; message: string; details: JsonValue };
    };

/** 注册表内部统一使用擦除泛型的工具类型 */
export type RegisteredTool = ToolDefinition<unknown, JsonValue>;

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(initial: ReadonlyArray<ToolDefinition<never, JsonValue> | RegisteredTool> = []) {
    for (const tool of initial as ReadonlyArray<RegisteredTool>) this.register(tool);
  }

  register(tool: RegisteredTool): void {
    if (!tool || typeof tool !== 'object') {
      throw new ForgeError('CONFIG_INVALID', '工具定义不能为空');
    }
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(tool.name)) {
      throw new ForgeError('CONFIG_INVALID', `工具名不合法: ${tool.name}（仅允许小写字母、数字、下划线）`);
    }
    if (this.tools.has(tool.name)) {
      throw new ForgeError('CONFIG_INVALID', `工具重复注册: ${tool.name}`);
    }
    if (!tool.description || tool.description.trim().length === 0) {
      throw new ForgeError('CONFIG_INVALID', `工具 ${tool.name} 缺少 description`);
    }
    if (!isZodType(tool.parameters)) {
      throw new ForgeError('CONFIG_INVALID', `工具 ${tool.name} 的 parameters 必须是 Zod schema`);
    }
    if (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0) {
      throw new ForgeError('CONFIG_INVALID', `工具 ${tool.name} 的 timeoutMs 非法`);
    }
    if (!Number.isFinite(tool.maxOutputBytes) || tool.maxOutputBytes <= 0) {
      throw new ForgeError('CONFIG_INVALID', `工具 ${tool.name} 的 maxOutputBytes 非法`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ReadonlyArray<RegisteredTool>): void {
    for (const tool of tools) this.register(tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** 取工具，不存在时抛 TOOL_NOT_FOUND（供 Dispatcher 使用） */
  require(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ForgeError('TOOL_NOT_FOUND', `模型请求了未注册的工具: ${name}`, { details: { name } });
    }
    return tool;
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** 生成模型可见的工具声明（参数已转换为 JSON Schema） */
  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.parameters as ZodType),
      },
    }));
  }

  /**
   * 校验模型传入的参数。
   * 注意：模型输出的 arguments 是字符串，解析成 JSON 的工作由 Dispatcher 完成；
   * 本方法接收的已经是解析后的值。
   */
  parseInput(tool: RegisteredTool, raw: unknown): ToolParseResult {
    const result = tool.parameters.safeParse(raw);
    if (result.success) return { ok: true, data: result.data };

    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
      code: issue.code,
    }));
    return {
      ok: false,
      error: {
        code: 'TOOL_INVALID_INPUT',
        message: `工具 ${tool.name} 参数校验失败: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
        details: issues,
      },
    };
  }
}

function isZodType(value: unknown): value is ZodType {
  return typeof value === 'object' && value !== null && 'safeParse' in value && typeof (value as ZodType).safeParse === 'function';
}
