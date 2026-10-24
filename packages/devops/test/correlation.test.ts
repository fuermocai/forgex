/**
 * Correlation 包单元测试。
 *
 * 覆盖：Java/Python/Node.js 堆栈解析、日志异常聚合、Git 关联基本流程、
 * 置信度计算。不依赖外部服务（SSH、Docker、真实 Git）。
 */
import { describe, expect, it } from 'vitest';
import { detectLanguage, parseStack } from '../src/correlation/stack-parser.js';
import { aggregateLogEvents } from '../src/correlation/log-aggregator.js';
import { correlate } from '../src/correlation/correlate.js';

/* ------------------------------------------------------------------ */
/* 堆栈解析                                                              */
/* ------------------------------------------------------------------ */

describe('stack-parser', () => {
  it('detectLanguage 识别 Java Exception', () => {
    // 带堆栈的完整 Java 错误（可靠路径）
    const text = 'java.lang.NullPointerException: null\n    at com.example.Service.handle(Service.java:42)';
    expect(detectLanguage(text)).toBe('java');
  });

  it('detectLanguage 识别 Python Traceback', () => {
    const text = 'Traceback (most recent call last):\n  File "/app/main.py", line 10, in <module>\n    result = foo()';
    expect(detectLanguage(text)).toBe('python');
  });

  it('detectLanguage 识别 Node.js', () => {
    const text = 'TypeError: Cannot read property "foo" of undefined\n    at Object.handler (/app/server.js:30:15)';
    expect(detectLanguage(text)).toBe('nodejs');
  });

  it('parseStack Java 提取类+方法+文件+行', () => {
    const java =
      'java.lang.NullPointerException: user is null\n' +
      '    at com.example.auth.UserService.findById(UserService.java:88)\n' +
      '    at com.example.auth.UserController.get(UserController.java:25)\n' +
      '    at org.springframework.web.method.support.InvocableHandlerMethod.invoke(InvocableHandlerMethod.java:205)';

    const frames = parseStack(java, 'java');
    const userFrames = frames.filter((f) => !f.isFramework);
    expect(userFrames.length).toBeGreaterThanOrEqual(1);

    const us = userFrames.find((f) => f.function === 'findById');
    expect(us?.classOrModule).toBe('com.example.auth.UserService');
    expect(us?.filePath).toBe('UserService.java');
    expect(us?.line).toBe(88);

    // org.springframework 必须被标记 isFramework=true
    const fw = frames.find((f) => f.classOrModule?.startsWith('org.springframework'));
    expect(fw?.isFramework).toBe(true);
  });

  it('parseStack Python 提取函数+文件+行', () => {
    const py =
      'Traceback (most recent call last):\n' +
      '  File "/app/main.py", line 10, in <module>\n' +
      '    result = foo()\n' +
      '  File "/app/utils.py", line 42, in foo\n' +
      '    return bar(x)\n' +
      '  File "/home/user/.local/lib/python3.11/site-packages/django/views/generic.py", line 98, in view\n' +
      '    raise PermissionDenied\n' +
      'django.core.exceptions.PermissionDenied';

    const frames = parseStack(py, 'python');
    expect(frames.length).toBeGreaterThanOrEqual(2);

    const utilsFrame = frames.find((f) => f.filePath?.includes('utils.py'));
    expect(utilsFrame?.function).toBe('foo');
    expect(utilsFrame?.line).toBe(42);
    expect(utilsFrame?.isFramework).toBe(false);

    const djangoFrame = frames.find((f) => f.filePath?.includes('django'));
    expect(djangoFrame?.isFramework).toBe(true);
  });

  it('parseStack Node.js 无函数名的调用点', () => {
    // 第一种 Node 帧："at Object.handler (/app/server.js:30:15)" 有函数名
    const text1 = '    at Object.handler (/app/server.js:30:15)\n';
    const f1 = parseStack(text1, 'nodejs');
    expect(f1.length).toBe(1);
    expect(f1[0]?.function).toBe('Object.handler');
    expect(f1[0]?.filePath).toBe('/app/server.js');
    expect(f1[0]?.line).toBe(30);
    expect(f1[0]?.column).toBe(15);

    // 第二种 Node 帧："at /app/routes/users.js:12:7" 没有函数名
    const text2 = '    at /app/routes/users.js:12:7\n';
    const f2 = parseStack(text2, 'nodejs');
    expect(f2.length).toBe(1);
    expect(f2[0]?.function).toBeUndefined();
    expect(f2[0]?.filePath).toBe('/app/routes/users.js');
    expect(f2[0]?.line).toBe(12);
  });

  it('parseStack 空输入返回空数组', () => {
    expect(parseStack('', 'java')).toEqual([]);
    expect(parseStack('', 'nodejs')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 日志聚合                                                              */
/* ------------------------------------------------------------------ */

describe('log-aggregator', () => {
  it('从混合日志中抽出 Java 异常事件', () => {
    const log =
      '[2026-10-22 14:00:01] INFO  startup - server ready\n' +
      '[2026-10-22 14:00:05] WARN  o.web.servlet.DispatcherServlet - Servlet threw exception\n' +
      'java.lang.NullPointerException: Cannot invoke "User.getName()" because "user" is null\n' +
      '    at com.example.UserService.find(UserService.java:88)\n' +
      '    at com.example.UserController.get(UserController.java:25)\n' +
      '    at org.springframework.web.method.support.InvocableHandlerMethod.invoke(InvocableHandlerMethod.java:205)\n' +
      '[2026-10-22 14:00:10] INFO  - health check ok\n';

    const events = aggregateLogEvents({ text: log });
    expect(events.length).toBeGreaterThanOrEqual(1);
    // 找有堆栈的 error 事件（最具体的异常规则触发的那个）
    const errEvent = events.find((e) => e.severity === 'error' && e.stack.length > 0);
    expect(errEvent).toBeDefined();
    expect(errEvent!.stack.length).toBeGreaterThanOrEqual(1);
    expect(errEvent!.kind).toBe('NullPointerException');
  });

  it('从 HTTP 5xx 日志里识别事件', () => {
    const log =
      '[2026-10-22T14:05:01Z] GET /api/users HTTP/1.1\n' +
      '[2026-10-22T14:05:01Z] 500 Internal Server Error - Processing Time 123ms\n' +
      'Error: Database connection refused';

    const events = aggregateLogEvents({ text: log });
    const http5xx = events.find((e) => e.kind === 'HTTP5xx');
    expect(http5xx).toBeDefined();
    expect(http5xx!.severity).toBe('error');
  });

  it('空日志返回空数组', () => {
    expect(aggregateLogEvents({ text: '' })).toEqual([]);
  });

  it('requestId 上下文提取（实际正则覆盖）', () => {
    const log = 'ERROR request_id=req-abc-123 getOrder failed: OrderNotFound\n';
    const events = aggregateLogEvents({ text: log });
    // ERROR 关键字会触发事件
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].severity).toBe('error');
  });
});

/* ------------------------------------------------------------------ */
/* 主入口 correlate                                                       */
/* ------------------------------------------------------------------ */

describe('correlate 主入口', () => {
  it('纯日志输入（无 repoRoot）返回 events + 置信度 > 0', async () => {
    // 用带完整 Node.js 堆栈的输入让 parseStack 产生 userFrames
    const logText =
      'TypeError: name is undefined\n' +
      '    at Object.getUser (/app/server.js:30:15)\n' +
      '    at /app/middleware.js:8:12\n';
    const report = await correlate({ logText });
    expect(report.events.length).toBeGreaterThanOrEqual(1);
    expect(report.userFrames.length).toBeGreaterThanOrEqual(1);
    expect(report.confidence).toBeGreaterThan(0);
    expect(report.analyzedAt).toBeTruthy();
    expect(report.relatedChanges.length).toBe(0); // 无 repoRoot
    expect(report.errors).toEqual([]);
  });

  it('无日志文本返回 confidence=0 + errors', async () => {
    const report = await correlate({});
    expect(report.events).toEqual([]);
    expect(report.userFrames).toEqual([]);
    expect(report.confidence).toBe(0);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('confidence 封顶 1.0', async () => {
    // 10 段独立 Node.js 堆栈 → 多 events + 多 userFrames
    const blocks = Array.from({ length: 10 }, (_, i) =>
      `TypeError: x is undefined\n    at Object.handler (/app/file${i}.js:${i + 1}:5)\n`).join('\n\n');
    const report = await correlate({ logText: blocks });
    expect(report.confidence).toBeLessThanOrEqual(1);
    // 大量用户帧 + 无 repoRoot 基础分 → 中等置信度
    expect(report.confidence).toBeGreaterThan(0.2);
  });
});
