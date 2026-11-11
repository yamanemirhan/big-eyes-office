import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { KEY_MASK, type AppState, type ExternalSession, type FileEntry, type Settings, type Team } from '../../shared/types.ts';
import { DATA, ROOT, db, newId, normalizeTeam, setUseDatabase, store, usingDatabase } from './store.ts';
import { externalSessions, watchExternal } from './external.ts';
import { evalResults, evalSuites, runEval, saveSuites } from './evals.ts';
import { deleteMemory, readMemory, writeMemory } from './memory.ts';
import { deleteModel, isOllama, pullStates, startPull } from './ollama.ts';
import { DEFAULT_ALLOW, dockerBuild, dockerCleanVolumes, dockerStatus, egressDenials } from './docker.ts';
import { Orchestrator } from './orchestrator.ts';
import { Automations } from './automations.ts';
import { providerStatuses } from './providers.ts';
import { installSuperpowers, skillsState } from './skills.ts';
import { git, gitInfo, isRepo, sh } from './git.ts';
import { record } from './log.ts';
import { billing } from './billing.ts';
import { Shells } from './shells.ts';
import { discardCompare, keepCompare, startCompare } from './compare.ts';
import { SUPERPOWERS_DIR } from './skills.ts';

const PORT = Number(process.env.PORT ?? 47800);
const HOST = '127.0.0.1'; // Local only: agents can run commands, so never expose this to a network.

const app = express();
// Only this machine's own pages: blocks DNS-rebinding sites from reaching the API.
app.use((req, res, next) => {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return next();
  res.status(403).send('Forbidden host');
});
// Pages of other websites open in the same browser can still send requests to localhost. Anything that changes
// something needs our own header, which a foreign page cannot add without a CORS preflight (which we never allow).
const LOCAL_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.path.startsWith('/hooks/')) return next();
  const origin = req.headers.origin;
  if (req.headers['x-beo-client'] === '1' && (!origin || LOCAL_ORIGINS.has(origin))) return next();
  res.status(403).json({ error: 'Requests must come from the Big Eyes Office page.' });
});
app.use(express.json({ limit: '40mb' }));

const server = http.createServer(app);
// The socket carries terminal input: only this app's own page may connect.
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: ({ origin, req }: { origin: string; req: http.IncomingMessage }) => LOCAL_ORIGINS.has(origin) && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host ?? '')),
});
wss.on('error', () => { /* Listen errors are reported once, by the HTTP server handler below. */ });
const broadcast = (message: unknown) => {
  const data = JSON.stringify(message);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
};
const orchestrator = new Orchestrator(broadcast);

// Outside sessions: pushed to every page whenever a Claude Code or Codex transcript changes.
let external: ExternalSession[] = [];
const refreshExternal = () => {
  if (store.settings().watchExternal === false) { if (external.length) { external = []; broadcast({ external }); } return; }
  const next = externalSessions(orchestrator.knownSessionIds());
  if (JSON.stringify(next) !== JSON.stringify(external)) { external = next; broadcast({ external }); }
};
watchExternal(refreshExternal);
setTimeout(refreshExternal, 1000);
const automations = new Automations(orchestrator);

const mask = (key?: string) => (key ? KEY_MASK : '');
const publicSettings = (s: Settings): Settings => ({
  ...s,
  anthropicApiKey: mask(s.anthropicApiKey),
  openaiApiKey: mask(s.openaiApiKey),
  anthropicAdminKey: mask(s.anthropicAdminKey),
  openaiAdminKey: mask(s.openaiAdminKey),
  otlpHeaders: mask(s.otlpHeaders),
  localEndpoints: s.localEndpoints.map((e) => ({ ...e, apiKey: mask(e.apiKey) })),
});
const keep = (next: string | undefined, prev: string | undefined) => (next === KEY_MASK ? prev : next || undefined);

const wrap = (fn: (req: express.Request, res: express.Response) => unknown) =>
  async (req: express.Request, res: express.Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      record(`400 ${req.method} ${req.path}: ${(e as Error).message}`);
      res.status(400).json({ error: (e as Error).message });
    }
  };

