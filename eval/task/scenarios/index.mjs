/**
 * 场景清单。新增场景组时只需在此登记，run.mjs 不感知具体实现。
 */
import { coreScenarios } from './core.mjs';
import { planningScenarios } from './planning.mjs';
import { runtimeScenarios } from './runtime.mjs';
import { adversarialScenarios } from './adversarial.mjs';
import { worktreeScenarios } from './worktree.mjs';

export const scenarios = [
  ...coreScenarios,
  ...planningScenarios,
  ...runtimeScenarios,
  ...adversarialScenarios,
  ...worktreeScenarios,
];
