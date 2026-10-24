/**
 * MemoryValidator：记忆写入前的合法性校验（v0.3.0 Phase 4）。
 *
 * 安全底线（对应项目硬约束）：
 *   - API Key / 密码 / token / 私钥等敏感信息绝不允许入库；
 *   - 检测命中即抛 MEMORY_SENSITIVE_CONTENT，不存在"降级入库"路径；
 *   - 错误消息不回显敏感内容本身，只给出命中的模式类别，避免二次泄露。
 *
 * 其他校验：
 *   - key 格式（MEMORY_KEY_PATTERN）
 *   - content 长度上限（MAX_CONTENT_BYTES）
 *   - confidence 区间 [0, 1]
 *   - scope 与 session_id / task_id 一致性
 *   以上违例抛 MEMORY_INVALID。
 */
import { ForgeError } from '@forgex/shared';
import {
  MEMORY_KEY_PATTERN,
  MAX_CONTENT_BYTES,
  scopeFieldsConsistent,
  type CreateMemoryInput,
} from './types.js';

/* ------------------------------------------------------------------ */
/* 敏感模式库                                                            */
/* ------------------------------------------------------------------ */

interface SensitivePattern {
  /** 模式类别名（错误消息中只暴露类别，不回显内容） */
  label: string;
  pattern: RegExp;
}

/**
 * 常见敏感信息模式。
 * 注意：正则不追求完美覆盖所有密钥格式，目标是拦截"明显不该入库"的内容；
 * 漏网的边缘格式由"Agent 不应主动生成敏感串"的行为约束兜底。
 */
const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  // OpenAI / Anthropic / 常见 API key 前缀
  { label: 'api_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: 'api_key', pattern: /\bkey-[A-Za-z0-9_-]{20,}/ },
  // AWS Access Key ID
  { label: 'aws_access_key', pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/ },
  // PEM 私钥头
  { label: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // 通用赋值形态：password= / passwd: / secret= / token= / api_key= 等
  {
    label: 'credential_assignment',
    pattern: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token)\b\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  },
  // Bearer token
  { label: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  // JWT（三段 base64url）
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  // GitHub（ghp_/gho_ 等下划线分隔）与 GitLab（glpat- 连字符分隔）token
  { label: 'vcs_token', pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{16,}\b/ },
  { label: 'vcs_token', pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/ },
  // Slack / 通用 webhook 里的 secret 段较长时拦下（短 id 放行避免误报）
  { label: 'webhook_secret', pattern: /hooks\.[a-z]+\.[a-z]+\/services\/[A-Z0-9/]{18,}/i },
];

/** 供测试与审计检视的模式类别清单 */
export const SENSITIVE_LABELS: readonly string[] = [
  ...new Set(SENSITIVE_PATTERNS.map((p) => p.label)),
];

/** 检测文本是否含敏感信息；命中返回类别，未命中返回 null */
export function detectSensitiveContent(text: string): string | null {
  for (const { label, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 入参校验                                                              */
/* ------------------------------------------------------------------ */

/**
 * 校验 CreateMemoryInput 的合法性。
 * 任何违例直接抛 ForgeError，调用方（MemoryManager.remember）据此拒绝写入。
 */
export function validateMemoryInput(input: CreateMemoryInput): void {
  // key 格式
  if (!MEMORY_KEY_PATTERN.test(input.key)) {
    throw new ForgeError('MEMORY_INVALID', `记忆 key 格式非法: "${input.key}"`, {
      details: { key: input.key, pattern: MEMORY_KEY_PATTERN.source },
    });
  }

  // content 非空且长度受限（按 UTF-8 字节计，中文占 3 字节）
  const contentBytes = Buffer.byteLength(input.content, 'utf8');
  if (contentBytes === 0) {
    throw new ForgeError('MEMORY_INVALID', '记忆内容不能为空');
  }
  if (contentBytes > MAX_CONTENT_BYTES) {
    throw new ForgeError('MEMORY_INVALID', `记忆内容超长: ${contentBytes} 字节（上限 ${MAX_CONTENT_BYTES}）`, {
      details: { contentBytes, max: MAX_CONTENT_BYTES },
    });
  }

  // confidence 区间
  if (input.confidence !== undefined) {
    if (Number.isNaN(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new ForgeError('MEMORY_INVALID', `confidence 必须在 [0, 1] 区间: ${input.confidence}`, {
        details: { confidence: input.confidence },
      });
    }
  }

  // scope 与关联字段一致性
  if (!scopeFieldsConsistent(input)) {
    throw new ForgeError(
      'MEMORY_INVALID',
      `scope=${input.scope} 与 session_id/task_id 组合不一致`,
      {
        details: {
          scope: input.scope,
          hasSessionId: input.session_id !== undefined,
          hasTaskId: input.task_id !== undefined,
        },
      },
    );
  }

  // workspace 必填非空（记忆必须归属具体工作区，禁止"全局漂浮"）
  if (typeof input.workspace !== 'string' || input.workspace.trim().length === 0) {
    throw new ForgeError('MEMORY_INVALID', 'workspace 不能为空');
  }

  // 敏感内容：content 与 key 都检（key 也可能带 secret）
  const contentHit = detectSensitiveContent(input.content);
  if (contentHit !== null) {
    throw new ForgeError('MEMORY_SENSITIVE_CONTENT', `记忆内容包含敏感信息（${contentHit}），已拒绝写入`, {
      details: { category: contentHit, key: input.key },
    });
  }
  const keyHit = detectSensitiveContent(input.key);
  if (keyHit !== null) {
    throw new ForgeError('MEMORY_SENSITIVE_CONTENT', `记忆 key 包含敏感信息（${keyHit}），已拒绝写入`, {
      details: { category: keyHit },
    });
  }

  // evidence_refs 里同样不允许夹带敏感串
  for (const ref of input.evidence_refs ?? []) {
    const refHit = detectSensitiveContent(ref);
    if (refHit !== null) {
      throw new ForgeError(
        'MEMORY_SENSITIVE_CONTENT',
        `evidence_refs 包含敏感信息（${refHit}），已拒绝写入`,
        { details: { category: refHit, key: input.key } },
      );
    }
  }
}
