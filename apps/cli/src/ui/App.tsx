/**
 * Ink TUI 主界面。
 *
 * 设计取舍：
 *  - 已提交的消息用 <Static> 渲染（只追加、不重排），避免整屏重绘导致的闪烁；
 *  - 流式内容单独放在 Static 之后，随 delta 更新；
 *  - 审批以模态提示呈现，未处理前不接受普通输入；
 *  - 所有状态都来自 Agent 事件流，UI 不直接读取工具内部状态。
 *
 * 运行时命令（斜杠命令）：
 *  - /models  切换模型（只替换 Provider，会话历史保留）
 *  - /plan    计划模式开关（权限降为 readonly + 系统提示词追加规划约束）
 *  - /connect 在 TUI 内完成 Key 校验、持久化与配置落盘
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { formatMs, type AgentEvent, type ApprovalRequest, type RunMetrics } from '@forgex/shared';
import { createProvider, type ModelConfig } from '@forgex/models';
import type { ForgeRuntime } from '../runtime/create-runtime.js';
import { switchModel as applyModelSwitch } from '../runtime/model-switch.js';
import type { ApprovalBridge } from './approval-bridge.js';
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

type LineKind = 'user' | 'assistant' | 'tool' | 'notice' | 'error';

interface Line {
  id: number;
  kind: LineKind;
  text: string;
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

const HELP = [
  '可用命令：',
  '  /models   查看并切换模型（会话历史保留）',
  '  /plan     进入/退出计划模式（只读，只出计划不改代码）',
  '  /connect  连接模型：校验 Key、持久化并立即生效',
  '  /context  显示上下文 token 估算',
  '  /session  显示会话 id',
  '  /help     显示帮助',
  '  /exit     退出',
  'Ctrl+C 取消当前任务（向导中则取消向导）；审批时按 y 批准 / n 拒绝。',
].join('\n');

export function App({ runtime, bridge }: AppProps): React.ReactElement {
  const { agent } = runtime;
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>([]);
  const [streaming, setStreaming] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [modelName, setModelName] = useState(agent.modelName);
  const [mode, setMode] = useState(agent.permissionMode);
  const [planMode, setPlanMode] = useState(agent.isPlanMode);
  const [wizard, setWizard] = useState<WizardStep | null>(null);

  const counter = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const workspace = runtime.settings.workspaceRoots[0] ?? process.cwd();

  const push = useCallback((kind: LineKind, text: string) => {
    counter.current += 1;
    const line: Line = { id: counter.current, kind, text };
    setLines((prev) => [...prev, line]);
  }, []);

  useEffect(() => {
    const offEvent = agent.events.on((event: AgentEvent) => {
      switch (event.type) {
        case 'assistant:delta':
          setStreaming((prev) => prev + event.text);
          break;
        case 'assistant:message':
          setStreaming('');
          if (event.text.trim().length > 0) push('assistant', event.text);
          break;
        case 'tool:start':
          push('tool', `调用 ${event.name}`);
          break;
        case 'tool:end':
          push(
            'tool',
            `${event.name} ${event.result.ok ? '成功' : '失败'}（${formatMs(event.result.durationMs)}）${event.result.summary}`,
          );
          break;
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
          setBusy(false);
          break;
        default:
          break;
      }
    });

    const offApproval = bridge.onRequest((request) => {
      setApproval(request);
    });

    push(
      'notice',
      `ForgeX 已就绪 | 模型 ${agent.modelName} | 权限 ${agent.permissionMode} | 工作区 ${workspace}\n输入 /help 查看命令。`,
    );

    return () => {
      offEvent();
      offApproval();
    };
  }, [agent, bridge, push, workspace]);

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
        case '/context':
          push('notice', `当前上下文估算: ${agent.contextTokens()} tokens`);
          return;
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
          push('notice', modelListText(agent.modelName));
          setWizard({ step: 'pickModel' });
          return;
        }
        case '/connect': {
          if (busy) {
            push('notice', '当前任务运行中，无法重新连接');
            return;
          }
          push('notice', providerListText());
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
    setInput('');

    // 向导中允许空回车：接受默认值 / 取消选择
    if (wizard) {
      void advanceWizard(text);
      return;
    }
    if (!text) return;
    if (text.startsWith('/')) {
      handleSlash(text);
      return;
    }
    if (busy || connecting) return;

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
        controllerRef.current = null;
        setBusy(false);
        setContextTokens(agent.contextTokens());
      });
  }, [advanceWizard, agent, busy, connecting, handleSlash, input, push, wizard]);

  useInput((inputChar, key) => {
    // 审批优先：此时普通输入被屏蔽
    if (approval) {
      if (inputChar.toLowerCase() === 'y') {
        bridge.respond(true);
        setApproval(null);
        push('notice', '已批准');
        return;
      }
      if (inputChar.toLowerCase() === 'n' || key.escape) {
        bridge.respond(false);
        setApproval(null);
        push('notice', '已拒绝');
        return;
      }
      if (key.ctrl && inputChar === 'c') {
        bridge.cancel();
        setApproval(null);
        push('notice', '已取消审批（按拒绝处理）');
      }
      return;
    }

    if (key.ctrl && inputChar === 'c') {
      if (wizard) {
        setWizard(null);
        setInput('');
        push('notice', '已取消向导');
      } else if (busy && controllerRef.current) {
        controllerRef.current.abort();
        push('notice', '已请求取消当前任务…');
      } else {
        exit();
      }
      return;
    }

    if (busy || connecting) return;
    if (key.return) {
      submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return;
    if (inputChar) setInput((prev) => prev + inputChar);
  });

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(line) => (
          <Text key={line.id} {...styleOf(line.kind)}>
            {prefixOf(line.kind)}
            {line.text}
          </Text>
        )}
      </Static>

      {streaming.length > 0 ? <Text>{streaming}</Text> : null}

      {approval ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
          <Text color="yellow">需要人工审批：{approval.tool}（{approval.riskLevel}）</Text>
          <Text>{approval.reason}</Text>
          {approval.preview ? <Text dimColor>{approval.preview}</Text> : null}
          <Text color="yellow">按 y 批准 / n 拒绝（Ctrl+C 视为拒绝）</Text>
        </Box>
      ) : null}

      {wizard ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">{wizardPrompt(wizard)}</Text>
          <Text>
            {wizard.step === 'apiKey' ? '*'.repeat(input.length) : input}
            <Text color="gray">_</Text>
          </Text>
          <Text dimColor>回车提交，Ctrl+C 取消向导</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color="cyan">{busy ? '运行中… ' : connecting ? '连接中… ' : ''}forgex&gt; </Text>
          <Text>{input}</Text>
          <Text color="gray">{busy || connecting ? '' : '_'}</Text>
        </Box>
      )}

      <Text dimColor>
        {modelName} | 会话 {agent.sessionId} | {planMode ? '计划模式(只读)' : `权限 ${mode}`} | 上下文{' '}
        {contextTokens} tokens
        {metrics
          ? ` | 上轮 ${formatMs(metrics.totalMs)} / 模型 ${metrics.modelCalls} 次 / 工具 ${metrics.toolCalls} 次 / tokens ${metrics.totalTokens}`
          : ''}
      </Text>
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* 文案与样式                                                          */
/* ------------------------------------------------------------------ */

