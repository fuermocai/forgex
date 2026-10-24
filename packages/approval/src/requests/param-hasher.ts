/**
 * ParamHasher：参数哈希计算（v0.4.0 Phase 3）。
 *
 * 职责：
 *   - 对操作名 + 完整参数计算 SHA-256 哈希；
 *   - 参数任何变化导致哈希变化；
 *   - 命令拆分后各部分哈希不同，防止通过拆分绕过审批。
 *
 * 安全约束：
 *   - 哈希包含完整命令（program + args），不允许拆分；
 *   - 哈希计算是确定性的（相同输入相同输出）；
 *   - 使用 Node.js 内置 crypto，不依赖外部库。
 */
import { createHash } from 'node:crypto';

/**
 * 计算参数哈希。
 *
 * @param operation 操作名
 * @param params 完整参数（对象，会被序列化）
 * @returns SHA-256 十六进制哈希
 */
export function hashParams(operation: string, params: Record<string, unknown>): string {
  const payload = JSON.stringify({
    operation,
    // 按键名排序，保证确定性
    params: sortObjectKeys(params),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 递归按键名排序对象，保证 JSON 序列化的确定性。
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * 计算命令哈希（用于 run_command 等操作）。
 * 包含 program + args，拆分命令必须各自独立审批。
 */
export function hashCommand(operation: string, program: string, args: readonly string[]): string {
  return hashParams(operation, { program, args: [...args] });
}
