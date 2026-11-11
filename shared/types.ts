// Types shared by the server and the web UI.

export type ProviderId = 'claude' | 'codex' | 'local' | 'demo';
export type Role = 'manager' | 'coder' | 'researcher' | 'reviewer' | 'custom';
export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** read: look only. edit: change files. full: change files and run commands. */
export type Autonomy = 'read' | 'edit' | 'full';
export type Workflow = 'free' | 'superpowers';

export interface Look {
  color: number;
  hair: 'none' | 'tuft' | 'spiky' | 'bun' | 'bob' | 'curls';
  hairColor: string;
  glasses: 'none' | 'round' | 'square';
  accessory: 'none' | 'headphones' | 'cap' | 'bow' | 'antenna';
}

export interface AgentConfig {
  id: string;
  name: string;
  role: Role;
  roleTitle: string;
  provider: ProviderId;
  /** Empty string means "provider default". */
  model: string;
  effort: Effort;
  /** For provider "local": which endpoint from settings to use. */
  endpointId?: string;
  instructions: string;
  /** Superpowers skill folder names to load for this agent. */
  skills: string[];
  look: Look;
  /** Daily token limit for this agent; 0 or missing means no limit. */
  dailyTokens?: number;
  /** A cheaper model for tasks the lead marks as light (mechanical edits, lookups). Empty: always the main model. */
  lightModel?: string;
  /** Used when the main provider is out of usage, rate-limited or down. */
  fallback?: { provider: ProviderId; model: string; endpointId?: string };
}

/** An MCP server the team's agents can use: a local command (stdio) or a URL (streamable HTTP). */
export interface McpServer {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

/** One span of a trace, in OpenTelemetry terms (times in ms). */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'internal' | 'client';
  start: number;
  end: number;
  status: 'ok' | 'error';
  attributes: Record<string, string | number | boolean | undefined>;
}

/** A fixed task with a check, run against teams to see whether a change made them better or worse. */
export interface EvalTask { id: string; prompt: string; check: { kind: 'contains' | 'command'; value: string } }
export interface EvalSuite { id: string; name: string; tasks: EvalTask[] }
export interface EvalResult {
  id: string; suiteId: string; teamId: string; teamName: string; at: number; status: 'running' | 'done';
  versions?: Run['versions'];
  items: { taskId: string; runId?: string; pass?: boolean; tokens?: number; secs?: number; note?: string }[];
}

/** A Claude Code or Codex session you run yourself, read from its transcript. */
export interface ExternalSession {
  id: string;
  tool: 'claude' | 'codex';
  sessionId: string;
  cwd: string;
  title: string;
  lastMessage: string;
  /** working: busy right now · waiting: a tool call sits unanswered (usually an approval) · done: answered, your turn · idle: quiet for a while */
  state: 'working' | 'waiting' | 'done' | 'idle';
  updatedAt: number;
  model: string;
  tokens: { input: number; output: number; cached: number };
  context?: { used: number; limit: number };
  files: string[];
}

/** How a task is handled: "quick" is one cheap answer without tools; "team" is the full lead-and-teammates flow. */
export type RunMode = 'auto' | 'quick' | 'team';

export interface Team {
  id: string;
  name: string;
  description: string;
  agents: AgentConfig[];
  autonomy: Autonomy;
  workflow: Workflow;
  maxRounds: number;
  /** Ask the user before these kinds of actions. Applies to Claude and local agents. */
  approvals: TeamApprovals;
  git: TeamGit;
  /** Optional tech stack the team should use, e.g. "TypeScript, React, Vite, pnpm". */
  stack: string;
  /** Let the lead ask the user clarifying questions before work starts. */
  clarify: boolean;
  /** Where agents run: on this machine, or inside a Docker container that only sees the working folder. */
  isolation: 'none' | 'docker';
  /** Daily limits for the whole team; 0 means no limit. A run stops when one is reached. */
  budget: { dailyUsd: number; dailyTokens: number };
  /** Allow, ask or deny rules for commands and file edits, checked before the approval switches. */
  rules: PermissionRule[];
  /** "auto" answers simple questions cheaply and sends real work to the team; "team" always uses the team. */
  routing: 'auto' | 'team';
  /** Who gives quick answers; empty means the lead. */
  quickAgentId?: string;
  /** Keep notes between runs (decisions, conventions, preferences) and show them to the lead. */
  memory: boolean;
  mcp: McpServer[];
  createdAt: number;
  updatedAt: number;
}

export interface TeamApprovals { edits: boolean; commands: boolean }

export interface TeamGit {
  /** Give every delegated task its own branch and worktree, then merge it back. */
  worktrees: boolean;
  /** Ask the user before a task branch is merged. */
  reviewBeforeMerge: boolean;
  /** Push the branch and open a pull request instead of merging locally. */
  openPr: boolean;
  /** Only merge when the run's check command passes on the branch. */
  requireCheck: boolean;
}

