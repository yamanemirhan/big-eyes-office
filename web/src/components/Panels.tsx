import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentConfig, ExternalSession, TraceSpan, FileEntry, GitInfo, Run, Team } from '../../../shared/types.ts';
import { api, wsSend } from '../api.ts';
import { terms } from '../lib/terms.ts';
import { useI18n, type TKey } from '../i18n.tsx';
import { duration, tasksOf, useNow, withoutRepeats } from '../lib/run.ts';
import { Character, PALETTE } from './Character.tsx';

type OnError = (message: string) => void;
const COMMAND_TOOLS = /^(Bash|Command|run_command|running)/;

/* Tasks: one lane per agent, so you see who is doing what and what is waiting behind it. */
export function TasksPanel({ run, team, onAgent }: { run: Run | undefined; team: Team; onAgent: (id: string) => void }) {
  const { t } = useI18n();
  const now = useNow(run?.status === 'running');
  const tasks = tasksOf(run);
  if (!run || !tasks.length) return <div className="panel empty">{t('noTasks')}</div>;
  const agents = run.team.agents.filter((a) => tasks.some((x) => x.agentId === a.id));
  return (
    <div className="panel lanes">
      {agents.map((a) => (
        <div className="lane" key={a.id}>
          <button className="lane-head" onClick={() => team.agents.some((x) => x.id === a.id) && onAgent(a.id)}>
            <svg viewBox="-42 -136 84 100" width="30" height="36"><Character look={a.look} /></svg>
            <b className="agent-name" style={{ '--agent-ink': PALETTE[a.look.color % PALETTE.length].ink, '--agent-body': PALETTE[a.look.color % PALETTE.length].body } as React.CSSProperties}>{a.name}</b><span>{a.roleTitle}</span>
          </button>
          {tasks.filter((x) => x.agentId === a.id).map((x) => (
            <div className={`task-card ${x.status}`} key={x.id} title={x.brief}>
              <div className="task-top"><b>{x.name}</b><span className={`pill ${x.status}`}>{t(`task_${x.status}` as TKey)}</span></div>
              <div className="task-meta">
                {x.startedAt && <span>{duration((x.endedAt ?? now) - x.startedAt)}</span>}
                {x.branch && <code>{x.branch}</code>}
              </div>
              {x.note && <p>{x.note}</p>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* One agent: status, a way to talk to it, its terminal and what it said. */
/** How full the agent's context window is, with what fills it, and buttons to free it. */
function ContextMeter({ run, agent, onError }: { run: Run | undefined; agent: AgentConfig; onError: OnError }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const last = [...(run?.events ?? [])].reverse().find((e) => e.type === 'context' && e.agentId === agent.id);
  const known = run?.context?.[agent.id];
  const used = last?.type === 'context' ? last.used : known?.used;
  const limit = last?.type === 'context' ? last.limit : known?.limit;
  if (!run || !used || !limit) return null;
  const pct = Math.min(100, Math.round((100 * used) / limit));
  const act = async (how: 'compact' | 'fresh') => {
    setBusy(true);
    try { await api.context(run.id, agent.id, how); } catch (e) { onError((e as Error).message); }
    setBusy(false);
  };
  const cats = last?.type === 'context' ? last.categories ?? [] : [];
  return (
    <div className="context-meter" title={cats.map((c) => `${c.name}: ${c.tokens.toLocaleString()}`).join('\n') || undefined}>
      <div className="muted">{t('context')}: {Math.round(used / 1000)}k / {Math.round(limit / 1000)}k ({pct}%)</div>
      <div className={`bar${pct >= 80 ? ' hot' : pct >= 60 ? ' warm' : ''}`}><span style={{ width: `${pct}%` }} /></div>
      <div className="row">
        <button className="ghost small" disabled={busy || run.status === 'running'} title={t('compactHint')} onClick={() => act('compact')}>{t('compact')}</button>
        <button className="ghost small" disabled={busy || run.status === 'running'} title={t('freshHint')} onClick={() => act('fresh')}>{t('fresh')}</button>
      </div>
    </div>
  );
}

export function AgentPanel({ run, agent, onClose, onError }: { run: Run | undefined; agent: AgentConfig; onClose: () => void; onError: OnError }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const events = withoutRepeats(run?.events ?? []).filter((e) => e.agentId === agent.id || (e.type === 'user' && e.toAgentId === agent.id));
  const state = [...events].reverse().find((e) => e.type === 'agent_state');
  const current = tasksOf(run).filter((x) => x.agentId === agent.id && (x.status === 'running' || x.status === 'merging')).pop();
  const usage = events.reduce((a, e) => (e.type === 'usage' ? { i: a.i + e.inputTokens, o: a.o + e.outputTokens, c: a.c + (e.costUsd ?? 0) } : a), { i: 0, o: 0, c: 0 });
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [events.length, agent.id]);

  const send = async () => {
    if (!text.trim() || !run) return;
    try { await api.message(run.id, text, agent.id); setText(''); } catch (e) { onError((e as Error).message); }
  };
  const stateName = state?.type === 'agent_state' ? state.state : 'idle';

  return (
    <div className="panel agent-panel">
      <div className="agent-head">
        <svg viewBox="-50 -146 100 156" width="70" height="108"><Character look={agent.look} state={stateName} /></svg>
        <div>
          <h3>{agent.name}</h3>
          <div className="muted">{agent.roleTitle} · {agent.provider} · {agent.model || t('modelDefault')}{agent.effort !== 'default' ? ` · ${agent.effort}` : ''}</div>
          <div><span className={`pill ${stateName}`}>{t(`state_${stateName}` as TKey)}</span> {state?.type === 'agent_state' && state.detail}</div>
          {current && <div className="muted">{t('task')}: <b>{current.name}</b></div>}
          {usage.i + usage.o > 0 && <div className="muted">{usage.i.toLocaleString()} in · {usage.o.toLocaleString()} out{usage.c ? ` · $${usage.c.toFixed(3)}` : ''}</div>}
          <ContextMeter run={run} agent={agent} onError={onError} />
        </div>
        <button className="ghost" onClick={onClose}>×</button>
      </div>
      <div className="row">
        <input className="grow" value={text} disabled={!run} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={run ? `${t('messageTo')} ${agent.name}…` : t('startFirst')} />
        <button className="primary" disabled={!run || !text.trim()} onClick={send}>{t('send')}</button>
      </div>
      <div className="terminal grow">
        {events.map((e) => {
          if (e.type === 'tool') return <div key={e.seq} className={COMMAND_TOOLS.test(e.tool) ? 'cmd' : 'tool-line'}>{COMMAND_TOOLS.test(e.tool) ? '$ ' : `${e.tool}: `}{e.detail}</div>;
          if (e.type === 'output') return <pre key={e.seq}>{e.text}</pre>;
          if (e.type === 'message') return <div key={e.seq} className={`say ${e.kind}`}>{e.text}</div>;
          if (e.type === 'user') return <div key={e.seq} className="you">› {e.text}</div>;
          if (e.type === 'note' || e.type === 'error') return <div key={e.seq} className={e.type}>{e.type === 'note' ? e.text : e.message}</div>;
          return null;
        })}
        <div ref={end} />
      </div>
    </div>
  );
}

/* Files of the working folder, with the uncommitted diff. */
export function FilesPanel({ root, onError }: { root: string | undefined; onError: OnError }) {
  const { t } = useI18n();
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [view, setView] = useState<{ title: string; text: string; diff?: boolean; path?: string } | null>(null);
  const load = useCallback(() => { if (root) api.files(root, dir).then((r) => setEntries(r.entries)).catch((e) => onError(e.message)); }, [root, dir]);
  useEffect(() => { setDir(''); setView(null); }, [root]);
  useEffect(load, [load]);
  if (!root) return <div className="panel empty">{t('noFolder')}</div>;

  const join = (name: string) => (dir ? `${dir}/${name}` : name);
  const open = async (name: string) => {
    try {
      const f = await api.file(root, join(name));
      setView({ title: join(name), path: join(name), text: f.binary ? `(${t('binaryFile')}, ${f.size.toLocaleString()} bytes)` : f.content + (f.truncated ? '\n…' : '') });
    } catch (e) { onError((e as Error).message); }
  };
  const showDiff = async () => {
    try {
      const d = await api.diff(root);
      setView({ title: t('changes'), diff: true, text: !d.isRepo ? t('notRepo') : d.diff || t('noChanges') });
    } catch (e) { onError((e as Error).message); }
  };
  const upload = async (list: FileList | null) => {
    try { for (const f of [...(list ?? [])]) await api.upload(f, root, dir); load(); } catch (e) { onError((e as Error).message); }
  };

  return (
    <div className="panel files">
      <div className="row">
        <button disabled={!dir} onClick={() => { setDir(dir.split('/').slice(0, -1).join('/')); setView(null); }}>↑</button>
        <code className="grow crumb" title={root}>/{dir}</code>
        <button onClick={showDiff}>{t('changes')}</button>
        <label className="button">{t('upload')}<input type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} /></label>
        <button className="ghost" onClick={load}>⟳</button>
      </div>
      {view ? (
        <div className="viewer grow">
          <div className="row"><b className="grow">{view.title}</b>
            {view.path && <a className="button" href={api.downloadUrl(root, view.path)}>{t('download')}</a>}
            <button onClick={() => setView(null)}>{t('close')}</button></div>
          <pre className={view.diff ? 'diff' : ''}>{view.diff
            ? view.text.split('\n').map((l, i) => <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l}{'\n'}</span>)
            : view.text}</pre>
        </div>
      ) : (
        <div className="file-list grow">
          {entries.map((e) => (
            <button key={e.name} className="file" onClick={() => (e.dir ? setDir(join(e.name)) : open(e.name))}>
              <span>{e.dir ? '▸' : ' '} {e.name}{e.dir ? '/' : ''}</span>{!e.dir && <small>{e.size.toLocaleString()}</small>}
            </button>
          ))}
          {!entries.length && <div className="empty">{t('emptyFolder')}</div>}
        </div>
      )}
    </div>
  );
}

/* Local git plus GitHub pull requests through the gh CLI. */
export function GitPanel({ root, onError }: { root: string | undefined; onError: OnError }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { if (root) api.git(root).then(setInfo).catch((e) => onError(e.message)); }, [root]);
  useEffect(() => { setInfo(null); load(); }, [load]);
  if (!root) return <div className="panel empty">{t('noFolder')}</div>;
  if (!info) return <div className="panel empty">…</div>;

  const act = async (action: string, value = '', confirmText = '') => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    try { await api.gitAction(root, action, value); if (action === 'commit') setMessage(''); } catch (e) { onError((e as Error).message); }
    setBusy(false);
    load();
  };
  if (!info.isRepo) return <div className="panel empty"><p>{t('notRepo')}</p><button disabled={busy} onClick={() => act('init')}>{t('gitInit')}</button></div>;

  return (
    <div className="panel git">
      <div className="row"><b>{t('branch')}:</b> <code>{info.branch || '(detached)'}</code><span className="grow" />
        {info.remote && <><button disabled={busy} onClick={() => act('pull')}>Pull</button><button disabled={busy} onClick={() => act('push', info.branch)}>Push</button></>}
        <button className="ghost" onClick={load}>⟳</button></div>
      {info.remote ? <div className="muted crumb">{info.remote}</div> : <div className="muted">{t('noRemote')}</div>}

      <h4>{t('changes')} ({info.changes.length})</h4>
      {info.changes.length > 0 && (<>
        <pre className="changes">{info.changes.join('\n')}</pre>
        <div className="row"><input className="grow" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('commitMessage')} />
          <button disabled={busy || !message.trim()} onClick={() => act('commit', message)}>Commit</button></div>
      </>)}

      <h4>{t('branches')}</h4>
      {info.branches.map((b) => (
        <div className="row branch" key={b}>
          <code className="grow">{b === info.branch ? '● ' : ''}{b}</code>
          {b !== info.branch && (<>
            <button disabled={busy} onClick={() => act('checkout', b)}>{t('switch')}</button>
            <button disabled={busy} onClick={() => act('merge', b, `${t('mergeInto')} ${info.branch}: ${b}?`)}>Merge</button>
            {info.gh && info.remote && <button disabled={busy} onClick={() => act('push', b).then(() => act('pr-create', b))}>PR</button>}
            <button className="ghost danger-text" disabled={busy} onClick={() => act('branch-delete', b, `${t('remove')}: ${b}?`)}>×</button>
          </>)}
        </div>
      ))}

      <h4>Pull requests</h4>
      {!info.gh ? <div className="muted">{t('noGh')}</div> : !info.prs.length ? <div className="muted">{t('noPrs')}</div> : info.prs.map((pr) => (
        <div className="row branch" key={pr.number}>
          <a className="grow" href={pr.url} target="_blank" rel="noreferrer">#{pr.number} {pr.title}</a>
          <button disabled={busy} onClick={() => act('pr-merge', String(pr.number), `Merge PR #${pr.number}?`)}>Merge</button>
        </div>
      ))}
    </div>
  );
}

export interface ShellEntry { id: string; root: string; text: string; done: boolean; code?: number | null }

/* A real terminal (xterm.js on a server-side PTY) for one shell session. */
function XtermView({ entry }: { entry: ShellEntry }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !box.current) return;
      const dark = document.documentElement.dataset.theme === 'dark';
      const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, ui-monospace, monospace', fontSize: 13, cursorBlink: true, convertEol: false,
        theme: { background: '#24201d', foreground: '#eee4d2', cursor: '#ff8a65', selectionBackground: dark ? '#4a423a' : '#6b5a4a' } });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(box.current);
      fit.fit();
      term.write(entry.text);
      terms.set(entry.id, term);
      const send = (data: string) => wsSend({ type: 'shell-input', id: entry.id, data });
      const sub = term.onData(send);
      const resize = () => { try { fit.fit(); wsSend({ type: 'shell-resize', id: entry.id, cols: term.cols, rows: term.rows }); } catch { /* hidden */ } };
      const ro = new ResizeObserver(resize);
      ro.observe(box.current);
      resize();
      term.focus();
      cleanup = () => { ro.disconnect(); sub.dispose(); terms.delete(entry.id); term.dispose(); };
    })();
    return () => { disposed = true; cleanup(); };
  }, [entry.id]);
  return <div className="xterm-box" ref={box} />;
}

