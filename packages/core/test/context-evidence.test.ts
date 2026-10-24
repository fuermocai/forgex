/**
 * ContextManager × EvidenceStore 集成测试（v0.3.0 Phase 5）。
 *
 * 验证"第 0 步"证据外置：
 *   - 超预算时超长工具输出被外置为证据引用，原文可取回
 *   - 最近一条工具输出不外置（当前轮模型要看完整结果）
 *   - 不外置时行为与旧版一致（无 evidenceStore 时 externalized=0）
 *   - 已外置的占位符不重复外置
 *   - 外置后仍超预算时继续走截断/删除降级链
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { ChatMessage } from '@forgex/shared';
import { ContextManager } from '../src/context/context-manager.js';
import { EvidenceStore } from '../src/context/evidence-store.js';

/** 造一个 token 数大致为 n 的文本（英文单词约 1 token/词，估算器按字符/4） */
function makeBigText(tokens: number): string {
  // estimateTokens 大约 4 字符 ≈ 1 token
  return 'log line: something happened\n'.repeat(Math.ceil((tokens * 4) / 29));
}

function toolMsg(content: string, callId: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: callId, name: 'run_command' };
}

describe('ContextManager 证据外置', () => {
  let store: EvidenceStore;

  beforeEach(() => {
    store = new EvidenceStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('未配置 evidenceStore 时 externalized 恒为 0（行为不变）', () => {
    const manager = new ContextManager({
      systemPrompt: 'sys',
      contextWindow: 4096,
      maxOutputTokens: 512,
    });
    manager.append({ role: 'user', content: 'task' });
    manager.append(toolMsg(makeBigText(3000), 'c1'));
    manager.append({ role: 'user', content: 'next' });
    manager.append(toolMsg(makeBigText(3000), 'c2'));

    const result = manager.build();
    expect(result.externalized).toBe(0);
    expect(result.compressed).toBe(true);
  });

  it('超预算时旧的超长工具输出被外置，原文可从证据库取回', () => {
    const manager = new ContextManager({
      systemPrompt: 'sys',
      contextWindow: 4096,
      maxOutputTokens: 512,
      evidenceStore: store,
      evidenceSessionId: 'sess-1',
    });
    const original = makeBigText(2500);
    manager.append({ role: 'user', content: 'task' });
    manager.append(toolMsg(original, 'c1'));
    manager.append({ role: 'user', content: 'go on' });
    manager.append(toolMsg(makeBigText(2000), 'c2'));

    const result = manager.build();
    expect(result.externalized).toBeGreaterThanOrEqual(1);
    expect(result.compressed).toBe(true);

    // 消息里留下了引用占位符
    const externalizedMsg = result.messages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'c1',
    );
    expect(externalizedMsg).toBeDefined();
    expect(externalizedMsg!.content).toContain('evidence_id=');

    // 凭 id 可取回原文
    const refs = store.listBySession('sess-1');
    expect(refs.length).toBeGreaterThanOrEqual(1);
    const record = store.get(refs[0]!.id)!;
    expect(record.content).toBe(original);
    expect(record.byteLen).toBe(Buffer.byteLength(original, 'utf8'));
  });

  it('最近一条工具输出不外置', () => {
    const manager = new ContextManager({
      systemPrompt: 'sys',
      contextWindow: 4096,
      maxOutputTokens: 512,
      evidenceStore: store,
    });
    manager.append({ role: 'user', content: 'task' });
    manager.append(toolMsg(makeBigText(2500), 'c1'));
    manager.append({ role: 'user', content: 'next' });
    manager.append(toolMsg(makeBigText(2500), 'c2'));

    const result = manager.build();
    const last = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c2');
    expect(last).toBeDefined();
    // 最近一条即使超长也不应出现占位符（它可能被后续步骤截断，但不是外置）
    expect(last!.content).not.toContain('[内容已外置为证据');
  });

  it('短工具输出不外置（低于阈值）', () => {
    const manager = new ContextManager({
      systemPrompt: 'sys',
      contextWindow: 4096,
      maxOutputTokens: 512,
      evidenceStore: store,
      evidenceMinTokens: 500,
    });
    manager.append({ role: 'user', content: 'task' });
    manager.append(toolMsg('short output', 'c1'));
    manager.append({ role: 'user', content: 'next' });
    manager.append(toolMsg(makeBigText(3000), 'c2'));

    const result = manager.build();
    expect(result.externalized).toBe(0);
    expect(store.count()).toBe(0);
  });

  it('未超预算时即使输出超长也不外置', () => {
    const manager = new ContextManager({
      systemPrompt: 'sys',
      contextWindow: 128 * 1024,
      maxOutputTokens: 512,
      evidenceStore: store,
    });
    manager.append({ role: 'user', content: 'task' });
    manager.append(toolMsg(makeBigText(2000), 'c1'));

    const result = manager.build();
    expect(result.externalized).toBe(0);
    expect(result.compressed).toBe(false);
    expect(store.count()).toBe(0);
  });

  it('外置后历史被就地更新，再次 build 不重复外置占位符', () => {
    const manager = new ContextManager({
      systemPrompt: 'sys',
      contextWindow: 4096,
      maxOutputTokens: 512,
      evidenceStore: store,
    });
    manager.append({ role: 'user', content: 'task' });
    manager.append(toolMsg(makeBigText(2500), 'c1'));
    manager.append({ role: 'user', content: 'next' });
    manager.append(toolMsg(makeBigText(2500), 'c2'));

    const first = manager.build();
    const firstCount = store.count();
    expect(first.externalized).toBeGreaterThanOrEqual(1);
    // c1 的占位符内容（含 evidence_id）在后续轮次中不应变化
    const c1Placeholder = manager.raw.find((m) => m.tool_call_id === 'c1')!.content;
    expect(c1Placeholder).toContain('[内容已外置为证据');

    // 第二轮：c2 从"最新"变"旧"被合法外置（+1），但 c1 的占位符不重复外置
    manager.append({ role: 'user', content: 'again' });
    manager.append(toolMsg(makeBigText(2500), 'c3'));
    manager.build();
    expect(store.count()).toBeLessThanOrEqual(firstCount + 1);
    expect(manager.raw.find((m) => m.tool_call_id === 'c1')!.content).toBe(c1Placeholder);
  });

  it('外置后仍超预算时继续降级（截断/删除）且最终不超预算', () => {
    const manager = new ContextManager({
      systemPrompt: 'sys',
      contextWindow: 2048,
      maxOutputTokens: 512,
      safetyMarginTokens: 128,
      evidenceStore: store,
    });
    for (let i = 0; i < 4; i++) {
      manager.append({ role: 'user', content: `round ${i}` });
      manager.append(toolMsg(makeBigText(1500), `c${i}`));
    }
    const result = manager.build();
    expect(result.compressed).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(manager.budgetTokens());
  });
});
