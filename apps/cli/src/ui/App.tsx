/**
 * Ink TUI 主界面（参考 OpenCode 的布局与信息层级）。
 *
 * 设计：
 *  - 历史消息用 <Static> 渲染（只追加，避免整屏闪烁）；
 *  - 底部固定「输入框 + 状态栏」，上方是流式输出与运行中的工具；
 *  - 用户消息 `❯`、助手消息 `◆`、工具调用 `⏺`，工具结果折叠成一行；
 *  - 输入 `/` 弹出命令面板（↑/↓ 选择、Tab 补全、Enter 运行）；
 *  - 审批与 /connect 向导以圆角面板替换输入区，避免普通输入误触。
 *
 * 运行时命令：
 *  - /models  切换模型（只替换 Provider，会话历史保留）
 *  - /plan    计划模式开关（权限降为 readonly + 系统提示词追加规划约束）
 *  - /connect 在 TUI 内完成 Key 校验、持久化与配置落盘
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { formatMs, redactText, type AgentEvent, type ApprovalRequest, type RunMetrics } from '@forgex/shared';
import { createProvider, type ModelConfig } from '@forgex/models';
import type { ForgeRuntime } from '../runtime/create-runtime.js';
import { switchModel as applyModelSwitch } from '../runtime/model-switch.js';
import { VERSION } from '../version.js';
import type { ApprovalBridge } from './approval-bridge.js';
import { applyInputKey, type EditKeyState } from './input-edit.js';
import {
  MODEL_PRESETS,
  PROVIDERS,
  PROVIDERS_KEYS,
  defaultConfigPath,
  maskKey,
  persistApiKey,
  readExistingConfig,
  resolveProvider,
  saveConnectionConfig,
  testConnectivity,
} from '../runtime/connect-core.js';

type LineKind = 'banner' | 'user' | 'assistant' | 'tool' | 'notice' | 'error';
type ToolStatus = 'ok' | 'fail';

interface Line {
  id: number;
  kind: LineKind;
  text: string;
  detail?: string;
  status?: ToolStatus;
}

interface ActiveTool {
  callId: string;
  name: string;
  detail: string;
}

/** `/connect` 向导状态机 */
type WizardStep =
  | { step: 'provider' }
  | { step: 'baseUrl'; provider: string }
  | { step: 'apiKey'; provider: string; baseUrl: string }
  | { step: 'model'; provider: string; baseUrl: string; apiKey: string }
  | { step: 'pickModel' };

export interface AppProps {
  runtime: ForgeRuntime;
  bridge: ApprovalBridge;
}

const THEME = {
  brand: 'magenta',
  accent: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  muted: 'gray',
} as const;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const COMMANDS = [
  { name: '/models', desc: '切换模型（保留会话历史）' },
  { name: '/plan', desc: '计划模式：只读，只出方案不改代码' },
  { name: '/connect', desc: '连接模型 / 更新 API Key' },
  { name: '/context', desc: '查看上下文 token 用量' },
  { name: '/session', desc: '显示当前会话 ID' },
  { name: '/help', desc: '帮助与快捷键' },
  { name: '/exit', desc: '退出 ForgeX' },
];

const HELP = [
  '命令',
  '  /models   切换模型（会话历史保留）',
  '  /plan     进入/退出计划模式（只读，只出计划不改代码）',
  '  /connect  连接模型：校验 Key、持久化并立即生效',
  '  /context  显示上下文 token 估算',
  '  /session  显示会话 id',
  '  /help     显示帮助',
  '  /exit     退出',
  '',
  '快捷键',
  '  ↑/↓       在命令面板中选择',
  '  Tab       补全命令',
  '  ←/→       移动光标',
  '  Ctrl+A/E  行首 / 行尾',
  '  Ctrl+C    取消当前任务；空闲时再按一次退出',
  '  审批时    y 批准 / n 或 Esc 拒绝',
].join('\n');

