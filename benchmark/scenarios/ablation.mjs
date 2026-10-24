/**
 * Ablation 套件：5 个消融对比场景。
 *
 * 每个场景对同一输入跑"开/关"两路，验证增强模块确实带来可观测差异，
 * 并把对比数据写入 details 供历史趋势分析。
 */

export const suite = {
  name: 'ablation',
  scenarios: [
    {
      id: 'ABL-01',
      name: '证据外置 vs 直接截断：信息可恢复性对比',
      async run(env) {
        const bigLog = '关键错误堆栈 '.repeat(800);
        const buildWith = (evidenceStore) => {
          const cm = new env.core.ContextManager({
            systemPrompt: '消融对比',
            contextWindow: 2048,
            maxOutputTokens: 256,
            safetyMarginTokens: 0,
            ...(evidenceStore
              ? { evidenceStore, evidenceSessionId: 'abl' }
              : {}),
          });
          cm.append({ role: 'user', content: '分析日志' });
          cm.append({
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_logs', arguments: '{}' } }],
          });
          cm.append({ role: 'tool', tool_call_id: 'c1', name: 'read_logs', content: bigLog });
          // 最近一条工具输出不会被外置——补一轮小工具调用让 c1 成为外置候选
          cm.append({ role: 'assistant', content: '初步结论' });
          cm.append({ role: 'user', content: '再查端口' });
          cm.append({
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c2', type: 'function', function: { name: 'inspect_port', arguments: '{"port":80}' } }],
          });
          cm.append({ role: 'tool', tool_call_id: 'c2', name: 'inspect_port', content: '{"found":false}' });
          cm.append({ role: 'assistant', content: '端口正常' });
          return cm.build();
        };

        // 关：无证据库 → 原文被截断或整轮丢弃，信息不可完整恢复
        const off = buildWith(null);
        const offText = JSON.stringify(off.messages);
        env.expect(!offText.includes('[内容已外置为证据'), '关闭时不应有证据占位符');
        env.expect(!offText.includes(bigLog), '关闭时完整原文不可恢复');

        // 开：有证据库 → 原文整体保留可取回
        const store = new env.core.EvidenceStore(':memory:');
        try {
          const on = buildWith(store);
          env.expect(on.externalized >= 1, '开启时应外置证据');
          const onTool = on.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
          const match = /ev_[a-zA-Z0-9_-]+/.exec(onTool.content);
          env.expect(match !== null, '占位符应含 evidence_id');
          env.expectEq(store.get(match[0]).content, bigLog, '证据库应保留完整原文');
          return {
            details: {
              originalLength: bigLog.length,
              onExternalized: on.externalized,
              recoverableWithEvidence: true,
            },
          };
        } finally {
          store.close();
        }
      },
    },
    {
      id: 'ABL-02',
      name: 'hybrid_search 三层全开 vs 仅关键词层',
      async run(env) {
        await env.write('src/pay.ts', 'export function processPayment(amount) {\n  return chargeCard(amount);\n}\n');
        const tool = env.tools.createHybridSearchTool();
        const query = { query: 'processPayment', path: '.', maxPerLayer: 20, maxResults: 30, caseSensitive: false };

        const keywordOnly = env.toolData(
          await tool.execute({ ...query, layers: ['keyword'] }, env.ctx),
          '仅关键词层',
        );
        env.expect(!keywordOnly.layerStats.structure.enabled, '关闭时结构层应禁用');
        env.expect(!keywordOnly.layerStats.semantic.enabled, '关闭时语义层应禁用');
        env.expect(!keywordOnly.hits.some((h) => h.symbol === 'processPayment'), '关闭时应无符号级命中');

        const full = env.toolData(await tool.execute(query, env.ctx), '三层全开');
        env.expect(full.hits.some((h) => h.symbol === 'processPayment'), '全开时应有符号级命中');
        return {
          details: {
            keywordOnlyHits: keywordOnly.hits.length,
            fullHits: full.hits.length,
            structureHitCount: full.layerStats.structure.hitCount,
          },
        };
      },
    },
    {
      id: 'ABL-03',
      name: 'Sub-Agent 预算硬上限 clip 对比默认预算',
      async run(env) {
        const clipped = env.core.resolveBudget({ maxTokens: 999_999, maxToolCalls: 500, maxIterations: 99 });
        env.expectEq(clipped.maxTokens, env.core.HARD_BUDGET_LIMITS.maxTokens, 'token 应被 clip 到硬上限');
        env.expectEq(clipped.maxToolCalls, env.core.HARD_BUDGET_LIMITS.maxToolCalls, '工具数应被 clip');
        env.expectEq(clipped.maxIterations, env.core.HARD_BUDGET_LIMITS.maxIterations, '迭代数应被 clip');

        const dflt = env.core.resolveBudget(undefined);
        env.expectEq(dflt.maxTokens, env.core.DEFAULT_BUDGET.maxTokens, '缺省应为默认预算');
        return {
          details: { hardLimits: env.core.HARD_BUDGET_LIMITS, defaults: env.core.DEFAULT_BUDGET },
        };
      },
    },
    {
      id: 'ABL-04',
      name: 'Memory 召回 tags 过滤 vs 不过滤',
      async run(env) {
        const memory = env.core.createMemoryManager(':memory:');
        try {
          const base = { kind: 'fact', source: 'agent', scope: 'project', workspace: env.ws };
          memory.remember({ ...base, key: 'db.host', content: '数据库配置：主机 db-01', tags: ['db'] });
          memory.remember({ ...base, key: 'db.port', content: '数据库配置：端口 5432', tags: ['db'] });
          memory.remember({ ...base, key: 'cache.ttl', content: '缓存配置：TTL 300s', tags: ['cache'] });

          const all = memory.recall({ workspace: env.ws, text: '配置' });
          const dbOnly = memory.recall({ workspace: env.ws, text: '配置', tags: ['db'] });
          env.expectEq(all.length, 3, '不过滤应召回 3 条');
          env.expectEq(dbOnly.length, 2, 'tags 过滤应只召回 2 条');
          env.expect(dbOnly.every((h) => h.entry.tags.includes('db')), '过滤结果应全部含 db 标签');
          return { details: { all: all.length, dbOnly: dbOnly.length } };
        } finally {
          memory.close();
        }
      },
    },
    {
      id: 'ABL-05',
      name: 'grep_search 大小写敏感 vs 不敏感命中对比',
      async run(env) {
        await env.write('case.ts', 'TOKEN_VALUE\ntoken_value\nTOKEN_VALUE\n');
        const tool = env.tools.createGrepSearchTool();
        const insensitive = env.toolData(
          await tool.execute({ pattern: 'token_value', path: '.', caseSensitive: false }, env.ctx),
          '大小写不敏感',
        );
        const sensitive = env.toolData(
          await tool.execute({ pattern: 'token_value', path: '.', caseSensitive: true }, env.ctx),
          '大小写敏感',
        );
        env.expectEq(insensitive.matchCount, 3, '不敏感应命中 3 处');
        env.expectEq(sensitive.matchCount, 1, '敏感应只命中 1 处');
        return { details: { insensitive: insensitive.matchCount, sensitive: sensitive.matchCount } };
      },
    },
  ],
};
