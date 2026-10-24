/**
 * 堆栈解析器（stack-parser）。
 *
 * 支持：Java / Python / Node.js / Go 基础格式。
 * 纯正则 + 字符串匹配，不调 LLM，确定性产出。
 */
import type { Language, StackFrame } from './types.js';

export function detectLanguage(text: string): Language {
  // 优先匹配带堆栈的格式（可靠度更高）
  if (/\bat\s+[\w$.]+\(.*:\d+\)/m.test(text)) {
    if (/(?:Exception|Error|Throwable|Caused by)\s*:/m.test(text)) return 'java';
  }
  if (/\bFile\s+"[^"]+",\s*line\s+\d+,\s*in/m.test(text)) {
    if (/Traceback\s*\(most recent call last\)/m.test(text)) return 'python';
  }
  if (/\bat\s+(?:[\w$.]+@)?[^:]+:\d+(?::\d+)?/m.test(text)) {
    if (/\b(TypeError|ReferenceError|SyntaxError|RangeError)\s*:/m.test(text)) return 'nodejs';
  }
  // 没有堆栈，但有明显 Exception 名 → 仍判 Java
  if (/[\w.$]+Exception\s*:/m.test(text) || /[\w.$]+Error\s*:/m.test(text)) return 'java';
  if (/\bpanic:\s|goroutine\s+\d+\s+\[/m.test(text)) return 'unknown';
  return 'unknown';
}

export function parseStack(text: string, language?: Language): StackFrame[] {
  const lang = language ?? detectLanguage(text);
  switch (lang) {
    case 'java':
      return parseJava(text);
    case 'python':
      return parsePython(text);
    case 'nodejs':
      return parseNodeJs(text);
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ */
/* Java                                                                 */
/* ------------------------------------------------------------------ */

const JAVA_FRAME_RE = /^([ \t]*)at\s+([\w$.]+)\(([^)]+)\)\s*(?:~\[([^\]]+)\])?\s*$/gm;

function parseJava(text: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const firstBlock = extractFirstJavaStackBlock(text);
  for (const m of firstBlock.matchAll(JAVA_FRAME_RE)) {
    const method = m[2] ?? '';
    const loc = m[3] ?? '';
    const [className, fn] = splitJavaClassMethod(method);
    const { filePath, line } = parseJavaLocation(loc);
    frames.push({
      function: fn || undefined,
      classOrModule: className || undefined,
      filePath,
      line,
      isFramework: isJavaFramework(className),
      raw: m[0]?.trim() ?? '',
    });
  }
  return frames;
}

function extractFirstJavaStackBlock(text: string): string {
  const startIdx = text.search(/\b(?:Exception|Error|Throwable)\b/);
  if (startIdx === -1) return text;
  const after = text.slice(startIdx);
  const frameMatches = [...after.matchAll(/^\s+at\s+/gm)];
  if (frameMatches.length === 0) return after;
  const lastFrame = frameMatches[frameMatches.length - 1]!; // non-empty 保证
  const endIdx = (lastFrame.index ?? 0) + (lastFrame[0]?.length ?? 20) + 40;
  return after.slice(0, endIdx);
}

function splitJavaClassMethod(method: string): [string, string] {
  const idx = method.lastIndexOf('.');
  if (idx === -1) return ['', method];
  return [method.slice(0, idx), method.slice(idx + 1)];
}

function parseJavaLocation(loc: string): { filePath?: string; line?: number } {
  const m = loc.match(/^([\w./-]+\.java):(-?\d+)$/);
  if (m) return { filePath: m[1] ?? loc.split(':')[0], line: parseInt(m[2] ?? '0', 10) };
  const m2 = loc.match(/^([\w./-]+\.java):(-?\d+)\s*:\s*(\d+)$/);
  if (m2) return { filePath: m2[1] ?? loc.split(':')[0], line: parseInt(m2[2] ?? '0', 10) };
  return {};
}

