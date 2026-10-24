/**
 * 消息协议校验。
 *
 * OpenAI-compatible 接口对 tool 消息有硬约束：
 *   assistant(tool_calls) 之后必须紧跟每个 id 对应的 tool 消息，
 *   且在下一个非 tool 消息出现前全部补齐，否则服务端直接 400。
 *
 * 该函数用于：
 *  - 单元测试断言上下文管理没有破坏协议；
 *  - Agent Loop 在发起请求前做最后一道自检（失败则本地修复而不是请求超时）。
 */
import type { ChatMessage } from '../types/index.js';

export interface ProtocolIssue {
  index: number;
  code: 'MISSING_TOOL_RESULT' | 'ORPHAN_TOOL_RESULT' | 'DUPLICATE_TOOL_CALL_ID' | 'EMPTY_TOOL_CALL_ID';
  message: string;
}

export function validateMessageProtocol(messages: ReadonlyArray<ChatMessage>): ProtocolIssue[] {
  const issues: ProtocolIssue[] = [];
  let pending: string[] = [];

  const flush = (atIndex: number) => {
    if (pending.length > 0) {
      issues.push({
        index: atIndex,
        code: 'MISSING_TOOL_RESULT',
        message: `缺少 tool_result，未配对的 tool_call_id: ${pending.join(', ')}`,
      });
      pending = [];
    }
  };

  messages.forEach((msg, index) => {
    if (msg.role === 'tool') {
      if (!msg.tool_call_id) {
        issues.push({ index, code: 'EMPTY_TOOL_CALL_ID', message: 'tool 消息缺少 tool_call_id' });
        return;
      }
      const pos = pending.indexOf(msg.tool_call_id);
      if (pos === -1) {
        issues.push({
          index,
          code: 'ORPHAN_TOOL_RESULT',
          message: `tool 结果 ${msg.tool_call_id} 没有对应的 tool_call`,
        });
      } else {
        pending.splice(pos, 1);
      }
      return;
    }

    // 遇到任何非 tool 消息，之前的 pending 必须已经清空
    flush(index);

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const seen = new Set<string>();
      for (const call of msg.tool_calls) {
        if (!call.id) {
          issues.push({ index, code: 'EMPTY_TOOL_CALL_ID', message: 'assistant.tool_calls 存在空 id' });
          continue;
        }
        if (seen.has(call.id)) {
          issues.push({
            index,
            code: 'DUPLICATE_TOOL_CALL_ID',
            message: `同一 assistant 消息内出现重复 tool_call_id: ${call.id}`,
          });
        }
        seen.add(call.id);
        pending.push(call.id);
      }
    }
  });

  flush(messages.length);
  return issues;
}

/** 协议是否合法 */
export function isProtocolValid(messages: ReadonlyArray<ChatMessage>): boolean {
  return validateMessageProtocol(messages).length === 0;
}
