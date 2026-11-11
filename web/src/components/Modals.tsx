import { useEffect, useState } from 'react';
import type { Automation, Billing, ClaudePlan, EvalResult, EvalSuite, Run, Stats, Team, UsageRow } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { compact, duration } from '../lib/run.ts';
import { PALETTE } from './Character.tsx';

const PRESETS: [string, string][] = [['*/15 * * * *', 'Every 15 minutes'], ['0 * * * *', 'Every hour'], ['0 9 * * *', 'Every day 09:00'], ['0 9 * * 1-5', 'Weekdays 09:00'], ['0 9 * * 1', 'Mondays 09:00']];
const blank = (teamId: string): Partial<Automation> => ({ name: '', teamId, task: '', workdir: '', checkCommand: '', kind: 'schedule', cron: '0 9 * * 1-5', watch: 'issues', intervalMin: 10, enabled: true });

/** Ready-made loops, after the patterns in "Loop Engineering: 9 Ways to Automate". */
const TEMPLATES: { id: string; name: string; a: Partial<Automation> }[] = [
  { id: 'triage', name: 'Issue triage', a: { kind: 'github', watch: 'issues', intervalMin: 10,
    task: 'A new GitHub issue was opened (details below). Triage it: search for duplicates with `gh issue list --search`, add fitting labels with `gh issue edit` (bug, feature, question, duplicate), and comment with the duplicate link or with the information that is missing to reproduce it. Do not close issues and do not change code.' } },
  { id: 'ci', name: 'CI repair', a: { kind: 'github', watch: 'ci', intervalMin: 10,
    task: 'A CI run failed (details below). Read the failed log with `gh run view <databaseId> --log-failed`. Reproduce the failure locally, write or adjust a test that shows it, fix the cause on a new branch and open a pull request. If it is a flaky test or infrastructure, say so in a comment on the run instead of changing code.' } },
  { id: 'deps', name: 'Dependency sweep', a: { kind: 'schedule', cron: '0 9 * * 1',
    task: 'Weekly dependency sweep: list outdated dependencies, update patch and minor versions one package at a time, run the tests after each update and keep only the updates that pass. Commit them on a branch and open one pull request listing what was updated and what was skipped and why.' } },
  { id: 'audit', name: 'Security audit burndown', a: { kind: 'schedule', cron: '0 2 * * *', checkCommand: 'npm audit --audit-level=high',
    task: 'Nightly security burndown: run the dependency audit, fix the most severe finding first by updating or replacing the package, run the tests, and repeat for the next finding. Stop after five fixes. Summarize what was fixed and what still needs a person.' } },
  { id: 'alert', name: 'Error alert to fix', a: { kind: 'webhook',
    task: 'An error alert arrived (payload below). Find the code behind the stack trace, write a failing test that reproduces it, fix it, and report the cause in two sentences. If the payload is not enough to reproduce it, say what is missing.' } },
];

