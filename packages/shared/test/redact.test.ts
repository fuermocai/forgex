import { describe, expect, it } from 'vitest';
import { redactText, redactValue, safeStringify } from '../src/index.js';

describe('redact', () => {
  it('替换 sk- 形式的 API Key', () => {
    const text = 'using key sk-abcdef1234567890 for request';
    expect(redactText(text)).not.toContain('sk-abcdef1234567890');
    expect(redactText(text)).toContain('sk-***');
  });

  it('替换 Bearer token', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    expect(redactText(text)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('替换 key=value 形式的密码', () => {
    expect(redactText('password=hunter2')).not.toContain('hunter2');
    expect(redactText('api_key: "abcd1234"')).not.toContain('abcd1234');
  });

  it('替换 URL 内嵌凭证', () => {
    expect(redactText('https://user:pass123@example.com/x')).not.toContain('pass123');
  });

  it('按字段名脱敏对象', () => {
    const out = redactValue({ apiKey: 'secret-value', nested: { password: 'p', name: 'ok' } }) as Record<string, any>;
    expect(out.apiKey).toBe('***');
    expect(out.nested.password).toBe('***');
    expect(out.nested.name).toBe('ok');
  });

  it('处理循环引用', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => safeStringify(obj)).not.toThrow();
  });
});
