/**
 * Approval Engine 测试（v0.4.0 Phase 3）。
 *
 * 重点验证：
 *   1. 参数哈希确定性和变化检测；
 *   2. 四级风险策略；
 *   3. ApprovalStore CRUD 和过期；
 *   4. ApprovalManager：L0 自动放行、L3 非交互拒绝、参数哈希复用、撤销、过期。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AuditLogger, MemoryAuditSink } from '@forgex/security';
import { hashParams, hashCommand } from '../src/requests/param-hasher.js';
import { ApprovalPolicy } from '../src/policy/approval-policy.js';
import { ApprovalStore } from '../src/store/approval-store.js';
import { ApprovalManager } from '../src/approval-manager.js';
import {
  type ApprovalRecord,
  newApprovalId,
  approvalNowIso,
  expiryIso,
} from '../src/types.js';

describe('ParamHasher', () => {
  it('相同参数产生相同哈希', () => {
    const h1 = hashParams('edit_file', { path: 'a.ts', content: 'hello' });
    const h2 = hashParams('edit_file', { path: 'a.ts', content: 'hello' });
    expect(h1).toBe(h2);
  });

  it('参数任何变化产生不同哈希', () => {
    const h1 = hashParams('edit_file', { path: 'a.ts', content: 'hello' });
    const h2 = hashParams('edit_file', { path: 'a.ts', content: 'world' });
    expect(h1).not.toBe(h2);
  });

  it('操作名变化产生不同哈希', () => {
    const h1 = hashParams('edit_file', { path: 'a.ts' });
    const h2 = hashParams('run_command', { path: 'a.ts' });
    expect(h1).not.toBe(h2);
  });

  it('键名顺序不影响哈希', () => {
    const h1 = hashParams('op', { a: 1, b: 2 });
    const h2 = hashParams('op', { b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('命令拆分后各部分哈希不同', () => {
    const full = hashCommand('run_command', 'rm', ['-rf', '/']);
    const part1 = hashCommand('run_command', 'rm', ['-rf']);
    const part2 = hashCommand('run_command', 'rm', ['/']);
    expect(full).not.toBe(part1);
    expect(full).not.toBe(part2);
    expect(part1).not.toBe(part2);
  });
});

describe('ApprovalPolicy', () => {
  it('L0 自动放行', () => {
    const policy = new ApprovalPolicy();
    expect(policy.getRequirement('L0')).toBe('auto_allow');
    expect(policy.isAutoAllowed('L0')).toBe(true);
  });

  it('L3 必须人工审批', () => {
    const policy = new ApprovalPolicy();
    expect(policy.getRequirement('L3')).toBe('manual_required');
    expect(policy.requiresHumanApproval('L3')).toBe(true);
  });

  it('L2 必须审批但非人工', () => {
    const policy = new ApprovalPolicy();
    expect(policy.getRequirement('L2')).toBe('required');
    expect(policy.requiresHumanApproval('L2')).toBe(false);
  });

  it('L1 可选审批', () => {
    const policy = new ApprovalPolicy();
    expect(policy.getRequirement('L1')).toBe('optional');
  });

  it('生产环境 L3 默认拒绝', () => {
    const policy = new ApprovalPolicy({ isProduction: true });
    expect(policy.isProductionDefaultDeny('L3')).toBe(true);
    expect(policy.isProductionDefaultDeny('L2')).toBe(false);
  });

  it('非生产环境 L3 不默认拒绝', () => {
    const policy = new ApprovalPolicy({ isProduction: false });
    expect(policy.isProductionDefaultDeny('L3')).toBe(false);
  });
});

describe('ApprovalStore', () => {
  let db: DatabaseSync;
  let store: ApprovalStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new ApprovalStore(db);
  });

  function makeRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
    return {
      id: newApprovalId(),
      operation: 'edit_file',
      riskLevel: 'L2',
      summary: 'edit file',
      scope: {
        operation: 'edit_file',
        paramHash: 'hash123',
        targetEnvironment: 'local',
        expiresAt: expiryIso(60000),
      },
      applicant: 'agent-1',
      approver: '',
      status: 'pending',
      createdAt: approvalNowIso(),
      ...overrides,
    };
  }

  it('create 后 get 返回相同记录', () => {
    const record = makeRecord();
    store.create(record);
    const loaded = store.get(record.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(record.id);
    expect(loaded?.operation).toBe('edit_file');
  });

  it('get 不存在返回 null', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('listByScope 返回匹配的审批', () => {
    const r1 = makeRecord({ scope: { operation: 'op', paramHash: 'hash-A', targetEnvironment: 'local', expiresAt: expiryIso(60000) } });
    const r2 = makeRecord({ scope: { operation: 'op', paramHash: 'hash-B', targetEnvironment: 'local', expiresAt: expiryIso(60000) } });
    store.create(r1);
    store.create(r2);

    const list = store.listByScope('hash-A');
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(r1.id);
  });

  it('updateStatus 更新状态', () => {
    const record = makeRecord();
    store.create(record);
    store.updateStatus(record.id, 'approved', 'user-1');
    const loaded = store.get(record.id);
    expect(loaded?.status).toBe('approved');
    expect(loaded?.approver).toBe('user-1');
  });

  it('expireOutdated 将过期审批标记为 expired', () => {
    const expired = makeRecord({
      scope: { operation: 'op', paramHash: 'hash-exp', targetEnvironment: 'local', expiresAt: '2020-01-01T00:00:00.000Z' },
      status: 'approved',
    });
    const valid = makeRecord({
      scope: { operation: 'op', paramHash: 'hash-valid', targetEnvironment: 'local', expiresAt: expiryIso(60000) },
      status: 'approved',
    });
    store.create(expired);
    store.create(valid);

    const expiredCount = store.expireOutdated();
    expect(expiredCount).toBe(1);
    expect(store.get(expired.id)?.status).toBe('expired');
    expect(store.get(valid.id)?.status).toBe('approved');
  });

  it('hasValidApproval 正确判断', () => {
    const valid = makeRecord({
      scope: { operation: 'op', paramHash: 'hash-valid', targetEnvironment: 'local', expiresAt: expiryIso(60000) },
      status: 'approved',
    });
    store.create(valid);
    expect(store.hasValidApproval('hash-valid')).toBe(true);
    expect(store.hasValidApproval('hash-nonexistent')).toBe(false);
  });
});

describe('ApprovalManager', () => {
  let db: DatabaseSync;
  let store: ApprovalStore;
  let auditSink: MemoryAuditSink;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new ApprovalStore(db);
    auditSink = new MemoryAuditSink();
    auditLogger = new AuditLogger({ sinks: [auditSink] });
  });

  function createManager(options: { isProduction?: boolean; handler?: any } = {}) {
    return new ApprovalManager({
      store,
      auditLogger,
      policyConfig: { isProduction: options.isProduction },
      approvalHandler: options.handler,
    });
  }

  it('L0 操作自动放行，不创建审批记录', async () => {
    const manager = createManager();
    const result = await manager.requestApproval({
      operation: 'read_file',
      riskLevel: 'L0',
      summary: 'read file',
      params: { path: 'a.ts' },
      targetEnvironment: 'local',
    });
    expect(result.approved).toBe(true);
    // L0 仍然创建记录但状态为 approved
    expect(result.record.status).toBe('approved');
    expect(result.record.approver).toBe('auto');
  });

  it('L3 操作在非交互模式默认拒绝', async () => {
    const manager = createManager();
    const result = await manager.requestApproval({
      operation: 'deploy',
      riskLevel: 'L3',
      summary: 'deploy to prod',
      params: { env: 'prod' },
      targetEnvironment: 'production',
    });
    expect(result.approved).toBe(false);
    expect(result.record.status).toBe('denied');
  });

  it('L3 操作在生产环境默认拒绝', async () => {
    const manager = createManager({
      isProduction: true,
      handler: async () => ({ approved: true, approver: 'user' }),
    });
    const result = await manager.requestApproval({
      operation: 'deploy',
      riskLevel: 'L3',
      summary: 'deploy',
      params: {},
      targetEnvironment: 'production',
    });
    expect(result.approved).toBe(false);
    expect(result.record.denialReason).toContain('生产环境');
  });

  it('相同参数哈希复用已有审批', async () => {
    const approveHandler = async () => ({ approved: true, approver: 'user-1' });
    const manager = createManager({ handler: approveHandler });

    const params = { path: 'a.ts', content: 'hello' };
    const r1 = await manager.requestApproval({
      operation: 'edit_file',
      riskLevel: 'L2',
      summary: 'edit',
      params,
      targetEnvironment: 'local',
    });
    expect(r1.approved).toBe(true);

    // 相同参数再次请求，应复用已有审批
    const r2 = await manager.requestApproval({
      operation: 'edit_file',
      riskLevel: 'L2',
      summary: 'edit',
      params,
      targetEnvironment: 'local',
    });
    expect(r2.approved).toBe(true);
    expect(r2.record.id).toBe(r1.record.id); // 复用同一条记录
  });

  it('参数变化后需要重新审批', async () => {
    const approveHandler = async () => ({ approved: true, approver: 'user-1' });
    const manager = createManager({ handler: approveHandler });

    const r1 = await manager.requestApproval({
      operation: 'edit_file',
      riskLevel: 'L2',
      summary: 'edit',
      params: { path: 'a.ts', content: 'v1' },
      targetEnvironment: 'local',
    });

    const r2 = await manager.requestApproval({
      operation: 'edit_file',
      riskLevel: 'L2',
      summary: 'edit',
      params: { path: 'a.ts', content: 'v2' }, // 参数变化
      targetEnvironment: 'local',
    });

    expect(r2.record.id).not.toBe(r1.record.id); // 不同记录
  });

  it('撤销后审批不可用', async () => {
    const approveHandler = async () => ({ approved: true, approver: 'user-1' });
    const manager = createManager({ handler: approveHandler });

    const result = await manager.requestApproval({
      operation: 'edit_file',
      riskLevel: 'L2',
      summary: 'edit',
      params: { path: 'a.ts' },
      targetEnvironment: 'local',
    });
    expect(result.approved).toBe(true);

    manager.revoke(result.record.id);
    const revoked = store.get(result.record.id);
    expect(revoked?.status).toBe('revoked');
  });

  it('审批通过 handler 被调用', async () => {
    let handlerCalled = false;
    const handler = async () => {
      handlerCalled = true;
      return { approved: true, approver: 'user-1' };
    };
    const manager = createManager({ handler });

    const result = await manager.requestApproval({
      operation: 'edit_file',
      riskLevel: 'L2',
      summary: 'edit',
      params: { path: 'a.ts' },
      targetEnvironment: 'local',
    });
    expect(handlerCalled).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.record.approver).toBe('user-1');
  });

  it('审批拒绝 handler 返回 false', async () => {
    const handler = async () => ({ approved: false, approver: 'user-1', reason: 'not safe' });
    const manager = createManager({ handler });

    const result = await manager.requestApproval({
      operation: 'edit_file',
      riskLevel: 'L2',
      summary: 'edit',
      params: { path: 'a.ts' },
      targetEnvironment: 'local',
    });
    expect(result.approved).toBe(false);
    expect(result.record.status).toBe('denied');
    expect(result.record.denialReason).toBe('not safe');
  });

  it('L1 操作在无 handler 时自动放行', async () => {
    const manager = createManager();
    const result = await manager.requestApproval({
      operation: 'edit_file',
      riskLevel: 'L1',
      summary: 'edit',
      params: { path: 'a.ts' },
      targetEnvironment: 'local',
    });
    expect(result.approved).toBe(true);
  });
});
