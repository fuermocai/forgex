/**
 * 内置工作流定义集合（v0.4.0 Phase 1）。
 *
 * 提供 registerBuiltinWorkflows(registry) 一次性注册全部 6 个工作流。
 */
import type { WorkflowRegistry } from '../registry/workflow-registry.js';
import { createBugFixWorkflow } from './bug-fix.js';
import { createFeatureDevWorkflow } from './feature-dev.js';
import { createCodeReviewWorkflow } from './code-review.js';
import { createRefactoringWorkflow } from './refactoring.js';
import { createDevopsDiagnosisWorkflow } from './devops-diagnosis.js';
import { createDeploymentPrepWorkflow } from './deployment-prep.js';

export {
  createBugFixWorkflow,
  createFeatureDevWorkflow,
  createCodeReviewWorkflow,
  createRefactoringWorkflow,
  createDevopsDiagnosisWorkflow,
  createDeploymentPrepWorkflow,
};

/** 一次性注册全部 6 个内置工作流 */
export function registerBuiltinWorkflows(registry: WorkflowRegistry): void {
  registry.register(createBugFixWorkflow());
  registry.register(createFeatureDevWorkflow());
  registry.register(createCodeReviewWorkflow());
  registry.register(createRefactoringWorkflow());
  registry.register(createDevopsDiagnosisWorkflow());
  registry.register(createDeploymentPrepWorkflow());
}