/** Resolves a path inside a root folder and refuses anything that escapes it. */
function within(root: unknown, rel: unknown = ''): string {
  const base = path.resolve(String(root || ''));
  if (!root || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error('Folder not found.');
  const full = path.resolve(base, String(rel || '.'));
  const r = path.relative(base, full);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('Path is outside the folder.');
  return full;
}

app.get('/api/state', wrap((): AppState => ({
  teams: store.teams(), settings: publicSettings(store.settings()), runs: orchestrator.list().slice(0, 30), automations: automations.list(), useDatabase: usingDatabase(),
})));

// Teams
app.post('/api/teams', wrap((req) => {
  const body = req.body as Team;
  if (!body.name?.trim()) throw new Error('A team needs a name.');
  const now = Date.now();
  const exists = body.id && store.team(body.id);
  return store.saveTeam(normalizeTeam({ ...body, id: exists ? body.id : newId(), createdAt: exists ? body.createdAt : now, updatedAt: now }));
}));
app.delete('/api/teams/:id', wrap((req) => {
  const result = store.deleteTeam(req.params.id);
  deleteMemory(req.params.id);
  void dockerCleanVolumes(agentIds()).catch(() => {}); // Deleted agents' container state goes too.
  return result;
}));

// Settings, providers, skills
app.put('/api/settings', wrap((req) => {
  const prev = store.settings();
  const next = req.body as Settings;
  store.saveSettings({
    ...prev,
    anthropicApiKey: keep(next.anthropicApiKey, prev.anthropicApiKey),
    openaiApiKey: keep(next.openaiApiKey, prev.openaiApiKey),
    anthropicAdminKey: keep(next.anthropicAdminKey, prev.anthropicAdminKey),
    openaiAdminKey: keep(next.openaiAdminKey, prev.openaiAdminKey),
    codexAuth: next.codexAuth ?? prev.codexAuth ?? 'auto',
    claudeAuth: next.claudeAuth ?? prev.claudeAuth ?? 'auto',
    watchExternal: next.watchExternal ?? prev.watchExternal,
    otlpEndpoint: next.otlpEndpoint !== undefined ? String(next.otlpEndpoint).trim() : prev.otlpEndpoint,
    otlpHeaders: keep(next.otlpHeaders, prev.otlpHeaders),
    dockerNetwork: next.dockerNetwork ?? prev.dockerNetwork ?? 'allowlist',
    dockerAllow: (next.dockerAllow ?? prev.dockerAllow ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean),
    dockerMemory: next.dockerMemory ?? prev.dockerMemory, dockerCpus: next.dockerCpus ?? prev.dockerCpus,
    localEndpoints: (next.localEndpoints ?? []).filter((e) => e.baseUrl?.trim()).map((e) => ({
      id: e.id || newId(), name: e.name?.trim() || 'Endpoint', baseUrl: e.baseUrl.trim(),
      apiKey: keep(e.apiKey, prev.localEndpoints.find((p) => p.id === e.id)?.apiKey),
      kind: e.kind === 'ollama' || e.kind === 'openai' ? e.kind : undefined,
      contextLength: e.contextLength ? Math.min(262_144, Math.max(2048, Math.round(Number(e.contextLength)))) : undefined,
    })),
  });
  return publicSettings(store.settings());
}));
app.get('/api/providers', wrap(() => providerStatuses(store.settings(),
  store.teams().flatMap((t) => t.agents).filter((a) => a.provider === 'codex' && a.model).map((a) => a.model))));
app.get('/api/skills', wrap(() => skillsState()));
app.post('/api/skills/install', wrap(() => installSuperpowers()));

// Folder picker for the working directory.
app.get('/api/fs', wrap((req) => {
  const dir = path.resolve(String(req.query.path || os.homedir()));
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name).sort((a, b) => a.localeCompare(b));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, dirs: entries };
}));

