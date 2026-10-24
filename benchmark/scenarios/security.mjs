/**
 * Security 套件：10 个安全对抗场景。
 *
 * 验证安全防线在"直接调用工具"的最坏情况下仍然生效：
 *  - CommandGuard 结构防线（shell 解释器 / 包装器 / 内联代码 / 注入字符）；
 *  - PolicyEngine 硬黑名单（纯评估，绝不真正执行危险程序）；
 *  - WorkspaceGuard 路径逃逸；
 *  - Memory 敏感信息写入拦截；
 *  - Sub-Agent 工具白名单收敛。
 */

export const suite = {
  name: 'security',
  scenarios: [
    {
      id: 'SEC-01',
      name: 'run_command 拒绝 cmd 交互式 shell',
      async run(env) {
        const tool = env.tools.createRunCommandTool();
        const outcome = await tool.execute({ program: 'cmd', args: ['/c', 'echo hi'] }, env.ctx);
        const err = env.toolBlocked(outcome, /^COMMAND_BLOCKED$/, 'cmd 拦截');
        env.expectEq(err.details?.rule, 'shell_interpreter', '拦截规则');
      },
    },
    {
      id: 'SEC-02',
      name: 'run_command 拒绝 powershell',
      async run(env) {
        const tool = env.tools.createRunCommandTool();
        const outcome = await tool.execute({ program: 'powershell', args: ['-Command', 'Get-Date'] }, env.ctx);
        env.toolBlocked(outcome, /^COMMAND_BLOCKED$/, 'powershell 拦截');
      },
    },
    {
      id: 'SEC-03',
      name: 'run_command 拒绝程序名中的注入字符',
      async run(env) {
        const tool = env.tools.createRunCommandTool();
        const outcome = await tool.execute({ program: 'node; rm -rf /', args: [] }, env.ctx);
        const err = env.toolBlocked(outcome, /^COMMAND_BLOCKED$/, '注入字符拦截');
        env.expectEq(err.details?.rule, 'illegal_program_chars', '拦截规则');
      },
    },
    {
      id: 'SEC-04',
      name: 'run_command 拒绝参数中的控制字符',
      async run(env) {
        const tool = env.tools.createRunCommandTool();
        const outcome = await tool.execute({ program: 'node', args: ['script.js\nrm -rf /'] }, env.ctx);
        env.toolBlocked(outcome, /^COMMAND_BLOCKED$/, '控制字符拦截');
      },
    },
    {
      id: 'SEC-05',
      name: 'run_command 拒绝 node -e 内联代码执行',
      async run(env) {
        const tool = env.tools.createRunCommandTool();
        const outcome = await tool.execute({ program: 'node', args: ['-e', 'process.exit(0)'] }, env.ctx);
        const err = env.toolBlocked(outcome, /^COMMAND_BLOCKED$/, '内联代码拦截');
        env.expectEq(err.details?.rule, 'inline_code_execution', '拦截规则');
      },
    },
    {
      id: 'SEC-06',
      name: 'PolicyEngine 硬黑名单拒绝 shutdown（纯评估不执行）',
      async run(env) {
        // 注意：这里用 CommandGuard.check 做纯策略评估，绝不真正 spawn 危险程序
        const guard = new env.sec.CommandGuard();
        const verdict = guard.check({ program: 'shutdown', args: ['/s', '/t', '0'] }, env.ctx.policy);
        env.expectEq(verdict.decision, 'deny', 'shutdown 必须被 deny');
        env.expectEq(verdict.rule, 'hard_denied_program', '命中硬黑名单规则');
      },
    },
    {
      id: 'SEC-07',
      name: 'CommandGuard 拒绝命令包装器 xargs',
      async run(env) {
        const guard = new env.sec.CommandGuard();
        const verdict = guard.check({ program: 'xargs', args: ['rm', '-rf'] }, env.ctx.policy);
        env.expectEq(verdict.decision, 'deny', 'xargs 必须被 deny');
        env.expectEq(verdict.rule, 'command_wrapper', '命中包装器规则');
      },
    },
    {
      id: 'SEC-08',
      name: 'Memory 拒绝写入 OpenAI API Key',
      async run(env) {
        const memory = env.core.createMemoryManager(':memory:');
        try {
          let code = null;
          try {
            memory.remember({
              kind: 'fact',
              source: 'agent',
              scope: 'project',
              key: 'thirdparty.openai',
              content: 'OpenAI key: sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd',
              workspace: env.ws,
            });
          } catch (err) {
            code = err?.code ?? null;
          }
          env.expectEq(code, 'MEMORY_SENSITIVE_CONTENT', '含 API Key 的记忆必须被拒绝');
          env.expectEq(memory.count(env.ws), 0, '敏感内容不得入库');
        } finally {
          memory.close();
        }
      },
    },
    {
      id: 'SEC-09',
      name: 'Memory 拒绝写入 GitHub Token',
      async run(env) {
        const memory = env.core.createMemoryManager(':memory:');
        try {
          let code = null;
          try {
            memory.remember({
              kind: 'fact',
              source: 'tool_run',
              scope: 'session',
              key: 'github.credential',
              content: 'token = ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
              workspace: env.ws,
              session_id: 'bench-session',
            });
          } catch (err) {
            code = err?.code ?? null;
          }
          env.expectEq(code, 'MEMORY_SENSITIVE_CONTENT', '含 GitHub Token 的记忆必须被拒绝');
        } finally {
          memory.close();
        }
      },
    },
    {
      id: 'SEC-10',
      name: 'Sub-Agent 工具白名单收敛检测',
      async run(env) {
        const outOfScope = env.core.findOutOfScopeTools(
          ['read_file', 'edit_file', 'run_command'],
          ['read_file'],
        );
        env.expectEq(outOfScope.length, 2, '越权工具数');
        env.expect(outOfScope.includes('edit_file') && outOfScope.includes('run_command'), '应识别全部越权工具');
        env.expectEq(env.core.findOutOfScopeTools(['read_file'], ['read_file']).length, 0, '子集应合法');
      },
    },
  ],
};
