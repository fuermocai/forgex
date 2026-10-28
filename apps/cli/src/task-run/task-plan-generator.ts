/**
 * TaskPlanGenerator：让模型输出结构化计划（TaskStep[]），经过严格解析+校验后喂给 PlanManager。
 *
 * 关键安全设计（v0.5.0 加固）：
 *   ✅ [P1 强制无工具] 使用 ModelProvider.chat() **完全绕过 AgentLoop**：
 *      - ChatRequest **不传 tools 字段**——模型连工具定义都看不到，不可能发起 tool_calls；
 *      - 不走 Agent.run() 也不经过 ToolDispatcher，完全隔离；
 *      - 也不写入 Agent 的会话历史——计划生成是一次性请求，不污染用户任务会话。
 *   ✅ [P1 不伪装审计] 不写 audit log——计划生成是内部行为，不应伪装成用户工具调用。
 *   ✅ risk_level 自动覆盖（不信任模型）；verification.type 严格枚举；
 *   ✅ 空计划 / 循环依赖 / 悬空依赖 / 重复 ID → 失败关闭。
 */
import type { ModelProvider } from '@forgex/models';
import { ForgeError } from '@forgex/shared';
import { PlanManager } from '@forgex/core';
import { createStep, type RiskLevel, type TaskPlan, type TaskStep } from '@forgex/core';

const PLAN_PROMPT = `你是任务拆解器。根据下方用户请求，输出一个 JSON 对象，结构固定如下：

{
  "steps": [
    {
      "step_id": "step_001",
      "description": "<给执行者的详细指令，要具体>",
      "dependencies": [],
      "required_tools": ["read_file", "list_directory"],
      "risk_level": "read",
      "verification": { "type": "tool_return_ok" }
    }
  ]
}

严格约束：
- 只输出 JSON，不要任何解释文字或 Markdown 代码块标记。
- step_id 必须唯一，用 step_ + 3位数字格式。
- risk_level 只能是 read | modify | run | deploy | critical 之一。
- verification.type 只能是 tool_return_ok | file_exists | file_changed | file_content | command_exit_zero | git_no_conflict | custom | auto。
- 验收本步骤创建或修改文件时必须用 file_changed；新建文件用 write_file，修改已有文件用 edit_file；file_exists 仅用于只要求文件已存在的步骤。
- 需要验证文件内容时使用 file_content，并提供 target 与 expected_content（目标文件的完整预期内容）。
- 每个 step 的 dependencies 必须引用前面已声明的 step_id，不能悬空。
- 至少 2 个步骤。`;

const ALLOWED_RISK: ReadonlySet<string> = new Set(['read', 'modify', 'run', 'deploy', 'critical']);
const ALLOWED_VERIFY: ReadonlySet<string> = new Set([
  'tool_return_ok', 'file_exists', 'file_changed', 'file_content', 'command_exit_zero', 'git_no_conflict', 'custom', 'auto',
]);
const ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'list_directory', 'grep_search', 'edit_file', 'write_file', 'delete_file',
  'git_status', 'git_diff', 'run_command', 'inspect_process', 'inspect_port', 'inspect_disk',
  'inspect_memory', 'read_logs', 'hybrid_search', 'correlate_code_runtime',
]);

export class TaskPlanGeneratorError extends ForgeError {}

export interface GeneratePlanOptions {
  minSteps?: number;
  signal?: AbortSignal;
}

export interface GeneratePlanResult {
  plan: TaskPlan;
  /** LLM 原始文本（用于调试 / 错误回显） */
  rawText: string;
  /** 风险等级自动调整统计 */
  adjustments: Array<{ step_id: string; field: 'risk_level'; from: RiskLevel; to: RiskLevel }>;
  /** 本轮请求确实是无工具的直连 */
  toolIsolation: true;
  modelCallCount: number;
  tokenUsage: number;
}

export class TaskPlanGenerator {
  private readonly provider: ModelProvider;
  private readonly planManager: PlanManager;

  constructor(provider: ModelProvider, planManager: PlanManager) {
    this.provider = provider;
    this.planManager = planManager;
  }

