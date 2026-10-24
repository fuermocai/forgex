/**
 * Requirement Engine 测试（v0.5.0 Phase 1）。
 *
 * 重点验证：
 *   1. 类型级安全约束：AcceptanceCriterion.approved 默认 false；
 *   2. isRequirementReady 必须无歧义 + 所有标准已批准；
 *   3. RequirementParser 通过注入 DeterministicMockModel 工作，不依赖 LLM；
 *   4. CriteriaValidator 拒绝未批准标准；
 *   5. RequirementAnalyzer.assertReady 门禁；
 *   6. RequirementTraceStore CRUD。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  makeStructuredRequirement,
  makeCriterion,
  isRequirementReady,
  newRequirementId,
  newTraceId,
  requirementNowIso,
  type StructuredRequirement,
  type AcceptanceCriterion,
} from '../src/types.js';
import {
  DeterministicMockModel,
  type RequirementModelInterface,
} from '../src/model/requirement-model-interface.js';
import { RequirementParser } from '../src/parser/requirement-parser.js';
import { RequirementAnalyzer } from '../src/analyzer/requirement-analyzer.js';
import { AcceptanceCriteriaValidator } from '../src/criteria/criteria-validator.js';
import { RequirementTraceStore } from '../src/traceability/trace-store.js';

describe('types.ts 类型级安全约束', () => {
  it('AcceptanceCriterion.approved 默认 false', () => {
    const c = makeCriterion({
      description: '功能正常工作',
      testable: true,
      verificationMethod: '运行 npm test',
      source: 'llm-generated',
    });
    expect(c.approved).toBe(false); // 类型级强制
    expect(c.source).toBe('llm-generated');
  });

  it('显式 approved=true 表示用户批准', () => {
    const c = makeCriterion({
      description: '用户批准的标准',
      testable: true,
      verificationMethod: '手动检查',
      source: 'user',
      approved: true,
    });
    expect(c.approved).toBe(true);
  });

  it('isRequirementReady 无歧义且全部标准已批准才 ready', () => {
    const req = makeStructuredRequirement({
      original: '增加权限管理',
      parsed: { category: 'feature', summary: '...', functionalReqs: [], nonFunctionalReqs: [] },
      ambiguities: [],
      acceptanceCriteria: [
        makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
        makeCriterion({ description: 'B', testable: true, verificationMethod: 'y', approved: true }),
      ],
    });
    expect(isRequirementReady(req).ready).toBe(true);
  });

  it('存在未解决歧义 → 未就绪', () => {
    const req = makeStructuredRequirement({
      original: '增加权限管理',
      parsed: { category: 'feature', summary: '...', functionalReqs: [], nonFunctionalReqs: [] },
      ambiguities: [
        { field: '粒度', description: '未说明 RBAC 还是 ABAC', suggestedOptions: ['RBAC', 'ABAC'] },
      ],
      acceptanceCriteria: [
        makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
      ],
    });
    const r = isRequirementReady(req);
    expect(r.ready).toBe(false);
    expect(r.reasons.some((m) => m.includes('歧义'))).toBe(true);
  });

  it('存在未批准验收标准 → 未就绪', () => {
    const req = makeStructuredRequirement({
      original: '增加权限管理',
      parsed: { category: 'feature', summary: '...', functionalReqs: [], nonFunctionalReqs: [] },
      ambiguities: [],
      acceptanceCriteria: [
        makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
        makeCriterion({ description: 'B', testable: true, verificationMethod: 'y', approved: false }),
      ],
    });
    const r = isRequirementReady(req);
    expect(r.ready).toBe(false);
    expect(r.reasons.some((m) => m.includes('未批准'))).toBe(true);
  });

  it('双失败同时触发', () => {
    const req = makeStructuredRequirement({
      original: 'x',
      parsed: { category: 'unknown', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
      ambiguities: [{ field: 'a', description: 'd', suggestedOptions: ['o1'] }],
      acceptanceCriteria: [makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: false })],
    });
    const r = isRequirementReady(req);
    expect(r.ready).toBe(false);
    expect(r.reasons.length).toBe(2);
  });
});

describe('RequirementParser（解耦 LLM，测试用 DeterministicMockModel）', () => {
  it('解析自然语言需求', async () => {
    const model = new DeterministicMockModel({
      intent: { category: 'feature', summary: '用户权限管理', functionalReqs: ['RBAC', '角色管理'], nonFunctionalReqs: ['安全性'] },
      criteria: [
        makeCriterion({ description: '角色创建正常', testable: true, verificationMethod: '运行单测' }),
      ],
    });
    const parser = new RequirementParser({ model });
    const req = await parser.parse('给项目增加用户权限管理功能');

    expect(req.parsed.category).toBe('feature');
    expect(req.parsed.summary).toBe('用户权限管理');
    expect(req.acceptanceCriteria).toHaveLength(1);
    // 关键：模型返回的 criteria 必须被强制 approved=false
    expect(req.acceptanceCriteria[0]!.approved).toBe(false);
    expect(req.traceId.startsWith('trace_')).toBe(true);
  });

  it('空输入抛 REQUIREMENT_PARSE_FAILED', async () => {
    const model = new DeterministicMockModel();
    const parser = new RequirementParser({ model });
    await expect(parser.parse('   ')).rejects.toThrow('需求输入为空');
  });

  it('detectAmbiguities 返回的 AmbiguityItem 被透传', async () => {
    const model = new DeterministicMockModel({
      ambiguities: [{ field: 'scope', description: '范围不明确', suggestedOptions: ['仅 API', 'API + UI'] }],
    });
    const parser = new RequirementParser({ model });
    const req = await parser.parse('增加权限管理');
    expect(req.ambiguities).toHaveLength(1);
    expect(req.ambiguities[0]!.resolved).toBeUndefined();
  });

  it('deterministicModuleHints 合并到 affectedModules', async () => {
    const model = new DeterministicMockModel();
    const parser = new RequirementParser({ model, deterministicModuleHints: ['auth', 'api'] });
    const req = await parser.parse('增加 auth 权限管理和 db 操作');
    // 关键词推断 auth + db，加 hints auth + api
    expect(req.affectedModules).toContain('auth');
    expect(req.affectedModules).toContain('api');
  });
});

describe('AcceptanceCriteriaValidator', () => {
  let validator: AcceptanceCriteriaValidator;

  beforeEach(() => {
    validator = new AcceptanceCriteriaValidator();
  });

  it('空列表 → invalid', () => {
    const r = validator.validate([]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((m) => m.includes('为空'))).toBe(true);
  });

  it('存在未批准 → invalid', () => {
    const r = validator.validate([
      makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
      makeCriterion({ description: 'B', testable: true, verificationMethod: 'y', approved: false }),
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((m) => m.includes('未批准'))).toBe(true);
  });

  it('全部批准 + 描述非空 → valid', () => {
    const r = validator.validate([
      makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
    ]);
    expect(r.valid).toBe(true);
    expect(r.approved).toBe(1);
  });

  it('describe 为空 → invalid', () => {
    const r = validator.validate([
      makeCriterion({ description: '  ', testable: true, verificationMethod: 'x', approved: true }),
    ]);
    expect(r.valid).toBe(false);
  });

  it('不可测试 + 无 verificationMethod → invalid', () => {
    const r = validator.validate([
      makeCriterion({ description: 'A', testable: false, verificationMethod: '  ', approved: true }),
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((m) => m.includes('验证方法'))).toBe(true);
  });

  it('不可测试 + 有 verificationMethod → valid', () => {
    const r = validator.validate([
      makeCriterion({ description: 'A', testable: false, verificationMethod: '人工 UI 检查', approved: true }),
    ]);
    expect(r.valid).toBe(true);
  });

  it('assertValid 抛 FORGEError', () => {
    expect(() => validator.assertValid([])).toThrow();
  });
});

describe('RequirementAnalyzer', () => {
  it('ready 需求 → ready', () => {
    const analyzer = new RequirementAnalyzer();
    const req = makeStructuredRequirement({
      original: 'x',
      parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
      ambiguities: [],
      acceptanceCriteria: [
        makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
      ],
    });
    expect(analyzer.analyze(req).ready).toBe(true);
  });

  it('高风险需求 → overallRisk=high', () => {
    const analyzer = new RequirementAnalyzer();
    const req = makeStructuredRequirement({
      original: 'x',
      parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
      compatibilityRisks: [{ type: 'breaking-change', description: 'API 变更', severity: 'critical' }],
      acceptanceCriteria: [
        makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
      ],
    });
    expect(analyzer.analyze(req).overallRisk).toBe('high');
  });

  it('assertReady 拒绝未批准标准', () => {
    const analyzer = new RequirementAnalyzer();
    const req = makeStructuredRequirement({
      original: 'x',
      parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
      acceptanceCriteria: [
        makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: false }),
      ],
    });
    expect(() => analyzer.assertReady(req)).toThrow();
  });

  it('assertReady 拒绝高风险 + ready', () => {
    const analyzer = new RequirementAnalyzer();
    const req = makeStructuredRequirement({
      original: 'x',
      parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
      compatibilityRisks: [{ type: 'security', description: 'CVE', severity: 'critical' }],
      acceptanceCriteria: [
        makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: true }),
      ],
    });
    // ready 但高风险 → 仍被 assertReady 拒绝
    expect(() => analyzer.assertReady(req)).toThrow('高风险');
  });
});

describe('RequirementTraceStore', () => {
  let db: DatabaseSync;
  let store: RequirementTraceStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new RequirementTraceStore(db);
  });

  function makeReq(): StructuredRequirement {
    return makeStructuredRequirement({
      original: 'x',
      parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
    });
  }

  it('init 后 get 可查询', () => {
    const req = makeReq();
    const trace = store.init(req);
    expect(trace.status).toBe('pending');
    expect(trace.traceId).toBe(req.traceId);
    expect(trace.requirementId).toBe(req.id);

    const loaded = store.get(trace.traceId);
    expect(loaded).not.toBeNull();
    expect(loaded?.traceId).toBe(req.traceId);
  });

  it('updateStatus 更新状态', () => {
    const req = makeReq();
    const trace = store.init(req);
    store.updateStatus(trace.traceId, 'in-progress');
    expect(store.get(trace.traceId)?.status).toBe('in-progress');
  });

  it('bindWorkflowRun 关联 Phase 2 工作流运行', () => {
    const req = makeReq();
    const trace = store.init(req);
    store.bindWorkflowRun(trace.traceId, 'wf_run_abc');
    expect(store.get(trace.traceId)?.workflowRunId).toBe('wf_run_abc');
  });

  it('addCodeChange + addTest', () => {
    const req = makeReq();
    const trace = store.init(req);
    store.addCodeChange(trace.traceId, 'src/auth/auth.ts');
    store.addTest(trace.traceId, 'test/auth.test.ts');

    const loaded = store.get(trace.traceId);
    expect(loaded?.codeChanges).toContain('src/auth/auth.ts');
    expect(loaded?.tests).toContain('test/auth.test.ts');
  });

  it('markDelivered 完成交付', () => {
    const req = makeReq();
    const trace = store.init(req);
    store.markDelivered(trace.traceId, '完成角色权限 API + 单测');

    const loaded = store.get(trace.traceId);
    expect(loaded?.status).toBe('delivered');
    expect(loaded?.deliverySummary).toBe('完成角色权限 API + 单测');
  });

  it('getByRequirement 查找', () => {
    const req = makeReq();
    store.init(req);
    const loaded = store.getByRequirement(req.id);
    expect(loaded?.requirementId).toBe(req.id);
  });
});
