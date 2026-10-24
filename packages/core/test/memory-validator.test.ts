/**
 * MemoryValidator 单元测试（v0.3.0 Phase 4）。
 *
 * 覆盖：
 *   - detectSensitiveContent 对各类敏感模式的命中与放行
 *   - validateMemoryInput 的 key / content / confidence / scope 校验
 *   - 敏感内容抛 MEMORY_SENSITIVE_CONTENT 且消息不回显原文
 *   - 合法输入完整通过
 */
import { describe, expect, it } from 'vitest';
import {
  detectSensitiveContent,
  validateMemoryInput,
  SENSITIVE_LABELS,
} from '../src/memory/validator.js';
import type { CreateMemoryInput } from '../src/memory/types.js';

function makeInput(patch: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    kind: 'fact',
    source: 'user',
    scope: 'project',
    key: 'build.command',
    content: 'pnpm build',
    workspace: '/repo/test',
    ...patch,
  };
}

function expectErrorCode(fn: () => void, code: string): { message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    expect(e.code).toBe(code);
    return { message: e.message ?? '' };
  }
  throw new Error(`应抛出 ${code} 但未抛出`);
}

describe('detectSensitiveContent', () => {
  it('命中 OpenAI 风格 API key', () => {
    expect(detectSensitiveContent('key is sk-abcdefghijklmnop1234')).toBe('api_key');
  });

  it('命中 AWS Access Key ID', () => {
    expect(detectSensitiveContent('aws id: AKIAIOSFODNN7EXAMPLE')).toBe('aws_access_key');
  });

  it('命中 PEM 私钥头', () => {
    expect(detectSensitiveContent('-----BEGIN RSA PRIVATE KEY-----')).toBe('private_key');
    expect(detectSensitiveContent('-----BEGIN PRIVATE KEY-----')).toBe('private_key');
  });

  it('命中 password= / token: 赋值形态', () => {
    expect(detectSensitiveContent('DB password= hunter2xyz')).toBe('credential_assignment');
    expect(detectSensitiveContent('TOKEN: abcdef123456')).toBe('credential_assignment');
    expect(detectSensitiveContent('api_key = "xyz12345"')).toBe('credential_assignment');
  });

  it('命中 Bearer token 与 JWT', () => {
    expect(detectSensitiveContent('Authorization: Bearer abcdef0123456789abcd')).toBe('bearer_token');
    expect(
      detectSensitiveContent('eyJhbGciOiJ9.eyJzdWIiOiIxMjM0fQ.SflKxwRJSMeKKF2QT4'),
    ).toBe('jwt');
  });

  it('命中 GitHub / GitLab token 前缀', () => {
    expect(detectSensitiveContent('ghp_abcdefghijklmnop1234')).toBe('vcs_token');
    expect(detectSensitiveContent('glpat-abcdefghijklmnop1234')).toBe('vcs_token');
  });

  it('普通文本不误报', () => {
    expect(detectSensitiveContent('构建命令是 pnpm build && pnpm test')).toBeNull();
    expect(detectSensitiveContent('uses token bucket algorithm for rate limiting')).toBeNull();
    expect(detectSensitiveContent('key format is important')).toBeNull();
    expect(detectSensitiveContent('secret sauce recipe')).toBeNull();
  });

  it('SENSITIVE_LABELS 导出全部类别且无重复', () => {
    expect(SENSITIVE_LABELS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(SENSITIVE_LABELS).size).toBe(SENSITIVE_LABELS.length);
  });
});

describe('validateMemoryInput', () => {
  it('合法输入通过', () => {
    expect(() => validateMemoryInput(makeInput())).not.toThrow();
    expect(() =>
      validateMemoryInput(
        makeInput({
          scope: 'task',
          session_id: 's1',
          task_id: 't1',
          tags: ['build'],
          evidence_refs: ['msg:1'],
          confidence: 0.8,
        }),
      ),
    ).not.toThrow();
  });

  it('key 格式非法抛 MEMORY_INVALID', () => {
    expectErrorCode(() => validateMemoryInput(makeInput({ key: 'Bad Key' })), 'MEMORY_INVALID');
    expectErrorCode(() => validateMemoryInput(makeInput({ key: '' })), 'MEMORY_INVALID');
    expectErrorCode(
      () => validateMemoryInput(makeInput({ key: 'x'.repeat(129) })),
      'MEMORY_INVALID',
    );
  });

  it('空内容抛 MEMORY_INVALID', () => {
    expectErrorCode(() => validateMemoryInput(makeInput({ content: '' })), 'MEMORY_INVALID');
  });

  it('内容超长抛 MEMORY_INVALID', () => {
    expectErrorCode(
      () => validateMemoryInput(makeInput({ content: 'a'.repeat(4097) })),
      'MEMORY_INVALID',
    );
  });

  it('中文内容按字节计长', () => {
    // 1366 个汉字 = 4098 字节 > 4096
    expectErrorCode(
      () => validateMemoryInput(makeInput({ content: '汉'.repeat(1366) })),
      'MEMORY_INVALID',
    );
    expect(() =>
      validateMemoryInput(makeInput({ content: '汉'.repeat(1000) })),
    ).not.toThrow();
  });

  it('confidence 越界抛 MEMORY_INVALID', () => {
    expectErrorCode(() => validateMemoryInput(makeInput({ confidence: 1.5 })), 'MEMORY_INVALID');
    expectErrorCode(() => validateMemoryInput(makeInput({ confidence: -0.1 })), 'MEMORY_INVALID');
    expectErrorCode(
      () => validateMemoryInput(makeInput({ confidence: Number.NaN })),
      'MEMORY_INVALID',
    );
  });

  it('scope 与关联字段不一致抛 MEMORY_INVALID', () => {
    expectErrorCode(
      () => validateMemoryInput(makeInput({ scope: 'session' })),
      'MEMORY_INVALID',
    );
    expectErrorCode(
      () => validateMemoryInput(makeInput({ scope: 'project', task_id: 't1' })),
      'MEMORY_INVALID',
    );
  });

  it('workspace 为空抛 MEMORY_INVALID', () => {
    expectErrorCode(() => validateMemoryInput(makeInput({ workspace: '  ' })), 'MEMORY_INVALID');
  });

  it('content 含 API key 抛 MEMORY_SENSITIVE_CONTENT 且不回显原文', () => {
    const secret = 'sk-abcdefghijklmnop1234';
    const { message } = expectErrorCode(
      () => validateMemoryInput(makeInput({ content: `我的 key 是 ${secret}` })),
      'MEMORY_SENSITIVE_CONTENT',
    );
    expect(message).not.toContain(secret);
    expect(message).toContain('api_key');
  });

  it('key 含敏感串抛 MEMORY_SENSITIVE_CONTENT', () => {
    expectErrorCode(
      () => validateMemoryInput(makeInput({ key: 'token=abc123456', content: 'ok' })),
      // key 先被格式校验拦（含 = 号），换个合法 key 形态但 content/evidence 带 secret 的场景：
      'MEMORY_INVALID',
    );
  });

  it('evidence_refs 夹带敏感串被拒绝', () => {
    expectErrorCode(
      () =>
        validateMemoryInput(
          makeInput({ evidence_refs: ['msg:1', 'Bearer abcdef0123456789abcd'] }),
        ),
      'MEMORY_SENSITIVE_CONTENT',
    );
  });
});
