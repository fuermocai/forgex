/**
 * 场景 D：人工审批 — 端到端测试（v0.4.0 Phase 7）。
 *
 * 验证：
 *   - L3 操作在非交互模式被拒绝；
 *   - 拒绝后不继续执行；
 *   - 参数变化需要重新审批。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AuditLogger, MemoryAuditSink } from '@forgex/security';
import { ApprovalManager } from '@forgex/approval';
import { ApprovalStore } from '@forgex/approval';

describe('场景 D：人工审批端到端', () => {
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

  it('L3 生产部署操作被拒绝，不继续执行', async () => {
    const manager = new ApprovalManager({
      store,
      auditLogger,
      policyConfig: { isProduction: true },
    });

    const result = await manager.requestApproval({
      operation: 'deploy_to_production',
      riskLevel: 'L3',
      summary: '部署到生产环境',
      params: { version: 'v1.0.0' },
      targetEnvironment: 'production',
    });

    expect(result.approved).toBe(false);
    expect(result.record.status).toBe('denied');
    // 审计日志记录了拒绝
    const events = auditSink.all;
    expect(events.some((e) => e.type === 'approval')).toBe(true);
  });

  it('L2 操作在交互模式可通过 handler 批准', async () => {
    const manager = new ApprovalManager({
      store,
      auditLogger,
      approvalHandler: async () => ({ approved: true, approver: 'admin' }),
    });

    const result = await manager.requestApproval({
      operation: 'install_dependency',
      riskLevel: 'L2',
      summary: '安装 npm 依赖',
      params: { package: 'lodash' },
      targetEnvironment: 'local',
    });

    expect(result.approved).toBe(true);
    expect(result.record.approver).toBe('admin');
  });

  it('拒绝审批后不得继续执行', async () => {
    const manager = new ApprovalManager({
      store,
      auditLogger,
      approvalHandler: async () => ({ approved: false, approver: 'admin', reason: '风险过高' }),
    });

    const result = await manager.requestApproval({
      operation: 'modify_firewall',
      riskLevel: 'L2',
      summary: '修改防火墙规则',
      params: { rule: 'allow 8080' },
      targetEnvironment: 'production',
    });

    expect(result.approved).toBe(false);
    expect(result.record.status).toBe('denied');
    expect(result.record.denialReason).toBe('风险过高');
  });

  it('参数变化后需要重新审批', async () => {
    let callCount = 0;
    const manager = new ApprovalManager({
      store,
      auditLogger,
      approvalHandler: async () => {
        callCount++;
        return { approved: true, approver: 'admin' };
      },
    });

    // 第一次请求
    await manager.requestApproval({
      operation: 'run_command',
      riskLevel: 'L2',
      summary: '运行命令',
      params: { cmd: 'npm test' },
      targetEnvironment: 'local',
    });

    // 相同参数：复用审批，handler 不被再次调用
    await manager.requestApproval({
      operation: 'run_command',
      riskLevel: 'L2',
      summary: '运行命令',
      params: { cmd: 'npm test' },
      targetEnvironment: 'local',
    });

    expect(callCount).toBe(1);

    // 参数变化：需要重新审批
    await manager.requestApproval({
      operation: 'run_command',
      riskLevel: 'L2',
      summary: '运行命令',
      params: { cmd: 'npm run build' },
      targetEnvironment: 'local',
    });

    expect(callCount).toBe(2);
  });
});
