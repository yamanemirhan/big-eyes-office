import fs from 'node:fs';
import path from 'node:path';
import type { Approval, Automation, Run, RunEvent, Stats, Task, Team } from '../../shared/types.ts';

// SQLite through Node's built-in driver: no native module to compile.

export type Backend = ReturnType<typeof openDb>;

export function openDb(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  // Loaded only when the database is switched on, so the default JSON storage never touches SQLite.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'office.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, json TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (run_id, seq));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, team_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, run_id TEXT NOT NULL, team TEXT NOT NULL, agent TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL, duration_ms INTEGER NOT NULL, ok INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts);
    CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
  `);

  const all = <T>(sql: string, ...args: any[]) => db.prepare(sql).all(...args) as T[];
  const run = (sql: string, ...args: any[]) => { db.prepare(sql).run(...args); };
  const parse = <T>(rows: { json: string }[]) => rows.map((r) => JSON.parse(r.json) as T);

  return {
    kind: 'sqlite' as 'sqlite' | 'json',
    kvGet<T>(key: string, fallback: T): T {
      const row = all<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)[0];
      return row ? (JSON.parse(row.value) as T) : fallback;
    },
    kvSet: (key: string, value: unknown) => run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value)),

    teams: () => parse<Team>(all('SELECT json FROM teams ORDER BY position, rowid')),
    saveTeam: (t: Team) => run('INSERT INTO teams (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', t.id, JSON.stringify(t)),
    deleteTeam: (id: string) => run('DELETE FROM teams WHERE id = ?', id),

    saveRun(r: Run) {
      const { events: _events, ...meta } = r;
      run('INSERT INTO runs (id, team_id, status, started_at, ended_at, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at, json = excluded.json',
        r.id, r.teamId, r.status, r.startedAt, r.endedAt ?? null, JSON.stringify(meta));
    },
    addEvent: (e: RunEvent) => run('INSERT OR REPLACE INTO events (run_id, seq, json) VALUES (?, ?, ?)', e.runId, e.seq, JSON.stringify(e)),
    loadRuns(limit: number): Run[] {
      return parse<Omit<Run, 'events'>>(all('SELECT json FROM runs ORDER BY started_at DESC LIMIT ?', limit)).map((meta) => ({
        ...meta, events: parse<RunEvent>(all('SELECT json FROM events WHERE run_id = ? ORDER BY seq', meta.id)),
      }));
    },

    saveTask: (t: Task, teamId: string, agent: string) => run('INSERT INTO tasks (id, run_id, team_id, agent, status, created_at, json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json',
      t.id, t.runId, teamId, agent, t.status, t.createdAt, JSON.stringify(t)),
    saveApproval: (a: Approval) => run('INSERT INTO approvals (id, run_id, status, created_at, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json',
      a.id, a.runId, a.status, a.createdAt, JSON.stringify(a)),

    automations: () => parse<Automation>(all('SELECT json FROM automations ORDER BY rowid')),
    saveAutomation: (a: Automation) => run('INSERT INTO automations (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', a.id, JSON.stringify(a)),
    deleteAutomation: (id: string) => run('DELETE FROM automations WHERE id = ?', id),

    addUsage: (u: { runId: string; team: string; agent: string; provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; ok: boolean }) =>
      run('INSERT INTO usage (ts, run_id, team, agent, provider, model, input_tokens, output_tokens, cost_usd, duration_ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        Date.now(), u.runId, u.team, u.agent, u.provider, u.model, u.inputTokens, u.outputTokens, u.costUsd, u.durationMs, u.ok ? 1 : 0),

    spend(team: string, agent?: string): { usd: number; tokens: number } {
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const row = all<{ usd: number | null; tokens: number | null }>(
        `SELECT SUM(cost_usd) AS usd, SUM(input_tokens + output_tokens) AS tokens FROM usage WHERE ts >= ? AND team = ?${agent ? ' AND agent = ?' : ''}`,
        midnight.getTime(), team, ...(agent ? [agent] : []))[0];
      return { usd: row?.usd ?? 0, tokens: row?.tokens ?? 0 };
    },
    stats(days: number): Stats {
      const since = Date.now() - days * 86_400_000;
      const cols = `COUNT(*) AS turns, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(cost_usd) AS costUsd,
        CAST(AVG(duration_ms) AS INTEGER) AS avgMs, SUM(1 - ok) AS failed`;
      const byModel = all<any>(`SELECT provider, model, '' AS agent, '' AS team, ${cols} FROM usage WHERE ts >= ? GROUP BY provider, model ORDER BY turns DESC`, since);
      const byAgent = all<any>(`SELECT provider, model, agent, team, ${cols} FROM usage WHERE ts >= ? GROUP BY team, agent, provider, model ORDER BY team, agent`, since);
      const taskRows = all<{ team: string; agent: string; status: string; n: number }>(
        `SELECT json_extract(r.json, '$.team.name') AS team, t.agent AS agent, t.status AS status, COUNT(*) AS n
         FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.created_at >= ? GROUP BY team, agent, t.status`, since);
      const count = (team: string, agent: string, status: string) => taskRows.find((r) => r.team === team && r.agent === agent && r.status === status)?.n ?? 0;
      const daily = all<any>(`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
        SUM(cost_usd) AS costUsd, COUNT(*) AS turns FROM usage WHERE ts >= ? GROUP BY day ORDER BY day`, since);
      const runRows = all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM runs WHERE started_at >= ? GROUP BY status', since);
      const n = (s: string) => runRows.find((r) => r.status === s)?.n ?? 0;
      return {
        recording: true, days, byModel, daily,
        byAgent: byAgent.map((r) => ({ ...r, tasksDone: count(r.team, r.agent, 'done'), tasksFailed: count(r.team, r.agent, 'failed') })),
        runs: { total: runRows.reduce((a, r) => a + r.n, 0), done: n('done'), failed: n('failed'), stopped: n('stopped') },
      };
    },
  };
}
