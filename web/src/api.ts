import type { AppState, ApprovalDecision, EvalResult, EvalSuite, ExternalSession, TraceSpan, Automation, Billing, ClaudePlan, ShellsState, FileEntry, GitInfo, ProviderStatus, Run, RunEvent, RunMode, Settings, ShellChunk, SkillsState, Stats, Team } from '../../shared/types.ts';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'x-beo-client': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface FolderListing { path: string; parent: string | null; dirs: string[] }

export const api = {
  state: () => request<AppState>('GET', '/api/state'),
  saveTeam: (team: Team) => request<Team>('POST', '/api/teams', team),
  deleteTeam: (id: string) => request('DELETE', `/api/teams/${id}`),
  saveSettings: (settings: Settings) => request<Settings>('PUT', '/api/settings', settings),
  providers: () => request<ProviderStatus[]>('GET', '/api/providers'),
  skills: () => request<SkillsState>('GET', '/api/skills'),
  installSkills: () => request<SkillsState>('POST', '/api/skills/install'),
  folders: (path?: string) => request<FolderListing>('GET', `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  startRun: (input: { teamId: string; task: string; workdir?: string; files?: string[]; checkCommand?: string; mode?: RunMode }) =>
    request<Run>('POST', '/api/runs', input),
  message: (id: string, text: string, agentId?: string, files: string[] = [], mode: RunMode = 'auto') => request<Run>('POST', `/api/runs/${id}/message`, { text, agentId, files, mode }),
  context: (runId: string, agentId: string, how: 'compact' | 'fresh') => request<Run>('POST', `/api/runs/${runId}/agents/${agentId}/context`, { how }),
  memory: (teamId: string) => request<{ text: string }>('GET', `/api/teams/${teamId}/memory`),
  saveMemory: (teamId: string, text: string) => request<{ text: string }>('PUT', `/api/teams/${teamId}/memory`, { text }),
  trace: (runId: string) => request<TraceSpan[]>('GET', `/api/runs/${runId}/trace`),
  evals: () => request<{ suites: EvalSuite[]; results: EvalResult[] }>('GET', '/api/evals'),
  saveEvalSuites: (suites: EvalSuite[]) => request<EvalSuite[]>('PUT', '/api/evals/suites', { suites }),
  runEval: (suiteId: string, teamId: string) => request<EvalResult>('POST', '/api/evals/run', { suiteId, teamId }),
  external: () => request<ExternalSession[]>('GET', '/api/external'),
  uploadUrl: (p: string) => `/api/upload?path=${encodeURIComponent(p)}`,
  ollamaPulls: () => request<{ model: string; status: string; percent?: number; done: boolean; error?: string }[]>('GET', '/api/ollama/pulls'),
  ollamaDelete: (endpointId: string, model: string) => request<{ ok: boolean }>('DELETE', '/api/ollama/model', { endpointId, model }),
  ollamaPull: (endpointId: string, model: string) => request<{ model: string; status: string }>('POST', '/api/ollama/pull', { endpointId, model }),
  answer: (questionId: string, answers: string[]) => request('POST', `/api/questions/${questionId}`, { answers }),
  setStorage: (useDatabase: boolean) => request<{ useDatabase: boolean }>('PUT', '/api/storage', { useDatabase }),
  docker: () => request<{ docker: boolean; image: boolean; detail: string; defaultAllow: string[]; denials: string }>('GET', '/api/docker'),
  dockerBuild: () => request<{ ok: boolean; log: string }>('POST', '/api/docker/build'),
  dockerClean: () => request<{ removed: number }>('POST', '/api/docker/clean'),
  decide: (approvalId: string, decision: ApprovalDecision) => request('POST', `/api/approvals/${approvalId}`, { decision }),
  files: (root: string, path: string) => request<{ entries: FileEntry[] }>('GET', `/api/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
  file: (root: string, path: string) => request<{ binary: boolean; size: number; content: string; truncated?: boolean }>('GET', `/api/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
  diff: (root: string, path = '') => request<{ isRepo: boolean; diff: string }>('GET', `/api/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
  downloadUrl: (root: string, path: string) => `/api/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
  git: (root: string) => request<GitInfo>('GET', `/api/git?root=${encodeURIComponent(root)}`),
  gitAction: (root: string, action: string, value = '') => request<{ output: string }>('POST', '/api/git', { root, action, value }),
  shell: (root: string, command?: string, cols?: number, rows?: number) => request<{ shellId: string }>('POST', '/api/shell', { root, command, cols, rows }),
  killShell: (id: string) => request('POST', `/api/shell/${id}/kill`),
  saveAutomation: (a: Partial<Automation>) => request<Automation>('POST', '/api/automations', a),
  deleteAutomation: (id: string) => request('DELETE', `/api/automations/${id}`),
  runAutomation: (id: string) => request<{ started: boolean; runId?: string; reason?: string }>('POST', `/api/automations/${id}/run`),
  automations: () => request<Automation[]>('GET', '/api/automations'),
  run: (id: string) => request<Run>('GET', `/api/runs/${id}`),
  stats: (days: number) => request<Stats>('GET', `/api/stats?days=${days}`),
  claudePlan: () => request<ClaudePlan>('GET', '/api/claude-plan'),
  shells: () => request<ShellsState>('GET', '/api/shells'),
  compare: (input: { teamIds: string[]; task: string; workdir?: string; checkCommand?: string }) => request<{ compareId: string; runs: Run[] }>('POST', '/api/compare', input),
  keepCompare: (id: string, runId: string) => request<{ message: string }>('POST', `/api/compare/${id}/keep`, { runId }),
  discardCompare: (id: string) => request('POST', `/api/compare/${id}/discard`),
  billing: (days: number) => request<Billing>('GET', `/api/billing?days=${days}`),
  resume: (id: string) => request<Run>('POST', `/api/runs/${id}/resume`),
  shellInput: (id: string, text: string) => request('POST', `/api/shell/${id}/input`, { text }),
  server: () => request<{ pid: number; node: string; port: number; startedAt: number; supervisor: any }>('GET', '/api/server'),
  serverLogs: () => request<{ supervisor: string; server: string }>('GET', '/api/server/logs'),
  restartServer: () => request('POST', '/api/server/restart'),
  stopRun: (id: string) => request('POST', `/api/runs/${id}/stop`),
  async upload(file: File, root?: string, dir?: string): Promise<{ path: string; name: string }> {
    const buf = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return request('POST', '/api/uploads', { name: file.name, dataBase64: btoa(binary), root, dir });
  },
};

let socket: WebSocket | null = null;
/** Sends a message on the live socket (terminal keystrokes and size). */
export const wsSend = (m: unknown) => { if (socket?.readyState === 1) socket.send(JSON.stringify(m)); };

export function connectEvents(onEvent: (e: RunEvent) => void, onShell: (c: ShellChunk) => void, onStatus: (online: boolean) => void, onExternal: (s: ExternalSession[]) => void = () => {}) {
  let closed = false;
  let ws: WebSocket;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket = ws;
    ws.onopen = () => onStatus(true);
    ws.onmessage = (m) => {
      const data = JSON.parse(m.data);
      if ('shellId' in data) onShell(data);
      else if ('external' in data) onExternal(data.external);
      else onEvent(data);
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) setTimeout(open, 1500);
    };
  };
  open();
  return () => { closed = true; ws.close(); };
}
