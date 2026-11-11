import fs from 'node:fs';
import path from 'node:path';
import type { Automation, Run, RunEvent, Stats, Team } from '../../shared/types.ts';
import type { Backend } from './db.ts';

// Default storage: plain JSON files. Keeps teams, settings, automations and finished runs.
// Usage statistics and task history need the database (Settings → Storage).

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function openJson(dataDir: string): Backend {
  const file = (name: string) => path.join(dataDir, name);
  fs.mkdirSync(file('runs'), { recursive: true });
  const read = <T>(name: string, fallback: T): T => {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T; } catch { return fallback; }
  };
  const write = (name: string, value: unknown) => {
    const tmp = `${file(name)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file(name));
  };
  // Events of a running run are kept in memory by the orchestrator; the file is written with the run.
  const pendingEvents = new Map<string, RunEvent[]>();

  return {
    kind: 'json',
    kvGet: <T>(key: string, fallback: T) => read<Record<string, T>>('state.json', {})[key] ?? fallback,
    kvSet: (key, value) => write('state.json', { ...read<Record<string, unknown>>('state.json', {}), [key]: value }),
    teams: () => read<Team[]>('teams.json', []),
    saveTeam: (t) => { const all = read<Team[]>('teams.json', []); write('teams.json', all.some((x) => x.id === t.id) ? all.map((x) => (x.id === t.id ? t : x)) : [...all, t]); },
    deleteTeam: (id) => write('teams.json', read<Team[]>('teams.json', []).filter((x) => x.id !== id)),
    saveRun: (r) => { write(path.join('runs', `${r.id}.json`), r); if (r.status !== 'running') pendingEvents.delete(r.id); },
    addEvent: (e) => { pendingEvents.set(e.runId, [...(pendingEvents.get(e.runId) ?? []), e]); },
    loadRuns: (limit) => fs.readdirSync(file('runs')).filter((f) => f.endsWith('.json'))
      .map((f) => read<Run | null>(path.join('runs', f), null)).filter((r): r is Run => !!r && Array.isArray(r.events))
      .sort((a, b) => b.startedAt - a.startedAt).slice(0, limit),
    saveTask: () => {},
    saveApproval: () => {},
    automations: () => read<Automation[]>('automations.json', []),
    saveAutomation: (a) => { const all = read<Automation[]>('automations.json', []); write('automations.json', all.some((x) => x.id === a.id) ? all.map((x) => (x.id === a.id ? a : x)) : [...all, a]); },
    deleteAutomation: (id) => write('automations.json', read<Automation[]>('automations.json', []).filter((x) => x.id !== id)),
    addUsage: (u) => {
      // Daily totals only, per team and per agent: enough for budgets without a database.
      const day = today();
      const all = read<Record<string, Record<string, { usd: number; tokens: number }>>>('usage-daily.json', {});
      const bucket = (all[day] ??= {});
      for (const key of [u.team, `${u.team}/${u.agent}`]) {
        const b = (bucket[key] ??= { usd: 0, tokens: 0 });
        b.usd += u.costUsd;
        b.tokens += u.inputTokens + u.outputTokens;
      }
      const keep = Object.keys(all).sort().slice(-40);
      write('usage-daily.json', Object.fromEntries(keep.map((d) => [d, all[d]])));
    },
    spend: (team, agent) => read<Record<string, Record<string, { usd: number; tokens: number }>>>('usage-daily.json', {})[today()]?.[agent ? `${team}/${agent}` : team] ?? { usd: 0, tokens: 0 },
    stats: (days): Stats => ({ recording: false, days, byModel: [], byAgent: [], daily: [], runs: { total: 0, done: 0, failed: 0, stopped: 0 } }),
  };
}