export function AutomationsModal({ teams, automations, onChange, onOpenRun, onClose }: {
  teams: Team[]; automations: Automation[]; onChange: (list: Automation[]) => void; onOpenRun: (runId: string, teamId: string) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Partial<Automation> | null>(null);
  const [error, setError] = useState('');
  const reload = () => api.automations().then(onChange);
  const guard = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await reload(); } catch (e) { setError((e as Error).message); } };
  const set = (patch: Partial<Automation>) => setDraft({ ...draft, ...patch });
  const hookUrl = (a: Automation) => `${location.protocol}//${location.hostname}:47800/api/hooks/${a.token}`;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>{t('automations')}</h2>
        <p className="hint">{t('automationsHint')}</p>
        {automations.map((a) => (
          <div className="auto-row" key={a.id}>
            <label className="check"><input type="checkbox" checked={a.enabled} onChange={(e) => guard(() => api.saveAutomation({ ...a, enabled: e.target.checked }))} /></label>
            <div className="grow">
              <b>{a.name}</b> <span className="pill">{a.kind === 'schedule' ? a.cron : a.kind === 'github' ? `GitHub · ${a.watch} · ${a.intervalMin}m` : 'webhook'}</span> <span className="muted">{teams.find((x) => x.id === a.teamId)?.name ?? '?'}</span>
              <div className="muted clip">{a.task}</div>
              {a.kind === 'webhook' && <code className="crumb">POST {hookUrl(a)}</code>}
              {a.lastRunAt && <div className="muted">{t('lastRun')}: {new Date(a.lastRunAt).toLocaleString()} {a.lastRunId && <button className="ghost" onClick={() => { onOpenRun(a.lastRunId!, a.teamId); onClose(); }}>{t('open')}</button>}</div>}
            </div>
            <button onClick={() => guard(async () => { const r = await api.runAutomation(a.id); if (!r.started) throw new Error(r.reason); })}>{t('runNow')}</button>
            <button onClick={() => setDraft(a)}>{t('edit')}</button>
            <button className="ghost danger-text" onClick={() => confirm(`${t('remove')}: ${a.name}?`) && guard(() => api.deleteAutomation(a.id))}>×</button>
          </div>
        ))}
        {!automations.length && !draft && <div className="muted">{t('noAutomations')}</div>}

        {draft ? (
          <div className="auto-form">
            {!draft.id && (
              <div className="presets"><span className="label">{t('templates')}</span>
                {TEMPLATES.map((x) => <button key={x.id} className={draft.template === x.id ? 'chip on' : 'chip'} onClick={() => set({ ...x.a, template: x.id, name: draft.name || x.name })}>{x.name}</button>)}
              </div>
            )}
            <div className="grid2">
              <label>{t('name')}<input value={draft.name ?? ''} onChange={(e) => set({ name: e.target.value })} autoFocus /></label>
              <label>{t('team')}<select value={draft.teamId} onChange={(e) => set({ teamId: e.target.value })}>{teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
              <label>{t('trigger')}<select value={draft.kind} onChange={(e) => set({ kind: e.target.value as Automation['kind'] })}><option value="schedule">{t('schedule')}</option><option value="webhook">Webhook</option><option value="github">GitHub</option></select></label>
              {draft.kind === 'schedule' && (
                <label>{t('schedule')} (cron)
                  <input value={draft.cron ?? ''} onChange={(e) => set({ cron: e.target.value })} list="cron-presets" className="mono" />
                  <datalist id="cron-presets">{PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</datalist>
                </label>
              )}
              {draft.kind === 'github' && (
                <div className="grid2">
                  <label>{t('watch')}<select value={draft.watch} onChange={(e) => set({ watch: e.target.value as Automation['watch'] })}>
                    <option value="issues">{t('watch_issues')}</option><option value="prs">{t('watch_prs')}</option><option value="ci">{t('watch_ci')}</option></select></label>
                  <label>{t('everyMinutes')}<input type="number" min={2} value={draft.intervalMin ?? 10} onChange={(e) => set({ intervalMin: Number(e.target.value) })} /></label>
                </div>
              )}
            </div>
            {draft.kind === 'github' && <p className="hint">{t('githubHint')}</p>}
            <label>{t('task')}<textarea rows={3} value={draft.task ?? ''} onChange={(e) => set({ task: e.target.value })} placeholder={t('taskPlaceholder')} /></label>
            <div className="grid2">
              <label>{t('workdir')}<input value={draft.workdir ?? ''} onChange={(e) => set({ workdir: e.target.value })} placeholder={t('workdirPlaceholder')} /></label>
              <label>{t('check')}<input value={draft.checkCommand ?? ''} onChange={(e) => set({ checkCommand: e.target.value })} placeholder="npm test" /></label>
            </div>
            <div className="actions"><span className="grow" /><button onClick={() => setDraft(null)}>{t('cancel')}</button>
              <button className="primary" onClick={() => guard(async () => { await api.saveAutomation(draft); setDraft(null); })}>{t('save')}</button></div>
          </div>
        ) : <button onClick={() => setDraft(blank(teams[0]?.id ?? ''))}>+ {t('newAutomation')}</button>}
        {error && <div className="error-text">{error}</div>}
        <div className="actions"><span className="grow" /><button onClick={onClose}>{t('close')}</button></div>
      </div>
    </div>
  );
}

