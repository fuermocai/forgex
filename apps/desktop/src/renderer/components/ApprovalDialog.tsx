import { useState } from 'react';
import type { DesktopApprovalRequest } from '../../shared/desktop-api.js';

export function ApprovalDialog(props: { request: DesktopApprovalRequest; queueLength: number; onResolve(decision: 'approve' | 'reject'): void }) {
  const [previewRead, setPreviewRead] = useState(false);
  const preview = props.request.preview ?? '';
  const needsScroll = Boolean(props.request.previewMustBeReviewed && preview.length > 0);

  return (
    <div className="modal-backdrop">
      <section className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="dialog-context">需要你的确认 · {props.request.riskLevel}{props.queueLength > 1 ? ` · 待处理 ${props.queueLength} 项` : ''}</div>
        <h2 id="approval-title">允许 ForgeX 执行 {props.request.tool}？</h2>
        <p>{props.request.reason}</p>
        <div className="approval-details"><strong>参数</strong><pre>{JSON.stringify(props.request.input, null, 2)}</pre></div>
        {preview && <div className="approval-preview" onScroll={(event) => {
          const node = event.currentTarget;
          if (node.scrollTop + node.clientHeight >= node.scrollHeight - 4) setPreviewRead(true);
        }}><strong>完整预览</strong><pre>{preview}</pre></div>}
        <div className="setup-actions">
          <button className="secondary-button" onClick={() => props.onResolve('reject')}>拒绝</button>
          <button className="project-button" onClick={() => props.onResolve('approve')} disabled={needsScroll && !previewRead}>批准</button>
        </div>
        {needsScroll && !previewRead && <div className="approval-hint">滚动查看完整预览后才能批准</div>}
      </section>
    </div>
  );
}
