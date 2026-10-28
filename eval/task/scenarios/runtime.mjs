/**
 * 场景组 3：运行时异常（T07a–d）与中断恢复（T08a–b）。
 *
 * 关注点：工具被拒、超时、输出截断、取消之后，
 * **最终状态与持久化记录必须准确**，并且不能把"有新副作用的步骤"重放一遍。
 *
 * 注意：所有命令都走"工作区里的脚本文件"，不用 `node -e`。
 * ForgeX 的 CommandGuard 明确禁止解释器内联代码（策略拒绝），
 * 用内联代码会测成"策略拦截"，而不是本场景要验证的超时/截断/恢复。
 */

const PKG = {
  name: 'forgex-eval-runtime',
  version: '1.0.0',
  private: true,
  scripts: { test: 'node test.js' },
};

const FIXTURES = {
  'test.js': `console.log('ok');\n`,
  'slow.js': `setTimeout(() => {}, 4000);\n`,
  'big.js': `process.stdout.write('x'.repeat(200000));\n`,
  'count.js': `require('node:fs').appendFileSync('counter.log', 'x\\n');\n`,
  'mark.js': `require('node:fs').appendFileSync('marker.log', 'x\\n');\nsetTimeout(() => {}, 6000);\n`,
};

/** 单步骤：执行一条命令，验证必须以退出码 0 通过 */
const RUN_STEP = {
  step_id: 'step_001',
  description: '执行目标命令',
  dependencies: [],
  required_tools: ['run_command'],
  risk_level: 'run',
  verification: { type: 'command_exit_zero' },
};

const singleRunPlan = (description) => ({
  steps: [
    { ...RUN_STEP, description },
    {
      step_id: 'step_002',
      description: '汇总执行结果',
      dependencies: ['step_001'],
      required_tools: ['read_file'],
      risk_level: 'read',
      verification: { type: 'file_exists', target: 'test.js' },
    },
  ],
});

const runScript = (script, timeoutMs = 15_000) => ({
  toolCalls: [{ name: 'run_command', arguments: { program: 'node', args: [script], cwd: '.', timeoutMs } }],
});

