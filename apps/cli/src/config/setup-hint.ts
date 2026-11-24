/**
 * 未配置模型时的引导文案（chat / run / plain 共用，避免各处说法不一致）。
 */
export function modelSetupHint(options: { interactive: boolean }): string {
  const lines = [
    '尚未配置模型。',
    options.interactive
      ? '进入 TUI 后使用 `/connect` 或 `/key` 配置模型。'
      : '任选一种方式完成配置：',
    '  1. 交互式向导：forgex connect',
    '  2. 非交互式：forgex connect --provider deepseek --api-key sk-xxx --model deepseek-flash',
    '  3. 只设置 Key：export DEEPSEEK_API_KEY=sk-xxx（启动时自动识别 DeepSeek）',
    '  4. 环境变量：FORGEX_BASE_URL / FORGEX_MODEL / FORGEX_API_KEY',
    '  5. 配置文件：~/.forgex/config.json 或项目根目录 forgex.config.json',
  ];
  return lines.join('\n');
}
