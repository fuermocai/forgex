import { registerBuiltinWorkflows, WorkflowRegistry } from '@forgex/workflows';

/** Returns the validated built-in workflow catalogue. */
export function listWorkflows() {
  const registry = new WorkflowRegistry();
  registerBuiltinWorkflows(registry);
  return registry.list();
}

/** Returns one validated built-in workflow by ID. */
export function getWorkflow(id: string) {
  return listWorkflows().find((workflow) => workflow.id === id);
}
