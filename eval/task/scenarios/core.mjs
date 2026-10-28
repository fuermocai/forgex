/**
 * 场景组 1：任务闭环主干（T01–T04）。
 *
 * 每个场景声明：输入（fixture + 计划 + 模型轮次）、预期状态、预期退出码、
 * 允许/禁止的工具调用、禁止的副作用。断言只落在外部证据上。
 */

const MATH_BUGGY = `function add(a, b) {
  return a - b;
}

module.exports = { add };
`;

const MATH_FIXED = `function add(a, b) {
  return a + b;
}

module.exports = { add };
`;

const TEST_ADD = `const assert = require('node:assert');
const { add } = require('./src/math.js');
assert.strictEqual(add(2, 3), 5);
console.log('tests passed');
`;

/** 两步骤：先读目标文件，再修改；第 2 步依赖第 1 步 */
const READ_THEN_EDIT_PLAN = {
  steps: [
    {
      step_id: 'step_001',
      description: '读取 src/math.js，确认 add 的实现',
      dependencies: [],
      required_tools: ['read_file'],
      risk_level: 'read',
      verification: { type: 'file_exists', target: 'src/math.js' },
    },
    {
      step_id: 'step_002',
      description: '修复 add 的运算错误',
      dependencies: ['step_001'],
      required_tools: ['edit_file'],
      risk_level: 'modify',
      verification: { type: 'tool_return_ok' },
    },
  ],
};

const READ_THEN_EDIT_TURNS = (oldText, newText) => [
  { toolCalls: [{ name: 'read_file', arguments: { path: 'src/math.js' } }] },
  { text: '已读取 src/math.js。' },
  { toolCalls: [{ name: 'edit_file', arguments: { path: 'src/math.js', oldText, newText } }] },
  { text: '已修改 add 的实现。' },
];

