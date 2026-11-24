import { useState } from 'react';
import type { SessionSummary } from '../../shared/desktop-api.js';

export function SessionList(props: {
  sessions: SessionSummary[];
  activeId: string | null;
  busy: boolean;
  opening?: boolean;
  onOpen(session: SessionSummary): void;
  onRename(session: SessionSummary, title: string): Promise<void>;
  onDelete(session: SessionSummary): Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const beginRename = (session: SessionSummary) => {
    setDeletingId(null);
    setEditingId(session.id);
    setTitle(session.title || session.model || '新会话');
  };

  const saveRename = async (session: SessionSummary) => {
    const nextTitle = title.trim();
    if (!nextTitle || pendingId) return;
    setPendingId(session.id);
    try {
      await props.onRename(session, nextTitle);
      setEditingId(null);
    } finally {
      setPendingId(null);
    }
  };

  const confirmDelete = async (session: SessionSummary) => {
    if (pendingId) return;
    setPendingId(session.id);
    try {
      await props.onDelete(session);
      setDeletingId(null);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section className="sidebar-section session-section">
      <div className="section-heading">会话</div>
      {props.sessions.length === 0
        ? <div className="sidebar-empty">当前项目还没有会话</div>
        : props.sessions.map((session) => {
          const isActive = props.activeId === session.id;
          const isEditing = editingId === session.id;
          const isDeleting = deletingId === session.id;
          const isPending = pendingId === session.id;
          const cannotDelete = props.busy && isActive;

          return (
            <div key={session.id} className={`session-row ${isActive ? 'selected' : ''}`}>
              {isEditing ? (
                <form className="session-rename-form" onSubmit={(event) => { event.preventDefault(); void saveRename(session); }}>
                  <input
                    autoFocus
                    maxLength={120}
                    value={title}
                    aria-label="会话名称"
                    onChange={(event) => setTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditingId(null);
                    }}
                  />
                  <button type="submit" title="保存名称" disabled={!title.trim() || isPending}>保存</button>
                  <button type="button" title="取消重命名" onClick={() => setEditingId(null)}>取消</button>
                </form>
              ) : isDeleting ? (
                <div className="session-delete-confirm" role="group" aria-label="确认删除会话">
                  <span>删除此会话？</span>
                  <button type="button" className="danger-action" onClick={() => void confirmDelete(session)} disabled={isPending || cannotDelete}>
                    {isPending ? '删除中…' : '删除'}
                  </button>
                  <button type="button" onClick={() => setDeletingId(null)}>取消</button>
                </div>
              ) : (
                <>
                  <button className="session-open" disabled={props.opening} onClick={() => props.onOpen(session)} title={session.id}>
                    <span className="session-icon">◇</span>
                    <span className="list-row-label">{session.title || session.model || '新会话'}</span>
                  </button>
                  <div className="session-actions">
                    <button type="button" title="重命名会话" aria-label={`重命名 ${session.title || '会话'}`} disabled={props.opening} onClick={() => beginRename(session)}>✎</button>
                    <button type="button" title={cannotDelete ? '任务运行期间不能删除当前会话' : '删除会话'} aria-label={`删除 ${session.title || '会话'}`} disabled={props.opening || cannotDelete} onClick={() => { setEditingId(null); setDeletingId(session.id); }}>⌫</button>
                  </div>
                </>
              )}
            </div>
          );
        })}
    </section>
  );
}