  async generate(userPrompt: string, options: GeneratePlanOptions = {}): Promise<GeneratePlanResult> {
    const minSteps = options.minSteps ?? 2;

    // [1] 直连模型生成计划 —— 完全绕开 AgentLoop 和 ToolDispatcher
    //     关键：**不传 tools 字段**，模型没有任何工具定义，不可能发起 tool_calls
    const systemPrompt = '你是纯 JSON 输出器。只输出符合用户指定结构的 JSON，绝对不要输出任何解释、注释、代码块标记或自然语言。';
    const response = await this.provider.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${PLAN_PROMPT}\n\n用户请求:\n${userPrompt}` },
      ],
      // 不传 tools → 模型看不到任何工具定义 → 强制纯文本/JSON 输出
      temperature: 0,
      maxOutputTokens: 4096,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    // 防御性检查：理论上不传 tools 就不会有 tool_calls，但如果模型厂商做了奇怪实现，
    // 这行能提前发现并报错，不让计划生成阶段偷偷执行任何操作
    const anyToolCall = response.message.tool_calls && response.message.tool_calls.length > 0;
    if (anyToolCall) {
      throw new TaskPlanGeneratorError(
        'PLANNING_VALIDATION_FAILED',
        '计划生成阶段检测到工具调用，但本阶段禁止任何工具执行；请检查模型配置',
      );
    }

    const text = response.message.content ?? '';

    // [2] 解析 JSON —— 先找第一个 { ... } 块（LLM 可能夹带解释）
    const parsed = extractAndParse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TaskPlanGeneratorError('PLANNING_PARSE_FAILED', '模型输出不是合法 JSON', {
        details: { hint: `原始输出前 300 字符: ${text.slice(0, 300)}` },
      });
    }

    // [3] 提取 steps 数组
    const stepsRaw = (parsed as Record<string, unknown>).steps;
    if (!Array.isArray(stepsRaw)) {
      throw new TaskPlanGeneratorError('PLANNING_PARSE_FAILED', 'JSON 缺少 steps 数组');
    }
    if (stepsRaw.length < minSteps) {
      throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `计划步骤太少：${stepsRaw.length} < ${minSteps}`);
    }

    // [4] 校验每个 step 字段合法性
    const adjustments: GeneratePlanResult['adjustments'] = [];
    const seenIds = new Set<string>();
    const steps: TaskStep[] = [];

    for (let i = 0; i < stepsRaw.length; i++) {
      const raw = stepsRaw[i] as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TaskPlanGeneratorError('PLANNING_PARSE_FAILED', `步骤 ${i} 不是合法对象`);
      }

      let stepId = typeof raw.step_id === 'string' && raw.step_id.length > 0 ? raw.step_id : undefined;
      if (!stepId) {
        stepId = `step_${String(i + 1).padStart(3, '0')}`;
      }
      if (seenIds.has(stepId)) {
        throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `重复 step_id: ${stepId}`);
      }
      seenIds.add(stepId);

      const description = typeof raw.description === 'string' ? raw.description.trim() : '';
      if (!description) {
        throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `步骤 ${stepId} 缺少 description`);
      }

      const dependencies = normalizeStringArray(raw.dependencies);
      const requiredTools = normalizeStringArray(raw.required_tools);

      // risk_level: LLM 给的如果不合法就丢弃，然后按工具名推断
      const llmRisk = typeof raw.risk_level === 'string' && ALLOWED_RISK.has(raw.risk_level)
        ? (raw.risk_level as RiskLevel)
        : undefined;
      const inferredRisk = inferRisk(requiredTools);
      const finalRisk: RiskLevel = inferredRisk;
      if (llmRisk && llmRisk !== finalRisk) {
        adjustments.push({ step_id: stepId, field: 'risk_level', from: llmRisk, to: finalRisk });
      }

      // verification
      const verificationObj = raw.verification as Record<string, unknown> | null;
      let verification: TaskStep['verification'];
      if (!verificationObj || typeof verificationObj !== 'object' || Array.isArray(verificationObj)) {
        verification = { type: 'auto' };
      } else {
        const vtype = typeof verificationObj.type === 'string' ? verificationObj.type : 'auto';
        if (!ALLOWED_VERIFY.has(vtype)) {
          throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `步骤 ${stepId} verification.type 非法: ${vtype}`);
        }
        verification = {
          type: vtype as TaskStep['verification']['type'],
          target: typeof verificationObj.target === 'string' ? verificationObj.target : undefined,
          expectedContent: typeof verificationObj.expected_content === 'string' ? verificationObj.expected_content : undefined,
        };
      }
      if (verification.type === 'file_exists' && !verification.target) {
        throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `步骤 ${stepId} file_exists 验证缺少 target`);
      }
      if (verification.type === 'file_changed' && !verification.target) {
        throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `步骤 ${stepId} file_changed 验证缺少 target`);
      }
      if (verification.type === 'file_changed' && !requiredTools.some((tool) => tool === 'edit_file' || tool === 'write_file')) {
        throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `步骤 ${stepId} 使用 file_changed 时 required_tools 必须包含 edit_file 或 write_file`);
      }
      if (verification.type === 'file_content' && !verification.target) {
        throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `步骤 ${stepId} file_content 验证缺少 target`);
      }
      if (verification.type === 'file_content' && verification.expectedContent === undefined) {
        throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `步骤 ${stepId} file_content 验证缺少 expected_content`);
      }
      if (verification.type === 'file_content' && !requiredTools.some((tool) => ['read_file', 'edit_file', 'write_file'].includes(tool))) {
        throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `步骤 ${stepId} 使用 file_content 时 required_tools 必须包含 read_file、edit_file 或 write_file`);
      }

      const step = createStep({
        task_id: stepId,
        description,
        dependencies,
        required_tools: requiredTools.filter((t) => ALLOWED_TOOLS.has(t)),
        risk_level: finalRisk,
        verification,
      });
      step.step_id = stepId;
      steps.push(step);
    }

    // [5] 校验依赖 —— 不能悬空、不能循环
    const idSet = new Set(steps.map((s) => s.step_id));
    for (const s of steps) {
      for (const dep of s.dependencies) {
        if (!idSet.has(dep)) {
          throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', `步骤 ${s.step_id} 依赖不存在: ${dep}`);
        }
      }
    }
    if (hasCycle(steps)) {
      throw new TaskPlanGeneratorError('PLANNING_VALIDATION_FAILED', '计划存在循环依赖');
    }

    // [6] 喂给 PlanManager —— 它会做 DAG + 状态机兜底
    const plan = this.planManager.createPlan({
      user_request: userPrompt,
      steps,
      metadata: { generated_at: new Date().toISOString() },
    });

    return {
      plan,
      rawText: text,
      adjustments,
      toolIsolation: true,
      modelCallCount: 1,
      tokenUsage: response.usage.totalTokens,
    };
  }
}

/* ========================================================================== */
/* 辅助函数                                                                    */
/* ========================================================================== */

function extractAndParse(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* ignore */ }

  const firstBrace = trimmed.indexOf('{');
  if (firstBrace === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = firstBrace; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(trimmed.slice(firstBrace, end));
  } catch {
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter((v) => v.length > 0);
}

/** 按工具名推断风险等级——覆盖 LLM 的自我声明（不信任模型的风险评估） */
function inferRisk(tools: string[]): RiskLevel {
  const set = new Set(tools);
  if (set.has('write_file') || set.has('delete_file')) return 'modify';
  if (set.has('edit_file')) return 'modify';
  if (set.has('run_command')) return 'run';
  return 'read';
}

function hasCycle(steps: TaskStep[]): boolean {
  const white = new Set(steps.map((s) => s.step_id));
  const gray = new Set<string>();
  const black = new Set<string>();
  const byId = new Map(steps.map((s) => [s.step_id, s]));
  function visit(id: string): boolean {
    if (black.has(id)) return false;
    if (gray.has(id)) return true;
    gray.add(id);
    const step = byId.get(id);
    if (!step) return false;
    for (const dep of step.dependencies) {
      if (white.has(dep) && visit(dep)) return true;
    }
    gray.delete(id);
    black.add(id);
    return false;
  }
  for (const s of steps) {
    if (white.has(s.step_id) && visit(s.step_id)) return true;
  }
  return false;
}
