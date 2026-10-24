/**
 * Coding 套件：20 个确定性场景。
 *
 * 覆盖：read_file / list_directory / grep_search / edit_file / hybrid_search
 * 五个编码核心工具的正常路径、边界条件与组合链路。
 * 全部在独立临时工作区用真实工具执行，无任何模型调用。
 */

export const suite = {
  name: 'coding',
  scenarios: [
    {
      id: 'COD-01',
      name: 'read_file 读取存在的文件并命中标记',
      async run(env) {
        await env.write('src/app.ts', '// BENCH_MARKER_ALPHA\nexport const v = 1;\n');
        const tool = env.tools.createReadFileTool();
        const data = env.toolData(await tool.execute({ path: 'src/app.ts' }, env.ctx), 'read_file');
        env.expect(data.content.includes('BENCH_MARKER_ALPHA'), '内容应包含标记');
        env.expectEq(data.totalLines, 2, '行数');
      },
    },
    {
      id: 'COD-02',
      name: 'read_file 读取不存在的文件返回 PATH_NOT_FOUND',
      async run(env) {
        const tool = env.tools.createReadFileTool();
        const outcome = await tool.execute({ path: 'no-such-file.ts' }, env.ctx);
        env.toolBlocked(outcome, /^PATH_NOT_FOUND$/, 'read_file 不存在文件');
      },
    },
    {
      id: 'COD-03',
      name: 'read_file offset/limit 分页读取正确',
      async run(env) {
        await env.write('lines.txt', 'L1\nL2\nL3\nL4\nL5\n');
        const tool = env.tools.createReadFileTool();
        const data = env.toolData(await tool.execute({ path: 'lines.txt', offset: 2, limit: 2 }, env.ctx), 'read_file 分页');
        env.expectEq(data.startLine, 2, '起始行');
        env.expect(data.content.includes('L2') && data.content.includes('L3'), '内容应含 L2/L3');
        env.expect(!data.content.includes('L4'), '不应读到 L4');
      },
    },
    {
      id: 'COD-04',
      name: 'list_directory 列出文件与子目录',
      async run(env) {
        await env.write('a.ts', 'export {};\n');
        await env.write('sub/b.ts', 'export {};\n');
        const tool = env.tools.createListDirectoryTool();
        const data = env.toolData(await tool.execute({ path: '.', depth: 1 }, env.ctx), 'list_directory');
        const paths = data.entries.map((e) => e.path);
        env.expect(paths.some((p) => p.endsWith('a.ts')), '应列出 a.ts');
        // 目录条目带尾部斜杠（如 'sub/'），断言时归一化
        env.expect(
          data.entries.some((e) => e.type === 'directory' && e.path.replace(/\/$/, '').endsWith('sub')),
          '应列出 sub 目录',
        );
      },
    },
    {
      id: 'COD-05',
      name: 'list_directory depth=2 递归到嵌套文件',
      async run(env) {
        await env.write('sub/deep/c.ts', 'export {};\n');
        const tool = env.tools.createListDirectoryTool();
        const data = env.toolData(await tool.execute({ path: '.', depth: 2 }, env.ctx), 'list_directory depth=2');
        env.expect(
          data.entries.some((e) => e.path.replace(/\\/g, '/').replace(/\/$/, '').endsWith('sub/deep')),
          'depth=2 应列出 sub/deep',
        );
      },
    },
    {
      id: 'COD-06',
      name: 'grep_search 命中目标字符串且行号正确',
      async run(env) {
        await env.write('a.ts', 'line1\nconst TARGET_TOKEN = 42;\nline3\n');
        const tool = env.tools.createGrepSearchTool();
        const data = env.toolData(await tool.execute({ pattern: 'TARGET_TOKEN', path: '.' }, env.ctx), 'grep_search');
        env.expectEq(data.matchCount, 1, '匹配数');
        env.expectEq(data.matches[0].line, 2, '命中行号');
      },
    },
    {
      id: 'COD-07',
      name: 'grep_search 无匹配时返回空结果',
      async run(env) {
        await env.write('a.ts', 'nothing here\n');
        const tool = env.tools.createGrepSearchTool();
        const data = env.toolData(await tool.execute({ pattern: 'ABSENT_PATTERN_XYZ', path: '.' }, env.ctx), 'grep_search 无匹配');
        env.expectEq(data.matchCount, 0, '匹配数应为 0');
      },
    },
    {
      id: 'COD-08',
      name: 'grep_search 默认大小写不敏感',
      async run(env) {
        await env.write('a.ts', 'const UPPER_CASE_TOKEN = 1;\n');
        const tool = env.tools.createGrepSearchTool();
        const data = env.toolData(
          await tool.execute({ pattern: 'upper_case_token', path: '.', caseSensitive: false }, env.ctx),
          'grep_search 大小写',
        );
        env.expectEq(data.matchCount, 1, '小写 pattern 应命中大写内容');
      },
    },
    {
      id: 'COD-09',
      name: 'grep_search glob 过滤只命中 .ts 文件',
      async run(env) {
        await env.write('a.ts', 'SHARED_TOKEN\n');
        await env.write('b.md', 'SHARED_TOKEN\n');
        const tool = env.tools.createGrepSearchTool();
        const data = env.toolData(
          await tool.execute({ pattern: 'SHARED_TOKEN', path: '.', glob: '*.ts' }, env.ctx),
          'grep_search glob',
        );
        env.expect(data.matchCount >= 1, '应至少命中一次');
        env.expect(data.matches.every((m) => m.path.endsWith('.ts')), '命中应全部来自 .ts 文件');
      },
    },
    {
      id: 'COD-10',
      name: 'edit_file 唯一替换成功并可读回验证',
      async run(env) {
        await env.write('m.ts', 'export const value = 1;\n');
        const edit = env.tools.createEditFileTool();
        const data = env.toolData(
          await edit.execute({ path: 'm.ts', oldText: 'value = 1', newText: 'value = 2' }, env.ctx),
          'edit_file 替换',
        );
        env.expect(data.changed, '应报告已修改');
        env.expectEq(data.replacements, 1, '替换次数');
        const read = env.tools.createReadFileTool();
        const back = env.toolData(await read.execute({ path: 'm.ts' }, env.ctx), 'read_file 回读');
        env.expect(back.content.includes('value = 2'), '回读应含新内容');
      },
    },
    {
      id: 'COD-11',
      name: 'edit_file oldText 不存在时明确失败',
      async run(env) {
        await env.write('m.ts', 'export const value = 1;\n');
        const edit = env.tools.createEditFileTool();
        const outcome = await edit.execute({ path: 'm.ts', oldText: 'NOT_EXIST_TEXT', newText: 'x' }, env.ctx);
        env.toolBlocked(outcome, /^TOOL_FAILED$/, 'edit_file oldText 缺失');
      },
    },
    {
      id: 'COD-12',
      name: 'edit_file 多处匹配且 replaceAll=false 时拒绝',
      async run(env) {
        await env.write('m.ts', 'dup\ndup\n');
        const edit = env.tools.createEditFileTool();
        const outcome = await edit.execute({ path: 'm.ts', oldText: 'dup', newText: 'x', replaceAll: false }, env.ctx);
        env.toolBlocked(outcome, /^TOOL_FAILED$/, 'edit_file 多处匹配');
      },
    },
    {
      id: 'COD-13',
      name: 'edit_file replaceAll=true 替换全部匹配',
      async run(env) {
        await env.write('m.ts', 'dup\ndup\ndup\n');
        const edit = env.tools.createEditFileTool();
        const data = env.toolData(
          await edit.execute({ path: 'm.ts', oldText: 'dup', newText: 'x', replaceAll: true }, env.ctx),
          'edit_file replaceAll',
        );
        env.expectEq(data.replacements, 3, '应替换 3 处');
      },
    },
    {
      id: 'COD-14',
      name: 'edit_file 写入后 grep_search 立即搜到新内容（组合链路）',
      async run(env) {
        await env.write('chain.ts', 'export const a = 1;\n');
        const edit = env.tools.createEditFileTool();
        await edit.execute({ path: 'chain.ts', oldText: 'a = 1', newText: 'NEWLY_WRITTEN_SYMBOL = 1' }, env.ctx);
        const grep = env.tools.createGrepSearchTool();
        const data = env.toolData(await grep.execute({ pattern: 'NEWLY_WRITTEN_SYMBOL', path: '.' }, env.ctx), '组合链路 grep');
        env.expectEq(data.matchCount, 1, '写入后应能搜到');
      },
    },
    {
      id: 'COD-15',
      name: 'hybrid_search 关键词层命中真实文件',
      async run(env) {
        await env.write('src/pay.ts', 'export function processPayment(amount) {\n  return chargeCard(amount);\n}\n');
        const tool = env.tools.createHybridSearchTool();
        const data = env.toolData(
          await tool.execute({ query: 'processPayment', path: '.', maxPerLayer: 20, maxResults: 30, caseSensitive: false }, env.ctx),
          'hybrid_search 关键词',
        );
        env.expect(data.hits.some((h) => h.path.replace(/\\/g, '/').endsWith('src/pay.ts')), '应命中 pay.ts');
        env.expect(data.layerStats.keyword.enabled, '关键词层应启用');
      },
    },
    {
      id: 'COD-16',
      name: 'hybrid_search 结构层返回符号级命中',
      async run(env) {
        await env.write('src/pay.ts', 'export function processPayment(amount) {\n  return chargeCard(amount);\n}\n');
        const tool = env.tools.createHybridSearchTool();
        const data = env.toolData(
          await tool.execute({ query: 'processPayment', path: '.', maxPerLayer: 20, maxResults: 30, caseSensitive: false }, env.ctx),
          'hybrid_search 结构层',
        );
        env.expect(data.hits.some((h) => h.symbol === 'processPayment'), '应命中符号 processPayment');
        env.expect(data.layerStats.structure.hitCount > 0, '结构层应有命中');
      },
    },
    {
      id: 'COD-17',
      name: 'hybrid_search 三层全部启用且有层统计',
      async run(env) {
        await env.write('src/pay.ts', 'export function processPayment(amount) {\n  return chargeCard(amount);\n}\n');
        const tool = env.tools.createHybridSearchTool();
        const data = env.toolData(
          await tool.execute({ query: 'processPayment amount', path: '.', maxPerLayer: 20, maxResults: 30, caseSensitive: false }, env.ctx),
          'hybrid_search 三层',
        );
        env.expect(data.layerStats.keyword.enabled, 'keyword 启用');
        env.expect(data.layerStats.structure.enabled, 'structure 启用');
        env.expect(data.layerStats.semantic.enabled, 'semantic 启用');
        env.expect(data.scannedFiles >= 1, '应扫描到文件');
      },
    },
    {
      id: 'COD-18',
      name: 'hybrid_search 语义层对 token 重叠查询给出命中',
      async run(env) {
        await env.write(
          'src/billing.ts',
          '// handles payment charge and card billing\nexport function settle(invoice) {\n  return invoice.total;\n}\n',
        );
        const tool = env.tools.createHybridSearchTool();
        const data = env.toolData(
          await tool.execute({ query: 'payment charge card billing', path: '.', maxPerLayer: 20, maxResults: 30, caseSensitive: false }, env.ctx),
          'hybrid_search 语义层',
        );
        env.expect(data.layerStats.semantic.hitCount > 0, '语义层应有命中');
        env.expect(data.hits.some((h) => h.path.replace(/\\/g, '/').endsWith('src/billing.ts')), '应命中 billing.ts');
      },
    },
    {
      id: 'COD-19',
      name: 'read_file 拒绝工作区外路径逃逸',
      async run(env) {
        const tool = env.tools.createReadFileTool();
        const outcome = await tool.execute({ path: '../../outside-secret.txt' }, env.ctx);
        env.toolBlocked(outcome, /ESCAPE|NOT_FOUND|DENIED/, 'read_file 路径逃逸');
      },
    },
    {
      id: 'COD-20',
      name: 'edit_file 拒绝工作区外路径逃逸',
      async run(env) {
        const tool = env.tools.createEditFileTool();
        const outcome = await tool.execute({ path: '../../evil.ts', oldText: 'a', newText: 'b' }, env.ctx);
        env.toolBlocked(outcome, /ESCAPE|NOT_FOUND|DENIED/, 'edit_file 路径逃逸');
      },
    },
  ],
};