export function App({ runtime, bridge }: AppProps): React.ReactElement {
  const { agent } = runtime;
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [lines, setLines] = useState<Line[]>([]);
  const [streaming, setStreaming] = useState('');
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [modelName, setModelName] = useState(agent.modelName);
  const [mode, setMode] = useState(agent.permissionMode);
  const [planMode, setPlanMode] = useState(agent.isPlanMode);
  const [wizard, setWizard] = useState<WizardStep | null>(null);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [width, setWidth] = useState(stdout?.columns ?? 80);

  const counter = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const streamingRef = useRef('');
  const workspace = runtime.settings.workspaceRoots[0] ?? process.cwd();

  /* ---------------- 终端尺寸 / 动画 ---------------- */

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setWidth(stdout.columns ?? 80);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  useEffect(() => {
    if (!busy && !connecting) return;
    const timer = setInterval(() => {
      setSpinnerFrame((frame) => (frame + 1) % SPINNER.length);
    }, 80);
    return () => clearInterval(timer);
  }, [busy, connecting]);

  /* ---------------- 消息与事件 ---------------- */

  const push = useCallback((kind: LineKind, text: string, extra?: { detail?: string; status?: ToolStatus }) => {
    counter.current += 1;
    setLines((prev) => [...prev, { id: counter.current, kind, text, ...extra }]);
  }, []);

  useEffect(() => {
    const offEvent = agent.events.on((event: AgentEvent) => {
      switch (event.type) {
        case 'assistant:delta':
          streamingRef.current += event.text;
          setStreaming(streamingRef.current);
          break;
        case 'assistant:message':
          streamingRef.current = '';
          setStreaming('');
          if (event.text.trim().length > 0) push('assistant', event.text);
          break;
        case 'tool:start':
          setActiveTools((prev) => [
            ...prev,
            { callId: event.callId, name: event.name, detail: describeToolInput(event.input) },
          ]);
          break;
        case 'tool:end': {
          setActiveTools((prev) => prev.filter((tool) => tool.callId !== event.callId));
          const ok = event.result.ok;
          const detail = ok
            ? `${redactText(event.result.summary)} · ${formatMs(event.result.durationMs)}`
            : `${redactText(event.result.error?.message ?? event.result.summary)} · ${formatMs(event.result.durationMs)}`;
          push('tool', event.name, { detail, status: ok ? 'ok' : 'fail' });
          break;
        }
        case 'notice':
          push(event.level === 'error' ? 'error' : 'notice', event.message);
          break;
        case 'approval:resolved':
          setApproval(null);
          break;
        case 'metrics':
          setMetrics(event.metrics);
          setContextTokens(agent.contextTokens());
          break;
        case 'turn:end':
          if (streamingRef.current.trim().length > 0) push('assistant', streamingRef.current);
          streamingRef.current = '';
          setStreaming('');
          setBusy(false);
          setActiveTools([]);
          break;
        default:
          break;
      }
    });

    const offApproval = bridge.onRequest((request) => {
      setApproval(request);
    });

    push('banner', `v${VERSION}`);
    push('notice', '输入消息开始，或输入 / 查看命令');

    return () => {
      offEvent();
      offApproval();
    };
  }, [agent, bridge, push]);

  /* ---------------- 模型切换 ---------------- */

  const switchModel = useCallback(
    (name: string) => {
      try {
        const result = applyModelSwitch(runtime, name);
        setModelName(result.model);
        push('notice', `已切换模型: ${result.model} @ ${result.baseUrl}`);
        push('notice', result.saved ? '已写入配置文件，下次启动保持该模型' : '未找到配置文件，本次切换仅在当前会话生效');
      } catch (err) {
        push('error', `切换模型失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [push, runtime],
  );

  /* ---------------- /connect 流程 ---------------- */

  const finishConnect = useCallback(
    async (params: { provider: string; baseUrl: string; apiKey: string; model: string }) => {
      const { provider, baseUrl, apiKey, model } = params;
      setConnecting(true);
      push('notice', `正在测试 ${model} @ ${baseUrl} ...`);
      const result = await testConnectivity({ baseUrl, apiKey, model });
      if (!result.ok) {
        push('error', `连通性测试失败：${result.reason}${result.detail ? `（${result.detail}）` : ''}`);
        setConnecting(false);
        return;
      }

      const preset = PROVIDERS[provider];
      const envName = preset?.apiKeyEnv ?? 'FORGEX_API_KEY';
      const persisted = persistApiKey(envName, apiKey);
      // 当前进程立即可用，无需重开终端
      process.env[envName] = apiKey;

      const configPath = runtime.configPath ?? defaultConfigPath();
      try {
        saveConnectionConfig(configPath, readExistingConfig(configPath), {
          baseUrl,
          model,
          envName,
          ...(preset ? { contextWindow: preset.contextWindow, maxOutputTokens: preset.maxOutputTokens } : {}),
        });
      } catch (err) {
        push('error', `配置写入失败: ${err instanceof Error ? err.message : String(err)}`);
      }

      const next: ModelConfig = {
        ...runtime.config.model,
        baseUrl,
        model,
        apiKey,
        ...(preset ? { contextWindow: preset.contextWindow, maxOutputTokens: preset.maxOutputTokens } : {}),
      };
      try {
        agent.setProvider(createProvider(next, { logger: runtime.logger }));
        runtime.config.model = next;
        setModelName(model);
      } catch (err) {
        push('error', `切换 Provider 失败: ${err instanceof Error ? err.message : String(err)}`);
      }

      push(
        'notice',
        `已连接 ${model}（${result.latencyMs}ms）| Key ${maskKey(apiKey)} | ` +
          (persisted.ok ? `${envName} 已持久化` : `需手动设置：${persisted.hint}`),
      );
      setConnecting(false);
    },
    [agent, push, runtime],
  );

  const advanceWizard = useCallback(
    async (text: string) => {
      if (!wizard) return;
      switch (wizard.step) {
        case 'provider': {
          const provider = resolveProvider(text);
          push('notice', `提供方: ${PROVIDERS[provider]?.name ?? provider}`);
          setWizard({ step: 'baseUrl', provider });
          return;
        }
        case 'baseUrl': {
          const baseUrl = text || PROVIDERS[wizard.provider]?.defaultBaseUrl || '';
          if (!baseUrl) {
            push('error', 'baseUrl 不能为空');
            return;
          }
          setWizard({ step: 'apiKey', provider: wizard.provider, baseUrl });
          return;
        }
        case 'apiKey': {
          if (!text) {
            push('error', 'API Key 不能为空');
            return;
          }
          setWizard({ step: 'model', provider: wizard.provider, baseUrl: wizard.baseUrl, apiKey: text });
          return;
        }
        case 'model': {
          const model = text || PROVIDERS[wizard.provider]?.defaultModel || '';
          if (!model) {
            push('error', '模型名不能为空');
            return;
          }
          const { provider, baseUrl, apiKey } = wizard;
          setWizard(null);
          await finishConnect({ provider, baseUrl, apiKey, model });
          return;
        }
        case 'pickModel': {
          setWizard(null);
          if (!text) {
            push('notice', '已取消模型切换');
            return;
          }
          const index = Number(text);
          const preset =
            Number.isInteger(index) && index >= 1 && index <= MODEL_PRESETS.length
              ? MODEL_PRESETS[index - 1]
              : undefined;
          switchModel(preset ? preset.model : text);
          return;
        }
        default:
          return;
      }
    },
    [finishConnect, push, switchModel, wizard],
  );

  /* ---------------- 斜杠命令 ---------------- */

  const handleSlash = useCallback(
    (text: string) => {
      const [name, ...rest] = text.split(/\s+/);
      const arg = rest.join(' ').trim();

      switch (name) {
        case '/exit':
        case '/quit':
          exit();
          return;
        case '/help':
          push('notice', HELP);
          return;
        case '/session':
          push('notice', `会话 id: ${agent.sessionId}`);
          return;
        case '/context': {
          const tokens = agent.contextTokens();
          setContextTokens(tokens);
          push('notice', `当前上下文估算: ${tokens} tokens`);
          return;
        }
        case '/plan': {
          if (busy) {
            push('notice', '当前任务运行中，结束或 Ctrl+C 取消后再切换计划模式');
            return;
          }
          const next = !agent.isPlanMode;
          agent.setPlanMode(next);
          setPlanMode(next);
          setMode(agent.permissionMode);
          return;
        }
        case '/models':
        case '/model': {
          if (busy) {
            push('notice', '当前任务运行中，无法切换模型');
            return;
          }
          if (arg) {
            switchModel(arg);
            return;
          }
          setWizard({ step: 'pickModel' });
          return;
        }
        case '/connect': {
          if (busy) {
            push('notice', '当前任务运行中，无法重新连接');
            return;
          }
          setWizard({ step: 'provider' });
          return;
        }
        default:
          push('error', `未知命令: ${name}（输入 /help 查看）`);
      }
    },
    [agent, busy, exit, push, switchModel],
  );

  const submit = useCallback(() => {
    const text = input.trim();
    if (wizard) {
      setInput('');
      setCursor(0);
      void advanceWizard(text);
      return;
    }
    if (!text) return;
    if (text.startsWith('/')) {
      setInput('');
      setCursor(0);
      handleSlash(text);
      return;
    }
    if (busy || connecting) return;

    setInput('');
    setCursor(0);
    push('user', text);
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;

    void agent
      .run(text, { signal: controller.signal })
      .then((result) => {
        if (result.reason !== 'completed') {
          push('notice', `本轮结束：${result.reason}`);
        }
      })
      .catch((err: unknown) => {
        push('error', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (streamingRef.current.trim().length > 0) push('assistant', streamingRef.current);
        streamingRef.current = '';
        setStreaming('');
        controllerRef.current = null;
        setBusy(false);
        setActiveTools([]);
        setContextTokens(agent.contextTokens());
      });
  }, [advanceWizard, agent, busy, connecting, handleSlash, input, push, wizard]);

  /* ---------------- 输入编辑 ---------------- */

  const editInput = useCallback(
    (char: string, key: EditKeyState): boolean => {
      const next = applyInputKey({ text: input, cursor }, char, key);
      if (!next) return false;
      if (next.text !== input) setInput(next.text);
      if (next.cursor !== cursor) setCursor(next.cursor);
      return true;
    },
    [cursor, input],
  );

  /* ---------------- 键盘 ---------------- */

  const palette = !wizard && !busy && !connecting && input.startsWith('/') && !input.includes(' ')
    ? COMMANDS.filter((command) => command.name.startsWith(input.toLowerCase()))
    : [];
  const selectedPalette = palette[Math.min(paletteIndex, Math.max(0, palette.length - 1))];

  useEffect(() => {
    setPaletteIndex(0);
  }, [input]);

  useInput((char, key) => {
    // 审批优先：此时普通输入被屏蔽
    if (approval) {
      if (char.toLowerCase() === 'y') {
        bridge.respond(true);
        setApproval(null);
        push('notice', '已批准');
        return;
      }
      if (char.toLowerCase() === 'n' || key.escape) {
        bridge.respond(false);
        setApproval(null);
        push('notice', '已拒绝');
        return;
      }
      if (key.ctrl && char === 'c') {
        bridge.cancel();
        setApproval(null);
        push('notice', '已取消审批（按拒绝处理）');
      }
      return;
    }

    if (key.ctrl && char === 'c') {
      if (wizard) {
        setWizard(null);
        setInput('');
        setCursor(0);
        push('notice', '已取消向导');
      } else if (busy && controllerRef.current) {
        controllerRef.current.abort();
        push('notice', '已请求取消当前任务…');
      } else {
        exit();
      }
      return;
    }

    if (wizard) {
      if (key.return) {
        submit();
        return;
      }
      if (key.escape) {
        setWizard(null);
        setInput('');
        setCursor(0);
        push('notice', '已取消向导');
        return;
      }
      editInput(char, key);
      return;
    }

    if (busy || connecting) return;

    if (palette.length > 0) {
      if (key.upArrow) {
        setPaletteIndex((index) => (index - 1 + palette.length) % palette.length);
        return;
      }
      if (key.downArrow) {
        setPaletteIndex((index) => (index + 1) % palette.length);
        return;
      }
      if (key.tab && selectedPalette) {
        setInput(`${selectedPalette.name} `);
        setCursor(selectedPalette.name.length + 1);
        return;
      }
      if (key.return && selectedPalette && input !== selectedPalette.name) {
        setInput(selectedPalette.name);
        setCursor(selectedPalette.name.length);
        return;
      }
      if (key.escape) {
        setInput('');
        setCursor(0);
        return;
      }
    }

    if (key.return) {
      submit();
      return;
    }
    editInput(char, key);
  });

  /* ---------------- 渲染 ---------------- */

  const modeLabel = planMode ? 'plan' : mode;
  const modeColor = planMode || mode === 'readonly' ? THEME.warning : mode === 'yolo' ? THEME.error : THEME.muted;
  const cwd = truncateMiddle(shortenHome(workspace), Math.max(16, Math.min(48, width - 52)));

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(line) => <LineView key={line.id} line={line} />}
      </Static>

      {activeTools.map((tool) => (
        <Box key={tool.callId} paddingLeft={2}>
          <Text color={THEME.accent}>{SPINNER[spinnerFrame]} </Text>
          <Text bold>{tool.name}</Text>
          {tool.detail ? <Text dimColor>  {tool.detail}</Text> : null}
        </Box>
      ))}

      {streaming.length > 0 ? (
        <Box marginTop={1}>
          <Text color={THEME.brand}>◆ </Text>
          <Text>
            {streaming}
            <Text color={THEME.accent}>▌</Text>
          </Text>
        </Box>
      ) : null}

      {approval ? (
        <ApprovalPanel approval={approval} />
      ) : wizard ? (
        <WizardPanel wizard={wizard} input={input} cursor={cursor} modelName={modelName} />
      ) : (
        <>
          {palette.length > 0 ? <CommandPalette commands={palette} selected={selectedPalette} /> : null}
          <Box
            marginTop={1}
            borderStyle="round"
            borderColor={busy || connecting ? THEME.muted : THEME.accent}
            paddingX={1}
          >
            <Text color={THEME.accent} bold>
              ❯{' '}
            </Text>
            {input.length === 0 ? (
              <>
                {busy || connecting ? null : <Text inverse> </Text>}
                <Text dimColor>
                  {busy ? '运行中，Ctrl+C 取消' : connecting ? '连接中…' : '输入消息，/ 查看命令'}
                </Text>
              </>
            ) : (
              renderInput(input, cursor, false)
            )}
          </Box>
        </>
      )}

      <Box marginTop={1}>
        <Text wrap="truncate-end">
          {busy || connecting ? (
            <Text color={THEME.accent}>{SPINNER[spinnerFrame]} </Text>
          ) : (
            <Text color={THEME.accent}>◆ </Text>
          )}
          <Text color={THEME.accent} bold>
            {modelName}
          </Text>
          <Text dimColor>  ·  </Text>
          <Text color={modeColor}>{modeLabel}</Text>
          <Text dimColor>  ·  ctx {formatTokens(contextTokens)}</Text>
          {metrics ? (
            <>
              <Text dimColor>  ·  </Text>
              <Text color={THEME.muted}>↑{formatTokens(metrics.promptTokens)}</Text>
              <Text dimColor> </Text>
              <Text color={THEME.muted}>↓{formatTokens(metrics.completionTokens)}</Text>
            </>
          ) : null}
          <Text dimColor>  ·  {cwd}</Text>
        </Text>
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* 组件                                                                */
/* ------------------------------------------------------------------ */

function LineView({ line }: { line: Line }): React.ReactElement {
  switch (line.kind) {
    case 'banner':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={THEME.brand} bold>
              ◆ ForgeX
            </Text>
            <Text dimColor>  {line.text}</Text>
          </Text>
          <Text dimColor>企业级 Coding + DevOps Agent</Text>
        </Box>
      );
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={THEME.accent} bold>
            ❯{' '}
          </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text bold>{line.text}</Text>
          </Box>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text color={THEME.brand}>◆ </Text>
          <Box flexDirection="column" flexGrow={1}>
            <RichText text={line.text} />
          </Box>
        </Box>
      );
    case 'tool':
      return (
        <Box paddingLeft={2}>
          <Text color={line.status === 'fail' ? THEME.error : THEME.success}>
            {line.status === 'fail' ? '✗ ' : '⏺ '}
          </Text>
          <Text bold>{line.text}</Text>
          {line.detail ? (
            <Text color={line.status === 'fail' ? THEME.error : undefined} dimColor={line.status !== 'fail'}>
              {'  '}
              {line.detail}
            </Text>
          ) : null}
        </Box>
      );
    case 'error':
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {line.text.split('\n').map((part, index) => (
            <Text key={index} color={THEME.error}>
              {index === 0 ? '✗ ' : '  '}
              {part}
            </Text>
          ))}
        </Box>
      );
    case 'notice':
    default:
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {line.text.split('\n').map((part, index) => (
            <Text key={index} dimColor>
              {index === 0 ? 'ℹ ' : '  '}
              {part}
            </Text>
          ))}
        </Box>
      );
  }
}

function CommandPalette({
  commands,
  selected,
}: {
  commands: typeof COMMANDS;
  selected: (typeof COMMANDS)[number] | undefined;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={THEME.muted} paddingX={1}>
      {commands.map((command) => {
        const active = command.name === selected?.name;
        return (
          <Box key={command.name}>
            <Text color={active ? THEME.accent : THEME.muted}>{active ? '❯ ' : '  '}</Text>
            <Text color={active ? THEME.accent : undefined} bold={active}>
              {command.name.padEnd(10)}
            </Text>
            <Text dimColor>{command.desc}</Text>
          </Box>
        );
      })}
      <Text dimColor>↑/↓ 选择 · Tab 补全 · Enter 运行 · Esc 清空</Text>
    </Box>
  );
}

function ApprovalPanel({ approval }: { approval: ApprovalRequest }): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={THEME.warning} paddingX={1}>
      <Box>
        <Text color={THEME.warning} bold>
          ⚠ 需要审批
        </Text>
        <Text dimColor>  {approval.tool}</Text>
        <Text color={riskColor(approval.riskLevel)}>  {approval.riskLevel}</Text>
      </Box>
      <Text>{approval.reason}</Text>
      {approval.preview ? (
        <Text dimColor wrap="truncate-end">
          {approval.preview}
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Text color={THEME.success}>[y]</Text>
        <Text dimColor> 批准   </Text>
        <Text color={THEME.error}>[n]</Text>
        <Text dimColor> 拒绝   </Text>
        <Text dimColor>[Esc] 拒绝</Text>
      </Box>
    </Box>
  );
}

function WizardPanel({
  wizard,
  input,
  cursor,
  modelName,
}: {
  wizard: WizardStep;
  input: string;
  cursor: number;
  modelName: string;
}): React.ReactElement {
  const showList = wizard.step === 'pickModel' || wizard.step === 'provider';
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={THEME.accent} paddingX={1}>
      <Box>
        <Text color={THEME.accent} bold>
          {wizardTitle(wizard)}
        </Text>
        <Text dimColor>  Esc 取消</Text>
      </Box>

      {wizard.step === 'pickModel' ? <ModelPicker current={modelName} /> : null}
      {wizard.step === 'provider' ? <ProviderPicker /> : null}

      <Box marginTop={showList ? 1 : 0} flexDirection="column">
        <Text color={THEME.accent}>{wizardPrompt(wizard)}</Text>
        <Box>
          <Text color={THEME.accent} bold>
            ❯{' '}
          </Text>
          {input.length === 0 ? (
            <>
              <Text inverse> </Text>
              <Text dimColor>{wizardPlaceholder(wizard)}</Text>
            </>
          ) : (
            renderInput(input, cursor, wizard.step === 'apiKey')
          )}
        </Box>
      </Box>
      <Text dimColor>{wizardHint(wizard)}</Text>
    </Box>
  );
}

function ModelPicker({ current }: { current: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {MODEL_PRESETS.map((preset, index) => {
        const active = preset.model === current;
        return (
          <Box key={preset.model}>
            <Text color={active ? THEME.success : THEME.muted}>{active ? '● ' : '○ '}</Text>
            <Text bold={active}>
              {index + 1}. {preset.model}
            </Text>
            <Text dimColor>  {preset.label}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ProviderPicker(): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {PROVIDERS_KEYS.map((key, index) => {
        const preset = PROVIDERS[key]!;
        return (
          <Box key={key}>
            <Text color={THEME.muted}>○ </Text>
            <Text>
              {index + 1}. {preset.name}
            </Text>
            <Text dimColor>  {preset.defaultBaseUrl}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** 轻量 Markdown 渲染：标题 / 列表 / 代码块 / 行内代码 / 粗体 */
function RichText({ text }: { text: string }): React.ReactElement {
  const nodes: React.ReactNode[] = [];
  let inCode = false;
  let language = '';

  text.split('\n').forEach((line, index) => {
    const fence = line.trimStart().match(/^```(.*)$/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        language = fence[1]?.trim() ?? '';
        nodes.push(
          <Text key={index} dimColor>
            ┌─ {language || 'code'}
          </Text>,
        );
      } else {
        inCode = false;
        language = '';
        nodes.push(
          <Text key={index} dimColor>
            └─
          </Text>,
        );
      }
      return;
    }
    if (inCode) {
      nodes.push(
        <Box key={index}>
          <Text dimColor>│ </Text>
          <Text color={THEME.muted}>{line || ' '}</Text>
        </Box>,
      );
      return;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      nodes.push(
        <Text key={index} bold>
          {line.replace(/^\s*#+\s*/, '')}
        </Text>,
      );
      return;
    }
    if (/^\s*[-*]\s/.test(line)) {
      nodes.push(
        <Box key={index}>
          <Text color={THEME.accent}>• </Text>
          <Text>{inline(line.replace(/^\s*[-*]\s/, ''))}</Text>
        </Box>,
      );
      return;
    }
    if (line.trim() === '') {
      nodes.push(<Text key={index}> </Text>);
      return;
    }
    nodes.push(<Text key={index}>{inline(line)}</Text>);
  });

  return <Box flexDirection="column">{nodes}</Box>;
}

function inline(text: string): React.ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <Text key={index} color={THEME.accent}>
            {part.slice(1, -1)}
          </Text>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <Text key={index} bold>
            {part.slice(2, -2)}
          </Text>
        );
      }
      return <Text key={index}>{part}</Text>;
    });
}

