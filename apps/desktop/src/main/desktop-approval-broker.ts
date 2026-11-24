import type { CreateRuntimeOptions } from '../../../cli/src/runtime/create-runtime.js';
import { redactApprovalRequest } from './redaction.js';
import type { DesktopApprovalRequest, DesktopEvent } from '../shared/desktop-api.js';

type ApprovalHandler = NonNullable<CreateRuntimeOptions['approvalHandler']>;
type ApprovalRequest = Parameters<ApprovalHandler>[0];

export class DesktopApprovalBroker {
  private readonly pending = new Map<string, (approved: boolean) => void>();

  constructor(private readonly emit: (event: DesktopEvent) => void) {}

  readonly handler: ApprovalHandler = (request) => new Promise<boolean>((resolve) => {
    this.pending.set(request.id, resolve);
    this.emit({ type: 'approval:request', request: redactApprovalRequest(toApprovalDto(request)) });
  });

  resolve(approvalId: string, decision: 'approve' | 'reject'): boolean {
    const resolve = this.pending.get(approvalId);
    if (!resolve) return false;
    this.pending.delete(approvalId);
    resolve(decision === 'approve');
    return true;
  }

  dismiss(approvalId: string): void {
    const resolve = this.pending.get(approvalId);
    if (!resolve) return;
    this.pending.delete(approvalId);
    resolve(false);
  }

  cancelAll(): void {
    for (const resolve of this.pending.values()) resolve(false);
    this.pending.clear();
  }
}

function toApprovalDto(request: ApprovalRequest): DesktopApprovalRequest {
  return {
    id: request.id,
    tool: request.tool,
    riskLevel: request.riskLevel,
    reason: request.reason,
    input: request.input,
    ...(request.preview ? { preview: request.preview } : {}),
    ...(request.previewMustBeReviewed !== undefined ? { previewMustBeReviewed: request.previewMustBeReviewed } : {}),
  };
}