export const coreScenarios = [
  {
    id: 'T01',
    name: '单文件代码修改：计划 → 执行 → 改文件 → 验收通过',
    tags: ['core', 'gate'],
    critical: true,
    prompt: '修复 src/math.js 里 add 的实现，让测试通过',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    model: {
      plan: READ_THEN_EDIT_PLAN,
      turns: READ_THEN_EDIT_TURNS('return a - b;', 'return a + b;'),
    },
    cliArgs: ['--yes'],
    expect: {
      taskStatus: 'completed',
      exitCode: 0,
      dbStatus: 'completed',
      gateVerdict: 'passed',
      planningHadNoTools: true,
      files: { 'src/math.js': MATH_FIXED },
      toolsExecuted: ['read_file', 'edit_file'],
      toolsForbidden: ['delete_file', 'write_file'],
    },
    /** 额外证明：失败路径没有被走（没有重试、没有多余步骤） */
    async verify(ctx) {
      const steps = ctx.db.steps;
      return [
        {
          name: '每个步骤只尝试一次',
          pass: steps.length === 2 && steps.every((s) => s.attempts_used === 1),
          actual: steps.map((s) => `${s.step_id}:${s.final_status}:${s.attempts_used}`),
        },
        {
          name: '步骤全部完成并写入验证结论',
          pass: steps.every((s) => s.final_status === 'completed' && s.verification_passed === 1),
          actual: steps.map((s) => `${s.step_id}:${s.final_status}:${s.verification_passed}`),
        },
      ];
    },
  },

  {
    id: 'T02',
    name: '多步骤任务：依赖顺序正确，全部完成',
    tags: ['core', 'gate'],
    critical: true,
    prompt: '修复 add 并跑测试确认',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    model: {
      plan: {
        steps: [
          ...READ_THEN_EDIT_PLAN.steps,
          {
            step_id: 'step_003',
            description: '运行测试脚本确认修复生效',
            dependencies: ['step_002'],
            required_tools: ['run_command'],
            risk_level: 'run',
            verification: { type: 'command_exit_zero' },
          },
        ],
      },
      turns: [
        ...READ_THEN_EDIT_TURNS('return a - b;', 'return a + b;'),
        { toolCalls: [{ name: 'run_command', arguments: { program: 'node', args: ['test.js'], cwd: '.', timeoutMs: 15000 } }] },
        { text: '测试已通过。' },
      ],
    },
    cliArgs: ['--yes'],
    expect: {
      taskStatus: 'completed',
      exitCode: 0,
      dbStatus: 'completed',
      planningHadNoTools: true,
      files: { 'src/math.js': MATH_FIXED },
      toolsExecuted: ['read_file', 'edit_file', 'run_command'],
    },
    /** 依赖顺序：审计里工具首次出现的先后必须与依赖链一致 */
    async verify(ctx) {
      const order = [
        ...new Set(
          ctx.audit
            .filter((e) => e.type === 'tool_result' && e.ok === true)
            .map((e) => e.tool),
        ),
      ];
      const expected = ['read_file', 'edit_file', 'run_command'];
      return [
        {
          name: '工具执行顺序符合依赖链',
          pass: JSON.stringify(order) === JSON.stringify(expected),
          expected,
          actual: order,
        },
        {
          name: '步骤记录顺序与依赖一致',
          pass: ctx.db.steps.map((s) => s.step_id).join(',') === 'step_001,step_002,step_003',
          actual: ctx.db.steps.map((s) => s.step_id),
        },
      ];
    },
  },

  {
    id: 'T02b',
    name: '多步骤任务：前置步骤失败后不执行后续步骤',
    tags: ['core', 'gate'],
    critical: true,
    prompt: '读取一个不存在的文件，然后据此修改代码',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    model: {
      plan: READ_THEN_EDIT_PLAN,
      turns: [
        { toolCalls: [{ name: 'read_file', arguments: { path: 'src/does-not-exist.js' } }] },
        { text: '无法读取该文件。' },
        // 后续步骤的脚本故意保留：如果调度器错误地继续执行，就会真的改文件
        { toolCalls: [{ name: 'edit_file', arguments: { path: 'src/math.js', oldText: 'return a - b;', newText: 'return a + b;' } }] },
        { text: '已修改。' },
      ],
    },
    cliArgs: ['--yes'],
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
      noSideEffects: true,
      planningHadNoTools: true,
      files: { 'src/math.js': MATH_BUGGY },
      toolsForbidden: ['edit_file'],
    },
    async verify(ctx) {
      return [
        {
          name: '只记录失败的第一个步骤',
          pass: ctx.db.steps.length === 1 && ctx.db.steps[0]?.step_id === 'step_001' && ctx.db.steps[0]?.final_status === 'failed',
          actual: ctx.db.steps.map((s) => `${s.step_id}:${s.final_status}`),
        },
        {
          name: '未运行质量门禁',
          pass: ctx.db.gates.length === 0,
          actual: ctx.db.gates.length,
        },
      ];
    },
  },

  {
    id: 'T03',
    name: '测试失败：不得报告 completed，退出码非零',
    tags: ['core', 'gate'],
    critical: true,
    prompt: '让测试通过',
    files: { 'src/math.js': MATH_BUGGY, 'test.js': TEST_ADD },
    model: {
      // 模型"声称"修好了，但实际改动不改变行为（只加注释）
      plan: READ_THEN_EDIT_PLAN,
      turns: READ_THEN_EDIT_TURNS('function add(a, b) {', 'function add(a, b) {\n  // fixed'),
    },
    cliArgs: ['--yes'],
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
      gateVerdict: 'failed',
      planningHadNoTools: true,
    },
    async verify(ctx) {
      const gate = ctx.db.gates[0];
      const stages = gate ? JSON.parse(gate.details_json) : [];
      const testStage = stages.find((s) => s.name === 'tests');
      return [
        {
          name: '质量门禁 tests 阶段真实失败',
          pass: testStage !== undefined && testStage.passed === false && testStage.exit_code === 1,
          actual: testStage ? { passed: testStage.passed, exit_code: testStage.exit_code, command: testStage.command } : null,
        },
        {
          name: 'stdout 未出现 completed 结论',
          pass: ctx.json?.taskStatus !== 'completed',
          actual: ctx.json?.taskStatus ?? null,
        },
      ];
    },
  },

  {
    id: 'T04',
    name: '项目没有可运行门禁：状态必须是 unverified',
    tags: ['core', 'gate'],
    critical: true,
    prompt: '给项目加一个问候文件',
    // 没有 package.json → 无 test/typecheck/build 脚本
    packageJson: null,
    files: {
      'greeting.js': 'module.exports = { hello: () => "hi" };\n',
    },
    model: {
      plan: {
        steps: [
          {
            step_id: 'step_001',
            description: '读取现有 greeting.js',
            dependencies: [],
            required_tools: ['read_file'],
            risk_level: 'read',
            verification: { type: 'file_exists', target: 'greeting.js' },
          },
          {
            step_id: 'step_002',
            description: '把 greeting.js 的问候语改成中文',
            dependencies: ['step_001'],
            required_tools: ['edit_file'],
            risk_level: 'modify',
            verification: { type: 'tool_return_ok' },
          },
        ],
      },
      turns: [
        { toolCalls: [{ name: 'read_file', arguments: { path: 'greeting.js' } }] },
        { text: '已读取。' },
        {
          toolCalls: [{
            name: 'edit_file',
            arguments: { path: 'greeting.js', oldText: '() => "hi"', newText: '() => "你好"' },
          }],
        },
        { text: '已修改。' },
      ],
    },
    cliArgs: ['--yes'],
    expect: {
      taskStatus: 'unverified',
      exitCode: 1,
      dbStatus: 'unverified',
      gateVerdict: 'unverified',
      planningHadNoTools: true,
      files: { 'greeting.js': /你好/ },
    },
    async verify(ctx) {
      const gate = ctx.db.gates[0];
      const stages = gate ? JSON.parse(gate.details_json) : [];
      return [
        {
          name: '所有门禁阶段都被标记为跳过（带 note）',
          pass: stages.length === 3 && stages.every((s) => typeof s.note === 'string'),
          actual: stages.map((s) => `${s.name}:${s.note ?? '(ran)'}`),
        },
        {
          name: '未把"没有门禁"当成通过',
          pass: ctx.db.gates[0]?.passed === 0,
          actual: ctx.db.gates[0]?.passed ?? null,
        },
      ];
    },
  },
];
