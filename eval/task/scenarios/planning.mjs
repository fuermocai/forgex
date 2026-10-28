/**
 * 场景组 2：计划生成校验（T05a–e）与"被拒绝就不执行"（T06a–c）。
 *
 * 这一组的共同要求：**计划不合法或用户没同意时，一个工具都不能跑**。
 * 因此断言重点是 `auditEmptyTools` 与 `noSideEffects`，而不是错误文案。
 */

import { existsSync } from 'node:fs';

const VALID_STEP_1 = {
  step_id: 'step_001',
  description: '读取配置',
  dependencies: [],
  required_tools: ['read_file'],
  risk_level: 'read',
  verification: { type: 'file_exists', target: 'app.js' },
};

const VALID_STEP_2 = {
  step_id: 'step_002',
  description: '修改配置',
  dependencies: ['step_001'],
  required_tools: ['edit_file'],
  risk_level: 'modify',
  verification: { type: 'tool_return_ok' },
};

const APP_JS = 'module.exports = { mode: "dev" };\n';

/** 每个非法计划都配上"如果被放过就会真的改文件"的轮次，才能证明没执行 */
const WOULD_MUTATE_TURNS = [
  { toolCalls: [{ name: 'edit_file', arguments: { path: 'app.js', oldText: 'dev', newText: 'prod' } }] },
  { text: '已修改。' },
];

/** 与上面两步计划匹配的轮次：先读（允许），再改（在 standard 模式需要审批） */
const READ_THEN_MUTATE_TURNS = [
  { toolCalls: [{ name: 'read_file', arguments: { path: 'app.js' } }] },
  { text: '已读取 app.js。' },
  ...WOULD_MUTATE_TURNS,
];

const invalidPlanCase = (id, name, model, extraExpect = {}) => ({
  id,
  name,
  tags: ['planning'],
  critical: true,
  prompt: '把 app.js 的 mode 改成 prod',
  files: { 'app.js': APP_JS },
  model: { ...model, turns: WOULD_MUTATE_TURNS },
  cliArgs: ['--yes'],
  expect: {
    taskStatus: 'invalid_plan',
    exitCode: 2,
    dbStatus: 'invalid_plan',
    noSideEffects: true,
    auditEmptyTools: true,
    ...extraExpect,
  },
});

export const planningScenarios = [
  invalidPlanCase('T05a', '计划格式错误（非 JSON）→ 失败关闭', {
    planText: '当然可以，我来帮你改。\n\n第一步：打开文件……',
  }),

  invalidPlanCase('T05b', '空计划（steps 为空）→ 失败关闭', {
    plan: { steps: [] },
  }),

  invalidPlanCase('T05c', '循环依赖 → 失败关闭', {
    plan: {
      steps: [
        { ...VALID_STEP_1, dependencies: ['step_002'] },
        { ...VALID_STEP_2, dependencies: ['step_001'] },
      ],
    },
  }),

  invalidPlanCase('T05d', '悬空依赖 → 失败关闭', {
    plan: {
      steps: [
        VALID_STEP_1,
        { ...VALID_STEP_2, dependencies: ['step_099'] },
      ],
    },
  }),

  invalidPlanCase('T05e', '重复 step_id → 失败关闭', {
    plan: {
      steps: [
        VALID_STEP_1,
        { ...VALID_STEP_2, step_id: 'step_001' },
      ],
    },
  }),

  {
    id: 'T06a',
    name: '计划未确认（--plan 只展示）→ 不执行任何工具',
    tags: ['approval'],
    critical: true,
    prompt: '把 app.js 的 mode 改成 prod',
    files: { 'app.js': APP_JS },
    model: {
      plan: { steps: [VALID_STEP_1, VALID_STEP_2] },
      turns: READ_THEN_MUTATE_TURNS,
    },
    cliArgs: ['--plan'],
    expect: {
      taskStatus: 'planned',
      exitCode: 0,
      noSideEffects: true,
      auditEmptyTools: true,
      planningHadNoTools: true,
    },
    async verify(ctx) {
      return [
        { name: '没有创建执行记录', pass: ctx.db.runs.length === 0, actual: ctx.db.runs.length },
        { name: '没有写入任何步骤结果', pass: ctx.db.steps.length === 0, actual: ctx.db.steps.length },
      ];
    },
  },

  {
    id: 'T06b',
    name: '工具审批被拒（非交互自动拒绝）→ 不产生副作用',
    tags: ['approval'],
    critical: true,
    prompt: '把 app.js 的 mode 改成 prod',
    files: { 'app.js': APP_JS },
    config: {
      mode: 'standard',
      requireApprovalForWrite: true,
      requireApprovalForExecute: true,
    },
    // 注意：不传 --yes，且 --json 使 CLI 走非交互分支 → 审批一律拒绝
    model: {
      plan: { steps: [VALID_STEP_1, VALID_STEP_2] },
      turns: READ_THEN_MUTATE_TURNS,
    },
    cliArgs: [],
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
      noSideEffects: true,
      gateVerdict: null,
    },
    async verify(ctx) {
      const approvals = ctx.audit.filter((e) => e.type === 'approval');
      const denied = approvals.filter((e) => e.decision === 'denied');
      return [
        {
          name: '审计记录了被拒绝的审批',
          pass: denied.length > 0,
          actual: approvals.map((e) => `${e.tool}:${e.decision}`),
        },
        {
          name: '被拒绝的工具没有产生 tool_result(ok)',
          pass: !ctx.audit.some((e) => e.type === 'tool_result' && e.tool === 'edit_file' && e.ok === true),
          actual: ctx.audit.filter((e) => e.type === 'tool_result').map((e) => `${e.tool}:${e.ok}`),
        },
      ];
    },
  },

  {
    id: 'T06c',
    name: 'TTY 下用户拒绝计划 → 不执行、不落执行记录',
    tags: ['approval', 'pty'],
    critical: true,
    prompt: '把 app.js 的 mode 改成 prod',
    files: { 'app.js': APP_JS },
    model: {
      plan: { steps: [VALID_STEP_1, VALID_STEP_2] },
      turns: READ_THEN_MUTATE_TURNS,
    },
    // 不能带 --json：--json 会强制非交互，走不到"确认计划"这一步
    cliArgs: [],
    pty: true,
    stdinData: 'n\n',
    stdinDelayMs: 2500,
    expect: {
      exitCode: 1,
      noSideEffects: true,
      auditEmptyTools: true,
    },
    async verify(ctx) {
      return [
        { name: '没有创建执行记录', pass: ctx.db.runs.length === 0, actual: ctx.db.runs.length },
        {
          name: '未执行任何工具',
          pass: ctx.audit.length === 0,
          actual: ctx.audit.length,
        },
      ];
    },
    // pty 由 util-linux 的 `script` 提供：Windows/macOS 无等价物，Linux 上也可能没装
    skipOn: (platform) => {
      if (platform !== 'linux') {
        return '需要 util-linux 的 `script` 提供 pty（当前平台无等价实现），该分支未被覆盖';
      }
      const hasScript = ['/usr/bin/script', '/bin/script'].some((p) => existsSync(p));
      return hasScript ? null : 'Linux 上未安装 util-linux 的 `script`，无法提供 pty，该分支未被覆盖';
    },
  },
];