function UsageTable({ rows, agent }: { rows: (UsageRow & { tasksDone?: number; tasksFailed?: number })[]; agent?: boolean }) {
  const { t } = useI18n();
  return (
    <table className="usage">
      <thead><tr>{agent && <th>{t('team')}</th>}{agent && <th>{t('agent')}</th>}<th>{t('provider')}</th><th>{t('model')}</th><th>{t('turns')}</th><th>In</th><th>Out</th><th>{t('cost')}</th><th>{t('avgTime')}</th><th>{t('failedTurns')}</th>{agent && <th>{t('tasksDoneFailed')}</th>}</tr></thead>
      <tbody>{rows.map((r, i) => (
        <tr key={i}>{agent && <td>{r.team}</td>}{agent && <td><b>{r.agent}</b></td>}<td>{r.provider}</td><td><code>{r.model}</code></td><td>{r.turns}</td>
          <td>{compact(r.inputTokens)}</td><td>{compact(r.outputTokens)}</td><td>{r.costUsd ? `$${r.costUsd.toFixed(2)}` : '—'}</td><td>{duration(r.avgMs)}</td><td>{r.failed || ''}</td>
          {agent && <td>{r.tasksDone} / {r.tasksFailed}</td>}</tr>
      ))}</tbody>
    </table>
  );
}

export function PlanMeters({ plan }: { plan: ClaudePlan }) {
  const { t } = useI18n();
  if (plan.mode === 'apiKey') return <div className="muted">{t('claudeUsesKey')}</div>;
  return (<>
    {plan.error && <div className="muted">{plan.error}</div>}
    {plan.limits.map((l) => (
      <div key={l.name} className="limit">
        <span>{l.name}</span>
        <div className={`meter${l.usedPercent >= 90 ? ' hot' : ''}`}><i style={{ width: `${Math.min(100, l.usedPercent)}%` }} /></div>
        <span>{Math.round(l.usedPercent)}%{l.resetsAt ? ` · ${t('resets')} ${new Date(l.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
      </div>
    ))}
    {plan.extraUsage && (plan.extraUsage.enabled
      ? <div className="warn">{t('extraOn')}{plan.extraUsage.usedUsd != null ? ` ${t('extraUsed')}: $${plan.extraUsage.usedUsd.toFixed(2)}${plan.extraUsage.limitUsd ? ` / $${plan.extraUsage.limitUsd.toFixed(2)}` : ''}.` : ''}</div>
      : <div className="ok-text">{t('extraOff')}</div>)}
    {plan.at && <div className="muted">{plan.source === 'live' ? t('planLive') : t('planLastRun')} · {new Date(plan.at).toLocaleTimeString()}</div>}
  </>);
}

function BillingView({ days }: { days: number }) {
  const { t } = useI18n();
  const [b, setB] = useState<Billing | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setB(null); api.billing(days).then(setB).catch((e) => setErr(e.message)); }, [days]);
  if (err) return <div className="error-text">{err}</div>;
  if (!b) return <div className="muted">{t('loadingBilling')}</div>;
  const provider = (name: string, p: Billing['anthropic'], keyHint: string) => (
    <div className="bill">
      <div className="row"><b className="grow">{name}</b>{p.configured && !p.error && <b>${p.totalUsd.toFixed(2)}</b>}</div>
      {!p.configured ? <div className="muted">{keyHint}</div> : p.error ? <div className="error-text">{p.error}</div>
        : p.lines.length ? <table className="usage"><tbody>{p.lines.slice(0, 8).map((l) => <tr key={l.label}><td>{l.label}</td><td>${l.usd.toFixed(2)}</td></tr>)}</tbody></table>
        : <div className="muted">{t('noUsage')}</div>}
    </div>
  );
  return (
    <div className="bills">
      {provider('Anthropic (API)', b.anthropic, t('needAdminKey'))}
      {provider('OpenAI (API)', b.openai, t('needAdminKey'))}
      <div className="bill">
        <div className="row"><b className="grow">Claude (subscription)</b>{b.claude.plan && <span className="pill">{b.claude.plan}</span>}</div>
        <PlanMeters plan={b.claude} />
      </div>
      <div className="bill">
        <div className="row"><b className="grow">Codex (ChatGPT)</b>{b.codex.plan && <span className="pill">{b.codex.plan}</span>}</div>
        {b.codex.error ? <div className="error-text">{b.codex.error}</div> : !b.codex.loggedIn ? <div className="muted">{t('codexNoLogin')}</div> : (<>
          {b.codex.limits.map((l) => (
            <div key={l.name} className="limit">
              <span>{l.name}{l.windowMins ? ` (${l.windowMins >= 1440 ? `${Math.round(l.windowMins / 1440)}d` : `${Math.round(l.windowMins / 60)}h`})` : ''}</span>
              <div className="meter"><i style={{ width: `${Math.min(100, l.usedPercent)}%` }} /></div>
              <span>{Math.round(l.usedPercent)}%{l.resetsAt ? ` · ${t('resets')} ${new Date(l.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
            </div>
          ))}
          {b.codex.daily.length > 0 && <div className="muted">{t('last7')}: {compact(b.codex.daily.slice(-7).reduce((a, d) => a + d.tokens, 0))} tokens</div>}
        </>)}
      </div>
      <p className="hint">{t('claudeSubHint')}</p>
    </div>
  );
}

export function UsageModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => { api.stats(days).then(setStats).catch(() => setStats(null)); }, [days]);
  const peak = Math.max(1, ...(stats?.daily ?? []).map((d) => d.inputTokens + d.outputTokens));

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2 className="grow">{t('usage')}</h2>
          <select style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} {t('days')}</option>)}</select></div>
        <h3>{t('billing')}</h3>
        <BillingView days={days} />
        <h3>{t('recorded')}</h3>
        <p className="hint">{t('usageHint')}</p>
        {!stats ? '…' : !stats.recording ? <div className="warn">{t('usageOff')}</div> : !stats.byModel.length ? <div className="muted">{t('noUsage')}</div> : (<>
          <div className="stat-tiles">
            <div><b>{stats.runs.total}</b><span>{t('runs')}</span></div>
            <div><b>{stats.runs.done}</b><span>{t('status_done')}</span></div>
            <div><b>{stats.runs.failed}</b><span>{t('status_failed')}</span></div>
            <div><b>{compact(stats.byModel.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0))}</b><span>tokens</span></div>
            <div><b>${stats.byModel.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}</b><span>{t('cost')}</span></div>
          </div>
          <h3>{t('perDay')}</h3>
          <div className="bars">{stats.daily.map((d) => (
            <div key={d.day} title={`${d.day}: ${compact(d.inputTokens + d.outputTokens)} tokens, ${d.turns} ${t('turns')}${d.costUsd ? `, $${d.costUsd.toFixed(2)}` : ''}`}>
              <i style={{ height: `${Math.max(3, ((d.inputTokens + d.outputTokens) / peak) * 100)}%` }} /><span>{d.day.slice(5)}</span></div>
          ))}</div>
          <h3>{t('perModel')}</h3><UsageTable rows={stats.byModel} />
          <h3>{t('perAgent')}</h3><UsageTable rows={stats.byAgent} agent />
        </>)}
        <div className="actions"><span className="grow" /><button onClick={onClose}>{t('close')}</button></div>
      </div>
    </div>
  );
}

