import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalDecision, Automation, ExternalSession, ClaudePlan, ProviderStatus, Question, Run, RunEvent, Settings, SkillsState, Team } from '../../shared/types.ts';
import { api, connectEvents } from './api.ts';
import { useI18n, type TKey } from './i18n.tsx';
import { approvalsOf, questionsOf, tasksOf } from './lib/run.ts';
import { terms } from './lib/terms.ts';
import { TRACKS, canListen, listen, setAudio, sfx, speak, unlockAudio, useAudio } from './lib/audio.ts';
import { Office } from './components/Office.tsx';
import { Feed } from './components/Feed.tsx';
import { TaskPanel } from './components/TaskPanel.tsx';
import { TeamEditor, blankTeam } from './components/TeamEditor.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { AgentPanel, ExternalPanel, TracePanel, FilesPanel, GitPanel, ShellPanel, TasksPanel, type ShellEntry } from './components/Panels.tsx';
import { AutomationsModal, CompareModal, EvalsModal, PlanMeters, UsageModal } from './components/Modals.tsx';
import { parseVoice } from './lib/voice.ts';
import { askNotifyPermission, notify } from './lib/notify.ts';

type Tab = 'activity' | 'tasks' | 'files' | 'git' | 'shell' | 'trace' | 'sessions';
const TABS: Tab[] = ['activity', 'tasks', 'files', 'git', 'shell', 'trace', 'sessions'];

function QuestionCard({ question, agentName, onAnswer }: { question: Question; agentName: string; onAnswer: (answers: string[]) => void }) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<string[]>(() => question.items.map((q) => q.recommended ?? q.options[0] ?? ''));
  const [sending, setSending] = useState(false);
  const set = (i: number, v: string) => setAnswers(answers.map((a, j) => (j === i ? v : a)));
  return (
    <div className="question">
      <b>{agentName} {t('hasQuestions')}</b>
      {question.items.map((q, i) => (
        <div key={i} className="q-item">
          <p>{q.question}</p>
          <div className="chips" hidden={!q.options.length}>
            {q.options.map((o) => <button key={o} className={answers[i] === o ? 'chip on' : 'chip'} onClick={() => set(i, o)}>{o}{o === q.recommended && <small> · {t('recommended')}</small>}</button>)}
          </div>
          <input value={answers[i]} onChange={(e) => set(i, e.target.value)} placeholder={t('ownAnswer')} />
        </div>
      ))}
      <div className="row"><span className="grow" /><button className="primary" disabled={sending || answers.some((a) => !a.trim())} onClick={() => { setSending(true); onAnswer(answers); }}>{t('sendAnswers')}</button></div>
    </div>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 64 40" width="48" height="30" aria-hidden="true">
      {[18, 46].map((x) => (<g key={x}><ellipse cx={x} cy="20" rx="13" ry="16" fill="#fff" stroke="#2b2622" strokeWidth="3" /><circle className="logo-pupil" cx={x + 2} cy="22" r="7" fill="#2b2622" /><circle cx={x + 5} cy="18" r="2.4" fill="#fff" /></g>))}
    </svg>
  );
}

