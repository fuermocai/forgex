/**
 * @forgex/requirement-engine 公共入口（v0.5.0 Phase 1）。
 *
 * 解耦设计：RequirementModelInterface 由上层注入，不直接 import createProvider()。
 */
export * from './types.js';
export * from './model/requirement-model-interface.js';
export * from './parser/requirement-parser.js';
export * from './analyzer/requirement-analyzer.js';
export * from './criteria/criteria-validator.js';
export * from './traceability/trace-store.js';
