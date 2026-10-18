import { z } from 'zod';
export const PROTOCOL_VERSION = 1 as const;
const binding = { generation: z.string().uuid(), sessionId: z.string().min(1).max(64) };
export const actionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('submit'),
      ...binding,
      invocationId: z.string().uuid(),
      text: z.string().trim().min(1).max(100_000),
    })
    .strict(),
  z.object({ type: z.literal('stop'), ...binding }).strict(),
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
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  sessions: Array<{ id: string; title: string; updatedAt: string; messageCount: number }>;
  brokenSessions: number;
  plugins: Array<{ id: string; version: string }>;
  tools: Array<{ name: string; risk: string }>;
  commands: Array<{ id: string; description: string }>;
  inspection: { kind: 'files' | 'read' | 'diff'; path?: string; content: string; error?: boolean };
}
export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  demo: boolean;
  lastSessionId?: string;
}
export interface DesktopState {
  version: typeof PROTOCOL_VERSION;
  revision: number;
  connecting: boolean;
  projects: ProjectSummary[];
  runtime?: RuntimeSnapshot;
  error?: string;
}
export interface DesktopBridge {
  snapshot(): Promise<DesktopState>;
  onState(listener: (state: DesktopState) => void): () => void;
  pickProject(): Promise<void>;
  openProject(id: string): Promise<void>;
  startDemo(): Promise<void>;
  newSession(): Promise<void>;
  request(action: DesktopAction): Promise<void>;
}
export interface WorkerRequest {
  id: string;
  action:
    | DesktopAction
    | { type: 'init'; cwd: string; demo: boolean; generation: string }
    | { type: 'dispose' };
}
export type WorkerMessage =
  | { type: 'state'; state: RuntimeSnapshot }
  | { type: 'reply'; id: string; error?: string }
  | { type: 'ready' };
