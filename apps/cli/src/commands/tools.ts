/**
 * forgex tools：列出内置工具（名称、风险等级、超时、说明）。
 *
 * 该命令直接读取 ToolRegistry，与 Agent 运行时使用同一份定义，
 * 不会出现"文档写了但实际没注册"的偏差。
 */
import { stdout } from 'node:process';
import { ToolRegistry, createBuiltinTools } from '@forgex/tools';

export function toolsCommand(): number {
  const registry = new ToolRegistry(createBuiltinTools());
  const tools = registry.list();

  stdout.write(`ForgeX 内置工具（${tools.length} 个）\n\n`);
  for (const tool of tools) {
    const tags = tool.tags && tool.tags.length > 0 ? ` 标签=${tool.tags.join(',')}` : '';
    stdout.write(`- ${tool.name}  [${tool.riskLevel}]  超时=${tool.timeoutMs}ms  输出上限=${tool.maxOutputBytes}B${tags}\n`);
    stdout.write(`  ${tool.description.split('\n')[0]}\n`);
  }
  stdout.write(
    '\n说明：风险等级决定默认权限策略；execute 级命令默认需要人工审批，privileged 级默认拒绝。\n',
  );
  return 0;
}
