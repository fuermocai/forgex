/**
 * @forgex/core 公共入口。
 *
 * 上层（CLI/TUI）只依赖本文件导出的门面与类型，
 * 不直接依赖内部文件布局，便于后续重构。
 */
export * from './agent/agent.js';
export * from './agent/agent-loop.js';
export * from './agent/system-prompt.js';
export * from './context/context-manager.js';
// evidence-store 的 EvidenceRef 与 planning/types 的同名类型冲突，这里显式导出并起别名
export {
  EvidenceStore,
  isEvidenceKind,
  makePreview,
  renderEvidencePlaceholder,
  newEvidenceId,
  PREVIEW_MAX_CHARS,
  EVIDENCE_KINDS,
  type EvidenceKind,
  type EvidenceRecord,
  type PutEvidenceInput,
} from './context/evidence-store.js';
export type { EvidenceRef as StoredEvidenceRef } from './context/evidence-store.js';
export * from './session/session-store.js';
export * from './runtime/metrics.js';
export * from './runtime/tool-dispatcher.js';
export * from './events/event-bus.js';

/* Phase 1: Task Planning (v0.3.0) */
export * from './planning/types.js';
export * from './planning/checkpoint.js';
export * from './planning/plan-manager.js';
export * from './planning/dep-scheduler.js';
export * from './planning/task-verifier.js';
export * from './planning/step-executor.js';
export * from './planning/task-planner.js';

/* Phase 2: Sub-Agent (v0.3.0) */
export * from './subagent/types.js';
export * from './subagent/resource-limiter.js';
export * from './subagent/agent-registry.js';
export * from './subagent/sub-agent-runner.js';
export * from './subagent/delegation-manager.js';
export * from './subagent/result-aggregator.js';

/* Phase 4: Project Memory (v0.3.0) */
export * from './memory/types.js';
export * from './memory/store.js';
export * from './memory/validator.js';
export * from './memory/retriever.js';
export * from './memory/consolidator.js';
export * from './memory/memory-manager.js';

/* Phase 6: Engineering Knowledge (v0.5.0) */
export * from './memory/engineering-knowledge-store.js';
