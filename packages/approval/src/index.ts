/**
 * @forgex/approval 公共入口（v0.4.0 Phase 3）。
 *
 * 增强版审批引擎：四级风险、参数绑定、持久化、撤销、过期、审计。
 * 对旧 security.ApprovalManager 提供兼容包装。
 */
export * from './types.js';
export * from './policy/approval-policy.js';
export * from './requests/param-hasher.js';
export * from './store/approval-store.js';
export * from './audit/approval-audit.js';
export * from './approval-manager.js';
export * from './compat/legacy-approval-manager.js';