function isJavaFramework(className: string): boolean {
  const prefixes = [
    'java.', 'javax.', 'jdk.', 'com.sun.', 'sun.',
    'org.springframework.', 'org.apache.', 'org.hibernate.',
    'org.slf4j.', 'org.junit.', 'io.spring.',
    'android.', 'kotlin.',
  ];
  return prefixes.some((p) => className.startsWith(p));
}

/* ------------------------------------------------------------------ */
/* Python                                                               */
/* ------------------------------------------------------------------ */

const PYTHON_FRAME_RE = /^\s*File\s+"([^"]+)",\s*line\s+(\d+),\s*in\s+(.+)$/gm;

function parsePython(text: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const m of text.matchAll(PYTHON_FRAME_RE)) {
    const filePath = m[1] ?? '';
    const line = parseInt(m[2] ?? '0', 10);
    const fn = (m[3] ?? '').trim();
    frames.push({
      function: fn === '<module>' ? undefined : fn || undefined,
      classOrModule: extractPythonModule(filePath) || undefined,
      filePath: filePath || undefined,
      line: line || undefined,
      isFramework: isPythonFramework(filePath),
      raw: m[0]?.trim() ?? '',
    });
  }
  return frames;
}

function extractPythonModule(path: string): string | undefined {
  const m = path.match(/\/([\w.-]+)\.py$/);
  return m?.[1];
}

function isPythonFramework(filePath: string): boolean {
  const lower = (filePath ?? '').toLowerCase();
  if (lower.includes('site-packages') || lower.includes('.pyenv') || lower.includes('/usr/lib/')) return true;
  const frameworks = ['django', 'flask', 'fastapi', 'celery', 'sqlalchemy', 'pytest', 'asyncio', 'typing'];
  return frameworks.some((f) => lower.includes(`/${f}.py`) || lower.includes(`/${f}/`));
}

/* ------------------------------------------------------------------ */
/* Node.js                                                             */
/* ------------------------------------------------------------------ */

// 注意：不能带 g 旗标！带 g 时 .match() 不返回捕获组，只能用 matchAll()
const NODEJS_FRAME_WITH_PAREN_RE = /^\s*at\s+(?:([\w$.]+)\s+\()?(.+?):(\d+)(?::(\d+))?\)/m;
const NODEJS_FRAME_NO_PAREN_RE = /^\s*at\s+(\S+?):(\d+)(?::(\d+))?/m;
const NODEJS_NATIVE_RE = /^\s*at\s+(?:([\w$.]+)\s+\()?(node:[^:()]+)(?:[):])/m;

function parseNodeJs(text: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of text.split('\n')) {
    // 先检查 native frame
    const mNative = line.match(NODEJS_NATIVE_RE);
    if (mNative) {
      frames.push({
        function: (mNative[1] ?? '').trim() || undefined,
        classOrModule: mNative[2] || undefined,
        isFramework: true,
        raw: line.trim(),
      });
      continue;
    }

    // 有括号格式：at fn (/path/to/file.js:line:col)
    let m = line.match(NODEJS_FRAME_WITH_PAREN_RE);
    if (m) {
      frames.push({
        function: (m[1] ?? '').trim() || undefined,
        filePath: m[2] || undefined,
        line: m[3] ? parseInt(m[3], 10) : undefined,
        column: m[4] ? parseInt(m[4], 10) : undefined,
        isFramework: isNodeJsFramework(m[2]),
        raw: line.trim(),
      });
      continue;
    }

    // 无括号格式：at /path/to/file.js:line:col
    m = line.match(NODEJS_FRAME_NO_PAREN_RE);
    if (!m) continue;
    frames.push({
      filePath: m[1] || undefined,
      line: m[2] ? parseInt(m[2], 10) : undefined,
      column: m[3] ? parseInt(m[3], 10) : undefined,
      isFramework: isNodeJsFramework(m[1]),
      raw: line.trim(),
    });
  }
  return frames;
}

function isNodeJsFramework(filePath: string | undefined): boolean {
  if (!filePath) return true;
  if (filePath.startsWith('node:')) return true;
  if (filePath.includes('/node_modules/')) return true;
  // /app/xxx.js、/src/xxx.js、/home/user/project/xxx.js → 用户代码
  return false;
}
