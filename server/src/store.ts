import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TEAM_DEFAULTS, type AgentConfig, type Look, type Settings, type Team } from '../../shared/types.ts';
import { openDb, type Backend } from './db.ts';
import { openJson } from './jsondb.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const DATA = process.env.BEO_DATA ? path.resolve(process.env.BEO_DATA) : path.join(ROOT, 'data');

for (const d of ['', 'uploads', 'workspaces', 'vendor', 'worktrees']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const configFile = path.join(DATA, 'config.json');
const readConfig = (): { useDatabase: boolean } | null => {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return null; }
};

/** Copies what both backends can hold. Runs stay where they were recorded. */
function copyAll(from: Backend, to: Backend) {
  for (const t of from.teams()) to.saveTeam(t);
  for (const a of from.automations()) to.saveAutomation(a);
  const s = from.kvGet<unknown>('settings', null);
  if (s) to.kvSet('settings', s);
  to.kvSet('initialized', true);
}

let config = readConfig();
if (!config) {
  // First start of this version. A database left by version 0.2 holds the newest teams: bring them over to the JSON files.
  config = { useDatabase: false };
  if (fs.existsSync(path.join(DATA, 'office.db'))) {
    try { const old = openDb(DATA); if (old.kvGet('initialized', false)) copyAll(old, openJson(DATA)); } catch { /* fall back to the JSON files as they are */ }
  }
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

/** The active storage. A live binding: importers always see the current backend. */
export let db: Backend = config.useDatabase ? openDb(DATA) : openJson(DATA);
export const usingDatabase = () => db.kind === 'sqlite';

export function setUseDatabase(on: boolean) {
  if (on === usingDatabase()) return;
  const next = on ? openDb(DATA) : openJson(DATA);
  copyAll(db, next);
  db = next;
  fs.writeFileSync(configFile, JSON.stringify({ useDatabase: on }, null, 2));
}
export const newId = () => randomUUID().slice(0, 8);

const look = (color: number, hair: Look['hair'], hairColor: string, glasses: Look['glasses'], accessory: Look['accessory']): Look =>
  ({ color, hair, hairColor, glasses, accessory });

function agent(partial: Partial<AgentConfig> & Pick<AgentConfig, 'name' | 'role' | 'provider' | 'look'>): AgentConfig {
  const titles = { manager: 'Team lead', coder: 'Developer', researcher: 'Researcher', reviewer: 'Reviewer', custom: 'Specialist' };
  return { id: newId(), roleTitle: titles[partial.role], model: '', effort: 'default', instructions: '', skills: [], ...partial };
}

function seedTeams(): Team[] {
  const now = Date.now();
  const base = { autonomy: 'edit' as const, workflow: 'free' as const, maxRounds: 8, createdAt: now, updatedAt: now, ...structuredClone(TEAM_DEFAULTS) };
  return [
    {
      ...base, id: newId(), name: 'Demo Crew',
      description: 'Simulated agents. Needs no account, so you can see how the office works.',
      agents: [
        agent({ name: 'Mila', role: 'manager', provider: 'demo', look: look(0, 'bun', '#3b2f2f', 'round', 'none') }),
        agent({ name: 'Bolt', role: 'coder', provider: 'demo', look: look(2, 'spiky', '#1f3b57', 'none', 'headphones') }),
        agent({ name: 'Iris', role: 'researcher', provider: 'demo', look: look(4, 'bob', '#6b3fa0', 'square', 'none') }),
      ],
    },
    {
      ...base, id: newId(), name: 'Code Crew', autonomy: 'full',
      description: 'Claude leads and codes, Codex researches, a second Claude reviews.',
      agents: [
        agent({ name: 'Mila', role: 'manager', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', look: look(0, 'bun', '#3b2f2f', 'round', 'none') }),
        agent({ name: 'Bolt', role: 'coder', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', look: look(2, 'spiky', '#1f3b57', 'none', 'headphones') }),
        agent({ name: 'Iris', role: 'researcher', provider: 'codex', effort: 'medium', look: look(4, 'bob', '#6b3fa0', 'square', 'none') }),
        agent({ name: 'Otto', role: 'reviewer', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', look: look(5, 'tuft', '#7a4b1d', 'round', 'bow') }),
      ],
    },
    {
      ...base, id: newId(), name: 'Local Lab',
      description: 'Runs entirely on your own machine through Ollama or LM Studio.',
      agents: [
        agent({ name: 'Pip', role: 'manager', provider: 'local', endpointId: 'ollama', look: look(3, 'curls', '#2f4f2f', 'none', 'antenna') }),
        agent({ name: 'Nox', role: 'coder', provider: 'local', endpointId: 'ollama', look: look(7, 'none', '#3b2f2f', 'square', 'cap') }),
      ],
    },
  ];
}

const defaultSettings: Settings = {
  localEndpoints: [
    { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
    { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  ],
  recentWorkdirs: [],
};

/** Teams saved by older versions, including snapshots inside old runs, lack the newer fields. */
const PROVIDERS = ['claude', 'codex', 'local', 'demo'];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const ROLES = ['manager', 'coder', 'researcher', 'reviewer', 'custom'];

/** Fills fields that older saves or hand-written requests may lack, so the rest of the code can rely on them. */
export const normalizeAgent = (a: Partial<AgentConfig>, i: number): AgentConfig => ({
  ...a,
  id: a.id || newId(),
  name: String(a.name ?? '').trim() || `Agent ${i + 1}`,
  role: ROLES.includes(a.role as string) ? a.role! : 'custom',
  roleTitle: a.roleTitle ?? '',
  provider: PROVIDERS.includes(a.provider as string) ? a.provider! : 'demo',
  model: a.model ?? '',
  effort: EFFORTS.includes(a.effort as string) ? a.effort! : 'default',
  instructions: a.instructions ?? '',
  skills: Array.isArray(a.skills) ? a.skills : [],
  look: a.look ?? ({} as AgentConfig['look']),
});

export const normalizeTeam = (t: Team): Team => ({
  ...t,
  description: t.description ?? '',
  agents: (Array.isArray(t.agents) ? t.agents : []).map(normalizeAgent),
  autonomy: ['read', 'edit', 'full'].includes(t.autonomy) ? t.autonomy : 'edit',
  workflow: t.workflow === 'superpowers' ? 'superpowers' : 'free',
  maxRounds: Number(t.maxRounds) > 0 ? Number(t.maxRounds) : 8,
  approvals: { ...TEAM_DEFAULTS.approvals, ...t.approvals },
  git: { ...TEAM_DEFAULTS.git, ...t.git },
  stack: t.stack ?? '',
  clarify: t.clarify ?? TEAM_DEFAULTS.clarify,
  isolation: t.isolation ?? TEAM_DEFAULTS.isolation,
  budget: { ...TEAM_DEFAULTS.budget, ...t.budget },
  rules: Array.isArray(t.rules) ? t.rules : [],
  routing: t.routing === 'team' ? 'team' : 'auto',
  memory: t.memory ?? true,
  mcp: (Array.isArray(t.mcp) ? t.mcp : []).filter((m) => m && (m.command || m.url)).map((m) => ({
    id: m.id || newId(), name: String(m.name ?? '').trim() || 'mcp', enabled: m.enabled !== false,
    ...(m.url ? { url: String(m.url) } : { command: String(m.command), args: Array.isArray(m.args) ? m.args.map(String) : [], env: m.env ?? {} }),
  })),
});

const readLegacy = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')) as T; } catch { return null; }
};

// First start on this database: import the JSON files of version 0.1, or seed.
if (!db.kvGet('initialized', false)) {
  const legacyTeams = readLegacy<Team[]>('teams.json');
  for (const t of legacyTeams ?? seedTeams()) db.saveTeam(normalizeTeam(t));
  const legacySettings = readLegacy<Partial<Settings>>('settings.json');
  if (legacySettings) db.kvSet('settings', legacySettings);
  db.kvSet('initialized', true);
}

let teams = db.teams().map(normalizeTeam);
let settings: Settings = { ...defaultSettings, ...db.kvGet<Partial<Settings>>('settings', {}) };

export const store = {
  teams: () => teams,
  team: (id: string) => teams.find((t) => t.id === id),
  saveTeam(team: Team) {
    const next = normalizeTeam({ ...team, updatedAt: Date.now() });
    db.saveTeam(next);
    teams = teams.some((t) => t.id === next.id) ? teams.map((t) => (t.id === next.id ? next : t)) : [...teams, next];
    return next;
  },
  deleteTeam(id: string) {
    db.deleteTeam(id);
    teams = teams.filter((t) => t.id !== id);
  },
  settings: () => settings,
  saveSettings(next: Settings) {
    settings = next;
    db.kvSet('settings', settings);
  },
};
