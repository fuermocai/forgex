import { describe, expect, it } from 'vitest';
import {
  createUnifiedDiff,
  diffStat,
  estimateMessagesTokens,
  estimateTokens,
  truncateUtf8,
  validateMessageProtocol,
  type ChatMessage,
} from '../src/index.js';

describe('tokens', () => {
  it('中文按字估算，英文按 4 字符估算', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('消息估算包含协议开销', () => {
    const msgs = [
      { role: 'system', content: 'hi' },
      { role: 'user', content: 'hello' },
    ];
    expect(estimateMessagesTokens(msgs)).toBeGreaterThan(8);
  });
});

describe('text', () => {
  it('按 UTF-8 字节截断不会切坏中文', () => {
    const text = '中'.repeat(1000);
    const { text: out, truncated } = truncateUtf8(text, 100);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200);
    // 不应出现 Unicode 替换字符
    expect(out).not.toContain('\uFFFD');
  });

  it('未超限时原样返回', () => {
    expect(truncateUtf8('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
});

describe('diff', () => {
  it('统计新增删除行', () => {
    const stat = diffStat('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(stat.added).toBe(2);
    expect(stat.removed).toBe(1);
  });

  it('生成 unified diff 且包含 hunk 头', () => {
    const { patch, hasChanges } = createUnifiedDiff('line1\nline2\nline3\n', 'line1\nlineX\nline3\n', 'demo.ts');
    expect(hasChanges).toBe(true);
    expect(patch).toContain('--- a/demo.ts');
    expect(patch).toContain('+++ b/demo.ts');
    expect(patch).toContain('@@');
    expect(patch).toContain('-line2');
    expect(patch).toContain('+lineX');
  });

  it('无变更时返回空 patch', () => {
    const { patch, hasChanges } = createUnifiedDiff('same\n', 'same\n');
    expect(hasChanges).toBe(false);
    expect(patch).toBe('');
  });
});

describe('protocol', () => {
  const call = (id: string) => ({
    role: 'assistant' as const,
    content: null,
    tool_calls: [{ id, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }],
  });

  it('配对完整时合法', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      call('c1'),
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'ok' },
    ];
    expect(validateMessageProtocol(messages)).toEqual([]);
  });

  it('缺少 tool_result 会被发现', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }, call('c1')];
    const issues = validateMessageProtocol(messages);
    expect(issues[0]?.code).toBe('MISSING_TOOL_RESULT');
  });

  it('孤儿 tool_result 会被发现', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'nope', content: 'x' },
    ];
    expect(validateMessageProtocol(messages)[0]?.code).toBe('ORPHAN_TOOL_RESULT');
  });

  it('同一消息内重复 tool_call_id 会被发现', () => {
    const message: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'dup', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'dup', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    };
    const issues = validateMessageProtocol([message]);
    expect(issues.some((i) => i.code === 'DUPLICATE_TOOL_CALL_ID')).toBe(true);
  });
});
