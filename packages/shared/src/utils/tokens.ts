/**
 * Token 估算。
 *
 * 为什么不用 tiktoken：
 *  - 需要下载词表，破坏离线部署与供应链可控性；
 *  - 国产模型（Qwen/DeepSeek）分词器各不相同，估算误差本来就存在。
 *
 * 策略：CJK 字符按 1 token/字，其余按 4 字符/token 估算，并叠加消息开销。
 * 该值只用于"预算水位线"判断，不作为计费依据。
 */

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/** 单条消息的协议开销（role、分隔符等），按 OpenAI 经验值取 4 */
const MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK) ?? []).length;
  const rest = text.replace(CJK, '');
  return cjkCount + Math.ceil(rest.length / 4);
}

export interface TokenizableMessage {
  role: string;
  content: string | null;
  tool_calls?: ReadonlyArray<{ function: { name: string; arguments: string } }>;
}

/** 估算一组消息的总 token（含协议开销） */
export function estimateMessagesTokens(messages: ReadonlyArray<TokenizableMessage>): number {
  let total = 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD + estimateTokens(m.role);
    total += estimateTokens(m.content ?? '');
    if (m.tool_calls) {
      for (const call of m.tool_calls) {
        total += estimateTokens(call.function.name) + estimateTokens(call.function.arguments) + MESSAGE_OVERHEAD;
      }
    }
  }
  return total;
}