app.post('/api/uploads', wrap((req) => {
  const { name, dataBase64, root, dir } = req.body as { name: string; dataBase64: string; root?: string; dir?: string };
  const safe = path.basename(name || 'file').replace(/[^\w.\- ()]/g, '_');
  // With a root, the file goes into that working folder; otherwise into the upload area for a new task.
  const target = root ? within(root, dir) : path.join(DATA, 'uploads', newId());
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, safe);
  fs.writeFileSync(file, Buffer.from(dataBase64, 'base64'));
  return { path: file, name: safe };
}));

// Attachments are served back for thumbnails in the activity feed (only from the upload area).
app.get('/api/upload', (req, res) => {
  const full = path.resolve(String(req.query.path ?? ''));
  const area = path.resolve(DATA, 'uploads') + path.sep;
  if (!full.startsWith(area) || !fs.existsSync(full)) { res.status(404).end(); return; }
  res.sendFile(full, { headers: { 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
});

// Files of a working folder
app.get('/api/files', wrap((req): { entries: FileEntry[] } => {
  const dir = within(req.query.root, req.query.path);
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
    .map((e) => ({ name: e.name, dir: e.isDirectory(), size: e.isFile() ? fs.statSync(path.join(dir, e.name)).size : 0 }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { entries };
}));
app.get('/api/file', wrap((req) => {
  const file = within(req.query.root, req.query.path);
  const size = fs.statSync(file).size;
  const buf = fs.readFileSync(file).subarray(0, 400_000);
  if (buf.includes(0)) return { binary: true, size, content: '' };
  return { binary: false, size, content: buf.toString('utf8'), truncated: size > 400_000 };
}));
app.get('/api/download', (req, res) => {
  try { res.download(within(req.query.root, req.query.path)); } catch (e) { res.status(400).send((e as Error).message); }
});
app.get('/api/diff', wrap(async (req) => {
  const dir = within(req.query.root);
  if (!(await isRepo(dir))) return { isRepo: false, diff: '' };
  const file = req.query.path ? ['--', String(req.query.path)] : [];
  const tracked = await git(dir, 'diff', 'HEAD', ...file);
  return { isRepo: true, diff: (tracked.ok ? tracked.out : (await git(dir, 'diff', ...file)).out).slice(0, 400_000) };
}));

// Git and GitHub
app.get('/api/git', wrap((req) => gitInfo(within(req.query.root))));
app.post('/api/git', wrap(async (req) => {
  const { root, action, value } = req.body as { root: string; action: string; value?: string };
  const dir = within(root);
  const v = String(value ?? '').trim();
  const steps: Record<string, () => Promise<{ ok: boolean; out: string }>> = {
    init: async () => {
      const r = await git(dir, 'init');
      if (!r.ok) return r;
      await git(dir, 'add', '-A');
      return git(dir, '-c', 'user.name=Big Eyes Office', '-c', 'user.email=office@localhost', 'commit', '--allow-empty', '-m', 'Initial commit');
    },
    commit: async () => { await git(dir, 'add', '-A'); return git(dir, 'commit', '-m', v || 'Update'); },
    push: () => git(dir, 'push', '-u', 'origin', v || 'HEAD'),
    pull: () => git(dir, 'pull', '--ff-only'),
    checkout: () => git(dir, 'checkout', v),
    'branch-delete': () => git(dir, 'branch', '-D', v),
    merge: () => git(dir, 'merge', '--no-ff', '--no-edit', v),
    'pr-create': () => sh('gh', ['pr', 'create', '--fill', '--head', v], dir),
    'pr-merge': () => sh('gh', ['pr', 'merge', v, '--merge'], dir),
  };
  if (!steps[action]) throw new Error('Unknown git action.');
  const result = await steps[action]();
  if (!result.ok) throw new Error(result.out || 'The git command failed.');
  return { output: result.out };
}));

// Shells for the user in a working folder (real terminals when node-pty is available).
const shells = new Shells((c) => broadcast(c));
app.post('/api/shell', wrap(async (req) => {
  const { root, command, cols, rows } = req.body as { root: string; command?: string; cols?: number; rows?: number };
  const shellId = await shells.open(within(root), cols, rows);
  if (command?.trim()) shells.write(shellId, command, true);
  return { shellId };
}));
app.get('/api/shells', wrap(() => shells.state()));
app.get('/api/external', wrap(() => external));

// Ollama: download models from Settings.
app.get('/api/ollama/pulls', wrap(() => pullStates()));
app.post('/api/ollama/pull', wrap((req) => {
  const e = store.settings().localEndpoints.find((x) => x.id === req.body.endpointId);
  if (!e || !isOllama(e)) throw new Error('Choose an Ollama endpoint.');
  return startPull(e, String(req.body.model ?? ''));
}));
app.delete('/api/ollama/model', wrap(async (req) => {
  const e = store.settings().localEndpoints.find((x) => x.id === req.body.endpointId);
  if (!e || !isOllama(e)) throw new Error('Choose an Ollama endpoint.');
  await deleteModel(e, String(req.body.model ?? ''));
  return { ok: true };
}));
app.post('/api/shell/:id/input', wrap((req) => shells.write(req.params.id, String(req.body.text ?? ''), req.body.raw ? false : true)));
app.post('/api/shell/:id/kill', wrap((req) => shells.kill(req.params.id)));
wss.on('connection', (ws) => {
  // Keystrokes and terminal size come over the socket, so typing in the terminal has no request overhead.
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw));
      if (m.type === 'shell-input') shells.write(String(m.id), String(m.data ?? ''));
      else if (m.type === 'shell-resize') shells.resize(String(m.id), Number(m.cols), Number(m.rows));
    } catch { /* ignore malformed or ended-shell messages */ }
  });
});

