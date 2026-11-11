import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { RunMode, PermissionRule, AgentConfig, Approval, ApprovalDecision, ApprovalKind, ProviderId, Question, QuestionItem, Run, RunEvent, RunEventBody, Task, Team } from '../../shared/types.ts';
import { DATA, db, newId, normalizeTeam, store } from './store.ts';
import { leadPrompt, memberPrompt, quickPrompt, withSkillOnce } from './prompts.ts';
import { NEEDS_TEAM, classify } from './router.ts';
import { addMemory, readMemory, takeMemory } from './memory.ts';
import { SUPERPOWERS_DIR, skillText } from './skills.ts';
import { codexDefaultModel } from './providers.ts';
import { commitAll, createWorktree, diffStat, hasCommits, initScratch, isRepo, mergeBranch, openPr, removeWorktree, type Worktree } from './git.ts';
import { clip, type Adapter } from './adapters/types.ts';
import { runInDocker } from './docker.ts';
import { claudeUsesLogin, recordRateLimit } from './claudeplan.ts';
import { acquireFolder, withRepoLock } from './locks.ts';
import { Tracer, providerName, type OpenSpan } from './telemetry.ts';
import { claudeAdapter } from './adapters/claude.ts';
import { codexAdapter } from './adapters/codex.ts';
import { localAdapter } from './adapters/local.ts';
import { demoAdapter } from './adapters/demo.ts';

const adapters: Record<ProviderId, Adapter> = { claude: claudeAdapter, codex: codexAdapter, local: localAdapter, demo: demoAdapter };
const MAX_CHECK_ATTEMPTS = 3;
/** The brainstorming skill asks one question at a time, so allow several rounds before work starts. */
const MAX_QUESTION_ROUNDS = 8;

interface Assignment { to: string; name?: string; task: string; level?: string }
interface Live {
  run: Run;
  abort: AbortController;
  sessions: Map<string, unknown>;
  busy: boolean;
  /** Messages from the user that arrived mid-run, keyed by agent id. */
  notes: Map<string, string[]>;
  /** Approval kinds the user chose "always allow" for in this run. */
  allowed: Set<ApprovalKind>;
  /** One task at a time per agent. */
  agentQueue: Map<string, Promise<unknown>>;
  /** Agents in the middle of a turn right now. */
  working: Set<string>;
  /** One merge at a time per run. */
  mergeQueue: Promise<unknown>;
  worktrees: boolean;
  /** Set when a daily budget stopped the run. */
  budgetHit?: string;
  saveTimer?: ReturnType<typeof setTimeout>;
  /** Images from the user's latest message, given natively to the next agent turn (the one that reads that message). */
  images: string[];
}

/** Out of usage / rate-limited (another provider can help), a passing glitch (try again), or anything else. */
export function errorKind(msg: string): 'limit' | 'transient' | 'other' {
  if (/hit your (5-hour|weekly|usage)|usage limit|rate.?limit|\b429\b|quota|credit balance|out of (usage|credits)|limit reached/i.test(msg)) return 'limit';
  if (/overloaded|\b(500|502|503|504|529)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|stopped unexpectedly|temporarily unavailable/i.test(msg)) return 'transient';
  return 'other';
}

export const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 10);
// The instruction templates the office uses; a change of prompts.ts changes this version.
const PROMPTS_VERSION = (() => { try { return shortHash(fs.readFileSync(new URL('./prompts.ts', import.meta.url), 'utf8')); } catch { return 'unknown'; } })();
const teamVersion = (team: Team) => shortHash(JSON.stringify({ ...team, id: undefined, name: undefined, description: undefined, createdAt: undefined, updatedAt: undefined, agents: team.agents.map((a) => ({ ...a, look: undefined, name: undefined })) }));

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
/** The file list appended to a user message, so every agent (and the lead when it delegates) knows the paths. */
const fileList = (files: string[]) => (files.length
  ? `\n\nAttached files:\n${files.map((f) => `- ${f}`).join('\n')}${files.some((f) => IMAGE_EXT.test(f)) ? '\n(Images are shown to you directly where your model supports it; otherwise open them with your file tools.)' : ''}`
  : '');
const checkFiles = (files: string[] = []) => files.map((f) => {
  const full = path.resolve(f);
  if (!full.startsWith(path.resolve(DATA, 'uploads') + path.sep) || !fs.existsSync(full)) throw new Error(`Attachment not found: ${f}`);
  return full;
});

export interface StartInput { teamId: string; task: string; workdir?: string; files?: string[]; checkCommand?: string; compare?: Run['compare']; mode?: RunMode; /** For evaluations: no questions and no approvals, so nothing waits for a person. */ unattended?: boolean }

export function parseDelegation(text: string): { body: string; assignments: Assignment[] | null; error?: string } {
  const match = /```delegate\s*([\s\S]*?)```/.exec(text);
  if (!match) return { body: text, assignments: null };
  const body = text.replace(match[0], '').trim();
  try {
    const parsed = JSON.parse(match[1]);
    const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((a) => a && typeof a.to === 'string' && typeof a.task === 'string');
    if (!list.length) return { body, assignments: [], error: 'The delegate block had no valid {"to","task"} entries.' };
    return { body, assignments: list };
  } catch (e) {
    return { body, assignments: [], error: `The delegate block was not valid JSON: ${(e as Error).message}` };
  }
}

