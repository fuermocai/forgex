import { redactText, redactValue } from '../../../../packages/shared/src/utils/redact.js';
import type { DesktopApprovalRequest } from '../shared/desktop-api.js';

export function redactApprovalRequest(request: DesktopApprovalRequest): DesktopApprovalRequest {
  return {
    ...request,
    input: redactValue(request.input),
    ...(request.preview ? { preview: redactText(request.preview) } : {}),
  };
}