/* ------------------------------------------------------------------ */
/* 文案与工具函数                                                      */
/* ------------------------------------------------------------------ */

function renderInput(text: string, cursor: number, mask: boolean): React.ReactNode {
  const chars = Array.from(text);
  const at = Math.min(cursor, chars.length);
  const left = chars.slice(0, at).join('');
  const current = chars[at] ?? ' ';
  const right = chars.slice(at + 1).join('');
  const hide = (value: string) => '•'.repeat(Array.from(value).length);

  return (
    <>
      <Text>{mask ? hide(left) : left}</Text>
      <Text inverse>{mask ? (chars[at] ? '•' : ' ') : current}</Text>
      <Text>{mask ? hide(right) : right}</Text>
    </>
  );
}

function wizardTitle(wizard: WizardStep): string {
  switch (wizard.step) {
    case 'provider':
      return '连接模型 · 1/4 选择提供方';
    case 'baseUrl':
      return '连接模型 · 2/4 确认 baseUrl';
    case 'apiKey':
      return '连接模型 · 3/4 输入 API Key';
    case 'model':
      return '连接模型 · 4/4 确认模型名';
    case 'pickModel':
      return '切换模型';
    default:
      return '设置';
  }
}

function wizardPrompt(wizard: WizardStep): string {
  switch (wizard.step) {
    case 'provider':
      return '提供方（回车 = DeepSeek）';
    case 'baseUrl':
      return `baseUrl [${PROVIDERS[wizard.provider]?.defaultBaseUrl ?? ''}]`;
    case 'apiKey':
      return 'API Key';
    case 'model':
      return `模型名 [${PROVIDERS[wizard.provider]?.defaultModel ?? ''}]`;
    case 'pickModel':
      return '模型编号或名称';
    default:
      return '输入';
  }
}

