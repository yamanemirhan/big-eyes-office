// Outside sessions: Claude Code and Codex sessions you run yourself in a terminal or an editor, shown next to the
// office's own agents. Read-only: we only read the transcripts both tools already write to your home folder.
// Updates are pushed as soon as a transcript file changes (file system events), with a slow poll as a safety net.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExternalSession } from '../../shared/types.ts';
import { DATA } from './store.ts';

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const RECENT_MS = 6 * 3600_000;
const TAIL_BYTES = 400_000;

function readPart(file: string, from: 'head' | 'tail', bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from === 'head' ? 0 : size - len);
    const text = buf.toString('utf8');
    // Drop the partial line at the cut.
    return from === 'head' ? text.slice(0, text.lastIndexOf('\n') + 1) : (size > len ? text.slice(text.indexOf('\n') + 1) : text);
  } finally { fs.closeSync(fd); }
}

const lines = (text: string) => text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function recentFiles(dir: string, depth: number): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = [];
  const walk = (d: string, level: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && level < depth) walk(full, level + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { const m = fs.statSync(full).mtimeMs; if (Date.now() - m < RECENT_MS) out.push({ file: full, mtime: m }); } catch { /* gone */ }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 25);
}

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text' || c?.type === 'input_text' || c?.type === 'output_text').map((c: any) => c.text).join(' ') : '';
const short = (s: string, n = 140) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function claudeSession(file: string, mtime: number): ExternalSession | null {
  const tail = lines(readPart(file, 'tail', TAIL_BYTES)).filter((e: any) => !e.isSidechain);
  if (!tail.length) return null;
  const head = lines(readPart(file, 'head', 64_000));
  const firstUser = head.find((e: any) => e.type === 'user' && textOf(e.message?.content) && !textOf(e.message?.content).startsWith('<'));
  const id = tail.find((e: any) => e.sessionId)?.sessionId ?? path.basename(file, '.jsonl');
  let input = 0, output = 0, cached = 0, context = 0, model = '';
  const files = new Set<string>();
  let lastText = '';
  for (const e of tail) {
    if (e.type === 'assistant') {
      const u = e.message?.usage ?? {};
      input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      cached += u.cache_read_input_tokens ?? 0;
      output += u.output_tokens ?? 0;
      context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      model = e.message?.model ?? model;
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && c.input?.file_path) files.add(c.input.file_path);
        if (c.type === 'text' && c.text?.trim()) lastText = c.text;
      }
    }
  }
  // What is it doing? The last message decides: an unanswered tool call is running (or waiting for approval once
  // it sits still), a finished answer means it waits for you, and a fresh user message means it is thinking.
  const last = [...tail].reverse().find((e: any) => e.type === 'assistant' || e.type === 'user');
  const quiet = Date.now() - mtime;
  let state: ExternalSession['state'] = 'idle';
  if (last?.type === 'assistant') {
    const pendingTool = (last.message?.content ?? []).some((c: any) => c.type === 'tool_use');
    state = pendingTool ? (quiet < 20_000 ? 'working' : 'waiting') : last.message?.stop_reason === 'end_turn' || !last.message?.stop_reason ? 'done' : 'working';
  } else if (last?.type === 'user') state = quiet < 120_000 ? 'working' : 'idle';
  if (quiet > 30 * 60_000 && state !== 'waiting') state = 'idle';
  const cwd = tail.find((e: any) => e.cwd)?.cwd ?? '';
  return {
    id: `claude:${id}`, tool: 'claude', sessionId: id, cwd, title: short(textOf(firstUser?.message?.content) || path.basename(cwd) || id, 90),
    lastMessage: short(lastText), state, updatedAt: mtime, model,
    tokens: { input, output, cached }, context: context ? { used: context, limit: /\[1m\]|1m/i.test(model) ? 1_000_000 : 200_000 } : undefined,
    files: [...files].slice(-8),
  };
}

