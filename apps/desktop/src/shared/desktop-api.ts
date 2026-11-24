export const IPC_CHANNELS = {
  appState: 'forgex:app-state',
  recentProjects: 'forgex:recent-projects',
  selectProject: 'forgex:select-project',
  connectModel: 'forgex:connect-model',
  startSession: 'forgex:start-session',
  sendMessage: 'forgex:send-message',
  cancelTurn: 'forgex:cancel-turn',
  listSessions: 'forgex:list-sessions',
  sessionMessages: 'forgex:session-messages',
  renameSession: 'forgex:rename-session',
  deleteSession: 'forgex:delete-session',
  resolveApproval: 'forgex:resolve-approval',
  openExternal: 'forgex:open-external',
  event: 'forgex:event',
} as const;

export interface ProjectSelection {
  path: string;
  name: string;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  workspace: string;
  model: string;
  updatedAt: string;
  status: string;
}

export interface DesktopMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DesktopAppState {
  version: string;
  modelConfigured: boolean;
  permissionMode: string;
  projectPath: string | null;
  modelConfigPath: string;
  providers: ProviderOption[];
}

export interface ProviderOption {
  id: string;
  name: string;
  defaultBaseUrl: string;
  defaultModel: string;
  apiKeyEnv: string;
}

export interface ConnectModelInput {
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ConnectModelResult {
  model: string;
  latencyMs: number;
}

export interface DesktopApprovalRequest {
  id: string;
  tool: string;
  riskLevel: string;
  reason: string;
  input: unknown;
  preview?: string;
  previewMustBeReviewed?: boolean;
}

export type DesktopEvent =
  | { type: 'assistant:delta'; text: string }
  | { type: 'assistant:message'; text: string }
  | { type: 'tool:start'; callId: string; name: string }
  | { type: 'tool:end'; callId: string; name: string; ok: boolean; summary: string; error?: string; durationMs: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'metrics'; totalTokens: number; totalMs: number; toolCalls: number }
  | { type: 'turn:end'; reason: string }
  | { type: 'approval:resolved'; id: string }
  | { type: 'approval:request'; request: DesktopApprovalRequest };

export interface DesktopApi {
  getAppState(): Promise<DesktopAppState>;
  getRecentProjects(): Promise<ProjectSelection[]>;
  selectProject(): Promise<ProjectSelection | null>;
  connectModel(input: ConnectModelInput): Promise<ConnectModelResult>;
  startSession(input: { projectPath: string; sessionId?: string }): Promise<SessionSummary>;
  sendMessage(text: string): Promise<void>;
  cancelTurn(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  getSessionMessages(sessionId: string): Promise<DesktopMessage[]>;
  renameSession(input: { sessionId: string; title: string }): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  resolveApproval(input: { approvalId: string; decision: 'approve' | 'reject' }): Promise<void>;
  openExternal(url: string): Promise<void>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}

declare global {
  interface Window {
    forgex: DesktopApi;
  }
}