function modelListText(current: string): string {
  const rows = MODEL_PRESETS.map(
    (preset, index) => `  ${index + 1}. ${preset.model} — ${preset.label}${preset.model === current ? '（当前）' : ''}`,
  );
  return [
    '可用模型：',
    ...rows,
    '',
    '也可直接输入任意模型名（沿用当前 baseUrl），例如：/models deepseek-v4-pro',
  ].join('\n');
}

function providerListText(): string {
  const rows = PROVIDERS_KEYS.map(
    (key, index) => `  ${index + 1}. ${PROVIDERS[key]!.name} — ${PROVIDERS[key]!.defaultBaseUrl}`,
  );
  return ['连接模型：', ...rows, '', '输入编号或名称，直接回车 = DeepSeek'].join('\n');
}

function wizardPrompt(wizard: WizardStep): string {
  switch (wizard.step) {
    case 'provider':
      return '提供方编号/名称（回车=DeepSeek）> ';
    case 'baseUrl':
      return `baseUrl [${PROVIDERS[wizard.provider]?.defaultBaseUrl ?? ''}] > `;
    case 'apiKey':
      return 'API Key（输入不回显）> ';
    case 'model':
      return `模型名 [${PROVIDERS[wizard.provider]?.defaultModel ?? ''}] > `;
    case 'pickModel':
      return '模型编号或名称（回车取消）> ';
    default:
      return '> ';
  }
}

function prefixOf(kind: LineKind): string {
  switch (kind) {
    case 'user':
      return '> ';
    case 'tool':
      return '[工具] ';
    case 'notice':
      return '[提示] ';
    case 'error':
      return '[错误] ';
    default:
      return '';
  }
}

function styleOf(kind: LineKind): { color?: string; dimColor?: boolean } {
  switch (kind) {
    case 'user':
      return { color: 'cyan' };
    case 'tool':
      return { color: 'yellow' };
    case 'notice':
      return { dimColor: true };
    case 'error':
      return { color: 'red' };
    default:
      return {};
  }
}
