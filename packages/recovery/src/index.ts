/**
 * @forgex/recovery 公共入口（v0.4.0 Phase 6）。
 *
 * 恢复引擎：检查点持久化、恢复前验证（环境+权限）、幂等计划、回滚协调。
 */
export * from './types.js';
export { CheckpointStore } from './checkpoints/checkpoint-store.js';
export { RecoveryPlanner } from './coordinator/recovery-planner.js';
export { RollbackCoordinator } from './coordinator/rollback-coordinator.js';
export { RecoveryVerifier, type RecoveryVerifierOptions } from './verification/recovery-verifier.js';
export { RecoveryManager, type RecoverResult } from './recovery-manager.js';
