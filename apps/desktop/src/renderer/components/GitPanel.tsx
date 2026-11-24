import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { DesktopApi, GitFileEntry, GitStatusResult } from '../../shared/desktop-api.js';

type DiffMode = 'staged' | 'unstaged';
type FileGroup = DiffMode | 'untracked' | 'conflicted';
type DiffTone = 'add' | 'remove' | 'hunk' | 'plain';

interface Selection {
  path: string;
  mode: DiffMode;
}

interface GitPanelProps {
  projectPath: string | null;
  visible: boolean;
  api: DesktopApi;
}

const GROUPS: { id: FileGroup; label: string; mode: DiffMode }[] = [
  { id: 'staged', label: '已暂存', mode: 'staged' },
  { id: 'unstaged', label: '未暂存', mode: 'unstaged' },
  { id: 'untracked', label: '未跟踪', mode: 'unstaged' },
  { id: 'conflicted', label: '冲突', mode: 'unstaged' },
];

function groupEntries(entries: GitFileEntry[]): Record<FileGroup, GitFileEntry[]> {
  const groups: Record<FileGroup, GitFileEntry[]> = { staged: [], unstaged: [], untracked: [], conflicted: [] };
  for (const entry of entries) {
    if (entry.conflicted) {
      groups.conflicted.push(entry);
    } else if (entry.indexStatus === '?') {
      groups.untracked.push(entry);
    } else {
      if (entry.indexStatus !== ' ') groups.staged.push(entry);
      if (entry.worktreeStatus !== ' ') groups.unstaged.push(entry);
    }
  }
  return groups;
}

function gitError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes('not a git repository')) {
    return '当前项目不是 Git 仓库。';
  }
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function diffTone(line: string, prefixLength: number): DiffTone {
  if (line.startsWith('@@')) return 'hunk';
  const prefix = line.slice(0, prefixLength);
  if (prefix.includes('+')) return 'add';
  if (prefix.includes('-')) return 'remove';
  return 'plain';
}

function DiffText({ text }: { text: string }) {
  const sections = useMemo(() => {
    const groups: { tone: DiffTone; lines: string[] }[] = [];
    let prefixLength = 0;
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (line.startsWith('diff --')) prefixLength = 0;
      const hunk = line.match(/^(@{2,}) /);
      if (hunk) prefixLength = hunk[1].length - 1;
      const tone = diffTone(line, prefixLength);
      const last = groups[groups.length - 1];
      if (last?.tone === tone) {
        last.lines.push(line);
      } else {
        groups.push({ tone, lines: [line] });
      }
    }
    return groups;
  }, [text]);

  return <pre className="git-diff-text" tabIndex={0} aria-label="文件差异"><code>
    {sections.map(({ tone, lines }, index) => <span key={index} className={`git-diff-${tone}`}>{lines.join('')}</span>)}
  </code></pre>;
}