export function App() {
  const { t, lang } = useI18n();
  const audio = useAudio();
  const [theme, setTheme] = useState(() => localStorage.getItem('beo.theme') ?? 'light');
  const [useDatabase, setUseDatabase] = useState(false);
  const langRef = useRef(lang);
  langRef.current = lang;
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('beo.theme', theme); }, [theme]);
  useEffect(() => {
    // Every button clicks; the first click also lets the browser start music.
    const onClick = (e: MouseEvent) => { unlockAudio(); if ((e.target as HTMLElement).closest('button, .button, select, [role=tab]')) sfx('click'); };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  const [teams, setTeams] = useState<Team[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [skills, setSkills] = useState<SkillsState>({ installed: false, skills: [] });
  const [teamId, setTeamId] = useState(() => localStorage.getItem('beo.team') ?? '');
  const [runId, setRunId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('activity');
  const [shellLog, setShellLog] = useState<ShellEntry[]>([]);
  const [external, setExternal] = useState<ExternalSession[]>([]);
  useEffect(() => { window.addEventListener('pointerdown', askNotifyPermission, { once: true }); }, []);
  const externalRef = useRef<ExternalSession[]>([]);
  const [editing, setEditing] = useState<Team | null>(null);
  const [modal, setModal] = useState<'settings' | 'automations' | 'usage' | 'compare' | 'evals' | null>(null);
  const [plan, setPlan] = useState<ClaudePlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [heard, setHeard] = useState('');
  const [online, setOnline] = useState(true);
  const [error, setError] = useState('');

  const refreshProviders = useCallback(async () => { setProviders(await api.providers()); }, []);

  const load = useCallback(async () => {
    const state = await api.state();
    setTeams(state.teams);
    setSettings(state.settings);
    setAutomations(state.automations);
    setUseDatabase(state.useDatabase);
    setRuns(Object.fromEntries(state.runs.map((r) => [r.id, r])));
  }, []);

  useEffect(() => {
    // The server can take a few seconds to come up, so keep trying quietly.
    let cancelled = false;
    const boot = async () => {
      while (!cancelled) {
        try {
          await load();
          refreshProviders().catch(() => {});
          api.skills().then(setSkills).catch(() => {});
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
    };
    void boot();
    // Claude plan limits: once now, then every five minutes.
    const loadPlan = () => api.claudePlan().then(setPlan).catch(() => {});
    const planTimer = setInterval(loadPlan, 5 * 60_000);
    setTimeout(loadPlan, 1500);
    const fetching = new Set<string>();
    const react = (e: RunEvent) => {
      // Sounds and speech for things worth noticing.
      if (e.type === 'delegate') sfx('send');
      else if (e.type === 'task' && e.task.status === 'done') sfx('pop');
      else if (e.type === 'approval' && e.approval.status === 'pending') { sfx('ask'); speak(e.approval.title, langRef.current); notify(t('notifyApproval'), e.approval.title); }
      else if (e.type === 'question' && e.question.status === 'pending') { sfx('ask'); speak(e.question.items.map((q) => q.question).join(' '), langRef.current); notify(t('notifyQuestion'), e.question.items[0]?.question ?? ''); }
      else if (e.type === 'run_status' && e.status === 'done') { sfx('done'); notify(t('notifyDone'), ''); }
      else if (e.type === 'run_status' && e.status === 'failed') { sfx('error'); notify(t('notifyFailed'), ''); }
      else if (e.type === 'message' && e.kind === 'final') speak(e.text, langRef.current);
    };
    const disconnect = connectEvents((e: RunEvent) => {
      react(e);
      setRuns((prev) => {
        const run = prev[e.runId];
        if (!run) {
          // A run this page did not start (an automation, another tab): fetch it once.
          if (!fetching.has(e.runId)) {
            fetching.add(e.runId);
            api.run(e.runId).then((r) => setRuns((p) => ({ ...p, [r.id]: p[r.id] ?? r }))).catch(() => {}).finally(() => fetching.delete(e.runId));
          }
          return prev;
        }
        if (e.seq < run.events.length) return prev;
        const next: Run = { ...run, events: [...run.events, e] };
        if (e.type === 'run_status') { next.status = e.status; if (e.status === 'running') next.interrupted = false; }
        return { ...prev, [e.runId]: next };
      });
    }, (c) => {
      // Output can arrive before the request that opened the shell has returned; keep it in a placeholder.
      if (c.chunk) terms.get(c.shellId)?.write(c.chunk);
      setShellLog((prev) => {
        const known = prev.some((s) => s.id === c.shellId);
        const list = known ? prev : [...prev, { id: c.shellId, root: '', text: '', done: false }];
        return list.map((s) => (s.id === c.shellId ? { ...s, text: (s.text + (c.chunk ?? '')).slice(-200_000), done: s.done || !!c.done, code: c.done ? c.code : s.code } : s));
      });
    }, (up) => { setOnline(up); if (up) load().catch(() => {}); }, (list) => {
      // Tell me when one of my own sessions starts waiting for me.
      for (const s of list) {
        const before = externalRef.current.find((x) => x.id === s.id);
        if (before && before.state !== s.state && (s.state === 'waiting' || s.state === 'done')) {
          sfx('ask');
          notify(`${s.tool === 'claude' ? 'Claude Code' : 'Codex'}: ${s.state === 'waiting' ? t('extWaiting') : t('extDone')}`, s.title);
        }
      }
      externalRef.current = list;
      setExternal(list);
    });
    api.external().then((l) => { externalRef.current = l; setExternal(l); }).catch(() => {});
    return () => { cancelled = true; clearInterval(planTimer); disconnect(); };
  }, [load, refreshProviders]);

  const team = teams.find((x) => x.id === teamId) ?? teams[0];
  useEffect(() => { if (team) localStorage.setItem('beo.team', team.id); }, [team?.id]);

  const teamRuns = useMemo(
    () => Object.values(runs).filter((r) => r.teamId === team?.id).sort((a, b) => b.startedAt - a.startedAt),
    [runs, team?.id],
  );
  const run = (runId && runs[runId]?.teamId === team?.id ? runs[runId] : undefined) ?? teamRuns[0];
  const agent = team?.agents.find((a) => a.id === agentId) ?? run?.team.agents.find((a) => a.id === agentId);
  const pending = useMemo(() => Object.values(runs).filter((r) => r.status === 'running').flatMap((r) => approvalsOf(r).filter((a) => a.status === 'pending').map((a) => ({ a, r }))), [runs]);
  const asking = useMemo(() => Object.values(runs).filter((r) => r.status === 'running').flatMap((r) => questionsOf(r).filter((q) => q.status === 'pending').map((q) => ({ q, r }))), [runs]);
  const openTasks = tasksOf(run).filter((x) => x.status === 'running' || x.status === 'queued' || x.status === 'merging').length;

  const saveTeam = async (draft: Team) => {
    try {
      const saved = await api.saveTeam(draft);
      setTeams((prev) => (prev.some((x) => x.id === saved.id) ? prev.map((x) => (x.id === saved.id ? saved : x)) : [...prev, saved]));
      setTeamId(saved.id);
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  };
  const deleteTeam = async (id: string) => {
    try {
      await api.deleteTeam(id);
      setTeams((prev) => prev.filter((x) => x.id !== id));
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  };
  const decide = (id: string, decision: ApprovalDecision) => api.decide(id, decision).catch((e) => setError(e.message));
  const selectTeam = (id: string) => { setTeamId(id); setRunId(null); setAgentId(null); };

  // Spoken commands. Refs keep the latest state without restarting the microphone.
  const voiceRef = useRef({ teams, team, run, pending, theme, audio });
  voiceRef.current = { teams, team, run, pending, theme, audio };
  useEffect(() => {
    if (!voiceOn) { setHeard(''); return; }
    let stopped = false;
    let stop: (() => void) | null = null;
    const start = () => {
      stop = listen(lang, (text, final) => {
        setHeard(text);
        if (!final) return;
        const action = parseVoice(text);
        const v = voiceRef.current;
        if (!action) return;
        sfx('pop');
        if (action.type === 'stop' && v.run?.status === 'running') api.stopRun(v.run.id).catch(() => {});
        else if (action.type === 'approve' && v.pending[0]) decide(v.pending[0].a.id, 'allow');
        else if (action.type === 'deny' && v.pending[0]) decide(v.pending[0].a.id, 'deny');
        else if (action.type === 'theme') setTheme(action.dark ? 'dark' : 'light');
        else if (action.type === 'music') setAudio({ music: action.on });
        else if (action.type === 'sounds') setAudio({ sfx: action.on });
        else if (action.type === 'team') {
          const found = v.teams.find((x) => x.name.toLowerCase().includes(action.name.toLowerCase()));
          if (found) selectTeam(found.id);
        } else if (action.type === 'task') window.dispatchEvent(new CustomEvent('beo-task', { detail: action.text }));
        else if (action.type === 'send') window.dispatchEvent(new CustomEvent('beo-send'));
      }, () => { if (!stopped) setTimeout(start, 300); });
    };
    start();
    return () => { stopped = true; stop?.(); };
  }, [voiceOn, lang]);

  if (!settings) return <div className="loading"><b>{t('connecting')}</b><p>{t('connectHelp')}</p></div>;

  return (
    <div className="app">
      <header>
        <div className="brand"><Logo /><div><h1>Big Eyes Office</h1><span>{t('tagline')}</span></div></div>
        <nav className="teams">
          {teams.map((x) => (
            <button key={x.id} className={x.id === team?.id ? 'team-tab on' : 'team-tab'} onClick={() => selectTeam(x.id)} title={x.description}>
              {x.name}<small>{x.agents.length}</small>
            </button>
          ))}
          <button className="team-tab add" onClick={() => setEditing(blankTeam(`${t('newTeam')} ${teams.length + 1}`))}>+ {t('newTeam')}</button>
        </nav>
        <div className="header-actions">
          {!online && <span className="offline">{t('offline')}</span>}
          {team && <button onClick={() => setEditing(team)}>{t('editTeam')}</button>}
          <button className="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={t('lights')} aria-pressed={theme === 'dark'}>{theme === 'dark' ? '☾' : '☀'}</button>
          <button className={`icon${audio.sfx ? '' : ' off'}`} onClick={() => setAudio({ sfx: !audio.sfx })} title={t('soundEffects')} aria-pressed={audio.sfx}>FX</button>
          <button className={`icon${audio.music ? '' : ' off'}`} onClick={() => setAudio({ music: !audio.music })} title={t('music')} aria-pressed={audio.music}>♫</button>
          {audio.music && <select className="track" value={audio.track} onChange={(e) => setAudio({ track: Number(e.target.value) })} aria-label={t('music')}>{TRACKS.map((x, i) => <option key={x.name} value={i}>{x.name}</option>)}</select>}
          <button className={`icon${audio.voice ? '' : ' off'}`} onClick={() => setAudio({ voice: !audio.voice })} title={t('voice')} aria-pressed={audio.voice}>{t('voiceShort')}</button>
          {canListen() && <button className={`icon${voiceOn ? ' live' : ' off'}`} onClick={() => setVoiceOn(!voiceOn)} title={t('voiceCommands')} aria-pressed={voiceOn}>🎙</button>}
          {plan && plan.mode === 'login' && plan.limits.length > 0 && (() => {
            // The chip shows the two limits every request counts against; model-only weekly limits are in the popover.
            const general = plan.limits.filter((l) => /5-hour|all models/i.test(l.name));
            const shown = general.length ? general : plan.limits;
            const hot = shown.some((l) => l.usedPercent >= 90);
            const label = shown.map((l) => `${/5-hour/i.test(l.name) ? '5h' : /week/i.test(l.name) ? '7d' : l.name} ${Math.round(l.usedPercent)}%`).join(' · ');
            return <button className={`plan-chip${hot ? ' hot' : ''}${plan.extraUsage?.enabled ? ' extra' : ''}`} onClick={() => setPlanOpen(!planOpen)} title={shown.map((l) => l.name).join(' · ')}>Claude {label}</button>;
          })()}
          <button onClick={() => setModal('compare')}>{t('compare')}</button>
          <button onClick={() => setModal('evals')}>{t('evals')}</button>
          <button onClick={() => setModal('automations')}>{t('automations')}</button>
          <button onClick={() => setModal('usage')}>{t('usage')}</button>
          <button onClick={() => setModal('settings')}>{t('settings')}</button>
        </div>
      </header>

      {planOpen && plan && <div className="plan-pop"><div className="row"><b className="grow">Claude {plan.plan ?? ''}</b><button className="ghost" onClick={() => setPlanOpen(false)}>×</button></div><PlanMeters plan={plan} /><p className="hint">{t('planWhere')}</p></div>}
      {voiceOn && <div className="voice-pop">🎙 {heard || t('listening')}</div>}
      {error && <div className="toast" onClick={() => setError('')}>{error} <b>×</b></div>}

      {team && (
        <main>
          <section className="stage">
            <div className="office-wrap"><Office team={team} run={run} selected={agentId} onSelect={(id) => { sfx('pop'); setAgentId(id === agentId ? null : id); }} dark={theme === 'dark'} onToggleLight={() => setTheme(theme === 'dark' ? 'light' : 'dark')} guests={external} onGuests={() => setTab('sessions')} /></div>
            {asking.map(({ q, r }) => (
              <QuestionCard key={q.id} question={q} agentName={r.team.agents.find((a) => a.id === q.agentId)?.name ?? '?'} onAnswer={(answers) => api.answer(q.id, answers).catch((e) => setError(e.message))} />
            ))}
            {pending.map(({ a, r }) => (
              <div className="approval" key={a.id}>
                <div className="grow">
                  <b>{a.title}</b> <span className="muted">{r.team.name}</span>
                  <pre>{a.detail}</pre>
                </div>
                <button className="primary" onClick={() => decide(a.id, 'allow')}>{t('allow')}</button>
                <button onClick={() => decide(a.id, 'always')} title={t('alwaysHint')}>{t('always')}</button>
                {a.kind !== 'merge' && <button onClick={() => decide(a.id, 'team')} title={t('alwaysTeamHint')}>{t('alwaysTeam')}</button>}
                <button className="danger" onClick={() => decide(a.id, 'deny')}>{t('deny')}</button>
              </div>
            ))}
            <TaskPanel team={team} run={run} recent={settings.recentWorkdirs}
              onStarted={(r) => { setRuns((prev) => ({ ...prev, [r.id]: prev[r.id] ?? r })); setRunId(r.id); }} onError={setError} />
          </section>
          <aside>
            {agent ? <AgentPanel run={run} agent={agent} onClose={() => setAgentId(null)} onError={setError} /> : (<>
              <div className="aside-head">
                <div className="tabs" role="tablist">
                  {TABS.map((x) => <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'tab on' : 'tab'} onClick={() => setTab(x)}>{t(`tab_${x}` as TKey)}{x === 'tasks' && openTasks > 0 && <small>{openTasks}</small>}{x === 'sessions' && external.some((s) => s.state === 'waiting' || s.state === 'working') && <small className={external.some((s) => s.state === 'waiting') ? 'hot' : ''}>{external.filter((s) => s.state === 'waiting' || s.state === 'working').length}</small>}</button>)}
                </div>
              </div>
              <div className="run-bar">
                {run && <span className={`status ${run.status}`}>{t(`status_${run.status}` as TKey)}</span>}
                {teamRuns.length > 0 && (
                  <select className="grow" value={run?.id ?? ''} onChange={(e) => setRunId(e.target.value)} title={t('history')}>
                    {teamRuns.map((r) => <option key={r.id} value={r.id}>{new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} — {r.task.slice(0, 40)}</option>)}
                  </select>
                )}
              </div>
              {run && <div className="run-meta" title={run.workdir}>{run.workdir}</div>}
              {run?.interrupted && run.status !== 'running' && (
                <div className="warn row"><span className="grow">{t('interrupted')}</span><button className="primary" onClick={() => api.resume(run.id).catch((e) => setError(e.message))}>{t('resume')}</button></div>
              )}
              {tab === 'activity' && <Feed run={run} />}
              {tab === 'tasks' && <TasksPanel run={run} team={team} onAgent={setAgentId} />}
              {tab === 'files' && <FilesPanel root={run?.workdir} onError={setError} />}
              {tab === 'git' && <GitPanel root={run?.workdir} onError={setError} />}
              {tab === 'sessions' && <ExternalPanel sessions={external} />}
              {tab === 'trace' && <TracePanel run={run} />}
              {tab === 'shell' && <ShellPanel root={run?.workdir} log={shellLog} onStart={(e) => setShellLog((prev) => (prev.some((s) => s.id === e.id) ? prev.map((s) => (s.id === e.id ? { ...s, root: e.root, text: e.text + s.text } : s)) : [...prev, e]))} onEcho={(id, text) => setShellLog((prev) => prev.map((s) => (s.id === id ? { ...s, text: s.text + text } : s)))} onError={setError} />}
            </>)}
          </aside>
        </main>
      )}

      {editing && <TeamEditor team={editing} providers={providers} skills={skills} onSave={saveTeam} onDelete={deleteTeam} onClose={() => setEditing(null)} />}
      {modal === 'settings' && <SettingsModal useDatabase={useDatabase} onDatabase={setUseDatabase} settings={settings} providers={providers} skills={skills} onSaved={setSettings} onRefresh={refreshProviders} onSkills={setSkills} onClose={() => setModal(null)} />}
      {modal === 'automations' && <AutomationsModal teams={teams} automations={automations} onChange={setAutomations} onOpenRun={(rid, tid) => { selectTeam(tid); setRunId(rid); }} onClose={() => setModal(null)} />}
      {modal === 'usage' && <UsageModal onClose={() => setModal(null)} />}
      {modal === 'evals' && <EvalsModal teams={teams} onOpenRun={(rid, tid) => { selectTeam(tid); setRunId(rid); }} onClose={() => setModal(null)} />}
      {modal === 'compare' && <CompareModal teams={teams} runs={Object.values(runs)} recent={settings.recentWorkdirs} onOpenRun={(rid, tid) => { selectTeam(tid); setRunId(rid); }} onClose={() => setModal(null)} />}
    </div>
  );
}
