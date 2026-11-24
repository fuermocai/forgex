import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopAppState, DesktopApprovalRequest, DesktopEvent, DesktopMessage, ProjectSelection, SessionSummary } from '../shared/desktop-api.js';
import { ProjectPicker } from './components/ProjectPicker.js';
import { SessionList } from './components/SessionList.js';
import { SetupScreen } from './components/SetupScreen.js';
import { ChatView, type ToolActivity } from './components/ChatView.js';
import { GitPanel } from './components/GitPanel.js';
import { SshHostPanel } from './components/SshHostPanel.js';
import { ApprovalDialog } from './components/ApprovalDialog.js';
import { AppearancePicker } from './components/AppearancePicker.js';
import { applyTheme, readSavedTheme, saveTheme, type ThemeId } from './theme.js';

interface ChatMessage extends DesktopMessage {
  id: string;
}

interface PendingNavigation {
  project: ProjectSelection;
  sessionId?: string;
}

export default function App() {
  const [state, setState] = useState<DesktopAppState | null>(null);
  const [recentProjects, setRecentProjects] = useState<ProjectSelection[]>([]);
  const [project, setProject] = useState<ProjectSelection | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [approvalQueue, setApprovalQueue] = useState<DesktopApprovalRequest[]>([]);
  const approval = approvalQueue[0] ?? null;
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showSshHosts, setShowSshHosts] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<'chat' | 'git'>('chat');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [themeId, setThemeId] = useState<ThemeId>(() => readSavedTheme());
  const busyRef = useRef(false);
  const navigationLockRef = useRef(false);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);

  const selectTheme = (nextTheme: ThemeId) => {
    setThemeId(nextTheme);
    applyTheme(nextTheme);
    saveTheme(nextTheme);
  };

  const refreshState = useCallback(async () => {
    const [nextState, projects] = await Promise.all([window.forgex.getAppState(), window.forgex.getRecentProjects()]);
    setState(nextState);
    setRecentProjects(projects);
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!project) return;
    setSessions(await window.forgex.listSessions());
  }, [project]);

  useEffect(() => {
    void refreshState().catch((reason: unknown) => setError(messageOf(reason)));
    return window.forgex.onEvent((event) => handleEvent(event));
  }, [refreshState]);

  useEffect(() => {
    if (project) void refreshSessions().catch((reason: unknown) => setError(messageOf(reason)));
  }, [project, refreshSessions]);

  const handleEvent = (event: DesktopEvent) => {
    switch (event.type) {
      case 'assistant:delta':
        setStreamingText((text) => text + event.text);
        break;
      case 'assistant:message':
        if (event.text.trim()) {
          setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: event.text }]);
        }
        setStreamingText('');
        break;
      case 'tool:start':
        setTools((current) => [...current.filter((tool) => tool.callId !== event.callId), { callId: event.callId, name: event.name, status: 'running' }]);
        break;
      case 'tool:end':
        setTools((current) => current.map((tool) => tool.callId === event.callId
          ? { ...tool, status: event.ok ? 'done' : 'failed', detail: event.error ?? event.summary }
          : tool));
        break;
      case 'approval:request':
        setApprovalQueue((current) => current.some((item) => item.id === event.request.id) ? current : [...current, event.request]);
        break;
      case 'approval:resolved':
        setApprovalQueue((current) => current.filter((item) => item.id !== event.id));
        break;
      case 'notice':
        if (event.level === 'error') setError(event.message);
        else setNotice(event.message);
        break;
      case 'turn:end':
        busyRef.current = false;
        setBusy(false);
        setTools((current) => current.filter((tool) => tool.status === 'running'));
        if (event.reason !== 'completed') setNotice(`本轮结束：${event.reason}`);
        break;
      case 'metrics':
        setNotice(`本轮 ${event.totalTokens} tokens · ${Math.round(event.totalMs)} ms · ${event.toolCalls} 个工具调用`);
        break;
      default:
        break;
    }
  };

  const openProject = async (selected: ProjectSelection, sessionId?: string) => {
    if (navigationLockRef.current) return;
    navigationLockRef.current = true;
    setStarting(true);
    setError('');
    try {
      const opened = await window.forgex.startSession({ projectPath: selected.path, ...(sessionId ? { sessionId } : {}) });
      setProject(selected);
      setSession(opened);
      setMessages((await window.forgex.getSessionMessages(opened.id)).map((message, index) => ({ ...message, id: `${opened.id}:${index}` })));
      setStreamingText('');
      setSessions(await window.forgex.listSessions());
      setShowSetup(false);
      await refreshState();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      navigationLockRef.current = false;
      setStarting(false);
    }
  };

  const requestOpenProject = (selected: ProjectSelection, sessionId?: string) => {
    if (navigationLockRef.current) return;
    if (busyRef.current) {
      setPendingNavigation({ project: selected, ...(sessionId ? { sessionId } : {}) });
      return;
    }
    void openProject(selected, sessionId);
  };

  const confirmNavigation = () => {
    const pending = pendingNavigation;
    if (!pending) return;
    setPendingNavigation(null);
    void window.forgex.cancelTurn();
    void openProject(pending.project, pending.sessionId);
  };

  const chooseProject = async () => {
    setError('');
    try {
      const selected = await window.forgex.selectProject();
      if (selected) requestOpenProject(selected);
    } catch (reason) {
      setError(messageOf(reason));
    }
  };

  const sendMessage = async (text: string) => {
    const content = text.trim();
    if (!content || busyRef.current || !session) return;
    setError('');
    busyRef.current = true;
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content }]);
    setBusy(true);
    try {
      await window.forgex.sendMessage(content);
    } catch (reason) {
      busyRef.current = false;
      setBusy(false);
      setError(messageOf(reason));
    }
  };

  const resolveApproval = async (decision: 'approve' | 'reject') => {
    if (!approval) return;
    try {
      await window.forgex.resolveApproval({ approvalId: approval.id, decision });
      setApprovalQueue((current) => current.filter((item) => item.id !== approval.id));
    } catch (reason) {
      setError(messageOf(reason));
    }
  };

  const renameSession = async (item: SessionSummary, title: string) => {
    setError('');
    try {
      await window.forgex.renameSession({ sessionId: item.id, title });
      await refreshSessions();
      setSession((current) => current?.id === item.id ? { ...current, title } : current);
      setNotice('会话名称已更新');
    } catch (reason) {
      setError(messageOf(reason));
    }
  };

  const deleteSession = async (item: SessionSummary) => {
    setError('');
    try {
      await window.forgex.deleteSession(item.id);
      const remaining = await window.forgex.listSessions();
      setSessions(remaining);
      if (session?.id === item.id) {
        setSession(null);
        setMessages([]);
        setStreamingText('');
        setTools([]);
        const nextSession = remaining[0];
        if (project && nextSession) await openProject(project, nextSession.id);
      }
      setNotice('会话已删除');
    } catch (reason) {
      setError(messageOf(reason));
    }
  };

  const onModelConnected = async () => {
    await refreshState();
    setShowSetup(false);
    if (project) {
      await refreshSessions();
      if (session) setMessages((await window.forgex.getSessionMessages(session.id)).map((message, index) => ({ ...message, id: `${session.id}:${index}` })));
    }
    setNotice('模型已连接');
  };

  const setupVisible = showSetup || state?.modelConfigured === false;
  const gitVisible = workspaceView === 'git' && project !== null;
  const mainContent = setupVisible
    ? <SetupScreen state={state} onConnected={() => void onModelConnected()} onCancel={() => setShowSetup(false)} />
    : session
      ? <ChatView key={session.id} messages={messages} streamingText={streamingText} tools={tools} busy={busy} error={error} notice={notice} onSend={(text) => void sendMessage(text)} onCancel={() => void window.forgex.cancelTurn()} />
      : <section className="empty-state">
          <h1>{project ? '开始新的项目会话' : '从一个项目开始'}</h1>
          <p>{project ? '此项目没有其他会话，可以新建一个干净的会话继续工作。' : '选取本机项目文件夹，ForgeX 会在现有权限和沙箱设置下协助你工作。'}</p>
          <button className="project-button" onClick={() => project ? requestOpenProject(project) : void chooseProject()} disabled={starting}>{starting ? '正在打开…' : project ? '新建会话' : '选择项目文件夹'}</button>
          {error && <div className="inline-error">{error}</div>}
        </section>;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">F</div>
          <strong>ForgeX</strong>
        </div>
        <div className="project-title" title={project?.path}>
          <span className="project-context-label">当前项目</span>
          <strong>{project?.name ?? '未选择项目'}</strong>
          {project && <span className="project-path">{project.path}</span>}
        </div>
        <div className="topbar-actions">
          <AppearancePicker themeId={themeId} onSelect={selectTheme} />
          <button className="settings-button" type="button" aria-haspopup="dialog" onClick={() => setShowSshHosts(true)}>SSH 主机</button>
          <button className="settings-button" onClick={() => {
            setWorkspaceView('chat');
            setShowSetup(true);
          }} title="模型设置">模型设置</button>
          <span className="version">{state ? `v${state.version}` : ''}</span>
        </div>
      </header>
      <div className="workspace-layout">
        <aside className="sidebar">
          <button className="new-project-button" onClick={() => project ? requestOpenProject(project) : void chooseProject()} disabled={starting}>
            <span className="new-session-mark" aria-hidden="true">+</span>新建会话
          </button>
          <ProjectPicker projects={recentProjects} activePath={project?.path ?? null} disabled={starting} onOpen={(item) => requestOpenProject(item)} />
          {project && <SessionList
            sessions={sessions}
            activeId={session?.id ?? null}
            busy={busy}
            opening={starting}
            onOpen={(item) => requestOpenProject({ path: project.path, name: project.name }, item.id)}
            onRename={renameSession}
            onDelete={deleteSession}
          />}
          <div className="sidebar-footer">
            <span className={`status-dot ${state?.modelConfigured ? 'ready' : ''}`} />
            <span>{state?.modelConfigured ? '模型已连接' : '未连接模型'}</span>
            <span className="mode-label">{state?.permissionMode ?? 'standard'}</span>
          </div>
        </aside>
        <section className="main-panel">
          <div className="workspace-switch" role="group" aria-label="工作区视图">
            <button type="button" aria-pressed={!gitVisible} onClick={() => setWorkspaceView('chat')}>对话</button>
            <button type="button" aria-pressed={gitVisible} onClick={() => setWorkspaceView('git')} disabled={!project || starting}>Git</button>
            {!project && <span>选择本地项目后可使用 Git</span>}
          </div>
          <div className="workspace-view" hidden={gitVisible}>{mainContent}</div>
          {project && !starting && <div className="workspace-view" hidden={!gitVisible}>
            <GitPanel key={project.path} projectPath={project.path} visible={gitVisible} api={window.forgex} />
          </div>}
          {gitVisible && starting && <p className="git-feedback" role="status">正在打开项目…</p>}
        </section>
      </div>
      {showSshHosts && <SshHostPanel api={window.forgex} onClose={() => setShowSshHosts(false)} />}
      {approval && <ApprovalDialog key={approval.id} request={approval} queueLength={approvalQueue.length} onResolve={(decision) => void resolveApproval(decision)} />}
      {pendingNavigation && <div className="modal-backdrop navigation-backdrop">
        <section className="navigation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="navigation-title">
          <div className="dialog-context">{busy ? '任务仍在运行' : '切换目标'}</div>
          <h2 id="navigation-title">{busy ? '切换后会取消当前任务' : '要切换到此目标吗？'}</h2>
          <p>目标：{pendingNavigation.sessionId ? '打开另一个会话' : pendingNavigation.project.name}</p>
          <div className="setup-actions">
            <button className="secondary-button" onClick={() => setPendingNavigation(null)}>取消切换</button>
            <button className="cancel-button" onClick={confirmNavigation}>{busy ? '取消任务并切换' : '切换'}</button>
          </div>
        </section>
      </div>}
    </main>
  );
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