// Runs
app.post('/api/runs', wrap((req) => orchestrator.start({ ...req.body, mode: modeOf(req.body.mode) })));
app.get('/api/runs/:id', wrap((req) => orchestrator.get(req.params.id) ?? (() => { throw new Error('Run not found.'); })()));
const modeOf = (m: unknown) => (m === 'quick' || m === 'team' ? m : 'auto');
app.post('/api/runs/:id/message', wrap((req) => orchestrator.message(req.params.id, String(req.body.text ?? ''), req.body.agentId || undefined, Array.isArray(req.body.files) ? req.body.files.map(String) : [], modeOf(req.body.mode))));
app.get('/api/evals', wrap(() => ({ suites: evalSuites(), results: evalResults() })));
app.put('/api/evals/suites', wrap((req) => saveSuites(Array.isArray(req.body.suites) ? req.body.suites : [])));
app.post('/api/evals/run', wrap((req) => runEval(orchestrator, String(req.body.suiteId), String(req.body.teamId))));
app.get('/api/runs/:id/trace', wrap((req) => orchestrator.tracer.read(req.params.id)));
app.post('/api/runs/:id/agents/:agentId/context', wrap((req) => orchestrator.compact(req.params.id, req.params.agentId, req.body.how === 'fresh' ? 'fresh' : 'compact')));

// Team memory: notes the lead keeps between runs.
app.get('/api/teams/:id/memory', wrap((req) => ({ text: readMemory(req.params.id) })));
app.put('/api/teams/:id/memory', wrap((req) => { writeMemory(req.params.id, String(req.body.text ?? '')); return { text: readMemory(req.params.id) }; }));
app.post('/api/runs/:id/stop', wrap((req) => orchestrator.stop(req.params.id)));
app.post('/api/compare', wrap((req) => startCompare(orchestrator, req.body)));
app.post('/api/compare/:id/keep', wrap(async (req) => ({ message: await keepCompare(orchestrator, req.params.id, String(req.body.runId)) })));
app.post('/api/compare/:id/discard', wrap((req) => discardCompare(orchestrator, req.params.id)));
app.post('/api/runs/:id/resume', wrap((req) => orchestrator.resume(req.params.id)));
app.post('/api/approvals/:id', wrap((req) => orchestrator.decide(req.params.id, req.body.decision)));
app.post('/api/questions/:id', wrap((req) => orchestrator.answer(req.params.id, req.body.answers ?? [])));

