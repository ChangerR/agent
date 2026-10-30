import { z } from 'zod';
export const PROTOCOL_VERSION = 1 as const;
const binding = { generation: z.string().uuid(), sessionId: z.string().min(1).max(64) };
export const actionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('debug-read'),
      ...binding,
      page: z.number().int().min(0).max(1000000),
      eventPage: z.number().int().min(0).max(1000000),
      requestId: z.string().uuid().optional(),
      eventId: z.string().uuid().optional(),
      filters: z
        .object({
          query: z.string().max(200).optional(),
          provider: z.string().max(200).optional(),
          model: z.string().max(200).optional(),
          role: z.string().max(50).optional(),
          status: z.string().max(30).optional(),
          from: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          to: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          order: z.enum(['newest', 'oldest']).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal('debug-export'), ...binding }).strict(),
  z.object({ type: z.literal('debug-close'), ...binding }).strict(),
  z
    .object({
      type: z.literal('submit'),
      ...binding,
      invocationId: z.string().uuid(),
      text: z.string().trim().min(1).max(100_000),
    })
    .strict(),
  z.object({ type: z.literal('stop'), ...binding }).strict(),
  z.object({ type: z.literal('session-save'), ...binding }).strict(),
  z
    .object({
      type: z.literal('session-delete'),
      ...binding,
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal('settings-read'),
      ...binding,
      sectionId: z.string().min(1).max(200),
      scope: z.enum(['project', 'global']),
    })
    .strict(),
  z
    .object({
      type: z.literal('settings-commit'),
      ...binding,
      editorId: z.string().uuid(),
      json: z.string().max(64 * 1024),
    })
    .strict(),
  z.object({ type: z.literal('settings-close'), ...binding }).strict(),
  z
    .object({
      type: z.literal('approve'),
      ...binding,
      approvalId: z.string().uuid(),
      allow: z.boolean(),
      feedback: z.string().max(4000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('resume'),
      ...binding,
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal('setting'),
      ...binding,
      field: z.enum(['model', 'mode', 'think']),
      value: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal('inspect'),
      ...binding,
      kind: z.enum(['files', 'read', 'diff']),
      path: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('interact'),
      ...binding,
      interactionId: z.string().uuid(),
      value: z.string().max(10000).optional(),
    })
    .strict(),
]);
export type DesktopAction = z.infer<typeof actionSchema>;
export const globalSettingsActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('read'),
      generation: z.string().uuid(),
      sectionId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal('commit'),
      generation: z.string().uuid(),
      editorId: z.string().uuid(),
      json: z.string().max(64 * 1024),
    })
    .strict(),
]);
export type GlobalSettingsAction = z.infer<typeof globalSettingsActionSchema>;
export interface Row {
  id: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'notice';
  text: string;
  toolName?: string;
  input?: string;
  status?: 'running' | 'completed' | 'error' | 'cancelled';
  startedAt?: number;
  durationMs?: number;
}
export interface Approval {
  id: string;
  summary: string;
  reason: string;
  toolName: string;
  input: string;
  cwd: string;
  agentName?: string;
  interpreter?: string;
}
export interface Interaction {
  id: string;
  prompt: string;
  body?: string;
  kind?: string;
  initialValue?: string;
  choices?: Array<{ id: string; label: string; description?: string }>;
}
export interface RuntimeSnapshot {
  projectId?: string;
  remote?: { target: string; path: string; connected: boolean };
  debug?: import('./debug.js').DebugSnapshot;
  generation: string;
  seq: number;
  cwd: string;
  projectName: string;
  sessionId: string;
  title: string;
  demo: boolean;
  busy: boolean;
  phase: string;
  error?: string;
  rows: Row[];
  approvals: Approval[];
  interaction?: Interaction;
  model: string;
  mode: string;
  thinking: string;
  provider: string;
  sources: { model: string; mode: string; thinking: string };
  models: string[];
  providers: string[];
  providerOptions?: string[];
  providerLabels?: Record<string, string>;
  modelDetails: Array<{
    id: string;
    displayName?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  sessions: Array<{
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
  }>;
  brokenSessions: number;
  plugins: Array<{ id: string; version: string }>;
  tools: Array<{ name: string; risk: string }>;
  commands: Array<{ id: string; description: string }>;
  settings: SettingsDescriptor[];
  settingsEditor?: SettingsEditor;
  inspection: { kind: 'files' | 'read' | 'diff'; path?: string; content: string; error?: boolean };
}
export interface SettingsDescriptor {
  id: string;
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  applyMode: 'immediate' | 'nextRequest' | 'idleBoundary' | 'newSession';
  scopes: Array<{ scope: 'project' | 'global'; path: string }>;
  editable: boolean;
}
export interface SettingsSnapshot extends Pick<
  RuntimeSnapshot,
  | 'generation'
  | 'settings'
  | 'settingsEditor'
  | 'provider'
  | 'providers'
  | 'providerOptions'
  | 'providerLabels'
  | 'models'
  | 'modelDetails'
  | 'tools'
> {
  revision: number;
}
export interface CredentialStatus {
  token: string;
  provider: string;
  endpoint: string;
  configured: boolean;
  available: boolean;
  backend: string;
}
export interface SettingsEditor {
  id: string;
  sectionId: string;
  scope: 'project' | 'global';
  value: unknown;
  effectiveValue?: unknown;
  effectiveError?: string;
  error?: string;
  saved?: boolean;
  feedbackRevision?: number;
}
export type DesktopNavigation = 'settings' | 'new-session' | 'open-project';
export interface ProjectSummary {
  remoteHostId?: string;
  remoteIdentity?: string;
  remote?: import('../remote/protocol.js').SshProjectInput;
  id: string;
  name: string;
  path: string;
  demo: boolean;
  lastSessionId?: string;
}
export interface RemoteHostSummary {
  id: string;
  name: string;
  target: string;
  identity?: string;
  home: string;
}
export interface DesktopState {
  remoteHosts?: RemoteHostSummary[];
  connectionStatus?: string;
  globalSettings?: SettingsSnapshot;
  theme?: 'system' | 'light' | 'dark' | 'blue';
  version: typeof PROTOCOL_VERSION;
  revision: number;
  connecting: boolean;
  projects: ProjectSummary[];
  runtime?: RuntimeSnapshot;
  error?: string;
  platform?: string;
}
export interface DesktopBridge {
  addRemoteHost?(input: import('../remote/protocol.js').SshHostInput): Promise<void>;
  openRemoteProject?(input: import('../remote/protocol.js').OpenRemoteProjectInput): Promise<void>;
  createProject?(input: import('../remote/protocol.js').NewProjectInput): Promise<void>;
  cancelRemoteConnection?(): Promise<void>;
  remoteConnections?(): Promise<Array<{ id: string; model: string; label: string }>>;
  pickRemoteDirectory?(input: { hostId: string; path?: string }): Promise<string[]>;
  readModelSetup?(
    service?: import('./model-setup.js').ModelService,
  ): Promise<import('./model-setup.js').ModelSetupView>;
  saveModelSetup?(input: import('./model-setup.js').ModelSetupSave): Promise<void>;
  globalSettingsRequest?(action: GlobalSettingsAction): Promise<void>;
  credentialStatus?(provider: string): Promise<CredentialStatus>;
  saveCredential?(token: string, key: string | null): Promise<void>;
  setTheme?(theme: 'system' | 'light' | 'dark' | 'blue'): Promise<void>;
  snapshot(): Promise<DesktopState>;
  onState(listener: (state: DesktopState) => void): () => void;
  onNavigate(listener: (action: DesktopNavigation) => void): () => void;
  settingsDirty(dirty: boolean): Promise<void>;
  pickProject(options?: { newSession?: boolean }): Promise<void>;
  pickDirectory(): Promise<string | undefined>;
  openProject(id: string): Promise<void>;
  startDemo(): Promise<void>;
  newSession(options?: { projectId: string }): Promise<void>;
  request(action: DesktopAction): Promise<void>;
}
export interface WorkerRequest {
  id: string;
  action:
    | DesktopAction
    | {
        type: 'init';
        cwd: string;
        demo: boolean;
        generation: string;
        credentials?: Record<string, { key: string; binding: string }>;
      }
    | { type: 'init-settings'; generation: string }
    | { type: 'global-settings'; action: GlobalSettingsAction }
    | { type: 'dispose' };
}
export type WorkerMessage =
  | { type: 'global-settings-state'; state: SettingsSnapshot }
  | { type: 'state'; state: RuntimeSnapshot }
  | { type: 'reply'; id: string; error?: string }
  | { type: 'ready' };
