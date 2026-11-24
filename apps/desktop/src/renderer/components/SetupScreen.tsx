import { useEffect, useState } from 'react';
import type { ConnectModelInput, DesktopAppState } from '../../shared/desktop-api.js';

export function SetupScreen(props: { state: DesktopAppState | null; onConnected(): void; onCancel(): void }) {
  const providers = props.state?.providers ?? [];
  const [providerId, setProviderId] = useState(providers[0]?.id ?? 'deepseek');
  const selected = providers.find((provider) => provider.id === providerId) ?? providers[0];
  const [baseUrl, setBaseUrl] = useState(selected?.defaultBaseUrl ?? '');
  const [model, setModel] = useState(selected?.defaultModel ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!selected) return;
    setBaseUrl(selected.defaultBaseUrl);
    setModel(selected.defaultModel);
  }, [selected?.id]);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const input: ConnectModelInput = { providerId, baseUrl, model, apiKey };
    try {
      await window.forgex.connectModel(input);
      setApiKey('');
      props.onConnected();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-wrap">
      <div className="setup-card">
        <h2>连接你的模型</h2>
        <p>模型配置写入 {props.state?.modelConfigPath ?? '~/.forgex/config.json'}。凭据保存在 ForgeX 本机凭据存储；验证通过后才启用会话。</p>
        <form onSubmit={(event) => void connect(event)}>
          <label>提供方
            <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label>API 地址
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} autoComplete="url" spellCheck={false} />
          </label>
          <label>模型名称
            <input value={model} onChange={(event) => setModel(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label>API Key {providerId === 'custom' && <span className="optional">（本地模型可留空）</span>}
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" spellCheck={false} />
          </label>
          {error && <div className="inline-error">{error}</div>}
          <div className="setup-actions">
            {props.state?.modelConfigured && <button type="button" className="secondary-button" onClick={props.onCancel}>返回会话</button>}
            <button type="submit" className="project-button" disabled={busy || !baseUrl.trim() || !model.trim() || (!apiKey.trim() && providerId !== 'custom')}>
              {busy ? '正在验证…' : '验证并连接'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