/* Shells in the working folder: a real terminal when the server has node-pty, otherwise line by line. */
export function ShellPanel({ root, log, onStart, onEcho, onError }: {
  root: string | undefined; log: ShellEntry[]; onStart: (e: ShellEntry) => void; onEcho: (id: string, text: string) => void; onError: OnError;
}) {
  const { t } = useI18n();
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [pos, setPos] = useState(-1);
  const [pty, setPty] = useState<boolean | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const sessions = log.filter((e) => e.root === root);
  const live = sessions.find((e) => !e.done);
  const size = sessions.reduce((n, e) => n + e.text.length, 0);
  useEffect(() => { api.shells().then((s) => setPty(s.pty)).catch(() => setPty(false)); }, []);
  useEffect(() => { if (!pty) end.current?.scrollIntoView({ block: 'end' }); }, [size, sessions.length, pty]);
  if (!root) return <div className="panel empty">{t('noFolder')}</div>;
  if (pty === null) return <div className="panel empty">…</div>;

  const open = async (text?: string) => {
    try { const { shellId } = await api.shell(root, text || undefined, 100, 30); onStart({ id: shellId, root, text: text && !pty ? `> ${text}\n` : '', done: false }); }
    catch (e) { onError((e as Error).message); }
  };

  if (pty) {
    return (
      <div className="panel">
        <div className="row"><span className="muted grow">{root} · {live ? t('shellLive') : t('shellEnded')}</span>
          {live ? <button className="danger" onClick={() => api.killShell(live.id)}>{t('stop')}</button> : <button className="primary" onClick={() => open()}>{t('openShell')}</button>}</div>
        {live ? <XtermView key={live.id} entry={live} /> : <div className="terminal grow"><div className="tool-line">{t('ptyHint')}</div></div>}
      </div>
    );
  }

  const run = async () => {
    const text = command;
    setCommand('');
    setPos(-1);
    if (text.trim()) setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 50));
    try {
      if (live) { onEcho(live.id, `> ${text}\n`); await api.shellInput(live.id, text); }
      else await open(text);
    } catch (e) { onError((e as Error).message); }
  };
  const recall = (dir: number) => {
    const next = Math.max(-1, Math.min(history.length - 1, pos + dir));
    setPos(next);
    setCommand(next < 0 ? '' : history[next]);
  };
  return (
    <div className="panel">
      <div className="terminal grow">
        <div className="tool-line">{root} · {live ? t('shellLive') : t('shellIdle')}</div>
        {sessions.map((e) => <div key={e.id}><pre>{e.text}</pre>{e.done && <div className="tool-line">{t('shellEnded')}{e.code ? ` (exit ${e.code})` : ''}</div>}</div>)}
        <div ref={end} />
      </div>
      <div className="row">
        <input className="grow mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('shellPlaceholder')}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); else if (e.key === 'ArrowUp') { e.preventDefault(); recall(1); } else if (e.key === 'ArrowDown') { e.preventDefault(); recall(-1); } }} />
        <button className="primary" onClick={run}>{live ? t('send') : t('run')}</button>
        {live && <button className="danger" onClick={() => api.killShell(live.id)}>{t('stop')}</button>}
      </div>
      <p className="hint">{t('shellHint')}</p>
    </div>
  );
}

