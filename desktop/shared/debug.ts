export interface DebugRequest {
  sequence: number;
  id: string;
  at: string;
  role: string;
  provider: string;
  model: string;
  agent?: string;
  parentRequestId?: string;
  status: 'running' | 'completed' | 'error' | 'aborted' | 'interrupted';
  durationMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usageReported?: boolean;
  chunks?: number;
  stopReason?: string;
  endpoint?: string;
  protocol?: string;
  httpStatus?: number;
  transportCount?: number;
  cacheAvailable?: boolean;
}
export interface DebugFilters {
  query?: string;
  provider?: string;
  model?: string;
  role?: string;
  status?: string;
  from?: string;
  to?: string;
  order?: 'newest' | 'oldest';
}
export interface DebugEntry {
  id: string;
  at: string;
  type: string;
  title: string;
  requestId?: string;
  agent?: string;
  data: Record<string, unknown>;
}
export interface DebugSnapshot {
  sessionId: string;
  totalRequests: number;
  httpAttempts: number;
  filteredRequests: number;
  filters: DebugFilters;
  choices: { providers: string[]; models: string[]; roles: string[] };
  totalEvents: number;
  toolCalls: number;
  approvals: number;
  page: number;
  pageSize: number;
  eventPage: number;
  requests: DebugRequest[];
  timeline: Array<Omit<DebugEntry, 'data'>>;
  warning?: string;
  detail?: { requestId: string; request?: DebugRequest; entries: DebugEntry[] };
  event?: DebugEntry;
  report?: { id: string; markdown: string };
}
