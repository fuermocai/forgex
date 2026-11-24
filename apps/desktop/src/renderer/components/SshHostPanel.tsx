import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, FormEvent, Ref, SetStateAction } from 'react';
import type {
  DesktopApi, RemoteDiagActionDto, SshDiagnosticResult, SshHostOperation, SshHostProfile,
} from '../../shared/desktop-api.js';

interface SshHostPanelProps {
  api: Pick<DesktopApi, 'listSshHosts' | 'saveSshHost' | 'deleteSshHost' | 'probeSshHost' | 'trustSshHostKey'
    | 'testSshHost' | 'runSshDiagnostic' | 'cancelSshOperation'>;
  suspended: boolean;
  mismatches: ReadonlySet<string>;
  setMismatches: Dispatch<SetStateAction<ReadonlySet<string>>>;
  onClose: () => void;
}

interface HostEditor {
  id?: string;
  name: string;
  host: string;
  port: string;
  username: string;
  privateKeyPath: string;
}

interface PendingOperation {
  label: string;
  operationId?: string;
}

interface FingerprintReview {
  fingerprint: string;
  previous: string | null;
}

const EMPTY_EDITOR: HostEditor = { name: '', host: '', port: '22', username: '', privateKeyPath: '' };
const DIAGNOSTIC_LABELS: Record<RemoteDiagActionDto['action'], string> = {
  system_info: '系统信息', top_processes: '进程排行', port_list: '监听端口', disk_usage: '磁盘用量',
  memory_usage: '内存用量', journalctl: '系统日志', systemctl_status: '服务状态',
  read_remote_log: '读取日志文件', list_dir: '列出目录', stat_file: '查看文件属性', uptime: '运行时间',
  kernel_modules: '内核模块',
};
const GENERAL_DIAGNOSTICS: readonly RemoteDiagActionDto[] = [
  { action: 'system_info' }, { action: 'uptime' }, { action: 'top_processes' }, { action: 'port_list' },
  { action: 'disk_usage' }, { action: 'memory_usage' }, { action: 'journalctl' }, { action: 'kernel_modules' },
];
const PATH_DIAGNOSTICS = ['read_remote_log', 'list_dir', 'stat_file'] as const;
const FINGERPRINT_MISMATCH = '主机指纹不匹配，连接已阻止';
type HostAction = 'add' | 'edit' | 'delete' | 'test';

function sshError(reason: unknown): string {
  return reason instanceof Error
    ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : 'SSH 操作失败，请重试。';
}

function hostAddress(profile: SshHostProfile): string {
  const hostname = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
  return `${profile.username}@${hostname}:${profile.port}`;
}

function trustIdentity(profile: SshHostProfile): string {
  return JSON.stringify([profile.id, profile.host, profile.port, profile.username, profile.hostKeyFingerprint]);
}

interface DiagnosticTable {
  headers: string[];
  rows: string[][];
}

function diagnosticTable(action: SshDiagnosticResult['action'], output: string): DiagnosticTable | null {
  const [header = '', ...lines] = output.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (action === 'disk_usage') {
    const columns = /^Filesystem\s+(Type\s+)?Size\s+Used\s+Avail\s+(?:Use%|Capacity)\s+Mounted on$/i.exec(header);
    if (!columns) return null;
    const rowPattern = columns[1]
      ? /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+%|-)\s+(.+)$/
      : /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+%|-)\s+(.+)$/;
    const rows: string[][] = [];
    for (const line of lines) {
      const match = rowPattern.exec(line);
      if (!match) return null;
      rows.push(match.slice(1));
    }
    return { headers: ['文件系统', ...(columns[1] ? ['类型'] : []), '容量', '已用', '可用', '使用率', '挂载点'], rows };
  }
  if (action === 'kernel_modules' && /^Module\s+Size\s+Used by$/i.test(header)) {
    const rows: string[][] = [];
    for (const line of lines) {
      const match = /^(\S+)\s+(\d+)\s+(\d+)(?:\s+(.+))?$/.exec(line);
      if (!match) return null;
      rows.push([match[1], match[2], match[3], match[4] ?? '']);
    }
    return { headers: ['模块', '大小', '引用数', '引用模块'], rows };
  }
  return null;
}