/** First matching rule wins. * is a wildcard; a pattern without one matches anything starting with it. */
export function matchRule(rules: PermissionRule[], kind: 'command' | 'edit', detail: string): PermissionRule | undefined {
  const text = detail.trim().toLowerCase();
  return rules.find((r) => {
    if (r.kind !== kind || !r.pattern.trim()) return false;
    const p = r.pattern.trim().toLowerCase();
    if (!p.includes('*')) return text.startsWith(p);
    const re = new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
    return re.test(text);
  });
}

export function parseQuestions(text: string): { body: string; items: QuestionItem[] } | null {
  const match = /```questions\s*([\s\S]*?)```/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    const items = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((q) => q && typeof q.question === 'string')
      .map((q) => ({ question: String(q.question), options: Array.isArray(q.options) ? q.options.map(String).slice(0, 5) : [], recommended: q.recommended ? String(q.recommended) : undefined }))
      .slice(0, 5);
    return items.length ? { body: text.replace(match[0], '').trim(), items } : null;
  } catch {
    return null;
  }
}

export function runCommand(command: string, cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, signal, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim().slice(-8000) || '(no output)' });
    });
  });
}

export class Orchestrator {
  private live = new Map<string, Live>();
  private runs = new Map<string, Run>();
  private pending = new Map<string, { live: Live; approval: Approval; resolve: (ok: boolean) => void }>();
  private asked = new Map<string, { live: Live; question: Question; resolve: (answers: string[]) => void }>();

  readonly tracer = new Tracer(() => store.settings());

  constructor(private broadcast: (event: RunEvent) => void) {
    for (const run of db.loadRuns(40)) {
      run.team = normalizeTeam(run.team);
      if (run.status === 'running') {
        // The server stopped while this run was working. It can be resumed from the UI.
        run.status = 'stopped';
        run.interrupted = true;
        run.endedAt = run.endedAt ?? Date.now();
        db.saveRun(run);
      }
      this.runs.set(run.id, run);
    }
  }

