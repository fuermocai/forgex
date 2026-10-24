/**
 * 代码 + 运行环境关联分析：类型定义。
 *
 * 核心思路：
 *   Agent 不只看到 HTTP 500 报错——它能从错误日志里提取异常堆栈，
 *   定位到具体代码文件和行号，再结合 Git diff 看最近谁改了什么。
 *
 * 关键原则：
 *   - 日志解析/堆栈解析/Git 关联都是**确定性函数**（正则+字符串匹配），
 *     不调 LLM；模型拿到结构化证据链后做推理是模型职责；
 *   - 所有证据链都带 `confidence` 字段，模型根据置信度判断是否可信；
 *   - "推测"和"事实"严格区分：git 提交时间/文件修改是事实，
 *     "可能是这次提交引入的 Bug"是推测。
 */

export type Language = 'java' | 'python' | 'nodejs' | 'unknown';

export type Severity = 'info' | 'warn' | 'error' | 'fatal';

/** 一段日志中的异常事件（log-aggregator 产出） */
export interface LogEvent {
  /** 事件在日志文件中的起始行（0-based） */
  lineStart: number;
  /** 结束行（exclusive） */
  lineEnd: number;
  /** 严重级别（从关键字推断） */
  severity: Severity;
  /** 事件类型（异常名或关键字） */
  kind: string;
  /** 完整原始文本（堆栈保留缩进） */
  raw: string;
  /** 推断语言 */
  language: Language;
  /** 从堆栈里解析出的帧列表（可能为空） */
  stack: StackFrame[];
  /** 从日志上下文提取的关键信息（请求 ID、时间戳、HTTP 路径等） */
  context: Record<string, string>;
}

/** 堆栈帧（stack-parser 产出） */
export interface StackFrame {
  /** 函数名（Java/Python 有，Node.js 可能为空） */
  function?: string;
  /** 类名或模块路径 */
  classOrModule?: string;
  /** 源文件路径（相对项目根或绝对） */
  filePath?: string;
  /** 行号（1-based） */
  line?: number;
  /** 列号（Node.js 有时有） */
  column?: number;
  /** 是否系统/框架代码（vs 用户代码） */
  isFramework: boolean;
  /** 原始行 */
  raw: string;
}

/** Git 变更（git-correlator 产出） */
export interface GitChange {
  /** 文件相对路径 */
  filePath: string;
  /** 变更行数（+/-） */
  additions: number;
  deletions: number;
  /** 最近一次修改的 commit hash */
  lastCommitHash: string;
  /** 最近一次修改时间（ISO 8601） */
  lastCommitDate: string;
  /** 最近一次提交信息 */
  lastCommitMessage: string;
  /** 作者 */
  author: string;
  /** 变更类型（A/D/M/R） */
  status: 'A' | 'D' | 'M' | 'R' | 'U' | '?';
}

/** 关联分析最终输出（传给模型的证据链） */
export interface CorrelationReport {
  /** 分析的源：日志文件路径 + 时间范围 */
  source: { logFile?: string; since?: string; until?: string };
  /** 从日志解析的异常事件 */
  events: LogEvent[];
  /** 从堆栈定位的用户代码帧（排除框架代码） */
  userFrames: StackFrame[];
  /** 关联到的 Git 变更（按时间窗口过滤） */
  relatedChanges: GitChange[];
  /** 分析置信度（0-1），低置信度说明证据不充分 */
  confidence: number;
  /** 生成报告的时间（ISO 8601） */
  analyzedAt: string;
  /** 错误（空数组表示成功） */
  errors: string[];
}

/** 关联分析输入（工具层传给 correlation 包） */
export interface CorrelateOptions {
  /** 原始日志文本（已经从文件读出来） */
  logText?: string;
  /** 日志文件路径（与 logText 二选一） */
  logPath?: string;
  /** Git 仓库根目录（用于 git log/diff） */
  repoRoot?: string;
  /** 回溯时间窗口（毫秒），默认 3600000（1 小时） */
  gitTimeWindowMs?: number;
  /** 已知 HTTP 路径（可选，帮助过滤堆栈） */
  httpPath?: string;
  /** 语言提示（auto 检测） */
  hintLanguage?: Language;
}

/** log-aggregator 输入（内部类型，correlate.ts 也用） */
export interface LogAggregateInput {
  text: string;
  hintLanguage?: Language;
  options?: { maxEvents?: number; contextLinesAfter?: number };
}