// Storage and isolation switches
app.put('/api/storage', wrap((req) => { setUseDatabase(!!req.body.useDatabase); return { useDatabase: usingDatabase() }; }));
app.get('/api/docker', wrap(async () => ({ ...(await dockerStatus()), defaultAllow: DEFAULT_ALLOW, denials: await egressDenials() })));
app.post('/api/docker/build', wrap(() => dockerBuild()));
const agentIds = () => store.teams().flatMap((t) => t.agents.map((a) => a.id));
app.post('/api/docker/clean', wrap(async () => ({ removed: await dockerCleanVolumes(agentIds()) })));

// Automations
app.get('/api/automations', wrap(() => automations.list()));
app.post('/api/automations', wrap((req) => automations.save(req.body)));
app.delete('/api/automations/:id', wrap((req) => automations.delete(req.params.id)));
app.post('/api/automations/:id/run', wrap((req) => {
  const a = automations.list().find((x) => x.id === req.params.id);
  if (!a) throw new Error('Automation not found.');
  return automations.fire(a);
}));
app.post('/api/hooks/:token', wrap((req) => automations.fireWebhook(req.params.token, JSON.stringify(req.body ?? {}, null, 2))));

app.get('/api/stats', wrap((req) => db.stats(Math.max(1, Math.min(365, Number(req.query.days) || 30)))));
app.get('/api/claude-plan', wrap(async () => (await import('./claudeplan.ts')).claudePlan(store.settings())));
app.get('/api/billing', wrap((req) => billing(store.settings(), Math.max(1, Math.min(90, Number(req.query.days) || 30)))));

// The supervisor (scripts/supervisor.mjs) runs this server. These routes let the UI talk to it.
function supervisorToken(): string | null {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'supervisor.json'), 'utf8')).token ?? null; } catch { return null; }
}
async function supervisor(pathname: string, method = 'GET') {
  const token = supervisorToken();
  if (!token) throw new Error('The supervisor is not set up. Run scripts\\install-autostart.cmd once.');
  const res = await fetch(`http://127.0.0.1:${process.env.BEO_SUPERVISOR_PORT ?? 47799}${pathname}`, { method, headers: { 'x-beo-token': token }, signal: AbortSignal.timeout(10_000) })
    .catch(() => { throw new Error('The supervisor is not running. This server was started another way (for example npm run dev).'); });
  return res.json();
}
app.get('/api/server', wrap(async () => {
  const info = await supervisor('/status').catch((e) => ({ error: (e as Error).message }));
  return { pid: process.pid, node: process.version, port: PORT, startedAt: startedAt, supervisor: info };
}));
app.get('/api/server/logs', wrap(() => supervisor('/logs?lines=200')));
app.post('/api/server/restart', wrap(() => supervisor('/restart', 'POST')));

const dist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

server.on('error', (err: NodeJS.ErrnoException) => {
  const why = err.code === 'EADDRINUSE' ? `Port ${PORT} is already used by another program.`
    : err.code === 'EACCES' ? `Windows or the system does not allow listening on port ${PORT}.`
    : err.message;
  console.error(`\n  Big Eyes Office could not start: ${why}\n  Set another port and try again, e.g. PORT=47900 (PowerShell: $env:PORT=47900; npm run dev)\n`);
  record(`FAILED to listen: ${why}`);
  process.exit(1);
});

const startedAt = Date.now();

// Superpowers is part of how teams plan and ask questions; fetch it once if git is available.
if (!fs.existsSync(SUPERPOWERS_DIR) && process.env.BEO_NO_AUTO_INSTALL !== '1') {
  installSuperpowers().then(() => record('Superpowers installed')).catch((e) => record(`Superpowers not installed: ${(e as Error).message}`));
}

server.listen(PORT, HOST, () => {
  console.log(`Big Eyes Office server: http://${HOST}:${PORT}`);
  record(`listening on http://${HOST}:${PORT}`);
});