  list = () => [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  get = (id: string) => this.runs.get(id);
  isBusy = (id: string) => !!this.live.get(id)?.busy;

  /** Provider session ids the office created, so its own sessions are not shown again as outside sessions. */
  knownSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const run of this.runs.values()) for (const s of Object.values(run.sessions ?? {})) if (typeof s === 'string') ids.add(s);
    return ids;
  }

  start(input: StartInput): Run {
    const team = store.team(input.teamId);
    if (!team) throw new Error('Team not found.');
    if (!team.agents.length) throw new Error('This team has no agents.');
    if (!input.task.trim()) throw new Error('The task is empty.');

    const id = newId();
    let workdir = input.workdir?.trim();
    if (workdir) {
      if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) throw new Error(`Folder not found: ${workdir}`);
    } else {
      workdir = path.join(DATA, 'workspaces', id);
      fs.mkdirSync(workdir, { recursive: true });
      initScratch(workdir);
    }

    const run: Run = {
      id, teamId: team.id, team: input.unattended ? { ...structuredClone(team), clarify: false, memory: false, approvals: { edits: false, commands: false }, git: { ...team.git, reviewBeforeMerge: false } } : structuredClone(team), task: input.task.trim(), workdir,
      files: checkFiles(input.files), checkCommand: input.checkCommand?.trim() || undefined,
      status: 'running', events: [], startedAt: Date.now(), compare: input.compare,
      versions: { prompt: PROMPTS_VERSION, team: teamVersion(team) },
    };
    const live = this.makeLive(run);
    this.runs.set(id, run);
    db.saveRun(run);

    const settings = store.settings();
    if (input.workdir?.trim() && !input.compare) {
      store.saveSettings({ ...settings, recentWorkdirs: [workdir, ...settings.recentWorkdirs.filter((w) => w !== workdir)].slice(0, 8) });
    }

    this.emit(live, { type: 'user', text: run.task, ...(run.files.length ? { files: run.files } : {}) });
    live.images = run.files.filter((f) => IMAGE_EXT.test(f));
    void this.drive(live, `${run.task}${fileList(run.files)}`, undefined, this.route(run.team, run.task, run.files, input.mode));
    return run;
  }

  /**
   * A message from the user to a run. To the whole team (no agent) or to one agent.
   * If the target is working, the message is queued and delivered with its next prompt.
   */
  /** Quick answer or team? An explicit choice wins; otherwise the team's routing setting and the task decide. */
  private route(team: Run['team'], text: string, files: string[], mode: RunMode = 'auto'): { mode: 'quick' | 'team'; reason: string } {
    if (mode === 'quick') return { mode: 'quick', reason: 'you chose a quick answer' };
    if (mode === 'team' || team.routing === 'team') return { mode: 'team', reason: mode === 'team' ? 'you chose the team' : 'this team always works as a team' };
    return classify(text, files);
  }

  message(id: string, text: string, agentId?: string, attached: string[] = [], mode: RunMode = 'auto'): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error('Run not found.');
    if (!text.trim()) throw new Error('The message is empty.');
    const files = checkFiles(attached);
    const live = this.live.get(id) ?? this.makeLive(run);
    const lead = run.team.agents.find((a) => a.role === 'manager') ?? run.team.agents[0];
    const target = agentId ? run.team.agents.find((a) => a.id === agentId) : undefined;
    if (agentId && !target) throw new Error('Agent not found in this run.');

    this.emit(live, { type: 'user', text, toAgentId: target?.id, ...(files.length ? { files } : {}) });
    const full = `${text}${fileList(files)}`;
    if (live.busy) {
      // A teammate who is free answers right away, in parallel with the rest of the team.
      if (target && target.id !== lead.id && !live.working.has(target.id)) {
        void this.sideTurn(live, target, full, files.filter((f) => IMAGE_EXT.test(f)));
        return run;
      }
      const key = (target ?? lead).id;
      live.notes.set(key, [...(live.notes.get(key) ?? []), full]);
      this.emit(live, { type: 'note', text: `${(target ?? lead).name} is working; the message is delivered with their next turn.` }, (target ?? lead).id);
      return run;
    }
    live.abort = new AbortController();
    run.status = 'running';
    run.endedAt = undefined;
    live.images = files.filter((f) => IMAGE_EXT.test(f));
    void this.drive(live, full, target, target ? undefined : this.route(run.team, text, files, mode));
    return run;
  }

  /** Continues a run that the server stopped by restarting. Agents keep their provider sessions. */
  resume(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error('Run not found.');
    run.interrupted = false;
    return this.message(id, `The server restarted while the team was working on this. Check what is already done in the working folder, then continue the original task until it is finished:\n\n${run.task}`);
  }

  /**
   * Frees an agent's context: "compact" asks the provider to summarise the conversation so far (the agent keeps
   * the gist), "fresh" forgets it and the next turn starts a new session.
   */
  async compact(id: string, agentId: string, how: 'compact' | 'fresh'): Promise<Run> {
    const run = this.runs.get(id);
    if (!run) throw new Error('Run not found.');
    // Runs from before a restart have no live state yet; their sessions are restored from the saved run.
    const live = this.live.get(id) ?? this.makeLive(run);
    if (live.busy) throw new Error('Wait until the team is idle.');
    const agent = live.run.team.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error('No such agent in this run.');
    if (how === 'fresh' || !live.sessions.has(agent.id)) {
      live.sessions.delete(agent.id);
      const { [agent.id]: _s, ...sessions } = live.run.sessions ?? {};
      const { [agent.id]: _c, ...context } = live.run.context ?? {};
      live.run.sessions = sessions;
      live.run.context = context;
      this.emit(live, { type: 'note', text: `${agent.name} starts the next turn with an empty context.` }, agent.id);
    } else {
      live.busy = true;
      live.abort = new AbortController();
      this.emit(live, { type: 'agent_state', state: 'thinking', detail: 'compacting' }, agent.id);
      try {
        await this.turn(live, agent, '', '', live.run.workdir, false, { op: 'compact' });
        this.emit(live, { type: 'note', text: `${agent.name}'s conversation was summarised to free context.` }, agent.id);
      } finally {
        live.busy = false;
        this.emit(live, { type: 'agent_state', state: 'idle' }, agent.id);
      }
    }
    live.run.sessions = Object.fromEntries(live.sessions);
    db.saveRun(live.run);
    return live.run;
  }

  stop(id: string) {
    const live = this.live.get(id);
    if (live?.busy) live.abort.abort();
  }

  decide(approvalId: string, decision: ApprovalDecision) {
    const entry = this.pending.get(approvalId);
    if (!entry) throw new Error('This approval is no longer waiting.');
    this.pending.delete(approvalId);
    entry.approval.status = decision === 'deny' ? 'denied' : 'allowed';
    if (decision === 'always') entry.live.allowed.add(entry.approval.kind);
    if (decision === 'team' && entry.approval.kind !== 'merge') {
      const rule: PermissionRule = { id: newId(), kind: entry.approval.kind === 'edit' ? 'edit' : 'command', pattern: entry.approval.detail.trim().slice(0, 300), action: 'allow' };
      const team = store.team(entry.live.run.teamId);
      if (team) store.saveTeam({ ...team, rules: [...team.rules, rule] });
      entry.live.run.team.rules = [...entry.live.run.team.rules, rule];
    }
    db.saveApproval(entry.approval);
    this.emit(entry.live, { type: 'approval', approval: { ...entry.approval } }, entry.approval.agentId);
    entry.resolve(decision !== 'deny');
  }

  answer(questionId: string, answers: string[]) {
    const entry = this.asked.get(questionId);
    if (!entry) throw new Error('This question is no longer waiting.');
    this.asked.delete(questionId);
    entry.question.status = 'answered';
    entry.question.answers = entry.question.items.map((_, i) => String(answers[i] ?? '').trim() || '(no answer, decide yourself)');
    this.emit(entry.live, { type: 'question', question: { ...entry.question } }, entry.question.agentId);
    entry.resolve(entry.question.answers);
  }

  /** Shows the agent's questions to the user and returns the text to send back to the agent. */
  private askUser(live: Live, agent: AgentConfig, items: QuestionItem[]): Promise<string> {
    const question: Question = { id: newId(), runId: live.run.id, agentId: agent.id, items, status: 'pending', createdAt: Date.now() };
    this.emit(live, { type: 'question', question: { ...question } }, agent.id);
    this.emit(live, { type: 'agent_state', state: 'waiting', detail: 'has questions' }, agent.id);
    const format = (answers: string[]) => `Answers from the user:\n${items.map((q, i) => `${i + 1}. ${q.question}\n   → ${answers[i]}`).join('\n')}\n\nNow proceed. Do not ask again.`;
    return new Promise((resolve, reject) => {
      this.asked.set(question.id, { live, question, resolve: (answers) => resolve(format(answers)) });
      live.abort.signal.addEventListener('abort', () => {
        if (!this.asked.delete(question.id)) return;
        question.status = 'cancelled';
        this.emit(live, { type: 'question', question: { ...question } }, agent.id);
        reject(new Error('aborted'));
      }, { once: true });
    });
  }

  private makeLive(run: Run): Live {
    run.team = normalizeTeam(run.team);
    const live: Live = {
      run, abort: new AbortController(), sessions: new Map(Object.entries(run.sessions ?? {})), busy: false, notes: new Map(), allowed: new Set(),
      agentQueue: new Map(), working: new Set(), mergeQueue: Promise.resolve(), worktrees: false, images: [],
    };
    this.live.set(run.id, live);
    return live;
  }

  private emit(live: Live, body: RunEventBody, agentId?: string) {
    const event = { ...body, seq: live.run.events.length, ts: Date.now(), runId: live.run.id, agentId } as RunEvent;
    live.run.events.push(event);
    db.addEvent(event);
    this.broadcast(event);
    // Keep the stored run close to live, so little is lost if the server stops.
    if (!live.saveTimer) live.saveTimer = setTimeout(() => { live.saveTimer = undefined; db.saveRun(live.run); }, 1500);
  }

  /** Throws when today's spend of the team or agent has reached its limit. */
  private checkBudget(live: Live, agent: AgentConfig, extra = { usd: 0, tokens: 0 }) {
    const { team } = live.run;
    const t = db.spend(team.name);
    const a = db.spend(team.name, agent.name);
    const over =
      team.budget.dailyUsd > 0 && t.usd + extra.usd >= team.budget.dailyUsd ? `the team's daily cost limit of $${team.budget.dailyUsd}`
      : team.budget.dailyTokens > 0 && t.tokens + extra.tokens >= team.budget.dailyTokens ? `the team's daily limit of ${team.budget.dailyTokens.toLocaleString('en-US')} tokens`
      : agent.dailyTokens && a.tokens + extra.tokens >= agent.dailyTokens ? `${agent.name}'s daily limit of ${agent.dailyTokens.toLocaleString('en-US')} tokens`
      : '';
    if (!over) return;
    live.budgetHit = `Stopped: ${over} was reached. Raise it in the team editor or continue tomorrow.`;
    live.abort.abort();
    throw new Error(live.budgetHit);
  }

  private saveTask(live: Live, task: Task) {
    const agent = live.run.team.agents.find((a) => a.id === task.agentId);
    db.saveTask(task, live.run.teamId, agent?.name ?? '?');
    this.emit(live, { type: 'task', task: { ...task } }, task.agentId);
  }

  /** Asks the user. Other agents keep working while this one waits. */
  private requestApproval(live: Live, agentId: string | undefined, kind: ApprovalKind, title: string, detail: string): Promise<boolean> {
    if (kind !== 'merge') {
      const rule = matchRule(live.run.team.rules, kind === 'edit' ? 'edit' : 'command', detail);
      if (rule?.action === 'deny') {
        this.emit(live, { type: 'note', text: `Blocked by rule "${rule.pattern}": ${detail.slice(0, 200)}` }, agentId);
        return Promise.resolve(false);
      }
      if (rule?.action === 'allow') return Promise.resolve(true);
      const flag = kind === 'edit' ? live.run.team.approvals.edits : live.run.team.approvals.commands;
      if (!rule && !flag) return Promise.resolve(true); // Only asked because of a rule that did not match.
    }
    if (live.allowed.has(kind)) return Promise.resolve(true);
    if (live.abort.signal.aborted) return Promise.resolve(false);
    const approval: Approval = { id: newId(), runId: live.run.id, agentId, kind, title, detail: detail.slice(0, 4000), status: 'pending', createdAt: Date.now() };
    db.saveApproval(approval);
    this.emit(live, { type: 'approval', approval: { ...approval } }, agentId);
    if (agentId) this.emit(live, { type: 'agent_state', state: 'waiting', detail: clip(title, 60) }, agentId);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        if (agentId) this.emit(live, { type: 'agent_state', state: 'thinking' }, agentId);
        resolve(ok);
      };
      this.pending.set(approval.id, { live, approval, resolve: done });
      live.abort.signal.addEventListener('abort', () => {
        if (!this.pending.delete(approval.id)) return;
        approval.status = 'denied';
        db.saveApproval(approval);
        this.emit(live, { type: 'approval', approval: { ...approval } }, agentId);
        resolve(false);
      }, { once: true });
    });
  }

  private async drive(live: Live, userMessage: string, direct?: AgentConfig, route?: { mode: 'quick' | 'team'; reason: string }) {
    const { run } = live;
    live.busy = true;
    const traceStart = Date.now();
    this.tracer.beginRun(run);
    this.emit(live, { type: 'run_status', status: 'running' });
    let release = () => {};
    try {
      const team = run.team;
      live.worktrees = team.git.worktrees && team.agents.length > 1 && (await isRepo(run.workdir)) && (await hasCommits(run.workdir));
      release = await acquireFolder(run.workdir, run.id, live.worktrees, (blockers) => {
        this.emit(live, { type: 'note', text: `Waiting: run ${blockers.join(', ')} is working in this folder. This run starts when it finishes, so the two never edit the same files at once.` });
        for (const a of team.agents) this.emit(live, { type: 'agent_state', state: 'waiting', detail: 'folder busy' }, a.id);
      }, live.abort.signal);
      const lead0 = team.agents.find((a) => a.role === 'manager') ?? team.agents[0];
      let answered = false;
      if (!direct && route?.mode === 'quick') {
        const quick = team.agents.find((a) => a.id === team.quickAgentId) ?? lead0;
        this.emit(live, { type: 'route', mode: 'quick', reason: `${route.reason}: ${quick.name} answers alone` });
        const memory = team.memory ? readMemory(team.id) : '';
        const reply = (await this.turn(live, quick, quickPrompt(team, quick, this.modelLabel(quick), memory), userMessage, run.workdir, false, { lean: true })).trim();
        if (reply.replace(/[`*.\s]/g, '').toUpperCase() === NEEDS_TEAM) {
          this.emit(live, { type: 'route', mode: 'team', reason: `${quick.name} needs files or tools for this, so the team takes over`, escalated: true });
        } else {
          this.emit(live, { type: 'message', kind: 'final', text: reply }, quick.id);
          answered = true;
        }
      } else if (!direct && route) {
        this.emit(live, { type: 'route', mode: 'team', reason: route.reason });
      }
      if (answered) { /* done */ } else if (direct) {
        const lead = lead0;
        const text = await this.turn(live, direct, memberPrompt(team, direct, direct.id === lead.id ? undefined : lead, this.modelLabel(direct)), `[direct] ${userMessage}`, run.workdir);
        this.emit(live, { type: 'message', kind: 'final', text }, direct.id);
      } else {
        let message = userMessage;
        for (let attempt = 1; ; attempt++) {
          await this.conversation(live, message);
          if (!run.checkCommand) break;
          const check = await runCommand(run.checkCommand, run.workdir, live.abort.signal);
          this.emit(live, { type: 'check', attempt, ok: check.ok, output: check.output });
          if (check.ok) break;
          if (attempt >= MAX_CHECK_ATTEMPTS) throw new Error(`The check "${run.checkCommand}" still fails after ${MAX_CHECK_ATTEMPTS} attempts.`);
          message = `The check command \`${run.checkCommand}\` failed (attempt ${attempt} of ${MAX_CHECK_ATTEMPTS}). Fix the cause.\n\nOutput:\n${check.output}`;
        }
      }
      run.status = 'done';
    } catch (e) {
      const stopped = live.abort.signal.aborted;
      run.status = stopped ? 'stopped' : 'failed';
      if (live.budgetHit) this.emit(live, { type: 'error', message: live.budgetHit });
      else if (!stopped) this.emit(live, { type: 'error', message: (e as Error).message });
      live.budgetHit = undefined;
    }
    release();
    run.endedAt = Date.now();
    this.tracer.finishRun(run, traceStart);
    for (const a of run.team.agents) this.emit(live, { type: 'agent_state', state: 'idle' }, a.id);
    this.emit(live, { type: 'run_status', status: run.status });
    live.busy = false;
    run.sessions = Object.fromEntries(live.sessions);
    clearTimeout(live.saveTimer);
    live.saveTimer = undefined;
    db.saveRun(run);

    // Messages that arrived after their target's last turn would otherwise be lost: deliver them now.
    const lead = run.team.agents.find((a) => a.role === 'manager') ?? run.team.agents[0];
    const [agentId, late] = [...live.notes.entries()].find(([, n]) => n.length) ?? [];
    if (agentId && late && run.status !== 'stopped') {
      live.notes.delete(agentId);
      live.abort = new AbortController();
      run.status = 'running';
      run.endedAt = undefined;
      void this.drive(live, late.join('\n\n'), agentId === lead.id ? undefined : run.team.agents.find((a) => a.id === agentId));
    }
  }

  /** One user message → lead/member rounds → final answer. */
  private async conversation(live: Live, message: string) {
    const team = live.run.team;
    const lead = team.agents.find((a) => a.role === 'manager') ?? team.agents[0];
    const members = team.agents.filter((a) => a.id !== lead.id);

    if (!members.length) {
      const system = memberPrompt(team, lead, undefined, this.modelLabel(lead), true, team.memory ? readMemory(team.id) : '');
      let text = await this.turn(live, lead, system, withSkillOnce(message, !live.sessions.has(lead.id), team.clarify), live.run.workdir);
      for (let asked = 0; team.clarify && asked < MAX_QUESTION_ROUNDS; asked++) {
        const questions = parseQuestions(text);
        if (!questions) break;
        text = await this.turn(live, lead, system, await this.askUser(live, lead, questions.items), live.run.workdir);
      }
      this.emit(live, { type: 'message', kind: 'final', text: this.keepMemory(live, text.replace(/```questions[\s\S]*?```/g, '').trim()) || 'Done.' }, lead.id);
      return;
    }

    let prompt = withSkillOnce(message, !live.sessions.has(lead.id), team.clarify);
    let questionRounds = 0;
    let delegated = false;
    // Read once per conversation so the system prompt stays identical across rounds (provider prompt caches stay warm).
    const system = leadPrompt(team, lead, { worktrees: live.worktrees, modelLabel: this.modelLabel(lead), memory: team.memory ? readMemory(team.id) : '' });
    for (let round = 1; round <= team.maxRounds; round++) {
      const reply = await this.turn(live, lead, system, prompt, live.run.workdir);
      // Questions are allowed until the first work is handed out.
      const questions = team.clarify && !delegated && questionRounds < MAX_QUESTION_ROUNDS ? parseQuestions(reply) : null;
      if (questions) {
        questionRounds++;
        prompt = await this.askUser(live, lead, questions.items);
        round--; // Clarifying is not a work round.
        continue;
      }
      const { body, assignments, error } = parseDelegation(reply);

      if (!assignments) {
        this.emit(live, { type: 'message', kind: 'final', text: this.keepMemory(live, body) || 'Done.' }, lead.id);
        return;
      }

      delegated = true;
      const jobs: Promise<string>[] = [];
      const problems: string[] = error ? [error] : [];
      for (const a of assignments) {
        const agent = members.find((m) => m.name.toLowerCase() === a.to.trim().toLowerCase());
        if (!agent) {
          problems.push(`There is no teammate named "${a.to}". Teammates: ${members.map((m) => m.name).join(', ')}.`);
          continue;
        }
        const task = this.newTask(live, agent, a.name?.trim() || clip(a.task, 48), a.task);
        this.emit(live, { type: 'delegate', toAgentId: agent.id, task: a.task }, lead.id);
        // Tasks for the same agent wait for each other; tasks for different agents run together.
        const previous = live.agentQueue.get(agent.id) ?? Promise.resolve();
        // Light tasks run on the teammate's cheaper model when it has one.
        const worker = a.level === 'light' && agent.lightModel ? { ...agent, model: agent.lightModel } : agent;
        const job = previous.catch(() => {}).then(() => this.runTask(live, lead, worker, task));
        live.agentQueue.set(agent.id, job);
        jobs.push(job);
      }

      const reports = await Promise.all(jobs);
      prompt = `Reports from your team:\n\n${[...reports, ...problems.map((p) => `### Problem\n${p}`)].join('\n\n')}`;
      if (round === team.maxRounds - 1) prompt += '\n\nThis is the last round. Finish with a summary and no delegate block.';
    }
    throw new Error(`The team did not finish within ${team.maxRounds} rounds.`);
  }

  private newTask(live: Live, agent: AgentConfig, name: string, brief: string): Task {
    const task: Task = { id: newId(), runId: live.run.id, name, agentId: agent.id, brief, status: 'queued', createdAt: Date.now() };
    this.saveTask(live, task);
    return task;
  }

  /** Runs one task and returns the text that goes back to the lead. Never throws except when the run is stopped. */
  private async runTask(live: Live, lead: AgentConfig | undefined, agent: AgentConfig, task: Task): Promise<string> {
    const { run } = live;
    let worktree: Worktree | undefined;
    task.status = 'running';
    task.startedAt = Date.now();
    try {
      if (live.worktrees && lead) {
        worktree = await createWorktree(run.workdir, run.id, task.id, agent.name);
        task.branch = worktree.branch;
      }
      this.saveTask(live, task);
      const text = await this.turn(live, agent, memberPrompt(run.team, agent, lead, this.modelLabel(agent)), task.brief, worktree?.dir ?? run.workdir, !!worktree);
      let gitNote = '';
      if (worktree) {
        task.status = 'merging';
        this.saveTask(live, task);
        const wt = worktree;
        const merge = withRepoLock(run.workdir, () => this.integrate(live, agent, task, wt));
        gitNote = await merge;
        task.note = gitNote;
      }
      task.status = 'done';
      task.endedAt = Date.now();
      this.saveTask(live, task);
      if (lead) this.emit(live, { type: 'report', toAgentId: lead.id, text }, agent.id);
      // The lead reads every report; a capped report keeps its context for planning. The full text stays in the feed.
      const report = text.length > 3000 ? `${text.slice(0, 1500)}\n… (shortened; full report in the activity feed) …\n${text.slice(-1200)}` : text;
      return `### Report from ${agent.name} — task "${task.name}"\n${report}${gitNote ? `\n\nGit: ${gitNote}` : ''}`;
    } catch (e) {
      const message = (e as Error).message;
      task.status = 'failed';
      task.note = clip(message, 300);
      task.endedAt = Date.now();
      this.saveTask(live, task);
      if (worktree) await removeWorktree(worktree, false).catch(() => {});
      if (live.abort.signal.aborted || !lead) throw e;
      this.emit(live, { type: 'error', message }, agent.id);
      return `### ${agent.name} failed — task "${task.name}"\n${message}`;
    }
  }

  /** Commits a finished task branch and brings it back according to the team's git rules. */
  private async integrate(live: Live, agent: AgentConfig, task: Task, wt: Worktree): Promise<string> {
    const { run } = live;
    const rules = run.team.git;
    const note = (text: string) => { this.emit(live, { type: 'note', text: `${wt.branch}: ${text}` }, agent.id); return text; };
    let keepBranch = true;
    try {
      if (!(await commitAll(wt.dir, `${task.name} (${agent.name})`))) {
        keepBranch = false;
        return note('no file changes.');
      }
      if (rules.requireCheck && run.checkCommand) {
        const check = await runCommand(run.checkCommand, wt.dir, live.abort.signal);
        this.emit(live, { type: 'check', attempt: 1, ok: check.ok, output: check.output }, agent.id);
        if (!check.ok) return note(`NOT merged, the check failed on this branch. The work is kept on branch ${wt.branch}.\n${check.output.slice(-1500)}`);
      }
      const stat = await diffStat(run.workdir, wt.branch);
      if (rules.reviewBeforeMerge && !(await this.requestApproval(live, agent.id, 'merge', `Merge "${task.name}" by ${agent.name}?`, `${wt.branch}\n\n${stat}`))) {
        return note(`NOT merged, the user rejected it in review. The work is kept on branch ${wt.branch}.`);
      }
      if (rules.openPr) {
        const url = await openPr(run.workdir, wt.branch, task.name, `${task.brief}\n\nOpened by ${agent.name} (Big Eyes Office).`);
        return note(`pull request opened: ${url}`);
      }
      const merged = await mergeBranch(run.workdir, wt.branch);
      if (!merged.ok) return note(`NOT merged because of a conflict. The work is kept on branch ${wt.branch}.\n${merged.detail}`);
      keepBranch = false;
      return note(`merged.\n${stat}`);
    } catch (e) {
      return note(`NOT merged: ${(e as Error).message}`);
    } finally {
      await removeWorktree(wt, !keepBranch).catch(() => {});
    }
  }

  private modelLabel(agent: AgentConfig): string {
    if (agent.model) return agent.model;
    if (agent.provider === 'codex') return codexDefaultModel() || 'the Codex default (not specified)';
    return agent.provider === 'demo' ? 'none (simulated)' : 'the provider default (not specified)';
  }

  /**
   * A direct message to a free teammate while the team works. It waits for any task already queued for that
   * agent (one turn per agent at a time), answers in its own session, and the lead hears about it.
   */
  private async sideTurn(live: Live, agent: AgentConfig, message: string, images: string[]) {
    const run = live.run;
    const lead = run.team.agents.find((a) => a.role === 'manager') ?? run.team.agents[0];
    const previous = live.agentQueue.get(agent.id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      try {
        live.images = images;
        const system = `${memberPrompt(run.team, agent, lead, this.modelLabel(agent))}
The user is talking to you directly while the rest of the team works on its tasks. Answer them; change files only if they ask you to.`;
        const text = await this.turn(live, agent, system, message, run.workdir);
        this.emit(live, { type: 'message', kind: 'final', text }, agent.id);
        // The lead should know what the user arranged with a teammate.
        live.notes.set(lead.id, [...(live.notes.get(lead.id) ?? []), `(The user spoke to ${agent.name} directly. ${agent.name} answered: ${clip(text, 600)})`]);
      } catch (e) {
        if (!live.abort.signal.aborted) this.emit(live, { type: 'error', message: `${agent.name}: ${(e as Error).message}` });
      } finally {
        this.emit(live, { type: 'agent_state', state: 'idle' }, agent.id);
      }
    });
    live.agentQueue.set(agent.id, job);
    await job;
  }

  private usageAttrs(u: { inputTokens: number; outputTokens: number; costUsd: number; cachedTokens?: number }, ctx?: { used: number; limit: number }) {
    return {
      'gen_ai.usage.input_tokens': u.inputTokens, 'gen_ai.usage.output_tokens': u.outputTokens,
      'gen_ai.usage.cache_read.input_tokens': u.cachedTokens || undefined, 'beo.cost_usd': u.costUsd || undefined,
      'beo.context.used': ctx?.used, 'beo.context.limit': ctx?.limit,
    };
  }

  /** Pulls ```memory blocks out of the lead's final answer and saves them to the team's memory. */
  private keepMemory(live: Live, text: string): string {
    const { text: rest, lines } = takeMemory(text);
    if (live.run.team.memory && lines.length) {
      const added = addMemory(live.run.team.id, lines);
      if (added.length) this.emit(live, { type: 'memory', added });
    }
    return rest;
  }

  private async turn(live: Live, agent: AgentConfig, systemPrompt: string, prompt: string, cwd: string, fresh = false, opts: { lean?: boolean; op?: 'compact' } = {}): Promise<string> {
    const team = live.run.team;
    const hasPlugin = team.workflow === 'superpowers' && fs.existsSync(SUPERPOWERS_DIR);
    // Claude loads the plugin natively; other providers get the selected skills as text.
    const extra = agent.provider !== 'claude' && agent.skills.length ? skillText(agent.skills) : '';
    const notes = live.notes.get(agent.id);
    if (notes?.length) {
      live.notes.delete(agent.id);
      prompt = `${notes.map((n) => `Message from the user: ${n}`).join('\n')}\n\n${prompt}`;
    }
    this.checkBudget(live, agent);
    // Compact early, at 75%: the model's own summary keeps what matters, and the next turn has room to work
    // instead of hitting the limit halfway (which forces a rushed automatic compaction or drops old turns).
    const ctx = live.run.context?.[agent.id];
    if (!opts.lean && !opts.op && !fresh && ctx && ctx.used / ctx.limit >= 0.75 && live.sessions.has(agent.id) && agent.provider !== 'local' && agent.provider !== 'demo') {
      this.emit(live, { type: 'note', text: `${agent.name}'s context is ${Math.round((100 * ctx.used) / ctx.limit)}% full; summarising earlier turns first.` }, agent.id);
      await this.turn(live, agent, '', '', cwd, false, { op: 'compact' }).catch(() => {});
      const { [agent.id]: _old, ...rest } = live.run.context ?? {};
      live.run.context = rest;
    }
    live.working.add(agent.id);
    const started = Date.now();
    const span = this.tracer.start(live.run, `invoke_agent ${agent.name}`, {
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': providerName(agent), 'gen_ai.request.model': agent.model || 'default',
      'gen_ai.agent.name': agent.name, 'gen_ai.agent.id': agent.id, 'gen_ai.request.reasoning_effort': agent.effort === 'default' ? undefined : agent.effort,
      'beo.turn.kind': opts.op ?? (opts.lean ? 'quick' : 'turn'), 'beo.prompt.hash': shortHash(systemPrompt),
    }, undefined, 'client');
    let toolSpan: OpenSpan | undefined;
    const endTool = () => { toolSpan?.finish(); toolSpan = undefined; };
    let acted = false; // once a tool ran, repeating the turn could repeat its actions
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, cachedTokens: 0 };
    // On the Claude subscription the SDK still reports an API-price estimate; nothing is charged, so it is not recorded as cost.
    const onPlan = agent.provider === 'claude' && claudeUsesLogin(store.settings());
    const record = (ok: boolean) => db.addUsage({
      runId: live.run.id, team: team.name, agent: agent.name, provider: agent.provider, model: this.modelLabel(agent),
      ...usage, durationMs: Date.now() - started, ok,
    });
    try {
      const adapterInput: Parameters<Adapter>[0] = {
        agent,
        systemPrompt: extra ? `${systemPrompt}\n\n${extra}` : systemPrompt,
        prompt, cwd,
        autonomy: team.autonomy,
        settings: store.settings(),
        signal: live.abort.signal,
        // A task in its own worktree starts clean: provider sessions are tied to a folder. Quick answers keep none.
        session: fresh || opts.lean ? undefined : live.sessions.get(agent.id),
        lean: opts.lean,
        op: opts.op,
        mcp: opts.lean ? [] : team.mcp.filter((m) => m.enabled),
        pluginPath: hasPlugin && agent.provider === 'claude' ? SUPERPOWERS_DIR : undefined,
        // The turn that reads the user's message gets its images; later turns see the paths in the text.
        images: live.images.splice(0),
        teammates: team.agents.filter((a) => a.id !== agent.id).map((a) => a.name),
        // Adapters route actions through approve() when a switch is on or a rule exists for that kind.
        ask: { edits: team.approvals.edits || team.rules.some((r) => r.kind === 'edit'), commands: team.approvals.commands || team.rules.some((r) => r.kind === 'command') },
        approve: (kind, title, detail) => this.requestApproval(live, agent.id, kind, title, detail),
        emit: (e) => {
          if (e.type === 'plan') { recordRateLimit(e.info); return; }
          if (e.type === 'context') {
            if (opts.lean) return; // A one-off quick answer says nothing about the agent's working context.
            live.run.context = { ...live.run.context, [agent.id]: { used: e.used, limit: e.limit, at: Date.now() } };
          }
          if (e.type === 'tool') {
            endTool();
            acted = true;
            toolSpan = this.tracer.start(live.run, `execute_tool ${e.tool}`, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': e.tool, 'gen_ai.agent.name': agent.name, 'beo.tool.detail': clip(e.detail, 200) }, span.span.spanId);
          } else if (e.type === 'message' || e.type === 'usage') endTool();
          if (e.type === 'state') this.emit(live, { type: 'agent_state', state: e.state, detail: e.detail }, agent.id);
          else if (e.type === 'message') {
            const text = e.text.replace(/```(delegate|questions)[\s\S]*?```/g, '').trim();
            if (text) this.emit(live, { type: 'message', kind: e.kind, text }, agent.id);
          } else {
            if (e.type === 'usage') {
              if (onPlan) e = { ...e, costUsd: undefined };
              usage.inputTokens += e.inputTokens;
              usage.outputTokens += e.outputTokens;
              usage.cachedTokens += e.cachedTokens ?? 0;
              usage.costUsd += e.costUsd ?? 0;
              try { this.checkBudget(live, agent, { usd: usage.costUsd, tokens: usage.inputTokens + usage.outputTokens }); } catch { /* the abort stops the turn */ }
            }
            this.emit(live, e, agent.id);
          }
        },
      };
      const call = (input: typeof adapterInput) => (team.isolation === 'docker' ? runInDocker(input.agent.provider, input) : adapters[input.agent.provider](input));
      let result: Awaited<ReturnType<Adapter>> | undefined;
      let fellBack = false;
      for (let attempt = 0; !result; attempt++) {
        try {
          result = await call(fellBack ? { ...adapterInput, agent: { ...agent, ...agent.fallback! }, session: undefined } : adapterInput);
        } catch (e) {
          if (live.abort.signal.aborted) throw e;
          const kind = errorKind((e as Error).message);
          if (kind === 'limit' && agent.fallback?.provider && !fellBack) {
            fellBack = true;
            this.emit(live, { type: 'note', text: `${agent.name}: ${providerName(agent)} is out of usage or rate-limited, so this turn runs on the fallback (${agent.fallback.provider}${agent.fallback.model ? ` · ${agent.fallback.model}` : ''}).` }, agent.id);
            span.span.attributes['beo.fallback'] = `${agent.fallback.provider}:${agent.fallback.model}`;
            continue;
          }
          if (kind === 'transient' && attempt < 2 && !acted) {
            this.emit(live, { type: 'note', text: `${agent.name}: ${clip((e as Error).message, 100)} — trying again.` }, agent.id);
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          if (kind === 'limit' && !agent.fallback?.provider) throw new Error(`${(e as Error).message} (Tip: set a fallback model for ${agent.name} in the team editor to keep working when this happens.)`);
          throw e;
        }
      }
      if (fellBack) result.session = undefined; // the fallback's session belongs to another provider
      if (result.session !== undefined && !fresh && !opts.lean) {
        live.sessions.set(agent.id, result.session);
        live.run.sessions = { ...live.run.sessions, [agent.id]: result.session };
      }
      this.emit(live, { type: 'agent_state', state: 'done' }, agent.id);
      record(true);
      endTool();
      span.finish(this.usageAttrs(usage, live.run.context?.[agent.id]));
      return result.text;
    } catch (e) {
      record(false);
      endTool();
      span.finish(this.usageAttrs(usage), (e as Error).message);
      if (!live.abort.signal.aborted) this.emit(live, { type: 'agent_state', state: 'error', detail: clip((e as Error).message, 80) }, agent.id);
      throw e;
    } finally {
      live.working.delete(agent.id);
    }
  }
}