export interface PermissionRule {
  id: string;
  kind: 'command' | 'edit';
  /** Matched against the whole command or file path, case-insensitive. * is a wildcard; without one, the rule matches anything that starts with it. */
  pattern: string;
  action: 'allow' | 'ask' | 'deny';
}

export const TEAM_DEFAULTS: Pick<Team, 'approvals' | 'git' | 'stack' | 'clarify' | 'isolation' | 'budget' | 'rules' | 'routing' | 'memory' | 'mcp'> = {
  approvals: { edits: false, commands: false },
  git: { worktrees: true, reviewBeforeMerge: false, openPr: false, requireCheck: false },
  stack: '',
  clarify: true,
  isolation: 'none',
  budget: { dailyUsd: 0, dailyTokens: 0 },
  rules: [],
  routing: 'auto',
  memory: true,
  mcp: [],
};

export type TaskStatus = 'queued' | 'running' | 'merging' | 'done' | 'failed';
export interface Task {
  id: string;
  runId: string;
  name: string;
  agentId: string;
  brief: string;
  status: TaskStatus;
  branch?: string;
  note?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export type ApprovalKind = 'edit' | 'command' | 'merge';
/** always = for the rest of this run; team = save an allow rule on the team. */
export type ApprovalDecision = 'allow' | 'always' | 'team' | 'deny';
export interface Approval {
  id: string;
  runId: string;
  agentId?: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  status: 'pending' | 'allowed' | 'denied';
  createdAt: number;
}

export interface QuestionItem { question: string; options: string[]; recommended?: string }
/** Questions an agent asks the user before starting, each with suggested answers. */
export interface Question {
  id: string;
  runId: string;
  agentId: string;
  items: QuestionItem[];
  status: 'pending' | 'answered' | 'cancelled';
  answers?: string[];
  createdAt: number;
}

export interface Automation {
  id: string;
  name: string;
  teamId: string;
  task: string;
  workdir: string;
  checkCommand: string;
  kind: 'schedule' | 'webhook' | 'github';
  /** What to watch on GitHub (through the gh CLI in the working folder); used when kind is "github". */
  watch?: 'issues' | 'prs' | 'ci';
  intervalMin?: number;
  /** Items already handled, so each starts at most one run. */
  seen?: string[];
  template?: string;
  /** Five-field cron expression in local time; used when kind is "schedule". */
  cron: string;
  /** Secret path segment; used when kind is "webhook". */
  token: string;
  enabled: boolean;
  lastRunAt?: number;
  lastRunId?: string;
  createdAt: number;
}

export interface UsageRow {
  provider: string; model: string; agent: string; team: string;
  turns: number; inputTokens: number; outputTokens: number; costUsd: number; avgMs: number; failed: number;
}
export interface Stats {
  /** False when the database is off: usage is only recorded with the database on. */
  recording: boolean;
  days: number;
  byModel: UsageRow[];
  byAgent: (UsageRow & { tasksDone: number; tasksFailed: number })[];
  daily: { day: string; inputTokens: number; outputTokens: number; costUsd: number; turns: number }[];
  runs: { total: number; done: number; failed: number; stopped: number };
}

export interface BillingLine { label: string; usd: number }
export interface Billing {
  days: number;
  anthropic: { configured: boolean; error?: string; totalUsd: number; lines: BillingLine[]; daily: { day: string; usd: number }[] };
  openai: { configured: boolean; error?: string; totalUsd: number; lines: BillingLine[]; daily: { day: string; usd: number }[] };
  claude: ClaudePlan;
  codex: { loggedIn: boolean; plan?: string; error?: string; limits: { name: string; usedPercent: number; resetsAt: number | null; windowMins: number | null }[]; daily: { day: string; tokens: number }[] };
}
export interface Spend { usd: number; tokens: number }
/** Claude subscription limits, as Claude Code reports them. */
export interface ClaudePlan {
  /** 'login' when agents use the Claude subscription, 'apiKey' when they use a pay-per-use key, 'none' without either. */
  mode: 'login' | 'apiKey' | 'none';
  plan?: string | null;
  limits: { name: string; usedPercent: number; resetsAt: number | null }[];
  /** Paid usage beyond the plan. When enabled, reaching a limit can cost money. */
  extraUsage?: { enabled: boolean; usedUsd: number | null; limitUsd: number | null } | null;
  /** 'live' = asked just now; 'last-run' = from the most recent agent turn. */
  source?: 'live' | 'last-run';
  at?: number;
  error?: string;
}

export interface FileEntry { name: string; dir: boolean; size: number }
export interface GitInfo {
  isRepo: boolean; branch: string; branches: string[]; changes: string[]; remote: string;
  gh: boolean; prs: { number: number; title: string; headRefName: string; url: string; isDraft: boolean }[];
}

export interface LocalEndpoint {
  id: string;
  name: string;
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  apiKey?: string;
  /** "ollama" uses Ollama's native API (context length, thinking, images). Detected from port 11434 when unset. */
  kind?: 'ollama' | 'openai';
  /** Ollama only: how many tokens of context the model gets. Ollama's own default is too small for agents. */
  contextLength?: number;
}

export interface Settings {
  /** Show your own Claude Code and Codex sessions (read from their transcripts) next to the office's agents. */
  watchExternal?: boolean;
  /** OTLP/HTTP endpoint for traces, e.g. http://localhost:4318; empty keeps traces local only. */
  otlpEndpoint?: string;
  /** Extra headers for the endpoint, "name=value" separated by commas (e.g. Authorization for Langfuse). */
  otlpHeaders?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** Admin keys, only for reading real costs from the providers' billing APIs. */
  anthropicAdminKey?: string;
  openaiAdminKey?: string;
  /** Which login Codex agents use. Auto: the ChatGPT login when present, else the API key. */
  codexAuth?: 'auto' | 'chatgpt' | 'apiKey';
  /** Which login Claude agents use. Auto: the API key when set, else the Claude Code login. */
  claudeAuth?: 'auto' | 'login' | 'apiKey';
  /** Docker isolation: allowlist = only listed hosts through a proxy; open = normal internet; none = no network. */
  dockerNetwork?: 'allowlist' | 'open' | 'none';
  /** Extra domains for the allowlist, besides the providers, GitHub and package registries. */
  dockerAllow?: string[];
  dockerMemory?: string;
  dockerCpus?: number;
  localEndpoints: LocalEndpoint[];
  recentWorkdirs: string[];
}

export type AgentState =
  | 'idle' | 'thinking' | 'reading' | 'writing' | 'running' | 'searching' | 'talking' | 'waiting' | 'done' | 'error';

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped';

export type RunEventBody =
  | { type: 'run_status'; status: RunStatus; message?: string }
  | { type: 'user'; text: string; toAgentId?: string; /** Attached files (absolute paths); images show as thumbnails. */ files?: string[] }
  | { type: 'output'; text: string }
  | { type: 'task'; task: Task }
  | { type: 'approval'; approval: Approval }
  | { type: 'question'; question: Question }
  | { type: 'note'; text: string }
  | { type: 'agent_state'; state: AgentState; detail?: string }
  | { type: 'message'; kind: 'thought' | 'say' | 'final'; text: string }
  | { type: 'tool'; tool: string; detail: string }
  | { type: 'delegate'; toAgentId: string; task: string }
  | { type: 'report'; toAgentId: string; text: string }
  /** inputTokens are fresh input; cachedTokens were re-read from the provider's cache (much cheaper, shown separately). */
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number }
  /** How full an agent's context window is after its last turn. */
  | { type: 'context'; used: number; limit: number; categories?: { name: string; tokens: number }[] }
  /** How the task was routed, and why. */
  | { type: 'route'; mode: 'quick' | 'team'; reason: string; escalated?: boolean }
  | { type: 'memory'; added: string[] }
  | { type: 'check'; attempt: number; ok: boolean; output: string }
  | { type: 'error'; message: string };