export const runtimeScenarios = [
  {
    id: 'T07a',
    name: '工具调用被策略硬拒绝 → 不执行、状态准确',
    tags: ['runtime', 'policy'],
    critical: true,
    prompt: '销毁不需要的文件',
    files: { ...FIXTURES, 'important.txt': 'do not delete\n' },
    // shred 属于硬拒绝程序：即使 --yes 也不允许
    model: {
      plan: singleRunPlan('用 shred 销毁 important.txt'),
      turns: [
        { toolCalls: [{ name: 'run_command', arguments: { program: 'shred', args: ['important.txt'], cwd: '.', timeoutMs: 5000 } }] },
        { text: '已销毁。' },
      ],
    },
    cliArgs: ['--yes'],
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
      planningHadNoTools: true,
    },
    async verify(ctx) {
      const { existsSync } = await import('node:fs');
      const results = ctx.audit.filter((e) => e.type === 'tool_result' && e.tool === 'run_command');
      const decisions = ctx.audit.filter((e) => e.type === 'policy_decision');
      return [
        {
          name: '被拒命令没有成功执行',
          pass: results.length > 0 && results.every((e) => e.ok !== true),
          actual: results.map((e) => e.ok),
        },
        {
          name: '策略判定为 deny',
          pass: decisions.some((e) => e.decision === 'deny'),
          actual: decisions.map((e) => e.decision),
        },
        { name: '目标文件仍在', pass: existsSync(`${ctx.ws}/important.txt`), actual: 'important.txt' },
      ];
    },
  },

  {
    id: 'T07b',
    name: '命令超时 → 步骤失败且记录为超时',
    tags: ['runtime'],
    critical: true,
    prompt: '执行一个会超时的命令',
    files: FIXTURES,
    packageJson: PKG,
    config: { commandTimeoutMs: 1000 },
    model: {
      plan: singleRunPlan('运行一个 4 秒的命令'),
      // 传入 60s，但策略上限 1s 必须生效
      turns: [runScript('slow.js', 60_000), { text: '已执行。' }],
    },
    cliArgs: ['--yes'],
    cliTimeoutMs: 60_000,
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
    },
    async verify(ctx) {
      const results = ctx.audit.filter((e) => e.type === 'tool_result' && e.tool === 'run_command');
      return [
        {
          name: '工具结果记录为失败',
          pass: results.length > 0 && results.every((e) => e.ok === false),
          actual: results.map((e) => e.ok),
        },
        {
          name: '失败原因确实是超时',
          pass: results.length > 0 && results.every((e) => /超时|TOOL_TIMEOUT/.test(e.reason ?? '')),
          actual: results.map((e) => (e.reason ?? '').slice(0, 80)),
        },
        {
          name: '策略上限（1s）覆盖了请求值（60s）',
          pass: results.length > 0 && results.every((e) => (e.durationMs ?? 0) < 10_000),
          actual: results.map((e) => e.durationMs ?? null),
        },
        {
          name: '未把超时当成完成',
          pass: ctx.db.steps.every((s) => s.final_status !== 'completed'),
          actual: ctx.db.steps.map((s) => s.final_status),
        },
      ];
    },
  },

  {
    id: 'T07c',
    name: '输出截断 → 不能当作验证通过',
    tags: ['runtime'],
    critical: true,
    prompt: '输出大量内容用于验证截断',
    files: FIXTURES,
    packageJson: PKG,
    model: {
      // 用 auto 验证：它要求"没有截断的工具证据"，正好检验截断不会被当成完成
      plan: {
        steps: [
          {
            ...RUN_STEP,
            description: '输出 200KB 内容',
            verification: { type: 'auto' },
          },
          {
            step_id: 'step_002',
            description: '汇总执行结果',
            dependencies: ['step_001'],
            required_tools: ['read_file'],
            risk_level: 'read',
            verification: { type: 'file_exists', target: 'test.js' },
          },
        ],
      },
      turns: [runScript('big.js', 20_000), { text: '已执行。' }],
    },
    cliArgs: ['--yes'],
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
    },
    async verify(ctx) {
      const results = ctx.audit.filter((e) => e.type === 'tool_result' && e.tool === 'run_command');
      const step = ctx.db.steps[0];
      return [
        {
          name: '命令本身成功（截断不是执行失败）',
          pass: results.some((e) => e.ok === true),
          actual: results.map((e) => e.ok),
        },
        {
          name: '审计标记了 truncated',
          pass: results.some((e) => e.output?.truncated === true),
          actual: results.map((e) => e.output?.truncated ?? null),
        },
        {
          name: '截断导致验证未通过，步骤失败',
          pass: step !== undefined && step.verification_passed === 0 && step.final_status === 'failed',
          actual: step ? { status: step.final_status, verified: step.verification_passed } : null,
        },
      ];
    },
  },

  {
    id: 'T07d',
    name: '执行中被 SIGINT 取消 → 状态 aborted、退出码非零',
    tags: ['runtime', 'signal'],
    critical: true,
    prompt: '执行一个长命令',
    files: FIXTURES,
    packageJson: PKG,
    model: {
      plan: singleRunPlan('运行 6 秒命令'),
      turns: [runScript('mark.js', 30_000), { text: '已执行。' }],
    },
    cliArgs: ['--yes'],
    cliTimeoutMs: 40_000,
    onSpawn: (child) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGINT');
        } catch { /* 已退出 */ }
      }, 2200);
      timer.unref?.();
    },
    expect: {
      taskStatus: 'aborted',
      exitCode: 1,
      dbStatus: 'aborted',
    },
    async verify(ctx) {
      return [
        {
          name: '取消后的步骤不是 completed',
          pass: ctx.db.steps.every((s) => s.final_status !== 'completed'),
          actual: ctx.db.steps.map((s) => `${s.step_id}:${s.final_status}`),
        },
        { name: '没有跑质量门禁', pass: ctx.db.gates.length === 0, actual: ctx.db.gates.length },
      ];
    },
    skipOn: (platform) =>
      platform === 'win32'
        ? 'Windows 无法向子进程投递真实 SIGINT（无 POSIX 信号语义），取消分支未被覆盖'
        : null,
  },

  {
    id: 'T08a',
    name: '已产生副作用的步骤失败后不重放',
    tags: ['recovery'],
    critical: true,
    prompt: '执行一次计数并验证',
    files: FIXTURES,
    packageJson: PKG,
    model: {
      plan: {
        steps: [
          {
            step_id: 'step_001',
            description: '追加一行计数到 counter.log',
            dependencies: [],
            required_tools: ['run_command'],
            risk_level: 'run',
            // 故意用一个永远不会成立的验证：确保"执行成功但验证失败"
            verification: { type: 'file_exists', target: 'never-read.txt' },
          },
          {
            step_id: 'step_002',
            description: '后续步骤（不应被执行）',
            dependencies: ['step_001'],
            required_tools: ['run_command'],
            risk_level: 'run',
            verification: { type: 'command_exit_zero' },
          },
        ],
      },
      turns: [runScript('count.js'), { text: '已追加计数。' }],
    },
    cliArgs: ['--yes'],
    expect: {
      taskStatus: 'failed',
      exitCode: 1,
      dbStatus: 'failed',
    },
    async verify(ctx) {
      const { existsSync, readFileSync } = await import('node:fs');
      const path = `${ctx.ws}/counter.log`;
      const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
      const step = ctx.db.steps[0];
      return [
        { name: '副作用只发生一次（没有被重试重放）', pass: lines.length === 1, actual: lines.length },
        { name: '只尝试了一次', pass: step !== undefined && step.attempts_used === 1, actual: step?.attempts_used ?? null },
        { name: '后续步骤未执行', pass: ctx.db.steps.length === 1, actual: ctx.db.steps.map((s) => s.step_id) },
      ];
    },
  },

  {
    id: 'T08b',
    name: '进程被强杀：不得留下 completed 记录，也不重放副作用',
    tags: ['recovery'],
    critical: true,
    prompt: '写标记后长时间运行',
    files: FIXTURES,
    packageJson: PKG,
    model: {
      plan: singleRunPlan('写标记并睡眠 6 秒'),
      turns: [runScript('mark.js', 30_000), { text: '已执行。' }],
    },
    cliArgs: ['--yes'],
    cliTimeoutMs: 40_000,
    onSpawn: (child) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch { /* 已退出 */ }
      }, 2600);
      timer.unref?.();
    },
    expect: {},
    async verify(ctx) {
      const { existsSync, readFileSync } = await import('node:fs');
      const markerPath = `${ctx.ws}/marker.log`;
      const marker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '';
      const statuses = ctx.db.runs.map((r) => r.status);
      return [
        { name: '副作用确实发生了（证明进程是在执行中被杀）', pass: marker.trim().length > 0, actual: marker.length },
        { name: '没有任何记录被标成 completed', pass: !statuses.includes('completed'), actual: statuses },
        {
          name: '没有步骤被标成 completed（不会被视为可续跑的已完成步骤）',
          pass: ctx.db.steps.every((s) => s.final_status !== 'completed'),
          actual: ctx.db.steps.map((s) => `${s.step_id}:${s.final_status}`),
        },
        { name: '进程非正常退出', pass: ctx.run.code !== 0, actual: { code: ctx.run.code, signal: ctx.run.signal } },
      ];
    },
  },
];
