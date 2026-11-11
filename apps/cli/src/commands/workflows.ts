import { stdout } from 'node:process';
import { flagString, type ParsedArgs } from '../args.js';
import { getWorkflow, listWorkflows } from '../task-run/workflow-catalog.js';

/** Lists built-in workflows or shows one workflow's phases. */
export function workflowsCommand(args: ParsedArgs): number {
  const id = args.positionals[0] ?? flagString(args.flags, 'workflow');
  if (!id) {
    for (const workflow of listWorkflows()) {
      stdout.write(`${workflow.id}\t${workflow.name}\t${workflow.description}\n`);
    }
    stdout.write('\n执行任务时可用：forgex run "任务" --workflow <id>\n');
    return 0;
  }

  const workflow = getWorkflow(id);
  if (!workflow) {
    stdout.write(`没有找到工作流 ${id}。运行 forgex workflows 查看可用项。\n`);
    return 2;
  }
  stdout.write(`${workflow.name} (${workflow.id})\n${workflow.description}\n\n`);
  for (const [index, node] of workflow.nodes.entries()) {
    const dependencies = node.dependencies.length > 0 ? ` ← ${node.dependencies.join(', ')}` : '';
    stdout.write(`${index + 1}. [${node.type}] ${node.name}: ${node.description}${dependencies}\n`);
  }
  stdout.write(`\n运行：forgex run "任务" --workflow ${workflow.id}\n`);
  return 0;
}
