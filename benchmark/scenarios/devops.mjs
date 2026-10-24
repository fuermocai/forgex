/**
 * DevOps 套件：20 个确定性场景。
 *
 * 覆盖：inspect_memory / inspect_disk / inspect_process / inspect_port /
 * read_logs / run_command / correlate_code_runtime。
 * 全部只读或受控执行，无模型调用、无外部网络依赖。
 */

import { createServer } from 'node:net';

/** 申请一个当前空闲的 TCP 端口（立即释放，用于"未监听"断言） */
function freeTcpPort() {
  return new Promise((resolveP, rejectP) => {
    const server = createServer();
    server.once('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolveP(port));
    });
  });
}

/** 持有一个监听中的 TCP 服务（用于"已监听"断言），返回 {port, close} */
function holdTcpPort() {
  return new Promise((resolveP, rejectP) => {
    const server = createServer();
    server.once('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveP({
        port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

export const suite = {
  name: 'devops',
  scenarios: [
    {
      id: 'DEV-01',
      name: 'inspect_memory 返回内存总量与使用率',
      async run(env) {
        const tool = env.tools.createInspectMemoryTool();
        const data = env.toolData(await tool.execute({}, env.ctx), 'inspect_memory');
        env.expect(data.totalBytes > 0, '内存总量应大于 0');
      },
    },
    {
      id: 'DEV-02',
      name: 'inspect_disk 返回至少一个磁盘',
      async run(env) {
        const tool = env.tools.createInspectDiskTool();
        const data = env.toolData(await tool.execute({}, env.ctx), 'inspect_disk');
        env.expect(Array.isArray(data.disks) && data.disks.length >= 1, '应返回至少一个磁盘');
      },
    },
    {
      id: 'DEV-03',
      name: 'inspect_process 按 PID 精确找到当前进程',
      async run(env) {
        const tool = env.tools.createInspectProcessTool();
        const data = env.toolData(
          await tool.execute({ pid: process.pid, limit: 20, sortBy: 'memory' }, env.ctx),
          'inspect_process 按 PID',
        );
        env.expect(data.processes.some((p) => p.pid === process.pid), '应找到当前 node 进程');
      },
    },
    {
      id: 'DEV-04',
      name: 'inspect_process 按名称过滤命中 node',
      async run(env) {
        const tool = env.tools.createInspectProcessTool();
        const data = env.toolData(
          await tool.execute({ name: 'node', limit: 50, sortBy: 'memory' }, env.ctx),
          'inspect_process 按名称',
        );
        env.expect(data.matched >= 1, '应至少匹配一个 node 进程');
      },
    },
    {
      id: 'DEV-05',
      name: 'inspect_port 空闲端口返回 found=false',
      async run(env) {
        const port = await freeTcpPort();
        const tool = env.tools.createInspectPortTool();
        const data = env.toolData(
          await tool.execute({ port, protocol: 'tcp', listeningOnly: true, limit: 50 }, env.ctx),
          'inspect_port 空闲',
        );
        env.expectEq(data.found, false, '刚释放的端口不应在监听');
      },
    },
    {
      id: 'DEV-06',
      name: 'inspect_port 监听中端口的诊断闭环',
      async run(env) {
        const held = await holdTcpPort();
        try {
          const tool = env.tools.createInspectPortTool();
          const data = env.toolData(
            await tool.execute({ port: held.port, protocol: 'tcp', listeningOnly: true, limit: 50 }, env.ctx),
            'inspect_port 监听',
          );
          env.expect(data.found, '应发现监听端口');
          env.expect(data.listening, '应处于 LISTENING');
        } finally {
          await held.close();
        }
      },
    },
    {
      id: 'DEV-07',
      name: 'read_logs 读取日志末尾 N 行',
      async run(env) {
        const lines = Array.from({ length: 30 }, (_, i) => `log line ${i + 1}`);
        lines.push('FATAL_ERROR_MARKER');
        await env.write('app.log', `${lines.join('\n')}\n`);
        const tool = env.tools.createReadLogsTool();
        const data = env.toolData(await tool.execute({ path: 'app.log', lines: 5 }, env.ctx), 'read_logs');
        env.expectEq(data.lines, 5, '应只读最后 5 行');
        env.expect(data.content.includes('FATAL_ERROR_MARKER'), '末尾标记应被读到');
        env.expect(!data.content.includes('log line 1\n'), '不应包含开头行');
      },
    },
    {
      id: 'DEV-08',
      name: 'read_logs 读取不存在的日志返回失败',
      async run(env) {
        const tool = env.tools.createReadLogsTool();
        const outcome = await tool.execute({ path: 'missing.log', lines: 100 }, env.ctx);
        env.toolBlocked(outcome, /NOT_FOUND|TOOL_FAILED/, 'read_logs 不存在');
      },
    },
    {
      id: 'DEV-09',
      name: 'run_command 执行 node --version 成功退出',
      async run(env) {
        const tool = env.tools.createRunCommandTool();
        const data = env.toolData(
          await tool.execute({ program: 'node', args: ['--version'], timeoutMs: 10_000 }, env.ctx),
          'run_command node --version',
        );
        env.expectEq(data.exitCode, 0, '退出码');
        env.expect(data.stdout.includes('v'), 'stdout 应含版本号');
      },
    },
    {
      id: 'DEV-10',
      name: 'run_command 非零退出码正确上报',
      async run(env) {
        // 让 node 加载一个不存在的模块文件——非零退出且无需内联代码（-e 会被结构防线拦截）
        const tool = env.tools.createRunCommandTool();
        const data = env.toolData(
          await tool.execute({ program: 'node', args: ['definitely-not-exists.js'], timeoutMs: 10_000 }, env.ctx),
          'run_command 非零退出',
        );
        env.expect(data.exitCode !== 0, '退出码应非 0');
      },
    },
    {
      id: 'DEV-11',
      name: 'run_command 捕获脚本 stdout',
      async run(env) {
        await env.write('hello.js', 'process.stdout.write("STDOUT_CAPTURE_MARKER\\n");\n');
        const tool = env.tools.createRunCommandTool();
        const data = env.toolData(
          await tool.execute({ program: 'node', args: ['hello.js'], timeoutMs: 10_000 }, env.ctx),
          'run_command stdout',
        );
        env.expectEq(data.exitCode, 0, '退出码');
        env.expect(data.stdout.includes('STDOUT_CAPTURE_MARKER'), 'stdout 应含标记');
      },
    },
    {
      id: 'DEV-12',
      name: 'run_command 超时后终止进程树并报告 TOOL_TIMEOUT',
      async run(env) {
        await env.write('spin.js', 'setInterval(() => {}, 1000);\n');
        const tool = env.tools.createRunCommandTool();
        const outcome = await tool.execute({ program: 'node', args: ['spin.js'], timeoutMs: 1000 }, env.ctx);
        env.toolBlocked(outcome, /^TOOL_TIMEOUT$/, 'run_command 超时');
      },
    },
    {
      id: 'DEV-13',
      name: 'run_command 不向子进程泄漏白名单外环境变量',
      async run(env) {
        process.env.BENCH_SECRET_MARKER = 'super-secret-value';
        try {
          await env.write(
            'env-check.js',
            'process.stdout.write(String(typeof process.env.BENCH_SECRET_MARKER));\n',
          );
          const tool = env.tools.createRunCommandTool();
          const data = env.toolData(
            await tool.execute({ program: 'node', args: ['env-check.js'], timeoutMs: 10_000 }, env.ctx),
            'run_command env 白名单',
          );
          env.expectEq(data.stdout.trim(), 'undefined', '白名单外环境变量不应注入子进程');
        } finally {
          delete process.env.BENCH_SECRET_MARKER;
        }
      },
    },
    {
      id: 'DEV-14',
      name: 'correlate_code_runtime 解析 Node.js 堆栈',
      async run(env) {
        // 使用正斜杠 *nix 风格路径（与模块测试用例一致的成熟解析格式）
        const logText = [
          'TypeError: Cannot read properties of undefined (reading \'id\')',
          '    at processOrder (/app/src/order.js:42:11)',
          '    at /app/src/main.js:10:3',
        ].join('\n');
        const tool = env.tools.createCorrelateCodeRuntimeTool();
        const data = env.toolData(await tool.execute({ logText }, env.ctx), 'correlate nodejs');
        env.expect(data.allEventKinds.length > 0, '应解析出事件');
        env.expect(data.topUserFrames.length > 0, '应提取用户堆栈帧');
      },
    },
    {
      id: 'DEV-15',
      name: 'correlate_code_runtime 解析 Python 堆栈',
      async run(env) {
        const logText = [
          'Traceback (most recent call last):',
          '  File "app.py", line 12, in main',
          '    run()',
          'ValueError: invalid literal for int()',
        ].join('\n');
        const tool = env.tools.createCorrelateCodeRuntimeTool();
        const data = env.toolData(await tool.execute({ logText, hintLanguage: 'python' }, env.ctx), 'correlate python');
        env.expect(data.allEventKinds.length > 0, '应解析出 Python 事件');
      },
    },
    {
      id: 'DEV-16',
      name: 'correlate_code_runtime 缺少输入时明确失败',
      async run(env) {
        const tool = env.tools.createCorrelateCodeRuntimeTool();
        const outcome = await tool.execute({}, env.ctx);
        env.toolBlocked(outcome, /^TOOL_INPUT_MISSING$/, 'correlate 空输入');
      },
    },
    {
      id: 'DEV-17',
      name: 'inspect_port 非法端口被参数校验拦截',
      async run(env) {
        const tool = env.tools.createInspectPortTool();
        const parsed = tool.parameters.safeParse({ port: 0, protocol: 'all', listeningOnly: true, limit: 50 });
        env.expect(!parsed.success, 'port=0 应被 Zod schema 拒绝');
      },
    },
    {
      id: 'DEV-18',
      name: 'inspect_disk 按使用率阈值过滤',
      async run(env) {
        const tool = env.tools.createInspectDiskTool();
        const all = env.toolData(await tool.execute({}, env.ctx), 'inspect_disk 全量');
        const filtered = env.toolData(await tool.execute({ minUsedPercent: 0 }, env.ctx), 'inspect_disk 阈值 0');
        env.expect(filtered.disks.length >= all.disks.length || filtered.disks.length >= 1, '阈值 0 不应过滤掉磁盘');
      },
    },
    {
      id: 'DEV-19',
      name: 'read_logs lines 参数限制生效',
      async run(env) {
        const lines = Array.from({ length: 50 }, (_, i) => `row-${i + 1}`);
        await env.write('big.log', `${lines.join('\n')}\n`);
        const tool = env.tools.createReadLogsTool();
        const data = env.toolData(await tool.execute({ path: 'big.log', lines: 3 }, env.ctx), 'read_logs 限制');
        env.expectEq(data.lines, 3, '应只返回 3 行');
        env.expect(data.content.includes('row-50'), '应包含末尾行');
        env.expect(!data.content.includes('row-46'), '不应包含超出窗口的行');
      },
    },
    {
      id: 'DEV-20',
      name: 'run_command cwd 参数在子目录执行',
      async run(env) {
        await env.write('sub/whereami.js', 'process.stdout.write(process.cwd().replace(/\\\\/g, "/"));\n');
        const tool = env.tools.createRunCommandTool();
        const data = env.toolData(
          await tool.execute({ program: 'node', args: ['whereami.js'], cwd: 'sub', timeoutMs: 10_000 }, env.ctx),
          'run_command cwd',
        );
        env.expectEq(data.exitCode, 0, '退出码');
        env.expect(data.stdout.replace(/\\/g, '/').endsWith('/sub'), '工作目录应切换到 sub');
      },
    },
  ],
};