function codexSession(file: string, mtime: number): ExternalSession | null {
  const tail = lines(readPart(file, 'tail', TAIL_BYTES));
  const head = lines(readPart(file, 'head', 64_000));
  const meta = head.find((e: any) => e.type === 'session_meta')?.payload ?? {};
  const userText = (e: any) => (e.type === 'event_msg' && e.payload?.type === 'user_message' ? String(e.payload.message ?? '') : '');
  const firstUser = [...head, ...tail].map(userText).find((t) => t.trim() && !t.trim().startsWith('<')) ?? '';
  let tokens = { input: 0, output: 0, cached: 0 };
  let context: ExternalSession['context'];
  let lastText = '';
  let state: ExternalSession['state'] = 'idle';
  let model = '';
  for (const e of tail) {
    const p = e.payload ?? {};
    if (e.type === 'turn_context' && p.model) model = p.model;
    if (e.type !== 'event_msg') continue;
    if (p.type === 'token_count' && p.info) {
      const t = p.info.total_token_usage ?? {};
      tokens = { input: (t.input_tokens ?? 0) - (t.cached_input_tokens ?? 0), output: t.output_tokens ?? 0, cached: t.cached_input_tokens ?? 0 };
      const l = p.info.last_token_usage ?? {};
      if (p.info.model_context_window) context = { used: (l.input_tokens ?? 0) + (l.output_tokens ?? 0), limit: p.info.model_context_window };
    }
    if (p.type === 'agent_message' && p.message) lastText = p.message;
    if (p.type === 'task_started' || p.type === 'user_message') state = 'working';
    if (p.type === 'task_complete' || p.type === 'turn_aborted') state = 'done';
    if (/approval_request$/.test(p.type ?? '')) state = 'waiting';
  }
  const quiet = Date.now() - mtime;
  if (state === 'working' && quiet > 5 * 60_000) state = 'idle';
  if (quiet > 30 * 60_000 && state !== 'waiting') state = 'idle';
  const id = meta.id ?? path.basename(file, '.jsonl');
  return {
    id: `codex:${id}`, tool: 'codex', sessionId: id, cwd: meta.cwd ?? '', title: short(firstUser || path.basename(meta.cwd ?? '') || id, 90),
    lastMessage: short(lastText), state, updatedAt: mtime, model, tokens, context, files: [],
  };
}

/** Recent outside sessions, newest first. `ignore` holds session ids the office itself created. */
export function externalSessions(ignore: Set<string>): ExternalSession[] {
  const out: ExternalSession[] = [];
  // Sessions the office started live in its own data folder; they are already on screen as agents.
  const ours = path.resolve(DATA).toLowerCase();
  const keep = (s: ExternalSession | null): s is ExternalSession => !!s && !ignore.has(s.sessionId)
    && !(s.cwd && path.resolve(s.cwd).toLowerCase().startsWith(ours))
    && (s.state !== 'idle' || s.tokens.input + s.tokens.output + s.tokens.cached > 0);
  for (const { file, mtime } of recentFiles(CLAUDE_DIR, 1)) {
    try { const s = claudeSession(file, mtime); if (keep(s)) out.push(s); } catch { /* unreadable line: skip */ }
  }
  for (const { file, mtime } of recentFiles(CODEX_DIR, 3)) {
    try { const s = codexSession(file, mtime); if (keep(s)) out.push(s); } catch { /* skip */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
}

/** Calls `onChange` shortly after any transcript changes, and every 10 s so "working" can turn into "waiting". */
export function watchExternal(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => { clearTimeout(timer); timer = setTimeout(onChange, 400); };
  const watchers: fs.FSWatcher[] = [];
  for (const dir of [CLAUDE_DIR, CODEX_DIR]) {
    try { if (fs.existsSync(dir)) watchers.push(fs.watch(dir, { recursive: true }, soon)); } catch { /* recursive watch unsupported: polling covers it */ }
  }
  const poll = setInterval(onChange, 10_000);
  return () => { clearInterval(poll); clearTimeout(timer); for (const w of watchers) w.close(); };
}
