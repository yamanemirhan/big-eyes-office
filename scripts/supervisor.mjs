// Big Eyes Office supervisor.
// Keeps the server running, restarts it when it crashes, rebuilds the UI when its source changed,
// and offers start / stop / restart / update on 127.0.0.1 so the app (and Claude) can manage it.
// Plain Node, no dependencies: it must start even when npm packages are broken.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const APP_PORT = Number(process.env.PORT ?? 47800);
const CTRL_PORT = Number(process.env.BEO_SUPERVISOR_PORT ?? 47799);
const isWin = process.platform === 'win32';
fs.mkdirSync(DATA, { recursive: true });

const cfgFile = path.join(DATA, 'supervisor.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
if (!cfg.token) { cfg.token = randomBytes(24).toString('hex'); fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); }

const logFile = path.join(DATA, 'supervisor.log');
const consoleFile = path.join(DATA, 'server-console.log');
const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.renameSync(logFile, `${logFile}.old`);
    fs.appendFileSync(logFile, text);
  } catch {}
  process.stdout.write(text);
};

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd: ROOT, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: isWin, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, out: `${stdout}${stderr}`.slice(-6000) });
  });
});

let child = null;
let wanted = true;
let state = 'stopped';
let crashes = [];
let busy = '';

function newest(dir) {
  let t = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else t = Math.max(t, fs.statSync(p).mtimeMs);
    }
  };
  try { walk(dir); } catch {}
  return t;
}

/** npm install when package files changed since the last install; build the UI when its source is newer. */
async function prepare() {
  const marker = path.join(DATA, '.installed');
  const pkgTime = Math.max(...['package.json', 'server/package.json', 'web/package.json'].map((f) => { try { return fs.statSync(path.join(ROOT, f)).mtimeMs; } catch { return 0; } }));
  const installed = fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : 0;
  if (!fs.existsSync(path.join(ROOT, 'node_modules')) || pkgTime > installed) {
    busy = 'installing packages';
    log('npm install');
    const r = await run('npm', ['install', '--no-audit', '--no-fund']);
    log(r.ok ? 'npm install done' : `npm install failed\n${r.out}`);
    if (r.ok) fs.writeFileSync(marker, new Date().toISOString());
  }
  const dist = path.join(ROOT, 'web', 'dist', 'index.html');
  const distTime = fs.existsSync(dist) ? fs.statSync(dist).mtimeMs : 0;
  const srcTime = Math.max(newest(path.join(ROOT, 'web', 'src')), newest(path.join(ROOT, 'shared')));
  if (srcTime > distTime) {
    busy = 'building the UI';
    log('building the UI');
    const r = await run('npm', ['run', 'build', '-w', 'web']);
    log(r.ok ? 'UI built' : `UI build failed\n${r.out}`);
  }
  busy = '';
}

/** Ends an older copy of this server that still holds the port, for example one started with "npm run dev". */
async function takeOverPort() {
  if (isWin) {
    const r = await run('powershell', ['-NoProfile', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${APP_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; "$($p.ProcessId)|$($p.ParentProcessId)|$($p.CommandLine)" }`], { shell: false });
    const [pid, parent, cmd = ''] = r.out.trim().split('|');
    if (!pid) return;
    if (!/main\.ts|big-eyes-office/i.test(cmd)) { log(`port ${APP_PORT} is used by another program (${cmd.slice(0, 120)}); not touching it`); return; }
    const p = await run('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${parent}").CommandLine`], { shell: false });
    // A "tsx watch" parent would start it again, so end that too.
    const target = /tsx.*watch/i.test(p.out) ? parent : pid;
    log(`taking over port ${APP_PORT} from process ${target}`);
    await run('taskkill', ['/PID', target, '/T', '/F'], { shell: false });
  } else {
    const r = await run('sh', ['-c', `lsof -t -iTCP:${APP_PORT} -sTCP:LISTEN 2>/dev/null | head -1`], { shell: false });
    const pid = r.out.trim();
    if (!pid) return;
    const cmd = fs.existsSync(`/proc/${pid}/cmdline`) ? fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8') : '';
    if (/main\.ts/.test(cmd)) { log(`taking over port ${APP_PORT} from process ${pid}`); try { process.kill(Number(pid)); } catch {} }
  }
  await new Promise((r) => setTimeout(r, 1200));
}

async function start() {
  if (child) return;
  wanted = true;
  state = 'starting';
  await prepare();
  await takeOverPort();
  const out = fs.openSync(consoleFile, 'a');
  child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join('server', 'src', 'main.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(APP_PORT) }, stdio: ['ignore', out, out], windowsHide: true,
  });
  state = 'running';
  log(`server started (pid ${child.pid})`);
  child.on('exit', (code, signal) => {
    log(`server exited (code ${code}${signal ? `, ${signal}` : ''})`);
    child = null;
    state = 'stopped';
    if (!wanted) return;
    crashes = [...crashes.filter((t) => Date.now() - t < 120_000), Date.now()];
    if (crashes.length > 5) { state = 'crashed'; log('server keeps crashing; not restarting. Look at server-console.log.'); return; }
    setTimeout(() => { if (wanted && !child) start(); }, 2000 * crashes.length);
  });
}

function stop() {
  wanted = false;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const c = child;
    c.once('exit', () => resolve());
    if (isWin) run('taskkill', ['/PID', String(c.pid), '/T', '/F'], { shell: false });
    else c.kill('SIGTERM');
    setTimeout(resolve, 8000);
  });
}

const tail = (file, lines) => { try { return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; } };

http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  // Only local pages that know the token may control the server. Cross-site pages cannot send the header without CORS.
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(403, { error: 'bad host' });
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>Big Eyes Office supervisor</title><p>Big Eyes Office supervisor is running. Use the app\'s Settings → Server, or its API with the token from data/supervisor.json.</p>');
  }
  if (req.headers['x-beo-token'] !== cfg.token) return send(401, { error: 'token required' });
  const status = () => ({ state, busy, pid: child?.pid ?? null, appPort: APP_PORT, supervisorPid: process.pid, recentCrashes: crashes.length });
  try {
    if (url.pathname === '/status') return send(200, status());
    if (url.pathname === '/logs') {
      const n = Math.min(500, Number(url.searchParams.get('lines')) || 120);
      return send(200, { supervisor: tail(logFile, n), server: tail(consoleFile, n) });
    }
    if (req.method !== 'POST') return send(405, { error: 'POST required' });
    if (url.pathname === '/start') { crashes = []; await start(); return send(200, status()); }
    if (url.pathname === '/stop') { await stop(); return send(200, status()); }
    if (url.pathname === '/restart' || url.pathname === '/update') {
      // Answer first: the app asking for a restart is the process being restarted.
      send(202, { ...status(), restarting: true });
      await stop();
      crashes = [];
      await start();
      return;
    }
    if (url.pathname === '/shutdown') {
      // Stops the server and the supervisor itself (the desktop app's "Quit and stop the server").
      send(200, { ok: true });
      await stop();
      setTimeout(() => process.exit(0), 200);
      return;
    }
    send(404, { error: 'unknown action' });
  } catch (e) {
    if (!res.headersSent) send(500, { error: String(e?.message ?? e) });
  }
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`another supervisor already runs on port ${CTRL_PORT}; exiting`); process.exit(0); }
  log(`control server error: ${e.message}`);
}).listen(CTRL_PORT, '127.0.0.1', () => {
  log(`supervisor listening on http://127.0.0.1:${CTRL_PORT} (pid ${process.pid})`);
  start();
});

process.on('uncaughtException', (e) => log(`supervisor error: ${e.stack ?? e}`));