const sum = (run: Run, pick: (e: any) => number) => run.events.reduce((a, e) => a + (e.type === 'usage' ? pick(e) : 0), 0);

export function CompareModal({ teams, runs, recent, onOpenRun, onClose }: {
  teams: Team[]; runs: Run[]; recent: string[]; onOpenRun: (runId: string, teamId: string) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string[]>(teams.slice(0, 2).map((x) => x.id));
  const [task, setTask] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [check, setCheck] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const groups = new Map<string, Run[]>();
  for (const r of runs) if (r.compare) groups.set(r.compare.id, [...(groups.get(r.compare.id) ?? []), r]);
  const list = [...groups.entries()].sort((a, b) => Math.max(...b[1].map((r) => r.startedAt)) - Math.max(...a[1].map((r) => r.startedAt)));
  const act = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setError(''); setNote(''); try { await fn(); } catch (e) { setError((e as Error).message); } setBusy(''); };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>{t('compare')}</h2>
        <p className="hint">{t('compareHint')}</p>
        <div className="auto-form">
          <div className="presets"><span className="label">{t('teamsToCompare')}</span>
            {teams.map((x) => <button key={x.id} className={picked.includes(x.id) ? 'chip on' : 'chip'} onClick={() => setPicked(picked.includes(x.id) ? picked.filter((p) => p !== x.id) : [...picked, x.id])}>{x.name}</button>)}
          </div>
          <label>{t('task')}<textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder={t('taskPlaceholder')} /></label>
          <div className="grid2">
            <label>{t('workdir')}<input value={workdir} onChange={(e) => setWorkdir(e.target.value)} list="recent-dirs-compare" placeholder={t('compareFolder')} />
              <datalist id="recent-dirs-compare">{recent.map((r) => <option key={r} value={r} />)}</datalist></label>
            <label>{t('check')}<input value={check} onChange={(e) => setCheck(e.target.value)} placeholder="npm test" /></label>
          </div>
          <div className="row"><span className="grow" /><button className="primary" disabled={picked.length < 2 || !task.trim() || !!busy}
            onClick={() => act('start', async () => { await api.compare({ teamIds: picked, task, workdir: workdir || undefined, checkCommand: check || undefined }); setTask(''); })}>{t('startCompare')}</button></div>
        </div>
        {error && <div className="error-text">{error}</div>}
        {note && <div className="ok-text">{note}</div>}
        {list.map(([id, group]) => (
          <div key={id} className="compare">
            <div className="row"><b className="grow">{group[0].task.slice(0, 120)}</b>
              {group.some((r) => r.compare?.discarded) ? <span className="muted">{t('discarded')}</span> : <button className="ghost danger-text" disabled={!!busy || group.some((r) => r.status === 'running')} onClick={() => confirm(t('discardConfirm')) && act('discard', () => api.discardCompare(id))}>{t('discard')}</button>}</div>
            <div className="compare-cols">
              {group.map((r) => {
                const lead = r.team.agents.find((a) => a.role === 'manager') ?? r.team.agents[0];
                const final = [...r.events].reverse().find((e) => e.type === 'message' && e.kind === 'final');
                const checks = r.events.filter((e) => e.type === 'check');
                const lastCheck = checks[checks.length - 1];
                return (
                  <div key={r.id} className="compare-card">
                    <div className="row"><b className="grow" style={{ color: lead ? PALETTE[lead.look.color % PALETTE.length].ink : undefined }}>{r.team.name}</b><span className={`status ${r.status}`}>{t(`status_${r.status}` as any)}</span></div>
                    <div className="muted">{r.team.agents.map((a) => `${a.name}: ${a.model || a.provider}`).join(' · ')}</div>
                    <table className="usage"><tbody>
                      <tr><td>{t('duration')}</td><td>{duration((r.endedAt ?? Date.now()) - r.startedAt)}</td></tr>
                      <tr><td>Tokens</td><td>{compact(sum(r, (e) => e.inputTokens + e.outputTokens))}</td></tr>
                      <tr><td>{t('cost')}</td><td>{sum(r, (e) => e.costUsd ?? 0) ? `$${sum(r, (e) => e.costUsd ?? 0).toFixed(3)}` : '—'}</td></tr>
                      <tr><td>{t('check')}</td><td>{lastCheck && lastCheck.type === 'check' ? `${lastCheck.ok ? '✓' : '✗'} (${checks.length})` : '—'}</td></tr>
                    </tbody></table>
                    {final && final.type === 'message' && <p className="compare-final">{final.text.slice(0, 600)}</p>}
                    <div className="row">
                      <button onClick={() => { onOpenRun(r.id, r.teamId); onClose(); }}>{t('open')}</button>
                      {r.compare?.branch && !r.compare.discarded && <button className="primary" disabled={!!busy || r.status === 'running'} onClick={() => act('keep', async () => setNote((await api.keepCompare(id, r.id)).message))}>{t('keepThis')}</button>}
                    </div>
                    {r.compare?.branch && <code className="crumb">{r.compare.branch}</code>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className="actions"><span className="grow" /><button onClick={onClose}>{t('close')}</button></div>
      </div>
    </div>
  );
}

/** Fixed tasks with checks, run against a team: did a change of model, team or instructions help or hurt? */
export function EvalsModal({ teams, onOpenRun, onClose }: { teams: Team[]; onOpenRun: (runId: string, teamId: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [results, setResults] = useState<EvalResult[]>([]);
  const [suiteId, setSuiteId] = useState('');
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const load = () => api.evals().then((d) => { if (!dirty) setSuites(d.suites); setResults(d.results); setSuiteId((x) => x || d.suites[0]?.id || ''); }).catch((e) => setError(e.message));
  useEffect(() => { void load(); const timer = setInterval(load, 3000); return () => clearInterval(timer); }, [dirty]);
  const suite = suites.find((s) => s.id === suiteId);
  const setTasks = (tasks: EvalSuite['tasks']) => { setDirty(true); setSuites(suites.map((s) => (s.id === suiteId ? { ...s, tasks } : s))); };
  const uid = () => Math.random().toString(36).slice(2, 10);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2 className="grow">{t('evalsTitle')}</h2><button className="ghost" onClick={onClose}>×</button></div>
        <p className="hint">{t('evalsHint')}</p>
        <div className="row">
          <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>{suites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.tasks.length})</option>)}</select>
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>{teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <span className="grow" />
          {dirty && <button onClick={async () => { setSuites(await api.saveEvalSuites(suites)); setDirty(false); }}>{t('save')}</button>}
          <button className="primary" disabled={!suite?.tasks.length || dirty} onClick={async () => { setError(''); try { await api.runEval(suiteId, teamId); await load(); } catch (e) { setError((e as Error).message); } }}>{t('evalRun')}</button>
        </div>
        {suite && <div className="eval-tasks">
          {suite.tasks.map((task, i) => (
            <div className="row" key={task.id}>
              <input className="grow" value={task.prompt} onChange={(e) => setTasks(suite.tasks.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)))} placeholder={t('evalPrompt')} />
              <select value={task.check.kind} onChange={(e) => setTasks(suite.tasks.map((x, j) => (j === i ? { ...x, check: { ...x.check, kind: e.target.value as 'contains' | 'command' } } : x)))} style={{ width: 150 }}>
                <option value="contains">{t('evalContains')}</option><option value="command">{t('evalCommand')}</option></select>
              <input className="mono" style={{ width: 220 }} value={task.check.value} onChange={(e) => setTasks(suite.tasks.map((x, j) => (j === i ? { ...x, check: { ...x.check, value: e.target.value } } : x)))} />
              <button className="ghost" onClick={() => setTasks(suite.tasks.filter((_, j) => j !== i))}>×</button>
            </div>))}
          <button className="ghost" onClick={() => setTasks([...suite.tasks, { id: uid(), prompt: '', check: { kind: 'contains', value: '' } }])}>+ {t('evalAdd')}</button>
        </div>}
        {error && <div className="error">{error}</div>}
        <h3>{t('evalResults')}</h3>
        <table className="usage-table">
          <thead><tr><th>{t('when')}</th><th>{t('team')}</th><th>{t('evalPassed')}</th><th>Tokens</th><th>{t('time')}</th><th>{t('promptVersion')} / {t('teamVersion')}</th><th /></tr></thead>
          <tbody>{results.filter((r) => r.suiteId === suiteId).map((r) => {
            const done = r.items.filter((i) => i.pass !== undefined);
            return (
              <tr key={r.id}>
                <td>{new Date(r.at).toLocaleString()}</td><td>{r.teamName}</td>
                <td><b>{done.filter((i) => i.pass).length}/{r.items.length}</b>{r.status === 'running' ? ' …' : ''}</td>
                <td>{r.items.reduce((n, i) => n + (i.tokens ?? 0), 0).toLocaleString()}</td>
                <td>{r.items.reduce((n, i) => n + (i.secs ?? 0), 0)} s</td>
                <td className="mono">{r.versions ? `${r.versions.prompt} / ${r.versions.team}` : '–'}</td>
                <td className="eval-dots">{r.items.map((i, k) => <button key={k} className={`dot ${i.pass === undefined ? '' : i.pass ? 'ok' : 'bad'}`} title={`${suite?.tasks[k]?.prompt ?? ''}${i.note ? ` — ${i.note}` : ''}`} disabled={!i.runId} onClick={() => { if (i.runId) { onOpenRun(i.runId, r.teamId); onClose(); } }} />)}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
    </div>
  );
}