function wizardHint(wizard: WizardStep): string {
  switch (wizard.step) {
    case 'provider':
      return '输入编号或名称，直接回车使用 DeepSeek';
    case 'baseUrl':
      return '直接回车使用默认地址';
    case 'apiKey':
      return '输入不会回显，也不会明文写入配置文件';
    case 'model':
      return '直接回车使用默认模型';
    case 'pickModel':
      return '直接回车取消';
    default:
      return '';
  }
}

function wizardPlaceholder(wizard: WizardStep): string {
  switch (wizard.step) {
    case 'provider':
      return '输入编号或名称';
    case 'baseUrl':
      return '输入 baseUrl';
    case 'apiKey':
      return '输入 API Key';
    case 'model':
      return '输入模型名';
    case 'pickModel':
      return '输入编号或名称';
    default:
      return '输入';
  }
}

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const record = input as Record<string, unknown>;
  if (typeof record.path === 'string') return redactText(truncateMiddle(record.path, 56));
  if (typeof record.program === 'string') {
    const args = Array.isArray(record.args) ? record.args.map(String).join(' ') : '';
    return redactText(truncateMiddle(`${record.program} ${args}`.trim(), 64));
  }
  if (typeof record.pattern === 'string') return redactText(truncateMiddle(record.pattern, 56));
  try {
    return redactText(truncateMiddle(JSON.stringify(input), 64));
  } catch {
    return '';
  }
}

function riskColor(risk: string): string {
  if (risk === 'privileged') return THEME.error;
  if (risk === 'execute' || risk === 'write') return THEME.warning;
  return THEME.muted;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function shortenHome(path: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home && path.toLowerCase().startsWith(home.toLowerCase())) return `~${path.slice(home.length)}`;
  return path;
}

function truncateMiddle(text: string, max: number): string {
  if (max <= 3 || text.length <= max) return text;
  const keep = max - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${text.slice(0, left)}…${text.slice(text.length - right)}`;
}