export function GitPanel({ projectPath, visible, api }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [statusError, setStatusError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<{ revision: number; path: string; mode: DiffMode; text?: string; error?: string } | null>(null);
  const [message, setMessage] = useState('');
  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState('');
  const [commitId, setCommitId] = useState('');
  const confirmation = useRef<HTMLDialogElement>(null);
  const wasVisible = useRef(false);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setStatusError('');
    setRevision((current) => current + 1);
  }, []);

  useLayoutEffect(() => {
    const becameVisible = visible && !wasVisible.current;
    wasVisible.current = visible;
    // A running mutation already refreshes status when it settles.
    if (becameVisible && !mutating) refresh();
  }, [visible, mutating, refresh]);

  useEffect(() => {
    if (!projectPath || revision === 0) return;
    let active = true;
    void api.getGitStatus().then((nextStatus) => {
      if (!active) return;
      setStatus(nextStatus);
      setStatusError('');
      setRefreshing(false);
    }, (reason: unknown) => {
      if (!active) return;
      setStatus(null);
      setStatusError(gitError(reason));
      setRefreshing(false);
    });
    return () => {
      active = false;
    };
  }, [api, projectPath, revision]);

  const groups = useMemo(() => groupEntries(status?.entries ?? []), [status]);
  const path = selection?.path;
  const hasStaged = groups.staged.some((entry) => entry.path === path);
  const hasUnstaged = groups.unstaged.some((entry) => entry.path === path)
    || groups.untracked.some((entry) => entry.path === path)
    || groups.conflicted.some((entry) => entry.path === path);
  const mode = selection?.mode === 'staged'
    ? (hasStaged ? 'staged' : 'unstaged')
    : (hasUnstaged ? 'unstaged' : 'staged');
  const selectedPath = hasStaged || hasUnstaged ? path : undefined;

  useEffect(() => {
    if (!projectPath || !selectedPath || refreshing) return;
    let active = true;
    void api.getGitDiff({ path: selectedPath, staged: mode === 'staged' }).then((text) => {
      if (active) setDiff({ revision, path: selectedPath, mode, text });
    }, (reason: unknown) => {
      if (active) setDiff({ revision, path: selectedPath, mode, error: gitError(reason) });
    });
    return () => {
      active = false;
    };
  }, [api, projectPath, selectedPath, mode, revision, refreshing]);

  const currentDiff = !refreshing && diff?.revision === revision && diff.path === selectedPath && diff.mode === mode ? diff : null;
  const controlsLocked = refreshing || mutating;
  const stagedCount = groups.staged.length;
  const canCommit = !controlsLocked && stagedCount > 0 && groups.conflicted.length === 0 && message.trim().length > 0;

  const mutate = async (operation: () => Promise<void>) => {
    setMutating(true);
    setActionError('');
    setCommitId('');
    try {
      await operation();
    } catch (reason) {
      setActionError(gitError(reason));
    } finally {
      refresh();
      setMutating(false);
    }
  };

  const openConfirmation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canCommit) confirmation.current?.showModal();
  };

  const commit = () => {
    confirmation.current?.close();
    if (!canCommit) return;
    void mutate(async () => {
      const result = await api.commitGit({ message: message.trim() });
      setMessage('');
      setCommitId(result.commit);
    });
  };

  if (!projectPath) {
    return <p className="git-feedback">选择本地项目后可使用 Git。</p>;
  }

  return (
    <section className="git-panel" aria-label="Git 工作区">
      <header className="git-header">
        <div className="git-repository">
          {status && <>
            <strong className="git-branch" title={status.branch}>{status.branch === 'HEAD (no branch)' ? '分离的 HEAD' : status.branch}</strong>
            <span className={status.entries.length ? 'git-dirty' : 'git-clean'}>{status.entries.length ? '有改动' : '工作区干净'}</span>
            {(status.ahead > 0 || status.behind > 0) && <span className="git-upstream">领先 {status.ahead}，落后 {status.behind}</span>}
          </>}
        </div>
        {refreshing && <span className="git-progress" role="status">正在读取 Git 状态…</span>}
        {mutating && <span className="git-progress" role="status">正在更新仓库…</span>}
        <button type="button" className="secondary-button" disabled={controlsLocked} onClick={() => {
          setActionError('');
          refresh();
        }}>刷新</button>
      </header>
      {statusError && <p className="git-feedback inline-error" role="alert">{statusError}</p>}
      {actionError && <p className="git-feedback inline-error" role="alert">{actionError}</p>}
      {commitId && <p className="git-feedback git-clean" role="status">已创建提交 <code>{commitId.slice(0, 12)}</code></p>}
      {status && <>
        <div className="git-content">
          <section className="git-files" aria-label="变更文件">
            {groups.conflicted.length > 0 && <p className="git-feedback git-conflict" role="status">请先解决冲突，再提交。</p>}
            {status.entries.length === 0 && <p className="git-feedback">没有变更文件。</p>}
            {GROUPS.map(({ id, label, mode: groupMode }) => {
              const entries = groups[id];
              if (!entries.length) return null;
              return <section className="git-file-group" key={id} aria-labelledby={`git-group-${id}`}>
                <h2 id={`git-group-${id}`}>{label} <span>{entries.length}</span></h2>
                <ul>
                  {entries.map((entry) => {
                    const side = id === 'staged' ? entry.indexStatus : entry.worktreeStatus;
                    const renamed = entry.originalPath !== undefined && (side === 'R' || side === 'C');
                    const displayPath = renamed ? `${entry.originalPath} → ${entry.path}` : entry.path;
                    const code = id === 'conflicted' ? entry.indexStatus + entry.worktreeStatus : side;
                    const action = id === 'staged' ? '取消暂存' : '暂存';
                    const actionPaths = side === 'R' && entry.originalPath !== undefined
                      ? [entry.originalPath, entry.path]
                      : [entry.path];
                    return <li className="git-file" key={entry.path}>
                      <button type="button" className="git-file-select" aria-pressed={selectedPath === entry.path && mode === groupMode} title={displayPath}
                        onClick={() => setSelection({ path: entry.path, mode: groupMode })}>
                        <span className={id === 'conflicted' ? 'git-code git-conflict' : 'git-code'}>{code}</span>
                        <span className="git-file-path">{displayPath}</span>
                      </button>
                      {id !== 'conflicted' && <button type="button" className="secondary-button git-file-action" disabled={controlsLocked}
                        aria-label={`${action} ${displayPath}`} onClick={() => void mutate(() => id === 'staged'
                          ? api.unstageGitFiles(actionPaths)
                          : api.stageGitFiles(actionPaths))}>{action}</button>}
                    </li>;
                  })}
                </ul>
              </section>;
            })}
          </section>
          <section className="git-diff" aria-label="差异详情">
            {selectedPath ? <>
              <div className="git-diff-header">
                <code className="git-selected-path" tabIndex={0}>{selectedPath}</code>
                <div className="git-diff-switch" role="group" aria-label="差异来源">
                  <button type="button" aria-pressed={mode === 'staged'} disabled={!hasStaged} onClick={() => setSelection({ path: selectedPath, mode: 'staged' })}>已暂存</button>
                  <button type="button" aria-pressed={mode === 'unstaged'} disabled={!hasUnstaged} onClick={() => setSelection({ path: selectedPath, mode: 'unstaged' })}>未暂存</button>
                </div>
              </div>
              {currentDiff?.error ? <p className="git-feedback inline-error" role="alert">{currentDiff.error}</p>
                : !currentDiff ? <p className="git-feedback" role="status">正在读取差异…</p>
                  : currentDiff.text ? <DiffText text={currentDiff.text} />
                    : <p className="git-feedback">没有可显示的差异。</p>}
            </> : <p className="git-feedback">{status.entries.length ? '选择文件查看差异。' : '没有可查看的差异。'}</p>}
          </section>
        </div>
        <form className="git-commit" onSubmit={openConfirmation}>
          <label htmlFor="git-commit-message">提交说明 <span>（{stagedCount} 个已暂存文件）</span></label>
          <div className="git-commit-input">
            <textarea id="git-commit-message" rows={2} maxLength={4096} value={message} disabled={mutating} onChange={(event) => setMessage(event.target.value)} />
            <button className="send-button" type="submit" disabled={!canCommit}>提交…</button>
          </div>
        </form>
        <dialog ref={confirmation} className="git-confirmation" aria-labelledby="git-confirmation-title" aria-describedby="git-confirmation-description">
          <h2 id="git-confirmation-title">提交 {stagedCount} 个已暂存文件？</h2>
          <div id="git-confirmation-description">
            <p>ForgeX 将跳过仓库的 Git 钩子。本次提交只包含已暂存的内容。</p>
            <pre>{message.trim()}</pre>
          </div>
          <div className="setup-actions">
            <button type="button" className="secondary-button" onClick={() => confirmation.current?.close()}>取消</button>
            <button type="button" className="send-button" disabled={!canCommit} onClick={commit}>确认提交</button>
          </div>
        </dialog>
      </>}
    </section>
  );
}