export type RunEvent = RunEventBody & { seq: number; ts: number; runId: string; agentId?: string };

export interface Run {
  id: string;
  teamId: string;
  team: Team;
  task: string;
  workdir: string;
  files: string[];
  checkCommand?: string;
  status: RunStatus;
  events: RunEvent[];
  startedAt: number;
  endedAt?: number;
  /** Provider sessions per agent, so a run can continue after a server restart. */
  sessions?: Record<string, unknown>;
  /** The server stopped while this run was working. */
  interrupted?: boolean;
  /** Set when the run is one side of a comparison. */
  compare?: { id: string; branch?: string; repo?: string; discarded?: boolean };
  /** Trace id of the run (OpenTelemetry). */
  traceId?: string;
  /** Short hashes of the instructions and the team setup the run used, to compare results across changes. */
  versions?: { prompt: string; team: string };
  /** Last known context fill per agent. */
  context?: Record<string, { used: number; limit: number; at: number }>;
}

export interface ProviderModel { id: string; label?: string; /** Ollama: completion, tools, vision, thinking… */ capabilities?: string[] }
export interface ProviderStatus {
  id: string;
  provider: ProviderId;
  name: string;
  ok: boolean;
  note: string;
  models: ProviderModel[];
  endpointId?: string;
}

export interface SkillInfo { name: string; description: string }
export interface SkillsState { installed: boolean; skills: SkillInfo[] }

export interface AppState {
  teams: Team[];
  settings: Settings;
  runs: Run[];
  automations: Automation[];
  useDatabase: boolean;
}

/** Messages on the WebSocket that are not run events. */
export interface ShellChunk { shellId: string; chunk?: string; done?: boolean; code?: number | null }
export interface ShellInfo { id: string; root: string; startedAt: number }
export interface ShellsState { pty: boolean; sessions: ShellInfo[] }

export const KEY_MASK = '••••••••';