function uptimeValues(output: string): { label: string; value: string }[] | null {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length > 3 || (lines.length > 1 && lines[1] !== '---')) return null;
  const summary = /^(.+?)\s+up\s+(.+?),\s+(\d+\s+users?),\s+load averages?:\s*(.+)$/.exec(lines[0] ?? '');
  if (!summary) return null;
  const values = [
    { label: '主机时间', value: summary[1] }, { label: '已运行', value: summary[2] },
    { label: '登录用户', value: summary[3] }, { label: '平均负载', value: summary[4] },
  ];
  if (lines[2]) values.push({ label: '启动时间', value: lines[2].replace(/^system boot\s+/, '') });
  return values;
}

function DiagnosticOutput({ result }: { result: SshDiagnosticResult }) {
  const output = result.stdout.trimEnd();
  const table = result.truncated ? null : diagnosticTable(result.action, output);
  const values = result.action === 'uptime' && !result.truncated ? uptimeValues(output) : null;
  if (table) return <div className="ssh-result-scroll" tabIndex={0} aria-label="诊断数据">
    <table className="ssh-result-table" aria-label={DIAGNOSTIC_LABELS[result.action]}>
      <thead><tr>{table.headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
      <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>
        {row.map((cell, columnIndex) => <td key={table.headers[columnIndex]}>{cell}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
  if (values) return <dl className="ssh-result-summary" aria-label="运行时间和负载">
    {values.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
  if (output) return <pre className="ssh-result-output" tabIndex={0} aria-label="诊断输出">{output}</pre>;
  if (result.stderr) return <pre className="ssh-result-output" tabIndex={0} aria-label="标准错误">{result.stderr}</pre>;
  return <p>本次诊断没有输出。</p>;
}

function DiagnosticResult({ result, titleRef }: { result: SshDiagnosticResult; titleRef: Ref<HTMLHeadingElement> }) {
  const outcome = result.timedOut ? '已超时' : result.exitCode === 0 ? '已完成' : '执行失败';
  return <section className="ssh-result" aria-labelledby="ssh-result-title">
    <h3 id="ssh-result-title" ref={titleRef} tabIndex={-1}>{DIAGNOSTIC_LABELS[result.action]}</h3>
    <dl className="ssh-result-summary" role="status">
      <div><dt>结果</dt><dd className={result.exitCode === 0 && !result.timedOut ? 'ssh-success' : 'ssh-warning'}>{outcome}</dd></div>
      <div><dt>耗时</dt><dd>{result.durationMs} ms</dd></div>
      <div><dt>退出码</dt><dd>{result.exitCode ?? '无'}</dd></div>
      <div><dt>输出</dt><dd>{result.truncated ? '已截断' : '完整'}</dd></div>
    </dl>
    <DiagnosticOutput result={result} />
    <details>
      <summary>原始输出</summary>
      {result.stdout && <pre tabIndex={0} aria-label="标准输出">{result.stdout}</pre>}
      {result.stderr && <pre tabIndex={0} aria-label="标准错误">{result.stderr}</pre>}
      {!result.stdout && !result.stderr && <p>本次诊断没有输出。</p>}
    </details>
  </section>;
}

/** Manages saved SSH hosts, fingerprint verification and fixed read-only diagnostics. */
export function SshHostPanel({ api, suspended, mismatches, setMismatches, onClose }: SshHostPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const editorNameRef = useRef<HTMLInputElement>(null);
  const reviewTitleRef = useRef<HTMLHeadingElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const resultTitleRef = useRef<HTMLHeadingElement>(null);
  const pendingRef = useRef<PendingOperation | null>(null);
  const [hosts, setHosts] = useState<SshHostProfile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<HostEditor | null>(null);
  const [review, setReview] = useState<FingerprintReview | null>(null);
  const [verified, setVerified] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<SshDiagnosticResult | null>(null);
  const [unit, setUnit] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [focusRequest, setFocusRequest] = useState<HostAction | null>(null);

  const selected = hosts.find((host) => host.id === selectedId);
  const mismatch = selected !== undefined && mismatches.has(trustIdentity(selected));
  const locked = pending !== null || editor !== null || deleteConfirmation || review !== null;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (suspended && dialog.open) {
      const active = document.activeElement;
      previousFocusRef.current = active instanceof HTMLElement && dialog.contains(active) ? active : null;
      dialog.close();
    } else if (!suspended && !dialog.open) {
      dialog.showModal();
      const previousFocus = previousFocusRef.current;
      if (previousFocus && dialog.contains(previousFocus) && !previousFocus.matches(':disabled')) {
        previousFocus.focus();
      } else {
        (errorRef.current ?? editorNameRef.current ?? reviewTitleRef.current ?? deleteCancelRef.current ?? resultTitleRef.current)?.focus();
      }
      previousFocusRef.current = null;
    }
  }, [suspended]);

  useEffect(() => {
    return () => {
      const operationId = pendingRef.current?.operationId;
      pendingRef.current = null;
      if (operationId) {
        // Main also aborts outstanding operations when the window closes.
        void api.cancelSshOperation(operationId).catch(() => undefined);
      }
    };
  }, [api]);

  useEffect(() => {
    let active = true;
    const loadHosts = async () => {
      try {
        const items = await api.listSshHosts();
        if (!active) return;
        setHosts(items);
        setSelectedId(items[0]?.id ?? null);
      } catch (reason: unknown) {
        if (active) setError(sshError(reason));
      } finally {
        if (active) setLoaded(true);
      }
    };
    void loadHosts();
    return () => { active = false; };
  }, [api]);

  const editorOpen = editor !== null;
  useEffect(() => {
    if (editorOpen) editorNameRef.current?.focus();
  }, [editorOpen]);
  useEffect(() => {
    if (review) reviewTitleRef.current?.focus();
  }, [review]);
  useEffect(() => {
    if (deleteConfirmation) deleteCancelRef.current?.focus();
  }, [deleteConfirmation]);
  useEffect(() => {
    if (result) resultTitleRef.current?.focus();
  }, [result]);
  useEffect(() => {
    if (error || (mismatch && !review && !locked)) errorRef.current?.focus();
  }, [error, locked, mismatch, review]);
  useEffect(() => {
    if (!focusRequest || suspended || locked) return;
    const actions = { add: addButtonRef, edit: editButtonRef, delete: deleteButtonRef, test: testButtonRef };
    actions[focusRequest].current?.focus();
    setFocusRequest(null);
  }, [focusRequest, locked, suspended]);

  const recordMismatch = (profile: SshHostProfile, blocked: boolean) => {
    const identity = trustIdentity(profile);
    setMismatches((current) => {
      if (current.has(identity) === blocked) return current;
      const next = new Set(current);
      if (blocked) next.add(identity);
      else next.delete(identity);
      return next;
    });
  };

  const changeSelection = (id: string | null) => {
    setSelectedId(id);
    setReview(null);
    setVerified(false);
    setError('');
    setNotice('');
    setResult(null);
    setUnit('');
    setRemotePath('');
  };

  const run = async <T,>(operation: PendingOperation, request: () => Promise<T>, complete: (value: T) => void) => {
    if (pendingRef.current) return;
    pendingRef.current = operation;
    setPending(operation);
    setError('');
    setNotice('');
    try {
      const value = await request();
      if (pendingRef.current === operation) complete(value);
    } catch (reason: unknown) {
      if (pendingRef.current !== operation) return;
      const message = sshError(reason);
      if (message.startsWith(FINGERPRINT_MISMATCH)) {
        if (selected) recordMismatch(selected, true);
        setVerified(false);
        setResult(null);
        setReview(null);
      } else if (message === 'SSH 操作已取消') {
        setNotice(message);
      } else {
        if (message.startsWith('私钥认证失败')) setVerified(false);
        setError(message);
      }
    } finally {
      if (pendingRef.current === operation) {
        pendingRef.current = null;
        setPending(null);
        setCancelling(false);
      }
    }
  };

  const runHostOperation = <T,>(label: string, request: (input: SshHostOperation) => Promise<T>, complete: (value: T) => void) => {
    if (!selected) return;
    const operationId = crypto.randomUUID();
    void run({ label, operationId }, () => request({ id: selected.id, operationId }), complete);
  };

  const cancelOperation = async () => {
    const operation = pendingRef.current;
    if (!operation?.operationId || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelSshOperation(operation.operationId);
    } catch (reason: unknown) {
      if (pendingRef.current !== operation) return;
      setError(sshError(reason));
      setCancelling(false);
    }
  };

  const closePanel = () => {
    if (suspended || (pendingRef.current && !pendingRef.current.operationId)) return;
    dialogRef.current?.close();
    onClose();
  };

  const openEditor = (profile?: SshHostProfile) => {
    setError('');
    setNotice('');
    setEditor(profile ? {
      id: profile.id, name: profile.name, host: profile.host, port: String(profile.port), username: profile.username,
      privateKeyPath: profile.privateKeyPath,
    } : EMPTY_EDITOR);
  };

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    const input = { ...editor, name: editor.name.trim(), host: editor.host.trim(), port: Number(editor.port), username: editor.username.trim() };
    void run({ label: '正在保存主机…' }, () => api.saveSshHost(input), (saved) => {
      if (selected?.id === saved.id && trustIdentity(selected) !== trustIdentity(saved)) recordMismatch(selected, false);
      setHosts((current) => editor.id === undefined ? [...current, saved] : current.map((host) => host.id === saved.id ? saved : host));
      changeSelection(saved.id);
      setEditor(null);
      setNotice('已保存主机。');
      setFocusRequest('edit');
    });
  };

  const probeFingerprint = () => {
    if (!selected) return;
    setVerified(false);
    setResult(null);
    runHostOperation('正在探测主机指纹…', (input) => api.probeSshHost(input), ({ fingerprint }) => {
      if (fingerprint === selected.hostKeyFingerprint) {
        recordMismatch(selected, false);
        setNotice('主机指纹与已信任的指纹一致。请测试连接。');
      } else {
        if (selected.hostKeyFingerprint) recordMismatch(selected, true);
        setReview({ fingerprint, previous: selected.hostKeyFingerprint });
      }
    });
  };

  const trustFingerprint = () => {
    if (!selected || !review) return;
    void run({ label: '正在保存指纹…' }, () => api.trustSshHostKey({ id: selected.id, fingerprint: review.fingerprint }), (saved) => {
      setHosts((current) => current.map((host) => host.id === saved.id ? saved : host));
      setReview(null);
      recordMismatch(selected, false);
      setNotice('已保存信任的指纹。请测试连接。');
      setFocusRequest('test');
    });
  };

  const handleTest = () => {
    if (!selected?.hostKeyFingerprint || mismatch) {
      probeFingerprint();
      return;
    }
    setVerified(false);
    setResult(null);
    runHostOperation('正在测试 SSH 连接…', (input) => api.testSshHost(input), () => {
      setVerified(true);
      setNotice('连接测试成功。');
    });
  };

  const diagnose = (action: RemoteDiagActionDto) => {
    if (!verified || mismatch) return;
    setResult(null);
    runHostOperation(`正在运行${DIAGNOSTIC_LABELS[action.action]}…`, (input) => api.runSshDiagnostic({ ...input, action }), setResult);
  };

  const deleteHost = () => {
    if (!selected) return;
    void run({ label: '正在删除主机…' }, () => api.deleteSshHost(selected.id), () => {
      const remaining = hosts.filter((host) => host.id !== selected.id);
      recordMismatch(selected, false);
      setHosts(remaining);
      changeSelection(remaining[0]?.id ?? null);
      setDeleteConfirmation(false);
      setNotice('已删除主机配置。');
      setFocusRequest(remaining.length ? 'edit' : 'add');
    });
  };

  return <dialog className="ssh-dialog" ref={dialogRef} aria-labelledby="ssh-title" onCancel={(event) => {
    event.preventDefault();
    closePanel();
  }}>
    <header className="ssh-header">
      <h2 id="ssh-title">SSH 主机</h2>
      <button type="button" className="secondary-button" onClick={closePanel} disabled={pending !== null && !pending.operationId}>关闭</button>
    </header>
    <div className="ssh-layout">
      <section className="ssh-hosts" aria-labelledby="ssh-host-list-title">
        <div className="ssh-row">
          <h3 id="ssh-host-list-title">主机配置</h3>
          <button type="button" className="secondary-button" ref={addButtonRef} disabled={!loaded || locked} onClick={() => openEditor()}>添加主机</button>
        </div>
        {!loaded && <p role="status">正在读取主机…</p>}
        {loaded && hosts.length === 0 && !error && <p>尚未添加主机。</p>}
        <ul>
          {hosts.map((host) => <li key={host.id}>
            <button type="button" aria-pressed={host.id === selectedId} className="ssh-host-select" disabled={locked} onClick={() => {
              if (host.id !== selectedId) changeSelection(host.id);
            }}>
              <strong>{host.name}</strong>
              <code>{hostAddress(host)}</code>
            </button>
          </li>)}
        </ul>
      </section>
      <section className="ssh-content" aria-label="主机详情">
        {editor ? <form className="ssh-editor" onSubmit={handleSave} autoComplete="off">
          <h3>{editor.id ? '编辑主机' : '添加主机'}</h3>
          <fieldset disabled={pending !== null}>
            <label className="ssh-field ssh-field-wide">显示名称
              <input required maxLength={120} ref={editorNameRef} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
            </label>
            <label className="ssh-field">主机名或 IP 地址
              <input required maxLength={253} spellCheck={false} value={editor.host} onChange={(event) => setEditor({ ...editor, host: event.target.value })} />
            </label>
            <label className="ssh-field">端口
              <input required type="number" min={1} max={65535} step={1} value={editor.port} onChange={(event) => setEditor({ ...editor, port: event.target.value })} />
            </label>
            <label className="ssh-field ssh-field-wide">SSH 用户名
              <input required maxLength={64} pattern="[A-Za-z0-9._\-]{1,64}" spellCheck={false} value={editor.username} onChange={(event) => setEditor({ ...editor, username: event.target.value })} />
            </label>
            <label className="ssh-field ssh-field-wide">本机私钥文件的绝对路径
              <input required maxLength={4096} spellCheck={false} value={editor.privateKeyPath} onChange={(event) => setEditor({ ...editor, privateKeyPath: event.target.value })} />
            </label>
            <div className="ssh-actions ssh-field-wide">
              <button type="submit" className="send-button">保存主机</button>
              <button type="button" className="secondary-button" onClick={() => {
                setFocusRequest(editor.id ? 'edit' : 'add');
                setEditor(null);
                setError('');
              }}>取消编辑</button>
            </div>
          </fieldset>
        </form> : selected ? <>
          <div className="ssh-row ssh-host-heading">
            <div><h3>{selected.name}</h3><code>{hostAddress(selected)}</code></div>
            <div className="ssh-actions">
              <button type="button" className="secondary-button" ref={editButtonRef} disabled={locked} onClick={() => openEditor(selected)}>编辑</button>
              <button type="button" className="secondary-button" ref={deleteButtonRef} disabled={locked} onClick={() => {
                setDeleteConfirmation(true);
                setError('');
                setNotice('');
              }}>删除…</button>
            </div>
          </div>
          {deleteConfirmation ? <section className="ssh-review" aria-labelledby="ssh-delete-title">
            <h3 id="ssh-delete-title">删除「{selected.name}」的配置？</h3>
            <div className="ssh-actions">
              <button type="button" className="secondary-button" ref={deleteCancelRef} disabled={pending !== null} onClick={() => {
                setDeleteConfirmation(false);
                setError('');
                setFocusRequest('delete');
              }}>取消删除</button>
              <button type="button" className="cancel-button" disabled={pending !== null} onClick={deleteHost}>确认删除</button>
            </div>
          </section> : review ? <section className={`ssh-review${review.previous ? ' ssh-review-warning' : ''}`} aria-labelledby="ssh-review-title">
            <h3 id="ssh-review-title" ref={reviewTitleRef} tabIndex={-1}>{review.previous ? '主机指纹已变化，连接已阻止' : '核对主机指纹'}</h3>
            <p>请通过可信渠道核对探测到的 SHA-256 指纹后再确认。</p>
            <dl className="ssh-fingerprints">
              {review.previous && <div><dt>已信任的指纹</dt><dd><code>{review.previous}</code></dd></div>}
              <div><dt>探测到的指纹</dt><dd><code>{review.fingerprint}</code></dd></div>
            </dl>
            <div className="ssh-actions">
              <button type="button" className="secondary-button" disabled={pending !== null} onClick={() => {
                setReview(null);
                setError('');
                setFocusRequest('test');
              }}>暂不信任</button>
              <button type="button" className={review.previous ? 'cancel-button' : 'send-button'} disabled={pending !== null} onClick={trustFingerprint}>
                {review.previous ? '确认更新信任指纹' : '确认并信任此指纹'}
              </button>
            </div>
          </section> : <section className="ssh-connection" aria-label="连接验证">
            {mismatch && <p className="ssh-feedback ssh-blocking" role="alert" tabIndex={-1} ref={error ? undefined : errorRef}>主机指纹不匹配，已阻止连接和诊断。已信任的指纹仍保存在主机配置中。</p>}
            {selected.hostKeyFingerprint ? <dl className="ssh-fingerprints">
              <div><dt>已信任的指纹</dt><dd><code>{selected.hostKeyFingerprint}</code></dd></div>
            </dl> : <p>首次连接前需要核对主机指纹。</p>}
            <button type="button" className="send-button" ref={testButtonRef} disabled={pending !== null} onClick={handleTest}>
              {mismatch ? '重新探测并核对指纹' : selected.hostKeyFingerprint ? '测试连接' : '探测主机指纹'}
            </button>
          </section>}
        </> : loaded && !error && <p>添加主机后即可核对指纹并测试连接。</p>}

        {pending && <div className="ssh-row ssh-feedback">
          <span role="status">{cancelling ? '正在取消 SSH 操作…' : pending.label}</span>
          {pending.operationId && <button type="button" className="secondary-button" disabled={cancelling} onClick={() => void cancelOperation()}>取消操作</button>}
        </div>}
        {error && <p className="ssh-feedback ssh-blocking" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
        {notice && <p className={`ssh-feedback${notice === 'SSH 操作已取消' ? '' : ' ssh-success'}`} role="status">{notice}</p>}

        {verified && !mismatch && !editor && !review && !deleteConfirmation && <section className="ssh-diagnostics" aria-labelledby="ssh-diagnostics-title">
          <h3 id="ssh-diagnostics-title">只读诊断</h3>
          <div className="ssh-actions">
            {GENERAL_DIAGNOSTICS.map((action) => <button type="button" className="secondary-button" key={action.action} disabled={locked} onClick={() => diagnose(action)}>
              {DIAGNOSTIC_LABELS[action.action]}
            </button>)}
          </div>
          <form className="ssh-diagnostic-input" onSubmit={(event) => { event.preventDefault(); diagnose({ action: 'systemctl_status', unit: unit.trim() }); }}>
            <label className="ssh-field">systemd 服务名称
              <input required spellCheck={false} value={unit} disabled={locked} onChange={(event) => setUnit(event.target.value)} />
            </label>
            <button type="submit" className="secondary-button" disabled={locked || !unit.trim()}>{DIAGNOSTIC_LABELS.systemctl_status}</button>
          </form>
          <div className="ssh-diagnostic-input ssh-diagnostic-path">
            <label className="ssh-field">远程绝对路径
              <input spellCheck={false} value={remotePath} disabled={locked} onChange={(event) => setRemotePath(event.target.value)} />
            </label>
            <div className="ssh-actions">
              {PATH_DIAGNOSTICS.map((action) => <button type="button" className="secondary-button" key={action} disabled={locked || !remotePath.trim()}
                onClick={() => diagnose({ action, path: remotePath.trim() })}>{DIAGNOSTIC_LABELS[action]}</button>)}
            </div>
          </div>
          {result && <DiagnosticResult result={result} titleRef={resultTitleRef} />}
        </section>}
      </section>
    </div>
  </dialog>;
}
