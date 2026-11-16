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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { formatMs, redactText, type AgentEvent, type ApprovalRequest, type RunMetrics } from '@forgex/shared';
import { createProvider, type ModelConfig } from '@forgex/models';
import type { ForgeRuntime } from '../runtime/create-runtime.js';
import { dispatchWorkerHubCommand, isWorkerHubCommand } from '../runtime/worker-hub.js';
import { dispatchMemoryCommand, isMemoryCommand } from '../runtime/memory-command.js';
import { checkModelConnectivity, formatConfiguredModels, switchModel as applyModelSwitch, switchModelRole } from '../runtime/model-switch.js';
import { applyApiKey, currentApiKeyEnv } from '../runtime/api-key.js';
import { VERSION } from '../version.js';
import type { ApprovalBridge } from './approval-bridge.js';
import { applyInputKey, type EditKeyState } from './input-edit.js';
import { paginateApprovalPreview } from './approval-preview.js';
import {
  nextPermissionMode,
  parsePermissionMode,
  permissionModeHelp,
  permissionModeList,
} from '../config/permission-mode.js';
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
  { name: '/models', desc: '查看已配置模型、切换角色或检查连通性' },
  { name: '/memory', desc: '查看、搜索、纠正和审核项目记忆' },
  { name: '/workers', desc: '查看当前会话 worker 状态' },
  { name: '/worker', desc: '查看 worker 摘要或 transcript' },
  { name: '/steer', desc: '向运行中的 worker 发送指令' },
  { name: '/cancel-worker', desc: '取消 worker' },
  { name: '/retry-worker', desc: '重试已结束的 worker' },
  { name: '/wait-worker', desc: '等待 worker 完成' },
  { name: '/key', desc: '填写 API Key（隐藏输入，回车即存）' },
  { name: '/mode', desc: '切换权限模式（readonly/standard/trusted/yolo）' },
  { name: '/plan', desc: '计划模式：只读，只出方案不改代码' },
  { name: '/connect', desc: '连接模型向导（provider → baseUrl → Key → 模型）' },
  { name: '/context', desc: '查看上下文 token 用量' },
  { name: '/session', desc: '显示当前会话 ID' },
  { name: '/queue', desc: '查看运行中排队的指令' },
  { name: '/queue-remove', desc: '移除队列项：/queue-remove <id>' },
  { name: '/followup', desc: '当前任务完成后执行：/followup <指令>' },
  { name: '/help', desc: '帮助与快捷键' },
  { name: '/exit', desc: '退出 ForgeX' },
];

