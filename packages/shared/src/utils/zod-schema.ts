/**
 * Zod -> JSON Schema（OpenAI function calling 所需的 parameters 结构）。
 *
 * 为什么不直接引入 zod-to-json-schema：
 *  - 工具参数只需要支持有限的 Zod 子集，自实现约 150 行即可覆盖；
 *  - 减少一个第三方依赖，便于离线构建与供应链审计；
 *  - 可以对不支持的 Zod 类型显式降级为 `{}`，避免工具注册阶段抛错。
 *
 * 支持：object / string / number / integer / boolean / array / enum / literal /
 *      optional / nullable / default / union / record / tuple。
 * 不支持：refine、transform 等带副作用的 schema（会取其内部 schema）——
 *      运行时仍由 Zod 校验兜底，JSON Schema 仅用于向模型描述参数。
 */
import type { ZodTypeAny } from 'zod';

/** 生成 JSON Schema 对象（始终为 object 类型，兼容 tools[].function.parameters） */
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const result = convert(schema);
  return result;
}

interface DefLike {
  typeName?: string;
  description?: string;
  shape?: Record<string, ZodTypeAny> | (() => Record<string, ZodTypeAny>);
  type?: ZodTypeAny;
  values?: unknown[];
  value?: unknown;
  items?: ZodTypeAny | ZodTypeAny[];
  options?: ZodTypeAny[];
  keyType?: ZodTypeAny;
  valueType?: ZodTypeAny;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  defaultValue?: unknown;
  checks?: ReadonlyArray<{ kind: string; value?: number }>;
}

function getDef(schema: ZodTypeAny): DefLike {
  return (schema as unknown as { _def: DefLike })._def;
}

/** 是否属于"可省略"字段（影响 object 的 required 列表） */
function isOptionalLike(schema: ZodTypeAny): boolean {
  const name = getDef(schema).typeName;
  return name === 'ZodOptional' || name === 'ZodDefault';
}

function convert(schema: ZodTypeAny): Record<string, unknown> {
  const def = getDef(schema);
  const typeName = def.typeName ?? '';
  const result = convertByType(typeName, def);
  if (def.description) result.description = def.description;
  return result;
}

function convertByType(typeName: string, def: DefLike): Record<string, unknown> {
  switch (typeName) {
    case 'ZodObject': {
      // zod v3 的 _def.shape 可能是惰性函数（懒加载递归 schema）
      const rawShape = def.shape;
      const shape: Record<string, ZodTypeAny> =
        typeof rawShape === 'function'
          ? (rawShape as unknown as () => Record<string, ZodTypeAny>)()
          : (rawShape ?? {});
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = convert(child);
        if (!isOptionalLike(child)) required.push(key);
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      for (const check of def.checks ?? []) {
        if (check.kind === 'min' && typeof check.value === 'number') out.minLength = check.value;
        if (check.kind === 'max' && typeof check.value === 'number') out.maxLength = check.value;
      }
      return out;
    }
    case 'ZodNumber':
    case 'ZodBigInt': {
      const out: Record<string, unknown> = { type: 'number' };
      for (const check of def.checks ?? []) {
        if (check.kind === 'int') out.type = 'integer';
        if (check.kind === 'min' && typeof check.value === 'number') out.minimum = check.value;
        if (check.kind === 'max' && typeof check.value === 'number') out.maximum = check.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray': {
      const items = def.type ? convert(def.type) : {};
      return { type: 'array', items };
    }
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values ?? [])] };
    case 'ZodLiteral':
      return { const: def.value, type: typeof def.value === 'number' ? 'number' : typeof def.value };
    case 'ZodOptional':
    case 'ZodDefault':
      return def.innerType ? convert(def.innerType) : {};
    case 'ZodNullable': {
      const inner = def.innerType ? convert(def.innerType) : {};
      return { ...inner, nullable: true };
    }
    case 'ZodUnion':
      return { anyOf: (def.options ?? []).map((option) => convert(option)) };
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: def.valueType ? convert(def.valueType) : {},
      };
    case 'ZodTuple': {
      const items = Array.isArray(def.items) ? def.items : [];
      return { type: 'array', items: items.map((item) => convert(item)) };
    }
    case 'ZodEffects':
      // refine / transform：运行时校验仍然生效，这里只暴露内层结构
      return def.schema ? convert(def.schema) : {};
    default:
      // 未知类型降级为"任意值"，不阻塞工具注册
      return {};
  }
}