/** Your own Claude Code and Codex sessions, read live from their transcripts. */
export function ExternalPanel({ sessions }: { sessions: ExternalSession[] }) {
  const { t } = useI18n();
  if (!sessions.length) return <div className="panel"><p className="muted">{t('extEmpty')}</p></div>;
  const ago = (ms: number) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
  return (
    <div className="panel external">
      <p className="hint">{t('extHint')}</p>
      {sessions.map((s) => {
        const pct = s.context ? Math.min(100, Math.round((100 * s.context.used) / s.context.limit)) : 0;
        return (
          <div key={s.id} className={`ext-card ${s.state}`}>
            <div className="row"><span className={`pill ${s.state}`}>{t(`ext_${s.state}` as TKey)}</span>
              <b className="grow">{s.title}</b><span className="muted">{s.tool === 'claude' ? 'Claude Code' : 'Codex'} · {ago(s.updatedAt)}</span></div>
            <div className="muted mono">{s.cwd}{s.model ? ` · ${s.model}` : ''}</div>
            {s.lastMessage && <div className="ext-last">{s.lastMessage}</div>}
            <div className="muted">{s.tokens.input.toLocaleString()} in{s.tokens.cached ? ` (+${s.tokens.cached.toLocaleString()} cached)` : ''} · {s.tokens.output.toLocaleString()} out
              {s.context && <> · {t('context')} {Math.round(s.context.used / 1000)}k/{Math.round(s.context.limit / 1000)}k</>}</div>
            {s.context && <div className={`bar${pct >= 80 ? ' hot' : pct >= 60 ? ' warm' : ''}`}><span style={{ width: `${pct}%` }} /></div>}
            {!!s.files.length && <div className="muted mono">{s.files.map((f) => f.split(/[\\/]/).pop()).join(', ')}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** The run as a trace: every agent turn and tool call on a timeline, with tokens. Same data as the OTLP export. */
export function TracePanel({ run }: { run: Run | undefined }) {
  const { t } = useI18n();
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const eventCount = run?.events.length ?? 0;
  useEffect(() => {
    if (!run) return;
    const timer = setTimeout(() => api.trace(run.id).then(setSpans).catch(() => setSpans([])), 300);
    return () => clearTimeout(timer);
  }, [run?.id, run?.status, Math.floor(eventCount / 10)]);
  if (!run) return <div className="panel"><p className="muted">{t('startFirst')}</p></div>;
  if (!spans.length) return <div className="panel"><p className="muted">{t('traceEmpty')}</p></div>;
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end || Date.now()));
  const total = Math.max(1, end - start);
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const depth = (s: TraceSpan): number => { let d = 0; let p = s.parentSpanId && byId.get(s.parentSpanId); while (p && d < 5) { d++; p = p.parentSpanId ? byId.get(p.parentSpanId) : undefined; } return d; };
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const tokens = spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent').reduce((n, s) => n + num(s.attributes['gen_ai.usage.input_tokens']) + num(s.attributes['gen_ai.usage.output_tokens']), 0);
  const sorted = [...spans].sort((a, b) => a.start - b.start || depth(a) - depth(b));
  return (
    <div className="panel trace">
      <div className="muted">{t('traceId')} <code>{run.traceId}</code> · {t('promptVersion')} <code>{run.versions?.prompt ?? '–'}</code> · {t('teamVersion')} <code>{run.versions?.team ?? '–'}</code> · {tokens.toLocaleString()} tokens</div>
      <div className="trace-rows">
        {sorted.map((s) => {
          const a = s.attributes;
          const ms = (s.end || Date.now()) - s.start;
          const tok = num(a['gen_ai.usage.input_tokens']) + num(a['gen_ai.usage.output_tokens']);
          return (
            <div key={s.spanId + s.start} className={`trace-row${s.status === 'error' ? ' error' : ''}`} title={Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n')}>
              <span className="trace-name" style={{ paddingLeft: depth(s) * 12 }}>{s.name}</span>
              <span className="trace-track"><span className={`trace-bar ${String(a['gen_ai.operation.name'] ?? '')}`} style={{ left: `${(100 * (s.start - start)) / total}%`, width: `${Math.max(0.6, (100 * ms) / total)}%` }} /></span>
              <span className="trace-meta">{ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}{tok ? ` · ${tok.toLocaleString()} tok` : ''}</span>
            </div>
          );
        })}
      </div>
      <p className="hint">{t('traceHint')}</p>
    </div>
  );
}