const HELP = [
  '命令',
  '  /models   查看已配置模型与角色',
  '  /models role <角色> [model-id]  切换模型任务角色',
  '  /models check <model-id>       检查模型连通性',
  '  /memory list                   列出当前工作区的项目记忆',
  '  /memory search <词>            搜索项目记忆',
  '  /memory show <id>              查看记忆来源、证据与状态',
  '  /memory edit <id> <内容>       纠正记忆并保留旧版本',
  '  /memory forget <id>            作废一条记忆',
  '  /memory clear confirm          清空当前工作区活动记忆（保留历史）',
  '  /memory export                 导出项目记忆 JSON',
  '  /memory candidates             查看待审核记忆候选',
  '  /memory approve|reject <id>    批准或拒绝候选',
  '  /workers                       查看 worker 状态与资源用量',
  '  /worker <id> [transcript]      查看摘要；指定 transcript 才显示完整对话',
  '  /steer <id> <指令>             向运行中的 worker 发送指令',
  '  /cancel-worker <id>            取消 worker',
  '  /retry-worker <id>             重试已结束的 worker',
  '  /wait-worker <id>              等待 worker 结束',
  '  /key      填写 API Key：/key（隐藏输入，推荐）或 /key sk-xxx（会立即校验连通性）',
  '  /mode     查看或切换权限模式：/mode standard、/mode plan、/mode agent',
  '  /plan     进入/退出计划模式（只读，只出计划不改代码）',
  '  /connect  连接模型向导：选提供方 → 确认 baseUrl → 输入 Key → 选模型',
  '  /context  显示上下文 token 估算',
  '  /session  显示会话 id',
  '  /queue    查看运行中排队的指令；运行时普通输入会作为 steering 插入',
  '  /queue-remove <id>  移除尚未执行的队列项',
  '  /followup <指令>  当前任务完成后执行',
  '  /help     显示帮助',
  '  /exit     退出',
  '',
  '快捷键',
  '  Shift+Tab 循环权限模式（计划模式下则退出计划模式）',
  '  ↑/↓       在命令面板中选择',
  '  Tab       补全命令',
  '  ←/→       移动光标',
  '  Ctrl+A/E  行首 / 行尾',
  '  Ctrl+C    取消当前任务；空闲时再按一次退出',
  '  审批时    y 批准 / n 或 Esc 拒绝；完整预览用 ↑/↓ 翻页并看完后才能批准',
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
  const [approvalPreviewPage, setApprovalPreviewPage] = useState(0);
  const [highestReviewedPreviewPage, setHighestReviewedPreviewPage] = useState(0);
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [queuedInputs, setQueuedInputs] = useState<Array<{ id: string; mode: 'steer' | 'followup'; text: string }>>([]);
  const [modelName, setModelName] = useState(agent.modelName);
  const [mode, setMode] = useState(agent.permissionMode);
  const [planMode, setPlanMode] = useState(agent.isPlanMode);
  const [wizard, setWizard] = useState<WizardStep | null>(null);
  /** `/key` 不带参数时进入的隐藏输入态：输入内容以 • 显示，回车提交、Esc 取消 */
  const [keyEntry, setKeyEntry] = useState(false);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [width, setWidth] = useState(stdout?.columns ?? 80);
  const [height, setHeight] = useState(stdout?.rows ?? 24);

  const counter = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const streamingRef = useRef('');
  const workspace = runtime.settings.workspaceRoots[0] ?? process.cwd();

  /* ---------------- 终端尺寸 / 动画 ---------------- */

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setWidth(stdout.columns ?? 80);
      setHeight(stdout.rows ?? 24);
    };
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
    // id 必须在调用时就取定：setLines 的更新函数是在渲染阶段才执行的，
    // 若在更新函数内部读 counter.current，同一 tick 里的多次 push（比如
    // 启动时连续 push banner/notice）会读到同一个值，导致 React key 重复。
    const id = counter.current;
    setLines((prev) => [...prev, { id, kind, text, ...extra }]);
  }, []);

  useEffect(() => {
    const offEvent = agent.events.on((event: AgentEvent) => {
      switch (event.type) {
        case 'model:response':
          setModelName(event.modelName);
          if (event.fallbackReason) push('notice', `模型已回退到 ${event.modelName} (${event.modelId})：${event.fallbackReason}`);
          break;
        case 'advisor:review':
          if (event.verdict === 'warn' || event.verdict === 'block') {
            push(event.verdict === 'block' ? 'error' : 'notice', `Advisor ${event.verdict} (${event.stage}): ${event.reason}`);
          }
          break;
        case 'worker:state':
          if (event.parentSessionId === agent.sessionId) {
            push('notice', `Worker ${event.workerId} [${event.status}] ${event.name}: ${event.progress}`);
          }
          break;
        case 'worker:progress':
          if (event.parentSessionId === agent.sessionId) {
            const usage = event.usage ? ` · ${event.usage.totalTokens} tokens / ${event.usage.toolCalls} 工具` : '';
            push('notice', `Worker ${event.workerId}: ${event.progress}${usage}`);
          }
          break;
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
        case 'input:queue':
          setQueuedInputs(event.items);
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
      setApprovalPreviewPage(0);
      setHighestReviewedPreviewPage(0);
      setApproval(request);
    });

    push('banner', `v${VERSION}`);
    push('notice', '输入消息开始，或输入 / 查看命令');
    // 没有 Key 时直接给动作入口：只说"未配置"用户还得猜怎么配
    if (!runtime.config.model.apiKey) {
      push(
        'notice',
        `未检测到 API Key：输入 /connect 走向导，或 /key <API Key> 直接填写；` +
          `也可以在 shell 里 export ${currentApiKeyEnv(runtime)}=...`,
      );
    }

    return () => {
      offEvent();
      offApproval();
    };
  }, [agent, bridge, push, runtime]);

  /* ---------------- 模型切换 ---------------- */

  const switchModel = useCallback(
    (name: string) => {
      try {
        const result = applyModelSwitch(runtime, name);
        setModelName(result.model);
        push('notice', `已切换模型: ${result.model} @ ${result.baseUrl}`);
        push(
          'notice',
          result.saved
            ? `已写入配置文件 ${result.savedPath ?? ''}，下次启动保持该模型`.replace('  ', ' ')
            : '未找到可写的配置文件，本次切换仅在当前会话生效',
        );
        if (!result.keyReady) {
          push(
            'notice',
            `该模型需要 ${result.apiKeyEnv ?? 'API Key'}：输入 /key <API Key> 填一个（换提供方后旧 Key 不沿用）`,
          );
        }
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
        // 与刚写进配置的 apiKeyEnv 对齐：否则本次会话里再执行 /key 会按旧名字落盘
        apiKeyEnv: envName,
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
          (persisted.ok ? `${envName} 已持久化（${persisted.hint}）` : `需手动设置：${persisted.hint}`),
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

  /* ---------------- 权限模式 ---------------- */

  /**
   * Shift+Tab：循环权限模式。
   *
   * 处于计划模式时先退出计划模式，回到进入前的权限；而不是在 readonly 上继续叠一层——
   * 否则用户按一下看到 readonly→standard 变化、再按又回到 readonly，容易误判"没生效"。
   */
  const cyclePermissionMode = useCallback(() => {
    if (agent.isPlanMode) {
      agent.setPlanMode(false);
    } else {
      agent.setPermissionMode(nextPermissionMode(agent.permissionMode));
    }
    setPlanMode(agent.isPlanMode);
    setMode(agent.permissionMode);
  }, [agent]);

  /* ---------------- API Key 更新 ---------------- */

  /**
   * 落盘 Key 并立刻验一次连通性。
   * `/key <sk-...>` 与 `/key`（隐藏输入）共用这一条路径，避免两处行为分叉。
   */
  const applyKey = useCallback(
    (raw: string) => {
      const key = raw.trim();
      if (!key) {
        push('notice', 'API Key 不能为空，已取消');
        return;
      }
      try {
        const result = applyApiKey(runtime, key);
        push('notice', `API Key 已更新（${result.masked}）`);
        push(
          'notice',
          result.saved
            ? `已保存到 ${result.hint}（变量 ${result.envName}），重开会话自动读取`
            : `未能自动保存：${result.hint}`,
        );
        if (!result.configSaved) {
          push('notice', '配置文件写入失败：重启后模型与 baseUrl 可能回到默认值，请检查 ~/.forgex 是否可写');
        }
        // 顺手验一次：Key 打错时当场知道，比等到第一次对话报 401 好
        setConnecting(true);
        void testConnectivity({
          baseUrl: runtime.config.model.baseUrl,
          apiKey: key,
          model: runtime.config.model.model,
        })
          .then((probe) => {
            push(
              probe.ok ? 'notice' : 'error',
              probe.ok
                ? `连通性正常（${probe.latencyMs}ms）`
                : `连通性测试失败：${probe.reason}${probe.detail ? `（${probe.detail}）` : ''}`,
            );
          })
          .finally(() => setConnecting(false));
      } catch (err) {
        push('error', `更新 API Key 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [push, runtime],
  );

  /* ---------------- 斜杠命令 ---------------- */

  const handleSlash = useCallback(
    (text: string) => {
      const [name = '', ...rest] = text.split(/\s+/);
      const arg = rest.join(' ').trim();

      if (isWorkerHubCommand(text)) {
        void dispatchWorkerHubCommand(runtime, text).then((message) => {
          push('notice', message);
        }).catch((err: unknown) => {
          push('error', `Agent Hub 命令失败：${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      if (isMemoryCommand(text)) {
        void dispatchMemoryCommand(runtime, text).then((message) => {
          push('notice', message);
        }).catch((err: unknown) => {
          push('error', `Memory 命令失败：${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }

      switch (name) {
        case '/exit':
        case '/quit':
          exit();
          return;
        case '/help':
          push('notice', [...HELP.split('\n'), ...agent.listExtensionCommands().map((command) => `  /${command.name}  ${command.description}`)].join('\n'));
          return;
        case '/session':
          push('notice', `会话 id: ${agent.sessionId}`);
          return;
        case '/queue': {
          const items = agent.listQueuedInputs();
          push('notice', items.length === 0
            ? '排队队列为空'
            : items.map((item, index) => `${index + 1}. [${item.mode}] ${item.id}: ${item.text}`).join('\n'));
          return;
        }
        case '/queue-remove': {
          if (!arg) {
            push('error', '用法：/queue-remove <队列项 id>（先用 /queue 查看）');
            return;
          }
          const removed = agent.removeQueuedInput(arg);
          push(removed ? 'notice' : 'error', removed ? `已移除队列项 ${arg}` : `没有找到可移除的队列项 ${arg}`);
          return;
        }
        case '/followup': {
          if (!arg) {
            push('error', '用法：/followup <当前任务完成后执行的指令>');
            return;
          }
          if (!busy) {
            push('notice', '当前没有运行中的任务；请直接发送该指令');
            return;
          }
          const queued = agent.enqueueInput(arg, 'followup');
          push('notice', `已排队 follow-up：${queued.id}`);
          return;
        }
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
        case '/mode': {
          if (busy) {
            push('notice', '当前任务运行中，结束或 Ctrl+C 取消后再切换权限模式');
            return;
          }
          // 不带参数：打印模式清单与当前值
          if (!arg) {
            push('notice', permissionModeHelp(agent.permissionMode, agent.isPlanMode));
            return;
          }
          const target = arg.toLowerCase();
          // /mode plan 与 /mode agent 是"计划模式"的显式说法，和 /plan 等价但语义更直观
          if (target === 'plan' || target === 'agent') {
            const wantPlan = target === 'plan';
            if (wantPlan === agent.isPlanMode) {
              push('notice', wantPlan ? '已处于计划模式' : `当前已是执行模式（${agent.permissionMode}）`);
              return;
            }
            agent.setPlanMode(wantPlan);
            setPlanMode(agent.isPlanMode);
            setMode(agent.permissionMode);
            return;
          }
          const parsedMode = parsePermissionMode(arg);
          if (!parsedMode) {
            push('error', `未知权限模式: ${arg}（可选：${permissionModeList()}，或 plan / agent）`);
            return;
          }
          agent.setPermissionMode(parsedMode);
          setPlanMode(agent.isPlanMode);
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
            const [operation, roleOrId, modelId] = arg.split(/\s+/);
            if (operation === 'role') {
              if (!roleOrId) {
                push('error', '用法: /models role <角色> [model-id]');
                return;
              }
              try {
                const result = switchModelRole(runtime, roleOrId, modelId);
                setModelName(result.model);
                push('notice', `已切换 ${result.role} 角色: ${result.modelId} (${result.model})${result.saved ? '（配置已保存）' : '（本次会话生效，配置未保存）'}`);
              } catch (err) {
                push('error', `切换模型角色失败: ${err instanceof Error ? err.message : String(err)}`);
              }
              return;
            }
            if (operation === 'check') {
              if (!roleOrId) {
                push('error', '用法: /models check <model-id>');
                return;
              }
              void checkModelConnectivity(runtime, roleOrId).then((result) => {
                push(result.ok ? 'notice' : 'error', `${roleOrId}: ${result.reason}${result.detail ? `（${result.detail}）` : ''}${result.latencyMs !== undefined ? ` ${result.latencyMs}ms` : ''}`);
              }).catch((err: unknown) => push('error', `模型检查失败: ${err instanceof Error ? err.message : String(err)}`));
              return;
            }
            switchModel(arg);
            return;
          }
          if (runtime.config.models.some((model) => model.id !== 'legacy-default')) {
            push('notice', formatConfiguredModels(runtime));
            return;
          }
          setWizard({ step: 'pickModel' });
          return;
        }
        case '/key': {
          if (busy) {
            push('notice', '当前任务运行中，无法更新 API Key');
            return;
          }
          const envName = currentApiKeyEnv(runtime);
          if (!arg) {
            // 不带参数不再只是打印用法：直接进入隐藏输入态，避免 Key 明文留在屏幕/历史里
            setKeyEntry(true);
            push(
              'notice',
              [
                `API Key 状态：${runtime.config.model.apiKey ? '已配置' : '未配置'}（环境变量 ${envName}）`,
                '请输入 API Key（输入内容以 • 显示），回车确认，Esc 取消',
                '也可以直接 /key <API Key>，或 /connect 走完整向导',
              ].join('\n'),
            );
            return;
          }
          applyKey(arg);
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
          if (name.startsWith('/')) {
            void agent.executeExtensionCommand(name.slice(1), arg).then((handled) => {
              if (!handled) push('error', `未知命令: ${name}（输入 /help 查看）`);
            }).catch((err: unknown) => push('error', `扩展命令失败：${err instanceof Error ? err.message : String(err)}`));
          } else {
            push('error', `未知命令: ${name}（输入 /help 查看）`);
          }
      }
    },
    [agent, applyKey, busy, exit, push, runtime, switchModel],
  );

  const submit = useCallback(() => {
    const text = input.trim();
    if (keyEntry) {
      setInput('');
      setCursor(0);
      setKeyEntry(false);
      applyKey(text);
      return;
    }
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
    if (busy) {
      const queued = agent.enqueueInput(text, 'steer');
      setInput('');
      setCursor(0);
      push('notice', `已排队 steering：${queued.id}（当前工具批次结束后生效）`);
      return;
    }
    if (connecting) return;

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
  }, [advanceWizard, agent, applyKey, busy, connecting, handleSlash, input, keyEntry, push, wizard]);

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

  const availableCommands = [
    ...COMMANDS,
    ...agent.listExtensionCommands().map((command) => ({ name: `/${command.name}`, desc: command.description })),
  ];
  const palette = !wizard && !keyEntry && !busy && !connecting && input.startsWith('/') && !input.includes(' ')
    ? availableCommands.filter((command) => command.name.startsWith(input.toLowerCase()))
    : [];
  const selectedPalette = palette[Math.min(paletteIndex, Math.max(0, palette.length - 1))];
  const approvalPages = useMemo(() => approval
    ? paginateApprovalPreview(approval.preview ?? '', Math.max(2, width - 18), Math.max(1, Math.min(8, height - 12)))
    : [], [approval, height, width]);
  const visibleApprovalPage = Math.min(approvalPreviewPage, Math.max(0, approvalPages.length - 1));

  useEffect(() => {
    if (!approval) return;
    setApprovalPreviewPage(0);
    setHighestReviewedPreviewPage(0);
  }, [approval?.id, height, width]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [input]);

  useInput((char, key) => {
    // 审批优先：此时普通输入被屏蔽
    if (approval) {
      if (approval.previewMustBeReviewed && key.downArrow) {
        const nextPage = Math.min(visibleApprovalPage + 1, approvalPages.length - 1);
        setApprovalPreviewPage(nextPage);
        setHighestReviewedPreviewPage((highest) => Math.max(highest, nextPage));
        return;
      }
      if (approval.previewMustBeReviewed && key.upArrow) {
        setApprovalPreviewPage(Math.max(0, visibleApprovalPage - 1));
        return;
      }
      if (char.toLowerCase() === 'y') {
        if (approval.previewMustBeReviewed && highestReviewedPreviewPage < approvalPages.length - 1) {
          push('notice', '完整审批预览尚未逐页查看；请用 ↓ 继续、↑ 返回，然后再批准');
          return;
        }
        setApproval(null);
        bridge.respond(true);
        push('notice', '已批准');
        return;
      }
      if (char.toLowerCase() === 'n' || key.escape) {
        setApproval(null);
        bridge.respond(false);
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

    // `/key` 的隐藏输入态：Enter 提交、Esc 取消，其余按键照常编辑
    if (keyEntry) {
      if (key.return) {
        submit();
        return;
      }
      if (key.escape) {
        setKeyEntry(false);
        setInput('');
        setCursor(0);
        push('notice', '已取消，API Key 保持不变');
        return;
      }
      editInput(char, key);
      return;
    }

    // Shift+Tab 循环权限模式。必须放在命令面板分支之前：
    // 面板打开时普通 Tab 被用来补全命令，Shift+Tab 若排在后面就永远轮不到。
    if (key.tab && key.shift) {
      if (busy || connecting) {
        push('notice', '当前任务运行中，结束或 Ctrl+C 取消后再切换权限模式');
        return;
      }
      cyclePermissionMode();
      return;
    }

    if (connecting) return;

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
      {queuedInputs.length > 0 ? (
        <Box paddingLeft={2}>
          <Text color={THEME.warning}>排队输入 {queuedInputs.length} 条</Text>
          <Text dimColor> · {queuedInputs.map((item) => `${item.mode}: ${item.text}`).join(' | ')}</Text>
        </Box>
      ) : null}

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
        <ApprovalPanel
          approval={approval}
          page={approvalPages[visibleApprovalPage] ?? []}
          pageNumber={visibleApprovalPage + 1}
          pageCount={approvalPages.length}
          fullyReviewed={!approval.previewMustBeReviewed || highestReviewedPreviewPage >= approvalPages.length - 1}
        />
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
                  {keyEntry
                    ? '输入 API Key（已隐藏），回车确认 / Esc 取消'
                    : busy
                      ? '运行中，Ctrl+C 取消'
                      : connecting
                        ? '连接中…'
                        : '输入消息，/ 查看命令'}
                </Text>
              </>
            ) : (
              renderInput(input, cursor, keyEntry)
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
          {/* 空闲时提示 Shift+Tab 可切模式：按钮式 UI 没有的地方，只能靠状态栏自解释 */}
          {busy || connecting ? null : <Text dimColor> ⇧⇥</Text>}
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
          <Text dimColor>会话式 Coding Agent</Text>
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

function ApprovalPanel({
  approval,
  page,
  pageNumber,
  pageCount,
  fullyReviewed,
}: {
  approval: ApprovalRequest;
  page: ReturnType<typeof paginateApprovalPreview>[number];
  pageNumber: number;
  pageCount: number;
  fullyReviewed: boolean;
}): React.ReactElement {
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
        <Box flexDirection="column">
          {approval.previewMustBeReviewed ? <Text color={THEME.warning}>完整预览 {pageNumber}/{pageCount} · {fullyReviewed ? '已逐页查看' : '使用 ↓ 继续、↑ 返回；看完后才可批准'}</Text> : null}
          {page.map((line, index) => (
            <Text key={`${pageNumber}-${index}`} dimColor={!line.continuesPrevious} wrap="wrap">
              {line.continuesPrevious ? '↪ ' : ''}{line.text || ' '}
            </Text>
          ))}
        </Box>
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
